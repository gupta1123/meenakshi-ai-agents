/**
 * Saves a Cash Discount / Turnover Discount result that a Meenakshi connector
 * calculated from Tally. Used by the page (PC mode: the browser posts the
 * result) and by the server-mode finish route (the server connector's result
 * is saved without any page open). Both paths run exactly the same code.
 */
import { appendMeenakshiAuditEvent, auditUserAction } from "@/lib/audit";
import { stopEvaluationRun } from "@/lib/evaluation/cancel-run";
import { loadLiveCdBatchRule, type EvaluationRunRecord } from "@/lib/evaluation/evidence";
import { completeLiveCdRun, isLiveCdBatch, type LiveCdBatch } from "@/lib/evaluation/live-cd";
import { isLiveTodBatchAggregate, type LiveTodBatchAggregate } from "@/lib/evaluation/live-tod";
import { retireObsoleteEvaluationReads } from "@/lib/evaluation/refresh-commands.mjs";
import { readDate } from "@/lib/rulebook/shared";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type SaveScope = { userId: string; roles: readonly string[]; organization: { id: string }; company: { id: string } };

export class SaveResultError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function saveLocalCdResult(scope: SaveScope, input: { evaluatedOn?: unknown; evidence?: unknown }, idempotencyKey: string) {
  const { organization, company, userId } = scope;
  if (!isLiveCdBatch(input.evidence)) throw new SaveResultError("Valid local Tally evidence is required.");
  if (!isUuid(input.evidence.ruleVersionId)) throw new SaveResultError("A valid Cash Discount rule is required.");
  const periodStart = readDate(input.evidence.dateFrom, "Tally period start");
  const periodEnd = readDate(input.evidence.dateTo, "Tally period end");
  if (periodStart! > periodEnd!) throw new SaveResultError("Tally period end must be on or after its start.");
  if (input.evidence.invoices.length > 25_000) throw new SaveResultError("The local Tally result is too large.", 413);
  const today = new Date().toISOString().slice(0, 10);
  const evaluatedOn = process.env.NODE_ENV === "development" && validDate(input.evaluatedOn) ? input.evaluatedOn : today;
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("create_meenakshi_evaluation_run", {
    p_organization_id: organization.id,
    p_company_id: company.id,
    p_actor_id: userId,
    // ruleVersionId lets the page show "last calculated" per Cash Discount rule.
    p_request_context: { schemeType: "cd", batch: true, evaluatedOn, localFirst: true, ruleVersionId: input.evidence.ruleVersionId },
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  const run = data as EvaluationRunRecord & { status: string; created_at: string };
  const evidence: LiveCdBatch = { ...input.evidence, evaluationRunId: run.id };
  const { rule } = await loadLiveCdBatchRule(run, evidence.ruleVersionId);
  const { error: savingError } = await supabase.from("evaluation_runs").update({
    request_context: { ...run.request_context, schemeType: "cd", batch: true, evaluatedOn, localFirst: true, ruleVersionId: evidence.ruleVersionId },
    // The database requires all three fields when entering evaluating.
    // Set them in the same update so there is no invalid intermediate state.
    scheme_version_id: rule.id, period_start: periodStart, period_end: periodEnd,
    status: "evaluating", started_at: new Date().toISOString(), summary: { schemeType: "cd", liveOnly: true, evidenceMode: "local_connector" }, error_summary: null,
  }).eq("id", run.id).eq("company_id", company.id);
  if (savingError) throw savingError;
  await retireObsoleteEvaluationReads(supabase, { companyId: company.id, runId: run.id });
  const result = await completeLiveCdRun(run, evidence);
  const { data: completedRun, error: completedError } = await supabase.from("evaluation_runs").select("*").eq("id", run.id).eq("company_id", company.id).single();
  if (completedError) throw completedError;
  await auditUserAction(scope, {
    action: "cd_result_saved", entityType: "evaluation_run", entityId: run.id,
    newValue: { periodStart, periodEnd, ruleVersionId: evidence.ruleVersionId, invoices: evidence.invoices.length },
  });
  return { evaluationRun: completedRun as Record<string, unknown> & { id: string }, totals: result.totals };
}

export async function saveLocalTodResult(scope: SaveScope, input: { asOfDate?: unknown; evaluatedOn?: unknown; evidence?: unknown }, idempotencyKey: string) {
  const { organization, company, userId } = scope;
  const startedAt = Date.now();
  const marks: string[] = [];
  const mark = (stage: string) => marks.push(`${stage}=${Date.now() - startedAt}ms`);
  if (!isLiveTodBatchAggregate(input.evidence)) throw new SaveResultError("Valid local Tally evidence is required.");
  if (!input.evidence.customerAggregates.length || input.evidence.customerAggregates.length > 10_000) {
    throw new SaveResultError("The local Tally result has an invalid customer count.", 413);
  }
  const today = new Date().toISOString().slice(0, 10);
  const asOfDate = validDate(input.asOfDate) ? input.asOfDate : today;
  const evaluatedOn = validDate(input.evaluatedOn) ? input.evaluatedOn : today;
  const supabase = createSupabaseAdminClient();
  const requestContext = { schemeType: "tod", batch: true, asOfDate, evaluatedOn, localFirst: true };
  type CreatedRun = EvaluationRunRecord & { status: string; created_at: string; idempotency_key: string };
  async function createRun() {
    const { data, error } = await supabase.rpc("create_meenakshi_evaluation_run", {
      p_organization_id: organization.id,
      p_company_id: company.id,
      p_actor_id: userId,
      p_request_context: requestContext,
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    return data as CreatedRun;
  }
  let run = await createRun();
  mark("createRun");
  if (run.request_context.batch !== true) {
    // A retry after a successful fan-out returns the original parent, whose
    // batch marker is intentionally removed by the database function.
    if (run.idempotency_key === idempotencyKey) return { evaluationRun: run as unknown as Record<string, unknown> & { id: string }, created: false };
    // The parallel-run guard can also return an older legacy single-customer
    // TOD run. The completed local calculation supersedes that pending scan.
    await stopEvaluationRun({ companyId: company.id, runId: run.id, status: "cancelled", message: "Superseded by a completed local TOD calculation." });
    await appendMeenakshiAuditEvent({
      organizationId: organization.id,
      companyId: company.id,
      actorType: "user",
      actorId: userId,
      action: "evaluation_superseded",
      entityType: "evaluation_run",
      entityId: run.id,
      newValue: { status: "cancelled", replacement: "local_tod_batch" },
    });
    run = await createRun();
    if (run.request_context.batch !== true) throw new Error("A previous Turnover Discount calculation is still stopping. Please retry once.");
  }
  const evidence: LiveTodBatchAggregate = { ...input.evidence, evaluationRunId: run.id };
  const { error: localModeError } = await supabase.from("evaluation_runs")
    .update({ request_context: { ...run.request_context, ...requestContext } }).eq("id", run.id).eq("company_id", company.id);
  if (localModeError) throw localModeError;
  await retireObsoleteEvaluationReads(supabase, { companyId: company.id, runId: run.id });
  mark("retireReads");
  const { error: fanoutError } = await supabase.rpc("fanout_meenakshi_tod_batch_evaluation", {
    p_parent_run_id: run.id,
    p_company_id: company.id,
    p_batch_result: evidence,
  });
  if (fanoutError) throw fanoutError;
  mark("fanout");
  const { data: queuedRun, error: queuedError } = await supabase.from("evaluation_runs").select("*").eq("id", run.id).eq("company_id", company.id).single();
  if (queuedError) throw queuedError;
  console.info(`TOD local-result timing customers=${input.evidence.customerAggregates.length} ${marks.join(" ")}`);
  return { evaluationRun: queuedRun as Record<string, unknown> & { id: string }, created: true };
}
