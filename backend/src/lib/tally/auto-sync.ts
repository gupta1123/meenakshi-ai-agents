import { createSupabaseAdminClient } from "@/lib/supabase/admin";

// Automatic master sync (migration 20260927190000_tally_change_counters.sql).
// The connector reports Tally's master change counter (AltMstId); when it is
// ahead of the counter recorded at the last successful master sync, a master
// sync is queued. At most one sync at a time and one request every 5 minutes.
const AUTO_REQUEST_GAP_MS = 5 * 60 * 1000;
const RUN_STALE_MS = 30 * 60 * 1000;

type Supabase = ReturnType<typeof createSupabaseAdminClient>;

function missingTable(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.code === "PGRST205" || /tally_change_counters/.test(error.message ?? "")));
}

/** Records the counter seen in Tally, and queues a master sync when Tally has changed. */
export async function noteMasterCounter(supabase: Supabase, input: { organizationId: string; companyId: string; counter: number }) {
  const now = new Date();
  const { data: row, error } = await supabase.from("tally_change_counters").select("synced_master_counter, last_auto_request_at").eq("company_id", input.companyId).maybeSingle();
  if (missingTable(error)) return { requested: false };
  if (error) throw error;
  const { error: upsertError } = await supabase.from("tally_change_counters").upsert({
    company_id: input.companyId, observed_master_counter: input.counter, observed_at: now.toISOString(), updated_at: now.toISOString(),
  }, { onConflict: "company_id" });
  if (upsertError) throw upsertError;

  const synced = row?.synced_master_counter == null ? null : Number(row.synced_master_counter);
  if (synced !== null && input.counter <= synced) return { requested: false };
  if (row?.last_auto_request_at && now.getTime() - new Date(row.last_auto_request_at).getTime() < AUTO_REQUEST_GAP_MS) return { requested: false };
  // One master sync at a time (ignore runs stuck for over 30 minutes).
  const { data: active, error: activeError } = await supabase.from("tally_sync_runs").select("id, created_at")
    .eq("company_id", input.companyId).eq("sync_kind", "masters").in("status", ["queued", "running"])
    .gte("created_at", new Date(now.getTime() - RUN_STALE_MS).toISOString()).limit(1);
  if (activeError) throw activeError;
  if (active?.length) return { requested: false };

  const { error: requestError } = await supabase.rpc("request_meenakshi_tally_sync", {
    p_organization_id: input.organizationId,
    p_company_id: input.companyId,
    p_sync_kind: "masters",
    p_requested_scope: { fullMasterRead: true, automatic: true, masterChangeCounter: input.counter },
    p_idempotency_key: `auto-masters:${input.companyId}:${input.counter}`,
  });
  if (requestError) throw requestError;
  await supabase.from("tally_change_counters").update({ last_auto_request_at: now.toISOString() }).eq("company_id", input.companyId);
  return { requested: true };
}

/** After a successful master sync: the counter that sync read is now in the app. */
export async function noteMasterSynced(supabase: Supabase, companyId: string, counter: unknown) {
  const value = Number(counter);
  if (!Number.isFinite(value) || value <= 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase.from("tally_change_counters").upsert({ company_id: companyId, synced_master_counter: value, synced_at: now, updated_at: now }, { onConflict: "company_id" });
  if (error && !missingTable(error)) throw error;
}

/** Plain sync status for the workspace badge. */
export async function masterSyncStatus(supabase: Supabase, companyId: string) {
  const [counters, lastRun, activeRun] = await Promise.all([
    supabase.from("tally_change_counters").select("observed_master_counter, observed_at, synced_master_counter, synced_at").eq("company_id", companyId).maybeSingle(),
    supabase.from("tally_sync_runs").select("completed_at").eq("company_id", companyId).eq("sync_kind", "masters").eq("status", "completed")
      .order("completed_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    supabase.from("tally_sync_runs").select("id").eq("company_id", companyId).eq("sync_kind", "masters").in("status", ["queued", "running"])
      .gte("created_at", new Date(Date.now() - RUN_STALE_MS).toISOString()).limit(1),
  ]);
  if (lastRun.error) throw lastRun.error;
  if (activeRun.error) throw activeRun.error;
  const row = missingTable(counters.error) ? null : counters.data;
  const observed = row?.observed_master_counter == null ? null : Number(row.observed_master_counter);
  const synced = row?.synced_master_counter == null ? null : Number(row.synced_master_counter);
  const syncing = Boolean(activeRun.data?.length);
  const changesPending = observed !== null && (synced === null || observed > synced);
  return {
    lastSyncedAt: lastRun.data?.completed_at ?? null,
    state: syncing ? "syncing" : changesPending ? "changes_pending" : lastRun.data?.completed_at ? "up_to_date" : "never_synced",
    tallyCheckedAt: row?.observed_at ?? null,
  };
}
