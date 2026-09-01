import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { loadLiveTodLocalBootstrap, type EvaluationRunRecord } from "@/lib/evaluation/evidence";
import { isUuid } from "@/lib/security";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function validDate(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const requestedAsOfDate = url.searchParams.get("asOfDate");
    const asOfDate = process.env.NODE_ENV === "development" && validDate(requestedAsOfDate) ? requestedAsOfDate : today;
    const syntheticRun: EvaluationRunRecord = {
      id: "local-preview",
      company_id: company.id,
      requested_by: null,
      request_context: { schemeType: "tod", batch: true, asOfDate, evaluatedOn: today },
      tally_master_refresh_run_id: null,
      tally_voucher_refresh_run_id: null,
    };
    const bootstrap = await loadLiveTodLocalBootstrap(syntheticRun);
    return jsonWithCors(request, {
      evaluatedOn: bootstrap.evaluatedOn,
      expectedCompany: { name: company.tally_company_name, guid: company.tally_company_guid },
      batches: bootstrap.batches.map((batch) => ({
        ...batch,
        voucherScope: { ...batch.voucherScope, evaluationRunId: null },
      })),
    }, { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=120" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not prepare the local Turnover Discount calculation:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not prepare the local Turnover Discount calculation." }, { status: 500 });
  }
}
