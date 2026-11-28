import test from "node:test";
import assert from "node:assert/strict";
import { fetchLiveCdEvidence } from "../src/commands/live-cd-evidence.mjs";
import { evaluateCashDiscountSettlements } from "../src/local-cd-settlement-evaluator.mjs";
import { fetchLiveTodEvidence } from "../src/commands/live-tod-evidence.mjs";
import { createOrRecoverDebitNote } from "../src/tally/debit-notes.mjs";
import { syncVouchers } from "../src/commands/sync-vouchers.mjs";

const customer = { customerId: "customer-guid", ledgerName: "Test Customer" };
const rule = { calendar: { activeHolidayDates: [], nonWorkingIsoWeekdays: [7] }, segments: [{ label: "3 days", allowedWorkingDays: 3, amountPerTonne: "500" }], customerSegments: { [customer.customerId]: 0 } };
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function ledger(name, amount, bills = [], guid = name === customer.ledgerName ? customer.customerId : "") {
  return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(name)}</LEDGERNAME><LEDGERGUID>${guid}</LEDGERGUID><AMOUNT>${amount}</AMOUNT>${bills.map(([reference, value, type = "Agst Ref", target = ""]) => `<BILLALLOCATIONS.LIST><NAME>${xml(reference)}</NAME><BILLTYPE>${type}</BILLTYPE><AMOUNT>${value}</AMOUNT>${target ? `<TARGETVOUCHERGUID>${target}</TARGETVOUCHERGUID>` : ""}</BILLALLOCATIONS.LIST>`).join("")}</ALLLEDGERENTRIES.LIST>`;
}
function voucher({ guid, type, number, amount, date = "20260324", party = customer.ledgerName, partyGuid = "", narration = "", entries = "", inventory = "", cancelled = false }) {
  return `<VOUCHER><GUID>${guid}</GUID><DATE>${date}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(number)}</VOUCHERNUMBER><VOUCHERAMOUNT>${amount}</VOUCHERAMOUNT>${party ? `<PARTYLEDGERNAME>${xml(party)}</PARTYLEDGERNAME>` : ""}<PARTYLEDGERGUID>${partyGuid}</PARTYLEDGERGUID><NARRATION>${xml(narration)}</NARRATION><ISCANCELLED>${cancelled ? "Yes" : "No"}</ISCANCELLED>${entries}${inventory}</VOUCHER>`;
}
const inventory = '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Test Steel</STOCKITEMNAME><STOCKITEMGUID>steel</STOCKITEMGUID><BILLEDQTY>10 MT</BILLEDQTY><AMOUNT>100000</AMOUNT></ALLINVENTORYENTRIES.LIST>';
const sale = (number = "INV/25-26/1", guid = "invoice-1") => voucher({ guid, type: "Sales", number, amount: "100000", date: "20260323", entries: ledger(customer.ledgerName, "-100000", [[number, "-100000", "New Ref"]]), inventory });
const receipt = (amount = "95000", reference = "INV/25-26/1", party = customer.ledgerName) => voucher({ guid: `receipt-${reference}-${party}`, type: "Receipt", number: "R1", amount, party, entries: ledger(party, amount, [[reference, amount]]) });
const note = (extra = {}) => voucher({ guid: "note-1", type: "Credit Note", number: "CN1", amount: "5000", narration: "CD against bill INV/25-26/1", entries: ledger(customer.ledgerName, "5000", [["INV/25-26/1", "5000"]]) + ledger("Cash Discount Allowed", "-5000"), ...extra });
async function check(vouchers, options = {}) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, request) => {
    assert.equal(url, "https://test-tally.invalid", "no real Tally or network access is permitted");
    const body = String(request.body);
    requests.push(body);
    const from = /<SVFROMDATE TYPE="Date">(\d{8})/.exec(body)?.[1];
    const to = /<SVTODATE TYPE="Date">(\d{8})/.exec(body)?.[1];
    const selected = vouchers.filter((value) => { const date = /<DATE>(\d{8})/.exec(value)?.[1]; return !from || (date >= from && date <= to); });
    return new Response(`<ENVELOPE>${body.includes("<TYPE>Ledger</TYPE>") ? "" : selected.join("")}</ENVELOPE>`);
  };
  try {
    const scope = { purpose: "live_cd_evaluation", dateFrom: "2026-03-23", dateTo: "2026-03-24", cdDiscountBasis: "amount_per_tonne", customers: [customer], eligibleStockItemGuids: ["steel"], unitConversions: [{ uomCode: "MT", tonnesPerUnit: "1" }], ...options.scope };
    const context = { config: { tallyUrl: "https://test-tally.invalid" }, activeCompany: { name: "Test Only" }, ...options.context };
    if (options.sync) return await syncVouchers({ payload: { syncRunId: "test-sync", requestedScope: { ...scope, purpose: undefined, customerLedgerName: customer.ledgerName } } }, context);
    if (options.tod) return await fetchLiveTodEvidence({ payload: { voucherScope: { ...scope, purpose: "live_tod_evaluation", paymentCheck: { dueDays: 25, holidays: [], nonWorkingIsoWeekdays: [7], readTo: scope.dateTo } } } }, context);
    const evidence = await fetchLiveCdEvidence({ payload: { voucherScope: scope } }, context, null);
    return { evidence, requests, ...evaluateCashDiscountSettlements(rule, options.evaluatedOn ?? "2026-04-10", evidence.invoices, evidence.customerCredits) };
  } finally { globalThis.fetch = originalFetch; }
}

test("a manual CD allocated to the invoice is recognized without app narration", async () => {
  const result = await check([sale(), receipt(), note()]);
  assert.equal(result.results[0].alreadyCredited, "5000.00");
  assert.equal(result.results[0].status, "credited");
  assert.equal(result.candidates.length, 0);
});

test("an accounting Credit Note with no party header is found through its customer ledger", async () => {
  const result = await check([sale(), receipt(), note({ party: "" })]);
  assert.equal(result.results[0].status, "credited");
  assert.equal(result.candidates.length, 0);
});

test("a partial existing CD is kept for review and cannot generate another note", async () => {
  const result = await check([sale(), receipt(), note({ amount: "2000", entries: ledger(customer.ledgerName, "2000", [["INV/25-26/1", "2000"]]) + ledger("Cash Discount Allowed", "-2000") })]);
  assert.equal(result.results[0].alreadyCredited, "2000.00");
  assert.equal(result.results[0].status, "credit_note_review");
  assert.equal(result.candidates.length, 0);
});

test("an unrelated adjustment does not become an already-given Cash Discount", async () => {
  const result = await check([sale(), receipt("75000"), note({ amount: "20000", narration: "Rate difference against invoice", entries: ledger(customer.ledgerName, "20000", [["INV/25-26/1", "20000"]]) + ledger("Rate Difference", "-20000") })]);
  assert.equal(result.results[0].alreadyCredited, "0.00");
  assert.equal(result.results[0].adjustmentByDeadline, "20000.00");
  assert.equal(result.results[0].category, "discounted_payment");
  assert.equal(result.candidates[0].creditAmount, "5000.00");
});

test("one CD note allocated to two invoices uses each allocation, not the whole note twice", async () => {
  const result = await check([sale(), sale("INV/25-26/2", "invoice-2"), receipt(), receipt("95000", "INV/25-26/2"), note({ amount: "10000", narration: "Cash discount for both bills", entries: ledger(customer.ledgerName, "10000", [["INV/25-26/1", "5000"], ["INV/25-26/2", "5000"]]) + ledger("Cash Discount Allowed", "-10000") })]);
  assert.deepEqual(result.results.map((row) => row.alreadyCredited), ["5000.00", "5000.00"]);
  assert.equal(result.candidates.length, 0);
});

test("discount ledger identifies a manual note with no CD wording", async () => {
  const result = await check([sale(), receipt(), note({ narration: "Allowed against the bill" })]);
  assert.equal(result.results[0].status, "credited");
});

test("a direct invoice GUID works even without a bill name", async () => {
  const result = await check([sale(), receipt(), note({ entries: ledger(customer.ledgerName, "5000", [["", "5000", "Agst Ref", "invoice-1"]]) + ledger("Cash Discount Allowed", "-5000") })]);
  assert.equal(result.results[0].alreadyCredited, "5000.00");
  assert.equal(result.results[0].creditNoteReferences[0].matchedBy, "invoice_guid");
});

test("Tally's source VoucherNumber inside an allocation never overrides its bill NAME", async () => {
  const receiptXml = receipt().replace("<NAME>INV/25-26/1</NAME>", "<NAME>INV/25-26/1</NAME><VOUCHERNUMBER>R1</VOUCHERNUMBER>");
  const noteXml = note().replace("<NAME>INV/25-26/1</NAME>", "<NAME>INV/25-26/1</NAME><VOUCHERNUMBER>CN1</VOUCHERNUMBER>");
  const result = await check([sale(), receiptXml, noteXml]);
  assert.equal(result.results[0].paidByDeadline, "95000.00");
  assert.equal(result.results[0].alreadyCredited, "5000.00");
  assert.equal(result.candidates.length, 0);
});

test("two equal allocations in one receipt are distinct, not a duplicate alias match", async () => {
  const payment = voucher({ guid: "split-receipt", type: "Receipt", number: "R2", amount: "95000", entries: ledger(customer.ledgerName, "95000", [["INV/25-26/1", "47500"], ["INV/25-26/1", "47500"]]) });
  const result = await check([sale(), payment, note()]);
  assert.equal(result.results[0].paidByDeadline, "95000.00");
  assert.equal(result.results[0].status, "credited");
});

test("the standard LEDGERENTRIES export is handled with the same allocation ownership", async () => {
  const result = await check([sale(), receipt(), note()].map((value) => value.replaceAll("ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST")));
  assert.equal(result.results[0].status, "credited");
  assert.equal(result.candidates.length, 0);
});

test("conflicting target GUID never falls back to a same-number bill", async () => {
  const result = await check([sale(), receipt(), note({ entries: ledger(customer.ledgerName, "5000", [["INV/25-26/1", "5000", "Agst Ref", "different-invoice"]]) + ledger("Cash Discount Allowed", "-5000") })]);
  assert.equal(result.results[0].alreadyCredited, "0.00");
  assert.equal(result.results[0].status, "ready");
});

test("same-number notes and receipts for another customer never affect this invoice", async () => {
  const wrongNote = note({ party: "Other Customer", entries: ledger("Other Customer", "5000", [["INV/25-26/1", "5000"]]) + ledger("Cash Discount Allowed", "-5000") });
  const result = await check([sale(), receipt("95000", "INV/25-26/1", "Other Customer"), wrongNote]);
  assert.equal(result.results[0].paidByDeadline, "0.00");
  assert.equal(result.results[0].alreadyCredited, "0.00");
  assert.equal(result.candidates.length, 0);
});

test("allocation ownership prevents a different customer's ledger from being borrowed", async () => {
  const result = await check([sale(), receipt(), note({ entries: ledger("Other Customer", "5000", [["INV/25-26/1", "5000"]]) + ledger(customer.ledgerName, "0") + ledger("Cash Discount Allowed", "-5000") })]);
  assert.equal(result.results[0].alreadyCredited, "0.00");
});

test("the stable customer GUID survives a renamed ledger", async () => {
  const result = await check([sale(), receipt(), note({ party: "Old customer name", partyGuid: customer.customerId, entries: ledger("Old customer name", "5000", [["INV/25-26/1", "5000"]], customer.customerId) + ledger("Cash Discount Allowed", "-5000") })]);
  assert.equal(result.results[0].status, "credited");
});

test("a cancelled note does not block a genuinely uncredited invoice", async () => {
  const result = await check([sale(), receipt(), note({ cancelled: true })]);
  assert.equal(result.results[0].alreadyCredited, "0.00");
  assert.equal(result.candidates.length, 1);
});

test("an unclear generic discount note requires review, with no new candidate", async () => {
  const result = await check([sale(), receipt(), note({ narration: "Discount adjustment", entries: ledger(customer.ledgerName, "5000", [["INV/25-26/1", "5000"]]) + ledger("Sales Discount", "-5000") })]);
  assert.equal(result.results[0].alreadyCredited, "0.00");
  assert.equal(result.results[0].status, "credit_note_review");
  assert.equal(result.candidates.length, 0);
});

test("a linked inventory return requires quantity review and is not a CD", async () => {
  const result = await check([sale(), receipt(), note({ inventory, narration: "Goods returned" })]);
  assert.equal(result.results[0].alreadyCredited, "0.00");
  assert.equal(result.results[0].status, "credit_note_review");
  assert.equal(result.results[0].creditNoteReferences[0].purpose, "sales_return");
  assert.equal(result.candidates.length, 0);
});

test("an on-account note accepts different wording but an exact complete invoice reference", async () => {
  const entries = ledger(customer.ledgerName, "5000", [["", "5000", "On Account"]]) + ledger("Cash Discount Allowed", "-5000");
  const result = await check([sale(), receipt(), note({ narration: "c.d. for invoice: INV/25-26/1.", entries })]);
  assert.equal(result.results[0].status, "credited");
  assert.equal(result.evidence.customerCredits.length, 0, "the same CD cannot also fund another invoice as free credit");
  assert.equal(result.results[0].creditNoteReferences[0].matchedBy, "narration");
});

test("an unlinked on-account CD is visible for review, never guessed by amount", async () => {
  const result = await check([sale(), receipt(), note({ narration: "CD allowed", entries: ledger(customer.ledgerName, "5000", [["", "5000", "On Account"]]) + ledger("Cash Discount Allowed", "-5000") })]);
  assert.equal(result.results[0].alreadyCredited, "0.00");
  assert.equal(result.results[0].status, "credit_note_review");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.results[0].creditNoteReferences[0].noteAmount, "5000.00");
});

test("a backdated note linked to this invoice is reviewed instead of silently ignored", async () => {
  const result = await check([sale(), receipt(), note({ date: "20260322" })], { scope: { dateFrom: "2026-03-22" } });
  assert.equal(result.results[0].status, "credit_note_review");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.results[0].creditNoteReferences[0].noteAmount, "5000.00");
});

test("invoice 1 is never treated as a narration match for invoice 10", async () => {
  const result = await check([sale(), receipt(), note({ narration: "Cash discount for INV/25-26/10", entries: ledger(customer.ledgerName, "5000", [["", "5000", "On Account"]]) + ledger("Cash Discount Allowed", "-5000") })]);
  assert.equal(result.results[0].alreadyCredited, "0.00");
  assert.equal(result.results[0].creditNoteReferences[0].matchedBy, "unresolved");
});

test("duplicate bill names within a customer require review instead of double credit", async () => {
  const result = await check([sale(), sale("INV/25-26/1", "other-year-invoice"), receipt(), note()]);
  assert.deepEqual(result.results.map((row) => row.alreadyCredited), ["0.00", "0.00"]);
  assert.ok(result.results.every((row) => row.status === "credit_note_review"));
  assert.equal(result.candidates.length, 0);
});

test("a prior-year invoice recognizes a CD booked after the financial year ends", async () => {
  const result = await check([sale(), receipt(), note({ date: "20260402" })], { scope: { dateTo: "2026-04-02", invoiceDateTo: "2026-03-31" } });
  assert.equal(result.results[0].status, "credited");
  assert.equal(result.results[0].creditNoteReferences[0].voucherDate, "2026-04-02");
});

test("later non-CD adjustments do not make a late settlement count on time", async () => {
  const result = await check([sale(), receipt("75000"), note({ amount: "20000", date: "20260402", narration: "Rate difference", entries: ledger(customer.ledgerName, "20000", [["INV/25-26/1", "20000"]]) + ledger("Rate Difference", "-20000") })], { scope: { dateTo: "2026-04-02" } });
  assert.equal(result.results[0].adjustmentByDeadline, "0.00");
  assert.equal(result.results[0].category, "not_eligible");
  assert.equal(result.candidates.length, 0);
});

test("over-credited or excessive allocations cannot produce another credit", async () => {
  for (const amount of ["6000", "120000"]) {
    const result = await check([sale(), receipt(), note({ amount: "6000", entries: ledger(customer.ledgerName, "6000", [["INV/25-26/1", amount]]) + ledger("Cash Discount Allowed", "-6000") })]);
    assert.equal(result.results[0].status, "credit_note_review");
    assert.equal(result.candidates.length, 0);
  }
});

test("restarting from a completed checkpoint preserves matches and never counts a note twice", async () => {
  let saved = null;
  const checkpoint = { load: () => structuredClone(saved), save: (state) => { saved = structuredClone(state); } };
  const before = await check([sale(), receipt(), note(), note()], { context: { checkpoint } });
  const after = await check([], { context: { checkpoint } });
  assert.equal(before.results[0].alreadyCredited, "5000.00");
  assert.deepEqual(after.results, before.results);
  assert.equal(after.requests.length, 0);
});

test("a targeted lookup retains an accounting note with no party header", async () => {
  const result = await check([note({ party: "" })], { sync: true });
  assert.equal(result.vouchers.length, 1);
  assert.equal(result.queryMode, "targeted");
  assert.equal(result.vouchers[0].billAllocations[0].ledgerName, customer.ledgerName);
});

test("TOD uses the same manual CD match and does not count the note twice", async () => {
  const result = await check([sale(), receipt(), note()], { tod: true });
  const payment = result.customerAggregates[0].paymentChecks[0];
  assert.equal(payment.counted, true);
  assert.equal(payment.invoiceAmount, "95000");
  assert.equal(payment.creditNotes[0].amount, "5000");
});

test("TOD respects the date of a non-CD adjustment", async () => {
  const result = await check([sale(), receipt("95000"), note({ date: "20260420", narration: "Rate difference", entries: ledger(customer.ledgerName, "5000", [["INV/25-26/1", "5000"]]) + ledger("Rate Difference", "-5000") })], { tod: true, scope: { dateTo: "2026-04-20" } });
  const payment = result.customerAggregates[0].paymentChecks[0];
  assert.equal(payment.counted, false);
  assert.equal(payment.paidInFullOn, "2026-04-20");
});

test("a CD note with three allocations and five named bills holds both narration-only invoices", async () => {
  const serials = ["5854", "6016", "6405", "7206", "8714", "8724", "500", "72060"];
  const numbers = serials.map(serial => "MUI/25-26/" + serial);
  const vouchers = numbers.flatMap((number, i) => [sale(number, "bill-" + serials[i]), receipt("95000", number)]);
  const bills = [[numbers[0], "8920"], [numbers[1], "2750"], [numbers[2], "2795"]];
  const cd = note({ number: "182", amount: "14465", narration: "Being Cash Discount allowed to party vide B.No.5854, 6016, 6405,7206 & 8714 (28.930 x 500/-)", entries: ledger(customer.ledgerName, "14465", bills) + ledger("Discount Allowed", "-14465") });
  const result = await check([...vouchers, cd]);
  const rows = new Map(result.results.map(row => [row.invoiceNumber, row]));
  for (const number of numbers.slice(3, 5)) {
    const row = rows.get(number);
    assert.equal(row.status, "credit_note_review");
    assert.equal(row.alreadyCredited, "0.00");
    assert.equal(row.creditNoteReferences[0].voucherNumber, "182");
    assert.equal(row.creditNoteReferences[0].matchedBy, "narration");
    assert.ok(!result.candidates.some(candidate => candidate.invoiceGuid === row.invoiceGuid));
  }
  for (const number of numbers.slice(5)) assert.equal(rows.get(number).status, "ready");
  assert.deepEqual(numbers.slice(0, 3).map(n => rows.get(n).alreadyCredited), ["8920.00", "2750.00", "2795.00"]);
});
for (const paymentDate of ["20260322", "20260323"]) {
  test(`CD and TOD count the applied part of an advance dated ${paymentDate} and its linked settlement journal`, async () => {
    const number = "S1";
    const inv = voucher({ guid: "s", type: "Sales", number, amount: "100000", date: "20260323", inventory,
      entries: ledger(customer.ledgerName, "-100000", [["ADV-17", "-95000", "Agst Ref"], [number, "-5000", "New Ref"]]) });
    const pay = voucher({ guid: "r", type: "Receipt", number: "17", amount: "99000", date: paymentDate,
      entries: ledger(customer.ledgerName, "99000", [["ADV-17", "99000", "Advance"]]) });
    const journal = voucher({ guid: "j", type: "Journal", number: "6", amount: "5000", date: "20260323",
      entries: ledger(customer.ledgerName, "5000", [[number, "5000"]]) + ledger("Mintifi", "-5000") });
    const rows = [inv, pay, journal];
    const cd = await check(rows);
    assert.equal(cd.results[0].paidByDeadline, "100000.00");
    const tod = (await check(rows, { tod: true })).customerAggregates[0].paymentChecks[0];
    assert.equal(tod.reason, "paid_in_full_on_time");
    assert.equal(tod.paidByDueDate, "100000");
    assert.deepEqual(tod.payments.map(p => p.amount).sort(), ["5000", "95000"]);
  });
}

test("ambiguous advance references never pay an invoice twice", async () => {
  const inv = voucher({ guid: "s", type: "Sales", number: "S", amount: "100000", date: "20260323", inventory,
    entries: ledger(customer.ledgerName, "-100000", [["ADV", "-100000", "Agst Ref"]]) });
  const receipts = ["1","2"].map(guid => voucher({ guid, type: "Receipt", number: guid, amount: "100000", date: "20260322",
    entries: ledger(customer.ledgerName, "100000", [["ADV", "100000", "New Ref"]]) }));
  const rows = [inv, ...receipts];
  const ambiguous = await check(rows);
  assert.equal(ambiguous.results[0].paidByDeadline, "0.00");
  assert.equal(ambiguous.results[0].category, "needs_review");
  assert.equal(ambiguous.candidates.length, 0);
  assert.equal((await check(rows, { tod: true })).customerAggregates[0].paymentChecks[0].paidByDueDate, "0");
});

for (const [total, bank, balance] of [
  ["702244", "689814.28", "12429.72"],
  ["577888", "567659.38", "10228.62"],
  ["231973", "227867.08", "4105.92"],
]) {
  test(`full bill draw reconciles bank advance and journal for ${total}`, async () => {
    const number = "S1", date = "20260323";
    const sale = voucher({ guid: "s", type: "Sales", number, date, amount: total, inventory,
      entries: ledger(customer.ledgerName, "-" + total, [[number, "-" + total, "Agst Ref"]]) });
    const receipt = voucher({ guid: "r", type: "Receipt", number: "17", date, amount: bank,
      entries: ledger(customer.ledgerName, bank, [[number, bank, "New Ref"]]) });
    const journal = voucher({ guid: "j", type: "Journal", number: "6", date, amount: balance,
      entries: ledger(customer.ledgerName, balance, [[number, balance]]) + ledger("Finance", "-" + balance) });
    const row = (await check([sale, receipt, journal])).results[0];
    assert.equal(row.paidByDeadline, total + ".00");
    assert.equal(row.category, "full_payment");
    assert.equal((await check([sale, receipt])).results[0].paidByDeadline, bank.includes(".") ? bank : bank + ".00");
  });
}

test("posting detects a newly entered manual Cash Discount before importing a voucher", async () => {
  const pending = {
    noteKind: "credit_note", party: { name: customer.ledgerName, guid: customer.customerId },
    company: { guid: "company", name: "Test Only" }, voucherType: { name: "Credit Note" },
    debitNoteDate: "2026-03-25", amount: "5000", calculationReference: "CN-CD-1",
    sourceInvoice: { guid: "invoice-1", number: "INV/25-26/1" }, cashDiscount: { invoiceDate: "2026-03-23" },
    allocation: { reference: "CN-CD-1" }, gstNote: { discountLedger: { name: "Discount" }, taxLines: [] },
  };
  const original = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async (_url, request) => {
    const body = String(request.body);
    assert.doesNotMatch(body, /Import Data/);
    reads++;
    return new Response("<ENVELOPE><COLLECTION>" + (body.includes("Meenakshi CD CreditNote") ? note() : "") + "</COLLECTION></ENVELOPE>");
  };
  try {
    await assert.rejects(createOrRecoverDebitNote({ payload: { debitNote: pending } },
      { config: { tallyUrl: "https://test-tally.invalid" } }), /Review Tally Credit Note CN1/);
    assert.equal(reads, 2);
  } finally { globalThis.fetch = original; }
});

test("a same-day New Ref receipt and a deadline receipt settle a multi-reference invoice", async () => {
  const number = "MUI/25-26/5663";
  const inv = voucher({ guid: "sale", type: "Sales", number, date: "20250827", amount: "443433", inventory: inventory.replace("10 MT", "7.82 MT"),
    entries: ledger(customer.ledgerName, "-443433", [["22082025", "-10566", "Agst Ref"], [number, "-432867", "Agst Ref"]]) });
  const advance = voucher({ guid: "r704", type: "Receipt", number: "704", date: "20250827", amount: "240000",
    entries: ledger(customer.ledgerName, "240000", [[number, "240000", "New Ref"]]) });
  const balance = voucher({ guid: "r762", type: "Receipt", number: "762", date: "20250830", amount: "203433",
    entries: ledger(customer.ledgerName, "203433", [[number, "203433"]]) });
  const result = await check([inv, advance, balance], {scope: {dateFrom: "2025-08-27", dateTo: "2025-08-30"}});
  const row = result.results[0];
  assert.deepEqual(row.payments.map(p => p.voucherNumber), ["704", "762"]);
  assert.equal(row.paidByDeadline, "443433.00");
  assert.equal(row.category, "full_payment");
  assert.equal(row.creditAmount, "3910.00");
});
