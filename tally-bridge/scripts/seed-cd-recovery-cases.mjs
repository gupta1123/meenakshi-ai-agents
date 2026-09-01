import { loadConfig } from "../src/config.mjs";
import { probeActiveCompany } from "../src/tally/company-probe.mjs";
import { buildCollectionExportXml, escapeXml, getTagText, postTallyXml } from "../src/tally/xml.mjs";
import { parseVouchers } from "../src/tally/vouchers.mjs";

const TEST_COMPANY = "Solution Nyx";
const STOCK_ITEM = "M S Scrap & Sponge Iron";
const SALES_LEDGER = "Meenakshi TOD Test Sales";
const UNIT = "MTS";
const RATE = 985;
const INVOICE_DATE = "2026-08-11";
const READ_THROUGH_DATE = "2026-08-18";

const cases = [
  { key: "UNPAID-APEX", party: "Apex Rebar Projects", quantity: 50 },
  { key: "UNPAID-BALAJI", party: "Balaji Rebar Projects", quantity: 100 },
  { key: "ONTIME-BHARATH", party: "Bharath Rebar Projects", quantity: 90, receiptDate: "2026-08-14" },
  { key: "LATE-DECCAN", party: "Deccan Rebar Projects", quantity: 80, receiptDate: "2026-08-18" },
];

function compactDate(value) {
  return value.replaceAll("-", "");
}

function invoiceReference(testCase) {
  return `MEENAKSHI-CD-RECOVERY-${testCase.key}`;
}

function narration(testCase) {
  return `${invoiceReference(testCase)} | Cash Discount 1% within 4 working days`;
}

function receiptReference(testCase) {
  return `${invoiceReference(testCase)}-RECEIPT`;
}

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
    "<VOUCHER VCHTYPE=\"Sales\" ACTION=\"Create\" OBJVIEW=\"Invoice Voucher View\"><DATE>", compactDate(INVOICE_DATE), "</DATE><EFFECTIVEDATE>", compactDate(INVOICE_DATE),
    "</EFFECTIVEDATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><REFERENCE>", escapeXml(reference), "</REFERENCE><REFERENCEDATE>", compactDate(INVOICE_DATE),
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
  return envelope(companyName, INVOICE_DATE, voucher);
}

function buildReceiptXml(companyName, testCase) {
  const reference = receiptReference(testCase);
  const amount = String(testCase.quantity * RATE);
  const voucher = [
    "<VOUCHER VCHTYPE=\"Receipt\" ACTION=\"Create\" OBJVIEW=\"Accounting Voucher View\"><DATE>", compactDate(testCase.receiptDate), "</DATE><EFFECTIVEDATE>", compactDate(testCase.receiptDate),
    "</EFFECTIVEDATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><REFERENCE>", escapeXml(reference), "</REFERENCE><NARRATION>", escapeXml(reference),
    "</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><ISOPTIONAL>No</ISOPTIONAL>",
    "<ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(testCase.party), "</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-", amount,
    "</AMOUNT><BILLALLOCATIONS.LIST><NAME>", escapeXml(invoiceReference(testCase)), "</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>-", amount,
    "</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>", amount,
    "</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>",
  ].join("");
  return envelope(companyName, testCase.receiptDate, voucher);
}

async function readCases(config, companyName) {
  const xml = buildCollectionExportXml({
    collectionName: "Meenakshi CD Recovery Test Cases",
    tallyType: "Voucher",
    fetchFields: "Date,VoucherTypeName,VoucherNumber,GUID,Narration,PartyLedgerName,VoucherAmount,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount",
    companyName,
    dateFrom: INVOICE_DATE,
    dateTo: READ_THROUGH_DATE,
  });
  const response = await postTallyXml(config.tallyUrl, xml, { timeoutMs: 90_000, operation: "Read Cash Discount recovery test cases" });
  return parseVouchers(response).filter((voucher) => voucher.narration.startsWith("MEENAKSHI-CD-RECOVERY-"));
}

async function createVoucher(config, companyName, testCase) {
  const reference = invoiceReference(testCase);
  const response = await postTallyXml(config.tallyUrl, buildSalesXml(companyName, testCase), { timeoutMs: 90_000, operation: `Create ${reference}` });
  const created = Number(getTagText(response, "CREATED") ?? "0");
  const errors = Number(getTagText(response, "ERRORS") ?? "0");
  const lineError = getTagText(response, "LINEERROR");
  if (created !== 1 || errors) throw new Error(`${reference} failed: created=${created}, errors=${errors}${lineError ? `, ${lineError}` : ""}`);
}

const config = loadConfig();
const activeCompany = await probeActiveCompany(config.tallyUrl);
if (activeCompany.name !== TEST_COMPANY) throw new Error(`Refusing to seed test cases in ${activeCompany.name}. Open ${TEST_COMPANY} in Tally Prime.`);

let existing = await readCases(config, activeCompany.name);
const existingNarrations = new Set(existing.map((voucher) => voucher.narration));
const pending = cases.filter((testCase) => !existingNarrations.has(narration(testCase)));
const pendingReceipts = cases.filter((testCase) => testCase.receiptDate && !existingNarrations.has(receiptReference(testCase)));
console.log(JSON.stringify({
  company: activeCompany.name,
  invoiceDate: INVOICE_DATE,
  evaluateAsOf: "2026-08-18",
  pendingInvoices: pending.map(invoiceReference),
  pendingReceipts: pendingReceipts.map(receiptReference),
}, null, 2));

if (!process.argv.includes("--apply")) {
  console.log("Dry run only. Re-run with --apply to create the missing recovery test invoices.");
  process.exit(0);
}

for (const testCase of pending) {
  await createVoucher(config, activeCompany.name, testCase);
  console.log(`Created ${invoiceReference(testCase)}.`);
}
for (const testCase of pendingReceipts) {
  const reference = receiptReference(testCase);
  const response = await postTallyXml(config.tallyUrl, buildReceiptXml(activeCompany.name, testCase), { timeoutMs: 90_000, operation: `Create ${reference}` });
  const created = Number(getTagText(response, "CREATED") ?? "0");
  const errors = Number(getTagText(response, "ERRORS") ?? "0");
  const lineError = getTagText(response, "LINEERROR");
  if (created !== 1 || errors) throw new Error(`${reference} failed: created=${created}, errors=${errors}${lineError ? `, ${lineError}` : ""}`);
  console.log(`Created ${reference}.`);
}

existing = await readCases(config, activeCompany.name);
const verifiedNarrations = new Set(existing.map((voucher) => voucher.narration));
const missing = [
  ...cases.filter((testCase) => !verifiedNarrations.has(narration(testCase))).map(invoiceReference),
  ...cases.filter((testCase) => testCase.receiptDate && !verifiedNarrations.has(receiptReference(testCase))).map(receiptReference),
];
if (missing.length) throw new Error(`Tally read-back could not find: ${missing.join(", ")}`);

console.log(JSON.stringify({
  verified: existing.map((voucher) => ({
    narration: voucher.narration,
    party: voucher.partyLedgerName,
    amount: voucher.grossAmount,
    billReferences: voucher.billReferences,
  })),
}, null, 2));
