import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { readIdempotencyKey } from "@/lib/tally/contracts";
import { requestTallySync } from "@/lib/tally/sync-request";
import { isUuid } from "@/lib/security";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const syncRun = await requestTallySync({
      organizationId: organization.id,
      companyId: company.id,
      syncKind: "masters",
      requestedScope: { fullMasterRead: true },
      idempotencyKey,
      actorId: userId,
    });
    return jsonWithCors(request, { syncRun }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not request Meenakshi master sync:", error);
    return jsonWithCors(request, { error: "Could not request master synchronization." }, { status: 500 });
  }
}
