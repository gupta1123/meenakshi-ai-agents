import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readBoolean, readOptionalText, readTimestamp, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; contactId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

async function requireContact(companyId: string, contactId: string) {
  if (!isUuid(contactId)) throw new RulebookRequestError("Invalid contact id.");
  const { data, error } = await createSupabaseAdminClient().from("customer_contacts").select("id, customer_id, phone_e164, is_active").eq("id", contactId).eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) throw new RulebookRequestError("Contact was not found for this company.", 404);
  return data as { id: string; customer_id: string; phone_e164: string; is_active: boolean };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, contactId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    await requireContact(scope.company.id, contactId);
    const { data, error } = await createSupabaseAdminClient().from("whatsapp_opt_ins").select("id, is_opted_in, source, recorded_at, evidence, revoked_at, created_at").eq("company_id", scope.company.id).eq("customer_contact_id", contactId).order("recorded_at", { ascending: false });
    if (error) throw error;
    return jsonWithCors(request, { optIns: data ?? [] });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load WhatsApp opt-ins");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, contactId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const contact = await requireContact(scope.company.id, contactId);
    if (!contact.is_active) return jsonWithCors(request, { error: "An inactive contact cannot receive a WhatsApp opt-in record." }, { status: 409 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const isOptedIn = readBoolean(body.isOptedIn, "isOptedIn");
    const source = readOptionalText(body.source, 160);
    if (!source) return jsonWithCors(request, { error: "source is required." }, { status: 400 });
    const recordedAt = readTimestamp(body.recordedAt, "recordedAt", false) ?? new Date().toISOString();
    const evidence = body.evidence && typeof body.evidence === "object" && !Array.isArray(body.evidence) ? body.evidence : {};
    const supabase = createSupabaseAdminClient();
    const revokedAt = new Date().toISOString();
    const { error: revokeError } = await supabase.from("whatsapp_opt_ins").update({ revoked_at: revokedAt }).eq("company_id", scope.company.id).eq("customer_contact_id", contact.id).eq("is_opted_in", true).is("revoked_at", null);
    if (revokeError) throw revokeError;
    const { data, error } = await supabase.from("whatsapp_opt_ins")
      .insert({ company_id: scope.company.id, customer_contact_id: contact.id, is_opted_in: isOptedIn, source, recorded_at: recordedAt, evidence, revoked_at: isOptedIn ? null : revokedAt })
      .select("id, is_opted_in, source, recorded_at, evidence, revoked_at, created_at")
      .single();
    if (error) throw error;
    await appendRulebookAudit({ scope, action: isOptedIn ? "whatsapp_opt_in_recorded" : "whatsapp_opt_in_revoked", entityType: "whatsapp_opt_in", entityId: (data as { id: string }).id, newValue: { contactId: contact.id, isOptedIn, source, recordedAt } });
    return jsonWithCors(request, { optIn: data }, { status: 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "record WhatsApp opt-in");
  }
}
