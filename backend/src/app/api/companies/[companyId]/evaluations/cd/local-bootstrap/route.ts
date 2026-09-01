import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { loadLiveCdLocalBootstrap, type EvaluationRunRecord } from "@/lib/evaluation/evidence";
import { isUuid } from "@/lib/security";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function cashDiscountRuleError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "No active Cash Discount rule is available.") {
    return "No active Cash Discount rule covers today. In Rulebook, activate the approved Cash Discount rule whose effective dates include today, then check again.";
  }
  if (message === "More than one active Cash Discount rule is available.") {
    return "More than one active Cash Discount rule covers today. Keep only the approved current version active before checking again.";
  }
  return null;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const requested = url.searchParams.get("evaluatedOn") ?? today;
    const evaluatedOn = process.env.NODE_ENV === "development" && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : today;
    const syntheticRun: EvaluationRunRecord = {
      id: "local-preview",
      company_id: company.id,
      requested_by: null,
      request_context: { schemeType: "cd", batch: true, evaluatedOn },
      tally_master_refresh_run_id: null,
      tally_voucher_refresh_run_id: null,
    };
    const bootstrap = await loadLiveCdLocalBootstrap(syntheticRun);
    return jsonWithCors(request, {
      evaluatedOn: bootstrap.evaluatedOn,
      expectedCompany: { name: company.tally_company_name, guid: company.tally_company_guid },
      rule: bootstrap.rule,
      voucherScope: { ...bootstrap.voucherScope, evaluationRunId: null },
    }, { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=120" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    const ruleError = cashDiscountRuleError(error);
    if (ruleError) return jsonWithCors(request, { error: ruleError }, { status: 409 });
    console.error("Could not prepare the local Cash Discount check:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not prepare the local Cash Discount check." }, { status: 500 });
  }
}
