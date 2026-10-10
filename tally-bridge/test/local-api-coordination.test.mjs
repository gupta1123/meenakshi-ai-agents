import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { startLocalApi } from "../src/local-api.mjs";
import { tallyActivity, tallyTaskSignal, tryAcquireTallyTask } from "../src/tally/read-coordinator.mjs";

const company = { name: "Test Company", guid: "test-guid" };
const body = {
  expectedCompany: company, evaluatedOn: "2026-07-01", periodStart: "2026-04-01", periodEnd: "2026-06-30",
  rule: { id: "test-rule", roundingScale: 2, roundingMethod: "half_up", tiers: [], reviewCalendar: { nonWorkingIsoWeekdays: [7], activeHolidayDates: [] } },
};
async function setup(t, options = {}) {
  const config = { tallyUrl: `http://${t.name.replaceAll(/[^a-z]/gi, "")}.example:9000`, connectorId: "test-connector" };
  const api = startLocalApi(config, { port: 0, probeCompany: async () => company, ...options });
  await once(api.server, "listening");
  const base = `http://127.0.0.1:${api.server.address().port}`;
  t.after(() => { api.close(); api.server.closeAllConnections(); });
  return { api, config, base };
}
const post = (base, path, input = body, signal) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });

test("overlapping CD/TOD/einvoice calls are rejected; health stays responsive without probing busy Tally", async (t) => {
  let release, started;
  const pending = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { started = resolve; });
  let probes = 0;
  const { base, config } = await setup(t, {
    probeCompany: async () => { probes++; return company; },
    fetchTodEvidence: async (_command, context) => {
      context.onProgress({ done: 1, total: 4 }); started(); await pending;
      return { customerAggregates: [] };
    },
  });
  const first = post(base, "/v1/turnover-discount");
  await reading;
  for (const path of ["/v1/turnover-discount", "/v1/cash-discount", "/v1/einvoice"]) {
    const response = await post(base, path); assert.equal(response.status, 409);
    assert.equal((await (await fetch(`${base}/v1/progress`)).json()).progress.done, 1);
  }
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 503); assert.equal((await health.json()).busy, true);
  assert.equal(probes, 1);
  assert.equal(tryAcquireTallyTask(config.tallyUrl, "cloud_command"), null);
  assert.equal((await (await fetch(`${base}/v1/progress`)).json()).progress.done, 1);
  release(); assert.equal((await first).status, 200);
  assert.equal((await (await fetch(`${base}/v1/progress`)).json()).progress, null);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("failed Tally read clears progress and permits a retry without weakening company validation", async (t) => {
  let reads = 0;
  const { base, config } = await setup(t, { fetchTodEvidence: async () => { reads++; throw new Error("Read active Tally company timed out after 60 seconds."); } });
  assert.equal((await post(base, "/v1/turnover-discount")).status, 422);
  assert.equal(tallyActivity(config.tallyUrl), null);
  assert.equal((await (await fetch(`${base}/v1/progress`)).json()).progress, null);
  assert.equal((await post(base, "/v1/turnover-discount", { ...body, expectedCompany: { name: "Wrong", guid: "wrong-guid" } })).status, 422);
  assert.equal(reads, 1);
  assert.equal((await post(base, "/v1/turnover-discount")).status, 422);
  assert.equal(reads, 2);
});

test("closing the browser request cancels the read and clears stale progress", async (t) => {
  let started, cancelled;
  const reading = new Promise((resolve) => { started = resolve; });
  const stopped = new Promise((resolve) => { cancelled = resolve; });
  const { base, config } = await setup(t, {
    fetchTodEvidence: async (_command, context) => {
      const signal = tallyTaskSignal(context.config.tallyUrl);
      started();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      assert.equal(context.isCancelled(), true);
      cancelled(); throw new Error("This Tally read was stopped.");
    },
  });
  const controller = new AbortController();
  const request = post(base, "/v1/turnover-discount", body, controller.signal);
  const rejected = assert.rejects(request, { name: "AbortError" });
  await reading; controller.abort(); await rejected; await stopped;
  // Flush the task's finally block before observing the next request.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tallyActivity(config.tallyUrl), null);
  assert.equal((await (await fetch(`${base}/v1/progress`)).json()).progress, null);
});

