import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

function decimal(value) { return new Decimal(String(value ?? "0")); }
function nonNegative(value) { return Decimal.max(decimal(0), decimal(value)); }
function quantity(value) { return decimal(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6); }
function roundingMode(method) {
  if (method === "half_even") return Decimal.ROUND_HALF_EVEN;
  if (method === "truncate") return Decimal.ROUND_DOWN;
  return Decimal.ROUND_HALF_UP;
}
function money(value, scale, method) { return decimal(value).toDecimalPlaces(scale, roundingMode(method)).toFixed(scale); }

function firstWorkingDayAfter(calendar, value) {
  if (!calendar) return null;
  const holidays = new Set(calendar.activeHolidayDates ?? []);
  const nonWorking = new Set(calendar.nonWorkingIsoWeekdays ?? []);
  const cursor = new Date(`${value}T00:00:00.000Z`);
  for (let guard = 0; guard < 3_000; guard += 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const date = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay() || 7;
    if (!holidays.has(date) && !nonWorking.has(weekday)) return date;
  }
  throw new Error("Could not find the Turnover Discount review date.");
}

// This is the same deterministic tier calculation used by the backend. The
// browser receives these rows immediately; the submitted evidence is still
// recalculated and persisted by the backend workers for the audit trail.
export function evaluateLocalTurnoverDiscount(rule, evaluatedOn, periodStart, periodEnd, aggregates) {
  const orderedTiers = [...(rule.tiers ?? [])].sort((left, right) => decimal(left.minimumTonnes).comparedTo(decimal(right.minimumTonnes)));
  const reviewOpenDate = firstWorkingDayAfter(rule.reviewCalendar, periodEnd);
  const rows = aggregates.map((aggregate) => {
    const eligibleTaxableValue = nonNegative(aggregate.eligibleTaxableValue);
    const eligibleTonnes = nonNegative(aggregate.eligibleTonnes);
    const achievedTier = orderedTiers.filter((tier) => eligibleTonnes.greaterThanOrEqualTo(tier.minimumTonnes)).at(-1) ?? null;
    const nextTier = orderedTiers.find((tier) => decimal(tier.minimumTonnes).greaterThan(eligibleTonnes)) ?? null;
    const missingUnits = Array.isArray(aggregate.missingUnits) ? aggregate.missingUnits : [];
    const status = missingUnits.length || !reviewOpenDate ? "needs_review" : evaluatedOn < reviewOpenDate ? "tracking" : achievedTier ? "eligible" : "tracking";
    const calculatedDiscount = achievedTier ? eligibleTaxableValue.mul(achievedTier.percentage).div(100) : decimal(0);
    return {
      customerId: aggregate.customerId,
      customerName: aggregate.customerLedgerName,
      periodStart,
      periodEnd,
      schemeVersionId: rule.id,
      entitlementKey: `tod:${rule.companyId}:${aggregate.customerId}:${periodStart}:${periodEnd}:${rule.id}`,
      eligibleProductTaxableValue: money(eligibleTaxableValue, rule.roundingScale, rule.roundingMethod),
      eligibleTonnes: quantity(eligibleTonnes),
      achievedTierId: achievedTier?.id ?? null,
      nextTierTonnes: nextTier ? quantity(nextTier.minimumTonnes) : null,
      additionalTonnesRequired: nextTier ? quantity(nonNegative(decimal(nextTier.minimumTonnes).minus(eligibleTonnes))) : null,
      discountPercentage: achievedTier?.percentage ?? null,
      calculatedDiscountAmount: money(calculatedDiscount, rule.roundingScale, rule.roundingMethod),
      eligibilityDeadline: reviewOpenDate,
      status,
      reasonCodes: [...(missingUnits.length ? ["approved_conversion_missing"] : []), ...(!achievedTier ? ["tier_not_achieved"] : [])],
    };
  });
  return {
    rows,
    totals: {
      customersChecked: rows.length,
      qualified: rows.filter((row) => Boolean(row.achievedTierId)).length,
      needAttention: rows.filter((row) => row.status === "needs_review").length,
      projectedDiscount: money(rows.reduce((total, row) => total.plus(row.calculatedDiscountAmount), decimal(0)), rule.roundingScale, rule.roundingMethod),
    },
  };
}
