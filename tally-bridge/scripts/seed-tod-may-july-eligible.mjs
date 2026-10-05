import { loadConfig } from "../src/config.mjs";
import { probeActiveCompany } from "../src/tally/company-probe.mjs";
import { buildCollectionExportXml, escapeXml, getTagText, postTallyXml } from "../src/tally/xml.mjs";
import { parseVouchers } from "../src/tally/vouchers.mjs";

const COMPANY = "Solution Nyx";
const ITEM = "M S Scrap & Sponge Iron";
const LEDGER = "Meenakshi TOD Test Sales";
const UNIT = "MTS";
const RATE = 1000;
const cases = [
  { key: "APEX-01", party: "Apex Rebar Projects", date: "2026-05-02", quantity: 15 },
  { key: "APEX-02", party: "Apex Rebar Projects", date: "2026-07-02", quantity: 15 },
  { key: "BALAJI-01", party: "Balaji Rebar Projects", date: "2026-05-02", quantity: 40 },
  { key: "BALAJI-02", party: "Balaji Rebar Projects", date: "2026-07-02", quantity: 40 },
  { key: "DECCAN-01", party: "Deccan Rebar Projects", date: "2026-05-02", quantity: 80 },
  { key: "DECCAN-02", party: "Deccan Rebar Projects", date: "2026-07-02", quantity: 80 },
  { key: "OMKAR-01", party: "Omkar Rebar Projects", date: "2026-05-02", quantity: 130 },
  { key: "OMKAR-02", party: "Omkar Rebar Projects", date: "2026-07-02", quantity: 130 },
  { key: "PIONEER-01", party: "Pioneer Rebar Projects", date: "2026-05-02", quantity: 260 },
  { key: "PIONEER-02", party: "Pioneer Rebar Projects", date: "2026-07-02", quantity: 260 },
  { key: "SHAKTI-01", party: "Shakti Rebar Projects", date: "2026-05-02", quantity: 10 },
  { key: "SHAKTI-02", party: "Shakti Rebar Projects", date: "2026-07-02", quantity: 20 },
];

const compact = (value) => value.replaceAll("-", "");
const reference = (test) => `MEENAKSHI-TOD-MAY-JULY-${test.key}`;

function voucherXml(company, test) {
  const amount = String(test.quantity * RATE);
  const quantity = `${test.quantity}.000 ${UNIT}`;
  const ref = reference(test);
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY><SVFROMDATE TYPE="Date">${compact(test.date)}</SVFROMDATE><SVTODATE TYPE="Date">${compact(test.date)}</SVTODATE><SVCURRENTDATE TYPE="Date">${compact(test.date)}</SVCURRENTDATE></STATICVARIABLES></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View"><DATE>${compact(test.date)}</DATE><EFFECTIVEDATE>${compact(test.date)}</EFFECTIVEDATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><REFERENCE>${escapeXml(ref)}</REFERENCE><REFERENCEDATE>${compact(test.date)}</REFERENCEDATE><PARTYLEDGERNAME>${escapeXml(test.party)}</PARTYLEDGERNAME><NARRATION>${escapeXml(ref)}</NARRATION><BASICBASEPARTYNAME>${escapeXml(test.party)}</BASICBASEPARTYNAME><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><VCHENTRYMODE>Item Invoice</VCHENTRYMODE><ISINVOICE>Yes</ISINVOICE><ISOPTIONAL>No</ISOPTIONAL><DIFFACTUALQTY>No</DIFFACTUALQTY><LEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(test.party)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE><AMOUNT>-${amount}</AMOUNT><BILLALLOCATIONS.LIST><NAME>${escapeXml(ref)}</NAME><BILLTYPE>New Ref</BILLTYPE><BILLCREDITPERIOD>0 Days</BILLCREDITPERIOD><AMOUNT>-${amount}</AMOUNT></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST><ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${escapeXml(ITEM)}</STOCKITEMNAME><GSTHSNINFERAPPLICABILITY>Specify Details Here</GSTHSNINFERAPPLICABILITY><GSTHSNNAME>72044900</GSTHSNNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>${RATE}/${UNIT}</RATE><AMOUNT>${amount}</AMOUNT><ACTUALQTY>${quantity}</ACTUALQTY><BILLEDQTY>${quantity}</BILLEDQTY><BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><AMOUNT>${amount}</AMOUNT><ACTUALQTY>${quantity}</ACTUALQTY><BILLEDQTY>${quantity}</BILLEDQTY><BATCHRATE>${RATE}/${UNIT}</BATCHRATE></BATCHALLOCATIONS.LIST><ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${escapeXml(LEDGER)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

async function read(config, company) {
  const xml = buildCollectionExportXml({
    collectionName: "Meenakshi May July TOD audit",
    tallyType: "Voucher",
    fetchFields: "Date,VoucherTypeName,VoucherNumber,GUID,Narration,PartyLedgerName,VoucherAmount,AllInventoryEntries.StockItemName,AllInventoryEntries.BilledQty,AllInventoryEntries.Amount",
    companyName: company,
    dateFrom: "2026-05-01",
    dateTo: "2026-07-31",
  });
  return parseVouchers(await postTallyXml(config.tallyUrl, xml, { timeoutMs: 180_000, operation: "Read May-July TOD audit vouchers" }))
    .filter((voucher) => voucher.narration.startsWith("MEENAKSHI-TOD-MAY-JULY-"));
}

const config = loadConfig();
const active = await probeActiveCompany(config.tallyUrl);
if (active.name !== COMPANY) throw new Error(`Refusing to write to ${active.name}. Open ${COMPANY} in Tally Prime.`);
const existing = new Set((await read(config, active.name)).map((voucher) => voucher.narration));
const pending = cases.filter((test) => !existing.has(reference(test)));
console.log(JSON.stringify({ company: active.name, pending: pending.map(reference) }, null, 2));
if (!process.argv.includes("--apply")) process.exit(0);
for (const test of pending) {
  const response = await postTallyXml(config.tallyUrl, voucherXml(active.name, test), { timeoutMs: 90_000, operation: `Create ${reference(test)}` });
  const created = Number(getTagText(response, "CREATED") ?? 0);
  const errors = Number(getTagText(response, "ERRORS") ?? 0);
  if (created !== 1 || errors) throw new Error(getTagText(response, "LINEERROR") ?? `${reference(test)} was not created. Tally reported created=${created}, errors=${errors}. Response: ${response.slice(0, 1_500)}`);
}
const verified = await read(config, active.name);
const expected = new Set(cases.map(reference));
const verifiedExpected = verified.filter((voucher) => expected.has(voucher.narration));
if (verifiedExpected.length !== cases.length) throw new Error(`Expected ${cases.length} audit vouchers but read back ${verifiedExpected.length}.`);
console.log(JSON.stringify(verifiedExpected.map((voucher) => ({
  reference: voucher.narration,
  date: voucher.date,
  party: voucher.partyLedgerName,
  item: voucher.inventoryLines[0]?.stockItemName,
  quantity: voucher.inventoryLines[0]?.quantity,
  value: voucher.inventoryLines[0]?.taxableProductValue,
})), null, 2));
