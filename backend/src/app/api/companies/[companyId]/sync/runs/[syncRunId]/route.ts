import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; syncRunId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, syncRunId } = await context.params;
    if (!isUuid(companyId) || !isUuid(syncRunId)) return jsonWithCors(request, { error: "Invalid company or sync run id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId);
    const { data, error } = await createSupabaseAdminClient()
      .from("tally_sync_runs")
      .select("id, company_id, sync_kind, status, requested_scope, cursor_from, cursor_to, records_received, records_applied, records_failed, source_fingerprint, error_summary, started_at, completed_at, created_at")
      .eq("id", syncRunId)
      .eq("company_id", company.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonWithCors(request, { error: "Sync run not found." }, { status: 404 });
    return jsonWithCors(request, { syncRun: data });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not read Meenakshi sync run:", error);
    return jsonWithCors(request, { error: "Could not read synchronization status." }, { status: 500 });
  }
}
