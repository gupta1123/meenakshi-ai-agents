// Customer credit that is not a receipt against the bill:
//  - Cash Discount: on-account credit (opening balance, or the On Account part of a receipt)
//  - Turnover Discount: a manual Credit Note set against the bill in Tally
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateCashDiscountSettlements } from "../src/local-cd-settlement-evaluator.mjs";
import { fetchLiveCdEvidence } from "../src/commands/live-cd-evidence.mjs";
import { fetchLiveTodEvidence } from "../src/commands/live-tod-evidence.mjs";

const rule = {
  id: "rule-1",
  cdDiscountBasis: "amount_per_tonne",
  calendar: { activeHolidayDates: [], nonWorkingIsoWeekdays: [7] },
  segments: [{ label: "3 days", allowedWorkingDays: 3, amountPerTonne: "500" }],
  customerSegments: { "cust-1": 0 },
};
// ₹1,00,000 invoice of 10 MT → discount ₹5,000; discounted target ₹95,000.
function invoice(payments, extra = {}) {
  const reference = extra.voucherNumber ?? "MUI/5193";
  return {
    customerId: "cust-1", customerLedgerName: "Shakti Agro", tallyGuid: "inv-1", voucherNumber: reference, billReferences: [reference],
    voucherDate: "2025-10-03", grossAmount: "100000", eligibleTonnes: "10", missingUnits: [], sourceSalesLedgerName: "GST Sales",
    payments: payments.map(([receiptDate, allocatedAmount], index) => ({ receiptGuid: `r${index}`, receiptNumber: `R${index}`, receiptDate, allocationType: "agst_ref", allocatedAmount, billReference: reference, targetVoucherGuid: null })),
    creditNotes: [], ...extra,
  };
}
const short = [["2025-10-06", "84418"]]; // short ₹15,582: more than ₹10,000

test("on-account credit counts toward a short payment once the window has closed", () => {
  const alone = evaluateCashDiscountSettlements(rule, "2025-10-20", [invoice(short)]);
  assert.equal(alone.results[0].category, "not_eligible");
  assert.equal(alone.results[0].onAccountCreditUsed, "0.00");

  // ₹8,084 credit: short becomes ₹7,498 → Short up to ₹10,000, credit min(7,498, 5,000).
  const opening = [{ customerId: "cust-1", date: "2025-04-01", amount: "8084", source: "Opening on-account balance" }];
  const withCredit = evaluateCashDiscountSettlements(rule, "2025-10-20", [invoice(short)], opening);
  assert.equal(withCredit.results[0].category, "over_ninety_percent");
  assert.equal(withCredit.results[0].onAccountCreditUsed, "8084.00");
  assert.equal(withCredit.results[0].paidByDeadline, "92502.00");
  assert.equal(withCredit.results[0].creditAmount, "5000.00");
  assert.equal(withCredit.candidates[0].status, "review_required");
  assert.equal(withCredit.results[0].payments.at(-1).voucherType, "On-account credit");
  assert.match(withCredit.results[0].reviewMessage, /on-account credit/);

  // Enough credit to reach the discounted amount: only what is needed is used.
  const discounted = evaluateCashDiscountSettlements(rule, "2025-10-20", [invoice(short)], [{ customerId: "cust-1", date: "2025-04-01", amount: "20000" }]);
  assert.equal(discounted.results[0].category, "discounted_payment");
  assert.equal(discounted.results[0].onAccountCreditUsed, "10582.00");
  assert.equal(discounted.results[0].creditAmount, "5000.00");
  assert.equal(discounted.candidates[0].status, "action_required");
});

