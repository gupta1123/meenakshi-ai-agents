import { saveLocalCdResult, saveLocalTodResult } from "@/lib/evaluation/save-local-results";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type SaveJob = {
  id: string; kind: string; organization_id: string; company_id: string; requested_by: string | null;
  request: { save?: { asOfDate?: string }; body?: Record<string, unknown> };
  result: Record<string, unknown>; save_attempts: number;
  progress?: Record<string, unknown> & { save?: { periodRuns?: PeriodRun[] } };
};
type PeriodRun = { period: string; evaluationRunId: string };
type SaveState = { state: "saved" | "failed"; evaluationRunId?: string; evaluationRunIds?: string[]; periodRuns?: PeriodRun[]; totals?: unknown; message?: string };
type SaveDeps = {
  roles: (job: SaveJob) => Promise<string[]>;
  saveCd: typeof saveLocalCdResult; saveTod: typeof saveLocalTodResult;
  finish: (state: SaveState) => Promise<void>;
  defer?: (periodRuns: PeriodRun[]) => Promise<void>;
  periodFinished?: (runId: string) => Promise<boolean>;
  canSaveTod?: (key: string) => Promise<boolean>;
};

/** One leased save; retries always use the original job's permanent key. */
export async function saveClaimedCheckJob(job: SaveJob, deps: SaveDeps) {
  const savedPeriods = [...(job.progress?.save?.periodRuns ?? [])];
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
      const groups = new Map<string, Array<Record<string, unknown>>>();
      for (const a of evidence.customerAggregates ?? []) {
        const start = a.periodStart ?? body.periodStart ?? evidence.periodStart;
        const end = a.periodEnd ?? body.periodEnd ?? evidence.periodEnd;
        if (typeof start !== "string" || typeof end !== "string") throw new Error("A saved TOD customer must have a calculation period.");
        const period = `${start}:${end}`;
        groups.set(period, [...(groups.get(period) ?? []), { ...a, periodStart: start, periodEnd: end }]);
      }
      if (!groups.size) throw new Error("No TOD customer results were returned.");
      // Customer child keys in the existing database are unique within one
      // period's calculation. Yield between periods so its customer jobs can
      // finish before the parallel-run guard allows the next calculation.
      if (savedPeriods.length && deps.periodFinished && !await deps.periodFinished(savedPeriods.at(-1)!.evaluationRunId)) {
        await deps.defer!(savedPeriods); return;
      }
      const next = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).find(([period]) => !savedPeriods.some((run) => run.period === period));
      if (!next) {
        const ids = savedPeriods.map((run) => run.evaluationRunId);
        await deps.finish({ state: "saved", evaluationRunId: ids.at(-1), evaluationRunIds: ids, periodRuns: savedPeriods }); return;
      }
      const [period, aggregates] = next;
      // Preserve the original permanent key for single-period jobs, including
      // saves already underway when this release is deployed.
      const periodKey = groups.size === 1 ? key : `${key}:${period}`;
      if (deps.canSaveTod && !await deps.canSaveTod(periodKey)) { await deps.defer!(savedPeriods); return; }
      const [periodStart, periodEnd] = period.split(":");
      const requestedAsOf = job.request.save?.asOfDate;
      const saved = await deps.saveTod(scope, {
        asOfDate: requestedAsOf && requestedAsOf < periodEnd ? requestedAsOf : periodEnd,
        evaluatedOn: body.evaluatedOn,
        evidence: { ...evidence, periodStart, periodEnd, customerAggregates: aggregates },
      }, periodKey);
      if (groups.size === 1) {
        await deps.finish({ state: "saved", evaluationRunId: saved.evaluationRun.id });
      } else {
        if (!deps.defer || !deps.periodFinished) throw new Error("Durable multi-period saving is unavailable.");
        savedPeriods.push({ period, evaluationRunId: saved.evaluationRun.id });
        await deps.defer(savedPeriods);
      }
    } else throw new Error("Unsupported saved check kind.");
  } catch (cause) {
    await deps.finish({ state: "failed", message: cause instanceof Error ? cause.message : "Could not save the result.", ...(savedPeriods.length ? { periodRuns: savedPeriods } : {}) });
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
      canSaveTod: async (key) => {
        const { data, error } = await db.from("evaluation_runs").select("id")
          .eq("company_id", job.company_id).eq("request_context->>schemeType", "tod")
          .in("status", ["queued", "refreshing_tally", "evaluating"]).neq("idempotency_key", key).limit(1);
        if (error) throw error;
        return !data?.length;
      },
      periodFinished: async (id) => {
        const { data, error } = await db.from("evaluation_runs").select("status")
          .eq("company_id", job.company_id).or(`id.eq.${id},idempotency_key.like.${id}:%`)
          .neq("status", "completed").limit(1);
        if (error) throw error;
        const unfinished = data?.[0]?.status;
        if (unfinished && ["failed", "completed_with_issues", "cancelled"].includes(unfinished)) throw new Error("A period's customer results need attention. Review Calculation history.");
        return !unfinished;
      },
      defer: async (periodRuns) => {
        if (!valid) throw new Error("Save ownership expired.");
        const now = new Date();
        const { data, error } = await db.from("tally_check_jobs").update({
          save_state: "pending", save_attempts: Math.max(0, job.save_attempts - 1),
          progress: { ...job.progress, save: { state: "pending", periodRuns } },
          save_available_at: new Date(now.getTime() + 1_000).toISOString(),
          save_locked_by: null, save_lease_expires_at: null, updated_at: now.toISOString(),
        }).eq("id", job.id).eq("save_state", "saving").eq("save_locked_by", workerId)
          .eq("save_attempts", job.save_attempts).gt("save_lease_expires_at", now.toISOString()).select("id").maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("Save ownership expired.");
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
