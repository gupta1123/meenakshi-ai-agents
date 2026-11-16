import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function gate(mode,fail=false){
  const exports={};
  class AccessError extends Error { constructor(message,status){super(message);this.status=status;} }
  const modules={
    "@/lib/authorization":{MeenakshiAccessError:AccessError},
    "@/lib/supabase/admin":{createSupabaseAdminClient:()=>({from:table=>{
      const query={select(){return query;},eq(){return query;},maybeSingle:async()=>({error:fail?new Error("database unavailable"):null,data:table==="tally_connector_modes"?{mode}:{connector_id:"connector"}})};return query;
    }})},
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL("./check-page.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>modules[name],URL});
  return exports.requireCurrentCheckPage;
}
test("cached PC pages are blocked for server companies but still work for PC companies",async()=>{
  const request=new Request("http://local/check/local-bootstrap");
  await assert.rejects(gate("server")(request,"company"),error=>error.status===409&&/Reload/.test(error.message));
  await gate("pc")(request,"company");
});
test("mode lookup failures block cached pages; current pages declare server support",async()=>{
  await assert.rejects(gate("server",true)(new Request("http://local/check/local-bootstrap"),"company"),/database unavailable/);
  await gate("server",true)(new Request("http://local/check/local-bootstrap?serverCapable=1"),"company");
});
