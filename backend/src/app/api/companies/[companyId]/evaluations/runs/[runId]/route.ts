import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { collapseEvaluationRuns } from "@/lib/evaluation/run-batches";
import { compactSummaryColumns, restoreCompactSummary, type RunSummaryRow } from "@/lib/evaluation/run-summary";
import { resultResetCutoff, resultIsVisible } from "@/lib/evaluation/result-visibility";

type RouteContext = { params: Promise<{ companyId: string; runId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, runId } = await context.params;
    if (!isUuid(companyId) || !isUuid(runId)) return jsonWithCors(request, { error: "Invalid company or evaluation run id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const compact = new URL(request.url).searchParams.get('detail') === 'compact';
    const { data: rawData, error } = await supabase
      .from("evaluation_runs")
      .select(`id, idempotency_key, company_id, scheme_version_id, evaluation_date, period_start, period_end, status, requested_by, source_fingerprint, ${compact ? compactSummaryColumns : 'summary'}, error_summary, started_at, completed_at, created_at, updated_at, request_context, tally_master_refresh_run_id, tally_voucher_refresh_run_id, attempts, max_attempts`)
      .eq("id", runId).eq("company_id", company.id).returns<RunSummaryRow[]>().maybeSingle();
    if (error) throw error;
    if (!rawData) return jsonWithCors(request, { error: "Evaluation run not found." }, { status: 404 });
    if (!resultIsVisible(rawData.created_at, await resultResetCutoff(company.id))) return jsonWithCors(request, { error: "This calculation was archived. Calculate again to view fresh results." }, { status: 404 });
    const data = compact ? restoreCompactSummary(rawData) : rawData;
    const { data: snapshot, error: snapshotError } = await supabase
      .from("proposal_evaluations")
      .select("proposal_id, id")
      .eq("evaluation_run_id", runId).eq("company_id", company.id)
      .order("evaluation_number", { ascending: false }).limit(1).maybeSingle();
    if (snapshotError) throw snapshotError;
    const { data: children, error: childrenError } = await supabase.from("evaluation_runs")
      .select(`id, idempotency_key, status, created_at, updated_at, completed_at, started_at, request_context, ${compactSummaryColumns}, period_start, period_end, scheme_version_id, error_summary`)
      .eq("company_id", company.id).like("idempotency_key", `${runId}:%`).returns<RunSummaryRow[]>();
    if (childrenError) throw childrenError;
    const evaluationRun = children?.length ? collapseEvaluationRuns([data, ...children.map(restoreCompactSummary)])[0] : data;
    return jsonWithCors(request, { evaluationRun, proposalId: snapshot?.proposal_id ?? null, proposalEvaluationId: snapshot?.id ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not read evaluation run:", error);
    return jsonWithCors(request, { error: "Could not read evaluation run." }, { status: 500 });
  }
}
