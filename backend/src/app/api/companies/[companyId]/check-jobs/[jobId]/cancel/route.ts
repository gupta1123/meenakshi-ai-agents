import { auditUserAction } from "@/lib/audit";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; jobId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Stop a check. Waiting: removed now. Running: the Tally server is told and stops at the next safe point. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, jobId } = await context.params;
    if (!isUuid(companyId) || !isUuid(jobId)) return jsonWithCors(request, { error: "Invalid id." }, { status: 400 });
    const access = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const { data, error } = await createSupabaseAdminClient().rpc("cancel_tally_check_job", { p_job_id: jobId, p_company_id: access.company.id });
    if (error) throw error;
    const outcome = String(data);
    await auditUserAction(access, { action: "check_job_stop_requested", entityType: "tally_check_job", entityId: jobId, newValue: { outcome } });
    return jsonWithCors(request, { outcome });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not stop check job:", error);
    return jsonWithCors(request, { error: "Could not stop the check." }, { status: 500 });
  }
}
