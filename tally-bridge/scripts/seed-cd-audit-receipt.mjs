import { loadConfig } from "../src/config.mjs";
import { probeActiveCompany } from "../src/tally/company-probe.mjs";
import { buildCollectionExportXml, escapeXml, getTagText, postTallyXml } from "../src/tally/xml.mjs";
import { parseVouchers } from "../src/tally/vouchers.mjs";

const TEST_COMPANY = "Solution Nyx";
const TEST_DATE = "2026-08-20";
const PARTY = "Apex Rebar Projects";
const BILL_REFERENCE = "APX-UX-TEST-104";
const AMOUNT = "9000";
const RECEIPT_LEDGER = "Cash";
const REFERENCE = "MEENAKSHI-CD-AUDIT-APX-UX-TEST-104-ONTIME";

function compactDate(value) {
  return value.replaceAll("-", "");
}

function buildReceiptXml(companyName) {
  return [
    "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>",
    "<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>", escapeXml(companyName),
    "</SVCURRENTCOMPANY><SVFROMDATE TYPE=\"Date\">", compactDate(TEST_DATE), "</SVFROMDATE><SVTODATE TYPE=\"Date\">", compactDate(TEST_DATE),
    "</SVTODATE><SVCURRENTDATE TYPE=\"Date\">", compactDate(TEST_DATE), "</SVCURRENTDATE></STATICVARIABLES></DESC>",
    "<DATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER VCHTYPE=\"Receipt\" ACTION=\"Create\" OBJVIEW=\"Accounting Voucher View\">",
    "<DATE>", compactDate(TEST_DATE), "</DATE><EFFECTIVEDATE>", compactDate(TEST_DATE), "</EFFECTIVEDATE>",
    "<VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><REFERENCE>", escapeXml(REFERENCE), "</REFERENCE><NARRATION>", escapeXml(REFERENCE), "</NARRATION>",
    "<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><ISOPTIONAL>No</ISOPTIONAL>",
    "<ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(PARTY), "</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-", AMOUNT,
    "</AMOUNT><BILLALLOCATIONS.LIST><NAME>", escapeXml(BILL_REFERENCE), "</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>-", AMOUNT,
    "</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(RECEIPT_LEDGER),
    "</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>", AMOUNT, "</AMOUNT></ALLLEDGERENTRIES.LIST>",
    "</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>",
  ].join("");
}

async function readReceipt(config, companyName) {
  const xml = buildCollectionExportXml({
    collectionName: "Meenakshi CD Audit Receipt",
    tallyType: "Voucher",
    fetchFields: "Date,VoucherTypeName,VoucherNumber,GUID,Reference,Narration,PartyLedgerName,VoucherAmount,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount",
    companyName,
    dateFrom: TEST_DATE,
    dateTo: TEST_DATE,
  });
  const response = await postTallyXml(config.tallyUrl, xml, { timeoutMs: 90_000, operation: "Read CD audit receipt" });
  return parseVouchers(response).find((voucher) => voucher.voucherKind === "receipt" && voucher.narration === REFERENCE);
}

const config = loadConfig();
const activeCompany = await probeActiveCompany(config.tallyUrl);
if (activeCompany.name !== TEST_COMPANY) throw new Error(`Refusing to create the audit receipt in ${activeCompany.name}. Open ${TEST_COMPANY} in Tally Prime.`);

const existing = await readReceipt(config, activeCompany.name);
console.log(JSON.stringify({ company: activeCompany.name, reference: REFERENCE, existing: Boolean(existing), date: TEST_DATE, party: PARTY, billReference: BILL_REFERENCE, amount: AMOUNT }, null, 2));

if (!process.argv.includes("--apply")) {
  console.log(existing ? "Receipt already exists; no change needed." : "Dry run only. Re-run with --apply to create the receipt.");
  process.exit(0);
}

if (!existing) {
  const response = await postTallyXml(config.tallyUrl, buildReceiptXml(activeCompany.name), { timeoutMs: 90_000, operation: `Create ${REFERENCE}` });
  const created = Number(getTagText(response, "CREATED") ?? "0");
  const errors = Number(getTagText(response, "ERRORS") ?? "0");
  if (created !== 1 || errors) throw new Error(`${REFERENCE} was not created. Tally reported created=${created}, errors=${errors}.`);
}

const verified = await readReceipt(config, activeCompany.name);
if (!verified) throw new Error(`Tally read-back could not find ${REFERENCE}.`);
console.log(JSON.stringify({ verified: { voucherNumber: verified.voucherNumber, date: verified.voucherDate, party: verified.partyLedgerName, narration: verified.narration, allocations: verified.billAllocations } }, null, 2));
