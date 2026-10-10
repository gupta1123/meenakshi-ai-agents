import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const RESULT_RESET_ACTION = "discount_results_archived";

/** An append-only marker, never a deletion of results, rules or accounting records. */
export async function resultResetCutoff(companyId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient().from("audit_events")
    .select("created_at, metadata").eq("company_id", companyId)
    .eq("entity_type", "company").eq("entity_id", companyId).eq("action", RESULT_RESET_ACTION)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.metadata?.version !== 1 || data.metadata?.schemes?.join(",") !== "cd,tod"
    || !Number.isFinite(Date.parse(data.created_at))) throw new Error("Invalid calculation reset marker.");
  return data.created_at;
}

export function visibleResults<T extends { gt(column: string, value: string): T }>(query: T, cutoff: string | null, column: string) {
  return cutoff ? query.gt(column, cutoff) : query;
}

export function resultIsVisible(timestamp: string | null | undefined, cutoff: string | null) {
  if (!cutoff) return true;
  return Boolean(timestamp && Date.parse(timestamp) > Date.parse(cutoff));
}

/** Old browser tabs may still contain Create buttons: reject their archived candidates. */
export async function requireVisibleCdCandidate(companyId: string, candidateId: string) {
  const cutoff = await resultResetCutoff(companyId);
  if (!cutoff) return;
  const { data, error } = await createSupabaseAdminClient().from("cash_discount_recovery_candidates")
    .select("created_at").eq("company_id", companyId).eq("id", candidateId).maybeSingle();
  if (error) throw error;
  if (!data || !resultIsVisible(data.created_at, cutoff)) throw new Error("This result was archived. Calculate Cash Discount again before creating a note.");
}
