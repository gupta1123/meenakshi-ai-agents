import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { stopEvaluationRun } from "@/lib/evaluation/cancel-run";
import { type EvaluationRunRecord } from "@/lib/evaluation/evidence";
import { isLiveTodBatchAggregate, type LiveTodBatchAggregate } from "@/lib/evaluation/live-tod";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readIdempotencyKey } from "@/lib/tally/contracts";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = await request.json().catch(() => null) as { asOfDate?: unknown; evaluatedOn?: unknown; evidence?: unknown } | null;
    if (!body || !isLiveTodBatchAggregate(body.evidence)) return jsonWithCors(request, { error: "Valid local Tally evidence is required." }, { status: 400 });
    if (!body.evidence.customerAggregates.length || body.evidence.customerAggregates.length > 10_000) {
      return jsonWithCors(request, { error: "The local Tally result has an invalid customer count." }, { status: 413 });
    }
    const today = new Date().toISOString().slice(0, 10);
    const asOfDate = validDate(body.asOfDate) ? body.asOfDate : today;
    const evaluatedOn = validDate(body.evaluatedOn) ? body.evaluatedOn : today;
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
    if (run.request_context.batch !== true) {
      // A retry after a successful fan-out returns the original parent, whose
      // batch marker is intentionally removed by the database function.
      if (run.idempotency_key === idempotencyKey) {
        return jsonWithCors(request, { evaluationRun: run }, { status: 200 });
      }
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
    const evidence: LiveTodBatchAggregate = { ...body.evidence, evaluationRunId: run.id };
    const { error: fanoutError } = await supabase.rpc("fanout_meenakshi_tod_batch_evaluation", {
      p_parent_run_id: run.id,
      p_company_id: company.id,
      p_batch_result: evidence,
    });
    if (fanoutError) throw fanoutError;
    const { data: queuedRun, error: queuedError } = await supabase.from("evaluation_runs").select("*").eq("id", run.id).eq("company_id", company.id).single();
    if (queuedError) throw queuedError;
    return jsonWithCors(request, { evaluationRun: queuedRun }, { status: 201 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not persist the local Turnover Discount result:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not save the local Turnover Discount result." }, { status: 500 });
  }
}
