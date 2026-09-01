import { loadConfig } from "../src/config.mjs";
import { probeActiveCompany } from "../src/tally/company-probe.mjs";
import { buildCollectionExportXml, escapeXml, getTagText, postTallyXml } from "../src/tally/xml.mjs";
import { parseVouchers } from "../src/tally/vouchers.mjs";

const TEST_COMPANY = "Solution Nyx";
const STOCK_ITEM = "M S Scrap & Sponge Iron";
const SALES_LEDGER = "Meenakshi TOD Test Sales";
const RECEIPT_LEDGER = "Cash";
const UNIT = "MTS";
const RATE = 985;
const DATE_FROM = "2026-07-01";
const DATE_TO = "2026-08-14";

const cases = [
  { key: "ONTIME-HIDDEN", party: "Apex Rebar Projects", invoiceDate: "2026-07-01", quantity: 60, receiptDate: "2026-07-06", receiptAmount: 59_100 },
  { key: "FIRST-WINDOW-MISSED", party: "Balaji Rebar Projects", invoiceDate: "2026-07-01", quantity: 70, receiptDate: "2026-07-15", receiptAmount: 68_950 },
  { key: "FINAL-WINDOW-MISSED", party: "Central India Rebar Projects", invoiceDate: "2026-07-01", quantity: 80 },
];

function compactDate(value) { return value.replaceAll("-", ""); }
function invoiceReference(testCase) { return `MEENAKSHI-CD-CASE-${testCase.key}`; }
function receiptReference(testCase) { return `${invoiceReference(testCase)}-RECEIPT`; }
function narration(testCase) { return `${invoiceReference(testCase)} | Cash Discount 1.5% within 7 working days`; }

function envelope(companyName, date, voucherXml) {
  return [
    "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>",
    "<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>", escapeXml(companyName), "</SVCURRENTCOMPANY><SVFROMDATE TYPE=\"Date\">", compactDate(date),
    "</SVFROMDATE><SVTODATE TYPE=\"Date\">", compactDate(date), "</SVTODATE><SVCURRENTDATE TYPE=\"Date\">", compactDate(date),
    "</SVCURRENTDATE></STATICVARIABLES></DESC><DATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\">", voucherXml,
    "</TALLYMESSAGE></DATA></BODY></ENVELOPE>",
  ].join("");
}

function buildSalesXml(companyName, testCase) {
  const reference = invoiceReference(testCase);
  const amount = String(testCase.quantity * RATE);
  const quantity = `${testCase.quantity}.000 ${UNIT}`;
  const voucher = [
    "<VOUCHER VCHTYPE=\"Sales\" ACTION=\"Create\" OBJVIEW=\"Invoice Voucher View\"><DATE>", compactDate(testCase.invoiceDate), "</DATE><EFFECTIVEDATE>", compactDate(testCase.invoiceDate),
    "</EFFECTIVEDATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><REFERENCE>", escapeXml(reference), "</REFERENCE><REFERENCEDATE>", compactDate(testCase.invoiceDate),
    "</REFERENCEDATE><PARTYLEDGERNAME>", escapeXml(testCase.party), "</PARTYLEDGERNAME><NARRATION>", escapeXml(narration(testCase)),
    "</NARRATION><BASICBASEPARTYNAME>", escapeXml(testCase.party), "</BASICBASEPARTYNAME><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>",
    "<VCHENTRYMODE>Item Invoice</VCHENTRYMODE><ISINVOICE>Yes</ISINVOICE><ISOPTIONAL>No</ISOPTIONAL><DIFFACTUALQTY>No</DIFFACTUALQTY>",
    "<LEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(testCase.party), "</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE><AMOUNT>-", amount,
    "</AMOUNT><BILLALLOCATIONS.LIST><NAME>", escapeXml(reference), "</NAME><BILLTYPE>New Ref</BILLTYPE><BILLCREDITPERIOD>0 Days</BILLCREDITPERIOD><AMOUNT>-", amount,
    "</AMOUNT></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST><ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>", escapeXml(STOCK_ITEM),
    "</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>", String(RATE), "/", UNIT, "</RATE><AMOUNT>", amount,
    "</AMOUNT><ACTUALQTY>", quantity, "</ACTUALQTY><BILLEDQTY>", quantity, "</BILLEDQTY><ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>", escapeXml(SALES_LEDGER),
    "</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>", amount, "</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST></VOUCHER>",
  ].join("");
  return envelope(companyName, testCase.invoiceDate, voucher);
}

