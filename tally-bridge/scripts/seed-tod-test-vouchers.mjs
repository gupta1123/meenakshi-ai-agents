import { loadConfig } from "../src/config.mjs";
import { probeActiveCompany } from "../src/tally/company-probe.mjs";
import { buildCollectionExportXml, escapeXml, getTagText, postTallyXml } from "../src/tally/xml.mjs";
import { parseVouchers } from "../src/tally/vouchers.mjs";

const TEST_COMPANY = "Solution Nyx";
const TEST_DATE = "2026-08-11";
const STOCK_ITEM = "M S Scrap & Sponge Iron";
const SALES_LEDGER = "Meenakshi TOD Test Sales";
const UNIT = "MTS";
const RATE = 1000;

const cases = [
  { key: "TRACKING-050", voucherType: "Sales", party: "Apex Rebar Projects", quantity: 50 },
  { key: "TIER1-100", voucherType: "Sales", party: "Balaji Rebar Projects", quantity: 100 },
  { key: "TIER2-250", voucherType: "Sales", party: "Bharath Rebar Projects", quantity: 250 },
  { key: "TIER3-500", voucherType: "Sales", party: "Central India Rebar Projects", quantity: 500 },
  { key: "RETURN-BASE-300", voucherType: "Sales", party: "Deccan Rebar Projects", quantity: 300 },
  { key: "RETURN-120", voucherType: "Credit Note", party: "Deccan Rebar Projects", quantity: 120, isReturn: true },
];

function compactDate(value) { return value.replaceAll("-", ""); }
function referenceFor(testCase) { return `MEENAKSHI-TOD-TEST-${testCase.key}`; }

function buildVoucherXml(companyName, testCase) {
  const amount = String(testCase.quantity * RATE);
  const quantity = `${testCase.quantity}.000 ${UNIT}`;
  const lineAmount = `${testCase.isReturn ? "-" : ""}${amount}`;
  const partyAmount = `${testCase.isReturn ? "" : "-"}${amount}`;
  const partyPositive = testCase.isReturn ? "No" : "Yes";
  const salesPositive = testCase.isReturn ? "Yes" : "No";
  const reference = referenceFor(testCase);
  return [
    "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>",
    "<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>", escapeXml(companyName),
    "</SVCURRENTCOMPANY><SVFROMDATE TYPE=\"Date\">", compactDate(TEST_DATE), "</SVFROMDATE><SVTODATE TYPE=\"Date\">", compactDate(TEST_DATE),
    "</SVTODATE><SVCURRENTDATE TYPE=\"Date\">", compactDate(TEST_DATE), "</SVCURRENTDATE></STATICVARIABLES></DESC>",
    "<DATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER VCHTYPE=\"",
    escapeXml(testCase.voucherType), "\" ACTION=\"Create\" OBJVIEW=\"Invoice Voucher View\"><DATE>", compactDate(TEST_DATE), "</DATE><EFFECTIVEDATE>", compactDate(TEST_DATE),
    "</EFFECTIVEDATE><VOUCHERTYPENAME>", escapeXml(testCase.voucherType),
    "</VOUCHERTYPENAME><REFERENCE>", escapeXml(reference), "</REFERENCE><REFERENCEDATE>", compactDate(TEST_DATE),
    "</REFERENCEDATE><PARTYLEDGERNAME>", escapeXml(testCase.party), "</PARTYLEDGERNAME><NARRATION>", escapeXml(reference),
    "</NARRATION><BASICBASEPARTYNAME>", escapeXml(testCase.party), "</BASICBASEPARTYNAME><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>",
    "<VCHENTRYMODE>Item Invoice</VCHENTRYMODE><ISINVOICE>Yes</ISINVOICE><ISOPTIONAL>No</ISOPTIONAL><DIFFACTUALQTY>No</DIFFACTUALQTY>",
    "<LEDGERENTRIES.LIST><LEDGERNAME>",
    escapeXml(testCase.party), "</LEDGERNAME><ISDEEMEDPOSITIVE>", partyPositive,
    "</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><ISLASTDEEMEDPOSITIVE>", partyPositive,
    "</ISLASTDEEMEDPOSITIVE><AMOUNT>", partyAmount, "</AMOUNT><BILLALLOCATIONS.LIST><NAME>", escapeXml(reference),
    "</NAME><BILLTYPE>New Ref</BILLTYPE><BILLCREDITPERIOD>0 Days</BILLCREDITPERIOD><AMOUNT>", partyAmount,
    "</AMOUNT></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST>",
    "<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>", escapeXml(STOCK_ITEM),
    "</STOCKITEMNAME><GSTHSNINFERAPPLICABILITY>Specify Details Here</GSTHSNINFERAPPLICABILITY><GSTHSNNAME>72044900</GSTHSNNAME>",
    "<ISDEEMEDPOSITIVE>", salesPositive, "</ISDEEMEDPOSITIVE><RATE>", String(RATE), "/", UNIT,
    "</RATE><AMOUNT>", lineAmount, "</AMOUNT><ACTUALQTY>", quantity,
    "</ACTUALQTY><BILLEDQTY>", quantity, "</BILLEDQTY>",
    "<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>", escapeXml(SALES_LEDGER), "</LEDGERNAME><ISDEEMEDPOSITIVE>", salesPositive,
    "</ISDEEMEDPOSITIVE><AMOUNT>", lineAmount, "</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>",
    "</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>",
  ].join("");
}

