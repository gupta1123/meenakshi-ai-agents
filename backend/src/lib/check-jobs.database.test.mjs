import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createServer } from "node:http";
import { once } from "node:events";
import vm from "node:vm";
import ts from "typescript";
import { buildCheckJobInput, CheckJobRequestError } from "./check-jobs.ts";
import { isUuid, readBridgeToken } from "./security.ts";
import { bridgeVersionIsOlder } from "./bridge.ts";
import { processOneCheckJob } from "../../../tally-bridge/src/server-jobs.mjs";

// Real PostgreSQL functions/indexes in an isolated process. No .env or network.
const db = new PGlite();
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.profiles(id uuid primary key);
    create table public.companies(id uuid primary key,organization_id uuid not null,code text,unique(id,organization_id));
    create table public.tally_connectors(id uuid primary key default gen_random_uuid(),organization_id uuid,installation_key text,display_name text,machine_fingerprint text,control_token_hash text,status text,paired_at timestamptz,last_heartbeat_at timestamptz);
    create table public.tally_connector_company_bindings(organization_id uuid,company_id uuid,connector_id uuid,expected_tally_company_guid text,expected_tally_company_name text,is_active boolean);
    create table public.tally_commands(id uuid primary key default gen_random_uuid(),company_id uuid,status text);`);
  for (const name of ["20261105120000_server_check_jobs.sql", "20261116182141_server_check_job_recovery.sql"])
    await db.exec(await readFile(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8"));
});
after(async () => db.close());

async function fixture(mode = "server") {
  const org=randomUUID(), company=randomUUID(), connector=randomUUID();
  await db.query("insert into companies values($1,$2,null)",[company,org]);
  await db.query("insert into tally_connectors(id,status) values($1,'paired')",[connector]);
  await db.query("insert into tally_connector_company_bindings(company_id,connector_id,is_active) values($1,$2,true)",[company,connector]);
  await db.query("insert into tally_connector_modes(connector_id,mode) values($1,$2)",[connector,mode]);
  return {org,company,connector,worker:`meenakshi-bridge:${connector}:installation`,
    async request(key="cd:A",save=true) {
      return (await db.query("select request_tally_check_job_v2($1,$2,'cd',$3,$4,null) as r",[org,company,key,{save:save?{}:null,body:{}}])).rows[0].r;
    },
    async claim() { return (await db.query("select * from claim_tally_check_job_v2($1,$2,180)",[connector,this.worker])).rows[0]; },
    async expire(id) { await db.query("update tally_check_jobs set lease_expires_at=now()-interval '1 second' where id=$1",[id]); },
    async finish(job,result={evidence:{}}) { return (await db.query("select finish_tally_check_job_v2($1,$2,$3,'succeeded',$4,null,null) as r",[job.id,this.worker,job.attempts,result])).rows[0].r; },
    async renew(job) { return (await db.query("select renew_tally_check_job_v2($1,$2,$3,180,'{}') as r",[job.id,this.worker,job.attempts])).rows[0].r; },
  };
}

test("PC mode refuses requests with the documented error", async () => {
  const f=await fixture("pc");
  await assert.rejects(f.request(),/not a server/);
  assert.equal(await f.claim(),undefined);
});
test("identical requests join and different requests wait behind one active job", async () => {
  const f=await fixture();
  const first=await f.request(),same=await f.request(),other=await f.request("cd:B");
  assert.equal(same.joined,true); assert.equal(first.job.id,same.job.id);
  assert.notEqual(first.job.id,other.job.id);
  assert.equal((await f.claim()).id,first.job.id);
  assert.equal(await f.claim(),undefined);
});
test("a superseded attempt cannot renew or finish even with the same installation worker", async () => {
  const f=await fixture(); await f.request(); const old=await f.claim();
  await f.expire(old.id);
  assert.equal((await f.renew(old)).ok,false,"an expired lease cannot resurrect itself");
  const current=await f.claim(); assert.equal(current.attempts,old.attempts+1);
  assert.equal((await f.renew(old)).ok,false);
  assert.equal(await f.finish(old),false);
  assert.equal(await f.finish(current),true);
});
test("Stop survives a crash and a late result cannot change it to success", async () => {
  const f=await fixture(); await f.request(); const job=await f.claim();
  await db.query("select cancel_tally_check_job($1,$2)",[job.id,f.company]);
  await f.expire(job.id); assert.equal(await f.claim(),undefined);
  assert.equal((await db.query("select status from tally_check_jobs where id=$1",[job.id])).rows[0].status,"cancelled");
  assert.equal(await f.finish(job),false);
});
test("accepted results and save work commit together; retrying an upload is idempotent", async () => {
  const f=await fixture(); await f.request(); const job=await f.claim();
  assert.equal(await f.finish(job),true); assert.equal(await f.finish(job),true);
  assert.equal(await f.finish(job,{different:true}),false);
  assert.equal((await db.query("select save_state from tally_check_jobs where id=$1",[job.id])).rows[0].save_state,"pending");
});
test("saving is reclaimed after a backend crash; the old saver cannot finish", async () => {
  // Limit claims to this fixture: earlier tests intentionally left pending saves.
  await db.query("update tally_check_jobs set save_state='saved' where save_state='pending'");
  const f=await fixture(); await f.request(); const job=await f.claim(); await f.finish(job);
  const claim=async(worker)=>(await db.query("select * from claim_tally_check_save_v2($1)",[worker])).rows[0];
  const old=await claim("saver"); assert.equal(old.id,job.id);
  assert.equal(await claim("other"),undefined);
  await db.query("update tally_check_jobs set save_lease_expires_at=now()-interval '1 second' where id=$1",[job.id]);
  const current=await claim("saver"); assert.equal(current.save_attempts,old.save_attempts+1);
  const finish=async(attempt)=>(await db.query("select finish_tally_check_save_v2($1,'saver',$2,'{\"state\":\"saved\"}',null) as r",[job.id,attempt])).rows[0].r;
  assert.equal(await finish(old.save_attempts),false); assert.equal(await finish(current.save_attempts),true);
});
test("mode changes refuse queued checks, unsaved results and waiting Credit Notes", async () => {
  const f=await fixture(); await f.request();
  const switchMode=()=>db.query("select set_tally_connector_mode_v2($1,'pc')",[f.company]);
  await assert.rejects(switchMode(),/still waiting/);
  const job=await f.claim(); await f.finish(job);
  await assert.rejects(switchMode(),/still waiting/);
  await db.query("update tally_check_jobs set save_state='saved' where id=$1",[job.id]);
  await db.query("insert into tally_commands(company_id,status) values($1,'queued')",[f.company]);
  await assert.rejects(switchMode(),/still waiting/);
  await db.query("update tally_commands set status='verified' where company_id=$1",[f.company]);
  await switchMode(); await assert.rejects(f.request("cd:new"),/not a server/);
});
test("browser database roles cannot read jobs or call privileged queue functions", async () => {
  for(const role of ["anon","authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query("select * from tally_check_jobs"),/permission denied/);
      await assert.rejects(db.query("select claim_tally_check_save_v2('intruder')"),/permission denied/);
    } finally { await db.exec("reset role"); }
  }
});

test("HTTP request -> API -> SQL queue -> real connector reader/calculator -> API result preserves the hand-calculated CD", async () => {
  const f=await fixture();
  const party="Review customer";
  const ruleId=randomUUID(), customerId=randomUUID();
  const sales=`<VOUCHER><GUID>review-sale</GUID><DATE>20261110</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>S-1</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><VOUCHERAMOUNT>-100000</VOUCHERAMOUNT><ALLLEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><AMOUNT>-100000</AMOUNT><BILLALLOCATIONS.LIST><NAME>S-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-100000</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST><ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Steel</STOCKITEMNAME><BILLEDQTY>10 MT</BILLEDQTY><AMOUNT>84746</AMOUNT></ALLINVENTORYENTRIES.LIST></VOUCHER>`;
  const receipt=`<VOUCHER><GUID>review-receipt</GUID><DATE>20261112</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><AMOUNT>95000</AMOUNT><BILLALLOCATIONS.LIST><NAME>S-1</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>95000</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>`;
  const routes={};
  const rpc=async(name,args)=>{
    try {
      const entries=Object.entries(args), set=name.startsWith("claim_");
      const sql=`select ${set?'*':name+'('+entries.map(([k],i)=>`${k} => $${i+1}`).join(',')+') as result'}${set?' from '+name+'('+entries.map(([k],i)=>`${k} => $${i+1}`).join(',')+')':''}`;
      const answer=await db.query(sql,entries.map(([,v])=>v));
      return{data:set?answer.rows:answer.rows[0].result,error:null};
    }catch(error){return{data:null,error};}
  };
  const client={rpc,from:()=>{
    const chain={select(){return chain;},eq(){return chain;},async maybeSingle(){return{data:{expected_tally_company_guid:f.connector,expected_tally_company_name:"Review company"},error:null};}};
    return chain;
  }};
  class AccessError extends Error {}
  const modules={
    "@/lib/api/cors":{jsonWithCors:(_r,b,init)=>Response.json(b,init),optionsWithCors:()=>new Response()},
    "@/lib/audit":{auditUserAction:async()=>{}},
    "@/lib/authorization":{MeenakshiAccessError:AccessError,requireMeenakshiCompanyAccess:async()=>({userId:null,company:{id:f.company,organization_id:f.org}})},
    "@/lib/check-jobs":{buildCheckJobInput,CheckJobRequestError},
    "@/lib/security":{isUuid,readBridgeToken},
    "@/lib/bridge":{bridgeVersionIsOlder,authenticateMeenakshiBridge:async(id,token)=>id===f.connector&&token==="test-credential"?{id,bridge_version:"0.5.1",machine_fingerprint:"installation"}:null},
    "@/lib/supabase/admin":{createSupabaseAdminClient:()=>client},
  };
  for(const [key,file,verb]of [
    ["request","companies/[companyId]/check-jobs/route.ts","POST"],
    ["next","bridge/check-jobs/next/route.ts","GET"],
    ["progress","bridge/check-jobs/[jobId]/progress/route.ts","POST"],
    ["finish","bridge/check-jobs/[jobId]/finish/route.ts","POST"],
  ]){
    const source=await readFile(new URL(`../app/api/${file}`,import.meta.url),'utf8');
    const exports={};
    vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(name)=>{assert.ok(modules[name],name);return modules[name];},console,URL});
    routes[key]=exports[verb];
  }
  const server=createServer(async(req,res)=>{
    try{
      let response;
      if(req.url==="/tally")response=new Response(`<ENVELOPE>${sales}${receipt}</ENVELOPE>`);
      else if(req.url==="/api/bridge/heartbeat")response=Response.json({ok:true});
      else{
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const request=new Request(`http://localhost${req.url}`,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
        const key=req.url.includes('/next?')?'next':req.url.endsWith('/progress')?'progress':req.url.endsWith('/finish')?'finish':'request';
        const jobId=req.url.split('/').at(-2);
        response=await routes[key](request,{params:Promise.resolve({companyId:f.company,jobId})});
      }
      res.writeHead(response.status,{"content-type":"application/json"});res.end(await response.text());
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const body={evaluatedOn:"2026-11-16",rule:{id:ruleId,cdDiscountBasis:"amount_per_tonne",calendar:{nonWorkingIsoWeekdays:[7],activeHolidayDates:[]},segments:[{label:"3 days",allowedWorkingDays:3,amountPerTonne:"500"}],customerSegments:{[customerId]:0}},voucherScope:{purpose:"live_cd_evaluation",liveAggregation:"cd",cdDiscountBasis:"amount_per_tonne",ruleVersionId:ruleId,dateFrom:"2026-11-10",dateTo:"2026-11-16",customers:[{customerId,ledgerName:party}],eligibleStockItemNames:["Steel"],unitConversions:[{uomCode:"MT",tonnesPerUnit:"1"}]}};
    const response=await fetch(`${base}/api/companies/${f.company}/check-jobs`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"cd",save:true,body})});
    assert.equal(response.status,201);const created=await response.json();
    await processOneCheckJob({apiBase:base,connectorId:f.connector,controlToken:"test-credential",tallyUrl:`${base}/tally`},{guid:f.connector,name:"Review company"});
    const job=(await db.query("select * from tally_check_jobs where id=$1",[created.job.id])).rows[0];
    assert.equal(job.status,"succeeded",job.failure_reason);
    assert.equal(job.result.results[0].category,"discounted_payment");
    assert.equal(job.result.results[0].discountAmount,"5000.00");
    assert.equal(job.result.results[0].paidByDeadline,"95000.00");
    assert.equal(job.save_state,"pending","saving must survive losing the original browser");
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
