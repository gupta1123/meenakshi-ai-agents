import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { authenticateMeenakshiBridge, bridgeVersionIsOlder, MINIMUM_BRIDGE_VERSION, tallyCompanyMatches } from "@/lib/bridge";
import { isUuid, readBridgeToken, readText, requestIpHash } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type BindingRow = { id: string; company_id: string; expected_tally_company_guid: string; expected_tally_company_name: string };
type TallyCompany = { name: string; guid: string; isActive: boolean };

function readActiveCompany(body: Record<string, unknown>) {
  const active = body.activeCompany && typeof body.activeCompany === "object" ? body.activeCompany as Record<string, unknown> : {};
  return { guid: readText(active.guid ?? body.activeCompanyGuid, 500), name: readText(active.name ?? active.companyName ?? body.activeCompanyName, 500) };
}

function sameTallyCompany(left: Pick<TallyCompany, "name" | "guid">, right: Pick<TallyCompany, "name" | "guid">) {
  if (left.guid && right.guid) return left.guid.toLowerCase() === right.guid.toLowerCase();
  return left.name.toLowerCase() === right.name.toLowerCase();
}

function readAvailableCompanies(body: Record<string, unknown>, activeCompany: { name: string | null; guid: string | null }) {
  const values = Array.isArray(body.availableCompanies) ? body.availableCompanies : [];
  const seen = new Set<string>();
  const companies: TallyCompany[] = [];

  for (const value of values.slice(0, 100)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const name = readText(row.name ?? row.companyName, 500);
    const guid = readText(row.guid, 500);
    if (!name || !guid) continue;
    const key = guid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push({ name, guid, isActive: false });
  }

  if (activeCompany.name && activeCompany.guid) {
    const active = { name: activeCompany.name, guid: activeCompany.guid };
    const existing = companies.find((company) => sameTallyCompany(company, active));
    if (existing) existing.isActive = true;
    else companies.unshift({ ...active, isActive: true });
  }

  return companies.sort((left, right) => Number(right.isActive) - Number(left.isActive));
}

