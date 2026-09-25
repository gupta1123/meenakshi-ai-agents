import { createHash } from "node:crypto";
import Decimal from "decimal.js";

import { buildCollectionExportXml, postTallyXml } from "./xml.mjs";
import { parseVouchers } from "./vouchers.mjs";

const CREDIT_NOTE_FETCH_FIELDS = [
  "Date,VoucherTypeName,VoucherType,VoucherTypeGUID,VoucherNumber,GUID,MasterID,AlterID,IsCancelled,IsOptional,IsReversed,PartyLedgerName,PartyLedgerGUID,VoucherAmount,Amount,Narration",
  "AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount",
  "InventoryEntries.StockItemName,InventoryEntries.StockItemGUID,InventoryEntries.BilledQty,InventoryEntries.Amount",
].join(",");

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function compactDate(value) { return String(value ?? "").replaceAll("-", ""); }

function payload(command) {
  const creditNote = command.payload?.creditNote;
  if (!creditNote || typeof creditNote !== "object") throw new Error("Credit Note command is missing its immutable financial payload.");
  const required = [
    [creditNote.company?.guid, "company GUID"], [creditNote.company?.name, "company name"],
    [creditNote.voucherType?.name, "Credit Note voucher type"], [creditNote.voucherType?.guid, "Credit Note voucher type GUID"],
    [creditNote.party?.name, "customer ledger"], [creditNote.party?.guid, "customer ledger GUID"],
    [creditNote.creditNoteDate, "Credit Note date"], [creditNote.amount, "approved amount"],
    [creditNote.calculationReference, "calculation reference"], [creditNote.allocation?.type, "bill allocation type"],
  ];
  for (const [value, label] of required) if (!String(value ?? "").trim()) throw new Error(`Credit Note command is missing ${label}.`);
  if (creditNote.gstTreatment !== "commercial_no_gst") throw new Error("Only commercial_no_gst Credit Notes are allowed.");
  if (!/^\d+(\.\d{1,4})?$/.test(String(creditNote.amount))) throw new Error("Credit Note amount is not a decimal string.");
  if (!Array.isArray(creditNote.sourceSalesLedgers) || !creditNote.sourceSalesLedgers.length) throw new Error("Credit Note command is missing its source Sales ledgers.");
  let allocated = new Decimal(0);
  for (const ledger of creditNote.sourceSalesLedgers) {
    if (!String(ledger?.name ?? "").trim() || !String(ledger?.guid ?? "").trim()) throw new Error("Credit Note source Sales ledger identity is incomplete.");
    if (!/^\d+(\.\d{1,4})?$/.test(String(ledger.amount)) || !new Decimal(String(ledger.amount)).isPositive()) throw new Error("Credit Note source Sales ledger amount is invalid.");
    allocated = allocated.plus(String(ledger.amount));
  }
  if (!allocated.equals(new Decimal(String(creditNote.amount)))) throw new Error("Credit Note source Sales ledger amounts do not equal the approved amount.");
  return creditNote;
}

// GST credit note in the client's own style (their Credit Note No. 15): party
// on top credited with the rounded total On Account; the "(Discount)" sales
// ledger, CGST+SGST or IGST and Round Off debited. Present when the backend
// prepared `snapshot.tallyPosting.gstNote`.
export function gstNoteOf(creditNote) {
  const gst = creditNote?.snapshot?.tallyPosting?.gstNote;
  return gst && typeof gst === "object" && gst.discountLedger?.name && Array.isArray(gst.taxLines) ? gst : null;
}

function signedAmount(debit, value) {
  // Tally XML: debit = ISDEEMEDPOSITIVE Yes with a negative amount.
  const amount = new Decimal(String(value));
  return debit ? `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amount.abs().toFixed(2)}</AMOUNT>` : `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amount.abs().toFixed(2)}</AMOUNT>`;
}

