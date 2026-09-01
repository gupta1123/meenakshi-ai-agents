import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { buildCreditNoteImportXml, findCreditNote, verificationResult } from "../src/tally/credit-notes.mjs";
import { buildDebitNoteImportXml, findDebitNote } from "../src/tally/debit-notes.mjs";

const creditNote = {
  company: { guid: "company-1", name: "Test Company" },
  voucherType: { guid: "credit-note-type", name: "Credit Note" },
  party: { guid: "customer-1", name: "ACME" },
  sourceSalesLedgers: [{ id: "sales-id-1", guid: "sales-1", name: "Sales", amount: "100.25" }],
  creditNoteDate: "2026-08-05",
  amount: "100.25",
  gstTreatment: "commercial_no_gst",
  calculationReference: "CD:V1:INV-1:EVAL-1",
  allocation: { type: "agst_ref", reference: "INV-1" },
};

const debitNote = {
  company: { guid: "company-1", name: "Test Company" },
  voucherType: { name: "Debit Note" },
  party: { guid: "customer-1", name: "ACME" },
  salesLedger: { name: "Sales" },
  debitNoteDate: "2026-08-05",
  amount: "50.25",
  calculationReference: "MEENAKSHI-CD-RECOVERY-1",
  allocation: { type: "agst_ref", reference: "INV-1" },
};

function voucherXml({ guid = "credit-note-guid", voucherNumber = "CN-1", voucherTypeGuid = "credit-note-type" } = {}) {
  return `<VOUCHER>
    <GUID>${guid}</GUID><MASTERID>71</MASTERID><ALTERID>4</ALTERID>
    <VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER><DATE>20260805</DATE>
    <VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME><VOUCHERTYPEGUID>${voucherTypeGuid}</VOUCHERTYPEGUID>
    <PARTYLEDGERNAME>ACME</PARTYLEDGERNAME><PARTYLEDGERGUID></PARTYLEDGERGUID>
    <VOUCHERAMOUNT>-100.25</VOUCHERAMOUNT><NARRATION>CD:V1:INV-1:EVAL-1</NARRATION>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>ACME</LEDGERNAME><AMOUNT>-100.25</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>100.25</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>-100.25</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
  </VOUCHER>`;
}

