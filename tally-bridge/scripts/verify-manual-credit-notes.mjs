// A repeatable integration check against our local, disposable test company.
// No bridge credentials, cloud API, or client Tally URL is used.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { probeActiveCompany } from "../src/tally/company-probe.mjs";
import { buildCollectionExportXml, escapeXml, getTagText, postTallyXml } from "../src/tally/xml.mjs";
import { parseVouchers } from "../src/tally/vouchers.mjs";

const tallyUrl = "http://localhost:9000";
const company = { name: "Solution Nyx", guid: "6a1e6251-3050-4d46-8ccf-847e223ac92d" };
const party = "Meenakshi Manual Discount Test 054";
const discountLedger = "Meenakshi Manual Cash Discount";
const adjustmentLedger = "Meenakshi Manual Rate Difference";
const salesLedger = "Meenakshi Manual Test Sales 054";
const stockItem = "Meenakshi Manual Test Steel 054";
const marker = "MN-MANUAL-054";
const sourceIndex = process.argv.indexOf("--runtime-source");
const runtime = sourceIndex < 0 ? new URL("../src/", import.meta.url) : pathToFileURL(path.resolve(process.argv[sourceIndex + 1]) + path.sep);
const { fetchLiveCdEvidence } = await import(new URL("commands/live-cd-evidence.mjs", runtime));
const { evaluateCashDiscountSettlements } = await import(new URL("local-cd-settlement-evaluator.mjs", runtime));

async function assertTestCompany() { assert.deepEqual(await probeActiveCompany(tallyUrl), company, "Refusing to use any company other than the local Solution Nyx test company"); }
async function exportData(type, fields, filter) {
  const request = buildCollectionExportXml({ collectionName: "Manual CD Local Test", tallyType: type, fetchFields: fields, companyName: company.name, dateFrom: type === "Voucher" ? "2026-11-01" : undefined, dateTo: type === "Voucher" ? "2026-11-02" : undefined, formulae: filter ? [{ name: "ManualCdTestFilter", formula: filter }] : [], filterNames: filter ? ["ManualCdTestFilter"] : [] });
  return postTallyXml(tallyUrl, request, { timeoutMs: 15000, operation: "Read local test company" });
}
function envelope(content, masters = false) {
  if (!masters) {
    const date = /<DATE>(\d{8})/.exec(content)[1];
    return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company.name)}</SVCURRENTCOMPANY><SVFROMDATE TYPE="Date">${date}</SVFROMDATE><SVTODATE TYPE="Date">${date}</SVTODATE><SVCURRENTDATE TYPE="Date">${date}</SVCURRENTDATE></STATICVARIABLES></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${content}</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  }
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${masters ? "All Masters" : "Vouchers"}</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company.name)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE>${content}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
async function importTest(content, masters = false) {
  await assertTestCompany();
  const result = await postTallyXml(tallyUrl, envelope(content, masters), { timeoutMs: 15000, operation: "Create isolated local test entry" });
  assert.equal(Number(getTagText(result, "ERRORS") || 0), 0);
  assert.equal(Number(getTagText(result, "EXCEPTIONS") || 0), 0, `${getTagText(content, "NARRATION") || "Test master"}: ${result}`);
  assert.equal(Number(getTagText(result, "CREATED") || 0) + (masters ? Number(getTagText(result, "ALTERED") || 0) : 0), 1, `${getTagText(content, "NARRATION") || "Test master"}: ${result}`);
}
async function ledgerExists(name) { return (await exportData("Ledger", "Name,GUID", `$$IsEqual:$Name:"${name}"`)).includes("<LEDGER "); }
function ledger(name, amount, ref = null, type = "Agst Ref", isParty = false) {
  return `<LEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(name)}</LEDGERNAME><ISPARTYLEDGER>${isParty ? "Yes" : "No"}</ISPARTYLEDGER><ISDEEMEDPOSITIVE>${Number(amount) < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE><ISLASTDEEMEDPOSITIVE>${Number(amount) < 0 ? "Yes" : "No"}</ISLASTDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT>${ref ? `<BILLALLOCATIONS.LIST><NAME>${ref}</NAME><BILLTYPE>${type}</BILLTYPE><AMOUNT>${amount}</AMOUNT></BILLALLOCATIONS.LIST>` : ""}</LEDGERENTRIES.LIST>`;
}
function entry(type, date, token, contents, partyHeader = true) {
  const number = token.split(" | ")[0].replace("MN-MANUAL-054-", "N054-");
  return `<VOUCHER VCHTYPE="${type}" ACTION="Create" OBJVIEW="${type === "Sales" ? "Invoice Voucher View" : "Accounting Voucher View"}"><DATE>${date}</DATE><EFFECTIVEDATE>${date}</EFFECTIVEDATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${number}</VOUCHERNUMBER><REFERENCE>${number}</REFERENCE>${partyHeader ? `<PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>` : ""}<NARRATION>${escapeXml(token)}</NARRATION>${type !== "Sales" ? "<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>" : ""}${contents}</VOUCHER>`;
}

