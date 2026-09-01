import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { MeenakshiAccessError, requireMeenakshiOrganizationAccess } from "@/lib/authorization";
import { TALLY_CONNECTOR_SELECT, type TallyConnectorRow } from "@/lib/bridge";
import { createConnectorControlToken, hashConnectorSecret, isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ connectorId: string }> };

function runtimeSchemaUnavailable(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "PGRST204" || /last_tally_reachable|last_company_loaded|last_company_name|last_error|last_tested_at/i.test(value?.message ?? "");
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { connectorId } = await context.params;
    if (!isUuid(connectorId)) return jsonWithCors(request, { error: "Invalid connector id." }, { status: 400 });

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.from("tally_connectors").select(TALLY_CONNECTOR_SELECT).eq("id", connectorId).maybeSingle();
    if (error) throw error;
    const connector = data as unknown as TallyConnectorRow | null;
    if (!connector || connector.status === "revoked") return jsonWithCors(request, { error: "Connector was not found." }, { status: 404 });

    const scope = await requireMeenakshiOrganizationAccess(request, connector.organization_id, ["administrator"]);
    const disconnectedAt = new Date().toISOString();
    const staleHeartbeat = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const nextControlTokenHash = hashConnectorSecret(createConnectorControlToken());
    const update = await supabase.from("tally_connectors").update({
      control_token_hash: nextControlTokenHash,
      status: "pending_pairing",
      paired_at: null,
      last_heartbeat_at: staleHeartbeat,
      last_tally_reachable: false,
      last_company_loaded: false,
      last_company_name: null,
      last_error: "Disconnected by user",
      last_tested_at: disconnectedAt,
    }).eq("id", connector.id);
    if (update.error && !runtimeSchemaUnavailable(update.error)) throw update.error;
    if (update.error) {
      const fallback = await supabase.from("tally_connectors").update({
        control_token_hash: nextControlTokenHash,
        status: "pending_pairing",
        paired_at: null,
        last_heartbeat_at: staleHeartbeat,
      }).eq("id", connector.id);
      if (fallback.error) throw fallback.error;
    }

    const observations = await supabase.from("tally_connector_company_observations")
      .update({ is_available: false, is_active: false })
      .eq("connector_id", connector.id);
    if (observations.error && !/tally_connector_company_observations/i.test(observations.error.message)) throw observations.error;

    await appendMeenakshiAuditEvent({
      organizationId: connector.organization_id,
      actorType: "user",
      actorId: scope.userId,
      action: "tally_connector_disconnected",
      entityType: "tally_connector",
      entityId: connector.id,
      previousValue: { status: connector.status },
      newValue: { status: "pending_pairing" },
      metadata: { disconnectedAt, reason: "user_requested" },
    });

    return jsonWithCors(request, { disconnectedAt });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not disconnect Tally connector:", error);
    return jsonWithCors(request, { error: "Could not disconnect Tally." }, { status: 500 });
  }
}
