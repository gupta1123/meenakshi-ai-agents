import assert from "node:assert/strict";
import test from "node:test";

import { buildDebitNoteImportXml, gstNoteOf } from "../src/tally/debit-notes.mjs";

const base = {
  company: { guid: "c", name: "MEENAKSHI" }, voucherType: { name: "Debit Note" },
  party: { guid: "p", name: "J.M.D.Ispat India, Bangalore" }, salesLedger: { name: "Sale of TMT Bars (IGST)" },
  debitNoteDate: "2026-09-25", amount: "37056.4264", calculationReference: "DN-CD-MUI/26-27/4547",
  allocation: { type: "new_ref", reference: "DN-CD-MUI/26-27/4547" },
};
const gstNote = {
  mode: "inter_state", recovery: "37056.43", taxableValue: "31403.75", total: "37056.00",
  discountLedger: { name: "TN IGST Sales (Discount)" }, taxLines: [{ name: "IGST @  18%", rate: "18", amount: "5652.68" }],
  roundOff: { name: "Round Off", amount: "-0.43" }, narration: "Being amount debited twds Cash Discount recovery against Inv No. MUI/26-27/4547 dt. 07.08.26",
  reference: "MUI/26-27/4547", partyGstin: "29AAOPK1133A1Z3", placeOfSupply: "Karnataka",
};

test("GST Debit Note matches the approved sample: party debited On Account, discount/IGST credited, round off reduction negative", () => {
  const xml = buildDebitNoteImportXml({ ...base, gstNote });
  assert.match(xml, /OBJVIEW="Invoice Voucher View"/);
  assert.match(xml, /<VCHENTRYMODE>Accounting Invoice<\/VCHENTRYMODE>/);
  assert.match(xml, /<LEDGERNAME>J\.M\.D\.Ispat India, Bangalore<\/LEDGERNAME><ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-37056\.00<\/AMOUNT><BILLALLOCATIONS\.LIST><BILLTYPE>On Account<\/BILLTYPE>/);
  assert.match(xml, /<LEDGERNAME>TN IGST Sales \(Discount\)<\/LEDGERNAME><ISPARTYLEDGER>No<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>31403\.75<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>IGST @  18%<\/LEDGERNAME><ISPARTYLEDGER>No<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>5652\.68<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Round Off<\/LEDGERNAME><ISPARTYLEDGER>No<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>-0\.43<\/AMOUNT>/);
  assert.doesNotMatch(xml, /New Ref|Sale of TMT Bars/);
});

test("Debit Notes without a GST plan keep the previous layout", () => {
  assert.equal(gstNoteOf(base), null);
  assert.match(buildDebitNoteImportXml(base), /New Ref/);
});
