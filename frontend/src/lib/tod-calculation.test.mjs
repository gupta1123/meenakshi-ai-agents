import assert from "node:assert/strict";
import test from "node:test";
import { canUseTodCloudFallback, runExclusiveTodCalculation, runTodPeriodsInOrder, tallyReadErrorMessage, waitForTodRun } from "./tod-calculation.ts";

test("only an explicit missing local route permits cloud fallback, never network/timeout/busy failures", () => {
  assert.equal(canUseTodCloudFallback(Object.assign(new Error("missing route"), { code: "LOCAL_ROUTE_NOT_FOUND" })), true);
  for (const error of [new TypeError("Failed to fetch"), new Error("Local connector route not found."), new DOMException("timeout", "TimeoutError"), new Error("Tally is busy")]) {
    assert.equal(canUseTodCloudFallback(error), false);
  }
});

test("cloud fallback must finish saving before the next due period starts", async () => {
  const events = [];
  const periods = [{ start: "2025-04-01", end: "2025-06-30" }, { start: "2025-07-01", end: "2025-09-30" }];
  await runTodPeriodsInOrder(periods, async (period) => {
    events.push(`start:${period.start}`);
    const states = ["refreshing_tally", "waiting_for_tally", "evaluating", "completed"];
    await waitForTodRun(async () => ({ status: states.shift() }), (run) => events.push(run.status), async (ms) => assert.equal(ms, 30_000));
    events.push(`saved:${period.start}`);
  }, String);
  assert.ok(events.indexOf("saved:2025-04-01") < events.indexOf("start:2025-07-01"));
  assert.equal(events.filter((event) => event === "completed").length, 2);
});

test("a failed period stops the batch and identifies completed count and exact failed period", async () => {
  const started = [];
  const periods = [1, 2, 3].map((month) => ({ start: `2025-0${month}-01`, end: `2025-0${month}-28` }));
  await assert.rejects(runTodPeriodsInOrder(periods, async (period) => {
    started.push(period.start);
    if (started.length === 2) throw new Error("Tally did not respond in time.");
  }, (cause) => cause.message), /1 of 3 periods completed.*2025-02-01 to 2025-02-28.*Remaining periods were not started/);
  assert.deepEqual(started, ["2025-01-01", "2025-02-01"]);
});

test("failed, cancelled, and partially saved runs never advance a batch", async () => {
  for (const status of ["failed", "cancelled", "completed_with_issues"]) {
    await assert.rejects(waitForTodRun(async () => ({ status }), () => {}, async () => {}), /did not finish/);
  }
});

test("polling failures do not count as success and finalization has a bounded wait", async () => {
  await assert.rejects(waitForTodRun(async () => { throw new Error("network lost"); }, () => {}), /network lost/);
  let reads = 0;
  await assert.rejects(waitForTodRun(async () => { reads++; return { status: "evaluating" }; }, () => {}, async () => {}), /still being finalized/);
  assert.equal(reads, 41);
});

test("Tally timeout and busy failures have an actionable safe message", async () => {
  for (const message of ["Read active Tally company timed out after 60 seconds.", "The Tally read exceeded 10 minutes and was stopped. Reopen the connector and try again."]) {
    await assert.rejects(waitForTodRun(async () => ({ status: "failed", error_summary: message }), () => {}), /Tally did not respond in time/);
  }
  assert.match(tallyReadErrorMessage("Tally is busy with another check."), /Another Tally check/);
  assert.equal(tallyReadErrorMessage("Secret internal database error"), null);
});

test("whole-batch gate rejects repeat submissions and only clears after completion or failure", async () => {
  const gate = { current: false };
  const busy = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const first = runExclusiveTodCalculation(gate, () => pending, (state) => busy.push(state));
  await assert.rejects(runExclusiveTodCalculation(gate, async () => assert.fail("overlapping submission"), () => {}), /Another Tally check/);
  assert.equal(gate.current, true); assert.deepEqual(busy, [true]);
  release(); await first;
  assert.equal(gate.current, false); assert.deepEqual(busy, [true, false]);
  await assert.rejects(runExclusiveTodCalculation(gate, async () => { throw new Error("failed"); }, () => {}), /failed/);
  assert.equal(gate.current, false);
});
