import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireCurrentCheckPage } from "@/lib/check-page";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { loadLiveTodLocalBootstrap, type EvaluationRunRecord } from "@/lib/evaluation/evidence";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function validDate(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

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

// Preparing the batches reads every customer's invoices, so a repeat visit within
// a minute reuses the last result (and one load is shared by simultaneous calls).
const bootstrapCache = new Map<string, { expiresAt: number; pending: Promise<Awaited<ReturnType<typeof loadLiveTodLocalBootstrap>>> }>();

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    await requireCurrentCheckPage(request, company.id);
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const requestedAsOfDate = url.searchParams.get("asOfDate");
    const asOfDate = validDate(requestedAsOfDate) ? requestedAsOfDate : today;
    const syntheticRun: EvaluationRunRecord = {
      id: "local-preview",
      company_id: company.id,
      requested_by: null,
      request_context: { schemeType: "tod", batch: true, asOfDate, evaluatedOn: today },
      tally_master_refresh_run_id: null,
      tally_voucher_refresh_run_id: null,
    };
    const cacheKey = `${company.id}:${asOfDate}:${today}`;
    let entry = bootstrapCache.get(cacheKey);
    if (!entry || entry.expiresAt < Date.now() || url.searchParams.get("fresh") === "1") {
      const pending = loadLiveTodLocalBootstrap(syntheticRun);
      entry = { expiresAt: Date.now() + 60_000, pending };
      bootstrapCache.set(cacheKey, entry);
      pending.catch(() => { if (bootstrapCache.get(cacheKey)?.pending === pending) bootstrapCache.delete(cacheKey); });
      if (bootstrapCache.size > 20) bootstrapCache.delete(bootstrapCache.keys().next().value as string);
    }
    const bootstrap = await entry.pending;
    const activeRule = [...bootstrap.batches].sort((left, right) => right.rule.versionNumber - left.rule.versionNumber)[0]?.rule ?? null;
    const activeSchemeVersionId = activeRule?.id ?? null;
    // A capped list of recent customers cannot tell whether an older period
    // has saved results. Check each period's durable records directly.
    const db = createSupabaseAdminClient();
    const periods = await Promise.all((activeRule ? rulePeriods(activeRule, today) : []).map(async (period) => {
      if (period.state === "upcoming") return { ...period, calculated: false };
      const { data, error } = await db.from("discount_proposals").select("id")
        .eq("company_id", company.id).eq("scheme_version_id", activeSchemeVersionId!)
        .eq("period_start", period.start).eq("period_end", period.end)
        .neq("status", "not_in_scheme").not("latest_evaluated_at", "is", null).limit(1);
      if (error) throw error;
      return { ...period, calculated: Boolean(data?.length) };
    }));
    return jsonWithCors(request, {
      evaluatedOn: bootstrap.evaluatedOn,
      expectedCompany: { name: company.tally_company_name, guid: company.tally_company_guid, booksFrom: company.tally_books_from ?? null },
      activeSchemeVersionId,
      periods,
      batches: bootstrap.batches.map((batch) => ({
        ...batch,
        voucherScope: { ...batch.voucherScope, evaluationRunId: null },
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    if (error instanceof Error && /^(No active Turnover Discount rule|More than one active Turnover Discount rule|The active Turnover Discount rule)/.test(error.message)) {
      return jsonWithCors(request, { error: error.message }, { status: 422 });
    }
    console.error("Could not prepare the local Turnover Discount calculation:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not prepare the local Turnover Discount calculation." }, { status: 500 });
  }
}