async function readTestVouchers(config, activeCompany) {
  const xml = buildCollectionExportXml({
    collectionName: "Meenakshi TOD Test Vouchers",
    tallyType: "Voucher",
    fetchFields: "Date,VoucherTypeName,VoucherNumber,GUID,Narration,PartyLedgerName,VoucherAmount,AllInventoryEntries.StockItemName,AllInventoryEntries.BilledQty,AllInventoryEntries.Amount,LedgerEntries.InventoryAllocations.StockItemName,LedgerEntries.InventoryAllocations.BilledQty,LedgerEntries.InventoryAllocations.Amount",
    companyName: activeCompany.name,
    dateFrom: TEST_DATE,
    dateTo: TEST_DATE,
  });
  const response = await postTallyXml(config.tallyUrl, xml, { timeoutMs: 90_000, operation: "Read Meenakshi TOD test vouchers" });
  return parseVouchers(response).filter((voucher) => voucher.narration.startsWith("MEENAKSHI-TOD-TEST-"));
}

const config = loadConfig();
const activeCompany = await probeActiveCompany(config.tallyUrl);
if (activeCompany.name !== TEST_COMPANY) {
  throw new Error(`Refusing to seed test vouchers in ${activeCompany.name}. Open ${TEST_COMPANY} in Tally Prime.`);
}

const existing = await readTestVouchers(config, activeCompany);
const existingReferences = new Set(existing.map((voucher) => voucher.narration));
const requestedCase = process.argv.find((argument) => argument.startsWith("--case="))?.slice("--case=".length);
const selectedCases = requestedCase ? cases.filter((testCase) => testCase.key === requestedCase) : cases;
if (requestedCase && selectedCases.length === 0) throw new Error(`Unknown test case: ${requestedCase}`);
const pending = selectedCases.filter((testCase) => !existingReferences.has(referenceFor(testCase)));
console.log(JSON.stringify({ company: activeCompany.name, date: TEST_DATE, existing: existing.length, pending: pending.map((testCase) => referenceFor(testCase)) }, null, 2));

if (!process.argv.includes("--apply")) {
  console.log("Dry run only. Re-run with --apply to create the missing vouchers.");
  process.exit(0);
}

for (const testCase of pending) {
  const response = await postTallyXml(config.tallyUrl, buildVoucherXml(activeCompany.name, testCase), { timeoutMs: 90_000, operation: `Create ${referenceFor(testCase)}` });
  const created = Number(getTagText(response, "CREATED") ?? "0");
  const errors = Number(getTagText(response, "ERRORS") ?? "0");
  const lineError = getTagText(response, "LINEERROR");
  if (created !== 1 || errors) {
    console.error(response);
    throw new Error(`${referenceFor(testCase)} was not created. Tally reported created=${created}, errors=${errors}${lineError ? `: ${lineError}` : "."}`);
  }
  console.log(`Created ${referenceFor(testCase)} for ${testCase.party}.`);
}

const verified = await readTestVouchers(config, activeCompany);
const verifiedReferences = new Set(verified.map((voucher) => voucher.narration));
const missing = selectedCases.map(referenceFor).filter((reference) => !verifiedReferences.has(reference));
if (missing.length) throw new Error(`Tally read-back could not find: ${missing.join(", ")}`);
console.log(JSON.stringify({ verified: verified.length, vouchers: verified.map((voucher) => ({ reference: voucher.narration, type: voucher.voucherTypeName, party: voucher.partyLedgerName, quantity: voucher.inventoryLines[0]?.quantity ?? null, unit: voucher.inventoryLines[0]?.uomCode ?? null })) }, null, 2));
