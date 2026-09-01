import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiOrganizationAccess } from "@/lib/authorization";
import { BRIDGE_HEARTBEAT_STALE_MS } from "@/lib/constants";
import { TALLY_CONNECTOR_SELECT, type TallyConnectorRow } from "@/lib/bridge";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ connectorId: string }> };
type TallyCompany = { name: string; guid: string; isActive: boolean };
type RuntimeRow = {
  tally_url: string;
  last_tally_reachable: boolean | null;
  last_company_loaded: boolean | null;
  last_company_name: string | null;
  last_error: string | null;
  last_tested_at: string | null;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

function isRuntimeSchemaUnavailable(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "PGRST204" || value?.code === "PGRST205" || value?.code === "42P01" || /tally_connector_company_observations|tally_url|last_tally_reachable|last_company_loaded|last_tested_at/i.test(value?.message ?? "");
}

function snapshotCompanies(metadata: unknown) {
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const activeRecord = record.activeCompany && typeof record.activeCompany === "object" ? record.activeCompany as Record<string, unknown> : {};
  const activeName = text(activeRecord.name ?? activeRecord.companyName);
  const activeGuid = text(activeRecord.guid);
  const values = Array.isArray(record.availableCompanies) ? record.availableCompanies : [];
  const seen = new Set<string>();
  const companies: TallyCompany[] = [];

  for (const value of values.slice(0, 100)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const name = text(row.name ?? row.companyName);
    const guid = text(row.guid);
    if (!name || !guid || seen.has(guid.toLowerCase())) continue;
    seen.add(guid.toLowerCase());
    companies.push({ name, guid, isActive: activeGuid ? guid.toLowerCase() === activeGuid.toLowerCase() : name.toLowerCase() === activeName?.toLowerCase() });
  }

  if (activeName && activeGuid && !companies.some((company) => company.guid.toLowerCase() === activeGuid.toLowerCase())) {
    companies.unshift({ name: activeName, guid: activeGuid, isActive: true });
  }

  return companies.sort((left, right) => Number(right.isActive) - Number(left.isActive));
}

function isFresh(value: string | null | undefined) {
  const timestamp = value ? new Date(value).getTime() : 0;
  return timestamp > 0 && Date.now() - timestamp <= BRIDGE_HEARTBEAT_STALE_MS;
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { connectorId } = await context.params;
    if (!isUuid(connectorId)) return jsonWithCors(request, { error: "Invalid connector id." }, { status: 400 });

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.from("tally_connectors").select(TALLY_CONNECTOR_SELECT).eq("id", connectorId).maybeSingle();
    if (error) throw error;
    const connector = data as unknown as TallyConnectorRow | null;
    if (!connector) return jsonWithCors(request, { error: "Connector not found." }, { status: 404 });
    await requireMeenakshiOrganizationAccess(request, connector.organization_id);

    const runtimeResult = await supabase.from("tally_connectors")
      .select("tally_url, last_tally_reachable, last_company_loaded, last_company_name, last_error, last_tested_at")
      .eq("id", connector.id)
      .maybeSingle();
    if (runtimeResult.error && !isRuntimeSchemaUnavailable(runtimeResult.error)) throw runtimeResult.error;
    const runtime = runtimeResult.error ? null : runtimeResult.data as RuntimeRow | null;

    const snapshotResult = await supabase.from("audit_events")
      .select("created_at, metadata")
      .eq("organization_id", connector.organization_id)
      .eq("action", "tally_connector_heartbeat")
      .eq("entity_type", "tally_connector")
      .eq("entity_id", connector.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (snapshotResult.error) throw snapshotResult.error;
    const snapshot = snapshotResult.data as { created_at: string; metadata: unknown } | null;

    let companies: TallyCompany[] = [];
    if (runtime) {
      const observations = await supabase.from("tally_connector_company_observations")
        .select("tally_company_guid, tally_company_name, is_active")
        .eq("connector_id", connector.id)
        .eq("is_available", true)
        .order("is_active", { ascending: false })
        .order("tally_company_name");
      if (observations.error && !isRuntimeSchemaUnavailable(observations.error)) throw observations.error;
      if (!observations.error) {
        companies = (observations.data ?? []).map((row) => ({
          guid: String(row.tally_company_guid),
          name: String(row.tally_company_name),
          isActive: row.is_active === true,
        }));
      }
    }
    if (companies.length === 0) companies = snapshotCompanies(snapshot?.metadata);

    const bridgeConnected = connector.status === "paired" && isFresh(connector.last_heartbeat_at);
    const fallbackTallyReachable = bridgeConnected && isFresh(snapshot?.created_at) && companies.length > 0;
    const tallyReachable = bridgeConnected && (runtime?.last_tally_reachable ?? fallbackTallyReachable);
    const activeCompany = companies.find((company) => company.isActive) ?? null;
    const companyLoaded = tallyReachable && (runtime?.last_company_loaded ?? Boolean(activeCompany));

    return jsonWithCors(request, {
      connector: {
        id: connector.id,
        displayName: connector.display_name,
        status: connector.status,
        tallyUrl: runtime?.tally_url ?? text((snapshot?.metadata as Record<string, unknown> | undefined)?.tallyUrl) ?? "http://localhost:9000",
        bridgeConnected,
        tallyReachable,
        companyLoaded,
        heartbeatStale: connector.status === "paired" && !bridgeConnected,
        lastHeartbeatAt: connector.last_heartbeat_at,
        lastTestedAt: runtime?.last_tested_at ?? snapshot?.created_at ?? connector.last_heartbeat_at,
        lastCompanyName: runtime?.last_company_name ?? activeCompany?.name ?? null,
        lastError: runtime?.last_error ?? null,
      },
      companies: bridgeConnected && tallyReachable ? companies : [],
      activeCompany: bridgeConnected && companyLoaded ? activeCompany : null,
    });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Error in GET /api/connectors/[connectorId]/tally-companies:", error);
    return jsonWithCors(request, { error: "Could not load the live Tally connection." }, { status: 500 });
  }
}
