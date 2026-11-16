/**
 * Server mode: save a finished check's result as an evaluation run straight
 * away, so the check completes even if every browser was closed. The page
 * waits for `progress.save` and only saves the result itself if this failed.
 */
import { saveLocalCdResult, saveLocalTodResult } from "@/lib/evaluation/save-local-results";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type CheckJobSaveState =
  | { state: "saving" }
  | { state: "saved"; evaluationRunId: string; totals?: unknown }
  | { state: "failed"; message: string };

type JobRow = {
  id: string; kind: string; organization_id: string; company_id: string; requested_by: string | null;
  request: { save?: { asOfDate?: string | null } | null; body?: Record<string, unknown> } | null;
  progress: Record<string, unknown> | null; result: Record<string, unknown> | null;
};

/** Does this job ask the server to save its result? (Set by the page when it queues the check.) */
export function wantsServerSave(job: Pick<JobRow, "kind" | "request">): boolean {
  return (job.kind === "cd" || job.kind === "tod") && Boolean(job.request?.save && typeof job.request.save === "object");
}

export async function saveCheckJobResult(jobId: string) {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("tally_check_jobs")
    .select("id, kind, organization_id, company_id, requested_by, request, progress, result").eq("id", jobId).maybeSingle();
  if (error) throw error;
  const job = data as JobRow | null;
  if (!job || !wantsServerSave(job) || !job.result) return;
  const setSave = async (save: CheckJobSaveState, evaluationRunId: string | null = null) => {
    const patch: Record<string, unknown> = { progress: { ...(job.progress ?? {}), save }, updated_at: new Date().toISOString() };
    if (evaluationRunId) patch.evaluation_run_id = evaluationRunId;
    const { error: updateError } = await db.from("tally_check_jobs").update(patch).eq("id", job.id);
    if (updateError) console.error("Could not record the check's save state:", updateError);
  };
  if (!job.requested_by) { await setSave({ state: "failed", message: "The person who started this check no longer has an account." }); return; }
  await setSave({ state: "saving" });
  try {
    const { data: memberships, error: membershipError } = await db.from("organization_memberships").select("role")
      .eq("organization_id", job.organization_id).eq("profile_id", job.requested_by);
    if (membershipError) throw membershipError;
    const roles = (memberships ?? []).map((row) => String(row.role));
    if (!roles.some((role) => role === "administrator" || role === "finance_approver")) throw new Error("The person who started this check can no longer save results.");
    const scope = { userId: job.requested_by, roles, organization: { id: job.organization_id }, company: { id: job.company_id } };
    const key = `check-job:${job.id}`;
    const evaluatedOn = job.request?.body?.evaluatedOn;
    if (job.kind === "cd") {
      const saved = await saveLocalCdResult(scope, { evaluatedOn, evidence: job.result.evidence }, key);
      await setSave({ state: "saved", evaluationRunId: saved.evaluationRun.id, totals: saved.totals }, saved.evaluationRun.id);
    } else {
      const evidence = job.result.evidence as Record<string, unknown> & { customerAggregates?: Array<Record<string, unknown>> } | undefined;
      const body = job.request?.body ?? {};
      // Each aggregate carries its own period, as the page does when it merges batches.
      const withPeriods = evidence ? { ...evidence, customerAggregates: (evidence.customerAggregates ?? []).map((aggregate) => ({ periodStart: body.periodStart, periodEnd: body.periodEnd, ...aggregate })) } : evidence;
      const saved = await saveLocalTodResult(scope, { asOfDate: job.request?.save?.asOfDate, evaluatedOn, evidence: withPeriods }, key);
      await setSave({ state: "saved", evaluationRunId: saved.evaluationRun.id }, saved.evaluationRun.id);
    }
  } catch (cause) {
    console.error(`Could not save check job ${job.id}:`, cause);
    await setSave({ state: "failed", message: cause instanceof Error ? cause.message : "Could not save the result." });
  }
}
