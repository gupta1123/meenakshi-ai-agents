import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSupportEvidence,
  mergeCdSnapshotRows,
} from "./connector-support-evidence.ts";

const body = {
  rule: { id: "rule" },
  customerScope: ["selected"],
  voucherScope: {
    customers: [{ customerId: "selected" }],
    dateFrom: "2025-04-01",
    dateTo: "2026-11-18",
    invoiceDateTo: "2026-03-31",
  },
};
const evidence = {
  mode: "live_cd_batch",
  ruleVersionId: "rule",
  dateFrom: "2025-04-01",
  dateTo: "2026-11-18",
  creditNoteMatchingVersion: 2,
  invoices: [
    { customerId: "selected", tallyGuid: "invoice", voucherDate: "2026-03-23" },
  ],
};
test("replay validates the server-owned period, customer and manual-CN evidence", () => {
  assert.deepEqual(
    validateSupportEvidence(body, evidence, "cd").customerScope,
    ["selected"],
  );
  for (const patch of [
    { ruleVersionId: "another" },
    { dateFrom: "2026-03-23" },
    { creditNoteMatchingVersion: 0 },
    { invoices: [{ ...evidence.invoices[0], customerId: "another" }] },
    { invoices: [{ ...evidence.invoices[0], voucherDate: "2026-04-01" }] },
    { invoices: [...evidence.invoices, ...evidence.invoices] },
    { customerCredits: [{ customerId: "another" }] },
  ])
    assert.throws(() =>
      validateSupportEvidence(body, { ...evidence, ...patch }, "cd"),
    );
});
test("partial refresh replaces all selected rows and preserves unrelated excluded evidence and provenance", () => {
  const other = {
    customerId: "other",
    invoiceGuid: "excluded",
    status: "not_eligible",
    sourceRunId: "old-run",
  };
  const previous = {
    evidenceSchemaVersion: 2,
    settlementResults: [{ customerId: "selected", invoiceGuid: "obsolete" }],
    excludedInvoices: [
      other,
      { customerId: "selected", invoiceGuid: "old-excluded" },
    ],
  };
  const current = {
    customerId: "selected",
    invoiceGuid: "new",
    status: "ready",
  };
  assert.deepEqual(mergeCdSnapshotRows(previous, [current], ["selected"]), [
    other,
    current,
  ]);
  assert.deepEqual(mergeCdSnapshotRows(previous, [], ["selected"]), [other]);
  assert.throws(
    () => mergeCdSnapshotRows({ evidenceSchemaVersion: 1 }, [], ["selected"]),
    /full connector/,
  );
  assert.throws(
    () => mergeCdSnapshotRows(previous, [other], ["selected"]),
    /another customer/,
  );
});
test("TOD must contain exactly the requested customers and complete period", () => {
  const b = {
    voucherScope: {
      customers: [{ customerId: "customer" }],
      dateFrom: "2025-04-01",
      dateTo: "2025-06-30",
    },
  };
  const e = {
    mode: "live_tod_batch_aggregate",
    periodStart: "2025-04-01",
    periodEnd: "2025-06-30",
    customerAggregates: [{ customerId: "customer" }],
  };
  assert.deepEqual(validateSupportEvidence(b, e, "tod"), e);
  for (const patch of [
    { periodStart: "2025-06-01" },
    { customerAggregates: [] },
    { customerAggregates: [{ customerId: "another" }] },
    {
      customerAggregates: [
        { customerId: "customer" },
        { customerId: "customer" },
      ],
    },
  ])
    assert.throws(() => validateSupportEvidence(b, { ...e, ...patch }, "tod"));
});
test("central TOD replay independently calculates the tier and below-threshold results",async()=>{
 const {evaluateLocalTurnoverDiscount}=await import("./evaluation/support-tod.mjs");
 const rule={id:"rule",companyId:"company",roundingScale:2,roundingMethod:"half_up",todBenefitBasis:"amount_per_eligible_tonne",tiers:[{id:"tier",minimumTonnes:"30",amountPerTonne:"350"}],reviewCalendar:{nonWorkingIsoWeekdays:[7],activeHolidayDates:[]}};
 const aggregates=[{customerId:"one",customerLedgerName:"One",eligibleTaxableValue:"100000",eligibleTonnes:"63.94",missingUnits:[]},{customerId:"two",customerLedgerName:"Two",eligibleTaxableValue:"100000",eligibleTonnes:"29.99",missingUnits:[]}];
 const result=evaluateLocalTurnoverDiscount(rule,"2025-07-01","2025-04-01","2025-06-30",aggregates);
 assert.equal(result.rows[0].calculatedDiscountAmount,"22379.00");assert.equal(result.rows[0].status,"eligible");
 assert.equal(result.rows[1].calculatedDiscountAmount,"0.00");assert.equal(result.rows[1].status,"tracking");
});
