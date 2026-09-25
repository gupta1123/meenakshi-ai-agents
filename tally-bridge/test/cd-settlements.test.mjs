import test from "node:test";
import assert from "node:assert/strict";

import { evaluateCashDiscountSettlements, gstCreditNoteLastDate, workingDayDeadline } from "../src/local-cd-settlement-evaluator.mjs";
import { buildDebitNoteImportXml, isCashDiscountCreditNote } from "../src/tally/debit-notes.mjs";

const calendar = { activeHolidayDates: ["2025-10-07"], nonWorkingIsoWeekdays: [7] };
const rule = {
  id: "rule-1",
  cdDiscountBasis: "amount_per_tonne",
  calendar,
  segments: [{ label: "3 working days", allowedWorkingDays: 3, amountPerTonne: "500" }],
  customerSegments: { "cust-1": 0 },
};
// ₹1,00,000 invoice of 10 MT → discount ₹5,000; discounted target ₹95,000.
const invoice = (payments, extra = {}) => ({
  customerId: "cust-1", customerLedgerName: "Shakti Agro", tallyGuid: "inv-1", voucherNumber: "MUI/5193", billReferences: ["MUI/5193"],
  voucherDate: "2025-10-03", grossAmount: "100000", eligibleTonnes: "10", missingUnits: [], sourceSalesLedgerName: "GST Sales",
  payments: payments.map(([receiptDate, allocatedAmount], index) => ({ receiptGuid: `r${index}`, receiptNumber: `R${index}`, receiptDate, allocationType: "agst_ref", allocatedAmount, billReference: "MUI/5193", targetVoucherGuid: null })),
  creditNotes: [], ...extra,
});

test("the backend's copy of the settlement evaluator is identical", async () => {
  const { readFile } = await import("node:fs/promises");
  const here = new URL("../src/local-cd-settlement-evaluator.mjs", import.meta.url);
  const backend = new URL("../../backend/src/lib/evaluation/cd-settlement.mjs", import.meta.url);
  const backendText = await readFile(backend, "utf8").catch(() => null);
  if (backendText === null) return; // connector built outside the monorepo
  assert.equal(backendText, await readFile(here, "utf8"), "Copy tally-bridge/src/local-cd-settlement-evaluator.mjs to backend/src/lib/evaluation/cd-settlement.mjs");
});

test("working-day deadline skips Sundays and holidays", () => {
  // Fri 3 Oct → Sat 4 (1), Sun 5 skipped, Mon 6 (2), Tue 7 holiday, Wed 8 (3).
  assert.equal(workingDayDeadline(calendar, "2025-10-03", 3), "2025-10-08");
});

test("GST Credit Note last date is 30 November after the financial year", () => {
  assert.equal(gstCreditNoteLastDate("2025-10-03"), "2026-11-30");
  assert.equal(gstCreditNoteLastDate("2026-02-10"), "2026-11-30");
});

test("categories: full, discounted, more than 90%, not eligible", () => {
  const run = (payments, evaluatedOn = "2025-10-20") => evaluateCashDiscountSettlements(rule, evaluatedOn, [invoice(payments)]);
  const full = run([["2025-10-06", "100000"]]);
  assert.equal(full.results[0].category, "full_payment");
  assert.equal(full.candidates.length, 0, "full payment gets no Credit Note");

  const discounted = run([["2025-10-08", "94999.60"]]);
  assert.equal(discounted.results[0].category, "discounted_payment", "within ₹1 of invoice − discount");
  assert.equal(discounted.candidates[0].status, "action_required");
  assert.equal(discounted.candidates[0].creditAmount, "5000.00");

  const ninety = run([["2025-10-08", "91000"]]);
  assert.equal(ninety.results[0].category, "over_ninety_percent");
  assert.equal(ninety.candidates[0].status, "review_required");
  assert.equal(ninety.candidates[0].creditAmount, "5000.00", "capped at the discount although ₹9,000 is short");

  const smallShort = run([["2025-10-08", "97000"]]);
  assert.equal(smallShort.results[0].category, "over_ninety_percent");
  assert.equal(smallShort.candidates[0].creditAmount, "3000.00", "only what is short when below the discount");

  const late = run([["2025-10-09", "95000"]]);
  assert.equal(late.results[0].category, "not_eligible", "discounted payment after the deadline earns nothing");
  assert.equal(late.candidates.length, 0);

  const open = run([], "2025-10-06");
  assert.equal(open.results[0].category, "awaiting_payment");
});

test("an invoice already credited or missing MT units makes no new Credit Note", () => {
  const credited = evaluateCashDiscountSettlements(rule, "2025-10-20", [invoice([["2025-10-08", "95000"]], { creditNotes: [{ tallyGuid: "cn", voucherNumber: "15", voucherDate: "2025-10-10", amount: "5000", narration: "Being Cash Discount allowed against Inv No. MUI/5193 dt." }] })]);
  assert.equal(credited.results[0].status, "credited");
  assert.equal(credited.candidates.length, 0);
  const noUnits = evaluateCashDiscountSettlements(rule, "2025-10-20", [invoice([["2025-10-08", "95000"]], { eligibleTonnes: "0", missingUnits: ["BAG"] })]);
  assert.equal(noUnits.results[0].category, "needs_review");
  assert.equal(noUnits.candidates.length, 0);
});

test("customers outside every segment are ignored", () => {
  const result = evaluateCashDiscountSettlements(rule, "2025-10-20", [invoice([["2025-10-08", "95000"]], { customerId: "other" })]);
  assert.equal(result.results.length, 0);
});

test("Cash Discount Credit Note XML credits the party and debits discount and GST", () => {
  const note = {
    noteKind: "credit_note",
    company: { guid: "c", name: "Meenakshi" }, voucherType: { name: "Credit Note" }, party: { guid: "p", name: "Shakti Agro" },
    debitNoteDate: "2025-10-20", amount: "5000.00", calculationReference: "CN-CD-MUI/5193", allocation: { type: "on_account", reference: "CN-CD-MUI/5193" },
    gstNote: { discountLedger: { name: "TN SGST Sales (Discount)" }, taxLines: [{ name: "SGST-9%", amount: "381.36" }, { name: "CGST - 9%", amount: "381.36" }], taxableValue: "4237.29", roundOff: { name: "Round Off", amount: "-0.01" }, total: "5000.00", narration: "Being Cash Discount allowed against Inv No. MUI/5193 dt. 03.10.25", reference: "MUI/5193" },
  };
  assert.equal(isCashDiscountCreditNote(note), true);
  const xml = buildDebitNoteImportXml(note);
  assert.match(xml, /VCHTYPE="Credit Note"/);
  assert.match(xml, /<LEDGERNAME>Shakti Agro<\/LEDGERNAME><ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>5000.00<\/AMOUNT><BILLALLOCATIONS.LIST><BILLTYPE>On Account/);
  assert.match(xml, /TN SGST Sales \(Discount\)<\/LEDGERNAME><ISPARTYLEDGER>No<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-4237.29/);
  assert.match(xml, /Round Off<\/LEDGERNAME><ISPARTYLEDGER>No<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>0.01/);
});
