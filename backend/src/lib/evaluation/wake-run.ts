import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function wakeEvaluationRunAfterTallyResult(input: { companyId: string; evaluationRunId: string }) {
  const now = new Date();
  const expiredLease = new Date(now.getTime() - 1_000).toISOString();
  const { data, error } = await createSupabaseAdminClient()
    .from("evaluation_runs")
    .update({ lease_expires_at: expiredLease, updated_at: now.toISOString() })
    .eq("id", input.evaluationRunId)
    .eq("company_id", input.companyId)
    .in("status", ["refreshing_tally", "evaluating"])
    .not("locked_by", "is", null)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
