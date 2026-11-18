import { auditUserAction } from "@/lib/audit";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { buildCheckJobInput, CheckJobRequestError } from "@/lib/check-jobs";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { CdEvidenceSafetyError, requireCurrentCdConnector } from "@/lib/evaluation/cd-credit-note-safety";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

const JOB_COLUMNS = "id, kind, scope_key, status, requested_by, attempts, cancel_requested, progress, failing_step, failure_reason, evaluation_run_id, created_at, started_at, finished_at, updated_at";

/** Ask the Tally server for a check. The same request already queued or running is joined, not repeated. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const access = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const input = buildCheckJobInput(await request.json().catch(() => null));
    const calculationBody = input.request.body as { rule?: { cdDiscountBasis?: string } } | undefined;
    if (input.kind === "cd" && calculationBody?.rule?.cdDiscountBasis === "amount_per_tonne") await requireCurrentCdConnector(createSupabaseAdminClient(), access.company.id);
    const { data, error } = await createSupabaseAdminClient().rpc("request_tally_check_job_v2", {
      p_organization_id: access.company.organization_id, p_company_id: access.company.id,
      p_kind: input.kind, p_scope_key: input.scopeKey, p_request: input.request, p_requested_by: access.userId,
    });
    if (error) {
      if (error.code === "P0001") return jsonWithCors(request, { error: error.message }, { status: 409 });
      throw error;
    }
    const result = data as { joined: boolean; job: { id: string }; queuePosition: number };
    await auditUserAction(access, {
      action: result.joined ? "check_job_joined" : "check_job_requested", entityType: "tally_check_job", entityId: result.job.id,
      newValue: { kind: input.kind, scopeKey: input.scopeKey },
    });
    return jsonWithCors(request, result, { status: result.joined ? 200 : 201 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError || error instanceof CheckJobRequestError || error instanceof CdEvidenceSafetyError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not request check job:", error);
    return jsonWithCors(request, { error: "Could not start the check." }, { status: 500 });
  }
}

/** Recent checks, so a reopened page can recover progress or the result. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const access = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const { data, error } = await createSupabaseAdminClient().from("tally_check_jobs").select(JOB_COLUMNS)
      .eq("company_id", access.company.id).order("created_at", { ascending: false }).limit(20);
    if (error) throw error;
    return jsonWithCors(request, { jobs: data ?? [] });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list check jobs:", error);
    return jsonWithCors(request, { error: "Could not load checks." }, { status: 500 });
  }
}
