import assert from "node:assert/strict";
import test from "node:test";
import { busyTallySnapshot, recordVerifiedCompany, serializeTallyRequest, tallyActivity, tallyTaskSignal, tryAcquireTallyTask } from "../src/tally/read-coordinator.mjs";
import { postTallyXml } from "../src/tally/xml.mjs";

test("a local CD/TOD task excludes cloud commands and probes until completion", async () => {
  const url = "http://coordination.example:9000";
  const task = tryAcquireTallyTask(url, "turnover_discount");
  assert.equal(tryAcquireTallyTask(`${url}/`, "cloud_command"), null);
  await task.run(async () => {
    recordVerifiedCompany(url, { name: "Expected", guid: "guid" });
    assert.equal(tallyActivity(url).activeCompany.guid, "guid");
    assert.equal(tryAcquireTallyTask(url, "cash_discount"), null);
  });
  assert.equal(tallyActivity(url), null);
  const next = tryAcquireTallyTask(url, "cloud_command");
  assert.ok(next); next.release();
});

test("a failed or cancelled task releases its reservation and propagates cancellation", async () => {
  const url = "http://cancel.example:9000";
  const cancellation = new AbortController();
  const task = tryAcquireTallyTask(url, "turnover_discount", cancellation.signal);
  await assert.rejects(task.run(async () => {
    assert.equal(tallyTaskSignal(url), cancellation.signal);
    cancellation.abort();
    await serializeTallyRequest(url, () => assert.fail("cancelled export must not run"), tallyTaskSignal(url));
  }), { name: "AbortError" });
  assert.equal(tallyActivity(url), null);
  assert.equal(await serializeTallyRequest(url, async () => "next"), "next");
});

test("XML requests and probes use a shared lane; timeout starts only after the lane is free", async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) await pending;
    return new Response("<ENVELOPE><RESULT>ok</RESULT></ENVELOPE>");
  });
  const url = "http://queue.example:9000";
  const first = postTallyXml(url, "export", { timeoutMs: 1000 });
  const second = postTallyXml(url, "probe", { timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test("failed XML request does not poison the lane", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) throw new Error("broken connection");
    return new Response("<ENVELOPE/>");
  });
  const url = "http://failure.example:9000";
  await assert.rejects(postTallyXml(url, "first"), /broken connection/);
  assert.equal(await postTallyXml(url, "second"), "<ENVELOPE/>");
});

test("browser cancellation aborts an in-flight XML fetch, not just the next chunk", async (t) => {
  let started;
  const fetching = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const url = "http://inflight-cancel.example:9000";
  const controller = new AbortController();
  const task = tryAcquireTallyTask(url, "turnover_discount", controller.signal);
  const request = task.run(() => postTallyXml(url, "export"));
  const rejected = assert.rejects(request, /This Tally read was stopped/);
  await fetching; controller.abort(); await rejected;
  assert.equal(tallyActivity(url), null);
});

test("busy heartbeat distinguishes cached company observations from fresh verification", () => {
  const known = { name: "Expected", guid: "guid" };
  const snapshot = busyTallySnapshot({ activeCompany: known }, null);
  assert.equal(snapshot.tallyBusy, true);
  assert.equal(snapshot.companySnapshotFresh, false);
  assert.deepEqual(snapshot.activeCompany, known);
  assert.equal(snapshot.error, null);
  assert.equal(busyTallySnapshot({}, null).companyLoaded, false);
  assert.equal(busyTallySnapshot({}, { companyLoaded: false, activeCompany: known }).activeCompany, null);
});