function buildReceiptXml(companyName, testCase) {
  const amount = String(testCase.receiptAmount);
  const reference = receiptReference(testCase);
  const voucher = [
    "<VOUCHER VCHTYPE=\"Receipt\" ACTION=\"Create\" OBJVIEW=\"Accounting Voucher View\"><DATE>", compactDate(testCase.receiptDate), "</DATE><EFFECTIVEDATE>", compactDate(testCase.receiptDate),
    "</EFFECTIVEDATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><REFERENCE>", escapeXml(reference), "</REFERENCE><NARRATION>", escapeXml(reference),
    "</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><ISOPTIONAL>No</ISOPTIONAL>",
    "<ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(testCase.party), "</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-", amount,
    "</AMOUNT><BILLALLOCATIONS.LIST><NAME>", escapeXml(invoiceReference(testCase)), "</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>-", amount,
    "</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(RECEIPT_LEDGER),
    "</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>", amount, "</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>",
  ].join("");
  return envelope(companyName, testCase.receiptDate, voucher);
}

async function readCases(config, companyName) {
  const xml = buildCollectionExportXml({
    collectionName: "Meenakshi CD Test Cases",
    tallyType: "Voucher",
    fetchFields: "Date,VoucherTypeName,VoucherNumber,GUID,Narration,PartyLedgerName,VoucherAmount,AllInventoryEntries.StockItemName,AllInventoryEntries.BilledQty,AllInventoryEntries.Amount,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount",
    companyName,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
  });
  const response = await postTallyXml(config.tallyUrl, xml, { timeoutMs: 90_000, operation: "Read Cash Discount test cases" });
  return parseVouchers(response).filter((voucher) => voucher.narration.startsWith("MEENAKSHI-CD-CASE-"));
}

async function createVoucher(config, companyName, description, xml) {
  const response = await postTallyXml(config.tallyUrl, xml, { timeoutMs: 90_000, operation: description });
  const created = Number(getTagText(response, "CREATED") ?? "0");
  const errors = Number(getTagText(response, "ERRORS") ?? "0");
  const lineError = getTagText(response, "LINEERROR");
  if (created !== 1 || errors) throw new Error(`${description} failed: created=${created}, errors=${errors}${lineError ? `, ${lineError}` : ""}`);
}

const config = loadConfig();
const activeCompany = await probeActiveCompany(config.tallyUrl);
if (activeCompany.name !== TEST_COMPANY) throw new Error(`Refusing to seed test cases in ${activeCompany.name}. Open ${TEST_COMPANY} in Tally Prime.`);

let existing = await readCases(config, activeCompany.name);
const narrations = new Set(existing.map((voucher) => voucher.narration));
const pendingInvoices = cases.filter((testCase) => !narrations.has(narration(testCase)));
const pendingReceipts = cases.filter((testCase) => testCase.receiptAmount && !narrations.has(receiptReference(testCase)));
console.log(JSON.stringify({ company: activeCompany.name, pendingInvoices: pendingInvoices.map(invoiceReference), pendingReceipts: pendingReceipts.map(receiptReference) }, null, 2));

if (!process.argv.includes("--apply")) {
  console.log("Dry run only. Re-run with --apply to create the missing test vouchers.");
  process.exit(0);
}

for (const testCase of pendingInvoices) {
  await createVoucher(config, activeCompany.name, `Create ${invoiceReference(testCase)}`, buildSalesXml(activeCompany.name, testCase));
  console.log(`Created invoice case ${invoiceReference(testCase)}.`);
}
for (const testCase of pendingReceipts) {
  await createVoucher(config, activeCompany.name, `Create ${receiptReference(testCase)}`, buildReceiptXml(activeCompany.name, testCase));
  console.log(`Created receipt case ${receiptReference(testCase)}.`);
}

existing = await readCases(config, activeCompany.name);
const verifiedNarrations = new Set(existing.map((voucher) => voucher.narration));
const missing = [...cases.map(narration), ...cases.filter((testCase) => testCase.receiptAmount).map(receiptReference)].filter((value) => !verifiedNarrations.has(value));
if (missing.length) throw new Error(`Tally read-back could not find: ${missing.join(", ")}`);
console.log(JSON.stringify({ verified: existing.map((voucher) => ({ narration: voucher.narration, kind: voucher.voucherKind, party: voucher.partyLedgerName, amount: voucher.grossAmount, allocations: voucher.billAllocations.length })) }, null, 2));
