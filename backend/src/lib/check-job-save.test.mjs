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
