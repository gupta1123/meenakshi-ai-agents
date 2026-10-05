import { noteMasterSynced } from "@/lib/tally/auto-sync";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type MasterResult = {
  syncRunId?: unknown;
  activeCompany?: { guid?: unknown; name?: unknown };
  complete?: unknown;
  masters?: unknown;
};

function normalizeSourcePayload(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeMasterResult(result: MasterResult) {
  const masters = result.masters as Record<string, unknown>;
  const records = (key: string) => Array.isArray(masters[key]) ? masters[key] as Record<string, unknown>[] : [];
  const identity = (record: Record<string, unknown>) => ({
    guid: record.guid,
    master_id: record.masterId,
    alter_id: record.alterId,
    name: record.name,
    source_payload: normalizeSourcePayload(record.sourcePayload),
  });

  return {
    syncRunId: result.syncRunId,
    activeCompany: result.activeCompany,
    complete: result.complete,
    masters: {
      customerGroups: records("customerGroups").map((record) => ({ ...identity(record), parent_guid: record.parentGuid })),
      units: records("units").map((record) => ({ ...identity(record), code: record.code })),
      stockGroups: records("stockGroups").map((record) => ({ ...identity(record), parent_guid: record.parentGuid })),
      stockItems: records("stockItems").map((record) => ({ ...identity(record), stock_group_guid: record.stockGroupGuid, uom_code: record.uomCode })),
      ledgers: records("ledgers").map((record) => ({ ...identity(record), parent_group_name: record.parentGroupName, gst_applicability: record.gstApplicability })),
      voucherTypes: records("voucherTypes").map((record) => ({ ...identity(record), is_credit_note_type: record.isCreditNoteType })),
      customers: records("customers").map((record) => ({
        guid: record.guid,
        master_id: record.masterId,
        alter_id: record.alterId,
        ledger_name: record.ledgerName,
        customer_group_guid: record.customerGroupGuid,
        tax_identifier: record.taxIdentifier,
        source_payload: normalizeSourcePayload(record.sourcePayload),
      })),
    },
  };
}

export async function applyMasterSyncResult(input: { syncRunId: string; companyId: string; result: unknown }) {
  if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) {
    throw new Error("A master sync result object is required.");
  }
  const result = input.result as MasterResult;
  if (result.syncRunId !== input.syncRunId || result.complete !== true || !result.masters || !result.activeCompany) {
    throw new Error("The master sync result is incomplete or belongs to a different sync run.");
  }
  if (!isUuid(input.syncRunId) || !isUuid(input.companyId)) throw new Error("Invalid master sync identifiers.");

  const normalizedResult = normalizeMasterResult(result);
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("apply_meenakshi_master_sync_result", {
    p_sync_run_id: input.syncRunId,
    p_company_id: input.companyId,
    p_result: normalizedResult,
  });
  if (error) throw error;
  // Tally can provide hierarchy relationships by display name when the GUID
  // is not included in a collection export. Resolve those links after the
  // immutable master snapshots have been safely stored.
  const { error: relationshipError } = await supabase.rpc("reconcile_meenakshi_master_relationships", {
    p_company_id: input.companyId,
  });
  if (relationshipError) throw relationshipError;
  // The Tally change counter this sync read is now in the app (automatic sync).
  await noteMasterSynced(supabase, input.companyId, (result as { changeCounter?: unknown }).changeCounter);
  return data as { syncRunId: string; recordsReceived: number; recordsApplied: number; fingerprint: string; alreadyApplied: boolean };
}

export async function markMasterSyncFailed(input: { syncRunId: string; companyId: string; failureReason: string }) {
  if (!isUuid(input.syncRunId) || !isUuid(input.companyId)) return;
  const { error } = await createSupabaseAdminClient()
    .from("tally_sync_runs")
    .update({ status: "failed", error_summary: input.failureReason.slice(0, 2_000), completed_at: new Date().toISOString() })
    .eq("id", input.syncRunId)
    .eq("company_id", input.companyId)
    .in("status", ["queued", "running"]);
  if (error) throw error;
}
