import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { createMessagePreview } from "@/lib/notifications/event-factory";
import { isNotificationEventType, type NotificationMessageRow } from "@/lib/notifications/types";
import { requireMeenakshiCompanyAccess, MeenakshiAccessError } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = (await request.json().catch(() => ({}))) as { notificationMessageId?: unknown };
    if (!isUuid(body.notificationMessageId)) return jsonWithCors(request, { error: "notificationMessageId must be a UUID." }, { status: 400 });
    const { data, error } = await createSupabaseAdminClient().from("notification_messages")
      .select("event_type, payload, template_snapshot").eq("id", body.notificationMessageId).eq("company_id", company.id).maybeSingle();
    if (error) throw error;
    if (!data || !isNotificationEventType(data.event_type)) return jsonWithCors(request, { error: "Notification was not found." }, { status: 404 });
    return jsonWithCors(request, { preview: createMessagePreview(data as Pick<NotificationMessageRow, "event_type" | "payload" | "template_snapshot">) });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not preview notification:", error);
    return jsonWithCors(request, { error: "Could not preview notification." }, { status: 500 });
  }
}
