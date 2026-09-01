import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { tallyCompanyMatches, type TallyConnectorRow } from "@/lib/bridge";
import { BRIDGE_HEARTBEAT_STALE_MS } from "@/lib/constants";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
type ProposalRow = { id: string; customer_id: string; status: string; calculated_discount_amount: string | number | null; latest_evaluated_at: string | null };
type MessageRow = { id: string; event_type: string; status: string; sent_at: string | null; created_at: string; attempt_count: number; max_attempts: number; provider_metadata: Record<string, unknown> | null };

// In-memory 10s cache: overview changes rarely (evaluations are periodic), but the
// old handler paid 8-10 PostgREST RTTs on every navigation. Cache absorbs polling bursts.
const OVERVIEW_CACHE_TTL_MS = 10_000;
const overviewCache = new Map<string, { expiresAt: number; data: unknown }>();

function getCachedOverview(companyId: string): unknown | null {
  const entry = overviewCache.get(companyId);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  if (entry) overviewCache.delete(companyId);
  return null;
}

function setCachedOverview(companyId: string, data: unknown) {
  overviewCache.set(companyId, { expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS, data });
  if (overviewCache.size > 500) {
    const now = Date.now();
    for (const [key, entry] of overviewCache) {
      if (entry.expiresAt <= now || overviewCache.size > 400) overviewCache.delete(key);
    }
  }
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }

