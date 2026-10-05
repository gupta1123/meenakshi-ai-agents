import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireMeenakshiCompanyAccess, MeenakshiAccessError } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { customerGroupsFor } from "@/lib/customer-groups";

type RouteContext = { params: Promise<{ companyId: string }> };
const allowedStatuses = new Set(["queued", "sending", "sent", "delivered", "read", "failed", "suppressed", "cancelled"]);

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const params = new URL(request.url).searchParams;
    const status = params.get("status");
    if (status && !allowedStatuses.has(status)) return jsonWithCors(request, { error: "Invalid notification status." }, { status: 400 });
    // The note pages need the delivery status of every note, not just the
    // latest 250 company messages; otherwise older sent notes look unsent.
    const noteColumn = { debit_notes: "cash_discount_debit_note_posting_id", credit_notes: "credit_note_posting_id" }[params.get("for") ?? ""];
    let query = createSupabaseAdminClient().from("notification_messages")
      .select("id, proposal_id, credit_note_posting_id, cash_discount_debit_note_posting_id, customer_contact_id, whatsapp_template_id, event_type, business_event_key, resend_of_notification_id, resend_reason, recipient_phone_e164, opt_in_snapshot, status, scheduled_for, available_at, attempt_count, max_attempts, sent_at, delivered_at, read_at, failure_reason, created_at, updated_at, payload")
      .eq("company_id", company.id).order("created_at", { ascending: false }).limit(noteColumn ? 2000 : 250);
    if (noteColumn) query = query.not(noteColumn, "is", null);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    // Customer and Tally group of each message (via its contact), for grouping on the page.
    const contactIds = [...new Set((data ?? []).map((message) => message.customer_contact_id).filter(Boolean))] as string[];
    const contactCustomer = new Map<string, string>();
    for (let index = 0; index < contactIds.length; index += 200) {
      const { data: contacts, error: contactError } = await createSupabaseAdminClient().from("customer_contacts").select("id, customer_id").in("id", contactIds.slice(index, index + 200));
      if (contactError) throw contactError;
      for (const contact of contacts ?? []) contactCustomer.set(contact.id, contact.customer_id);
    }
    const groups = await customerGroupsFor(createSupabaseAdminClient(), company.id, { ids: [...contactCustomer.values()] });
    const messages = (data ?? []).map(({ payload, ...message }) => {
      const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
      const text = (key: string) => typeof body[key] === "string" && body[key] ? String(body[key]) : null;
      const amount = (key: string) => typeof body[key] === "number" || (typeof body[key] === "string" && body[key] !== "") ? String(body[key]) : null;
      // What the message was about, in the user's terms (shown on the Messages page).
      const document = {
        kind: text("creditNoteNumber") ? "credit_note" : text("debitNoteNumber") ? "debit_note" : null,
        number: text("creditNoteNumber") ?? text("debitNoteNumber"),
        amount: amount("creditNoteAmount") ?? amount("debitNoteAmount") ?? amount("benefitAmount"),
        periodStart: text("todPeriodStart"),
        periodEnd: text("todPeriodEnd"),
        invoiceReference: text("invoiceReference")?.startsWith("TOD:") ? null : text("invoiceReference"),
      };
      const customer = message.customer_contact_id ? groups.byId.get(contactCustomer.get(message.customer_contact_id) ?? "") : undefined;
      return { ...message, customer_name: text("customerName"), document, customer_id: customer?.customerId ?? null, customer_group: customer?.groupName ?? null };
    });
    return jsonWithCors(request, { messages });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list notifications:", error);
    return jsonWithCors(request, { error: "Could not list notifications." }, { status: 500 });
  }
}
