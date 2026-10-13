import assert from "node:assert/strict";
import test from "node:test";
import { obsoleteEvaluationReadReason, retireEvaluationRead, retireObsoleteEvaluationReads, OBSOLETE_READ_PREFIX } from "./refresh-commands.mjs";
import { postingProgress } from "../notes/posting-progress.mjs";

const command = { id: "read-1", company_id: "company-1", command_type: "fetch_meenakshi_evidence", payload: { evaluationRunId: "run-1" } };
const run = { id: "run-1", company_id: "company-1", status: "refreshing_tally", request_context: {}, attempts: 1, max_attempts: 8 };

test("a queued local calculation never needs a second connector read", () => {
  for (const schemeType of ["cd", "tod"]) {
    assert.match(obsoleteEvaluationReadReason(command, { ...run, status: "queued", request_context: { schemeType, localFirst: true } }), /local Tally evidence/);
  }
});
test("finished calculations stop reads, but a retryable legacy calculation keeps its read", () => {
  for (const status of ["completed", "completed_with_issues", "cancelled"]) assert.ok(obsoleteEvaluationReadReason(command, { ...run, status }));
  assert.equal(obsoleteEvaluationReadReason(command, run), null);
  assert.equal(obsoleteEvaluationReadReason(command, { ...run, status: "failed" }), null);
  assert.ok(obsoleteEvaluationReadReason(command, { ...run, status: "failed", attempts: 8 }));
});
test("cleanup cannot cancel financial commands or another company or run", async () => {
  for (const command_type of ["create_credit_note", "create_debit_note", "verify_credit_note"]) {
    assert.equal(obsoleteEvaluationReadReason({ ...command, command_type }, { ...run, status: "completed" }), null);
    await retireEvaluationRead({ from() { assert.fail("Financial commands must not be updated"); } }, { ...command, command_type }, `${OBSOLETE_READ_PREFIX} test`);
  }
  assert.equal(obsoleteEvaluationReadReason(command, { ...run, company_id: "company-2", status: "completed" }), null);
  assert.equal(obsoleteEvaluationReadReason(command, { ...run, id: "other-run", status: "completed" }), null);
  assert.equal(obsoleteEvaluationReadReason(command, null), null);
  await assert.rejects(retireObsoleteEvaluationReads({}, {}), /scope is required/);
});
test("cleanup retires only obsolete reads and preserves saved calculation rows", async () => {
  const writes = [];
  const reads = [command, { ...command, id: "read-2", payload: { evaluationRunId: "run-2" } }];
  const db = { from(table) {
    let update = null;
    const filters = [];
    const chain = {
      select() { return chain; }, eq(...args) { filters.push(args); return chain; }, in(...args) { filters.push(args); return chain; }, limit() { return chain; },
      update(value) { update = value; return chain; },
      then(resolve, reject) {
        if (update) writes.push({ table, update, filters });
        const data = update ? null : table === "tally_commands" ? reads : [{ ...run, status: "completed" }, { ...run, id: "run-2" }];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return chain;
  } };
  assert.equal(await retireObsoleteEvaluationReads(db, { companyId: "company-1" }), 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].table, "tally_commands");
  assert.equal(writes[0].update.status, "dead_letter");
  assert.deepEqual(writes[0].filters.find(([key]) => key === "id"), ["id", "read-1"]);
});
test("note progress follows the connector lease rather than the posting label", () => {
  const note = { status: "queued", created_at: "2026-10-13T07:59:21Z" };
  assert.equal(postingProgress(note, null).stage, "queued");
  assert.equal(postingProgress(note, { status: "queued", command_type: "create_debit_note" }).label, "Waiting for Tally…");
  assert.equal(postingProgress(note, { status: "sending", command_type: "create_debit_note", locked_at: "2026-10-13T08:01:29Z" }).label, "Creating and verifying…");
  assert.equal(postingProgress(note, { status: "sending", command_type: "verify_credit_note" }).stage, "verifying");
  assert.equal(postingProgress({ ...note, status: "created_verified" }, { status: "sending" }), null);
});
