import { createOrRecoverCreditNote, findCreditNote } from "../tally/credit-notes.mjs";
import { escapeXml, getTagText, postTallyXml } from "../tally/xml.mjs";

export const TEST_REFERENCE_PREFIX = "MEENAKSHI-TEST-";
const compactDate = (value) => String(value ?? "").replaceAll("-", "");

/** Refuses anything that is not exactly the one small test voucher this operation is allowed to touch. */
export function assertTestVoucher(creditNote, activeCompany) {
  const reference = String(creditNote?.calculationReference ?? "");
  if (!reference.startsWith(TEST_REFERENCE_PREFIX) || reference.length < TEST_REFERENCE_PREFIX.length + 6) throw new Error("Not a test voucher reference.");
  if (String(creditNote.amount) !== "1.00") throw new Error("A test voucher must be exactly 1.00.");
  if (creditNote.gstTreatment !== "commercial_no_gst") throw new Error("A test voucher must be a plain commercial Credit Note.");
  if (!activeCompany?.name || String(activeCompany.name).trim().toLowerCase() !== String(creditNote.company?.name ?? "").trim().toLowerCase()) {
    throw new Error(`The connector is on a different Tally company (${activeCompany?.name ?? "none"}) than the test names (${creditNote.company?.name}). Nothing was created.`);
  }
  if (activeCompany.guid && creditNote.company?.guid && activeCompany.guid !== creditNote.company.guid) throw new Error("The Tally company GUID does not match the test. Nothing was created.");
}

function deleteXml(creditNote, voucher, how) {
  const identity = how === "number"
    ? `DATE="${compactDate(voucher.voucherDate)}" TAGNAME="Voucher Number" TAGVALUE="${escapeXml(voucher.voucherNumber)}" VCHTYPE="${escapeXml(creditNote.voucherType.name)}"`
    : `REMOTEID="${escapeXml(voucher.guid)}" VCHTYPE="${escapeXml(creditNote.voucherType.name)}"`;
  return [
    "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC>",
    "<REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>", escapeXml(creditNote.company.name),
    "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\"><VOUCHER ", identity,
    " ACTION=\"Delete\"><DATE>", compactDate(voucher.voucherDate), "</DATE><VOUCHERTYPENAME>", escapeXml(creditNote.voucherType.name),
    "</VOUCHERTYPENAME><VOUCHERNUMBER>", escapeXml(voucher.voucherNumber), "</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>",
  ].join("");
}

/**
 * Creates ONE Rs 1 Credit Note, reads it back, deletes exactly that voucher (identified by the GUID
 * it was just read back with) and reads back again to prove it is gone. If the delete fails the error
 * names the voucher so it can be removed by hand.
 */
export async function runVoucherTest(request, context, deps = {}) {
  const creditNote = request.creditNote;
  const config = context.config;
  assertTestVoucher(creditNote, context.activeCompany);
  const find = deps.find ?? findCreditNote, create = deps.create ?? createOrRecoverCreditNote, post = deps.post ?? postTallyXml;
  const startedAt = Date.now();
  const created = await create({ payload: { creditNote } }, { config });
  const voucher = await find(creditNote, config);
  if (!voucher || voucher.guid !== created.tallyGuid) throw new Error(`The test voucher was created but could not be read back by its GUID. Delete Credit Note ${created.voucherNumber ?? "?"} dated ${creditNote.creditNoteDate} in ${creditNote.company.name} by hand.`);
  if (!String(voucher.narration ?? "").startsWith(TEST_REFERENCE_PREFIX) || voucher.voucherDate !== creditNote.creditNoteDate) throw new Error("The voucher read back is not the test voucher. Nothing was deleted.");
  const where = `Credit Note ${voucher.voucherNumber} dated ${voucher.voucherDate} in ${creditNote.company.name}`;
  const attempts = [];
  for (const how of ["number", "guid"]) {
    const response = await post(config.tallyUrl, deleteXml(creditNote, voucher, how), { timeoutMs: 60_000, operation: "Delete Meenakshi test voucher" });
    attempts.push({ how, deleted: getTagText(response, "DELETED") ?? null, errors: getTagText(response, "ERRORS") ?? null });
    if (!(await find(creditNote, config))) {
      return { created: { voucherNumber: voucher.voucherNumber, guid: voucher.guid, date: voucher.voucherDate, company: creditNote.company.name, amount: "1.00" }, deleted: true, verifiedGone: true, deleteMethod: how, attempts, ms: Date.now() - startedAt };
    }
  }
  throw Object.assign(new Error(`The test voucher was created but Tally did not delete it. Delete ${where} by hand (narration ${creditNote.calculationReference}).`), { attempts });
}
