import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function service(apiRequest) {
  const exports={};
  const source=readFileSync(new URL("./server-checks.ts",import.meta.url),"utf8");
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:()=>({apiRequest}),Date,Set});
  return exports;
}
const old={id:"old",kind:"tod",status:"succeeded",created_at:"2026-11-16",evaluation_run_id:"old-run"};

test("a reopened page discovers queued/running work and never walks backwards through completed history",()=>{
  const api=service(()=>assert.fail());
  const newest={...old,id:"new",evaluation_run_id:"new-run"};
  assert.equal(api.pickServerCheck([newest,old],"tod",new Set()).id,"new");
  assert.equal(api.pickServerCheck([newest,old],"tod",new Set(["new"])),null);
  const running={...newest,id:"running",status:"running"};
  assert.equal(api.pickServerCheck([newest,running,old],"tod",new Set(["new"])).id,"running");
  assert.equal(api.pickServerCheck([running],"cd",new Set()),null);
});

test("reopened running work is followed read-only and queued work explains an offline server",async()=>{
  let status="running";
  const calls=[];
  const api=service(async(_token,url,init)=>{calls.push({url,method:init?.method??"GET"});return url.endsWith("/mode")?{message:"The server is offline."}:{job:{...old,status},queuePosition:2};});
  assert.equal((await api.readServerCheck("token","company","job")).phase,"reading");
  status="queued";
  const queued=await api.readServerCheck("token","company","job");
  assert.match(queued.message,/2 checks ahead/);assert.match(queued.message,/offline/);
  assert.ok(calls.every(c=>c.method==="GET"));
});

test("a completed Tally read stays Saving until every saved customer result settles",async()=>{
  let status="processing";
  const api=service(async(_token,url)=>url.includes("check-jobs")?{job:{...old,progress:{save:{state:"saved"}}}}:{evaluationRun:{id:"old-run",status}});
  assert.equal((await api.readServerCheck("token","company","old")).phase,"saving");
  status="completed";
  assert.equal((await api.readServerCheck("token","company","old")).phase,null);
});

test("Stop targets the observed company's exact job without submitting another calculation",async()=>{
  const calls=[];
  const api=service(async(_token,url,init)=>{calls.push({url,method:init?.method});return{outcome:"running"};});
  await api.stopServerCheck("token","company","job");
  assert.deepEqual(calls,[{url:"/api/companies/company/check-jobs/job/cancel",method:"POST"}]);
});
