import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { authenticateMeenakshiBridge, bridgeVersionIsOlder, MINIMUM_BRIDGE_VERSION, normalizeBooksFrom, sameTallyCompany as sameCompanyIdentity } from "@/lib/bridge";
import { isUuid, readBridgeToken, readText, requestIpHash } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { noteMasterCounter } from "@/lib/tally/auto-sync";

type BindingRow = { id: string; company_id: string; expected_tally_company_guid: string; expected_tally_company_name: string; expected_tally_books_from: string | null };
type TallyCompany = { name: string; guid: string; booksFrom: string | null; isActive: boolean };

function readActiveCompany(body: Record<string, unknown>) {
  const active = body.activeCompany && typeof body.activeCompany === "object" ? body.activeCompany as Record<string, unknown> : {};
  return { guid: readText(active.guid ?? body.activeCompanyGuid, 500), name: readText(active.name ?? active.companyName ?? body.activeCompanyName, 500), booksFrom: normalizeBooksFrom(active.booksFrom) };
}

// One Tally company is one GUID plus one financial year, so two years of the same company are two entries.
const companyKey = (company: { guid: string; booksFrom: string | null }) => `${company.guid.toLowerCase()}|${company.booksFrom ?? ""}`;

function readAvailableCompanies(body: Record<string, unknown>, activeCompany: { name: string | null; guid: string | null; booksFrom: string | null }) {
  const values = Array.isArray(body.availableCompanies) ? body.availableCompanies : [];
  const seen = new Set<string>();
  const companies: TallyCompany[] = [];

  for (const value of values.slice(0, 100)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const name = readText(row.name ?? row.companyName, 500);
    const guid = readText(row.guid, 500);
    if (!name || !guid) continue;
    const booksFrom = normalizeBooksFrom(row.booksFrom);
    const key = companyKey({ guid, booksFrom });
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push({ name, guid, booksFrom, isActive: false });
  }

  if (activeCompany.name && activeCompany.guid) {
    const active = { name: activeCompany.name, guid: activeCompany.guid, booksFrom: activeCompany.booksFrom };
    const existing = companies.find((company) => sameCompanyIdentity(active, company));
    if (existing) existing.isActive = true;
    else companies.unshift({ ...active, isActive: true });
  }

  return companies.sort((left, right) => Number(right.isActive) - Number(left.isActive));
}

type SupabaseAdmin = ReturnType<typeof createSupabaseAdminClient>;

/**
 * Record which Tally companies this connector can see. Matching is on GUID plus
 * financial year, so two years of one company are two rows. A row written before
 * years were known (no books-from) is adopted by its matching company.
 */