test("a cloud command reservation rejects local calculations without reading Tally", async (t) => {
  const { base, config } = await setup(t, { probeCompany: async () => assert.fail("cloud command owns Tally") });
  const command = tryAcquireTallyTask(config.tallyUrl, "cloud_command");
  try { assert.equal((await post(base, "/v1/cash-discount")).status, 409); }
  finally { command.release(); }
});

test("successful CD checks clear progress just like TOD checks", async (t) => {
  const { base, config } = await setup(t, { fetchCdEvidence: async () => ({ invoices: [] }) });
  const response = await post(base, "/v1/cash-discount", { expectedCompany: company, evaluatedOn: "2026-07-01", rule: { slabs: [], calendar: { activeHolidayDates: [], nonWorkingIsoWeekdays: [7] } } });
  assert.equal(response.status, 200);
  assert.equal(tallyActivity(config.tallyUrl), null);
  assert.equal((await (await fetch(`${base}/v1/progress`)).json()).progress, null);
});

for (const backgroundName of ["connection_check", "command_poll"]) {
  test(`a TOD request waits for ${backgroundName}, then reads the original body exactly once`, async (t) => {
    let probes = 0, reads = 0;
    const { base, config } = await setup(t, {
      probeCompany: async () => { probes++; return company; },
      fetchTodEvidence: async () => { reads++; return { customerAggregates: [] }; },
    });
    const background = tryAcquireTallyTask(config.tallyUrl, backgroundName);
    t.after(() => background.release());
    const response = post(base, "/v1/turnover-discount");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(probes, 0);
    assert.equal(reads, 0);
    assert.equal((await post(base, "/v1/cash-discount")).status, 409);
    background.release();
    assert.equal((await response).status, 200);
    assert.equal(probes, 1);
    assert.equal(reads, 1);
    assert.equal(tallyActivity(config.tallyUrl), null);
  });
}

test("a CD request also waits behind a brief connection check", async (t) => {
  let reads = 0;
  const { base, config } = await setup(t, { fetchCdEvidence: async () => { reads++; return { invoices: [] }; } });
  const background = tryAcquireTallyTask(config.tallyUrl, "connection_check");
  t.after(() => background.release());
  const response = post(base, "/v1/cash-discount", { expectedCompany: company, evaluatedOn: "2026-07-01", rule: { slabs: [], calendar: { activeHolidayDates: [], nonWorkingIsoWeekdays: [7] } } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, 0);
  background.release();
  assert.equal((await response).status, 200);
  assert.equal(reads, 1);
});

test("a waiting browser request is rejected when the poll claims an actual cloud job", async (t) => {
  const { base, config } = await setup(t, { probeCompany: async () => assert.fail("claimed cloud job owns Tally") });
  const poll = tryAcquireTallyTask(config.tallyUrl, "command_poll");
  t.after(() => poll.release());
  const response = post(base, "/v1/turnover-discount");
  await new Promise((resolve) => setTimeout(resolve, 30));
  poll.setName("cloud_command");
  assert.equal((await response).status, 409);
  assert.equal(tallyActivity(config.tallyUrl).name, "cloud_command");
  assert.equal((await (await fetch(`${base}/v1/progress`)).json()).progress, null);
});

test("closing a queued browser request prevents a delayed calculation from starting", async (t) => {
  const { base, config } = await setup(t, { probeCompany: async () => assert.fail("cancelled request must never probe Tally") });
  const background = tryAcquireTallyTask(config.tallyUrl, "connection_check");
  t.after(() => background.release());
  const controller = new AbortController();
  const request = post(base, "/v1/turnover-discount", body, controller.signal);
  const rejected = assert.rejects(request, { name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort(); await rejected;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tallyActivity(config.tallyUrl).name, "connection_check");
  background.release();
  assert.equal(tallyActivity(config.tallyUrl), null);
  const next = tryAcquireTallyTask(config.tallyUrl, "cloud_command");
  assert.ok(next); next.release();
});

test("a queued read still verifies the actual company before reading any evidence", async (t) => {
  const { base, config } = await setup(t, { fetchTodEvidence: async () => assert.fail("wrong company must never be read") });
  const background = tryAcquireTallyTask(config.tallyUrl, "connection_check");
  t.after(() => background.release());
  const response = post(base, "/v1/turnover-discount", { ...body, expectedCompany: { name: "Wrong", guid: "wrong-guid" } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  background.release();
  assert.equal((await response).status, 422);
  assert.equal(tallyActivity(config.tallyUrl), null);
});