async function withTallyResponse(responseXml, callback) {
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(responseXml);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("commercial Credit Note XML contains only the party and source Sales-ledger accounting entries", () => {
  const xml = buildCreditNoteImportXml(creditNote);
  assert.match(xml, /<VOUCHER VCHTYPE="Credit Note" ACTION="Create">/);
  assert.match(xml, /<LEDGERNAME>ACME<\/LEDGERNAME>/);
  assert.match(xml, /<LEDGERNAME>Sales<\/LEDGERNAME>/);
  assert.match(xml, /<BILLTYPE>Agst Ref<\/BILLTYPE>/);
  assert.doesNotMatch(xml, /INVENTORYENTRIES|(?:IGST|CGST|SGST|UTGST)/i);
});

test("Credit Note verification detects accounting-mode evidence without using floating point arithmetic", () => {
  const result = verificationResult(creditNote, {
    guid: "credit-note-guid", masterId: "71", alterId: "4", voucherNumber: "CN-1",
    voucherTypeGuid: "credit-note-type", partyLedgerGuid: "customer-1", voucherDate: "2026-08-05",
    grossAmount: "-100.25", inventoryLines: [],
    billAllocations: [{ billReference: "INV-1", allocationType: "agst_ref" }],
    sourcePayload: { ledgerEntries: [{ ledgerName: "ACME", amount: "-100.25" }, { ledgerName: "Sales", amount: "100.25" }] },
  });
  assert.equal(result.amount, "100.25");
  assert.equal(result.unexpectedGstLedgerCount, 0);
  assert.equal(result.inventoryLineCount, 0);
  assert.deepEqual(result.sourceSalesLedgerEvidence, [{ id: "sales-id-1", guid: "sales-1", name: "Sales", amount: "100.25" }]);
  assert.match(result.ledgerEntriesHash, /^[a-f0-9]{64}$/);
});

test("commercial Credit Note XML supports proportional source Sales-ledger splits", () => {
  const xml = buildCreditNoteImportXml({
    ...creditNote,
    sourceSalesLedgers: [
      { id: "sales-id-1", guid: "sales-1", name: "Local Sales", amount: "60.15" },
      { id: "sales-id-2", guid: "sales-2", name: "Export Sales", amount: "40.10" },
    ],
  });
  assert.match(xml, /<LEDGERNAME>Local Sales<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>60\.15<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Export Sales<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>40\.10<\/AMOUNT>/);
});

test("Credit Note read-back accepts the exact synced party name only when Tally omitted PARTYLEDGERGUID", async () => {
  await withTallyResponse(`<ENVELOPE><BODY><DATA><COLLECTION>${voucherXml()}</COLLECTION></DATA></BODY></ENVELOPE>`, async (tallyUrl) => {
    const voucher = await findCreditNote(creditNote, { tallyUrl });
    assert.equal(voucher.guid, "credit-note-guid");
    assert.equal(voucher.partyLedgerGuid, "");
    const result = verificationResult(creditNote, voucher);
    assert.equal(result.partyLedgerGuid, "customer-1");
    assert.equal(result.partyIdentityMethod, "exact_party_name_when_guid_omitted");
    assert.equal(result.reportedPartyLedgerGuid, null);
  });
});

test("Credit Note read-back accepts the exact configured voucher type name when Tally omitted VOUCHERTYPEGUID", async () => {
  await withTallyResponse(`<ENVELOPE><BODY><DATA><COLLECTION>${voucherXml({ voucherTypeGuid: "" })}</COLLECTION></DATA></BODY></ENVELOPE>`, async (tallyUrl) => {
    const voucher = await findCreditNote(creditNote, { tallyUrl });
    const result = verificationResult(creditNote, voucher);
    assert.equal(result.voucherTypeGuid, "credit-note-type");
    assert.equal(result.voucherTypeIdentityMethod, "exact_voucher_type_name_when_guid_omitted");
    assert.equal(result.reportedVoucherTypeGuid, null);
  });
});

test("Credit Note read-back refuses ambiguous existing vouchers before importing another", async () => {
  await withTallyResponse(`<ENVELOPE><BODY><DATA><COLLECTION>${voucherXml({ guid: "one", voucherNumber: "1" })}${voucherXml({ guid: "two", voucherNumber: "2" })}</COLLECTION></DATA></BODY></ENVELOPE>`, async (tallyUrl) => {
    await assert.rejects(
      () => findCreditNote(creditNote, { tallyUrl }),
      /More than one Tally Credit Note matches the immutable calculation reference/,
    );
  });
});

test("Cash Discount Debit Note XML creates a new customer reference and credits the source Sales ledger", () => {
  const xml = buildDebitNoteImportXml(debitNote);
  assert.match(xml, /<VOUCHER VCHTYPE="Debit Note" ACTION="Create">/);
  assert.match(xml, /<LEDGERNAME>ACME<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>50\.25<\/AMOUNT>/);
  assert.match(xml, /<NAME>INV-1<\/NAME><BILLTYPE>New Ref<\/BILLTYPE><AMOUNT>50\.25<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Sales<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-50\.25<\/AMOUNT>/);
  assert.doesNotMatch(xml, /INVENTORYENTRIES|(?:IGST|CGST|SGST|UTGST)/i);
});

test("Debit Note read-back requires the exact immutable recovery reference", async () => {
  const xml = `<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><GUID>dn-guid</GUID><VOUCHERNUMBER>DN-1</VOUCHERNUMBER><DATE>20260805</DATE><VOUCHERTYPENAME>Debit Note</VOUCHERTYPENAME><PARTYLEDGERNAME>ACME</PARTYLEDGERNAME><VOUCHERAMOUNT>50.25</VOUCHERAMOUNT><NARRATION>MEENAKSHI-CD-RECOVERY-1</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>ACME</LEDGERNAME><AMOUNT>50.25</AMOUNT><BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>50.25</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>-50.25</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`;
  await withTallyResponse(xml, async (tallyUrl) => {
    const voucher = await findDebitNote(debitNote, { tallyUrl });
    assert.equal(voucher?.guid, "dn-guid");
  });
});
