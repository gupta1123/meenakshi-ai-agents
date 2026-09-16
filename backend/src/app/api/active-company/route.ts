import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { BRIDGE_HEARTBEAT_STALE_MS, MEENAKSHI_FEATURE } from "@/lib/constants";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type CompanyRow = {
  id: string;
  organization_id: string;
  code: string;
  tally_company_guid: string;
  tally_company_name: string;
};
type ConnectorRow = {
  id: string;
  organization_id: string;
  display_name: string;
  last_heartbeat_at: string | null;
  last_tally_reachable: boolean | null;
  last_company_loaded: boolean | null;
};
type ObservationRow = {
  connector_id: string;
  tally_company_guid: string;
  tally_company_name: string;
};
type BindingRow = {
  company_id: string;
  connector_id: string;
  expected_tally_company_guid: string;
};

function normalized(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function heartbeatIsFresh(value: string | null) {
  const timestamp = value ? new Date(value).getTime() : 0;
  return timestamp > 0 && Date.now() - timestamp <= BRIDGE_HEARTBEAT_STALE_MS;
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

// The browser must never choose a database company independently from Tally.
// This resolves the single currently-active, authorised company from the live
// connector observation. A missing or ambiguous result is deliberately not a
// fallback to a previously selected company.
export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const supabase = createSupabaseAdminClient();
    const [{ data: memberships, error: membershipError }, { data: features, error: featureError }] = await Promise.all([
      supabase.from("organization_memberships").select("organization_id").eq("profile_id", user.id),
      supabase.from("organization_features").select("organization_id").eq("feature", MEENAKSHI_FEATURE).eq("is_enabled", true),
    ]);
    if (membershipError || featureError) throw membershipError ?? featureError;

    const memberOrganizationIds = new Set((memberships ?? []).map((row) => String(row.organization_id)));
    const candidateOrganizationIds = [...new Set((features ?? [])
      .map((row) => String(row.organization_id))
      .filter((organizationId) => memberOrganizationIds.has(organizationId)))];
    if (!candidateOrganizationIds.length) return jsonWithCors(request, { status: "no_authorized_companies", company: null });
    const { data: organizations, error: organizationError } = await supabase
      .from("organizations")
      .select("id")
      .in("id", candidateOrganizationIds)
      .eq("is_active", true);
    if (organizationError) throw organizationError;
    const organizationIds = (organizations ?? []).map((organization) => String(organization.id));
    if (!organizationIds.length) return jsonWithCors(request, { status: "no_authorized_companies", company: null });

    const { data: companies, error: companyError } = await supabase
      .from("companies")
      .select("id, organization_id, code, tally_company_guid, tally_company_name")
      .in("organization_id", organizationIds)
      .eq("is_active", true);
    if (companyError) throw companyError;
    const companyRows = (companies ?? []) as CompanyRow[];
    if (!companyRows.length) return jsonWithCors(request, { status: "no_authorized_companies", company: null });

    const { data: connectors, error: connectorError } = await supabase
      .from("tally_connectors")
      .select("id, organization_id, display_name, last_heartbeat_at, last_tally_reachable, last_company_loaded")
      .in("organization_id", organizationIds)
      .eq("status", "paired");
    if (connectorError) throw connectorError;
    const liveConnectors = ((connectors ?? []) as ConnectorRow[]).filter((connector) => (
      heartbeatIsFresh(connector.last_heartbeat_at)
      && connector.last_tally_reachable !== false
      && connector.last_company_loaded !== false
    ));
    if (!liveConnectors.length) return jsonWithCors(request, { status: "tally_not_connected", company: null });

    const connectorIds = liveConnectors.map((connector) => connector.id);
    const [{ data: observations, error: observationError }, { data: bindings, error: bindingError }] = await Promise.all([
      supabase.from("tally_connector_company_observations")
        .select("connector_id, tally_company_guid, tally_company_name")
        .in("connector_id", connectorIds)
        .eq("is_available", true)
        .eq("is_active", true),
      supabase.from("tally_connector_company_bindings")
        .select("company_id, connector_id, expected_tally_company_guid")
        .in("connector_id", connectorIds)
        .eq("is_active", true),
    ]);
    if (observationError || bindingError) throw observationError ?? bindingError;
    const activeObservations = (observations ?? []) as ObservationRow[];
    if (!activeObservations.length) return jsonWithCors(request, { status: "company_not_open", company: null });
    const distinctActiveTallyCompanies = new Map<string, ObservationRow>();
    for (const observation of activeObservations) {
      distinctActiveTallyCompanies.set(normalized(observation.tally_company_guid), observation);
    }
    // A browser cannot safely infer which workstation it represents when two
    // connectors report different active companies. Require a single live
    // Tally context instead of silently choosing one database record.
    if (distinctActiveTallyCompanies.size > 1) {
      return jsonWithCors(request, {
        status: "ambiguous_active_companies",
        company: null,
        activeTallyCompanies: [...distinctActiveTallyCompanies.values()].map((observation) => ({ guid: observation.tally_company_guid, name: observation.tally_company_name })),
      });
    }

    const companyByOrganizationAndGuid = new Map(companyRows.map((company) => [
      `${company.organization_id}:${normalized(company.tally_company_guid)}`,
      company,
    ]));
    const activeBindingKeys = new Set(((bindings ?? []) as BindingRow[]).map((binding) => (
      `${binding.connector_id}:${binding.company_id}:${normalized(binding.expected_tally_company_guid)}`
    )));
    const connectorById = new Map(liveConnectors.map((connector) => [connector.id, connector]));
    const matches = new Map<string, { company: CompanyRow; connector: ConnectorRow; observation: ObservationRow }>();

    for (const observation of activeObservations) {
      const connector = connectorById.get(observation.connector_id);
      const company = connector
        ? companyByOrganizationAndGuid.get(`${connector.organization_id}:${normalized(observation.tally_company_guid)}`)
        : undefined;
      if (!company || !connector) continue;
      const bindingKey = `${connector.id}:${company.id}:${normalized(company.tally_company_guid)}`;
      if (!activeBindingKeys.has(bindingKey)) continue;
      const existing = matches.get(company.id);
      if (!existing || (connector.last_heartbeat_at ?? "") > (existing.connector.last_heartbeat_at ?? "")) {
        matches.set(company.id, { company, connector, observation });
      }
    }

    if (!matches.size) {
      const activeTallyCompany = activeObservations.length === 1
        ? { guid: activeObservations[0].tally_company_guid, name: activeObservations[0].tally_company_name }
        : null;
      return jsonWithCors(request, { status: "active_company_not_registered", company: null, activeTallyCompany });
    }
    if (matches.size > 1) {
      return jsonWithCors(request, {
        status: "ambiguous_active_companies",
        company: null,
        activeTallyCompanies: [...matches.values()].map((match) => ({ guid: match.observation.tally_company_guid, name: match.observation.tally_company_name })),
      });
    }

    const match = [...matches.values()][0];
    return jsonWithCors(request, {
      status: "ready",
      company: {
        id: match.company.id,
        organizationId: match.company.organization_id,
        code: match.company.code,
        tallyCompanyGuid: match.company.tally_company_guid,
        tallyCompanyName: match.company.tally_company_name,
      },
      connector: { id: match.connector.id, displayName: match.connector.display_name },
      activeTallyCompany: { guid: match.observation.tally_company_guid, name: match.observation.tally_company_name },
    });
  } catch (error) {
    console.error("Error in GET /api/active-company:", error);
    return jsonWithCors(request, { error: "Could not resolve the active Tally company." }, { status: 500 });
  }
}
