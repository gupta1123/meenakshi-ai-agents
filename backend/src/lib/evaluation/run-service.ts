import { evaluateCd, evaluateTod } from "./evaluate";
import type { EvaluationResult } from "./contracts";
import { deriveRefreshScope, loadFreshEvaluation, loadLiveTodContext, type EvaluationRunRecord } from "./evidence";
import { evaluateLiveTodAggregate, isLiveTodAggregate } from "./live-tod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { stopEvaluationRun } from "./cancel-run";
import { hasCompletedLocalTodEvidence, requiresTallyRefresh } from "./refresh-policy";

export type EvaluationWorkerRun = EvaluationRunRecord & {
  status: string;
  locked_by: string | null;
  attempts: number;
  max_attempts: number;
  started_at: string | null;
  created_at: string;
};

export type EvaluationProcessState = "refresh_requested" | "waiting_for_tally" | "persisted";

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [value.message, value.details, value.hint, value.code]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    if (parts.length > 0) return parts.join(" | ");
  }
  return String(error ?? "Evaluation worker failed.");
}

function noProposalResult(run: EvaluationWorkerRun, issueType: "no_active_rule" | "missing_rule_configuration" | "other", message: string): EvaluationResult {
  const schemeType = run.request_context.schemeType === "tod" ? "tod" : "cd";
  return {
    proposal: null,
    evaluation: { ruleSnapshot: {}, customerGroupSnapshot: {}, calendarSnapshot: null, formulaSnapshot: {}, groupMemberships: [], workingDayBreakdown: [], sourceVouchers: [], sourceInventoryLines: [], paymentAllocations: [], priorPeriodAdjustments: [] },
    issues: [{
      issueKey: `evaluation:${run.company_id}:${run.id}:${issueType}`,
      issueType,
      ...(typeof run.request_context.customerId === "string" ? { customerId: run.request_context.customerId } : {}),
      details: { schemeType, message },
    }],
    hasBlockingIssues: true,
    summary: { schemeType, outcome: "needs_review", message },
  };
}

async function refreshIsComplete(run: EvaluationWorkerRun) {
  if (isLiveTodAggregate(run.summary?.liveTodEvidence)) return { complete: true, failed: null as string | null };
  const { data, error } = await createSupabaseAdminClient()
    .from("tally_sync_runs")
    .select("id, status, error_summary")
    .eq("company_id", run.company_id)
    .contains("requested_scope", { evaluationRunId: run.id });
  if (error) throw error;
  const syncs = data ?? [];
  if (syncs.length < 2) return { complete: false, failed: null as string | null };
  const failed = syncs.find((sync) => sync.status === "failed" || sync.status === "completed_with_errors");
  if (failed) return { complete: false, failed: failed.error_summary || "The targeted Tally refresh failed." };
  return { complete: syncs.every((sync) => sync.status === "completed"), failed: null as string | null };
}

async function lockTodPeriod(run: EvaluationWorkerRun, loaded: Awaited<ReturnType<typeof loadFreshEvaluation>>) {
  if (loaded.kind !== "tod") return;
  const { data, error } = await createSupabaseAdminClient().rpc("lock_meenakshi_tod_customer_period", {
    p_company_id: run.company_id,
    p_customer_id: loaded.customer.id,
    p_scheme_id: loaded.rule.schemeId,
    p_scheme_version_id: loaded.rule.id,
    p_period_start: loaded.periodStart,
    p_period_end: loaded.periodEnd,
    p_evaluation_run_id: run.id,
  });
  if (error) throw error;
  if (!data || data.scheme_version_id !== loaded.rule.id) {
    throw new Error("A different immutable TOD rule version already owns this customer period. Retry the evaluation to load that locked rule.");
  }
}

async function lockLiveTodPeriod(run: EvaluationWorkerRun, context: Awaited<ReturnType<typeof loadLiveTodContext>>) {
  const { data, error } = await createSupabaseAdminClient().rpc("lock_meenakshi_tod_customer_period", {
    p_company_id: run.company_id,
    p_customer_id: context.customer.id,
    p_scheme_id: context.rule.schemeId,
    p_scheme_version_id: context.rule.id,
    p_period_start: context.periodStart,
    p_period_end: context.periodEnd,
    p_evaluation_run_id: run.id,
  });
  if (error) throw error;
  if (!data || data.scheme_version_id !== context.rule.id) {
    throw new Error("A different immutable TOD rule version already owns this customer period. Retry the evaluation to load that locked rule.");
  }
}

