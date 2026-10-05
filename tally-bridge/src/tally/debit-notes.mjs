import { buildCollectionExportXml, postTallyXml } from "./xml.mjs";
import { parseVouchers } from "./vouchers.mjs";
import Decimal from "decimal.js";

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
  return new Decimal(raw).abs().toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
function payload(command) {
  const debitNote = command.payload?.debitNote;
  if (!debitNote || typeof debitNote !== "object") throw new Error("Debit Note command is missing its immutable recovery payload.");
  const creditNote = isCashDiscountCreditNote(debitNote);
  const required = [
    [debitNote.company?.guid, "company GUID"], [debitNote.company?.name, "company name"],
    [debitNote.voucherType?.name, creditNote ? "Credit Note voucher type" : "Debit Note voucher type"],
    [debitNote.party?.name, "customer ledger"],
    ...(creditNote ? [] : [[debitNote.salesLedger?.name, "source Sales ledger"]]),
    [debitNote.debitNoteDate, "note date"], [debitNote.amount, "amount"],
    [debitNote.calculationReference, "calculation reference"], [debitNote.allocation?.reference, "invoice reference"],
  ];
  for (const [value, label] of required) if (!String(value ?? "").trim()) throw new Error(`${creditNote ? "Credit" : "Debit"} Note command is missing ${label}.`);
  if (!/^\d+(\.\d{1,4})?$/.test(String(debitNote.amount))) throw new Error("Note amount is not a decimal string.");
  // A Cash Discount Credit Note is always posted in the GST invoice style.
  if (creditNote && !gstNoteOf(debitNote)) throw new Error("Cash Discount Credit Note is missing its GST plan.");
  return debitNote;
}

/** Per-MT Cash Discount (docs/CD_LOGIC.md) gives the discount by Credit Note through this same command. */
export function isCashDiscountCreditNote(note) { return note?.noteKind === "credit_note"; }

// Cash Discount Credit Note in the client's GST style (their Credit Note
// No. 15): party credited with the rounded total On Account; "(Discount)"
// ledger, GST and Round Off debited — the mirror of the Debit Note below.
export function buildGstCashDiscountCreditNoteImportXml(note, gst) {
  const line = (name, deemed, amount, extra = "", isParty = false) => `<LEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(name)}</LEDGERNAME><ISPARTYLEDGER>${isParty ? "Yes" : "No"}</ISPARTYLEDGER><ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT>${extra}</LEDGERENTRIES.LIST>`;
  const total = new Decimal(String(gst.total)).toFixed(2);
  const roundOff = new Decimal(String(gst.roundOff?.amount ?? "0"));
  const optional = (tag, value) => (value ? `<${tag}>${escapeXml(value)}</${tag}>` : "");
  return [
    "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>",
    escapeXml(note.company.name), "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER VCHTYPE=\"",
    escapeXml(note.voucherType.name), "\" ACTION=\"Create\" OBJVIEW=\"Invoice Voucher View\"><DATE>", compactDate(note.debitNoteDate), "</DATE><VOUCHERTYPENAME>",
    escapeXml(note.voucherType.name), "</VOUCHERTYPENAME><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><VCHENTRYMODE>Accounting Invoice</VCHENTRYMODE><ISINVOICE>Yes</ISINVOICE>",
    "<PARTYLEDGERNAME>", escapeXml(note.party.name), "</PARTYLEDGERNAME>",
    optional("BASICBUYERNAME", note.party.name), optional("PARTYGSTIN", gst.partyGstin), optional("PLACEOFSUPPLY", gst.placeOfSupply), optional("STATENAME", gst.placeOfSupply),
    optional("REFERENCE", gst.reference), "<NARRATION>", escapeXml(gst.narration), "</NARRATION>",
    line(note.party.name, "No", total, `<BILLALLOCATIONS.LIST><BILLTYPE>On Account</BILLTYPE><AMOUNT>${total}</AMOUNT></BILLALLOCATIONS.LIST>`, true),
    line(gst.discountLedger.name, "Yes", `-${new Decimal(String(gst.taxableValue)).toFixed(2)}`),
    ...gst.taxLines.map((tax) => line(tax.name, "Yes", `-${new Decimal(String(tax.amount)).toFixed(2)}`)),
    // As on the TOD Credit Note: Round Off stays on the debit side (Yes); an
    // addition is negative, a reduction positive.
    ...(roundOff.isZero() ? [] : [line(gst.roundOff.name, "Yes", roundOff.negated().toFixed(2))]),
    "</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>",
  ].join("");
}

