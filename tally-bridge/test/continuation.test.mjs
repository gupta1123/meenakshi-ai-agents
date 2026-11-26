import assert from "node:assert/strict";
import test from "node:test";
import { readContinuationAllocations } from "../src/commands/continuation.mjs";
import { matchPayments } from "../src/commands/payment-matching.mjs";

const customers = [{ customerId: "c1", tallyLedgerGuid: "g-c1", ledgerName: "Sri Ramani Traders" }];
const receipt = (billReference, date, amount) => ({
  guid: `r-${billReference}`, voucherKind: "receipt", status: "posted", voucherDate: date, voucherNumber: "8", voucherTypeName: "Receipt",
  partyLedgerName: "Sri Ramani Traders", partyLedgerGuid: "g-c1",
  billAllocations: [{ allocationKey: `k-${billReference}`, allocationType: "agst_ref", billReference, allocatedAmount: amount, ledgerName: "Sri Ramani Traders", sourcePayload: { rawAmount: amount } }],
});
const next = { name: "CO - (2026-2027)", guid: "guid-1", booksFrom: "2026-04-01" };
const scope = { dateFrom: "2026-01-01", dateTo: "2026-03-31", continuation: { company: next, dateFrom: "2026-04-01", dateTo: "2026-05-30" } };
const makeScope = ({ cursor, dateFrom, dateTo, chunkDays }) => ({ ...scope, dateFrom, dateTo, cursor, chunkDays });

test("does nothing when the backend names no next-year company", async () => {
  const out = await readContinuationAllocations({ command: {}, scope: { dateFrom: "2026-01-01", dateTo: "2026-03-31" }, context: {}, customers, includeJournals: true, makeScope });
  assert.deepEqual(out, { allocations: [], status: "none" });
});

test("reads receipts from the next-year company and they settle last year's invoice", async () => {
  const asked = [];
  const read = async (command, source) => {
    asked.push({ url: source.config.tallyUrl, company: source.activeCompany.name, from: command.payload.requestedScope.dateFrom, to: command.payload.requestedScope.dateTo, cursor: command.payload.requestedScope.cursor });
    const cursor = command.payload.requestedScope.cursor;
    return cursor === "2026-04-01"
      ? { vouchers: [receipt("MUI/25-26/11409", "2026-04-02", "866996")], cursorTo: "2026-04-11" }
      : { vouchers: [], cursorTo: null };
  };
  const resolved = [];
  const context = { config: { tallyUrl: "http://127.0.0.1:9002" }, activeCompany: { name: "CO - (2025-2026)" },
    resolveTarget: async (expected) => { resolved.push(expected); return { config: { tallyUrl: "http://127.0.0.1:9000" }, activeCompany: { name: next.name } }; } };
  const out = await readContinuationAllocations({ command: { payload: {} }, scope, context, customers, includeJournals: true, makeScope, read });
  assert.equal(out.status, "read");
  assert.deepEqual(resolved, [next]);
  assert.equal(asked.length, 2);
  assert.ok(asked.every((a) => a.url === "http://127.0.0.1:9000" && a.company === next.name));
  assert.equal(out.allocations.length, 1);
  // The normal matcher ties it to the March invoice by number.
  const invoice = { tallyGuid: "inv-1", voucherNumber: "MUI/25-26/11409", voucherDate: "2026-03-02", customerId: "c1", billReferences: ["MUI/25-26/11409"], advanceDraws: [] };
  const matched = matchPayments([invoice], out.allocations);
  assert.equal(matched.get("inv-1")?.length, 1);
  assert.equal(matched.get("inv-1")[0].receiptDate, "2026-04-02");
});

test("stops, instead of guessing, when the next-year company is not open", async () => {
  const context = { resolveTarget: async () => null };
  await assert.rejects(readContinuationAllocations({ command: { payload: {} }, scope, context, customers, includeJournals: true, makeScope, read: async () => { throw new Error("must not read"); } }), /not open on the server/);
});

test("a PC connector with no router reports it cannot look at the next year", async () => {
  const out = await readContinuationAllocations({ command: { payload: {} }, scope, context: {}, customers, includeJournals: true, makeScope });
  assert.equal(out.status, "unavailable_on_pc_connector");
  assert.deepEqual(out.allocations, []);
});

test("honours a stop request between windows", async () => {
  const context = { resolveTarget: async () => ({ config: {}, activeCompany: next }), isCancelled: () => true };
  await assert.rejects(readContinuationAllocations({ command: { payload: {} }, scope, context, customers, includeJournals: true, makeScope, read: async () => ({ vouchers: [], cursorTo: null }) }), /stopped/);
});
