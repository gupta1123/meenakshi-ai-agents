import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireMeenakshiCompanyAccess, MeenakshiAccessError } from "@/lib/authorization";
import { notificationTemplateBlock } from "@/lib/notifications/template-readiness";
import { notificationEventTypes, type NotificationEventType } from "@/lib/notifications/types";

export const OPTIONS = optionsWithCors;
export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }) {
  try {
    const { companyId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const eventType = new URL(request.url).searchParams.get("eventType") as NotificationEventType;
    if (!notificationEventTypes.includes(eventType)) return jsonWithCors(request, { error: "Unknown message type." }, { status: 400 });
    const blockedReason = await notificationTemplateBlock(scope.company.id, eventType);
    return jsonWithCors(request, { ready: !blockedReason, blockedReason }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    return jsonWithCors(request, { error: "Could not check WhatsApp setup. Try again before sending." }, { status: 503 });
  }
}
