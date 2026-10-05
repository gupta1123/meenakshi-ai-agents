import { loadConfig } from "../src/config.mjs";
import { probeActiveCompany } from "../src/tally/company-probe.mjs";
import { buildCollectionExportXml, escapeXml, getTagText, postTallyXml } from "../src/tally/xml.mjs";
import { parseVouchers } from "../src/tally/vouchers.mjs";

const COMPANY = "Solution Nyx";
// Tally educational mode accepts voucher entry on the 1st, 2nd, and 31st.
const DATE = "2026-08-31";
const ITEM = "M S Scrap & Sponge Iron";
const LEDGER = "Meenakshi TOD Test Sales";
const UNIT = "MTS";
const RATE = 1000;
const cases = [
  { key: "PUNE-BASE-40", party: "Apex TMT Traders", quantity: 40, type: "Sales" },
  { key: "PUNE-TIER-UP-20", party: "Apex TMT Traders", quantity: 20, type: "Sales" },
  { key: "PUNE-RETURN-15", party: "Apex TMT Traders", quantity: 15, type: "Credit Note", isReturn: true },
];

const compact = (value) => value.replaceAll("-", "");
const reference = (test) => `MEENAKSHI-TOD-QUARTERLY-${test.key}`;

function voucherXml(company, test) {
  const amount = String(test.quantity * RATE);
  const quantity = `${test.quantity}.000 ${UNIT}`;
  const lineAmount = `${test.isReturn ? "-" : ""}${amount}`;
  const partyAmount = `${test.isReturn ? "" : "-"}${amount}`;
  const partyPositive = test.isReturn ? "No" : "Yes";
  const salesPositive = test.isReturn ? "Yes" : "No";
  const ref = reference(test);
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY><SVFROMDATE TYPE="Date">${compact(DATE)}</SVFROMDATE><SVTODATE TYPE="Date">${compact(DATE)}</SVTODATE><SVCURRENTDATE TYPE="Date">${compact(DATE)}</SVCURRENTDATE></STATICVARIABLES></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${escapeXml(test.type)}" ACTION="Create" OBJVIEW="Invoice Voucher View"><DATE>${compact(DATE)}</DATE><EFFECTIVEDATE>${compact(DATE)}</EFFECTIVEDATE><VOUCHERTYPENAME>${escapeXml(test.type)}</VOUCHERTYPENAME><VOUCHERNUMBERSERIES>Default</VOUCHERNUMBERSERIES><GSTREGISTRATION> Registration</GSTREGISTRATION><CMPGSTREGISTRATIONTYPE>Regular</CMPGSTREGISTRATIONTYPE><REFERENCE>${escapeXml(ref)}</REFERENCE><REFERENCEDATE>${compact(DATE)}</REFERENCEDATE><PARTYLEDGERNAME>${escapeXml(test.party)}</PARTYLEDGERNAME><NARRATION>${escapeXml(ref)}</NARRATION><BASICBASEPARTYNAME>${escapeXml(test.party)}</BASICBASEPARTYNAME><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><VCHENTRYMODE>Item Invoice</VCHENTRYMODE><ISINVOICE>Yes</ISINVOICE><ISOPTIONAL>No</ISOPTIONAL><DIFFACTUALQTY>No</DIFFACTUALQTY><LEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(test.party)}</LEDGERNAME><ISDEEMEDPOSITIVE>${partyPositive}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><ISLASTDEEMEDPOSITIVE>${partyPositive}</ISLASTDEEMEDPOSITIVE><AMOUNT>${partyAmount}</AMOUNT></LEDGERENTRIES.LIST><ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${escapeXml(ITEM)}</STOCKITEMNAME><GSTHSNINFERAPPLICABILITY>Specify Details Here</GSTHSNINFERAPPLICABILITY><GSTHSNNAME>72044900</GSTHSNNAME><ISDEEMEDPOSITIVE>${salesPositive}</ISDEEMEDPOSITIVE><RATE>${RATE}/${UNIT}</RATE><AMOUNT>${lineAmount}</AMOUNT><ACTUALQTY>${quantity}</ACTUALQTY><BILLEDQTY>${quantity}</BILLEDQTY><ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${escapeXml(LEDGER)}</LEDGERNAME><ISDEEMEDPOSITIVE>${salesPositive}</ISDEEMEDPOSITIVE><AMOUNT>${lineAmount}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

async function read(config, company) {
  const xml = buildCollectionExportXml({ collectionName: "Meenakshi quarterly TOD audit", tallyType: "Voucher", fetchFields: "Date,VoucherTypeName,VoucherNumber,GUID,Narration,PartyLedgerName,VoucherAmount,AllInventoryEntries.StockItemName,AllInventoryEntries.BilledQty,AllInventoryEntries.Amount", companyName: company, dateFrom: DATE, dateTo: DATE });
  return parseVouchers(await postTallyXml(config.tallyUrl, xml, { timeoutMs: 90_000, operation: "Read quarterly TOD audit vouchers" })).filter((voucher) => voucher.narration.startsWith("MEENAKSHI-TOD-QUARTERLY-"));
}

const config = loadConfig();
const active = await probeActiveCompany(config.tallyUrl);
if (active.name !== COMPANY) throw new Error(`Refusing to write to ${active.name}. Open ${COMPANY} in Tally Prime.`);
const requested = process.argv.find((item) => item.startsWith("--case="))?.slice(7);
const selected = requested ? cases.filter((item) => item.key === requested) : cases;
if (!selected.length) throw new Error(`Unknown audit case: ${requested}`);
const existing = new Set((await read(config, active.name)).map((voucher) => voucher.narration));
const pending = selected.filter((item) => !existing.has(reference(item)));
console.log(JSON.stringify({ company: active.name, date: DATE, pending: pending.map(reference) }, null, 2));
if (!process.argv.includes("--apply")) process.exit(0);
for (const test of pending) {
  const response = await postTallyXml(config.tallyUrl, voucherXml(active.name, test), { timeoutMs: 90_000, operation: `Create ${reference(test)}` });
  if (Number(getTagText(response, "CREATED") ?? 0) !== 1 || Number(getTagText(response, "ERRORS") ?? 0)) throw new Error(getTagText(response, "LINEERROR") ?? `Tally did not create ${reference(test)}. ${response.slice(0, 1_000)}`);
}
const verified = await read(config, active.name);
console.log(JSON.stringify(verified.map((voucher) => ({ reference: voucher.narration, type: voucher.voucherTypeName, party: voucher.partyLedgerName, quantity: voucher.inventoryLines[0]?.quantity, amount: voucher.inventoryLines[0]?.taxableProductValue })), null, 2));
