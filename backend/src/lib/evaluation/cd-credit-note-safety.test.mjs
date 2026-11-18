import test from "node:test";
import assert from "node:assert/strict";
import { keepCdSettlementRow, requireCurrentCdCheck, requireCurrentCdConnector } from "./cd-credit-note-safety.ts";
import { completeCdSettlementRun } from "./live-cd.ts";

function database(rows) {
  return { from(table) {
    const query = { select() { return query; }, eq() { return query; }, order() { return query; }, limit() { return query; }, maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) };
    return query;
  } };
}
test("old or missing CD snapshots cannot authorize single or bulk credit creation", async () => {
  for (const run of [null, { matchingVersion: null }, { matchingVersion: 0 }]) {
    await assert.rejects(requireCurrentCdCheck(database({ evaluation_runs: run }), "company"), /run Cash Discount again/);
  }
  await requireCurrentCdCheck(database({ evaluation_runs: { matchingVersion: 1 } }), "company");
});
test("server checks need the reader update before a Tally read is queued", async () => {
  const binding = { connector_id: "connector" };
  for (const version of [null, "0.5.3", "0.4.3"]) await assert.rejects(requireCurrentCdConnector(database({ tally_connector_company_bindings: binding, tally_connectors: { bridge_version: version } }), "company"), /0.5.4/);
  await requireCurrentCdConnector(database({ tally_connector_company_bindings: binding, tally_connectors: { bridge_version: "0.5.4" } }), "company");
  await requireCurrentCdConnector(database({ tally_connector_company_bindings: binding, tally_connectors: { bridge_version: "0.6.0" } }), "company");
});
test("old connector evidence cannot overwrite the saved settlement snapshot", async () => {
  await assert.rejects(completeCdSettlementRun({}, { invoices: [] }), /run Cash Discount again/);
});
test("existing Credit Notes remain visible even on an otherwise ineligible invoice", () => {
  assert.equal(keepCdSettlementRow({ category: "not_eligible", creditNoteReferences: [] }), false);
  assert.equal(keepCdSettlementRow({ category: "not_eligible", creditNoteReferences: [{ voucherNumber: "CN15" }] }), true);
  assert.equal(keepCdSettlementRow({ category: "not_eligible", status: "credited" }), true);
  assert.equal(keepCdSettlementRow({ category: "needs_review", status: "credit_note_review" }), true);
});
