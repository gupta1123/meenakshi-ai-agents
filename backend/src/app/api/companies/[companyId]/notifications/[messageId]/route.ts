import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireMeenakshiCompanyAccess, MeenakshiAccessError } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; messageId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, messageId } = await context.params;
    if (!isUuid(companyId) || !isUuid(messageId)) return jsonWithCors(request, { error: "Invalid company or notification id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const { data: message, error } = await supabase.from("notification_messages")
      .select("id, proposal_id, credit_note_posting_id, event_type, resend_of_notification_id, resend_reason, recipient_phone_e164, opt_in_snapshot, status, scheduled_for, available_at, attempt_count, max_attempts, sent_at, delivered_at, read_at, failure_reason, created_at, updated_at")
      .eq("id", messageId).eq("company_id", company.id).maybeSingle();
    if (error) throw error;
    if (!message) return jsonWithCors(request, { error: "Notification was not found." }, { status: 404 });
    const { data: attempts, error: attemptsError } = await supabase.from("notification_attempts")
      .select("id, attempt_number, provider_message_id, status, attempted_at, completed_at, failure_reason")
      .eq("notification_message_id", messageId).order("attempt_number", { ascending: false });
    if (attemptsError) throw attemptsError;
    // Deliberately omit frozen payloads, provider metadata, provider response
    // bodies, and template envelopes. Rendering is performed by the separate
    // protected preview endpoint.
    return jsonWithCors(request, { message, attempts: attempts ?? [] });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load notification detail:", error);
    return jsonWithCors(request, { error: "Could not load notification detail." }, { status: 500 });
  }
}