// GST Debit Note in the client's style (sample No. 324): invoice view, party
// debited with the rounded total On Account; "(Discount)" ledger, GST and
// Round Off on the credit side (Round Off keeps that side; its sign carries
// the direction, as on the client's own Debit Notes).
export function gstNoteOf(debitNote) {
  const gst = debitNote?.gstNote;
  return gst && typeof gst === "object" && gst.discountLedger?.name && Array.isArray(gst.taxLines) ? gst : null;
}

export function buildGstDebitNoteImportXml(debitNote, gst) {
  const line = (name, deemed, amount, extra = "", isParty = false) => `<LEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(name)}</LEDGERNAME><ISPARTYLEDGER>${isParty ? "Yes" : "No"}</ISPARTYLEDGER><ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT>${extra}</LEDGERENTRIES.LIST>`;
  const total = new Decimal(String(gst.total)).toFixed(2);
  const roundOff = new Decimal(String(gst.roundOff?.amount ?? "0"));
  const optional = (tag, value) => (value ? `<${tag}>${escapeXml(value)}</${tag}>` : "");
  return [
    "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>",
    escapeXml(debitNote.company.name), "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER VCHTYPE=\"",
    escapeXml(debitNote.voucherType.name), "\" ACTION=\"Create\" OBJVIEW=\"Invoice Voucher View\"><DATE>", compactDate(debitNote.debitNoteDate), "</DATE><VOUCHERTYPENAME>",
    escapeXml(debitNote.voucherType.name), "</VOUCHERTYPENAME><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><VCHENTRYMODE>Accounting Invoice</VCHENTRYMODE><ISINVOICE>Yes</ISINVOICE>",
    "<PARTYLEDGERNAME>", escapeXml(debitNote.party.name), "</PARTYLEDGERNAME>",
    optional("BASICBUYERNAME", debitNote.party.name), optional("PARTYGSTIN", gst.partyGstin), optional("PLACEOFSUPPLY", gst.placeOfSupply), optional("STATENAME", gst.placeOfSupply),
    optional("REFERENCE", gst.reference), "<NARRATION>", escapeXml(gst.narration), "</NARRATION>",
    line(debitNote.party.name, "Yes", `-${total}`, `<BILLALLOCATIONS.LIST><BILLTYPE>On Account</BILLTYPE><AMOUNT>-${total}</AMOUNT></BILLALLOCATIONS.LIST>`, true),
    line(gst.discountLedger.name, "No", new Decimal(String(gst.taxableValue)).toFixed(2)),
    ...gst.taxLines.map((tax) => line(tax.name, "No", new Decimal(String(tax.amount)).toFixed(2))),
    ...(roundOff.isZero() ? [] : [line(gst.roundOff.name, "No", roundOff.toFixed(2))]),
    "</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>",
  ].join("");
}

