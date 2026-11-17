import assert from "node:assert/strict";
import test from "node:test";
import { saveClaimedCheckJob } from "./check-job-save.ts";

const job = { id: "job-1", kind: "cd", requested_by: "person", organization_id: "org", company_id: "company", save_attempts: 1,
  request: { save: {}, body: { evaluatedOn: "2026-11-16" } }, result: { evidence: { invoices: [] } } };
test("restarting a saver retries the same evidence and permanent key without any browser", async () => {
  const inputs=[], finishes=[];
  let interrupted=true;
  const deps={ roles:async()=>["finance_approver"], saveCd:async(...args)=>{
    inputs.push(args); if(interrupted){interrupted=false;throw new Error("database connection lost");}
    return { evaluationRun:{id:"run-1"},totals:{autoQueued:0} };
  }, finish:async(state)=>finishes.push(state) };
  await saveClaimedCheckJob(job,deps);
  await saveClaimedCheckJob({...job,save_attempts:2},deps);
  assert.equal(finishes[0].state,"failed"); assert.equal(finishes[1].state,"saved");
  assert.deepEqual(inputs[0],inputs[1]); assert.equal(inputs[1][2],"check-job:job-1");
});
test("an account that lost permission cannot save a queued result", async () => {
  const states=[];
  await saveClaimedCheckJob(job,{roles:async()=>[],saveCd:()=>assert.fail("must not save"),finish:async(s)=>states.push(s)});
  assert.equal(states[0].state,"failed");
});
test("TOD saving preserves the period of each customer's evidence", async () => {
  let payload;
  const tod={...job,kind:"tod",request:{save:{asOfDate:"2026-09-30"},body:{evaluatedOn:"2026-11-16",periodStart:"2026-04-01",periodEnd:"2026-06-30"}},result:{evidence:{customerAggregates:[{customerId:"A",periodStart:"2026-07-01",periodEnd:"2026-09-30"}]}}};
  await saveClaimedCheckJob(tod,{roles:async()=>["administrator"],saveTod:async(_scope,p)=>{payload=p;return{evaluationRun:{id:"run"}};},finish:async(s)=>assert.equal(s.state,"saved")});
  assert.equal(payload.evidence.customerAggregates[0].periodStart,"2026-07-01");
  assert.equal(payload.asOfDate,"2026-09-30");
});

const periods = ["2026-03-31", "2026-06-30"];
const multiTod = { ...job, kind: "tod", request: { save: { asOfDate: "2026-06-30" }, body: { evaluatedOn: "2026-11-16" } }, result: { evidence: { customerAggregates: periods.map((end, index) => ({ customerId: "same-customer", periodStart: index ? "2026-04-01" : "2026-01-01", periodEnd: end })) } } };

test("all-due saving yields between periods and resumes with separate permanent keys for the same customer", async () => {
  let progress = {}, ready = false;
  const inputs = [], states = [];
  const deps = {
    roles: async () => ["administrator"],
    canSaveTod: async () => true, periodFinished: async () => ready,
    saveTod: async (_scope, payload, key) => { inputs.push({ payload, key }); return { evaluationRun: { id: `run-${inputs.length}` } }; },
    defer: async (periodRuns) => { progress = { save: { periodRuns: structuredClone(periodRuns) } }; },
    finish: async (state) => states.push(state),
  };
  await saveClaimedCheckJob(multiTod, deps);
  assert.equal(inputs.length, 1); assert.equal(states.length, 0);
  await saveClaimedCheckJob({ ...multiTod, progress }, deps);
  assert.equal(inputs.length, 1, "unfinished customer jobs must settle before the next period");
  ready = true;
  await saveClaimedCheckJob({ ...multiTod, progress }, deps);
  assert.equal(inputs.length, 2); assert.equal(states.length, 0);
  await saveClaimedCheckJob({ ...multiTod, progress }, deps);
  assert.deepEqual(states[0].evaluationRunIds, ["run-1", "run-2"]);
  assert.equal(states[0].evaluationRunId, "run-2");
  assert.deepEqual(inputs.map(({ payload }) => payload.asOfDate), periods);
  assert.ok(inputs.every(({ payload }) => payload.evidence.customerAggregates.length === 1));
  assert.deepEqual(inputs.map(({ key }) => key), ["check-job:job-1:2026-01-01:2026-03-31", "check-job:job-1:2026-04-01:2026-06-30"]);
});

test("a failed later save preserves completed periods and retries the same next-period key", async () => {
  const completed = [{ period: "2026-01-01:2026-03-31", evaluationRunId: "first-run" }];
  const keys = [], states = [];
  let failed = true;
  const deps = {
    roles: async () => ["administrator"], canSaveTod: async () => true, periodFinished: async () => true,
    saveTod: async (_scope, _payload, key) => { keys.push(key); if (failed) { failed = false; throw new Error("connection lost"); } return { evaluationRun: { id: "second-run" } }; },
    defer: async () => {}, finish: async (state) => states.push(state),
  };
  await saveClaimedCheckJob({ ...multiTod, progress: { save: { periodRuns: completed } } }, deps);
  assert.equal(states[0].state, "failed"); assert.deepEqual(states[0].periodRuns, completed);
  await saveClaimedCheckJob({ ...multiTod, progress: { save: states[0] }, save_attempts: 2 }, deps);
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
});

test("saving waits for another active TOD calculation without superseding it", async () => {
  let deferred = false;
  await saveClaimedCheckJob(multiTod, {
    roles: async () => ["administrator"], canSaveTod: async () => false,
    saveTod: async () => assert.fail("must wait for the active calculation"),
    defer: async (runs) => { assert.deepEqual(runs, []); deferred = true; },
    finish: async () => assert.fail("waiting is not a save failure"),
  });
  assert.equal(deferred, true);
});
