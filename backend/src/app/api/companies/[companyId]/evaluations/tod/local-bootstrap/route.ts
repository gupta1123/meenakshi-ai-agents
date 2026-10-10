import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { loadLiveTodLocalBootstrap, type EvaluationRunRecord } from "@/lib/evaluation/evidence";
import { isUuid } from "@/lib/security";
import { isTodDate, requestedTodPeriod, TodPeriodError } from "@/lib/evaluation/tod-period";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function addMonths(value: string, months: number) {
  const [year, month, day] = value.split("-").map(Number);
  const targetMonth = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
  const date = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth(), Math.min(day, lastDay)));
  return date.toISOString().slice(0, 10);
}

function previousDay(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function rulePeriods(rule: { periodAnchorDate: string; periodMonths: number; effectiveFrom: string; effectiveTo: string | null }, today: string) {
  const horizon = rule.effectiveTo ?? addMonths(today, rule.periodMonths * 2);
  const periods: Array<{ key: string; start: string; end: string; state: "completed" | "current" | "upcoming" }> = [];
  let start = rule.periodAnchorDate;
  for (let guard = 0; guard < 120 && start <= horizon; guard += 1) {
    const naturalEnd = previousDay(addMonths(start, rule.periodMonths));
    const end = rule.effectiveTo && naturalEnd > rule.effectiveTo ? rule.effectiveTo : naturalEnd;
    if (end >= rule.effectiveFrom) {
      periods.push({ key: `${start}:${end}`, start, end, state: end < today ? "completed" : start <= today ? "current" : "upcoming" });
    }
    start = addMonths(start, rule.periodMonths);
  }
  return periods;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const requestedAsOfDate = url.searchParams.get("asOfDate");
    if (requestedAsOfDate !== null && !isTodDate(requestedAsOfDate)) return jsonWithCors(request, { error: "Invalid asOfDate." }, { status: 400 });
    const asOfDate = requestedAsOfDate ?? today;
    const period = requestedTodPeriod({ periodStart: url.searchParams.get("periodStart") ?? undefined, periodEnd: url.searchParams.get("periodEnd") ?? undefined });
    const selectedSchemeVersionId = url.searchParams.get("selectedSchemeVersionId") ?? undefined;
    if (selectedSchemeVersionId !== undefined && !isUuid(selectedSchemeVersionId)) return jsonWithCors(request, { error: "Invalid rule version." }, { status: 400 });
    const syntheticRun: EvaluationRunRecord = {
      id: "local-preview",
      company_id: company.id,
      requested_by: null,
      request_context: { schemeType: "tod", batch: true, asOfDate, evaluatedOn: today, ...(period ? { periodStart: period.start, periodEnd: period.end } : {}), ...(selectedSchemeVersionId ? { selectedSchemeVersionId } : {}) },
      tally_master_refresh_run_id: null,
      tally_voucher_refresh_run_id: null,
    };
    const bootstrap = await loadLiveTodLocalBootstrap(syntheticRun);
    const activeRule = bootstrap.activeRule;
    const activeSchemeVersionId = activeRule?.id ?? null;
    return jsonWithCors(request, {
      evaluatedOn: bootstrap.evaluatedOn,
      expectedCompany: { name: company.tally_company_name, guid: company.tally_company_guid },
      activeSchemeVersionId,
      periodStart: bootstrap.period.start,
      periodEnd: bootstrap.period.end,
      periods: activeRule ? rulePeriods(activeRule, today) : [],
      batches: bootstrap.batches.map((batch) => ({
        ...batch,
        voucherScope: { ...batch.voucherScope, evaluationRunId: null },
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TodPeriodError) return jsonWithCors(request, { error: error.message }, { status: 422 });
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    if (error instanceof Error && /^(No active Turnover Discount rule|More than one active Turnover Discount rule|The active Turnover Discount rule)/.test(error.message)) {
      return jsonWithCors(request, { error: error.message }, { status: 422 });
    }
    console.error("Could not prepare the local Turnover Discount calculation:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not prepare the local Turnover Discount calculation." }, { status: 500 });
  }
}