test("on-account credit is used once, oldest invoice first, and only if it existed by the deadline", () => {
  const second = invoice([["2025-10-09", "84418"]], { tallyGuid: "inv-2", voucherNumber: "MUI/5194", voucherDate: "2025-10-06" });
  const credit = [{ customerId: "cust-1", date: "2025-04-01", amount: "12000" }];
  const result = evaluateCashDiscountSettlements(rule, "2025-10-20", [second, invoice(short)], credit);
  assert.deepEqual(result.results.map((row) => row.invoiceGuid), ["inv-2", "inv-1"], "results keep the connector's order");
  const byGuid = Object.fromEntries(result.results.map((row) => [row.invoiceGuid, row]));
  assert.equal(byGuid["inv-1"].onAccountCreditUsed, "10582.00", "the older invoice takes the credit first");
  assert.equal(byGuid["inv-2"].onAccountCreditUsed, "0.00", "₹1,418 left is not enough for the second");
  assert.equal(byGuid["inv-2"].category, "not_eligible");

  const late = evaluateCashDiscountSettlements(rule, "2025-10-20", [invoice(short)], [{ customerId: "cust-1", date: "2025-10-15", amount: "50000" }]);
  assert.equal(late.results[0].category, "not_eligible", "credit received after the deadline does not count");

  const takenBack = evaluateCashDiscountSettlements(rule, "2025-10-20", [invoice(short)], [
    { customerId: "cust-1", date: "2025-04-01", amount: "20000" },
    { customerId: "cust-1", date: "2025-10-10", amount: "-12000" },
  ]);
  assert.equal(takenBack.results[0].onAccountCreditUsed, "8000.00", "credit later taken back is not lent earlier");

  const open = evaluateCashDiscountSettlements(rule, "2025-10-05", [invoice([["2025-10-04", "84418"]])], credit);
  assert.equal(open.results[0].category, "awaiting_payment", "credit is not used while the window is open");

  const otherCustomer = evaluateCashDiscountSettlements(rule, "2025-10-20", [invoice(short)], [{ customerId: "cust-2", date: "2025-04-01", amount: "50000" }]);
  assert.equal(otherCustomer.results[0].category, "not_eligible", "another customer's credit is never used");
});

const tally = { config: { tallyUrl: "http://localhost:9000" }, activeCompany: { name: "Test Company", guid: "company-1" }, isCancelled: () => false };

