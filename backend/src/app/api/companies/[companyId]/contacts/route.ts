import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readBoolean, readOptionalText, readRequiredUuid, requireRulebookCompanyAdmin, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
const E164 = /^\+[1-9]\d{7,14}$/;

export function OPTIONS(request: Request) { return optionsWithCors(request); }

async function requireCustomer(companyId: string, customerId: string) {
  const { data, error } = await createSupabaseAdminClient().from("customers").select("id, ledger_name, source_payload, is_available").eq("id", customerId).eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) throw new RulebookRequestError("Customer was not found for this company.", 404);
  return data as { id: string; ledger_name: string; source_payload: Record<string, unknown> | null; is_available: boolean };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const customerId = new URL(request.url).searchParams.get("customerId");
    if (customerId) await requireCustomer(scope.company.id, customerId);
    const supabase = createSupabaseAdminClient();
    let query = supabase
      .from("customer_contacts")
      .select("id, customer_id, phone_e164, contact_name, source, is_primary, is_active, entered_by, entered_at, updated_at")
      .eq("company_id", scope.company.id)
      .order("entered_at", { ascending: false });
    if (customerId) query = query.eq("customer_id", customerId);
    const { data: contacts, error } = await query;
    if (error) throw error;
    const ids = [...new Set((contacts ?? []).map((contact) => (contact as { customer_id: string }).customer_id))];
    const { data: customers, error: customerError } = ids.length
      ? await supabase.from("customers").select("id, ledger_name, source_payload, is_available").in("id", ids)
      : { data: [], error: null };
    if (customerError) throw customerError;
    const customerById = new Map((customers ?? []).map((customer) => [(customer as { id: string }).id, customer as { id: string; ledger_name: string; source_payload: Record<string, unknown> | null; is_available: boolean }]));
    return jsonWithCors(request, {
      contacts: (contacts ?? []).map((contact) => {
        const row = contact as { customer_id: string } & Record<string, unknown>;
        const customer = customerById.get(row.customer_id);
        const payload = customer?.source_payload && typeof customer.source_payload === "object" ? customer.source_payload : {};
        return {
          ...row,
          customer: customer ? {
            id: customer.id,
            ledgerName: customer.ledger_name,
            isAvailable: customer.is_available,
            tallyContact: {
              phone: typeof payload.phone === "string" ? payload.phone : null,
              contactName: typeof payload.contactName === "string" ? payload.contactName : null,
            },
          } : null,
        };
      }),
    });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load controlled contacts");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = readRequiredUuid(body.customerId, "customerId");
    await requireCustomer(scope.company.id, customerId);
    const phoneE164 = typeof body.phoneE164 === "string" ? body.phoneE164.trim() : "";
    if (!E164.test(phoneE164)) return jsonWithCors(request, { error: "phoneE164 must be a normalized E.164 phone number, for example +919876543210." }, { status: 400 });
    const contactName = readOptionalText(body.contactName, 160);
    const isPrimary = body.isPrimary === undefined ? true : readBoolean(body.isPrimary, "isPrimary");
    const supabase = createSupabaseAdminClient();
    if (isPrimary) {
      const { error: previousError } = await supabase.from("customer_contacts").update({ is_primary: false }).eq("company_id", scope.company.id).eq("customer_id", customerId).eq("is_active", true).eq("is_primary", true);
      if (previousError) throw previousError;
    }
    const { data, error } = await supabase.from("customer_contacts")
      .insert({ company_id: scope.company.id, customer_id: customerId, phone_e164: phoneE164, contact_name: contactName, source: "controlled_manual_update", is_primary: isPrimary, is_active: true, entered_by: scope.userId })
      .select("id, customer_id, phone_e164, contact_name, source, is_primary, is_active, entered_by, entered_at, updated_at")
      .single();
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "customer_contact_added", entityType: "customer_contact", entityId: (data as { id: string }).id, newValue: { customerId, phoneE164, contactName, isPrimary, source: "controlled_manual_update" } });
    return jsonWithCors(request, { contact: data }, { status: 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "create controlled contact");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const contactId = readRequiredUuid(body.contactId, "contactId");
    const { data: existing, error: existingError } = await createSupabaseAdminClient().from("customer_contacts").select("id, customer_id, is_primary, is_active").eq("id", contactId).eq("company_id", scope.company.id).maybeSingle();
    if (existingError) throw existingError;
    const contact = existing as { id: string; customer_id: string; is_primary: boolean; is_active: boolean } | null;
    if (!contact) return jsonWithCors(request, { error: "Contact was not found for this company." }, { status: 404 });
    const update: Record<string, unknown> = {};
    if (body.isActive !== undefined) update.is_active = readBoolean(body.isActive, "isActive");
    if (body.isPrimary !== undefined) update.is_primary = readBoolean(body.isPrimary, "isPrimary");
    if (!Object.keys(update).length) return jsonWithCors(request, { error: "Provide isActive or isPrimary." }, { status: 400 });
    const supabase = createSupabaseAdminClient();
    if (update.is_primary === true) {
      const { error } = await supabase.from("customer_contacts").update({ is_primary: false }).eq("company_id", scope.company.id).eq("customer_id", contact.customer_id).eq("is_active", true).eq("is_primary", true).neq("id", contact.id);
      if (error) throw error;
    }
    const { data, error } = await supabase.from("customer_contacts").update(update).eq("id", contact.id).eq("company_id", scope.company.id).select("id, customer_id, phone_e164, contact_name, source, is_primary, is_active, entered_by, entered_at, updated_at").single();
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "customer_contact_status_updated", entityType: "customer_contact", entityId: contact.id, previousValue: { isPrimary: contact.is_primary, isActive: contact.is_active }, newValue: update });
    return jsonWithCors(request, { contact: data });
  } catch (error) {
    return rulebookErrorResponse(request, error, "update controlled contact");
  }
}
