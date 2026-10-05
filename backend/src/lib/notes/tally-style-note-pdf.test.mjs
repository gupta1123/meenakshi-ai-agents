import assert from "node:assert/strict";
import test from "node:test";

import { amountInIndianWords, renderTallyStyleNotePdf } from "./tally-style-note-pdf.mjs";

test("amount in words uses Indian lakh/crore grouping and paise", () => {
  assert.equal(amountInIndianWords(120892.5), "Indian Rupees One Lakh Twenty Thousand Eight Hundred Ninety Two and Fifty Paise Only");
  assert.equal(amountInIndianWords(14049214.42), "Indian Rupees One Crore Forty Lakh Forty Nine Thousand Two Hundred Fourteen and Forty Two Paise Only");
  assert.equal(amountInIndianWords(1000), "Indian Rupees One Thousand Only");
});

test("Tally-style note prints title, parties, amount and signatory without internal identifiers", () => {
  const { pdf } = renderTallyStyleNotePdf({
    kind: "debit",
    company: { name: "MEENAKSHI UDYOG (INDIA) PVT LTD  - (2025-2026)", state: "Tamil Nadu" },
    party: { name: "J.M.D.Ispat India, Bangalore", gstin: "29AAOPK1133A1Z3" },
    voucherNumber: "321", voucherDate: "2026-09-25", reference: "Inv. MUI/26-27/4547",
    particulars: ["Cash discount of 1.5% recovered"], amount: 37056.43,
  });
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  for (const expected of ["DEBIT NOTE", "(321)", "25-Sep-2026", "J.M.D.Ispat India, Bangalore", "Rs. 37,056.43", "Authorised Signatory", "for MEENAKSHI UDYOG \\(INDIA\\) PVT LTD"]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
  assert.ok(!text.includes("2025-2026"), "books-year suffix must not be printed");
});
