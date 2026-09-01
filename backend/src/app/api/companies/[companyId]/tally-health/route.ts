import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { tallyCompanyMatches, type TallyConnectorRow } from "@/lib/bridge";
import { BRIDGE_HEARTBEAT_STALE_MS, TALLY_SYNC_STALE_MS } from "@/lib/constants";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function syncReadiness(sync: { status: string; completed_at: string | null; error_summary: string | null } | null) {
  if (!sync) return { status: "required", completedAt: null, stale: true, errorSummary: null };
  const completedAt = sync.completed_at;
  const stale = !completedAt || Date.now() - new Date(completedAt).getTime() > TALLY_SYNC_STALE_MS;
  return {
    status: sync.status === "completed" && !stale ? "current" : sync.status === "completed" ? "stale" : sync.status,
    completedAt,
    stale,
    errorSummary: sync.error_summary,
  };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId);
    const supabase = createSupabaseAdminClient();
    const { data: binding, error: bindingError } = await supabase.from("tally_connector_company_bindings").select("id, connector_id, expected_tally_company_guid, expected_tally_company_name, observed_tally_company_guid, observed_tally_company_name, is_active, last_validated_at, last_mismatch_at").eq("company_id", company.id).eq("is_active", true).maybeSingle();
    if (bindingError) throw bindingError;
    if (!binding) return jsonWithCors(request, { status: "not_bound", ready: false, companyId: company.id });
    const bindingRow = binding as { id: string; connector_id: string; expected_tally_company_guid: string; expected_tally_company_name: string; observed_tally_company_guid: string | null; observed_tally_company_name: string | null; last_validated_at: string | null; last_mismatch_at: string | null };
    const [{ data: connector, error: connectorError }, { data: latestMasters, error: mastersError }, { data: latestVouchers, error: vouchersError }] = await Promise.all([
      supabase.from("tally_connectors").select("id, status, display_name, bridge_version, last_heartbeat_at, last_tally_reachable, last_company_loaded, last_error").eq("id", bindingRow.connector_id).maybeSingle(),
      supabase.from("tally_sync_runs").select("status, completed_at, error_summary").eq("company_id", company.id).eq("sync_kind", "masters").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("tally_sync_runs").select("status, completed_at, error_summary").eq("company_id", company.id).eq("sync_kind", "vouchers").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (connectorError || mastersError || vouchersError) throw connectorError ?? mastersError ?? vouchersError;
    const connectorRow = connector as (Pick<TallyConnectorRow, "id" | "status" | "display_name" | "bridge_version" | "last_heartbeat_at"> & { last_tally_reachable: boolean | null; last_company_loaded: boolean | null; last_error: string | null }) | null;
    if (!connectorRow || connectorRow.status !== "paired") return jsonWithCors(request, {
      status: "awaiting_pairing",
      ready: false,
      companyId: company.id,
      connector: connectorRow ? {
        id: connectorRow.id,
        displayName: connectorRow.display_name,
        bridgeVersion: connectorRow.bridge_version,
        lastHeartbeatAt: connectorRow.last_heartbeat_at,
      } : undefined,
      binding: {
        id: bindingRow.id,
        expectedCompanyGuid: bindingRow.expected_tally_company_guid,
        expectedCompanyName: bindingRow.expected_tally_company_name,
        observedCompanyGuid: bindingRow.observed_tally_company_guid,
        observedCompanyName: bindingRow.observed_tally_company_name,
        lastValidatedAt: bindingRow.last_validated_at,
        lastMismatchAt: bindingRow.last_mismatch_at,
      },
      sync: { masters: syncReadiness(latestMasters), vouchers: syncReadiness(latestVouchers) },
    });
    const heartbeatAt = connectorRow.last_heartbeat_at ? new Date(connectorRow.last_heartbeat_at).getTime() : 0;
    const stale = !heartbeatAt || Date.now() - heartbeatAt > BRIDGE_HEARTBEAT_STALE_MS;
    const matches = tallyCompanyMatches(bindingRow.expected_tally_company_guid, bindingRow.expected_tally_company_name, bindingRow.observed_tally_company_guid, bindingRow.observed_tally_company_name);
    const status = stale
      ? "bridge_stale"
      : connectorRow.last_tally_reachable === false
        ? "tally_unreachable"
        : connectorRow.last_company_loaded === false
          ? "company_not_open"
          : matches
            ? "ready"
            : "company_mismatch";
    return jsonWithCors(request, {
      status,
      ready: status === "ready",
      companyId: company.id,
      connector: { id: connectorRow.id, displayName: connectorRow.display_name, bridgeVersion: connectorRow.bridge_version, lastHeartbeatAt: connectorRow.last_heartbeat_at, lastError: connectorRow.last_error },
      binding: { id: bindingRow.id, expectedCompanyGuid: bindingRow.expected_tally_company_guid, expectedCompanyName: bindingRow.expected_tally_company_name, observedCompanyGuid: bindingRow.observed_tally_company_guid, observedCompanyName: bindingRow.observed_tally_company_name, lastValidatedAt: bindingRow.last_validated_at, lastMismatchAt: bindingRow.last_mismatch_at },
      sync: { masters: syncReadiness(latestMasters), vouchers: syncReadiness(latestVouchers) },
    });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Error in GET /api/companies/[companyId]/tally-health:", error);
    return jsonWithCors(request, { error: "Could not load Tally health." }, { status: 500 });
  }
}