export function buildGstCreditNoteImportXml(creditNote, gst) {
  // Accounting-invoice mode (as the client's own notes are stored): Tally
  // shows "Party A/c name" at the top and the discount, GST and Round Off
  // lines with their rates, instead of To/By accounting lines.
  const entry = (name, debit, amount, extra = "", party = false) => `<LEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(name)}</LEDGERNAME><ISPARTYLEDGER>${party ? "Yes" : "No"}</ISPARTYLEDGER>${signedAmount(debit, amount)}${extra}</LEDGERENTRIES.LIST>`;
  const roundOff = new Decimal(String(gst.roundOff?.amount ?? "0"));
  const lines = [
    entry(creditNote.party.name, false, gst.total, `<BILLALLOCATIONS.LIST><BILLTYPE>On Account</BILLTYPE><AMOUNT>${new Decimal(gst.total).toFixed(2)}</AMOUNT></BILLALLOCATIONS.LIST>`, true),
    entry(gst.discountLedger.name, true, gst.taxableValue),
    ...gst.taxLines.map((line) => entry(line.name, true, line.amount)),
    // Round Off stays on the debit side like the other lines (ISDEEMEDPOSITIVE
    // Yes, as in the client's own notes); only the amount's sign changes: an
    // addition is negative (debit), a reduction positive. Marking a reduction
    // "No" made Tally's invoice view add it instead of subtracting it.
    ...(roundOff.isZero() ? [] : [`<LEDGERENTRIES.LIST><LEDGERNAME>${escapeXml(gst.roundOff.name)}</LEDGERNAME><ISPARTYLEDGER>No</ISPARTYLEDGER><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${roundOff.negated().toFixed(2)}</AMOUNT></LEDGERENTRIES.LIST>`]),
  ];
  const optional = (tag, value) => (value ? `<${tag}>${escapeXml(value)}</${tag}>` : "");
  return [
    "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC>",
    "<REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>", escapeXml(creditNote.company.name),
    "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER VCHTYPE=\"",
    escapeXml(creditNote.voucherType.name), "\" ACTION=\"Create\" OBJVIEW=\"Invoice Voucher View\"><DATE>", compactDate(creditNote.creditNoteDate),
    "</DATE><VOUCHERTYPENAME>", escapeXml(creditNote.voucherType.name), "</VOUCHERTYPENAME>",
    "<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><VCHENTRYMODE>Accounting Invoice</VCHENTRYMODE><ISINVOICE>Yes</ISINVOICE>",
    "<PARTYLEDGERNAME>", escapeXml(creditNote.party.name), "</PARTYLEDGERNAME>",
    optional("BASICBUYERNAME", creditNote.party.name), optional("PARTYGSTIN", gst.partyGstin), optional("PLACEOFSUPPLY", gst.placeOfSupply), optional("STATENAME", gst.placeOfSupply),
    optional("REFERENCE", gst.reference), "<NARRATION>", escapeXml(gst.narration), "</NARRATION>",
    lines.join(""),
    "</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>",
  ].join("");
}

function verifyGstLedgers(creditNote, gst, ledgerEntries) {
  const expectDebit = (name, amount) => {
    const entry = matchingLedgerEntry(ledgerEntries, name);
    if (!entry || absoluteDecimal(entry.amount) !== absoluteDecimal(amount)) throw new Error(`Tally Credit Note did not contain the expected amount for ${name}.`);
    if (!isDebitAmount(entry.amount)) throw new Error(`Tally Credit Note credits ${name} instead of debiting it.`);
  };
  expectDebit(gst.discountLedger.name, gst.taxableValue);
  for (const line of gst.taxLines) expectDebit(line.name, line.amount);
  const roundOff = new Decimal(String(gst.roundOff?.amount ?? "0"));
  if (!roundOff.isZero()) {
    const entry = matchingLedgerEntry(ledgerEntries, gst.roundOff.name);
    if (!entry || absoluteDecimal(entry.amount) !== absoluteDecimal(roundOff.abs().toFixed(2)) || isDebitAmount(entry.amount) !== roundOff.isPositive()) {
      throw new Error("Tally Credit Note Round Off does not match.");
    }
  }
  const allowed = [creditNote.party.name, gst.discountLedger.name, ...gst.taxLines.map((line) => line.name), gst.roundOff?.name].filter(Boolean);
  if (ledgerEntries.some((entry) => String(entry.ledgerName ?? "").trim() && !allowed.some((name) => sameLedgerName(name, entry.ledgerName)))) {
    throw new Error("Tally Credit Note contains an unexpected accounting ledger.");
  }
  // Only GST ledgers other than the approved tax lines are "unexpected".
  return ledgerEntries.filter((entry) => !gst.taxLines.some((line) => sameLedgerName(line.name, entry.ledgerName)) && !sameLedgerName(entry.ledgerName, gst.discountLedger.name)
    && /\b(?:igst|cgst|sgst|utgst|gst)\b/i.test(String(entry.ledgerName ?? ""))).length;
}