await assertTestCompany();
const existing = parseVouchers(await exportData("Voucher", "GUID,Date,VoucherTypeName,VoucherNumber,Narration,PartyLedgerName,VoucherAmount"));
const cases = [{ key: "A", paid: 95000, credit: 5000, purpose: "CD for this bill" }, { key: "B", paid: 95000, credit: 2000, purpose: "Cash discount partly given" }, { key: "C", paid: 75000, credit: 20000, purpose: "Rate difference against this bill" }];
if (process.argv.includes("--seed")) {
  for (const [name, parent] of [[party, "Sundry Debtors"], [discountLedger, "Indirect Expenses"], [adjustmentLedger, "Indirect Expenses"], [salesLedger, "Sales Accounts"]]) if (!await ledgerExists(name)) await importTest(`<LEDGER NAME="${name}" ACTION="Create"><NAME>${name}</NAME><PARENT>${parent}</PARENT><ISBILLWISEON>${name === party ? "Yes" : "No"}</ISBILLWISEON></LEDGER>`, true);
  const itemXml = await exportData("StockItem", "Name,GUID", `$$IsEqual:$Name:"${stockItem}"`);
  if (!itemXml.includes("<STOCKITEM ")) await importTest(`<STOCKITEM NAME="${stockItem}" ACTION="Create"><NAME>${stockItem}</NAME><PARENT>&#4; Primary</PARENT><BASEUNITS>MTS</BASEUNITS><ISBATCHWISEON>No</ISBATCHWISEON></STOCKITEM>`, true);
  for (const item of cases) {
    const ref = `${marker}-${item.key}`;
    const variants = [
      [`${ref}-SALE`, entry("Sales", "20261101", `${ref}-SALE`, `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><VCHENTRYMODE>Item Invoice</VCHENTRYMODE><ISINVOICE>Yes</ISINVOICE>${ledger(party, -100000, ref, "New Ref", true)}<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${escapeXml(stockItem)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>10000/MTS</RATE><AMOUNT>100000</AMOUNT><ACTUALQTY>10 MTS</ACTUALQTY><BILLEDQTY>10 MTS</BILLEDQTY><BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><AMOUNT>100000</AMOUNT><ACTUALQTY>10 MTS</ACTUALQTY><BILLEDQTY>10 MTS</BILLEDQTY></BATCHALLOCATIONS.LIST><ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${salesLedger}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100000</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`) ],
      [`${ref}-RECEIPT`, entry("Receipt", "20261102", `${ref}-RECEIPT`, ledger(party, item.paid, ref, "Agst Ref", true) + ledger("Cash", -item.paid))],
      [`${ref}-NOTE`, entry("Credit Note", "20261102", `${ref}-NOTE | ${item.purpose}`, ledger(party, item.credit, ref, "Agst Ref", true) + ledger(item.key === "C" ? adjustmentLedger : discountLedger, -item.credit), false)],
    ];
    for (const [token, contents] of variants) if (!existing.some((value) => value.narration.includes(token))) await importTest(contents);
  }
}
const masterXml = await exportData("Ledger", "Name,GUID", `$$IsEqual:$Name:"${party}"`);
const customerId = getTagText(masterXml, "GUID");
assert.ok(customerId, "Run this script with --seed to create the isolated local test entries");
const rule = { cdDiscountBasis: "amount_per_tonne", calendar: { nonWorkingIsoWeekdays: [7], activeHolidayDates: [] }, segments: [{ label: "3 days", allowedWorkingDays: 3, amountPerTonne: "500" }], customerSegments: { [customerId]: 0 } };
const command = { payload: { voucherScope: { purpose: "live_cd_evaluation", dateFrom: "2026-11-01", dateTo: "2026-11-02", invoiceDateTo: "2026-11-01", cdDiscountBasis: "amount_per_tonne", customers: [{ customerId, ledgerName: party }], eligibleStockItemNames: [stockItem], unitConversions: [{ uomCode: "MTS", tonnesPerUnit: "1" }] } } };
const run = async () => { await assertTestCompany(); const evidence = await fetchLiveCdEvidence(command, { config: { tallyUrl }, activeCompany: company }, null); return { evidence, ...evaluateCashDiscountSettlements(rule, "2026-11-18", evidence.invoices, evidence.customerCredits) }; };
const result = await run(), repeated = await run();
if (process.argv.includes("--debug")) console.error(JSON.stringify({ customerId, evidence: result.evidence.invoices, results: result.results }, null, 2));
assert.deepEqual(repeated.results, result.results, "Rerunning the reader must give the same result");
assert.equal(result.results.length, 3);
const byCase = (key) => result.results.find((row) => row.billReference === `${marker}-${key}`);
assert.equal(byCase("A").status, "credited");
assert.equal(byCase("A").alreadyCredited, "5000.00");
assert.equal(byCase("B").status, "credit_note_review");
assert.equal(byCase("B").alreadyCredited, "2000.00");
assert.equal(byCase("C").category, "discounted_payment");
assert.equal(byCase("C").alreadyCredited, "0.00");
assert.equal(byCase("C").adjustmentByDeadline, "20000.00");
assert.equal(result.candidates.length, 1);
assert.equal(result.candidates[0].invoiceGuid, byCase("C").invoiceGuid);
console.log(JSON.stringify({ company, tallyUrl, runtime: runtime.pathname, repeatedResultIdentical: true, creditNoteMatchingVersion: result.evidence.creditNoteMatchingVersion, results: result.results, candidates: result.candidates, totals: result.totals }, null, 2));
