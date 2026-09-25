import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { listActiveCdRules } from "@/lib/evaluation/evidence";
import { isUuid } from "@/lib/security";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Active Cash Discount rules today, for the rule selector on the Cash Discount page. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const rules = await listActiveCdRules(company.id, new Date().toISOString().slice(0, 10));
    return jsonWithCors(request, { rules }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list Cash Discount rules:", error);
    return jsonWithCors(request, { error: "Could not list Cash Discount rules." }, { status: 500 });
  }
}
