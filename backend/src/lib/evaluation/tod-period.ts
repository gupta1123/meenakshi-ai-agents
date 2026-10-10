import { addCalendarMonths, previousCalendarDay } from "./calendar";

export class TodPeriodError extends Error {}
export type TodPeriod = { start: string; end: string };
type PeriodRule = { periodAnchorDate: string; periodMonths: number; effectiveTo: string | null };

export function isTodDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function requestedTodPeriod(context: { periodStart?: unknown; periodEnd?: unknown }): TodPeriod | null {
  if (context.periodStart === undefined && context.periodEnd === undefined) return null;
  if (!isTodDate(context.periodStart) || !isTodDate(context.periodEnd) || context.periodStart > context.periodEnd) {
    throw new TodPeriodError("Choose a valid Turnover Discount period with both start and end dates.");
  }
  return { start: context.periodStart, end: context.periodEnd };
}

export function resolveTodPeriod(rule: PeriodRule, asOfDate: string, requested: TodPeriod | null = null): TodPeriod {
  if (!isTodDate(asOfDate) || asOfDate < rule.periodAnchorDate) throw new TodPeriodError("The active Turnover Discount rule has not started yet.");
  let start = rule.periodAnchorDate;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const naturalEnd = previousCalendarDay(addCalendarMonths(start, rule.periodMonths));
    const end = rule.effectiveTo && naturalEnd > rule.effectiveTo ? rule.effectiveTo : naturalEnd;
    if (start <= asOfDate && asOfDate <= end) {
      if (requested && (requested.start !== start || requested.end !== end)) {
        throw new TodPeriodError("The selected Turnover Discount period no longer matches the current rule. Reload the periods and select again.");
      }
      return { start, end };
    }
    if (rule.effectiveTo && end >= rule.effectiveTo) break;
    start = addCalendarMonths(start, rule.periodMonths);
  }
  throw new TodPeriodError("No Turnover Discount period covers the selected date.");
}

export function assertTodEvidencePeriod(period: TodPeriod, evidence: { periodStart?: unknown; periodEnd?: unknown }) {
  if (evidence.periodStart !== period.start || evidence.periodEnd !== period.end) {
    throw new TodPeriodError("The Tally result belongs to a different Turnover Discount period. Nothing was saved; calculate the selected period again.");
  }
}

export function validateTodBatchEvidence<T extends { customerId: string; schemeVersionId?: string; periodStart?: string; periodEnd?: string }>(
  period: TodPeriod,
  evidence: { periodStart: string; periodEnd: string; customerAggregates: T[] },
  versionByCustomer: Map<string, string>,
) {
  assertTodEvidencePeriod(period, evidence);
  const seen = new Set<string>();
  const aggregates = evidence.customerAggregates.map((aggregate) => {
    const versionId = versionByCustomer.get(aggregate.customerId);
    if (!versionId || seen.has(aggregate.customerId)) throw new TodPeriodError("The Tally result contains an unexpected or duplicate customer. Calculate again; nothing was saved.");
    seen.add(aggregate.customerId);
    assertTodEvidencePeriod(period, { periodStart: aggregate.periodStart ?? evidence.periodStart, periodEnd: aggregate.periodEnd ?? evidence.periodEnd });
    if (aggregate.schemeVersionId !== undefined && aggregate.schemeVersionId !== versionId) throw new TodPeriodError("The customer's locked rule changed after the Tally read. Calculate again; nothing was saved.");
    return { ...aggregate, periodStart: period.start, periodEnd: period.end, schemeVersionId: versionId };
  });
  if (seen.size !== versionByCustomer.size) throw new TodPeriodError("The Tally result is incomplete. Calculate again before saving customer results.");
  return aggregates;
}
