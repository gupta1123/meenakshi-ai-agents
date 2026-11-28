import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { bridgeVersionIsOlder } from "@/lib/bridge";

export const CD_CREDIT_NOTE_MATCHING_VERSION = 2;
export const CD_CONNECTOR_MINIMUM = "0.7.4";
export const CD_RECHECK_MESSAGE = "The saved Cash Discount result needs verification of advances and existing Credit Notes. Open Cash Discount to start verification.";
export function currentCdEvidence(matchingVersion: unknown, readerVersion: unknown) {
  return Number(matchingVersion) === CD_CREDIT_NOTE_MATCHING_VERSION && typeof readerVersion === "string"
    && /^\d+\.\d+\.\d+$/.test(readerVersion) && !bridgeVersionIsOlder(readerVersion, CD_CONNECTOR_MINIMUM);
}
export class CdEvidenceSafetyError extends Error { readonly status = 409; }
type Database = ReturnType<typeof createSupabaseAdminClient>;

export function keepCdSettlementRow(row: Record<string, unknown>) {
  return row.category !== "not_eligible" || row.status === "credited" || (Array.isArray(row.creditNoteReferences) && row.creditNoteReferences.length > 0);
}

export async function requireCurrentCdConnector(db: Database, companyId: string, minimum = CD_CONNECTOR_MINIMUM) {
  const { data: binding, error } = await db.from("tally_connector_company_bindings").select("connector_id").eq("company_id", companyId).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!binding) throw new CdEvidenceSafetyError("Connect the intended Tally company before checking Cash Discount.");
  const result = await db.from("tally_connectors").select("bridge_version").eq("id", binding.connector_id).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data?.bridge_version || bridgeVersionIsOlder(result.data.bridge_version, minimum)) throw new CdEvidenceSafetyError(`Cash Discount requires connector ${minimum} or newer on the Tally computer.`);
}

/** Old saved candidates must not remain postable after the reader is fixed. */
export async function requireCurrentCdCheck(db: Database, companyId: string) {
  const { data, error } = await db.from("evaluation_runs").select("id, matchingVersion:summary->creditNoteMatchingVersion, readerVersion:summary->>connectorVersion")
    .eq("company_id", companyId).eq("status", "completed").eq("summary->>cdDiscountBasis", "amount_per_tonne")
    .order("completed_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!currentCdEvidence(data?.matchingVersion, data?.readerVersion)) throw new CdEvidenceSafetyError(CD_RECHECK_MESSAGE);
  await requireCurrentCdConnector(db, companyId, "0.7.5");
}
