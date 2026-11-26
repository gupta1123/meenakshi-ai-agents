import assert from "node:assert/strict";
import test from "node:test";
import { companiesMatch, processOneCheckJob, runCheckJob } from "../src/server-jobs.mjs";

const company = { guid: "G-1", name: "Meenakshi Udyog" };
const baseJob = (over = {}) => ({
  id: "job-1", kind: "cd", attempt: 1, requestedBy: "u1", expectedTallyCompany: company,
  request: { body: { rule: { cdDiscountBasis: "percent" }, evaluatedOn: "2026-06-30", voucherScope: { dateFrom: "2026-04-01", dateTo: "2026-06-30" } } },
  ...over,
});
const checkpoint = () => ({ cleared: false, settled: false, clear() { this.cleared = true; }, settle() { this.settled = true; } });

function makeDeps(over = {}) {
  const calls = { finish: [], progress: [] };
  const cp = checkpoint();
  const deps = {
    createCheckpoint: () => cp,
    fetchLiveCdEvidence: async (_c, ctx) => { ctx.onProgress({ done: 1, total: 1 }); return { invoices: [{ id: 1 }] }; },
    fetchLiveTodEvidence: async () => ({ customerAggregates: [] }),
    evaluateLocalCashDiscount: () => ({ rows: ["cd"] }),
    evaluateCashDiscountSettlements: () => ({ rows: ["settlement"] }),
    evaluateLocalTurnoverDiscount: () => ({ rows: ["tod"] }),
    claimNextCheckJob: async () => ({ job: baseJob() }),
    reportCheckJobProgress: async (_c, id, p) => { calls.progress.push(p); return { ok: true, cancelRequested: false }; },
    finishCheckJob: async (_c, id, payload) => { calls.finish.push({ id, ...payload }); return { ok: true }; },
    sendHeartbeat: async () => ({ ok: true }),
    ...over,
  };
  return { deps, calls, cp };
}

test("company match uses the GUID, falling back to the name", () => {
  assert.equal(companiesMatch({ guid: "A" }, { guid: "a" }), true);
  assert.equal(companiesMatch({ guid: "A", name: "X" }, { guid: "B", name: "X" }), false);
  assert.equal(companiesMatch({ name: "X" }, { name: " x " }), true);
  assert.equal(companiesMatch({ name: "" }, { name: "" }), false);
});

test("a finished check reports the result in the PC connector's shape", async () => {
  const { deps, calls, cp } = makeDeps();
  assert.equal(await processOneCheckJob({}, company, {}, deps), true);
  assert.equal(calls.finish.length, 1);
  assert.equal(calls.finish[0].status, "succeeded");
  assert.deepEqual(calls.finish[0].result.rows, ["cd"]);
  assert.ok(calls.finish[0].result.evidence && calls.finish[0].result.timings);
  assert.equal(cp.cleared, true);
});

test("nothing queued means nothing happens", async () => {
  const { deps, calls } = makeDeps({ claimNextCheckJob: async () => ({ job: null }) });
  assert.equal(await processOneCheckJob({}, company, {}, deps), false);
  assert.equal(calls.finish.length, 0);
});

test("with no Tally company open the job is not even claimed", async () => {
  let claimed = false;
  const { deps } = makeDeps({ claimNextCheckJob: async () => { claimed = true; return { job: baseJob() }; } });
  assert.equal(await processOneCheckJob({}, null, {}, deps), false);
  assert.equal(claimed, false);
});

test("the wrong Tally company fails the job with a clear message and reads nothing", async () => {
  let read = false;
  const { deps, calls } = makeDeps({ fetchLiveCdEvidence: async () => { read = true; return { invoices: [] }; } });
  await processOneCheckJob({}, { guid: "OTHER", name: "Another Co" }, {}, deps);
  assert.equal(read, false);
  assert.equal(calls.finish[0].status, "failed");
  assert.match(calls.finish[0].failureReason, /Another Co.*Meenakshi Udyog/);
});

