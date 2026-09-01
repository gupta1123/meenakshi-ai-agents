import { buildCollectionExportXml, postTallyXml } from "./xml.mjs";
import { parseVouchers } from "./vouchers.mjs";

const FETCH_FIELDS = [
  "Date,VoucherTypeName,VoucherType,VoucherTypeGUID,VoucherNumber,GUID,MasterID,AlterID,IsCancelled,IsOptional,IsReversed,PartyLedgerName,PartyLedgerGUID,VoucherAmount,Amount,Narration",
  "AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount",
  "InventoryEntries.StockItemName,InventoryEntries.StockItemGUID,InventoryEntries.BilledQty,InventoryEntries.Amount",
].join(",");

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function compactDate(value) { return String(value ?? "").replaceAll("-", ""); }
function absoluteDecimal(value) {
  const raw = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error("Tally returned a non-decimal Debit Note amount.");
  const unsigned = raw.startsWith("-") ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${whole.replace(/^0+(?=\d)/, "") || "0"}.${normalizedFraction}` : whole.replace(/^0+(?=\d)/, "") || "0";
}
function payload(command) {
  const debitNote = command.payload?.debitNote;
  if (!debitNote || typeof debitNote !== "object") throw new Error("Debit Note command is missing its immutable recovery payload.");
  const required = [
    [debitNote.company?.guid, "company GUID"], [debitNote.company?.name, "company name"],
    [debitNote.voucherType?.name, "Debit Note voucher type"],
    [debitNote.party?.name, "customer ledger"],
    [debitNote.salesLedger?.name, "source Sales ledger"],
    [debitNote.debitNoteDate, "Debit Note date"], [debitNote.amount, "recovery amount"],
    [debitNote.calculationReference, "calculation reference"], [debitNote.allocation?.reference, "invoice reference"],
  ];
  for (const [value, label] of required) if (!String(value ?? "").trim()) throw new Error(`Debit Note command is missing ${label}.`);
  if (!/^\d+(\.\d{1,4})?$/.test(String(debitNote.amount))) throw new Error("Debit Note amount is not a decimal string.");
  return debitNote;
}

export function buildDebitNoteImportXml(debitNote) {
  const amount = String(debitNote.amount);
  return [
    "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>",
    escapeXml(debitNote.company.name), "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER VCHTYPE=\"",
    escapeXml(debitNote.voucherType.name), "\" ACTION=\"Create\"><DATE>", compactDate(debitNote.debitNoteDate), "</DATE><VOUCHERTYPENAME>",
    escapeXml(debitNote.voucherType.name), "</VOUCHERTYPENAME><PARTYLEDGERNAME>", escapeXml(debitNote.party.name), "</PARTYLEDGERNAME><NARRATION>",
    escapeXml(debitNote.calculationReference), "</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(debitNote.party.name),
    "</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>", escapeXml(amount), "</AMOUNT><BILLALLOCATIONS.LIST><NAME>",
    escapeXml(debitNote.allocation.reference), "</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>", escapeXml(amount),
    "</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(debitNote.salesLedger.name),
    "</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-", escapeXml(amount),
    "</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>",
  ].join("");
}

function identity(actualGuid, actualName, expected) {
  const guid = String(actualGuid ?? "").trim();
  return guid && expected.guid ? guid === expected.guid : String(actualName ?? "").trim() === expected.name;
}
function exactLedger(entries, name) { return entries.some((entry) => String(entry.ledgerName ?? "").trim() === name); }

export async function findDebitNote(debitNote, { tallyUrl }) {
  const xml = buildCollectionExportXml({ collectionName: "Meenakshi Debit Note Readback", tallyType: "Voucher", fetchFields: FETCH_FIELDS, companyName: debitNote.company.name, dateFrom: debitNote.debitNoteDate, dateTo: debitNote.debitNoteDate });
  const responseXml = await postTallyXml(tallyUrl, xml, { timeoutMs: 90_000, operation: "Read back Meenakshi Debit Note" });
  const matches = parseVouchers(responseXml).filter((voucher) => voucher.voucherKind === "debit_note"
    && voucher.status === "posted"
    && identity(voucher.voucherTypeGuid, voucher.voucherTypeName, debitNote.voucherType)
    && identity(voucher.partyLedgerGuid, voucher.partyLedgerName, debitNote.party)
    && voucher.voucherDate === debitNote.debitNoteDate
    && voucher.narration === debitNote.calculationReference
    && absoluteDecimal(voucher.grossAmount) === absoluteDecimal(debitNote.amount));
  if (matches.length > 1) throw new Error("More than one Tally Debit Note matches this recovery reference.");
  return matches[0] ?? null;
}

function verificationResult(debitNote, voucher) {
  const entries = Array.isArray(voucher?.sourcePayload?.ledgerEntries) ? voucher.sourcePayload.ledgerEntries : [];
  const allocation = voucher.billAllocations.find((entry) => entry.billReference === debitNote.allocation.reference);
  if (!allocation) throw new Error("Tally Debit Note did not contain the required invoice allocation.");
  if (!exactLedger(entries, debitNote.party.name) || !exactLedger(entries, debitNote.salesLedger.name)) throw new Error("Tally Debit Note ledger entries do not match the approved recovery.");
  if (voucher.inventoryLines.length) throw new Error("Tally Debit Note unexpectedly contains inventory lines.");
  return { tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber || null, amount: absoluteDecimal(voucher.grossAmount), billReference: allocation.billReference, recovered: false };
}

export async function createOrRecoverDebitNote(command, { config }) {
  const debitNote = payload(command);
  const recovered = await findDebitNote(debitNote, config);
  if (recovered) return { ...verificationResult(debitNote, recovered), recovered: true };
  await postTallyXml(config.tallyUrl, buildDebitNoteImportXml(debitNote), { timeoutMs: 90_000, operation: "Create Meenakshi Debit Note" });
  const created = await findDebitNote(debitNote, config);
  if (!created) throw new Error("Tally accepted the Debit Note request but exact read-back could not verify it.");
  return verificationResult(debitNote, created);
}
