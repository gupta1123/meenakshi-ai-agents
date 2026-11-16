import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function runner(apiRequest) {
  const exports={}, requests=[];
  const source=readFileSync(new URL("./local-tally.ts",import.meta.url),"utf8");
  const context={exports,require:()=>({apiRequest}),AbortSignal,DOMException,console,
    fetch:async(url)=>{requests.push(url);throw new Error("PC connector must not be contacted");},
    window:{setTimeout:(fn)=>{queueMicrotask(fn);return 1;}}};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {api:exports,requests};
}
test("an unresolved mode blocks both calculations and e-invoice reads without contacting a PC",async()=>{
  const {api,requests}=runner(()=>assert.fail("must not queue work"));
  api.setServerModeLookup(async()=>{throw new Error("mode lookup unavailable");});
  await assert.rejects(api.runLocalCashDiscount({}),/mode lookup unavailable/);
  await assert.rejects(api.readLocalNoteEInvoice({}),/mode lookup unavailable/);
  assert.equal(requests.length,0);
});
test("a previously opened PC page rechecks routing before a new calculation",async()=>{
  const posted=[];
  const {api,requests}=runner(async(_token,url,init)=>{
    if(init?.method==="POST"){posted.push(JSON.parse(init.body));return{job:{id:"job"}};}
    if(url.includes("result=0"))return{job:{progress:{save:{state:"saved",evaluationRunId:"run"}}}};
    return{job:{status:"succeeded",result:{rows:[],evidence:{}}}};
  });
  api.setServerCheckContext(null);
  api.setServerModeLookup(async()=>api.setServerCheckContext({companyId:"company",getToken:async()=>"token"}));
  const result=await api.runLocalCashDiscount({rule:{id:"rule"}});
  assert.equal(posted.length,1);assert.equal(posted[0].save,true);
  assert.equal(result.savedOnServer.evaluationRunId,"run");assert.equal(requests.length,0);
});
test("all TOD periods are submitted together before the page starts following progress",async()=>{
  let body;
  const {api}=runner(async(_token,url,init)=>{
    if(init?.method==="POST"){body=JSON.parse(init.body);return{job:{id:"job"}};}
    if(url.includes("result=0"))return{job:{progress:{save:{state:"saved",evaluationRunId:"run"}}}};
    return{job:{status:"succeeded",result:{rows:[],evidence:{}}}};
  });
  api.setServerCheckContext({companyId:"company",getToken:async()=>"token"});
  const batches=[{periodStart:"2026-04-01",periodEnd:"2026-06-30"},{periodStart:"2026-07-01",periodEnd:"2026-09-30"}];
  await api.runLocalTurnoverDiscount({batches,evaluatedOn:"2026-11-16"});
  assert.equal(body.body.batches.length,2);assert.equal(body.saveAsOfDate,"2026-11-16");
});
