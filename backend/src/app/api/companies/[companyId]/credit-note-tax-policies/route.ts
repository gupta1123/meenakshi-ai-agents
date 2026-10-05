import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readDate, readOptionalText, readRequiredText, readTimestamp, requireRulebookCompanyAdmin, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const { data, error } = await createSupabaseAdminClient().from("company_credit_note_tax_policies")
      .select("id, gst_treatment, effective_from, effective_to, approval_reference, approver_name_snapshot, approved_by, approved_at, notes, created_at, updated_at")
      .eq("company_id", scope.company.id)
      .order("effective_from", { ascending: false });
    if (error) throw error;
    return jsonWithCors(request, { policies: data ?? [] });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load Credit Note tax policies");
  }
}

// This records supplied Finance/CA approval evidence. It does not itself grant
// Finance approval for an individual discount proposal; that happens in Phase 5.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.gstTreatment !== "commercial_no_gst") return jsonWithCors(request, { error: "gstTreatment must be commercial_no_gst." }, { status: 400 });
    const effectiveFrom = readDate(body.effectiveFrom, "effectiveFrom") as string;
    const effectiveTo = readDate(body.effectiveTo, "effectiveTo", false);
    if (effectiveTo && effectiveTo < effectiveFrom) return jsonWithCors(request, { error: "effectiveTo cannot be before effectiveFrom." }, { status: 400 });
    const approvalReference = readRequiredText(body.approvalReference, "approvalReference", 500);
    const approverName = readRequiredText(body.approverName, "approverName", 240);
    const approvedAt = readTimestamp(body.approvedAt, "approvedAt", false) ?? new Date().toISOString();
    const notes = readOptionalText(body.notes, 2_000);
    const { data, error } = await createSupabaseAdminClient().from("company_credit_note_tax_policies")
      .insert({ company_id: scope.company.id, gst_treatment: "commercial_no_gst", effective_from: effectiveFrom, effective_to: effectiveTo, approval_reference: approvalReference, approver_name_snapshot: approverName, approved_by: scope.userId, approved_at: approvedAt, notes })
      .select("id, gst_treatment, effective_from, effective_to, approval_reference, approver_name_snapshot, approved_by, approved_at, notes, created_at, updated_at")
      .single();
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "credit_note_tax_policy_recorded", entityType: "company_credit_note_tax_policy", entityId: (data as { id: string }).id, newValue: { effectiveFrom, effectiveTo, approvalReference, approverName, approvedAt } });
    return jsonWithCors(request, { policy: data }, { status: 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "record Credit Note tax policy");
  }
}
