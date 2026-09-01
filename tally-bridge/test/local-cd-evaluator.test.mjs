import assert from "node:assert/strict";
import test from "node:test";

import { evaluateLocalCashDiscount } from "../src/local-cd-evaluator.mjs";

const rule = {
  slabs: [{ id: "one", allowedWorkingDays: 7, percentage: "1" }],
  checkNarration: false,
  narrationMode: "disabled",
  calendar: { nonWorkingIsoWeekdays: [7], activeHolidayDates: [] },
};

test("local CD calculation reverses a discount already included in the invoice", () => {
  const result = evaluateLocalCashDiscount(rule, "2026-08-20", [{
    customerId: "customer-1", customerLedgerName: "Demo Customer", sourceSalesLedgerName: "Sales",
    tallyGuid: "invoice-1", voucherNumber: "INV-1", billReferences: ["INV-1"], voucherDate: "2026-08-01",
    grossAmount: "99000", eligibleValue: "99000", narration: "", inventoryLineCount: 0, payments: [], debitNotes: [],
  }]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].impliedGrossAmount, "100000.0000");
  assert.equal(result.rows[0].remainingRecovery, "1000.0000");
  assert.deepEqual(result.results.map((row) => [row.invoiceGuid, row.status]), [["invoice-1", "recovery_due"]]);
});

test("local CD calculation keeps a retained invoice in the result list", () => {
  const result = evaluateLocalCashDiscount(rule, "2026-08-08", [{
    customerId: "customer-1", customerLedgerName: "Demo Customer", sourceSalesLedgerName: "Sales",
    tallyGuid: "invoice-retained", voucherNumber: "INV-2", billReferences: ["INV-2"], voucherDate: "2026-08-01",
    grossAmount: "990", eligibleValue: "990", narration: "", inventoryLineCount: 0,
    payments: [{ receiptGuid: "receipt-1", receiptDate: "2026-08-05", allocationType: "agst_ref", allocatedAmount: "990" }], debitNotes: [],
  }]);
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.results.map((row) => [row.invoiceGuid, row.status, row.earnedDiscountPercentage]), [["invoice-retained", "retained", "1.0000"]]);
});
