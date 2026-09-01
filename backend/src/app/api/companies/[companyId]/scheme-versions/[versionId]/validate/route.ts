import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, requireRulebookVersionForCompany, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; versionId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    const { data, error } = await createSupabaseAdminClient().rpc("validate_meenakshi_scheme_version", { p_scheme_version_id: version.id });
    if (error) throw error;
    const validation = data as { valid?: boolean; issues?: Array<{ code?: string }> };
    await appendRulebookAudit({
      scope,
      action: "scheme_version_validation_requested",
      entityType: "scheme_version",
      entityId: version.id,
      metadata: { valid: validation.valid === true, issueCodes: (validation.issues ?? []).map((issue) => issue.code ?? "unknown") },
    });
    return jsonWithCors(request, { validation });
  } catch (error) {
    return rulebookErrorResponse(request, error, "validate scheme version");
  }
}
