import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { tallyCompanyMatches, type TallyConnectorRow } from "@/lib/bridge";
import { BRIDGE_HEARTBEAT_STALE_MS, TALLY_SYNC_STALE_MS } from "@/lib/constants";
import { getCompanyLaunchControl } from "@/lib/launch-control";
import { buildOperationsAlerts } from "@/lib/operations";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

// 10s in-memory cache (same pattern as overview) - operations polled from header
const HEALTH_CACHE_TTL_MS = 10_000;
const healthCache = new Map<string, { expiresAt: number; data: unknown }>();

function syncReadiness(sync: { status: string; completed_at: string | null; error_summary: string | null } | null) {
  const completedAt = sync?.completed_at ?? null;
  const stale = !completedAt || Date.now() - new Date(completedAt).getTime() > TALLY_SYNC_STALE_MS;
  return { status: sync?.status === "completed" && !stale ? "current" : sync?.status === "completed" ? "stale" : sync?.status ?? "required", completedAt, stale, errorSummary: sync?.error_summary ?? null };
}

async function loadHealthFallback(company: { id: string; organization_id: string }, bindingRow: { id: string; connector_id: string; expected_tally_company_guid: string; expected_tally_company_name: string; observed_tally_company_guid: string | null; observed_tally_company_name: string | null; last_mismatch_at: string | null } | null) {
  const supabase = createSupabaseAdminClient();
  // Fallback: legacy 20 counts path (kept for pre-migration). New path uses get_operations_health_counts RPC.
  async function statusCounts(table: "integration_outbox" | "tally_commands" | "notification_messages", companyId: string, statuses: string[]) {
    const results = await Promise.all(statuses.map(async (status) => {
      const result = await supabase.from(table).select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", status);
      if (result.error) throw result.error;
      return [status, result.count ?? 0] as const;
    }));
    return Object.fromEntries(results) as Record<string, number>;
  }
  const [connectorResult, mastersResult, vouchersResult, outboxCounts, commandCounts, messageCounts, failedMessagesResult, failedOutboxResult, failedCommandResult, proposalResult, activeVersionResult, templateResult, launchControl] = await Promise.all([
    bindingRow ? supabase.from("tally_connectors").select("id, status, last_heartbeat_at").eq("id", bindingRow.connector_id).maybeSingle() : Promise.resolve({ data: null, error: null } as const),
    supabase.from("tally_sync_runs").select("status, completed_at, error_summary").eq("company_id", company.id).eq("sync_kind", "masters").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("tally_sync_runs").select("status, completed_at, error_summary").eq("company_id", company.id).eq("sync_kind", "vouchers").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    statusCounts("integration_outbox", company.id, ["pending", "processing", "completed", "failed", "dead_letter"]),
    statusCounts("tally_commands", company.id, ["queued", "sending", "accepted", "verified", "failed", "dead_letter"]),
    statusCounts("notification_messages", company.id, ["queued", "sending", "sent", "delivered", "read", "failed", "suppressed", "cancelled"]),
    supabase.from("notification_messages").select("attempt_count, max_attempts, provider_metadata").eq("company_id", company.id).eq("status", "failed").limit(1_000),
    supabase.from("integration_outbox").select("id, status, correlation_id, created_at, last_error").eq("company_id", company.id).in("status", ["dead_letter", "failed"]).order("created_at", { ascending: true }).limit(1).maybeSingle(),
    supabase.from("tally_commands").select("id, status, correlation_id, created_at, failure_reason").eq("company_id", company.id).in("status", ["dead_letter", "failed"]).order("created_at", { ascending: true }).limit(1).maybeSingle(),
    supabase.from("discount_proposals").select("id", { count: "exact", head: true }).eq("company_id", company.id).in("status", ["needs_review", "review_invalidated"]),
    supabase.from("scheme_versions").select("id").eq("company_id", company.id).eq("status", "active").limit(1),
    supabase.from("whatsapp_templates").select("id").eq("organization_id", company.organization_id).eq("is_active", true).limit(1),
    getCompanyLaunchControl(company.id),
  ]);
  const errors = [connectorResult.error, mastersResult.error, vouchersResult.error, failedMessagesResult.error, failedOutboxResult.error, failedCommandResult.error, proposalResult.error, activeVersionResult.error, templateResult.error].filter(Boolean);
  if (errors[0]) throw errors[0];
  const connector = connectorResult.data as Pick<TallyConnectorRow, "id" | "status" | "last_heartbeat_at"> | null;
  const heartbeatAt = connector?.last_heartbeat_at ? new Date(connector.last_heartbeat_at).getTime() : 0;
  const heartbeatStale = !heartbeatAt || Date.now() - heartbeatAt > BRIDGE_HEARTBEAT_STALE_MS;
  const matches = Boolean(bindingRow && tallyCompanyMatches(bindingRow.expected_tally_company_guid, bindingRow.expected_tally_company_name, bindingRow.observed_tally_company_guid, bindingRow.observed_tally_company_name));
  const tallyStatus = !bindingRow ? "not_bound" : !connector || connector.status !== "paired" ? "awaiting_pairing" : heartbeatStale ? "bridge_stale" : matches ? "ready" : "company_mismatch";
  const messageRows = (failedMessagesResult.data ?? []) as Array<{ attempt_count: number; max_attempts: number; provider_metadata: Record<string, unknown> | null }>;
  const retryingMessages = messageRows.filter((message) => message.attempt_count < message.max_attempts && message.provider_metadata?.terminal !== true).length;
  const terminalMessages = messageRows.filter((message) => message.attempt_count >= message.max_attempts || message.provider_metadata?.terminal === true).length;
  return { connectorResult, mastersResult, vouchersResult, outboxCounts, commandCounts, messageCounts, retryingMessages, terminalMessages, failedOutboxResult, failedCommandResult, proposalResult, activeVersionResult, templateResult, launchControl, tallyStatus, heartbeatStale, connector };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const cached = healthCache.get(company.id);
    if (cached && cached.expiresAt > Date.now()) {
      return jsonWithCors(request, cached.data, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "HIT" } });
    }
    const supabase = createSupabaseAdminClient();
    const { data: binding, error: bindingError } = await supabase.from("tally_connector_company_bindings")
      .select("id, connector_id, expected_tally_company_guid, expected_tally_company_name, observed_tally_company_guid, observed_tally_company_name, last_mismatch_at")
      .eq("company_id", company.id).eq("is_active", true).maybeSingle();
    if (bindingError) throw bindingError;
    const bindingRow = binding as { id: string; connector_id: string; expected_tally_company_guid: string; expected_tally_company_name: string; observed_tally_company_guid: string | null; observed_tally_company_name: string | null; last_mismatch_at: string | null } | null;

    // Fast path: single RPC for all 20 counts + failed aggregates
    const { data: rpcCounts, error: rpcError } = await supabase.rpc("get_operations_health_counts", { p_company_id: company.id });
    const isMissingRpc = rpcError && (String((rpcError as { code?: string }).code) === "42883" || String(rpcError.message ?? "").includes("get_operations_health_counts"));

    if (!isMissingRpc && rpcCounts) {
      const counts = rpcCounts as { outboxCounts: Record<string, number>; commandCounts: Record<string, number>; messageCounts: Record<string, number>; retrying: number; terminalFailures: number; proposalCount: number };
      const [connectorResult, mastersResult, vouchersResult, failedOutboxResult, failedCommandResult, activeVersionResult, templateResult, launchControl] = await Promise.all([
        bindingRow ? supabase.from("tally_connectors").select("id, status, last_heartbeat_at").eq("id", bindingRow.connector_id).maybeSingle() : Promise.resolve({ data: null, error: null } as const),
        supabase.from("tally_sync_runs").select("status, completed_at, error_summary").eq("company_id", company.id).eq("sync_kind", "masters").order("created_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("tally_sync_runs").select("status, completed_at, error_summary").eq("company_id", company.id).eq("sync_kind", "vouchers").order("created_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("integration_outbox").select("id, status, correlation_id, created_at, last_error").eq("company_id", company.id).in("status", ["dead_letter", "failed"]).order("created_at", { ascending: true }).limit(1).maybeSingle(),
        supabase.from("tally_commands").select("id, status, correlation_id, created_at, failure_reason").eq("company_id", company.id).in("status", ["dead_letter", "failed"]).order("created_at", { ascending: true }).limit(1).maybeSingle(),
        supabase.from("scheme_versions").select("id").eq("company_id", company.id).eq("status", "active").limit(1),
        supabase.from("whatsapp_templates").select("id").eq("organization_id", company.organization_id).eq("is_active", true).limit(1),
        getCompanyLaunchControl(company.id),
      ]);
      const errors = [connectorResult.error, mastersResult.error, vouchersResult.error, failedOutboxResult.error, failedCommandResult.error, activeVersionResult.error, templateResult.error].filter(Boolean);
      if (errors[0]) throw errors[0];
      const connector = connectorResult.data as Pick<TallyConnectorRow, "id" | "status" | "last_heartbeat_at"> | null;
      const heartbeatAt = connector?.last_heartbeat_at ? new Date(connector.last_heartbeat_at).getTime() : 0;
      const heartbeatStale = !heartbeatAt || Date.now() - heartbeatAt > BRIDGE_HEARTBEAT_STALE_MS;
      const matches = Boolean(bindingRow && tallyCompanyMatches(bindingRow.expected_tally_company_guid, bindingRow.expected_tally_company_name, bindingRow.observed_tally_company_guid, bindingRow.observed_tally_company_name));
      const tallyStatus = !bindingRow ? "not_bound" : !connector || connector.status !== "paired" ? "awaiting_pairing" : heartbeatStale ? "bridge_stale" : matches ? "ready" : "company_mismatch";
      const outboxCounts = counts.outboxCounts ?? {};
      const commandCounts = counts.commandCounts ?? {};
      const messageCounts = counts.messageCounts ?? {};
      const retryingMessages = counts.retrying ?? 0;
      const terminalMessages = counts.terminalFailures ?? 0;
      const failedOutbox = failedOutboxResult.data as { id: string; correlation_id: string | null; created_at: string; last_error: string | null } | null;
      const failedCommand = failedCommandResult.data as { id: string; correlation_id: string | null; created_at: string; failure_reason: string | null } | null;
      const proposalCount = counts.proposalCount ?? 0;
      const missingConfiguration = [...(activeVersionResult.data?.length ? [] : ["an active CD or TOD rule version"]), ...(templateResult.data?.length ? [] : ["an approved WhatsApp template"])];
      const sync = { masters: syncReadiness(mastersResult.data), vouchers: syncReadiness(vouchersResult.data) };
      const alerts = buildOperationsAlerts({ now: new Date().toISOString(), tally: { status: tallyStatus, lastMismatchAt: bindingRow?.last_mismatch_at }, outbox: { failed: outboxCounts.failed ?? 0, deadLetter: outboxCounts.dead_letter ?? 0, oldestFailure: failedOutbox ? { id: failedOutbox.id, correlationId: failedOutbox.correlation_id, createdAt: failedOutbox.created_at, lastError: failedOutbox.last_error } : null }, commands: { failed: commandCounts.failed ?? 0, deadLetter: commandCounts.dead_letter ?? 0, oldestFailure: failedCommand ? { id: failedCommand.id, correlationId: failedCommand.correlation_id, createdAt: failedCommand.created_at, failureReason: failedCommand.failure_reason } : null }, messages: { retrying: retryingMessages, terminalFailures: terminalMessages }, missingConfiguration, staleProposalCount: proposalCount, launchMode: launchControl.mode });
      const payload = { companyId: company.id, generatedAt: new Date().toISOString(), launchControl, tally: { status: tallyStatus, ready: tallyStatus === "ready", heartbeat: { at: connector?.last_heartbeat_at ?? null, stale: heartbeatStale }, wrongCompanyBinding: tallyStatus === "company_mismatch", sync }, outbox: { counts: outboxCounts, backlog: (outboxCounts.pending ?? 0) + (outboxCounts.processing ?? 0), failed: outboxCounts.failed ?? 0, deadLetter: outboxCounts.dead_letter ?? 0, sampledItems: Object.values(outboxCounts).reduce((total, count) => total + (count as number), 0) }, bridgeCommands: { counts: commandCounts, failed: commandCounts.failed ?? 0, deadLetter: commandCounts.dead_letter ?? 0, sampledItems: Object.values(commandCounts).reduce((total, count) => total + (count as number), 0) }, messages: { counts: messageCounts, queue: (messageCounts.queued ?? 0) + (messageCounts.sending ?? 0), retrying: retryingMessages, terminalFailures: terminalMessages, sampledItems: Object.values(messageCounts).reduce((total, count) => total + (count as number), 0) }, configuration: { missing: missingConfiguration }, proposals: { reviewInvalidatedOrNeedsReview: proposalCount }, alerts };
      healthCache.set(company.id, { expiresAt: Date.now() + HEALTH_CACHE_TTL_MS, data: payload });
      return jsonWithCors(request, payload, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "MISS" } });
    }

    if (rpcError && !isMissingRpc) console.warn("get_operations_health_counts RPC failed, falling back:", rpcError);
    // Fallback path
    const fallback = await loadHealthFallback(company, bindingRow);
    const { connectorResult, mastersResult, vouchersResult, outboxCounts, commandCounts, messageCounts, retryingMessages, terminalMessages, failedOutboxResult, failedCommandResult, proposalResult, activeVersionResult, templateResult, launchControl, tallyStatus, heartbeatStale, connector } = fallback as unknown as { connectorResult: { data: unknown }; mastersResult: { data: unknown }; vouchersResult: { data: unknown }; outboxCounts: Record<string, number>; commandCounts: Record<string, number>; messageCounts: Record<string, number>; retryingMessages: number; terminalMessages: number; failedOutboxResult: { data: unknown }; failedCommandResult: { data: unknown }; proposalResult: { count: number | null; data: unknown }; activeVersionResult: { data: unknown[] }; templateResult: { data: unknown[] }; launchControl: unknown; tallyStatus: string; heartbeatStale: boolean; connector: Pick<TallyConnectorRow, "id" | "status" | "last_heartbeat_at"> | null };
    const failedOutbox = (failedOutboxResult as { data: { id: string; correlation_id: string | null; created_at: string; last_error: string | null } | null }).data;
    const failedCommand = (failedCommandResult as { data: { id: string; correlation_id: string | null; created_at: string; failure_reason: string | null } | null }).data;
    const missingConfiguration = [...((activeVersionResult as { data: unknown[] }).data?.length ? [] : ["an active CD or TOD rule version"]), ...((templateResult as { data: unknown[] }).data?.length ? [] : ["an approved WhatsApp template"])];
    const sync = { masters: syncReadiness((mastersResult as { data: { status: string; completed_at: string | null; error_summary: string | null } | null }).data), vouchers: syncReadiness((vouchersResult as { data: { status: string; completed_at: string | null; error_summary: string | null } | null }).data) };
    const alerts = buildOperationsAlerts({
      now: new Date().toISOString(), tally: { status: tallyStatus, lastMismatchAt: bindingRow?.last_mismatch_at },
      outbox: { failed: outboxCounts.failed, deadLetter: outboxCounts.dead_letter, oldestFailure: failedOutbox ? { id: failedOutbox.id, correlationId: failedOutbox.correlation_id, createdAt: failedOutbox.created_at, lastError: failedOutbox.last_error } : null },
      commands: { failed: commandCounts.failed, deadLetter: commandCounts.dead_letter, oldestFailure: failedCommand ? { id: failedCommand.id, correlationId: failedCommand.correlation_id, createdAt: failedCommand.created_at, failureReason: failedCommand.failure_reason } : null },
      messages: { retrying: retryingMessages, terminalFailures: terminalMessages }, missingConfiguration,
      staleProposalCount: (proposalResult as { count: number | null }).count ?? 0, launchMode: (launchControl as { mode: string }).mode as "review_only" | "posting_enabled",
    });
    const payload = {
      companyId: company.id, generatedAt: new Date().toISOString(), launchControl,
      tally: { status: tallyStatus, ready: tallyStatus === "ready", heartbeat: { at: (connector as { last_heartbeat_at: string | null } | null)?.last_heartbeat_at ?? null, stale: heartbeatStale }, wrongCompanyBinding: tallyStatus === "company_mismatch", sync },
      outbox: { counts: outboxCounts, backlog: outboxCounts.pending + outboxCounts.processing, failed: outboxCounts.failed, deadLetter: outboxCounts.dead_letter, sampledItems: Object.values(outboxCounts).reduce((total, count) => total + count, 0) },
      bridgeCommands: { counts: commandCounts, failed: commandCounts.failed, deadLetter: commandCounts.dead_letter, sampledItems: Object.values(commandCounts).reduce((total, count) => total + count, 0) },
      messages: { counts: messageCounts, queue: messageCounts.queued + messageCounts.sending, retrying: retryingMessages, terminalFailures: terminalMessages, sampledItems: Object.values(messageCounts).reduce((total, count) => total + count, 0) },
      configuration: { missing: missingConfiguration }, proposals: { reviewInvalidatedOrNeedsReview: (proposalResult as { count: number | null }).count ?? 0 }, alerts,
    };
    healthCache.set(company.id, { expiresAt: Date.now() + HEALTH_CACHE_TTL_MS, data: payload });
    return jsonWithCors(request, payload, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": isMissingRpc ? "FALLBACK-MISSING-RPC" : "FALLBACK" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load operations health:", error);
    return jsonWithCors(request, { error: "Could not load operations health." }, { status: 500 });
  }
}
