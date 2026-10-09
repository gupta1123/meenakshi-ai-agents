import test from "node:test";
import assert from "node:assert/strict";
import { matchCdCreditNote } from "../src/commands/cd-credit-note-matching.mjs";
import { fetchLiveCdEvidence } from "../src/commands/live-cd-evidence.mjs";
import { evaluateCashDiscountSettlements as bridgeEvaluate } from "../src/local-cd-settlement-evaluator.mjs";
import { evaluateCashDiscountSettlements as backendEvaluate } from "../../backend/src/lib/evaluation/cd-settlement.mjs";

const invoice = (extra = {}) => ({ tallyGuid: "inv192", customerLedgerName: "Kumaran Steel", voucherNumber: "MUI/25-26/0192", voucherDate: "2025-04-04", ...extra });
const note = (extra = {}) => ({ tallyGuid: "cn14", customerLedgerName: "Kumaran Steel", voucherDate: "2025-06-16", amount: "11405", narration: "Being Amount credited twds Discount allowed for the month of Apr' 25 vide B.No.192 (22.810 x 500/-)", ...extra });

test("legacy Kumaran bill reference and modern full references match explicitly", () => {
  assert.equal(matchCdCreditNote(note(), [invoice()]), "inv192");
  for (const narration of [
    "Being Cash Discount allowed against Inv No. MUI/25-26/0192 dt. 4-Apr-2025",
    "cash discount allowed against INV NO. mui/25-26/0192",
    "Discount allowed Bill No: 00192 (22.81 x 500)",
  ]) assert.equal(matchCdCreditNote(note({ narration }), [invoice()]), "inv192");
});

test("do not guess from amounts, substrings, different customers, periods or multiple bills", () => {
  for (const fields of [
    { customerLedgerName: "Other Customer" }, { customerLedgerName: "" },
    { narration: "Discount allowed B.No.1920" },
    { narration: "Discount allowed for Apr 25 quantity 192" },
    { narration: "Turnover Discount allowed B.No.192" },
    { narration: "Quarterly Cash Discount Inv No. MUI/25-26/0192" },
    { narration: "Cash Discount Inv No. MUI/24-25/0192" },
    { narration: "Discount allowed B.No.192 and Bill No.193" },
    { narration: "Discount allowed B.No.192, 193" },
    { narration: "Discount allowed B.No.192 and 193" },
    { narration: "Goods return B.No.192" },
    { voucherDate: "2025-04-03" }, { voucherDate: "" }, { amount: "0" },
  ]) assert.equal(matchCdCreditNote(note(fields), [invoice()]), null, JSON.stringify(fields));
  const duplicate = invoice({ tallyGuid: "older", voucherNumber: "MUI/24-25/0192", voucherDate: "2024-04-04" });
  assert.equal(matchCdCreditNote(note(), [invoice(), duplicate]), null);
  assert.equal(matchCdCreditNote(note({ narration: "Cash Discount Inv No. MUI/25-26/0192" }), [invoice(), duplicate]), "inv192");
  assert.equal(matchCdCreditNote(note(), [invoice(), invoice({ tallyGuid: "other", customerLedgerName: "Other Customer" })]), "inv192");
});

test("collector attaches CN14 and both evaluators suppress duplicate candidate for Kumaran 0192", async () => {
  // Reconstructed screenshot evidence, not a captured live XML export.
  const bill = (type, amount) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Kumaran Steel</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><BILLALLOCATIONS.LIST><NAME>MUI/25-26/0192</NAME><BILLTYPE>${type}</BILLTYPE><AMOUNT>${amount}</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>`;
  const voucher = (guid, date, type, number, amount, content = "") => `<VOUCHER><GUID>${guid}</GUID><DATE>${date}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${number}</VOUCHERNUMBER><PARTYLEDGERNAME>Kumaran Steel</PARTYLEDGERNAME><VOUCHERAMOUNT>${amount}</VOUCHERAMOUNT>${content}</VOUCHER>`;
  const xml = [
    voucher("inv192", "20250404", "GST Sales-New", "MUI/25-26/0192", "1483471", bill("New Ref", "-1483471") + "<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>TMT Bars</STOCKITEMNAME><BILLEDQTY>22810 Kgs</BILLEDQTY><AMOUNT>1252617</AMOUNT></ALLINVENTORYENTRIES.LIST>"),
    voucher("r62", "20250404", "Receipt", "62", "145000", bill("New Ref", "145000")),
    voucher("r68", "20250404", "Receipt", "68", "1280000", bill("Agst Ref", "1280000")),
    voucher("r108", "20250405", "Receipt", "108", "47066", bill("Agst Ref", "47066")),
    voucher("cn14", "20250616", "Credit Note", "14", "11405", `<NARRATION>${note().narration}</NARRATION>`),
    voucher("cancelled", "20250616", "Credit Note", "15", "11405", `<NARRATION>${note().narration}</NARRATION><ISCANCELLED>Yes</ISCANCELLED>`),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const from = String(options.body).match(/<SVFROMDATE[^>]*>(\d+)<\/SVFROMDATE>/)[1];
    const to = String(options.body).match(/<SVTODATE[^>]*>(\d+)<\/SVTODATE>/)[1];
    return new Response(`<ENVELOPE>${xml.filter(v => { const d = v.match(/<DATE>(\d+)<\/DATE>/)[1]; return d >= from && d <= to; }).join("")}</ENVELOPE>`);
  };
  let batch;
  try {
    batch = await fetchLiveCdEvidence({ payload: { voucherScope: {
      purpose: "live_cd_evaluation", cdDiscountBasis: "amount_per_tonne", dateFrom: "2025-04-04", dateTo: "2025-06-16",
      customers: [{ customerId: "kumaran", ledgerName: "Kumaran Steel" }],
      eligibleStockItemNames: ["TMT Bars"], unitConversions: [{ uomCode: "Kgs", tonnesPerUnit: "0.001" }],
    } } }, { config: { tallyUrl: "http://mock.invalid" }, activeCompany: { name: "Fixture" } }, null);
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(batch.invoices[0].creditNotes.map(n => n.voucherNumber), ["14"]);
  const rule = { segments: [{ label: "3 days", allowedWorkingDays: 3, amountPerTonne: "500" }], customerSegments: { kumaran: 0 }, calendar: { activeHolidayDates: [], nonWorkingIsoWeekdays: [7] } };
  for (const evaluate of [bridgeEvaluate, backendEvaluate]) {
    const result = evaluate(rule, "2026-10-09", batch.invoices);
    assert.equal(result.results[0].paidByDeadline, "1472066.00");
    assert.equal(result.results[0].discountAmount, "11405.00");
    assert.equal(result.results[0].alreadyCredited, "11405.00");
    assert.equal(result.results[0].status, "credited");
    assert.equal(result.candidates.length, 0);
  }
});
