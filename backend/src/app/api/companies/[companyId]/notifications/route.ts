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
    const status = new URL(request.url).searchParams.get("status");
    if (status && !allowedStatuses.has(status)) return jsonWithCors(request, { error: "Invalid notification status." }, { status: 400 });
    let query = createSupabaseAdminClient().from("notification_messages")
      .select("id, proposal_id, credit_note_posting_id, customer_contact_id, whatsapp_template_id, event_type, business_event_key, resend_of_notification_id, resend_reason, recipient_phone_e164, opt_in_snapshot, status, scheduled_for, available_at, attempt_count, max_attempts, sent_at, delivered_at, read_at, failure_reason, created_at, updated_at")
      .eq("company_id", company.id).order("created_at", { ascending: false }).limit(250);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    return jsonWithCors(request, { messages: data ?? [] });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list notifications:", error);
    return jsonWithCors(request, { error: "Could not list notifications." }, { status: 500 });
  }
}
