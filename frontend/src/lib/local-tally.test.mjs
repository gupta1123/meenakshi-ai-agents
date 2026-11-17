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

test("version telemetry never probes a staff PC in server or unresolved mode, while PC mode retains its identity read", async()=>{
  const {api,requests}=runner(()=>assert.fail("version telemetry must not submit work"));
  api.setServerModeLookup(async()=>api.setServerCheckContext({companyId:"company",getToken:async()=>"token"}));
  assert.equal(await api.readLocalConnectorVersion(),null);
  assert.equal(requests.length,0);
  api.setServerModeLookup(async()=>{throw new Error("mode unavailable");});
  assert.equal(await api.readLocalConnectorVersion(),null);
  assert.equal(requests.length,0);
  api.setServerModeLookup(async()=>api.setServerCheckContext(null));
  assert.equal(await api.readLocalConnectorVersion(),null);
  assert.deepEqual(requests,["http://127.0.0.1:3219/v1/identity"]);
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

test("separately prepared due periods produce one saved server job, including every period",async()=>{
  const requests=[];
  const {api}=runner(async(_token,url,init)=>{
    requests.push({url,method:init?.method??"GET",body:init?.body&&JSON.parse(init.body)});
    if(init?.method==="POST")return{job:{id:"durable-batch"}};
    if(url.includes("result=0"))return{job:{progress:{save:{state:"saved",evaluationRunId:"one-run"}}}};
    return{job:{status:"succeeded",result:{rows:[],evidence:{}}}};
  });
  api.setServerCheckContext({companyId:"company",getToken:async()=>"token"});
  const periods=[["2025-04-01","2025-06-30"],["2025-07-01","2025-09-30"],["2026-04-01","2026-06-30"]];
  const prepared=periods.map(([periodStart,periodEnd])=>({expectedCompany:{guid:"tally-company"},activeSchemeVersionId:"rule",evaluatedOn:"2026-11-17",periods:[],batches:[{periodStart,periodEnd,rule:{id:"rule"}}]}));
  const result=await api.runLocalTurnoverDiscount(api.combineTodBootstraps(prepared),undefined,{serverSave:{asOfDate:"2026-06-30"}});
  const submitted=requests.filter(r=>r.method==="POST");
  assert.equal(submitted.length,1,"later periods must not depend on another browser-side submission");
  assert.deepEqual(JSON.parse(JSON.stringify(submitted[0].body.body.batches.map(b=>[b.periodStart,b.periodEnd]))),periods);
  assert.equal(submitted[0].body.saveAsOfDate,"2026-06-30");
  assert.equal(result.savedOnServer.evaluationRunId,"one-run");
});

test("preparation refuses a company/rule change and Stop before submission queues nothing",async()=>{
  const {api}=runner(()=>assert.fail("a stopped check must not be submitted"));
  const bootstrap={expectedCompany:{guid:"one"},activeSchemeVersionId:"rule",evaluatedOn:"2026-11-17",batches:[{}]};
  assert.throws(()=>api.combineTodBootstraps([bootstrap,{...bootstrap,expectedCompany:{guid:"two"}}]),/changed/);
  api.setServerCheckContext({companyId:"company",getToken:async()=>"token"});
  const controller=new AbortController();controller.abort();
  await assert.rejects(api.runLocalCashDiscount({},undefined,{signal:controller.signal}),/cancelled/);
});
