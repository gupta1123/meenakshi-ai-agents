import assert from "node:assert/strict";
import test from "node:test";

import { buildCreditNoteImportXml, gstNoteOf } from "../src/tally/credit-notes.mjs";

const base = {
  company: { guid: "c", name: "MEENAKSHI" }, voucherType: { guid: "vt", name: "Credit Note" },
  party: { guid: "p", name: "Shakti Agro Industries" }, creditNoteDate: "2026-09-25", amount: "808335.00",
  calculationReference: "TOD:4:x", allocation: { type: "on_account", reference: null },
  sourceSalesLedgers: [{ id: "d", guid: "dg", name: "TN SGST Sales (Discount)", amount: "808335.00" }],
};
const intra = {
  mode: "intra_state", taxableValue: "808335.00", total: "953835.00",
  discountLedger: { id: "d", guid: "dg", name: "TN SGST Sales (Discount)" },
  taxLines: [{ guid: "c9", name: "CGST - 9%", rate: "9", amount: "72750.15" }, { guid: "s9", name: "SGST-9%", rate: "9", amount: "72750.15" }],
  roundOff: { guid: "r", name: "Round Off", amount: "-0.30" },
  narration: "Being amount credited twds Turnover Discount for Jan-26 to Mar-26", reference: "TOD Jan-26 to Mar-26",
  partyGstin: "33AASFA3725G1ZJ", placeOfSupply: "Tamil Nadu",
};

test("GST credit note: party credited On Account, discount and CGST/SGST debited, round off reduction kept on the debit side with a positive amount", () => {
  const xml = buildCreditNoteImportXml({ ...base, snapshot: { tallyPosting: { gstNote: intra } } });
  assert.match(xml, /<LEDGERNAME>Shakti Agro Industries<\/LEDGERNAME><ISPARTYLEDGER>(?:Yes|No)<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>953835\.00<\/AMOUNT><BILLALLOCATIONS\.LIST><BILLTYPE>On Account<\/BILLTYPE>/);
  assert.match(xml, /<LEDGERNAME>TN SGST Sales \(Discount\)<\/LEDGERNAME><ISPARTYLEDGER>(?:Yes|No)<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-808335\.00<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>CGST - 9%<\/LEDGERNAME><ISPARTYLEDGER>(?:Yes|No)<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-72750\.15<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>SGST-9%<\/LEDGERNAME><ISPARTYLEDGER>(?:Yes|No)<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-72750\.15<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Round Off<\/LEDGERNAME><ISPARTYLEDGER>No<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>0\.30<\/AMOUNT>/);
  assert.match(xml, /<PARTYGSTIN>33AASFA3725G1ZJ<\/PARTYGSTIN><PLACEOFSUPPLY>Tamil Nadu<\/PLACEOFSUPPLY>/);
  assert.doesNotMatch(xml, /New Ref|IGST/);
  // Books balance: debits = credits.
  const signed = [...xml.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
  const ledgerAmounts = signed.filter((_, index) => index !== 1); // skip the bill allocation line
  assert.equal(Math.round(ledgerAmounts.reduce((a, b) => a + b, 0) * 100), 0);
});

test("GST credit note for an out-of-state party uses IGST and skips a zero round off", () => {
  const inter = { ...intra, mode: "inter_state", discountLedger: { id: "i", guid: "ig", name: "TN IGST Sales (Discount)" }, taxLines: [{ guid: "i18", name: "IGST @  18%", rate: "18", amount: "145500.30" }], roundOff: { guid: "r", name: "Round Off", amount: "0.00" }, total: "953835.30" };
  const xml = buildCreditNoteImportXml({ ...base, snapshot: { tallyPosting: { gstNote: inter } } });
  assert.match(xml, /<LEDGERNAME>IGST @  18%<\/LEDGERNAME><ISPARTYLEDGER>(?:Yes|No)<\/ISPARTYLEDGER><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-145500\.30<\/AMOUNT>/);
  assert.doesNotMatch(xml, /CGST|SGST-9%|Round Off/);
});

test("notes without a GST plan keep the previous commercial layout", () => {
  assert.equal(gstNoteOf(base), null);
});
