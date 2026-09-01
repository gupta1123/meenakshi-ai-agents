import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { type EvaluationRunRecord } from "@/lib/evaluation/evidence";
import { completeLiveCdRun, isLiveCdBatch, type LiveCdBatch } from "@/lib/evaluation/live-cd";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readIdempotencyKey } from "@/lib/tally/contracts";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = await request.json().catch(() => null) as { evaluatedOn?: unknown; evidence?: unknown } | null;
    if (!body || !isLiveCdBatch(body.evidence)) return jsonWithCors(request, { error: "Valid local Tally evidence is required." }, { status: 400 });
    if (body.evidence.invoices.length > 10_000) return jsonWithCors(request, { error: "The local Tally result is too large." }, { status: 413 });
    const today = new Date().toISOString().slice(0, 10);
    const evaluatedOn = process.env.NODE_ENV === "development" && typeof body.evaluatedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.evaluatedOn) ? body.evaluatedOn : today;
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc("create_meenakshi_evaluation_run", {
      p_organization_id: organization.id,
      p_company_id: company.id,
      p_actor_id: userId,
      p_request_context: { schemeType: "cd", batch: true, evaluatedOn, localFirst: true },
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    const run = data as EvaluationRunRecord & { status: string; created_at: string };
    const evidence: LiveCdBatch = { ...body.evidence, evaluationRunId: run.id };
    await supabase.from("evaluation_runs").update({
      status: "evaluating", started_at: new Date().toISOString(), summary: { schemeType: "cd", liveOnly: true, evidenceMode: "local_connector" }, error_summary: null,
    }).eq("id", run.id).eq("company_id", company.id);
    const result = await completeLiveCdRun(run, evidence);
    const { data: completedRun, error: completedError } = await supabase.from("evaluation_runs").select("*").eq("id", run.id).eq("company_id", company.id).single();
    if (completedError) throw completedError;
    return jsonWithCors(request, { evaluationRun: completedRun, totals: result.totals }, { status: 201 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not persist the local Cash Discount result:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not save the local Cash Discount result." }, { status: 500 });
  }
}
