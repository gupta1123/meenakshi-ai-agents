import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { listActiveRulesByGroup } from "@/lib/evaluation/evidence";
import { isUuid } from "@/lib/security";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Active Cash Discount and Turnover Discount rules today with their customer groups. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const rules = await listActiveRulesByGroup(company.id, new Date().toISOString().slice(0, 10));
    return jsonWithCors(request, { rules }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list rules by customer group:", error);
    return jsonWithCors(request, { error: "Could not list rules by customer group." }, { status: 500 });
  }
}
