import { saveLocalCdResult, saveLocalTodResult } from "@/lib/evaluation/save-local-results";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type SaveJob = {
  id: string; kind: string; organization_id: string; company_id: string; requested_by: string | null;
  request: { save?: { asOfDate?: string }; body?: Record<string, unknown> };
  result: Record<string, unknown>; save_attempts: number;
};
type SaveState = { state: "saved" | "failed"; evaluationRunId?: string; totals?: unknown; message?: string };
type SaveDeps = {
  roles: (job: SaveJob) => Promise<string[]>;
  saveCd: typeof saveLocalCdResult; saveTod: typeof saveLocalTodResult;
  finish: (state: SaveState) => Promise<void>;
};

/** One leased save; retries always use the original job's permanent key. */
export async function saveClaimedCheckJob(job: SaveJob, deps: SaveDeps) {
  try {
    if (!job.requested_by) throw new Error("The person who started this check no longer has an account.");
    const roles = await deps.roles(job);
    if (!roles.some((role) => role === "administrator" || role === "finance_approver")) throw new Error("The person who started this check can no longer save results.");
    const scope = { userId: job.requested_by, roles, organization: { id: job.organization_id }, company: { id: job.company_id } };
    const key = `check-job:${job.id}`;
    const body = job.request.body ?? {};
    if (job.kind === "cd") {
      const saved = await deps.saveCd(scope, { evaluatedOn: body.evaluatedOn, evidence: job.result.evidence }, key);
      await deps.finish({ state: "saved", evaluationRunId: saved.evaluationRun.id, totals: saved.totals });
    } else if (job.kind === "tod") {
      const evidence = job.result.evidence as Record<string, unknown> & { customerAggregates?: Array<Record<string, unknown>> };
      const withPeriods = { ...evidence, customerAggregates: (evidence.customerAggregates ?? []).map((a) => ({ periodStart: body.periodStart, periodEnd: body.periodEnd, ...a })) };
      const saved = await deps.saveTod(scope, { asOfDate: job.request.save?.asOfDate, evaluatedOn: body.evaluatedOn, evidence: withPeriods }, key);
      await deps.finish({ state: "saved", evaluationRunId: saved.evaluationRun.id });
    } else throw new Error("Unsupported saved check kind.");
  } catch (cause) {
    await deps.finish({ state: "failed", message: cause instanceof Error ? cause.message : "Could not save the result." });
  }
}

/** Called by the existing evaluation worker, including after every restart. */
export async function processPendingCheckSaves(workerId: string) {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.rpc("claim_tally_check_save_v2", { p_worker_id: workerId });
  if (error) throw error;
  const job = (data as SaveJob[] | null)?.[0];
  if (!job) return false;
  let valid = true;
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const renewed = await db.rpc("renew_tally_check_save_v2", { p_job_id: job.id, p_worker_id: workerId, p_attempt: job.save_attempts });
      if (!renewed.error && renewed.data === false) valid = false;
    } catch (error) { console.warn("Could not renew check save:", error); }
    finally { renewing = false; }
  }, 20_000);
  timer.unref?.();
  try {
    await saveClaimedCheckJob(job, {
      saveCd: saveLocalCdResult, saveTod: saveLocalTodResult,
      roles: async () => {
        const { data: memberships, error: roleError } = await db.from("organization_memberships").select("role").eq("organization_id", job.organization_id).eq("profile_id", job.requested_by!);
        if (roleError) throw roleError;
        return (memberships ?? []).map((row) => String(row.role));
      },
      finish: async (save) => {
        if (!valid) throw new Error("Save ownership expired; another worker will recover it.");
        const answer = await db.rpc("finish_tally_check_save_v2", { p_job_id: job.id, p_worker_id: workerId, p_attempt: job.save_attempts, p_save: save, p_evaluation_run_id: save.evaluationRunId ?? null });
        if (answer.error) throw answer.error;
        if (!answer.data) throw new Error("Save ownership expired.");
      },
    });
  } finally { clearInterval(timer); }
  return true;
}
