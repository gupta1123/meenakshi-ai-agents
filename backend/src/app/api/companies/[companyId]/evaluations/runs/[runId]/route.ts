import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; runId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, runId } = await context.params;
    if (!isUuid(companyId) || !isUuid(runId)) return jsonWithCors(request, { error: "Invalid company or evaluation run id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("evaluation_runs")
      .select("id, company_id, scheme_version_id, evaluation_date, period_start, period_end, status, requested_by, source_fingerprint, summary, error_summary, started_at, completed_at, created_at, updated_at, request_context, tally_master_refresh_run_id, tally_voucher_refresh_run_id, attempts, max_attempts")
      .eq("id", runId).eq("company_id", company.id).maybeSingle();
    if (error) throw error;
    if (!data) return jsonWithCors(request, { error: "Evaluation run not found." }, { status: 404 });
    const { data: snapshot, error: snapshotError } = await supabase
      .from("proposal_evaluations")
      .select("proposal_id, id")
      .eq("evaluation_run_id", runId).eq("company_id", company.id)
      .order("evaluation_number", { ascending: false }).limit(1).maybeSingle();
    if (snapshotError) throw snapshotError;
    return jsonWithCors(request, { evaluationRun: data, proposalId: snapshot?.proposal_id ?? null, proposalEvaluationId: snapshot?.id ?? null });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not read evaluation run:", error);
    return jsonWithCors(request, { error: "Could not read evaluation run." }, { status: 500 });
  }
}
