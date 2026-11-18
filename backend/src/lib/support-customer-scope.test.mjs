import test from "node:test";
import assert from "node:assert/strict";
import {createClient} from "@supabase/supabase-js";
import {selectedSupportCustomerGuids} from "./support-customer-scope.ts";
test("targeted lookup finds a customer beyond the first 1000 company records",async()=>{
 const rows=Array.from({length:2000},(_,i)=>({id:"customer-"+i,tally_ledger_guid:"ledger-"+i}));
 const db=createClient("https://scope-test.example","test-public-key",{global:{fetch:async(url)=>{
  const filter=new URL(url).searchParams.get("id");
  // Reproduce the Data API's limit when callers forget to push their filter down.
  const filtered=filter?rows.filter(row=>filter.includes(row.id+")")||filter.includes(row.id+",")):rows;
  return new Response(JSON.stringify(filtered.slice(0,1000)),{headers:{"Content-Type":"application/json"}});
 }}});
 assert.deepEqual([...await selectedSupportCustomerGuids(db,"company",["customer-1500"])],["ledger-1500"]);
});
