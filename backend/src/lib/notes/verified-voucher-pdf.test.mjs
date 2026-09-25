import test from "node:test";
import assert from "node:assert/strict";
import { renderVerifiedVoucherPdf } from "./verified-voucher-pdf.mjs";

const input = {
  kind: "credit", companyName: "Solution Nyx", customerName: "Central India Rebar Projects",
  voucherNumber: "2", voucherDate: "2026-09-21", voucherGuid: "6a1e6251-3050-4d46-8ccf-847e223ac92d-000031d0",
  amount: "1254000", reference: "TOD:3:2026-07-15", narration: "TOD settlement",
  ledgerLines: [{ side: "Credit", name: "Customer", amount: "1254000" }, { side: "Debit", name: "Sales", amount: "1254000" }],
};

test("renders a deterministic, correctly labelled verified-voucher PDF", () => {
  const first = renderVerifiedVoucherPdf(input);
  const second = renderVerifiedVoucherPdf(input);
  assert.equal(first.pdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal(first.sha256Hex, second.sha256Hex);
  assert.match(first.pdf.toString("ascii"), /not TallyPrime's native print layout/);
  assert.match(first.pdf.toString("ascii"), /Central India Rebar Projects/);
  assert.match(first.pdf.toString("ascii"), /INR 12,54,000.00/);
});

test("rejects missing identity and unsupported text rather than silently changing a financial document", () => {
  assert.throws(() => renderVerifiedVoucherPdf({ ...input, voucherGuid: "" }), /missing document identity/);
  assert.throws(() => renderVerifiedVoucherPdf({ ...input, customerName: "ग्राहक" }), /cannot represent/);
});