async function recordObservations(supabase: SupabaseAdmin, connector: { id: string; organization_id: string }, companies: TallyCompany[], now: string) {
  const { data, error } = await supabase.from("tally_connector_company_observations").select("id, tally_company_guid, tally_books_from").eq("connector_id", connector.id);
  if (error) throw error;
  const existing = (data ?? []) as Array<{ id: string; tally_company_guid: string; tally_books_from: string | null }>;
  const used = new Set<string>();
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  for (const company of companies) {
    const sameGuid = (row: { id: string; tally_company_guid: string }) => !used.has(row.id) && row.tally_company_guid.toLowerCase() === company.guid.toLowerCase();
    const match = existing.find((row) => sameGuid(row) && (row.tally_books_from ?? null) === company.booksFrom)
      ?? (company.booksFrom ? existing.find((row) => sameGuid(row) && row.tally_books_from === null) : undefined);
    const row = { organization_id: connector.organization_id, connector_id: connector.id, tally_company_guid: company.guid, tally_company_name: company.name, tally_books_from: company.booksFrom, is_available: true, is_active: company.isActive, last_seen_at: now };
    if (match) { used.add(match.id); updates.push({ id: match.id, ...row }); } else inserts.push(row);
  }
  if (updates.length) {
    const { error: updateError } = await supabase.from("tally_connector_company_observations").upsert(updates, { onConflict: "id" });
    if (updateError) throw updateError;
  }
  for (const row of inserts) {
    const { error: insertError } = await supabase.from("tally_connector_company_observations").insert(row);
    // 23505: the old one-company-per-GUID rule is still in force, so a second year cannot be stored yet.
    if (insertError && insertError.code !== "23505") throw insertError;
    if (insertError) console.warn("Could not store a second financial-year company yet (old unique rule still applies):", row.tally_company_name);
  }
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
    if(body.runtime && typeof body.runtime==="object"){
      const value=body.runtime as Record<string,unknown>;
      if(value.protocol===1 && (value.mode==="server"||value.mode==="pc")){
        const runtime={protocol:1,mode:value.mode,version:bridgeVersion,pid:Number(value.pid)||null,
          bootId:typeof value.bootId==="string"?value.bootId.slice(0,80):null,
          lastTallyReadAt:typeof value.lastTallyReadAt==="string"?value.lastTallyReadAt:null,
          startedAt:typeof value.startedAt==="string"?value.startedAt:null,
          activity:typeof value.activity==="string"?value.activity.slice(0,160):null,
          windowsUser:typeof value.windowsUser==="string"?value.windowsUser.slice(0,100):null,
          osRelease:typeof value.osRelease==="string"?value.osRelease.slice(0,100):null,
          freeMemoryMb:Number(value.freeMemoryMb)||null,
          capabilities:Array.isArray(value.capabilities)?value.capabilities.filter(v=>typeof v==="string").slice(0,30):[],
          startup:value.startup&&typeof value.startup==="object"?value.startup:null,reportedAt:now};
        const stored=await supabase.from("tally_connectors").update({runtime}).eq("id",connector.id);
        if(stored.error && !["42703","PGRST204"].includes(stored.error.code))throw stored.error;
      }
    }

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
      if (availableCompanies.length > 0) await recordObservations(supabase, connector, availableCompanies, now);
    } else if (runtimeSchemaAvailable && activeCompany.name && activeCompany.guid) {
      // The bridge probes the active company on every heartbeat, whereas the
      // full company list is intentionally cached. Keep this lightweight live
      // pointer current so the web workspace can follow a Tally Prime switch
      // without waiting for the next full company-list refresh.
      const { data: activeRows, error: activeRowsError } = await supabase
        .from("tally_connector_company_observations")
        .select("id, tally_company_guid, tally_books_from")
        .eq("connector_id", connector.id)
        .eq("is_active", true);
      if (activeRowsError) throw activeRowsError;
      const active = { guid: activeCompany.guid, name: activeCompany.name, booksFrom: activeCompany.booksFrom };
      const stale = ((activeRows ?? []) as Array<{ id: string; tally_company_guid: string; tally_books_from: string | null }>)
        .filter((row) => !sameCompanyIdentity(active, { guid: row.tally_company_guid, booksFrom: row.tally_books_from, name: activeCompany.name }))
        .map((row) => row.id);
      if (stale.length) {
        const deactivatePrevious = await supabase.from("tally_connector_company_observations").update({ is_active: false }).in("id", stale);
        if (deactivatePrevious.error) throw deactivatePrevious.error;
      }
      await recordObservations(supabase, connector, [{ name: activeCompany.name, guid: activeCompany.guid, booksFrom: activeCompany.booksFrom, isActive: true }], now);
    }
    const { data: bindings, error: bindingError } = await supabase.from("tally_connector_company_bindings").select("id, company_id, expected_tally_company_guid, expected_tally_company_name, expected_tally_books_from").eq("connector_id", connector.id).eq("is_active", true);
    if (bindingError) throw bindingError;
    // A server has several companies open at once, so a binding is satisfied by ANY open company.
    // A PC works on the one company that is active in Tally Prime.
    const runtimeMode = body.runtime && typeof body.runtime === "object" ? (body.runtime as Record<string, unknown>).mode : null;
    const serverMode = runtimeMode === "server";
    const openCompanies: Array<{ guid: string | null; name: string | null; booksFrom: string | null }> = serverMode ? availableCompanies : [activeCompany];
    const bindingStates = (await Promise.all(((bindings ?? []) as unknown as BindingRow[]).map(async (binding) => {
      const expected = { guid: binding.expected_tally_company_guid, name: binding.expected_tally_company_name, booksFrom: binding.expected_tally_books_from };
      const seenCompany = openCompanies.find((company) => sameCompanyIdentity(expected, company));
      const matches = Boolean(seenCompany);
      // A short progress heartbeat only names the company being worked on; it says nothing about the others.
      if (serverMode && !companySnapshotFresh && !matches) return null;
      const shown = seenCompany ?? activeCompany;
      const stamp = matches ? { last_validated_at: now } : { last_mismatch_at: now };
      const observed = { observed_tally_company_guid: shown.guid, observed_tally_company_name: shown.name };
      let { error } = await supabase.from("tally_connector_company_bindings").update({ ...observed, observed_tally_books_from: shown.booksFrom, ...stamp }).eq("id", binding.id).eq("connector_id", connector.id);
      // The column arrives with a later migration; the heartbeat must not fail while it is missing.
      if (error && ["42703", "PGRST204"].includes(error.code ?? "")) {
        ({ error } = await supabase.from("tally_connector_company_bindings").update({ ...observed, ...stamp }).eq("id", binding.id).eq("connector_id", connector.id));
      }
      if (error) throw error;
      return {
        companyId: binding.company_id,
        matches,
        expectedCompany: { guid: binding.expected_tally_company_guid, name: binding.expected_tally_company_name, booksFrom: binding.expected_tally_books_from },
      };
    }))).filter((state): state is NonNullable<typeof state> => state !== null);
    // Tally's master change counter: queue a master sync when Tally changed.
    // Never let this fail the heartbeat itself.
    // A server reports one counter per open company (masterChangeCounters), so a change in any
    // year's company is noticed; a PC reports the single counter of its active company.
    const perCompany = Array.isArray(body.masterChangeCounters) ? (body.masterChangeCounters as Array<Record<string, unknown>>) : [];
    if (companyLoaded && serverMode && perCompany.length) {
      for (const binding of bindingStates.filter((item) => item.matches)) {
        const reported = perCompany.find((entry) => sameCompanyIdentity(binding.expectedCompany, { guid: String(entry.guid ?? ""), name: String(entry.name ?? ""), booksFrom: (entry.booksFrom as string | null) ?? null }));
        const counter = Number(reported?.counter);
        if (!Number.isFinite(counter) || counter <= 0) continue;
        await noteMasterCounter(supabase, { organizationId: connector.organization_id, companyId: binding.companyId, counter })
          .catch((error) => console.error("Automatic master sync check failed:", error));
      }
    } else {
      const masterCounter = Number(body.masterChangeCounter);
      if (companyLoaded && Number.isFinite(masterCounter) && masterCounter > 0) {
        for (const binding of bindingStates.filter((item) => item.matches)) {
          await noteMasterCounter(supabase, { organizationId: connector.organization_id, companyId: binding.companyId, counter: masterCounter })
            .catch((error) => console.error("Automatic master sync check failed:", error));
        }
      }
    }
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
