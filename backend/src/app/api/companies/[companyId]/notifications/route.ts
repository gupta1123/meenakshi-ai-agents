import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireMeenakshiCompanyAccess, MeenakshiAccessError } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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
    const messages = (data ?? []).map(({ payload, ...message }) => ({
      ...message,
      customer_name: payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).customerName === "string"
        ? (payload as Record<string, unknown>).customerName
        : null,
    }));
    return jsonWithCors(request, { messages });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list notifications:", error);
    return jsonWithCors(request, { error: "Could not list notifications." }, { status: 500 });
  }
}
