import assert from "node:assert/strict";
import test from "node:test";

import { evaluateLocalTurnoverDiscount } from "../src/local-tod-evaluator.mjs";

const rule = {
  id: "rule-1", companyId: "company-1", roundingScale: 2, roundingMethod: "half_up",
  tiers: [
    { id: "tier-1", minimumTonnes: "10", percentage: "1" },
    { id: "tier-2", minimumTonnes: "20", percentage: "1.5" },
  ],
  reviewCalendar: { nonWorkingIsoWeekdays: [7], activeHolidayDates: [] },
};

test("local TOD calculation selects the highest achieved tier and rounds the discount", () => {
  const result = evaluateLocalTurnoverDiscount(rule, "2026-09-01", "2026-08-01", "2026-08-31", [{
    customerId: "customer-1", customerLedgerName: "Demo Customer", eligibleTaxableValue: "99000", eligibleTonnes: "25",
    missingUnits: [],
  }]);
  assert.equal(result.rows[0].achievedTierId, "tier-2");
  assert.equal(result.rows[0].calculatedDiscountAmount, "1485.00");
  assert.equal(result.rows[0].status, "eligible");
});

test("local TOD calculation keeps an in-period result tracking and flags missing conversions", () => {
  const tracking = evaluateLocalTurnoverDiscount(rule, "2026-08-20", "2026-08-01", "2026-08-31", [{
    customerId: "customer-1", customerLedgerName: "Demo Customer", eligibleTaxableValue: "99000", eligibleTonnes: "12", missingUnits: [],
  }]);
  assert.equal(tracking.rows[0].status, "tracking");
  const review = evaluateLocalTurnoverDiscount(rule, "2026-09-01", "2026-08-01", "2026-08-31", [{
    customerId: "customer-1", customerLedgerName: "Demo Customer", eligibleTaxableValue: "99000", eligibleTonnes: "12", missingUnits: ["BAG"],
  }]);
  assert.equal(review.rows[0].status, "needs_review");
  assert.deepEqual(review.rows[0].reasonCodes, ["approved_conversion_missing"]);
});

test("local TOD calculation applies the reached per-tonne rate to the full eligible quantity", () => {
  const perTonneRule = {
    ...rule,
    todBenefitBasis: "amount_per_eligible_tonne",
    tiers: [
      { id: "tier-30", minimumTonnes: "30", percentage: null, amountPerTonne: "250" },
      { id: "tier-50", minimumTonnes: "50", percentage: null, amountPerTonne: "350" },
    ],
  };
  const result = evaluateLocalTurnoverDiscount(perTonneRule, "2026-09-22", "2026-08-01", "2026-10-31", [{
    customerId: "customer-1", customerLedgerName: "Demo Customer", eligibleTaxableValue: "99000", eligibleTonnes: "72",
    missingUnits: [],
  }]);
  assert.equal(result.rows[0].achievedTierId, "tier-50");
  assert.equal(result.rows[0].discountPercentage, null);
  assert.equal(result.rows[0].calculatedDiscountAmount, "25200.00");
  assert.equal(result.rows[0].status, "tracking");
});
