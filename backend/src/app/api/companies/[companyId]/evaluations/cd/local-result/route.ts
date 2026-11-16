import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { saveLocalCdResult, SaveResultError } from "@/lib/evaluation/save-local-results";
import { isUuid } from "@/lib/security";
import { readIdempotencyKey } from "@/lib/tally/contracts";
import { RulebookRequestError } from "@/lib/rulebook/shared";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const access = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = await request.json().catch(() => null) as { evaluatedOn?: unknown; evidence?: unknown } | null;
    if (!body) return jsonWithCors(request, { error: "Valid local Tally evidence is required." }, { status: 400 });
    const saved = await saveLocalCdResult(access, body, idempotencyKey);
    return jsonWithCors(request, saved, { status: 201 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError || error instanceof RulebookRequestError || error instanceof SaveResultError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not persist the local Cash Discount result:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not save the local Cash Discount result." }, { status: 500 });
  }
}
