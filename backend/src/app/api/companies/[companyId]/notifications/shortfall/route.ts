import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { queueInitialNotification } from "@/lib/notifications/event-factory";
import { readRequiredUuid, rulebookErrorResponse } from "@/lib/rulebook/shared";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Recovery endpoint for an eligible CD evaluation; it never accepts a phone or message text. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const proposalId = readRequiredUuid(body.proposalId, "proposalId");
    const result = await queueInitialNotification({ companyId: scope.company.id, proposalId, eventType: "cd_shortfall", actorId: scope.userId });
    return jsonWithCors(request, result, { status: result.queued ? 201 : 409 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    return rulebookErrorResponse(request, error, "queue CD shortfall reminder");
  }
}
