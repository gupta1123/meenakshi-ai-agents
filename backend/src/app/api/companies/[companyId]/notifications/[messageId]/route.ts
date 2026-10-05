import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireMeenakshiCompanyAccess, MeenakshiAccessError } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createMessagePreview } from "@/lib/notifications/event-factory";
import { sentMessageText } from "@/lib/notifications/sent-message-text";
import { isNotificationEventType, type NotificationMessageRow } from "@/lib/notifications/types";

type RouteContext = { params: Promise<{ companyId: string; messageId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, messageId } = await context.params;
    if (!isUuid(companyId) || !isUuid(messageId)) return jsonWithCors(request, { error: "Invalid company or notification id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const [messageResult, attemptsResult] = await Promise.all([
      supabase.from("notification_messages")
        .select("id, proposal_id, credit_note_posting_id, event_type, resend_of_notification_id, resend_reason, recipient_phone_e164, opt_in_snapshot, status, scheduled_for, available_at, attempt_count, max_attempts, sent_at, delivered_at, read_at, failure_reason, created_at, updated_at, payload, template_snapshot")
        .eq("id", messageId).eq("company_id", company.id).maybeSingle(),
      supabase.from("notification_attempts")
        .select("id, attempt_number, provider_message_id, status, attempted_at, completed_at, failure_reason")
        .eq("notification_message_id", messageId).order("attempt_number", { ascending: false }),
    ]);
    const { data: message, error } = messageResult;
    if (error) throw error;
    if (!message) return jsonWithCors(request, { error: "Notification was not found." }, { status: 404 });
    const { data: attempts, error: attemptsError } = attemptsResult;
    if (attemptsError) throw attemptsError;
    const preview = isNotificationEventType(message.event_type)
      ? createMessagePreview(message as Pick<NotificationMessageRow, "event_type" | "payload" | "template_snapshot">)
      : [];
    const snapshot = (message as Pick<NotificationMessageRow, "template_snapshot">).template_snapshot ?? {};
    const sent = await sentMessageText(snapshot.providerTemplateId, snapshot.languageCode, preview);
    const { payload: _payload, template_snapshot: _templateSnapshot, ...safeMessage } = message;
    void _payload; void _templateSnapshot;
    // Return only the safe rendered preview; frozen inputs and provider payloads stay server-side.
    return jsonWithCors(request, { message: safeMessage, attempts: attempts ?? [], preview, sent });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load notification detail:", error);
    return jsonWithCors(request, { error: "Could not load notification detail." }, { status: 500 });
  }
}
