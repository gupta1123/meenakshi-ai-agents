import assert from "node:assert/strict";
import test from "node:test";
import { assertTestVoucher, runVoucherTest } from "../src/support/voucher-test.mjs";

const note = (over = {}) => ({
  company: { guid: "g", name: "CO - (2025-2026)" }, voucherType: { guid: "vt", name: "Credit Note" }, party: { guid: "p", name: "Test Party" },
  creditNoteDate: "2026-03-31", amount: "1.00", calculationReference: "MEENAKSHI-TEST-ABCD1234", allocation: { type: "on_account", reference: "MEENAKSHI-TEST-ABCD1234" },
  gstTreatment: "commercial_no_gst", sourceSalesLedgers: [{ id: "l", guid: "lg", name: "X (Discount)", amount: "1.00" }], ...over,
});
const company = { name: "CO - (2025-2026)", guid: "g" };
const voucher = { guid: "v1", voucherNumber: "7", voucherDate: "2026-03-31", narration: "MEENAKSHI-TEST-ABCD1234" };

test("only the exact test voucher in the exact company is allowed", () => {
  assertTestVoucher(note(), company);
  assert.throws(() => assertTestVoucher(note({ calculationReference: "REAL-123456" }), company), /Not a test/);
  assert.throws(() => assertTestVoucher(note({ amount: "250.00" }), company), /exactly 1.00/);
  assert.throws(() => assertTestVoucher(note(), { name: "CO - (2026-2027)", guid: "g" }), /different Tally company/);
  assert.throws(() => assertTestVoucher(note(), { name: company.name, guid: "other" }), /GUID/);
});

test("creates, deletes by number, and proves it is gone", async () => {
  let present = false; const posted = [];
  const result = await runVoucherTest({ creditNote: note() }, { config: { tallyUrl: "u" }, activeCompany: company }, {
    create: async () => { present = true; return { tallyGuid: "v1", voucherNumber: "7" }; },
    find: async () => (present ? voucher : null),
    post: async (_url, xml) => { posted.push(xml); present = false; return "<RESPONSE><DELETED>1</DELETED></RESPONSE>"; },
  });
  assert.equal(result.deleted, true); assert.equal(result.verifiedGone, true); assert.equal(result.deleteMethod, "number");
  assert.equal(posted.length, 1); assert.match(posted[0], /ACTION="Delete"/); assert.match(posted[0], /TAGVALUE="7"/);
});

test("falls back to the GUID form once, then names the voucher if it cannot delete", async () => {
  let calls = 0;
  await assert.rejects(runVoucherTest({ creditNote: note() }, { config: { tallyUrl: "u" }, activeCompany: company }, {
    create: async () => ({ tallyGuid: "v1", voucherNumber: "7" }),
    find: async () => voucher,
    post: async () => { calls += 1; return "<RESPONSE><DELETED>0</DELETED></RESPONSE>"; },
  }), /Delete Credit Note 7 dated 2026-03-31 in CO - \(2025-2026\) by hand/);
  assert.equal(calls, 2);
});

test("never deletes a voucher that is not the test voucher", async () => {
  let posted = 0;
  await assert.rejects(runVoucherTest({ creditNote: note() }, { config: { tallyUrl: "u" }, activeCompany: company }, {
    create: async () => ({ tallyGuid: "v1", voucherNumber: "7" }),
    find: async () => ({ ...voucher, narration: "A REAL NOTE" }),
    post: async () => { posted += 1; return ""; },
  }), /not the test voucher/);
  assert.equal(posted, 0);
});
