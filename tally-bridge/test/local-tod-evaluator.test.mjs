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