test("a Tally read failure is reported as failed at the read step", async () => {
  const { deps, calls } = makeDeps({ fetchLiveCdEvidence: async () => { throw new Error("Tally did not answer"); } });
  await processOneCheckJob({}, company, {}, deps);
  assert.equal(calls.finish[0].status, "failed");
  assert.equal(calls.finish[0].failingStep, "tally_read");
});

test("a calculation failure is reported as failed at the calculation step", async () => {
  const { deps, calls } = makeDeps({ evaluateLocalCashDiscount: () => { throw new Error("bad rule"); } });
  await processOneCheckJob({}, company, {}, deps);
  assert.equal(calls.finish[0].failingStep, "calculation");
});

test("a user's Stop ends the check as cancelled and keeps the progress", async () => {
  let commandsAfterStop = 0;
  const { deps, calls, cp } = makeDeps({
    reportCheckJobProgress: async () => ({ ok: true, cancelRequested: true }),
    fetchLiveCdEvidence: async (_c, ctx) => {
      await ctx.betweenWindows();
      if (ctx.isCancelled()) throw new Error("This Cash Discount check was stopped.");
      return { invoices: [] };
    },
  });
  await processOneCheckJob({}, company, { processCommand: async () => { commandsAfterStop += 1; } }, deps);
  assert.equal(commandsAfterStop, 0, "Stop must prevent even an attempted side command");
  assert.equal(calls.finish[0].status, "cancelled");
  assert.equal(cp.settled, true);
});

test("a Credit Note waiting in the queue runs between read windows", async () => {
  const order = [];
  const { deps } = makeDeps({
    fetchLiveCdEvidence: async (_c, ctx) => { order.push("window1"); await ctx.betweenWindows(); order.push("window2"); await ctx.betweenWindows(); return { invoices: [] }; },
  });
  await processOneCheckJob({}, company, { processCommand: async () => { order.push("note"); } }, deps);
  assert.deepEqual(order, ["window1", "note", "window2", "note"]);
});

test("a failing side task between windows does not fail the check", async () => {
  const { deps, calls } = makeDeps({
    fetchLiveCdEvidence: async (_c, ctx) => { await ctx.betweenWindows(); await ctx.betweenWindows(); return { invoices: [] }; },
  });
  await processOneCheckJob({}, company, { processCommand: async () => { throw new Error("Could not claim Tally command."); } }, deps);
  assert.equal(calls.finish[0].status, "succeeded");
});

test("if the lease is lost the result is dropped, not saved", async () => {
  const { deps, calls } = makeDeps({ reportCheckJobProgress: async () => ({ ok: false, cancelRequested: false }), fetchLiveCdEvidence: async (_c, ctx) => { await ctx.betweenWindows(); return { invoices: [] }; } });
  await processOneCheckJob({}, company, { processCommand: async () => {} }, deps);
  assert.equal(calls.finish.length, 0);
});

test("an unknown kind is refused", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => runCheckJob(baseJob({ kind: "payroll" }), { activeCompany: company, isCancelled: () => false, onProgress() {} }, deps), /cannot run/);
});

test("an e-invoice read returns the note's details", async () => {
  let asked;
  const { deps, calls } = makeDeps({
    claimNextCheckJob: async () => ({ job: baseJob({ kind: "einvoice", request: { noteKind: "credit", date: "2026-06-30", voucherNumber: "CN-1" } }) }),
    readNoteEInvoice: async (input) => { asked = input; return { irn: "IRN1", ackNo: "9", ackDate: null, signedQr: "QR" }; },
  });
  await processOneCheckJob({ tallyUrl: "http://t" }, company, {}, deps);
  assert.equal(calls.finish[0].status, "succeeded");
  assert.equal(calls.finish[0].result.einvoice.irn, "IRN1");
  assert.deepEqual(asked, { tallyUrl: "http://t", companyName: "Meenakshi Udyog", date: "2026-06-30", voucherNumber: "CN-1", kind: "credit" });
});

test("a note that is not e-invoiced yet returns null, not an error", async () => {
  const { deps, calls } = makeDeps({
    claimNextCheckJob: async () => ({ job: baseJob({ kind: "einvoice", request: { noteKind: "debit", date: "2026-06-30", voucherNumber: "DN-1" } }) }),
    readNoteEInvoice: async () => null,
  });
  await processOneCheckJob({}, company, {}, deps);
  assert.equal(calls.finish[0].status, "succeeded");
  assert.equal(calls.finish[0].result.einvoice, null);
});