async function loadOverviewFallback(companyId: string) {
  // Fallback for environments where the get_company_overview RPC has not been applied yet.
  // Preserves exact previous semantics but keeps it out of the fast path.
  const supabase = createSupabaseAdminClient();
  const [bindingResult, recoveryResult, proposalResult, creditNoteCountResult, creditNoteAwaitingResult, queuedMessageCountResult, failedMessageResult, recentMessageResult] = await Promise.all([
    supabase.from("tally_connector_company_bindings").select("connector_id, expected_tally_company_guid, expected_tally_company_name, observed_tally_company_guid, observed_tally_company_name").eq("company_id", companyId).eq("is_active", true).maybeSingle(),
    supabase.from("cash_discount_recovery_candidates").select("status, remaining_recovery").eq("company_id", companyId).eq("current_snapshot", true).in("status", ["action_required", "review_required", "posting"]),
    supabase.from("discount_proposals").select("id, customer_id, status, calculated_discount_amount, latest_evaluated_at").eq("company_id", companyId).eq("scheme_type", "tod").order("updated_at", { ascending: false }).limit(250),
    supabase.from("credit_note_postings").select("id", { count: "exact", head: true }).eq("company_id", companyId),
    supabase.from("credit_note_postings").select("id", { count: "exact", head: true }).eq("company_id", companyId).neq("status", "created_verified"),
    supabase.from("notification_messages").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "queued"),
    supabase.from("notification_messages").select("attempt_count, max_attempts, provider_metadata").eq("company_id", companyId).eq("status", "failed"),
    supabase.from("notification_messages").select("id, event_type, status, sent_at, created_at, attempt_count, max_attempts, provider_metadata").eq("company_id", companyId).order("created_at", { ascending: false }).limit(3),
  ]);
  const firstError = [bindingResult.error, recoveryResult.error, proposalResult.error, creditNoteCountResult.error, creditNoteAwaitingResult.error, queuedMessageCountResult.error, failedMessageResult.error, recentMessageResult.error].find(Boolean);
  if (firstError) throw firstError;

  const binding = bindingResult.data as { connector_id: string; expected_tally_company_guid: string; expected_tally_company_name: string; observed_tally_company_guid: string | null; observed_tally_company_name: string | null } | null;
  const connectorResult = binding
    ? await supabase.from("tally_connectors").select("id, status, last_heartbeat_at").eq("id", binding.connector_id).maybeSingle()
    : { data: null, error: null };
  if (connectorResult.error) throw connectorResult.error;
  const connector = connectorResult.data as Pick<TallyConnectorRow, "id" | "status" | "last_heartbeat_at"> | null;
  const heartbeatAt = connector?.last_heartbeat_at ?? null;
  const heartbeatStale = !heartbeatAt || Date.now() - new Date(heartbeatAt).getTime() > BRIDGE_HEARTBEAT_STALE_MS;
  const companyMatches = Boolean(binding && tallyCompanyMatches(binding.expected_tally_company_guid, binding.expected_tally_company_name, binding.observed_tally_company_guid, binding.observed_tally_company_name));
  const tallyStatus = !binding ? "not_bound" : !connector || connector.status !== "paired" ? "awaiting_pairing" : heartbeatStale ? "bridge_stale" : companyMatches ? "ready" : "company_mismatch";

  const recoveries = recoveryResult.data ?? [];
  const recoveryActions = recoveries.filter((row) => row.status === "action_required" || row.status === "posting");
  const recoveryReviews = recoveries.filter((row) => row.status === "review_required");
  const proposals = (proposalResult.data ?? []) as ProposalRow[];
  const proposalActivity = proposals.filter((proposal) => proposal.latest_evaluated_at).slice(0, 4);
  const customerIds = [...new Set(proposalActivity.map((proposal) => proposal.customer_id))];
  const customerResult = customerIds.length ? await supabase.from("customers").select("id, ledger_name").eq("company_id", companyId).in("id", customerIds) : { data: [], error: null };
  if (customerResult.error) throw customerResult.error;
  const customerNames = new Map((customerResult.data ?? []).map((customer) => [customer.id, customer.ledger_name]));
  const failedMessages = (failedMessageResult.data ?? []) as Pick<MessageRow, "attempt_count" | "max_attempts" | "provider_metadata">[];
  const recentMessages = (recentMessageResult.data ?? []) as MessageRow[];
  const retrying = failedMessages.filter((message) => message.attempt_count < message.max_attempts && message.provider_metadata?.terminal !== true).length;
  const terminalFailures = failedMessages.filter((message) => message.attempt_count >= message.max_attempts || message.provider_metadata?.terminal === true).length;
  const activity = [
    ...proposalActivity.map((proposal) => ({ id: proposal.id, title: "Turnover Discount result updated", detail: customerNames.get(proposal.customer_id) ?? "Customer result", at: proposal.latest_evaluated_at })),
    ...recentMessages.map((message) => ({ id: message.id, title: `WhatsApp message ${message.status.replaceAll("_", " ")}`, detail: message.event_type.replaceAll("_", " "), at: message.sent_at ?? message.created_at })),
  ].sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, 6);
  const reviewStatuses = new Set(["eligible", "needs_review", "review_invalidated", "pending_approval"]);

  return {
    generatedAt: new Date().toISOString(),
    tally: { status: tallyStatus, ready: tallyStatus === "ready", heartbeatAt },
    recoveries: { actionCount: recoveryActions.length, reviewCount: recoveryReviews.length, amount: recoveryActions.reduce((total, row) => total + Number(row.remaining_recovery ?? 0), 0) },
    turnoverDiscount: { reviewCount: proposals.filter((proposal) => reviewStatuses.has(proposal.status)).length, resultCount: proposals.length, projectedAmount: proposals.reduce((total, proposal) => total + Number(proposal.calculated_discount_amount ?? 0), 0) },
    creditNotes: { total: creditNoteCountResult.count ?? 0, awaiting: creditNoteAwaitingResult.count ?? 0 },
    messages: { queued: queuedMessageCountResult.count ?? 0, retrying, terminalFailures },
    activity,
  };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);

    // Serve from 10s in-memory cache before hitting PG
    const cached = getCachedOverview(company.id);
    if (cached) {
      return jsonWithCors(request, cached, {
        headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "HIT" },
      });
    }

    const supabase = createSupabaseAdminClient();

    // Fast path: single PG round-trip via RPC (replaces 10 HTTP->PG hops + unbounded fetch)
    const { data: rpcData, error: rpcError } = await supabase.rpc("get_company_overview", { p_company_id: company.id });

    if (!rpcError && rpcData) {
      setCachedOverview(company.id, rpcData);
      return jsonWithCors(request, rpcData, {
        headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "MISS" },
      });
    }

    // If RPC is not yet deployed (42883 undefined_function) or any other PG error,
    // fall through to the exact previous logic so the route never breaks pre-migration.
    const isMissingFunction =
      rpcError &&
      // PostgREST surfaces PG 42883 as code 42883 in message/details
      (String((rpcError as { code?: string }).code) === "42883" ||
        String(rpcError.message ?? "").includes("get_company_overview"));

    if (rpcError && !isMissingFunction) {
      console.warn("get_company_overview RPC failed, falling back to multi-query:", rpcError);
    }

    const fallback = await loadOverviewFallback(company.id);
    setCachedOverview(company.id, fallback);
    return jsonWithCors(request, fallback, {
      headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": isMissingFunction ? "FALLBACK-MISSING-RPC" : "FALLBACK" },
    });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load overview:", error);
    return jsonWithCors(request, { error: "Could not load the overview." }, { status: 500 });
  }
}
