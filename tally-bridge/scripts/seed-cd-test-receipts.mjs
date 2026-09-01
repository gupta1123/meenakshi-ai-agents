import { loadConfig } from "../src/config.mjs";
import { probeActiveCompany } from "../src/tally/company-probe.mjs";
import { buildCollectionExportXml, escapeXml, getTagText, postTallyXml } from "../src/tally/xml.mjs";
import { parseVouchers } from "../src/tally/vouchers.mjs";

const TEST_COMPANY = "Solution Nyx";
const TEST_DATE = "2026-08-14";
const RECEIPT_LEDGER = "Cash";
const cases = [
  { key: "INV-55-QUALIFIED-AGST", party: "Apex Rebar Projects", invoiceNumber: "55", billReference: "MEENAKSHI-TOD-TEST-TRACKING-050", amount: "49500" },
  { key: "INV-56-QUALIFIED-AGST", party: "Balaji Rebar Projects", invoiceNumber: "56", billReference: "MEENAKSHI-TOD-TEST-TIER1-100", amount: "99000" },
];

function compactDate(value) { return value.replaceAll("-", ""); }
function referenceFor(testCase) { return `MEENAKSHI-CD-TEST-${testCase.key}`; }

function buildReceiptXml(companyName, testCase) {
  const reference = referenceFor(testCase);
  return [
    "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>",
    "<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>", escapeXml(companyName),
    "</SVCURRENTCOMPANY><SVFROMDATE TYPE=\"Date\">", compactDate(TEST_DATE), "</SVFROMDATE><SVTODATE TYPE=\"Date\">", compactDate(TEST_DATE),
    "</SVTODATE><SVCURRENTDATE TYPE=\"Date\">", compactDate(TEST_DATE), "</SVCURRENTDATE></STATICVARIABLES></DESC>",
    "<DATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER VCHTYPE=\"Receipt\" ACTION=\"Create\" OBJVIEW=\"Accounting Voucher View\">",
    "<DATE>", compactDate(TEST_DATE), "</DATE><EFFECTIVEDATE>", compactDate(TEST_DATE), "</EFFECTIVEDATE>",
    "<VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><REFERENCE>", escapeXml(reference), "</REFERENCE><NARRATION>", escapeXml(reference), "</NARRATION>",
    "<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><ISOPTIONAL>No</ISOPTIONAL>",
    "<ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(testCase.party), "</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-", testCase.amount,
    "</AMOUNT><BILLALLOCATIONS.LIST><NAME>", escapeXml(testCase.billReference), "</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>-", testCase.amount,
    "</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>",
    "<ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(RECEIPT_LEDGER), "</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>", testCase.amount,
    "</AMOUNT></ALLLEDGERENTRIES.LIST>",
    "</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>",
  ].join("");
}

async function readTestReceipts(config, activeCompany) {
  const xml = buildCollectionExportXml({
    collectionName: "Meenakshi CD Test Receipts",
    tallyType: "Voucher",
    fetchFields: "Date,VoucherTypeName,VoucherNumber,GUID,Narration,PartyLedgerName,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount",
    companyName: activeCompany.name,
    dateFrom: TEST_DATE,
    dateTo: TEST_DATE,
  });
  const response = await postTallyXml(config.tallyUrl, xml, { timeoutMs: 90_000, operation: "Read Meenakshi CD test receipts" });
  return parseVouchers(response).filter((voucher) => voucher.voucherKind === "receipt" && voucher.narration.startsWith("MEENAKSHI-CD-TEST-"));
}

const config = loadConfig();
const activeCompany = await probeActiveCompany(config.tallyUrl);
if (activeCompany.name !== TEST_COMPANY) throw new Error(`Refusing to seed test receipts in ${activeCompany.name}. Open ${TEST_COMPANY} in Tally Prime.`);

const existing = await readTestReceipts(config, activeCompany);
const existingReferences = new Set(existing.map((voucher) => voucher.narration));
const pending = cases.filter((testCase) => !existingReferences.has(referenceFor(testCase)));
console.log(JSON.stringify({ company: activeCompany.name, date: TEST_DATE, pending: pending.map(referenceFor) }, null, 2));

if (!process.argv.includes("--apply")) {
  console.log("Dry run only. Re-run with --apply to create the missing receipts.");
  process.exit(0);
}

for (const testCase of pending) {
  const response = await postTallyXml(config.tallyUrl, buildReceiptXml(activeCompany.name, testCase), { timeoutMs: 90_000, operation: `Create ${referenceFor(testCase)}` });
  const created = Number(getTagText(response, "CREATED") ?? "0");
  const errors = Number(getTagText(response, "ERRORS") ?? "0");
  const lineError = getTagText(response, "LINEERROR");
  if (created !== 1 || errors) {
    console.error(response);
    throw new Error(`${referenceFor(testCase)} was not created. Tally reported created=${created}, errors=${errors}${lineError ? `: ${lineError}` : "."}`);
  }
  console.log(`Created ${referenceFor(testCase)} for ${testCase.party} against invoice ${testCase.invoiceNumber} (${testCase.billReference}).`);
}

const verified = await readTestReceipts(config, activeCompany);
const verifiedReferences = new Set(verified.map((voucher) => voucher.narration));
const missing = cases.map(referenceFor).filter((reference) => !verifiedReferences.has(reference));
if (missing.length) throw new Error(`Tally read-back could not find: ${missing.join(", ")}`);
console.log(JSON.stringify({ verified: verified.map((voucher) => ({ reference: voucher.narration, party: voucher.partyLedgerName, allocations: voucher.billAllocations })) }, null, 2));