test("tod check uses the turnover evaluator", async () => {
  const { deps, calls } = makeDeps({ claimNextCheckJob: async () => ({ job: baseJob({ kind: "tod", request: { body: { rule: {}, evaluatedOn: "2026-06-30", periodStart: "2026-04-01", periodEnd: "2026-06-30" } } }) }) });
  await processOneCheckJob({}, company, {}, deps);
  assert.deepEqual(calls.finish[0].result.rows, ["tod"]);
});

test("a successful read is not marked failed when uploading the result is interrupted", async () => {
  const statuses = [];
  const { deps } = makeDeps({ finishCheckJob: async (_c, _id, body) => {
    statuses.push(body.status);
    throw new Error("network interrupted");
  } });
  await processOneCheckJob({}, company, {}, deps);
  assert.deepEqual(statuses, ["succeeded"], "leave the attempt recoverable instead of discarding the successful calculation");
});

test("a long read renews its lease and heartbeat before the three-minute lease expires", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let renewals = 0, heartbeats = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { deps } = makeDeps({
    fetchLiveCdEvidence: async () => { await waiting; return { invoices: [] }; },
    reportCheckJobProgress: async (_c, _id, _p, attempt) => { assert.equal(attempt, 1); renewals++; return { ok: true }; },
    sendHeartbeat: async () => { heartbeats++; },
  });
  const running = processOneCheckJob({ heartbeatIntervalMs: 15_000 }, company, {}, deps);
  await Promise.resolve();
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(20_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  release();
  await running;
  assert.ok(renewals >= 5, "renew repeatedly during the real waiting read");
  assert.ok(heartbeats >= 5, "the UI must continue seeing the connector online");
});

test("one queued TOD job reads every period and returns evidence ready for browser-independent saving", async () => {
  const periods = [["2026-04-01","2026-06-30"],["2026-07-01","2026-09-30"]];
  const read = [];
  const {deps}=makeDeps({
    fetchLiveTodEvidence: async (command) => {
      read.push(command.payload.voucherScope.dateFrom);
      return {mode:"live_tod_batch_aggregate",chunks:1,vouchersScanned:1,matchingVouchers:1,sourceFingerprint:command.payload.voucherScope.dateFrom,customerAggregates:[{customerId:"A",eligibleTaxableValue:"10000",eligibleTonnes:"2",missingUnits:[]}]};
    },
    evaluateLocalTurnoverDiscount: (_r,_d,start,end) => ({rows:[{periodStart:start,periodEnd:end}],totals:{customersChecked:1,qualified:1,needAttention:0,projectedDiscount:"700.00"}}),
  });
  const batches=periods.map(([periodStart,periodEnd])=>({periodStart,periodEnd,rule:{},voucherScope:{dateFrom:periodStart,dateTo:periodEnd}}));
  const result=await runCheckJob(baseJob({kind:"tod",request:{body:{evaluatedOn:"2026-11-16",batches}}}),{config:{},activeCompany:company,isCancelled:()=>false,onProgress(){}},deps);
  assert.deepEqual(read,periods.map(([start])=>start));
  assert.equal(result.totals.projectedDiscount,"1400.00");
  assert.deepEqual(result.evidence.customerAggregates.map((a)=>[a.periodStart,a.periodEnd]),periods);
});

test("companies that share a GUID but are different financial years do not match", () => {
  const y25 = { guid: "g", name: "Co - (2025-2026)", booksFrom: "2025-04-01" };
  const y26 = { guid: "G", name: "Co - (2026-2027)", booksFrom: "2026-04-01" };
  assert.equal(companiesMatch(y25, y26), false);
  assert.equal(companiesMatch(y25, { ...y25, guid: "G", name: "Renamed" }), true);
  // A record that does not know its year yet keeps matching on the GUID, as before.
  assert.equal(companiesMatch({ guid: "g", name: "Co" }, y26), true);
});