function isRuntimeSchemaUnavailable(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "PGRST204" || value?.code === "42P01" || /tally_connector_company_observations|tally_url|last_tally_reachable|last_company_loaded|last_tested_at/i.test(value?.message ?? "");
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const connectorId = readText(body.connectorId, 80);
    const machineFingerprint = readText(body.machineFingerprint, 500);
    const bridgeVersion = readText(body.bridgeVersion, 120) ?? "unknown";
    const controlToken = readBridgeToken(request) || readText(body.controlToken, 500) || "";
    if (!isUuid(connectorId) || !machineFingerprint || !controlToken) return jsonWithCors(request, { error: "connectorId, machineFingerprint, and controlToken are required." }, { status: 400 });
    const connector = await authenticateMeenakshiBridge(connectorId, controlToken);
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    if (connector.machine_fingerprint !== machineFingerprint) return jsonWithCors(request, { error: "Heartbeat came from a different connector installation." }, { status: 409 });
    if (bridgeVersionIsOlder(bridgeVersion)) return jsonWithCors(request, { error: `Connector update required. Install Meenakshi Tally Connector ${MINIMUM_BRIDGE_VERSION} or newer.` }, { status: 426 });
    const activeCompany = readActiveCompany(body);
    const availableCompanies = readAvailableCompanies(body, activeCompany);
    const tallyUrl = readText(body.tallyUrl, 500) ?? "http://localhost:9000";
    const tallyReachable = body.tallyReachable !== false;
    const companyLoaded = tallyReachable && body.companyLoaded !== false && Boolean(activeCompany.name && activeCompany.guid);
    const companySnapshotFresh = body.companySnapshotFresh !== false;
    const heartbeatError = readText(body.error, 2_000);
    const supabase = createSupabaseAdminClient();
    const now = new Date().toISOString();
    const previousRuntime = await supabase.from("tally_connectors")
      .select("last_tally_reachable, last_company_loaded, last_company_name, last_error, last_tested_at")
      .eq("id", connector.id)
      .maybeSingle();
    if (previousRuntime.error && !isRuntimeSchemaUnavailable(previousRuntime.error)) throw previousRuntime.error;
    const previous = previousRuntime.error ? null : previousRuntime.data;
    const stateChanged = !previous
      || previous.last_tally_reachable !== tallyReachable
      || previous.last_company_loaded !== companyLoaded
      || previous.last_company_name !== (companyLoaded ? activeCompany.name : null)
      || previous.last_error !== heartbeatError;
    const previousTestedAt = previous?.last_tested_at ? new Date(previous.last_tested_at).getTime() : 0;
    const refreshCompanyObservations = companySnapshotFresh && (stateChanged || !previousTestedAt || Math.floor(Date.now() / 60_000) !== Math.floor(previousTestedAt / 60_000));
    const runtimeHeartbeat = await supabase.from("tally_connectors").update({
      bridge_version: bridgeVersion,
      last_heartbeat_at: now,
      last_ip_hash: requestIpHash(request),
      tally_url: tallyUrl,
      last_tally_reachable: tallyReachable,
      last_company_loaded: companyLoaded,
      last_company_name: companyLoaded ? activeCompany.name : null,
      last_error: heartbeatError,
      last_tested_at: now,
    }).eq("id", connector.id).eq("status", "paired");
    const runtimeSchemaAvailable = !runtimeHeartbeat.error;
    if (runtimeHeartbeat.error && !isRuntimeSchemaUnavailable(runtimeHeartbeat.error)) throw runtimeHeartbeat.error;
    if (!runtimeSchemaAvailable) {
      const { error: legacyHeartbeatError } = await supabase.from("tally_connectors").update({ bridge_version: bridgeVersion, last_heartbeat_at: now, last_ip_hash: requestIpHash(request) }).eq("id", connector.id).eq("status", "paired");
      if (legacyHeartbeatError) throw legacyHeartbeatError;
    }
    if (runtimeSchemaAvailable && refreshCompanyObservations) {
      const unavailable = await supabase.from("tally_connector_company_observations").update({ is_available: false, is_active: false }).eq("connector_id", connector.id);
      if (unavailable.error) throw unavailable.error;
      if (availableCompanies.length > 0) {
        const observations = availableCompanies.map((company) => ({
          organization_id: connector.organization_id,
          connector_id: connector.id,
          tally_company_guid: company.guid,
          tally_company_name: company.name,
          is_available: true,
          is_active: company.isActive,
          last_seen_at: now,
        }));
        const { error: observationError } = await supabase.from("tally_connector_company_observations").upsert(observations, { onConflict: "connector_id,tally_company_guid" });
        if (observationError) throw observationError;
      }
    }
    const { data: bindings, error: bindingError } = await supabase.from("tally_connector_company_bindings").select("id, company_id, expected_tally_company_guid, expected_tally_company_name").eq("connector_id", connector.id).eq("is_active", true);
    if (bindingError) throw bindingError;
    const bindingStates = await Promise.all(((bindings ?? []) as unknown as BindingRow[]).map(async (binding) => {
      const matches = tallyCompanyMatches(binding.expected_tally_company_guid, binding.expected_tally_company_name, activeCompany.guid, activeCompany.name);
      const { error } = await supabase.from("tally_connector_company_bindings").update({ observed_tally_company_guid: activeCompany.guid, observed_tally_company_name: activeCompany.name, ...(matches ? { last_validated_at: now } : { last_mismatch_at: now }) }).eq("id", binding.id).eq("connector_id", connector.id);
      if (error) throw error;
      return {
        companyId: binding.company_id,
        matches,
        expectedCompany: { guid: binding.expected_tally_company_guid, name: binding.expected_tally_company_name },
      };
    }));
    if (stateChanged) {
      await appendMeenakshiAuditEvent({
        organizationId: connector.organization_id,
        companyId: bindingStates.find((binding) => binding.matches)?.companyId ?? null,
        actorType: "tally_connector",
        action: "tally_connector_heartbeat",
        entityType: "tally_connector",
        entityId: connector.id,
        metadata: { activeCompany, availableCompanies, bridgeVersion, tallyUrl, tallyReachable, companyLoaded, error: heartbeatError },
      });
    }
    return jsonWithCors(request, { acceptedAt: now, tallyReachable, companyLoaded, activeCompany, availableCompanies, bindings: bindingStates });
  } catch (error) {
    console.error("Error in POST /api/bridge/heartbeat:", error);
    return jsonWithCors(request, { error: "Could not record bridge heartbeat." }, { status: 500 });
  }
}