export function buildCreditNoteImportXml(creditNote) {
  const gst = gstNoteOf(creditNote);
  if (gst) return buildGstCreditNoteImportXml(creditNote, gst);
  const amount = String(creditNote.amount);
  const allocation = creditNote.allocation?.type === "agst_ref"
    ? `<BILLALLOCATIONS.LIST><NAME>${escapeXml(creditNote.allocation.reference)}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>${escapeXml(amount)}</AMOUNT></BILLALLOCATIONS.LIST>`
    : `<BILLALLOCATIONS.LIST><NAME>${escapeXml(creditNote.allocation.reference)}</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>${escapeXml(amount)}</AMOUNT></BILLALLOCATIONS.LIST>`;
  const salesEntries = creditNote.sourceSalesLedgers.map((ledger) => [
    "<ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(ledger.name),
    "</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-", escapeXml(ledger.amount),
    "</AMOUNT></ALLLEDGERENTRIES.LIST>",
  ].join("")).join("");
  // This is an accounting-mode commercial Credit Note: the customer is
  // credited and the original Sales ledger(s) are debited proportionally.
  // Tally XML: a negative AMOUNT (ISDEEMEDPOSITIVE Yes) is a debit, a
  // positive AMOUNT (ISDEEMEDPOSITIVE No) is a credit.
  return [
    "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC>",
    "<REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>", escapeXml(creditNote.company.name),
    "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER VCHTYPE=\"",
    escapeXml(creditNote.voucherType.name), "\" ACTION=\"Create\"><DATE>", compactDate(creditNote.creditNoteDate),
    "</DATE><VOUCHERTYPENAME>", escapeXml(creditNote.voucherType.name), "</VOUCHERTYPENAME><PARTYLEDGERNAME>",
    escapeXml(creditNote.party.name), "</PARTYLEDGERNAME><NARRATION>", escapeXml(creditNote.calculationReference),
    "</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>", escapeXml(creditNote.party.name),
    "</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>", escapeXml(amount), "</AMOUNT>", allocation,
    "</ALLLEDGERENTRIES.LIST>", salesEntries,
    "</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>",
  ].join("");
}

