import assert from "node:assert/strict";
import test from "node:test";
import { canUseTodCloudFallback, isTransientTodReadError, refreshSavedTodResults, retryTodRead, runExclusiveTodCalculation, runTodPeriodsInOrder, tallyReadErrorMessage, waitForTodRun } from "./tod-calculation.ts";

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

test("read retries distinguish temporary outages from permissions, cancellation and validation errors", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isTransientTodReadError(Object.assign(new Error("read failed"), { status })), true);
  for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(isTransientTodReadError(Object.assign(new Error("read failed"), { status })), false);
  assert.equal(isTransientTodReadError(new TypeError("Failed to fetch")), true);
  assert.equal(isTransientTodReadError(new DOMException("timeout", "TimeoutError")), true);
  assert.equal(isTransientTodReadError(new DOMException("stopped", "AbortError")), false);
  assert.equal(isTransientTodReadError(new Error("The calculation does not match the selected period.")), false);
});

test("temporary status failures recover without restarting the period or advancing early", async () => {
  const events = [], delays = [], progress = [];
  const periods = [{ start: "2025-04-01", end: "2025-06-30" }, { start: "2025-07-01", end: "2025-09-30" }];
  let starts = 0, retryNotices = 0;
  await runTodPeriodsInOrder(periods, async (period) => {
    starts++;
    events.push(`start:${period.start}`);
    let polls = 0;
    await waitForTodRun(async () => {
      polls++;
      if (polls === 1) throw new TypeError("Failed to fetch");
      if (polls === 2) throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
      return { status: polls === 3 ? "evaluating" : "completed" };
    }, (run) => events.push(run.status), async (ms) => { delays.push(ms); }, () => { retryNotices++; });
    events.push(`saved:${period.start}`);
  }, String, (state) => progress.push(state));
  assert.equal(starts, 2);
  assert.equal(retryNotices, 4);
  assert.deepEqual(delays, [2000, 4000, 30000, 2000, 4000, 30000]);
  assert.ok(events.indexOf("saved:2025-04-01") < events.indexOf("start:2025-07-01"));
  assert.deepEqual(progress.map(({ index, completed }) => [index, completed]), [[1, 0], [1, 1], [2, 1], [2, 2]]);
});

test("repeated status-read outages stop safely with an unknown-completion warning", async () => {
  let reads = 0, starts = 0;
  const periods = [1, 2].map((month) => ({ start: `2025-0${month}-01`, end: `2025-0${month}-28` }));
  await assert.rejects(runTodPeriodsInOrder(periods, async () => {
    starts++;
    await waitForTodRun(async () => { reads++; throw new DOMException("timeout", "TimeoutError"); }, () => assert.fail("no completion was confirmed"), async () => {});
  }, (cause) => cause.message), /0 of 2 periods completed.*may still finish in the background.*Remaining periods were not started/);
  assert.equal(reads, 3);
  assert.equal(starts, 1);
});

test("authentication errors are not retried or turned into temporary outage warnings", async () => {
  const unauthorized = Object.assign(new Error("session expired"), { status: 401 });
  let reads = 0;
  await assert.rejects(waitForTodRun(async () => { reads++; throw unauthorized; }, () => {}, async () => assert.fail("must not retry authentication")), (cause) => cause === unauthorized);
  assert.equal(reads, 1);
});

test("recovered polling never treats a genuinely failed or partly saved run as success", async () => {
  for (const status of ["failed", "cancelled", "completed_with_issues"]) {
    let reads = 0;
    await assert.rejects(waitForTodRun(async () => {
      if (++reads === 1) throw Object.assign(new Error("read temporarily unavailable"), { status: 502 });
      return { status };
    }, () => {}, async () => {}), /did not finish/);
    assert.equal(reads, 2);
  }
});

test("read retry budget resets after each successful status read", async () => {
  let reads = 0, observed = 0;
  const run = await waitForTodRun(async () => {
    reads++;
    if (reads % 3 !== 0) throw new TypeError("Failed to fetch");
    return { status: reads === 6 ? "completed" : "evaluating" };
  }, () => { observed++; }, async () => {});
  assert.equal(run.status, "completed");
  assert.equal(reads, 6);
  assert.equal(observed, 2);
});

test("failed display refresh cannot undo a confirmed period or stop the next one", async () => {
  const events = [], warnings = [];
  const periods = [{ start: "2025-04-01", end: "2025-06-30" }, { start: "2025-07-01", end: "2025-09-30" }];
  await runTodPeriodsInOrder(periods, async (period) => {
    events.push(`start:${period.start}`);
    await waitForTodRun(async () => ({ status: "completed" }), () => {}, async () => {});
    events.push(`saved:${period.start}`);
    assert.equal(await refreshSavedTodResults(async () => { throw new TypeError("Failed to fetch"); }, (cause) => warnings.push(cause.message)), false);
  }, String);
  assert.equal(warnings.length, 2);
  assert.deepEqual(events, ["start:2025-04-01", "saved:2025-04-01", "start:2025-07-01", "saved:2025-07-01"]);
});

test("all six periods advance automatically and display is refreshed only once after completion", async () => {
  const periods = Array.from({ length: 6 }, (_, i) => ({ start: `2025-0${i + 1}-01`, end: `2025-0${i + 1}-28` }));
  const saved = [], progress = [];
  await runTodPeriodsInOrder(periods, async (period) => {
    await waitForTodRun(async () => ({ status: "completed" }), () => {}, async () => {});
    saved.push(period.start);
  }, String, (state) => progress.push(state));
  let refreshes = 0;
  assert.equal(await refreshSavedTodResults(async () => { refreshes++; }, () => assert.fail("unexpected refresh error")), true);
  assert.equal(saved.length, 6);
  assert.equal(refreshes, 1);
  assert.deepEqual(progress.at(-1), { index: 6, completed: 6, total: 6, ...periods[5] });
});

test("temporary bootstrap reads use bounded backoff and retain the original request", async () => {
  let reads = 0;
  const delays = [];
  const result = await retryTodRead(async () => {
    reads++;
    if (reads < 3) throw new TypeError("Failed to fetch");
    return { periodStart: "2025-07-01", periodEnd: "2025-09-30" };
  }, async (delay) => { delays.push(delay); });
  assert.deepEqual(result, { periodStart: "2025-07-01", periodEnd: "2025-09-30" });
  assert.deepEqual(delays, [2000, 4000]);
});
