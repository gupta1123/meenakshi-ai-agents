import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireCurrentMasterSync, requireRulebookVersionForCompany, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; versionId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    await requireCurrentMasterSync(scope.company.id);
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc("activate_meenakshi_scheme_version", {
      p_scheme_version_id: version.id,
      p_actor_id: scope.userId,
      p_correlation_id: null,
      p_metadata: { requestedFrom: "rulebook_api" },
    });
    if (error) return jsonWithCors(request, { error: error.message || "Rule version could not be activated. Review the rule and try again." }, { status: 409 });
    return jsonWithCors(request, { activation: data });
  } catch (error) {
    return rulebookErrorResponse(request, error, "activate scheme version");
  }
}