export function buildDebitNoteImportXml(debitNote) {
  const gst = gstNoteOf(debitNote);
  if (gst && isCashDiscountCreditNote(debitNote)) return buildGstCashDiscountCreditNoteImportXml(debitNote, gst);
  if (gst) return buildGstDebitNoteImportXml(debitNote, gst);
  const amount = String(debitNote.amount);
  return [
    "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>",
    escapeXml(debitNote.company.name), "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER VCHTYPE=\"",
    escapeXml(debitNote.voucherType.name), "\" ACTION=\"Create\"><DATE>", compactDate(debitNote.debitNoteDate), "</DATE><VOUCHERTYPENAME>",
    escapeXml(debitNote.voucherType.name), "</VOUCHERTYPENAME><PARTYLEDGERNAME>", escapeXml(debitNote.party.name), "</PARTYLEDGERNAME><NARRATION>",
    escapeXml(debitNote.calculationReference), "</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(debitNote.party.name),
    // Debit Note: the customer is debited (negative, ISDEEMEDPOSITIVE Yes) and
    // the Sales ledger credited (positive), matching the client's own Debit Notes.
    "</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-", escapeXml(amount), "</AMOUNT><BILLALLOCATIONS.LIST><NAME>",
    escapeXml(debitNote.allocation.reference), "</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-", escapeXml(amount),
    "</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(debitNote.salesLedger.name),
    "</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>", escapeXml(amount),
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
  const expectedKind = isCashDiscountCreditNote(debitNote) ? "credit_note" : "debit_note";
  const matches = parseVouchers(responseXml).filter((voucher) => voucher.voucherKind === expectedKind
    && voucher.status === "posted"
    && identity(voucher.voucherTypeGuid, voucher.voucherTypeName, debitNote.voucherType)
    && identity(voucher.partyLedgerGuid, voucher.partyLedgerName, debitNote.party)
    && voucher.voucherDate === debitNote.debitNoteDate
    && voucher.narration === (gstNoteOf(debitNote)?.narration ?? debitNote.calculationReference)
    && absoluteDecimal(voucher.grossAmount) === absoluteDecimal(gstNoteOf(debitNote)?.total ?? debitNote.amount));
  if (matches.length > 1) throw new Error(`More than one Tally ${expectedKind === "credit_note" ? "Credit" : "Debit"} Note matches this reference.`);
  return matches[0] ?? null;
}

function verifyGstDebitNote(debitNote, gst, voucher, entries) {
  // Read-back collapses repeated spaces ("IGST @  18%" -> "IGST @ 18%").
  const same = (left, right) => String(left ?? "").replace(/\s+/g, " ").trim() === String(right ?? "").replace(/\s+/g, " ").trim();
  const find = (name) => entries.find((entry) => same(entry.ledgerName, name));
  const isDebit = (entry) => String(entry?.amount ?? "").trim().startsWith("-");
  const party = find(debitNote.party.name);
  if (!party || absoluteDecimal(party.amount) !== absoluteDecimal(gst.total) || !isDebit(party)) throw new Error("Tally Debit Note did not debit the customer with the approved total.");
  const credit = (name, amount) => {
    const entry = find(name);
    if (!entry || absoluteDecimal(entry.amount) !== absoluteDecimal(amount) || isDebit(entry)) throw new Error(`Tally Debit Note did not credit ${name} with the expected amount.`);
  };
  credit(gst.discountLedger.name, gst.taxableValue);
  for (const tax of gst.taxLines) credit(tax.name, tax.amount);
  const roundOff = new Decimal(String(gst.roundOff?.amount ?? "0"));
  if (!roundOff.isZero()) {
    const entry = find(gst.roundOff.name);
    if (!entry || absoluteDecimal(entry.amount) !== absoluteDecimal(roundOff.toFixed(2)) || isDebit(entry) !== roundOff.isNegative()) throw new Error("Tally Debit Note Round Off does not match.");
  }
  const allowed = new Set([debitNote.party.name, gst.discountLedger.name, ...gst.taxLines.map((tax) => tax.name), gst.roundOff?.name].filter(Boolean));
  if (entries.some((entry) => String(entry.ledgerName ?? "").trim() && ![...allowed].some((name) => same(name, entry.ledgerName)))) throw new Error("Tally Debit Note contains an unexpected accounting ledger.");
  if (voucher.inventoryLines.length) throw new Error("Tally Debit Note unexpectedly contains inventory lines.");
  // `amount` is the approved recovery (checked by the database); the posted,
  // rupee-rounded GST total is reported separately.
  return { tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber || null, amount: absoluteDecimal(gst.recovery ?? debitNote.amount), debitNoteTotal: absoluteDecimal(gst.total), billReference: null, recovered: false };
}

// Mirror of verifyGstDebitNote: customer credited, discount and GST debited.
function verifyGstCashDiscountCreditNote(note, gst, voucher, entries) {
  const same = (left, right) => String(left ?? "").replace(/\s+/g, " ").trim() === String(right ?? "").replace(/\s+/g, " ").trim();
  const find = (name) => entries.find((entry) => same(entry.ledgerName, name));
  const isDebit = (entry) => String(entry?.amount ?? "").trim().startsWith("-");
  const party = find(note.party.name);
  if (!party || absoluteDecimal(party.amount) !== absoluteDecimal(gst.total) || isDebit(party)) throw new Error("Tally Credit Note did not credit the customer with the approved total.");
  const debit = (name, amount) => {
    const entry = find(name);
    if (!entry || absoluteDecimal(entry.amount) !== absoluteDecimal(amount) || !isDebit(entry)) throw new Error(`Tally Credit Note did not debit ${name} with the expected amount.`);
  };
  debit(gst.discountLedger.name, gst.taxableValue);
  for (const tax of gst.taxLines) debit(tax.name, tax.amount);
  const roundOff = new Decimal(String(gst.roundOff?.amount ?? "0"));
  if (!roundOff.isZero()) {
    const entry = find(gst.roundOff.name);
    if (!entry || absoluteDecimal(entry.amount) !== absoluteDecimal(roundOff.toFixed(2)) || isDebit(entry) !== roundOff.isPositive()) throw new Error("Tally Credit Note Round Off does not match.");
  }
  const allowed = [note.party.name, gst.discountLedger.name, ...gst.taxLines.map((tax) => tax.name), gst.roundOff?.name].filter(Boolean);
  if (entries.some((entry) => String(entry.ledgerName ?? "").trim() && !allowed.some((name) => same(name, entry.ledgerName)))) throw new Error("Tally Credit Note contains an unexpected accounting ledger.");
  if (voucher.inventoryLines.length) throw new Error("Tally Credit Note unexpectedly contains inventory lines.");
  return { tallyGuid: voucher.guid, voucherNumber: voucher.voucherNumber || null, amount: absoluteDecimal(gst.recovery ?? note.amount), debitNoteTotal: absoluteDecimal(gst.total), billReference: null, recovered: false };
}

function verificationResult(debitNote, voucher) {
  const entries = Array.isArray(voucher?.sourcePayload?.ledgerEntries) ? voucher.sourcePayload.ledgerEntries : [];
  const gst = gstNoteOf(debitNote);
  if (gst && isCashDiscountCreditNote(debitNote)) return verifyGstCashDiscountCreditNote(debitNote, gst, voucher, entries);
  if (gst) return verifyGstDebitNote(debitNote, gst, voucher, entries);
  const allocation = voucher.billAllocations.find((entry) => entry.billReference === debitNote.allocation.reference);
  if (!allocation) throw new Error("Tally Debit Note did not contain the required invoice allocation.");
  if (!exactLedger(entries, debitNote.party.name) || !exactLedger(entries, debitNote.salesLedger.name)) throw new Error("Tally Debit Note ledger entries do not match the approved recovery.");
  // Direction matters: the customer must be debited (negative in Tally XML) and the Sales ledger credited.
  const partyEntry = entries.find((entry) => String(entry.ledgerName ?? "").trim() === debitNote.party.name);
  const salesEntry = entries.find((entry) => String(entry.ledgerName ?? "").trim() === debitNote.salesLedger.name);
  if (!String(partyEntry.amount ?? "").trim().startsWith("-") || String(salesEntry.amount ?? "").trim().startsWith("-")) {
    throw new Error("Tally Debit Note has the customer and Sales ledger on the wrong sides. Delete it in Tally and correct the connector.");
  }
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
