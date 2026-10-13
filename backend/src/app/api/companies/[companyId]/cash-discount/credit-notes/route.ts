import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { customerGroupsFor } from "@/lib/customer-groups";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/**
 * Per-MT Cash Discount Credit Notes for the Credit Notes page. They are stored
 * with Debit Notes (note_kind = 'credit_note'); cancelled ones are left out.
 * Each carries its invoice, MT and rate from the saved snapshot, and its latest
 * WhatsApp message.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const [notes, messages] = await Promise.all([
      supabase.from("cash_discount_debit_note_postings")
        .select("id, status, amount, verified_amount, verified_voucher_number, verified_at, failure_reason, debit_note_date, created_at, debit_note_snapshot")
        .eq("company_id", company.id).eq("note_kind", "credit_note").neq("status", "cancelled")
        .order("created_at", { ascending: false }).limit(5000),
      supabase.from("notification_messages")
        .select("cash_discount_debit_note_posting_id, status, sent_at, delivered_at, read_at, recipient_phone_e164, failure_reason, created_at")
        .eq("company_id", company.id).eq("event_type", "cd_credit_note_created").not("cash_discount_debit_note_posting_id", "is", null)
        .order("created_at", { ascending: false }).limit(5000),
    ]);
    if (notes.error) throw notes.error;
    if (messages.error) throw messages.error;
    // Every WhatsApp attempt per note, newest first.
    const history = new Map<string, Array<Record<string, unknown>>>();
    for (const message of messages.data ?? []) {
      const key = String(message.cash_discount_debit_note_posting_id);
      history.set(key, [...(history.get(key) ?? []), message]);
    }
    const toMessage = (message: Record<string, unknown>) => ({ status: String(message.status), sentAt: (message.sent_at as string | null) ?? null, deliveredAt: (message.delivered_at as string | null) ?? null, readAt: (message.read_at as string | null) ?? null, recipient: (message.recipient_phone_e164 as string | null) ?? null, failureReason: (message.failure_reason as string | null) ?? null, createdAt: String(message.created_at) });
    const groups = await customerGroupsFor(supabase, company.id, {
      ledgerGuids: (notes.data ?? []).map((note) => String(((note.debit_note_snapshot ?? {}) as { party?: { guid?: string } }).party?.guid ?? "")),
    });
    const creditNotes = (notes.data ?? []).map((note) => {
      const snapshot = (note.debit_note_snapshot ?? {}) as Record<string, Record<string, unknown> | undefined>;
      const cd = snapshot.cashDiscount ?? {};
      const attempts = history.get(note.id) ?? [];
      return {
        id: note.id,
        status: note.status,
        amount: note.verified_amount ?? note.amount,
        voucherNumber: note.verified_voucher_number,
        noteDate: note.debit_note_date,
        verifiedAt: note.verified_at,
        createdAt: note.created_at,
        failureReason: note.failure_reason,
        customerName: typeof snapshot.party?.name === "string" ? snapshot.party.name : null,
        invoiceNumber: typeof snapshot.sourceInvoice?.number === "string" ? snapshot.sourceInvoice.number : null,
        invoiceDate: typeof cd.invoiceDate === "string" ? cd.invoiceDate : null,
        eligibleTonnes: cd.eligibleTonnes != null ? String(cd.eligibleTonnes) : null,
        amountPerTonne: cd.amountPerTonne != null ? String(cd.amountPerTonne) : null,
        category: typeof cd.category === "string" ? cd.category : null,
        segmentLabel: typeof cd.segmentLabel === "string" ? cd.segmentLabel : null,
        invoiceGuid: typeof snapshot.sourceInvoice?.guid === "string" ? snapshot.sourceInvoice.guid : null,
        customerId: groups.byGuid.get(String(snapshot.party?.guid ?? ""))?.customerId ?? null,
        customerGroup: groups.byGuid.get(String(snapshot.party?.guid ?? ""))?.groupName ?? null,
        windowDeadline: typeof cd.windowDeadline === "string" ? cd.windowDeadline : null,
        discountAmount: cd.discountAmount != null ? String(cd.discountAmount) : null,
        whatsapp: attempts[0] ? toMessage(attempts[0]) : null,
        whatsappHistory: attempts.map(toMessage),
      };
    });
    return jsonWithCors(request, { creditNotes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list Cash Discount Credit Notes:", error);
    return jsonWithCors(request, { error: "Could not list Cash Discount Credit Notes." }, { status: 500 });
  }
}
