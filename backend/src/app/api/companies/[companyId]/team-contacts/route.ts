import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { normalizeRecipient } from "@/lib/notifications/manual-send";
import { appendRulebookAudit, readOptionalText, readRequiredText, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
const columns = "id, name, role_label, phone_e164, is_active, created_at, updated_at";

export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Everyone who reads the send screen can see the team; only administrators change it. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const { data, error } = await createSupabaseAdminClient().from("team_contacts").select(columns)
      .eq("company_id", scope.company.id).order("is_active", { ascending: false }).order("name");
    if (error) throw error;
    return jsonWithCors(request, { teamContacts: data ?? [] });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load team contacts");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = readRequiredText(body.name, "name", 120);
    const roleLabel = readOptionalText(body.roleLabel, 80);
    const phone = normalizeRecipient(body.phone);
    if (!phone) return jsonWithCors(request, { error: "Enter a valid mobile number, for example 98765 43210 or +91 98765 43210." }, { status: 400 });
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.from("team_contacts")
      .insert({ company_id: scope.company.id, name, role_label: roleLabel, phone_e164: phone, created_by: scope.userId })
      .select(columns).single();
    if (error) {
      if (error.code === "23505") return jsonWithCors(request, { error: "This number is already on the team list." }, { status: 409 });
      throw error;
    }
    await appendRulebookAudit({ scope, action: "team_contact_added", entityType: "team_contact", entityId: data.id, newValue: { name, phoneE164: phone } });
    return jsonWithCors(request, { teamContact: data }, { status: 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "add the team member");
  }
}
