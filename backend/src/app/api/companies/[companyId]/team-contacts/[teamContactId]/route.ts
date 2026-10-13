import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { normalizeRecipient } from "@/lib/notifications/manual-send";
import { appendRulebookAudit, readBoolean, readOptionalText, readRequiredText, readRequiredUuid, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; teamContactId: string }> };
const columns = "id, name, role_label, phone_e164, is_active, created_at, updated_at";

export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Edit a team member, or switch them off/on. Nobody is deleted so past messages keep their history. */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { companyId, teamContactId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const id = readRequiredUuid(teamContactId, "teamContactId");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) update.name = readRequiredText(body.name, "name", 120);
    if (body.roleLabel !== undefined) update.role_label = readOptionalText(body.roleLabel, 80);
    if (body.isActive !== undefined) update.is_active = readBoolean(body.isActive, "isActive");
    if (body.phone !== undefined) {
      const phone = normalizeRecipient(body.phone);
      if (!phone) return jsonWithCors(request, { error: "Enter a valid mobile number, for example 98765 43210 or +91 98765 43210." }, { status: 400 });
      update.phone_e164 = phone;
    }
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.from("team_contacts").update(update).eq("id", id).eq("company_id", scope.company.id).select(columns).maybeSingle();
    if (error) {
      if (error.code === "23505") return jsonWithCors(request, { error: "This number is already on the team list." }, { status: 409 });
      throw error;
    }
    if (!data) throw new RulebookRequestError("Team member was not found.", 404);
    await appendRulebookAudit({ scope, action: "team_contact_updated", entityType: "team_contact", entityId: id, newValue: { name: data.name, phoneE164: data.phone_e164, isActive: data.is_active } });
    return jsonWithCors(request, { teamContact: data });
  } catch (error) {
    return rulebookErrorResponse(request, error, "update the team member");
  }
}
