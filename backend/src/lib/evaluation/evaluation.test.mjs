import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCd, evaluateTod } from "./evaluate.ts";
import { workingDayBreakdown } from "./calendar.ts";
import { parseCashDiscountNarration } from "./cash-discount-narration.ts";
import { evaluateLiveCdInvoices } from "./live-cd.ts";

const calendar = { id: "calendar-1", revision: 3, nonWorkingIsoWeekdays: [7], activeHolidayDates: [] };
const customer = {
  id: "customer-1", tallyLedgerGuid: "ledger-guid", ledgerName: "Demo customer", isAvailable: true, currentCustomerGroupId: "group-1",
  groupPath: [{ customerId: "customer-1", customerGroupId: "group-1", groupName: "Retail", tallyGuid: "group-guid", isAvailable: true, parentGroupId: null }],
};
const sale = {
  id: "sale-1", tallyGuid: "sale-guid", tallyMasterId: "1", tallyAlterId: "2", voucherNumber: "S-100", voucherKind: "sales", voucherDate: "2026-08-05", status: "posted",
  partyCustomerId: "customer-1", linkedSalesVoucherId: null, taxableProductValue: "800", grossAmount: "1000", sourceSnapshot: {},
};

test("CD counts Day 0 separately and retains the included discount only after full payment", () => {
  const days = workingDayBreakdown(calendar, "2026-08-05", 2);
  assert.equal(days[0].exclusionReason, "invoice_day_zero");
  assert.equal(days.at(-1)?.businessDate, "2026-08-07");
  const result = evaluateCd({
    rule: {
      id: "cd-v1", schemeId: "cd-scheme", companyId: "company-1", schemeType: "cd", versionNumber: 1, effectiveFrom: "2026-01-01", effectiveTo: null,
      roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, discountPercentage: "10", allowedWorkingDays: 2, nearEligibilityPercent: "80", invoiceTreatment: "after_qualification", narrationMode: "informational", calendar,
    },
    customer, salesVoucher: sale,
    inventoryLines: [{ id: "line-1", voucherId: "sale-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "1", taxableProductValue: "800", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} }],
    paymentAllocations: [
      { id: "allocation-1", sourceVoucherId: "receipt-1", targetVoucherId: "sale-1", targetReference: "S-100", allocationType: "agst_ref", allocatedAmount: "800", receiptVoucherDate: "2026-08-07", receiptVoucherStatus: "posted", sourceSnapshot: {} },
      { id: "allocation-2", sourceVoucherId: "receipt-1", targetVoucherId: "sale-1", targetReference: "S-100", allocationType: "agst_ref", allocatedAmount: "120", receiptVoucherDate: "2026-08-07", receiptVoucherStatus: "posted", sourceSnapshot: {} },
    ],
    existingCreditNotes: [], evaluatedOn: "2026-08-07",
  });
  assert.equal(result.proposal?.discountedSettlementTarget, "1000.0000");
  assert.equal(result.proposal?.amountPaidByDeadline, "920.0000");
  assert.equal(result.proposal?.status, "near_eligibility");
  assert.equal(result.proposal?.recommendedAction, "send_shortfall_reminder");
  assert.equal(result.evaluation.sourceVouchers.filter((item) => item.contributionType === "payment_evidence").length, 1, "one receipt yields one immutable source-voucher row");
});

test("CD recommends a shortfall reminder for an open invoice even below the 80% threshold", () => {
  const result = evaluateCd({
    rule: {
      id: "cd-v1", schemeId: "cd-scheme", companyId: "company-1", schemeType: "cd", versionNumber: 1, effectiveFrom: "2026-01-01", effectiveTo: null,
      roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, discountPercentage: "10", allowedWorkingDays: 2, nearEligibilityPercent: "80", invoiceTreatment: "after_qualification", narrationMode: "informational", calendar,
    },
    customer, salesVoucher: sale,
    inventoryLines: [{ id: "line-1", voucherId: "sale-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "1", taxableProductValue: "800", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} }],
    paymentAllocations: [], existingCreditNotes: [], evaluatedOn: "2026-08-06",
  });
  assert.equal(result.proposal?.status, "unpaid");
  assert.equal(result.proposal?.recommendedAction, "send_shortfall_reminder");
});

test("CD does not recreate an entitlement when its verified Credit Note has no Tally invoice-link field", () => {
  const result = evaluateCd({
    rule: {
      id: "cd-v1", schemeId: "cd-scheme", companyId: "company-1", schemeType: "cd", versionNumber: 1, effectiveFrom: "2026-01-01", effectiveTo: null,
      roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, discountPercentage: "10", allowedWorkingDays: 2, nearEligibilityPercent: "80", invoiceTreatment: "after_qualification", narrationMode: "informational", calendar,
    },
    customer, salesVoucher: sale,
    inventoryLines: [{ id: "line-1", voucherId: "sale-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "1", taxableProductValue: "800", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} }],
    paymentAllocations: [],
    existingCreditNotes: [{
      id: "credit-note-1", tallyGuid: "credit-guid", tallyMasterId: "3", tallyAlterId: "4", voucherNumber: "CN-1", voucherKind: "credit_note", voucherDate: "2026-08-08", status: "posted",
      partyCustomerId: "customer-1", linkedSalesVoucherId: null, taxableProductValue: "0", grossAmount: "80", sourceSnapshot: {}, verifiedForProposal: true,
    }],
    evaluatedOn: "2026-08-08",
  });
  assert.equal(result.proposal?.status, "already_credited");
});

test("CD narration parser reads percentage and working-day terms", () => {
  assert.deepEqual(parseCashDiscountNarration("Cash Discount 1.5% within 7 working days"), {
    mentioned: true,
    percentage: 1.5,
    allowedDays: 7,
    dayType: "working_days",
    confidence: "high",
    sourceText: "Cash Discount 1.5% within 7 working days",
  });
});

test("CD requires Finance review when strict narration conflicts with the approved group rule", () => {
  const result = evaluateCd({
    rule: {
      id: "cd-v1", schemeId: "cd-scheme", companyId: "company-1", schemeType: "cd", versionNumber: 1, effectiveFrom: "2026-01-01", effectiveTo: null,
      roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, discountPercentage: "10", allowedWorkingDays: 2, nearEligibilityPercent: "80", invoiceTreatment: "after_qualification", narrationMode: "required", calendar,
    },
    customer,
    salesVoucher: { ...sale, sourceSnapshot: { narration: "CD 5% within 4 calendar days" } },
    inventoryLines: [{ id: "line-1", voucherId: "sale-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "1", taxableProductValue: "800", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} }],
    paymentAllocations: [], existingCreditNotes: [], evaluatedOn: "2026-08-08",
  });
  assert.equal(result.proposal?.status, "needs_review");
  assert.equal(result.proposal?.recommendedAction, "finance_review");
  assert.ok(result.proposal?.reasonCodes.includes("cash_discount_narration_conflict"));
});

test("CD recommends Debit Note recovery only for an upfront discount after the deadline", () => {
  const result = evaluateCd({
    rule: {
      id: "cd-v1", schemeId: "cd-scheme", companyId: "company-1", schemeType: "cd", versionNumber: 1, effectiveFrom: "2026-01-01", effectiveTo: null,
      roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, discountPercentage: "10", allowedWorkingDays: 2, nearEligibilityPercent: "80", invoiceTreatment: "deducted_upfront", narrationMode: "disabled", calendar,
    },
    customer, salesVoucher: sale,
    inventoryLines: [{ id: "line-1", voucherId: "sale-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "1", taxableProductValue: "800", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} }],
    paymentAllocations: [], existingCreditNotes: [], evaluatedOn: "2026-08-08",
  });
  assert.equal(result.proposal?.status, "deadline_expired");
  assert.equal(result.proposal?.recommendedAction, "debit_note");
});

test("live CD treats the invoice as already discounted and never creates another Credit Note", () => {
  const rule = {
    id: "cd-live-v1", schemeId: "cd-live", companyId: "company-1", schemeType: "cd", versionNumber: 1, effectiveFrom: "2026-01-01", effectiveTo: null,
    roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, nearEligibilityPercent: "80", checkNarration: true, narrationMode: "informational", calendar,
    slabs: [{ id: "slab-1", allowedWorkingDays: 7, percentage: "1.5" }, { id: "slab-2", allowedWorkingDays: 15, percentage: "1" }],
  };
  const invoice = (overrides = {}) => ({
    customerId: "customer-1", customerLedgerName: "Demo customer", sourceSalesLedgerName: "Sales", tallyGuid: "invoice-guid", voucherNumber: "CD-1", billReferences: ["CD-1"], voucherDate: "2026-08-05",
    grossAmount: "985", eligibleValue: "985", narration: "Cash Discount 1.5% within 7 working days", inventoryLineCount: 1, payments: [], debitNotes: [], ...overrides,
  });
  const payment = (allocatedAmount, receiptDate) => ({ receiptGuid: `receipt-${allocatedAmount}`, receiptNumber: "R-1", receiptDate, billReference: "CD-1", targetVoucherGuid: null, allocationType: "agst_ref", allocatedAmount });

  const result = evaluateLiveCdInvoices(rule, "2026-08-25", [
    invoice({ tallyGuid: "within-seven", payments: [payment("985", "2026-08-10")] }),
    invoice({ tallyGuid: "second-window", payments: [payment("985", "2026-08-18")] }),
    invoice({ tallyGuid: "final-missed" }),
    invoice({ tallyGuid: "part-recovered", debitNotes: [{ tallyGuid: "dn-1", voucherNumber: "DN-1", voucherDate: "2026-08-20", customerLedgerName: "Demo customer", status: "posted", billReference: "CD-1", targetVoucherGuid: null, amount: "5", narration: "recovery" }] }),
  ]);

  assert.equal(result.rows.length, 3, "paid within the first window is hidden");
  assert.deepEqual(result.rows.map((row) => row.remainingRecovery), ["5.0000", "15.0000", "10.0000"]);
  assert.deepEqual(result.rows.map((row) => row.missedWindowWorkingDays), [7, 15, 15]);
  assert.deepEqual(result.rows.map((row) => row.nextWindowWorkingDays), [null, null, null]);
  assert.ok(result.rows.every((row) => row.status === "action_required"));
  assert.deepEqual(result.results.map((row) => [row.invoiceGuid, row.status]), [
    ["within-seven", "retained"],
    ["second-window", "recovery_due"],
    ["final-missed", "recovery_due"],
    ["part-recovered", "recovery_due"],
  ]);
  assert.deepEqual(result.totals, { invoicesChecked: 4, actionRequired: 3, reviewRequired: 0, recoveryAmount: "30.0000", alreadyRecovered: "5.0000", openReminderReady: 0, openReminderReview: 0 });
});

test("live CD lists every open invoice before the final deadline as a reminder candidate", () => {
  const result = evaluateLiveCdInvoices({
    id: "cd-live-v1", schemeId: "cd-live", companyId: "company-1", schemeType: "cd", versionNumber: 1,
    effectiveFrom: "2026-01-01", effectiveTo: null, roundingMethod: "half_up", roundingScale: 2,
    selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, nearEligibilityPercent: "80",
    checkNarration: false, narrationMode: "off", calendar,
    slabs: [{ id: "slab-1", allowedWorkingDays: 7, percentage: "1.5" }],
  }, "2026-08-06", [{
    customerId: "customer-1", customerLedgerName: "Demo customer", sourceSalesLedgerName: "Sales", tallyGuid: "invoice-open", voucherNumber: "CD-OPEN",
    billReferences: ["CD-OPEN"], voucherDate: "2026-08-05", grossAmount: "1000", eligibleValue: "1000", narration: "",
    inventoryLineCount: 1, payments: [], debitNotes: [],
  }]);
  assert.equal(result.reminders.length, 1);
  assert.equal(result.reminders[0]?.status, "ready");
  assert.equal(result.reminders[0]?.shortfallAmount, "1000.0000");
  assert.equal(result.totals.openReminderReady, 1);
});

test("live CD shows the remaining lower discount window while payment can still qualify", () => {
  const result = evaluateLiveCdInvoices({
    id: "cd-live-v1", schemeId: "cd-live", companyId: "company-1", schemeType: "cd", versionNumber: 1,
    effectiveFrom: "2026-01-01", effectiveTo: null, roundingMethod: "half_up", roundingScale: 2,
    selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, nearEligibilityPercent: "80",
    checkNarration: false, narrationMode: "off", calendar,
    slabs: [{ id: "slab-1", allowedWorkingDays: 7, percentage: "1.5" }, { id: "slab-2", allowedWorkingDays: 15, percentage: "1" }],
  }, "2026-08-14", [{
    customerId: "customer-1", customerLedgerName: "Demo customer", sourceSalesLedgerName: "Sales", tallyGuid: "invoice-guid", voucherNumber: "CD-1",
    billReferences: ["CD-1"], voucherDate: "2026-08-05", grossAmount: "985", eligibleValue: "985", narration: "",
    inventoryLineCount: 1, payments: [], debitNotes: [],
  }]);
  assert.equal(result.rows[0]?.missedWindowWorkingDays, 7);
  assert.equal(result.rows[0]?.nextWindowWorkingDays, 15);
  assert.equal(result.rows[0]?.remainingRecovery, "5.0000");
});

test("live CD derives a one-percent recovery from an already-discounted 99000 bill", () => {
  const result = evaluateLiveCdInvoices({
    id: "cd-live-v1", schemeId: "cd-live", companyId: "company-1", schemeType: "cd", versionNumber: 1,
    effectiveFrom: "2026-01-01", effectiveTo: null, roundingMethod: "half_up", roundingScale: 2,
    selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, nearEligibilityPercent: "80",
    checkNarration: false, narrationMode: "off", calendar,
    slabs: [{ id: "slab-1", allowedWorkingDays: 7, percentage: "1" }],
  }, "2026-08-25", [{
    customerId: "customer-1", customerLedgerName: "Demo customer", sourceSalesLedgerName: "Sales",
    tallyGuid: "invoice-guid-99000", voucherNumber: "CD-99000", billReferences: ["CD-99000"],
    voucherDate: "2026-08-05", grossAmount: "99000", eligibleValue: "99000", narration: "",
    inventoryLineCount: 0, payments: [], debitNotes: [],
  }]);
  assert.equal(result.rows[0]?.impliedGrossAmount, "100000.0000");
  assert.equal(result.rows[0]?.remainingRecovery, "1000.0000");
});

test("live CD sends an over-recovered invoice to review instead of posting another Debit Note", () => {
  const result = evaluateLiveCdInvoices({
    id: "cd-live-v1", schemeId: "cd-live", companyId: "company-1", schemeType: "cd", versionNumber: 1,
    effectiveFrom: "2026-01-01", effectiveTo: null, roundingMethod: "half_up", roundingScale: 2,
    selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, nearEligibilityPercent: "80",
    checkNarration: false, narrationMode: "off", calendar,
    slabs: [{ id: "slab-1", allowedWorkingDays: 7, percentage: "1.5" }, { id: "slab-2", allowedWorkingDays: 15, percentage: "1" }],
  }, "2026-08-25", [{
    customerId: "customer-1", customerLedgerName: "Demo customer", sourceSalesLedgerName: "Sales", tallyGuid: "invoice-guid", voucherNumber: "CD-1",
    billReferences: ["CD-1"], voucherDate: "2026-08-05", grossAmount: "985", eligibleValue: "985", narration: "",
    inventoryLineCount: 1,
    payments: [{ receiptGuid: "receipt-1", receiptNumber: "R-1", receiptDate: "2026-08-10", billReference: "CD-1", targetVoucherGuid: null, allocationType: "agst_ref", allocatedAmount: "985" }],
    debitNotes: [{ tallyGuid: "dn-1", voucherNumber: "DN-1", voucherDate: "2026-08-20", customerLedgerName: "Demo customer", status: "posted", billReference: "CD-1", targetVoucherGuid: null, amount: "5", narration: "recovery" }],
  }]);
  assert.equal(result.rows[0]?.status, "review_required");
  assert.equal(result.rows[0]?.reasonCode, "existing_debit_note_exceeds_recovery");
  assert.equal(result.totals.reviewRequired, 1);
});

test("live CD requires the original Sales ledger before allowing a Debit Note", () => {
  const result = evaluateLiveCdInvoices({
    id: "cd-live-v1", schemeId: "cd-live", companyId: "company-1", schemeType: "cd", versionNumber: 1,
    effectiveFrom: "2026-01-01", effectiveTo: null, roundingMethod: "half_up", roundingScale: 2,
    selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, nearEligibilityPercent: "80",
    checkNarration: false, narrationMode: "off", calendar,
    slabs: [{ id: "slab-1", allowedWorkingDays: 7, percentage: "1.5" }],
  }, "2026-08-25", [{
    customerId: "customer-1", customerLedgerName: "Demo customer", sourceSalesLedgerName: null,
    tallyGuid: "invoice-guid", voucherNumber: "CD-1", billReferences: ["CD-1"], voucherDate: "2026-08-05",
    grossAmount: "985", eligibleValue: "985", narration: "", inventoryLineCount: 1, payments: [], debitNotes: [],
  }]);
  assert.equal(result.rows[0]?.status, "review_required");
  assert.equal(result.rows[0]?.reasonCode, "source_sales_ledger_unavailable");
  assert.equal(result.totals.actionRequired, 0);
});

test("TOD nets returns, uses approved UOM conversion, and applies the highest tier to the full eligible value", () => {
  const result = evaluateTod({
    rule: {
      id: "tod-v1", schemeId: "tod-scheme", companyId: "company-1", schemeType: "tod", versionNumber: 1, effectiveFrom: "2026-01-01", effectiveTo: null,
      roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, periodAnchorDate: "2026-08-01", periodMonths: 1,
      selectedStockItemIds: [], selectedStockGroupIds: ["stock-group-1"], unitConversions: [{ id: "conversion-1", sourceUomId: "uom-1", tonnesPerUnit: "1" }],
      tiers: [{ id: "tier-1", minimumTonnes: "1", percentage: "5" }, { id: "tier-2", minimumTonnes: "2", percentage: "10" }], reviewCalendar: calendar,
    },
    customer, periodStart: "2026-08-01", periodEnd: "2026-08-31", evaluatedOn: "2026-09-01",
    vouchers: [
      { ...sale, voucherDate: "2026-08-10", taxableProductValue: "200", grossAmount: "200" },
      { id: "return-1", tallyGuid: "return-guid", tallyMasterId: "3", tallyAlterId: "4", voucherNumber: "R-1", voucherKind: "sales_return", voucherDate: "2026-08-15", status: "posted", partyCustomerId: "customer-1", linkedSalesVoucherId: "sale-1", taxableProductValue: "50", grossAmount: "50", sourceSnapshot: {} },
    ],
    inventoryLines: [
      { id: "tod-sale-line", voucherId: "sale-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "2.5", taxableProductValue: "200", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} },
      { id: "tod-return-line", voucherId: "return-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "0.5", taxableProductValue: "50", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} },
    ],
    existingCreditNotes: [], priorPeriodAdjustments: [],
  });
  assert.equal(result.proposal?.eligibleTonnes, "2.000000");
  assert.equal(result.proposal?.eligibleProductTaxableValue, "150.00");
  assert.equal(result.proposal?.discountPercentage, "10");
  assert.equal(result.proposal?.calculatedDiscountAmount, "15.00");
  assert.equal(result.proposal?.status, "eligible");
});

test("TOD preserves an already locked customer period after a later group change", () => {
  const result = evaluateTod({
    rule: {
      id: "tod-v1", schemeId: "tod-scheme", companyId: "company-1", schemeType: "tod", versionNumber: 1, effectiveFrom: "2026-01-01", effectiveTo: null,
      roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, periodAnchorDate: "2026-08-01", periodMonths: 1,
      selectedStockItemIds: [], selectedStockGroupIds: ["stock-group-1"], unitConversions: [{ id: "conversion-1", sourceUomId: "uom-1", tonnesPerUnit: "1" }],
      tiers: [{ id: "tier-1", minimumTonnes: "1", percentage: "5" }], reviewCalendar: calendar,
    },
    customer: { ...customer, currentCustomerGroupId: "moved-group", groupPath: [{ ...customer.groupPath[0], customerGroupId: "moved-group" }] },
    periodStart: "2026-08-01", periodEnd: "2026-08-31", evaluatedOn: "2026-08-15", lockedPeriod: true,
    vouchers: [{ ...sale, voucherDate: "2026-08-10", taxableProductValue: "200", grossAmount: "200" }],
    inventoryLines: [{ id: "tod-sale-line", voucherId: "sale-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "2", taxableProductValue: "200", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} }],
    existingCreditNotes: [], priorPeriodAdjustments: [],
  });
  assert.equal(result.proposal?.status, "tracking");
  assert.equal(result.proposal?.achievedTierId, "tier-1");
});

test("TOD labels a late linked return as a prior-period adjustment without counting it twice", () => {
  const lateReturn = { id: "late-return-1", tallyGuid: "late-return-guid", tallyMasterId: "5", tallyAlterId: "6", voucherNumber: "R-2", voucherKind: "sales_return", voucherDate: "2026-09-04", status: "posted", partyCustomerId: "customer-1", linkedSalesVoucherId: "sale-1", taxableProductValue: "50", grossAmount: "50", sourceSnapshot: {} };
  const result = evaluateTod({
    rule: {
      id: "tod-v1", schemeId: "tod-scheme", companyId: "company-1", schemeType: "tod", versionNumber: 1, effectiveFrom: "2026-01-01", effectiveTo: null,
      roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, periodAnchorDate: "2026-09-01", periodMonths: 1,
      selectedStockItemIds: [], selectedStockGroupIds: ["stock-group-1"], unitConversions: [{ id: "conversion-1", sourceUomId: "uom-1", tonnesPerUnit: "1" }],
      tiers: [{ id: "tier-1", minimumTonnes: "1", percentage: "5" }], reviewCalendar: calendar,
    },
    customer, periodStart: "2026-09-01", periodEnd: "2026-09-30", evaluatedOn: "2026-10-01",
    vouchers: [{ ...sale, voucherDate: "2026-09-02", taxableProductValue: "200", grossAmount: "200" }, lateReturn],
    inventoryLines: [
      { id: "current-sale-line", voucherId: "sale-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "2", taxableProductValue: "200", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} },
      { id: "late-return-line", voucherId: "late-return-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: "stock-group-1", sourceUomId: "uom-1", sourceUomCode: "MT", quantity: "0.5", taxableProductValue: "50", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} },
    ],
    existingCreditNotes: [],
    priorPeriodAdjustments: [{ voucher: lateReturn, originalPeriodStart: "2026-08-01", originalPeriodEnd: "2026-08-31", taxableValueAdjustment: "0", tonneAdjustment: "0", reason: "sales_return_after_verified_tod_credit_note" }],
  });
  assert.equal(result.proposal?.eligibleTonnes, "1.500000");
  assert.equal(result.proposal?.eligibleProductTaxableValue, "150.00");
  assert.equal(result.evaluation.priorPeriodAdjustments[0]?.taxableValueAdjustment, "-50.00");
  assert.equal(result.evaluation.priorPeriodAdjustments[0]?.tonneAdjustment, "-0.500000");
  assert.equal(result.evaluation.sourceVouchers.find((item) => item.tallyVoucherId === "late-return-1")?.contributionType, "prior_period_adjustment");
});

test("TOD stops at needs review when an approved UOM-to-tonne conversion is missing", () => {
  const result = evaluateTod({
    rule: {
      id: "tod-v2", schemeId: "tod-scheme", companyId: "company-1", schemeType: "tod", versionNumber: 2, effectiveFrom: "2026-01-01", effectiveTo: null,
      roundingMethod: "half_up", roundingScale: 2, selectedCustomerGroupIds: ["group-1"], sourceSnapshot: {}, periodAnchorDate: "2026-08-01", periodMonths: 1,
      selectedStockItemIds: ["item-1"], selectedStockGroupIds: [], unitConversions: [], tiers: [{ id: "tier-1", minimumTonnes: "1", percentage: "5" }], reviewCalendar: calendar,
    },
    customer, periodStart: "2026-08-01", periodEnd: "2026-08-31", evaluatedOn: "2026-09-01", vouchers: [{ ...sale, voucherDate: "2026-08-10" }],
    inventoryLines: [{ id: "line-missing-uom", voucherId: "sale-1", lineNumber: 1, stockItemId: "item-1", stockGroupId: null, sourceUomId: "uom-1", sourceUomCode: "BOX", quantity: "5", taxableProductValue: "100", freightValue: "0", nonProductValue: "0", lineCategory: "inventory", quantityIsReliable: true, sourceSnapshot: {} }],
    existingCreditNotes: [], priorPeriodAdjustments: [],
  });
  assert.equal(result.proposal?.status, "needs_review");
  assert.equal(result.issues[0]?.issueType, "missing_unit_conversion");
});