test("Turnover Discount counts a manual Credit Note set against the bill", async () => {
  const originalFetch = globalThis.fetch;
  const sales = "<VOUCHER><GUID>sales-2626</GUID><DATE>20260801</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>MUI/2626</VOUCHERNUMBER><PARTYLEDGERNAME>BKP Traders</PARTYLEDGERNAME><VOUCHERAMOUNT>-100000</VOUCHERAMOUNT>"
    + "<ALLLEDGERENTRIES.LIST><LEDGERNAME>BKP Traders</LEDGERNAME><AMOUNT>-100000</AMOUNT><BILLALLOCATIONS.LIST><NAME>MUI/2626</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-100000</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>"
    + "<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Steel</STOCKITEMNAME><BILLEDQTY>10 MT</BILLEDQTY><AMOUNT>84746</AMOUNT></ALLINVENTORYENTRIES.LIST></VOUCHER>";
  const receipt = "<VOUCHER><GUID>receipt-1</GUID><DATE>20260810</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>R-1</VOUCHERNUMBER><PARTYLEDGERNAME>BKP Traders</PARTYLEDGERNAME>"
    + "<ALLLEDGERENTRIES.LIST><LEDGERNAME>BKP Traders</LEDGERNAME><AMOUNT>78880</AMOUNT><BILLALLOCATIONS.LIST><NAME>MUI/2626</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>78880</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>";
  const creditNote = "<VOUCHER><GUID>cn-7</GUID><DATE>20260812</DATE><VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME><VOUCHERNUMBER>7</VOUCHERNUMBER><PARTYLEDGERNAME>BKP Traders</PARTYLEDGERNAME><VOUCHERAMOUNT>21120</VOUCHERAMOUNT>"
    + "<NARRATION>Being Amount credited twds Discount allowed vide B.No.2626 (42.240 x 500/-)</NARRATION>"
    + "<ALLLEDGERENTRIES.LIST><LEDGERNAME>BKP Traders</LEDGERNAME><AMOUNT>21120</AMOUNT><BILLALLOCATIONS.LIST><NAME>MUI/2626</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>21120</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>";
  const run = async (vouchers) => {
    globalThis.fetch = async (_url, options) => new Response(`<ENVELOPE>${String(options?.body ?? "").includes("20260731</SVFROMDATE") ? vouchers : ""}</ENVELOPE>`, { status: 200 });
    const result = await fetchLiveTodEvidence({ payload: { evaluationRunId: "e-1", voucherScope: {
      purpose: "live_tod_evaluation", liveAggregation: true, dateFrom: "2026-08-01", dateTo: "2026-08-31",
      customers: [{ customerId: "bkp", ledgerName: "BKP Traders" }], eligibleStockItemNames: ["Steel"],
      unitConversions: [{ uomCode: "MT", tonnesPerUnit: "1" }], paymentCheck: { dueDays: 25, readTo: "2026-08-31" },
    } } }, tally);
    return result.customerAggregates[0].paymentChecks[0];
  };
  try {
    const withoutNote = await run(sales + receipt);
    assert.equal(withoutNote.counted, false);
    assert.equal(withoutNote.reason, "partly_paid");
    const withNote = await run(sales + receipt + creditNote);
    assert.equal(withNote.counted, true, "receipt ₹78,880 + Credit Note ₹21,120 settle the ₹1,00,000 bill");
    assert.equal(withNote.reason, "paid_in_full_on_time");
    assert.equal(withNote.creditNotes[0].amount, "21120");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cash Discount reads on-account credit and the opening on-account balance", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const sales = "<VOUCHER><GUID>sales-41</GUID><DATE>20250401</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>MUI/0041</VOUCHERNUMBER><PARTYLEDGERNAME>Venkateswara Hardwares</PARTYLEDGERNAME><VOUCHERAMOUNT>-100000</VOUCHERAMOUNT>"
    + "<ALLLEDGERENTRIES.LIST><LEDGERNAME>Venkateswara Hardwares</LEDGERNAME><AMOUNT>-100000</AMOUNT><BILLALLOCATIONS.LIST><NAME>MUI/0041</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-100000</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>"
    + "<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Steel</STOCKITEMNAME><BILLEDQTY>10 MT</BILLEDQTY><AMOUNT>84746</AMOUNT></ALLINVENTORYENTRIES.LIST></VOUCHER>";
  const receipt = "<VOUCHER><GUID>receipt-25</GUID><DATE>20250403</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>25</VOUCHERNUMBER><PARTYLEDGERNAME>Venkateswara Hardwares</PARTYLEDGERNAME>"
    + "<ALLLEDGERENTRIES.LIST><LEDGERNAME>Venkateswara Hardwares</LEDGERNAME><AMOUNT>85418</AMOUNT>"
    + "<BILLALLOCATIONS.LIST><NAME>MUI/0041</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>84418</AMOUNT></BILLALLOCATIONS.LIST>"
    + "<BILLALLOCATIONS.LIST><NAME>On Account</NAME><BILLTYPE>On Account</BILLTYPE><AMOUNT>1000</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>";
  const ledger = "<LEDGER NAME=\"Venkateswara Hardwares\" RESERVEDNAME=\"\"><OPENINGBALANCE TYPE=\"Amount\">5971.00</OPENINGBALANCE>"
    + "<BILLALLOCATIONS.LIST><NAME>MUI/24-25/11903</NAME><OPENINGBALANCE TYPE=\"Amount\">-4512.00</OPENINGBALANCE></BILLALLOCATIONS.LIST></LEDGER>";
  globalThis.fetch = async (_url, options) => {
    const body = String(options?.body ?? "");
    requests.push(body);
    if (body.includes("<TYPE>Ledger</TYPE>")) return new Response(`<ENVELOPE>${ledger}</ENVELOPE>`, { status: 200 });
    return new Response(`<ENVELOPE>${body.includes("20250331</SVFROMDATE") ? sales + receipt : ""}</ENVELOPE>`, { status: 200 });
  };
  try {
    const evidence = await fetchLiveCdEvidence({ payload: { evaluationRunId: "e-1", voucherScope: {
      purpose: "live_cd_evaluation", liveAggregation: "cd", cdDiscountBasis: "amount_per_tonne", ruleVersionId: "rule-1",
      dateFrom: "2025-04-01", dateTo: "2025-04-10", customers: [{ customerId: "vh", ledgerName: "Venkateswara Hardwares" }],
      eligibleStockItemNames: ["Steel"], unitConversions: [{ uomCode: "MT", tonnesPerUnit: "1" }],
    } } }, tally, null);
    assert.deepEqual(evidence.customerCredits.map(({ date, amount }) => [date, amount]), [["2025-04-03", "1000"], ["2025-04-01", "10483"]],
      "the receipt's On Account part, and the opening ₹5,971 Cr less the ₹4,512 Dr opening bill = ₹10,483 Cr on account");
    assert.equal(requests.filter((body) => body.includes("<TYPE>Ledger</TYPE>")).length, 1, "one small ledger request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
