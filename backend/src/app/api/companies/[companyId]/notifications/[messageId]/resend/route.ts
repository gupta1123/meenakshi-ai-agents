import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { resendNotification } from "@/lib/notifications/event-factory";
import { RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { isUuid } from "@/lib/security";

type RouteContext = { params: Promise<{ companyId: string; messageId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, messageId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    if (!isUuid(messageId)) throw new RulebookRequestError("Invalid notification id.");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > 500) throw new RulebookRequestError("A resend reason of at most 500 characters is required.");
    const resendKey = request.headers.get("Idempotency-Key")?.trim() || undefined;
    const messageIdCreated = await resendNotification({ companyId: scope.company.id, notificationMessageId: messageId, actorId: scope.userId, reason, resendKey });
    return jsonWithCors(request, { notificationMessageId: messageIdCreated, queued: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
    if (/not approved in MSG91|requires a Credit Note PDF|template setup is incomplete|needs a PDF|mapping.*MSG91 template/i.test(message)) {
      return jsonWithCors(request, { error: message }, { status: 422 });
    }
    if (/Only sent, delivered, read, or failed|active approved template|required before resending|current recorded opt-in|current near-eligibility|verified Tally Credit Note/i.test(message)) {
      return jsonWithCors(request, { error: message }, { status: 409 });
    }
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    return rulebookErrorResponse(request, error, "resend notification");
  }
}
