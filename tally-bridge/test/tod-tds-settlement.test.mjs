import test from "node:test";
import assert from "node:assert/strict";
import { fetchLiveTodEvidence } from "../src/commands/live-tod-evidence.mjs";

const ref = "MUI/25-26/12189";
const bill = (amount, { reference = ref, type = "Agst Ref", target = "" } = {}) => `<BILLALLOCATIONS.LIST><NAME>${reference}</NAME><BILLTYPE>${type}</BILLTYPE><AMOUNT>${amount}</AMOUNT><TARGETVOUCHERGUID>${target}</TARGETVOUCHERGUID></BILLALLOCATIONS.LIST>`;
const ledger = (name, amount, bills = "", debit = false) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${name}</LEDGERNAME><AMOUNT>${amount}</AMOUNT><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>${bills}</ALLLEDGERENTRIES.LIST>`;
const voucher = (guid, date, type, body, party = "Shakti Agro Industries", gross = "0") => `<VOUCHER><GUID>${guid}</GUID><DATE>${date}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${guid}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><VOUCHERAMOUNT>${gross}</VOUCHERAMOUNT>${body}</VOUCHER>`;
const sale = () => voucher("invoice", "20260325", "GST Sales-New", ledger("Shakti Agro Industries", "-975748", bill("-975748", { type: "New Ref" }), true) + `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>TMT Bars</STOCKITEMNAME><BILLEDQTY>15190 Kgs</BILLEDQTY><AMOUNT>826905</AMOUNT></ALLINVENTORYENTRIES.LIST>`, "Shakti Agro Industries", "975748").replace("<VOUCHERNUMBER>invoice</VOUCHERNUMBER>", `<VOUCHERNUMBER>${ref}</VOUCHERNUMBER>`);
const receipt = (amount = "293545", date = "20260326", bank = "Cash") => voucher("receipt", date, "Receipt", ledger(bank, `-${amount}`, "", true) + ledger("Shakti Agro Industries", amount, bill(amount)), "Shakti Agro Industries", amount);
const journal = (amount = "147761.23", date = "20260331", options = {}) => voucher("775", date, "Journal", ledger(options.debitLedger ?? "Income Tax TDS", `-${amount}`, "", true) + ledger(options.owner ?? "Shakti Agro Industries", amount, options.bills ?? bill(amount, options), options.reversal ?? false), "", amount);

async function evidence(vouchers, paymentCheck = { dueDays: 25, readTo: "2026-05-15", nonWorkingIsoWeekdays: [7], holidays: [] }) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = String(options.body);
    const from = body.match(/<SVFROMDATE[^>]*>(\d+)</)[1];
    const to = body.match(/<SVTODATE[^>]*>(\d+)</)[1];
    return new Response(`<ENVELOPE>${vouchers.filter(xml => { const date = xml.match(/<DATE>(\d+)</)[1]; return date >= from && date <= to; }).join("")}</ENVELOPE>`);
  };
  try {
    const result = await fetchLiveTodEvidence({ payload: { voucherScope: {
      purpose: "live_tod_evaluation", liveAggregation: true,
      dateFrom: "2026-03-01", dateTo: "2026-03-31", paymentCheck,
      customers: [{ customerId: "shakti", ledgerName: "Shakti Agro Industries" }],
      eligibleStockItemNames: ["TMT Bars"], unitConversions: [{ uomCode: "Kgs", tonnesPerUnit: "0.001" }],
    } } }, { config: { tallyUrl: "http://fixture.invalid" }, activeCompany: { name: "Fixture" } });
    return result.customerAggregates[0];
  } finally { globalThis.fetch = previous; }
}

test("Shakti 12189: allocated cash receipt plus linked TDS is settlement, still partly paid", async () => {
  const row = await evidence([sale(), receipt(), journal()]);
  const check = row.paymentChecks[0];
  assert.equal(check.dueDate, "2026-04-20");
  assert.equal(check.receiptTotal, "293545");
  assert.equal(check.tdsTotal, "147761.23");
  assert.equal(check.paidTotal, "441306.23");
  assert.equal(check.paidByDueDate, "441306.23");
  assert.equal(check.reason, "partly_paid");
  assert.equal(check.counted, false);
  assert.equal(row.eligibleTonnes, "0");
  assert.equal(check.payments[1].settlementKind, "tds");
});

test("TDS completing settlement on shifted deadline counts; later TDS does not", async () => {
  for (const [date, counted] of [["20260420", true], ["20260421", false]]) {
    const row = await evidence([sale(), receipt("827986.77"), journal("147761.23", date)]);
    assert.equal(row.paymentChecks[0].paidTotal, "975748");
    assert.equal(row.paymentChecks[0].counted, counted);
    assert.equal(row.eligibleTonnes, counted ? "15.19" : "0");
  }
});

test("unrelated, debit-side, unlinked and wrong-customer journals cannot settle this bill", async () => {
  for (const options of [{ debitLedger: "Discount Allowed" }, { reversal: true }, { type: "On Account" }, { owner: "Another Customer" }, { target: "different-invoice" }]) {
    const row = await evidence([sale(), receipt(), journal("147761.23", "20260331", options)]);
    assert.equal(row.paymentChecks[0].paidTotal, "293545", JSON.stringify(options));
  }
});

test("GUID and bill-ref matching do not double-count; separate equal allocations survive", async () => {
  const row = await evidence([sale(), receipt(), journal("200", "20260331", { bills: bill("100", { target: "invoice" }) + bill("100", { target: "invoice" }) })]);
  assert.equal(row.paymentChecks[0].tdsTotal, "200");
  assert.equal(row.paymentChecks[0].payments.length, 3);
});

test("missing payment configuration fails closed before reading Tally", async () => {
  await assert.rejects(evidence([sale()], null), /TOD payment check required/);
});

test("bank and cash receipts both count only the invoice allocation", async () => {
  for (const account of ["Cash", "HDFC Bank Ltd (CC A/c)"]) {
    const row = await evidence([sale(), receipt("975748", "20260326", account)]);
    assert.equal(row.paymentChecks[0].counted, true);
    assert.equal(row.paymentChecks[0].receiptTotal, "975748");
    assert.equal(row.paymentChecks[0].tdsTotal, "0");
  }
});
