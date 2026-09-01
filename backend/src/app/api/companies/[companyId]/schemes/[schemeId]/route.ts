import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readOptionalText, readRequiredText, requireRulebookSchemeForCompany, rulebookErrorResponse, toSchemeResponse, toVersionResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; schemeId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, schemeId } = await context.params;
    const { scope, scheme } = await requireRulebookSchemeForCompany(request, companyId, schemeId);
    const { data, error } = await createSupabaseAdminClient()
      .from("scheme_versions")
      .select("id, company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to, discount_percentage, calculation_base, rounding_method, rounding_scale, gst_treatment, credit_note_voucher_type_id, discount_ledger_id, requires_approval, working_calendar_id, allowed_working_days, near_eligibility_percent, cd_invoice_treatment, cd_narration_mode, period_months, period_anchor_date, tod_review_calendar_id, created_at, updated_at")
      .eq("company_id", scope.company.id)
      .eq("scheme_id", scheme.id)
      .order("version_number", { ascending: false });
    if (error) throw error;
    return jsonWithCors(request, { scheme: toSchemeResponse(scheme), versions: ((data ?? []) as Parameters<typeof toVersionResponse>[0][]).map(toVersionResponse) });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load scheme");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { companyId, schemeId } = await context.params;
    const { scope, scheme } = await requireRulebookSchemeForCompany(request, companyId, schemeId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = readRequiredText(body.name, "name", 160);
    if (body.description !== undefined) update.description = readOptionalText(body.description, 1_000);
    if (body.status !== undefined) {
      if (body.status !== "paused" && body.status !== "retired") return jsonWithCors(request, { error: "status can only be paused or retired here. Activation uses the version activation endpoint." }, { status: 400 });
      update.status = body.status;
    }
    if (!Object.keys(update).length) return jsonWithCors(request, { error: "Provide name, description, or status." }, { status: 400 });
    const { data, error } = await createSupabaseAdminClient()
      .from("schemes")
      .update(update)
      .eq("id", scheme.id)
      .eq("company_id", scope.company.id)
      .select("id, company_id, scheme_type, code, name, description, status, created_at, updated_at")
      .single();
    if (error) throw error;
    const updated = data as Parameters<typeof toSchemeResponse>[0];
    await appendRulebookAudit({ scope, action: "scheme_updated", entityType: "scheme", entityId: scheme.id, previousValue: { name: scheme.name, description: scheme.description, status: scheme.status }, newValue: { name: updated.name, description: updated.description, status: updated.status } });
    return jsonWithCors(request, { scheme: toSchemeResponse(updated) });
  } catch (error) {
    return rulebookErrorResponse(request, error, "update scheme");
  }
}
