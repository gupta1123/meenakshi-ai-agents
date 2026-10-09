import test from "node:test";
import assert from "node:assert/strict";
import { fetchLiveCdEvidence } from "../src/commands/live-cd-evidence.mjs";
import { parseVouchers } from "../src/tally/vouchers.mjs";
import { evaluateCashDiscountSettlements as bridgeEvaluate } from "../src/local-cd-settlement-evaluator.mjs";
import { evaluateCashDiscountSettlements as backendEvaluate } from "../../backend/src/lib/evaluation/cd-settlement.mjs";

const ref = "MUI/25-26/1418";
const rule = {
  segments: [{ label: "3 days", allowedWorkingDays: 3, amountPerTonne: "500" }],
  customerSegments: { bkp: 0, other: 0 },
  calendar: { activeHolidayDates: [], nonWorkingIsoWeekdays: [7] },
};
const invoice = (extra = {}) => ({
  customerId: "bkp", customerLedgerName: "BKP Traders", tallyGuid: "inv1418",
  voucherNumber: ref, billReferences: [ref], voucherDate: "2025-05-09",
  grossAmount: "312661", eligibleTonnes: "5.04", missingUnits: [], payments: [], creditNotes: [],
  ...extra,
});
const payment = (extra = {}) => ({
  receiptGuid: "r209", receiptNumber: "209", receiptKind: "receipt", receiptType: "Receipt",
  receiptDate: "2025-05-09", customerLedgerName: "BKP Traders", ledgerIsDeemedPositive: false,
  billReference: ref, targetVoucherGuid: null, allocationType: "new_ref",
  rawAllocatedAmount: "294965", allocatedAmount: "294965", ...extra,
});
const bill = (name, type, amount, target = "") => `<BILLALLOCATIONS.LIST><NAME>${name}</NAME><BILLTYPE>${type}</BILLTYPE><AMOUNT>${amount}</AMOUNT>${target ? `<TARGETVOUCHERGUID>${target}</TARGETVOUCHERGUID>` : ""}</BILLALLOCATIONS.LIST>`;
const ledger = (name, bills, direction = "No") => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${name}</LEDGERNAME><ISDEEMEDPOSITIVE>${direction}</ISDEEMEDPOSITIVE>${bills}</ALLLEDGERENTRIES.LIST>`;
const voucher = (guid, date, type, number, content, amount = "0", party = "BKP Traders") => `<VOUCHER><GUID>${guid}</GUID><DATE>${date}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${number}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><VOUCHERAMOUNT>${amount}</VOUCHERAMOUNT>${content}</VOUCHER>`;
const sales = (guid = "inv1418", item = "TMT Bars", party = "BKP Traders", reference = ref) => voucher(guid, "20250509", "GST Sales-New", reference,
  ledger(party, bill(reference, "Agst Ref", "-312661"), "Yes")
  + `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${item}</STOCKITEMNAME><BILLEDQTY>5040 Kgs</BILLEDQTY><AMOUNT>264119</AMOUNT></ALLINVENTORYENTRIES.LIST>`, "312661", party);

async function evidenceFromXml(vouchers, extraScope = {}) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = String(options.body);
    requests.push(request);
    const from = request.match(/<SVFROMDATE[^>]*>(\d+)<\/SVFROMDATE>/)[1];
    const to = request.match(/<SVTODATE[^>]*>(\d+)<\/SVTODATE>/)[1];
    const matching = vouchers.filter(xml => {
      const date = xml.match(/<DATE>(\d+)<\/DATE>/)[1];
      return date >= from && date <= to;
    });
    return new Response(`<ENVELOPE>${matching.join("")}</ENVELOPE>`, { status: 200 });
  };
  try {
    const batch = await fetchLiveCdEvidence({ payload: { voucherScope: {
      purpose: "live_cd_evaluation", cdDiscountBasis: "amount_per_tonne",
      dateFrom: "2025-05-09", dateTo: "2025-05-12",
      customers: [{ customerId: "bkp", ledgerName: "BKP Traders" }, { customerId: "other", ledgerName: "Other Customer" }],
      eligibleStockItemNames: ["TMT Bars"], unitConversions: [{ uomCode: "Kgs", tonnesPerUnit: "0.001" }],
      ...extraScope,
    } } }, { config: { tallyUrl: "http://mock.invalid" }, activeCompany: { name: "Fixture" } }, null);
    return { batch, requests };
  } finally { globalThis.fetch = originalFetch; }
}

test("BKP 1418: same-bill New Ref plus Agst Ref counts by deadline in connector and backend", async () => {
  // Reconstructed from screenshots, not a captured live Tally export.
  const { batch, requests } = await evidenceFromXml([
    sales(),
    voucher("r209", "20250509", "Receipt", "209", ledger("BKP Traders", bill("MUI/25-26/1037", "Agst Ref", "5035") + bill(ref, "New Ref", "294965")), "300000"),
    voucher("r214", "20250510", "Receipt", "214", ledger("BKP Traders", bill(ref, "Agst Ref", "9961")), "9961"),
    voucher("r514", "20250523", "Receipt", "514", ledger("BKP Traders", bill(ref, "Agst Ref", "7735") + bill("MUI/25-26/1842", "Agst Ref", "300784")), "308519"),
  ], { dateTo: "2025-05-23" });
  assert.equal(requests.length, 2, "read in 10-day windows");
  assert.equal(batch.invoices.length, 1);
  assert.deepEqual(batch.invoices[0].payments.map(p => p.receiptNumber), ["209", "214", "514"]);
  const result = bridgeEvaluate(rule, "2026-10-09", batch.invoices);
  assert.deepEqual(backendEvaluate(rule, "2026-10-09", batch.invoices), result);
  const row = result.results[0];
  assert.equal(row.windowDeadline, "2025-05-12");
  assert.equal(row.paidByDeadline, "304926.00");
  assert.equal(row.paidToDate, "312661.00");
  assert.equal(row.category, "over_ninety_percent");
  assert.equal(row.creditAmount, "0.00");
  assert.equal(row.status, "settled_late");
  assert.equal(result.candidates.length, 0, "late full settlement suppresses a new credit note");
  assert.equal(row.payments[0].allocationType, "new_ref", "retain original evidence type");
  assert.equal(row.payments[2].counted, false, "later settlement does not improve deadline eligibility");
});

test("New Ref guards are rechecked by both evaluators, not trusted merely because attached to an invoice", () => {
  const rejected = [
    { customerLedgerName: "Other Customer" },
    { customerLedgerName: null },
    { receiptKind: "payment" },
    { receiptKind: "other", receiptType: "Journal" },
    { allocationType: "on_account" },
    { allocationType: "advance" },
    { billReference: "UNRELATED ADVANCE" },
    { targetVoucherGuid: "another-invoice" },
    { receiptDate: "2025-05-08" },
    { rawAllocatedAmount: "-294965" },
    { rawAllocatedAmount: "NaN" },
    { allocatedAmount: "invalid" },
    { rawAllocatedAmount: null },
    { rawAllocatedAmount: "100" },
    { ledgerIsDeemedPositive: true },
  ];
  for (const fields of rejected) {
    const input = [invoice({ payments: [payment(fields)] })];
    for (const evaluate of [bridgeEvaluate, backendEvaluate]) {
      const row = evaluate(rule, "2026-10-09", input).results[0];
      assert.equal(row.paidByDeadline, "0.00", JSON.stringify(fields));
    }
  }
  const late = bridgeEvaluate(rule, "2026-10-09", [invoice({ payments: [payment({ receiptDate: "2025-05-13" })] })]).results[0];
  assert.equal(late.paidByDeadline, "0.00");
  assert.equal(late.paidToDate, "294965.00");
  assert.equal(late.category, "not_eligible");
});

test("a matched New Ref keeps inclusive deadline, holiday adjustment and existing-note protections", () => {
  const boundaryRule = { ...rule, calendar: { nonWorkingIsoWeekdays: [7], activeHolidayDates: ["2025-05-12"] } };
  const onDeadline = invoice({ payments: [payment({ receiptDate: "2025-05-13", rawAllocatedAmount: "312661", allocatedAmount: "312661" })] });
  for (const evaluate of [bridgeEvaluate, backendEvaluate]) {
    const result = evaluate(boundaryRule, "2026-10-09", [onDeadline]);
    assert.equal(result.results[0].windowDeadline, "2025-05-13");
    assert.equal(result.results[0].category, "full_payment");
    const credited = evaluate(boundaryRule, "2026-10-09", [{ ...onDeadline, creditNotes: [{ amount: "2520" }] }]);
    assert.equal(credited.results[0].status, "credited");
    assert.equal(credited.candidates.length, 0);
  }
});

test("duplicate same-customer references reject New Ref unless an explicit invoice GUID disambiguates", () => {
  const first = invoice({ payments: [payment()] });
  const second = invoice({ tallyGuid: "duplicate", eligibleTonnes: "0" });
  for (const evaluate of [bridgeEvaluate, backendEvaluate]) {
    assert.equal(evaluate(rule, "2026-10-09", [first, second]).results[0].paidByDeadline, "0.00");
    const explicit = invoice({ payments: [payment({ targetVoucherGuid: "inv1418" })] });
    assert.equal(evaluate(rule, "2026-10-09", [explicit, second]).results[0].paidByDeadline, "294965.00");
    const other = invoice({ customerId: "other", customerLedgerName: "Other Customer", tallyGuid: "other" });
    assert.equal(evaluate(rule, "2026-10-09", [first, other]).results[0].paidByDeadline, "294965.00");
  }
});

test("collector checks ledger ownership, credit direction and ambiguity, including ineligible invoices", async () => {
  const cases = [
    [ledger("Other Customer", bill(ref, "New Ref", "294965"))],
    [ledger("BKP Traders", bill(ref, "New Ref", "-294965"), "Yes")],
    [ledger("BKP Traders", bill(ref, "New Ref", "294965"), "Yes")],
    [bill(ref, "New Ref", "294965")], // no owning-ledger evidence
    [ledger("BKP Traders", bill("ADVANCE", "New Ref", "294965"))],
    [ledger("BKP Traders", bill(ref, "On Account", "294965"))],
    [ledger("BKP Traders", bill(ref, "New Ref", "294965")), sales("duplicate", "Ineligible product")],
    [ledger("BKP Traders", bill(ref, "New Ref", "294965")) + "<ISCANCELLED>Yes</ISCANCELLED>"],
    [ledger("BKP Traders", bill(ref, "New Ref", "294965")) + "<ISREVERSED>Yes</ISREVERSED>"],
    [ledger("BKP Traders", bill(ref, "New Ref", "294965")) + "<ISOPTIONAL>Yes</ISOPTIONAL>"],
  ];
  for (const [content, extraInvoice] of cases) {
    const { batch } = await evidenceFromXml([sales(), voucher("receipt", "20250509", "Receipt", "209", content), ...(extraInvoice ? [extraInvoice] : [])]);
    assert.equal(batch.invoices[0].payments.length, 0, content);
    assert.equal(bridgeEvaluate(rule, "2026-10-09", batch.invoices).results[0].paidByDeadline, "0.00");
  }
});

test("each real allocation counts once even when indexed by GUID and name; equal split allocations remain distinct", async () => {
  const { batch } = await evidenceFromXml([
    sales(),
    voucher("receipt", "20250509", "Receipt", "209", ledger("BKP Traders",
      bill(ref, "New Ref", "500", "inv1418") + bill(ref, "New Ref", "500", "inv1418"))),
    sales("other-invoice", "TMT Bars", "Other Customer"),
  ]);
  assert.equal(batch.invoices[0].payments.length, 2);
  assert.equal(batch.invoices[1].payments.length, 0, "same number for another customer is not a match");
  assert.equal(bridgeEvaluate(rule, "2026-10-09", batch.invoices).results[0].paidByDeadline, "1000.00");
});

test("voucher parser retains owning ledger and signed bill amount for both ledger export formats", () => {
  for (const tag of ["ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST"]) {
    const xml = voucher("receipt", "20250509", "Receipt", "209",
      ledger("BKP Traders", bill(ref, "New Ref", "294965")).replaceAll("ALLLEDGERENTRIES.LIST", tag)
      + ledger("Other Customer", bill("other", "New Ref", "-50"), "Yes").replaceAll("ALLLEDGERENTRIES.LIST", tag));
    const [parsed] = parseVouchers(`<ENVELOPE>${xml}</ENVELOPE>`);
    assert.equal(parsed.billAllocations[0].sourcePayload.ledgerName, "BKP Traders");
    assert.equal(parsed.billAllocations[0].sourcePayload.ledgerIsDeemedPositive, false);
    assert.equal(parsed.billAllocations[1].sourcePayload.ledgerName, "Other Customer");
    assert.equal(parsed.billAllocations[1].sourcePayload.rawAmount, "-50");
    assert.equal(parsed.billAllocations[1].allocatedAmount, "50");
  }
});
