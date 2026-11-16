import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; jobId: string }> };
type JobStatusRow = { id: string; status: string; created_at: string; [key: string]: unknown };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, jobId } = await context.params;
    if (!isUuid(companyId) || !isUuid(jobId)) return jsonWithCors(request, { error: "Invalid id." }, { status: 400 });
    const access = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const db = createSupabaseAdminClient();
    // ?result=0 leaves out the (large) result, for pages that only follow the save.
    const withResult = new URL(request.url).searchParams.get("result") !== "0";
    const columns = "id, kind, scope_key, status, requested_by, attempts, cancel_requested, progress, failing_step, failure_reason, evaluation_run_id, created_at, started_at, finished_at, updated_at";
    const { data: job, error } = await db.from("tally_check_jobs")
      .select(withResult ? `${columns}, result` : columns)
      .eq("id", jobId).eq("company_id", access.company.id).returns<JobStatusRow[]>().maybeSingle();
    if (error) throw error;
    if (!job) return jsonWithCors(request, { error: "Check not found." }, { status: 404 });
    let queuePosition = 0;
    if (job.status === "queued") {
      const { count } = await db.from("tally_check_jobs").select("id", { count: "exact", head: true })
        .eq("company_id", access.company.id).in("status", ["queued", "running"]).neq("id", job.id).lt("created_at", job.created_at);
      queuePosition = count ?? 0;
    }
    return jsonWithCors(request, { job, queuePosition });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not read check job:", error);
    return jsonWithCors(request, { error: "Could not load the check." }, { status: 500 });
  }
}