async function persist(run: EvaluationWorkerRun, result: EvaluationResult) {
  const { error } = await createSupabaseAdminClient().rpc("persist_meenakshi_evaluation_result", {
    p_evaluation_run_id: run.id,
    p_worker_id: run.locked_by,
    p_actor_id: run.requested_by,
    p_result: result,
  });
  if (error) throw error;
}

export async function processEvaluationRun(run: EvaluationWorkerRun): Promise<EvaluationProcessState> {
  if (!run.locked_by) throw new Error("Claimed evaluation run did not include a worker lease.");
  const startedAt = Date.parse(run.started_at ?? run.created_at);
  if (Number.isFinite(startedAt) && Date.now() - startedAt > 10 * 60_000) {
    await stopEvaluationRun({
      companyId: run.company_id,
      runId: run.id,
      status: "failed",
      message: "The Tally read exceeded 10 minutes and was stopped. Reopen the connector and try again.",
    });
    return "persisted";
  }

  // Local-first TOD has already completed the only Tally read and calculation.
  // Consume that immutable result before looking for refresh-run ids; fan-out
  // children intentionally have no refresh ids and must never enqueue another
  // connector command for the same evidence.
  const liveTodEvidence = run.summary?.liveTodEvidence;
  if (hasCompletedLocalTodEvidence(run) && isLiveTodAggregate(liveTodEvidence)) {
    const evaluated = await evaluateLiveTodAggregate(run, liveTodEvidence);
    await lockLiveTodPeriod(run, evaluated.context);
    await persist(run, evaluated.result);
    return "persisted";
  }

  if (requiresTallyRefresh(run)) {
    let scope;
    try {
      scope = await deriveRefreshScope(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The evaluation request cannot be prepared.";
      const issueType = /No active|unavailable|incomplete/i.test(message) ? "no_active_rule" : "missing_rule_configuration";
      await persist(run, noProposalResult(run, issueType, message));
      return "persisted";
    }
    const { error } = await createSupabaseAdminClient().rpc("request_meenakshi_evaluation_refresh", {
      p_evaluation_run_id: run.id,
      p_worker_id: run.locked_by,
      p_master_scope: scope.masterScope,
      p_voucher_scope: scope.voucherScope,
    });
    if (error) throw error;
    return "refresh_requested";
  }

  const refresh = await refreshIsComplete(run);
  if (refresh.failed) throw new Error(refresh.failed);
  if (!refresh.complete) return "waiting_for_tally";

  if (run.request_context.schemeType === "cd" && run.request_context.batch === true) {
    await persist(run, noProposalResult(run, "other", "Fresh Cash Discount information was not returned by the installed Tally connector. Update or restart the connector, then run the check again."));
    return "persisted";
  }

  let loaded: Awaited<ReturnType<typeof loadFreshEvaluation>>;
  try {
    loaded = await loadFreshEvaluation(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The fresh Tally evidence cannot be evaluated.";
    const issueType = /No active|unavailable|immutable TOD rule/i.test(message) ? "no_active_rule" : "missing_rule_configuration";
    await persist(run, noProposalResult(run, issueType, message));
    return "persisted";
  }
  await lockTodPeriod(run, loaded);
  const result = loaded.kind === "cd" ? evaluateCd(loaded) : evaluateTod(loaded);
  await persist(run, result);
  return "persisted";
}

export async function failEvaluationRun(run: EvaluationWorkerRun, error: unknown) {
  const detail = errorText(error);
  const { error: failure } = await createSupabaseAdminClient().rpc("fail_meenakshi_evaluation_run", {
    p_evaluation_run_id: run.id,
    p_worker_id: run.locked_by,
    p_error_summary: detail.slice(0, 2_000),
  });
  if (failure) throw failure;
}