function absoluteDecimal(value) {
  const raw = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error("Tally returned a non-decimal Credit Note amount.");
  const unsigned = raw.startsWith("-") ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

// Tally XML writes debits as negative ledger amounts.
export function isDebitAmount(value) { return String(value ?? "").trim().startsWith("-"); }

function amountMatches(voucher, expected) {
  // Financial transport values are decimal strings. Avoid IEEE-754 rounding
  // when deciding whether an existing Tally Credit Note may be recovered.
  return absoluteDecimal(voucher.grossAmount) === absoluteDecimal(expected);
}

function partyIdentity(voucher, expectedParty) {
  const reportedGuid = String(voucher.partyLedgerGuid ?? "").trim();
  if (reportedGuid) {
    return {
      matches: reportedGuid === expectedParty.guid,
      method: "tally_party_guid",
      reportedGuid,
    };
  }

  // Tally Prime can omit PARTYLEDGERGUID from a voucher collection export,
  // including for a freshly created Credit Note. In that one case, resolve
  // the returned exact ledger name back to the already-synced company ledger.
  // This is deliberately not a fuzzy match and it is never used when Tally
  // actually supplied a GUID (a supplied but different GUID must fail).
  const reportedName = String(voucher.partyLedgerName ?? "").trim();
  return {
    matches: Boolean(reportedName) && reportedName === expectedParty.name,
    method: "exact_party_name_when_guid_omitted",
    reportedGuid: null,
  };
}

function voucherTypeIdentity(voucher, expectedVoucherType) {
  const reportedGuid = String(voucher.voucherTypeGuid ?? "").trim();
  if (reportedGuid) {
    return {
      matches: reportedGuid === expectedVoucherType.guid,
      method: "tally_voucher_type_guid",
      reportedGuid,
    };
  }

  // Tally Prime can omit VOUCHERTYPEGUID from a voucher collection export.
  // The bridge must still be able to recover a created Credit Note, but it
  // must never treat a different, supplied GUID as a match.  An exact type
  // name is the only fallback used when the GUID is genuinely absent.
  const reportedName = String(voucher.voucherTypeName ?? "").trim();
  return {
    matches: Boolean(reportedName) && reportedName === expectedVoucherType.name,
    method: "exact_voucher_type_name_when_guid_omitted",
    reportedGuid: null,
  };
}

// Read-back collapses repeated spaces ("IGST @  18%" -> "IGST @ 18%").
function sameLedgerName(left, right) {
  return String(left ?? "").replace(/\s+/g, " ").trim() === String(right ?? "").replace(/\s+/g, " ").trim();
}
function matchingLedgerEntry(ledgerEntries, expectedLedgerName) {
  return ledgerEntries.find((entry) => sameLedgerName(entry.ledgerName, expectedLedgerName));
}

export async function findCreditNote(creditNote, { tallyUrl }) {
  const xml = buildCollectionExportXml({
    collectionName: "Meenakshi Credit Note Readback", tallyType: "Voucher", fetchFields: CREDIT_NOTE_FETCH_FIELDS,
    companyName: creditNote.company.name, dateFrom: creditNote.creditNoteDate, dateTo: creditNote.creditNoteDate,
  });
  const responseXml = await postTallyXml(tallyUrl, xml, { timeoutMs: 90_000, operation: "Read back Meenakshi Credit Note" });
  // GST notes carry a readable narration and a GST-inclusive total; older
  // commercial notes carry the calculation reference and the discount amount.
  const gst = gstNoteOf(creditNote);
  const candidates = parseVouchers(responseXml).filter((voucher) => (
    voucher.voucherKind === "credit_note"
    && voucher.status === "posted"
    && voucherTypeIdentity(voucher, creditNote.voucherType).matches
    && partyIdentity(voucher, creditNote.party).matches
    && voucher.voucherDate === creditNote.creditNoteDate
    && voucher.narration === (gst ? gst.narration : creditNote.calculationReference)
    && amountMatches(voucher, gst ? gst.total : creditNote.amount)
  ));
  if (candidates.length > 1) throw new Error("More than one Tally Credit Note matches the immutable calculation reference. Manual correction is required.");
  return candidates[0] ?? null;
}

export function verificationResult(creditNote, voucher) {
  const ledgerEntries = Array.isArray(voucher?.sourcePayload?.ledgerEntries) ? voucher.sourcePayload.ledgerEntries : [];
  const party = partyIdentity(voucher, creditNote.party);
  const voucherType = voucherTypeIdentity(voucher, creditNote.voucherType);
  const gst = gstNoteOf(creditNote);
  if (gst) {
    if (!party.matches) throw new Error("Tally Credit Note party does not match the approved customer ledger.");
    if (!voucherType.matches) throw new Error("Tally Credit Note voucher type does not match the approved Credit Note type.");
    const partyEntry = matchingLedgerEntry(ledgerEntries, creditNote.party.name);
    if (!partyEntry || absoluteDecimal(partyEntry.amount) !== absoluteDecimal(gst.total)) throw new Error("Tally Credit Note did not credit the customer with the approved total.");
    if (isDebitAmount(partyEntry.amount)) throw new Error("Tally Credit Note debits the customer instead of crediting it.");
    const unexpectedGstLedgerCount = verifyGstLedgers(creditNote, gst, ledgerEntries);
    return {
      tallyGuid: voucher.guid, masterId: voucher.masterId || null, alterId: voucher.alterId || null, voucherNumber: voucher.voucherNumber || null,
      companyGuid: creditNote.company.guid,
      voucherTypeGuid: voucherType.reportedGuid ?? creditNote.voucherType.guid, voucherTypeIdentityMethod: voucherType.method, reportedVoucherTypeGuid: voucherType.reportedGuid,
      partyLedgerGuid: party.reportedGuid ?? creditNote.party.guid, partyIdentityMethod: party.method, reportedPartyLedgerGuid: party.reportedGuid,
      // The discount ledger stands in for the "source Sales ledger" in the database check.
      sourceSalesLedgerEvidence: creditNote.sourceSalesLedgers.map((row) => ({ id: row.id, guid: row.guid, name: row.name, amount: absoluteDecimal(row.amount) })),
      voucherDate: voucher.voucherDate,
      // The approved (taxable) discount amount; the GST-inclusive total is reported separately.
      amount: absoluteDecimal(gst.taxableValue),
      creditNoteTotal: absoluteDecimal(gst.total),
      billAllocationType: "on_account",
      billReference: null,
      inventoryLineCount: voucher.inventoryLines.length,
      unexpectedGstLedgerCount,
      ledgerEntriesHash: createHash("sha256").update(JSON.stringify(ledgerEntries)).digest("hex"),
    };
  }
  // Approved Sales ledgers may carry "(IGST)" in their name; only other
  // GST-named ledgers (tax lines) count as unexpected GST.
  const approvedSalesNames = new Set(creditNote.sourceSalesLedgers.map((row) => row.name));
  const unexpectedGstLedgerCount = ledgerEntries.filter((entry) => !approvedSalesNames.has(String(entry.ledgerName ?? "").trim())
    && /\b(?:igst|cgst|sgst|utgst|gst)\b/i.test(String(entry.ledgerName ?? ""))).length;
  const allocation = voucher.billAllocations.find((entry) => entry.billReference === creditNote.allocation.reference);
  if (!party.matches) throw new Error("Tally Credit Note party does not match the approved customer ledger.");
  if (!voucherType.matches) throw new Error("Tally Credit Note voucher type does not match the approved Credit Note type.");
  if (!allocation) throw new Error("Tally Credit Note did not contain the required bill allocation.");
  const partyEntry = matchingLedgerEntry(ledgerEntries, creditNote.party.name);
  if (!partyEntry) {
    throw new Error("Tally Credit Note did not contain the approved customer ledger entry.");
  }
  // Direction matters: the customer must be credited (positive in Tally XML).
  if (isDebitAmount(partyEntry.amount)) throw new Error("Tally Credit Note debits the customer instead of crediting it. Delete it in Tally and correct the connector.");
  const sourceSalesLedgerEvidence = creditNote.sourceSalesLedgers.map((expected) => {
    const entry = matchingLedgerEntry(ledgerEntries, expected.name);
    if (!entry || absoluteDecimal(entry.amount) !== absoluteDecimal(expected.amount)) {
      throw new Error(`Tally Credit Note did not contain the approved Sales ledger amount for ${expected.name}.`);
    }
    if (!isDebitAmount(entry.amount)) throw new Error(`Tally Credit Note credits ${expected.name} instead of debiting it.`);
    return { id: expected.id, guid: expected.guid, name: expected.name, amount: absoluteDecimal(expected.amount) };
  });
  const expectedNames = new Set([creditNote.party.name, ...creditNote.sourceSalesLedgers.map((row) => row.name)]);
  if (ledgerEntries.some((entry) => String(entry.ledgerName ?? "").trim() && !expectedNames.has(String(entry.ledgerName).trim()))) {
    throw new Error("Tally Credit Note contains an unexpected accounting ledger.");
  }
  return {
    tallyGuid: voucher.guid,
    masterId: voucher.masterId || null,
    alterId: voucher.alterId || null,
    voucherNumber: voucher.voucherNumber || null,
    companyGuid: creditNote.company.guid,
    // The DB verifier compares the immutable configured GUID.  When Tally
    // omitted its GUID, the exact configured name above is the controlled
    // identity evidence and the known immutable GUID is carried forward.
    voucherTypeGuid: voucherType.reportedGuid ?? creditNote.voucherType.guid,
    voucherTypeIdentityMethod: voucherType.method,
    reportedVoucherTypeGuid: voucherType.reportedGuid,
    // The downstream verifier compares this against the immutable synced
    // ledger GUID. When Tally omitted the GUID, the exact company-scoped
    // party-name match above is the evidence that maps it to that GUID.
    partyLedgerGuid: party.reportedGuid ?? creditNote.party.guid,
    partyIdentityMethod: party.method,
    reportedPartyLedgerGuid: party.reportedGuid,
    sourceSalesLedgerEvidence,
    voucherDate: voucher.voucherDate,
    amount: absoluteDecimal(voucher.grossAmount),
    billAllocationType: allocation.allocationType,
    billReference: allocation.billReference,
    inventoryLineCount: voucher.inventoryLines.length,
    unexpectedGstLedgerCount,
    ledgerEntriesHash: createHash("sha256").update(JSON.stringify(ledgerEntries)).digest("hex"),
  };
}

export async function createOrRecoverCreditNote(command, { config }) {
  const creditNote = payload(command);
  const recovered = await findCreditNote(creditNote, config);
  if (recovered) return { ...verificationResult(creditNote, recovered), recovered: true };
  const importXml = buildCreditNoteImportXml(creditNote);
  await postTallyXml(config.tallyUrl, importXml, { timeoutMs: 90_000, operation: "Create Meenakshi Credit Note" });
  const created = await findCreditNote(creditNote, config);
  if (!created) throw new Error("Tally accepted the Credit Note request but independent read-back could not find the exact voucher.");
  return { ...verificationResult(creditNote, created), recovered: false };
}

export async function verifyCreditNote(command, { config }) {
  const creditNote = payload(command);
  const voucher = await findCreditNote(creditNote, config);
  if (!voucher) throw new Error("The expected Credit Note was not found during independent Tally read-back.");
  return verificationResult(creditNote, voucher);
}
