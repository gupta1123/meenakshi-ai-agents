import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const runtime=path.join(root,"installer/payload-clean/Meenakshi Tally Connector.exe");
const bridge=path.join(root,"installer/payload-clean/resources/app/src/bridge.mjs");

test("packaged server starts headlessly, polls jobs and restarts after a hard stop",{skip:process.platform!=="win32",timeout:30000},async()=>{
  const scratch=mkdtempSync(path.join(tmpdir(),"meenakshi-packaged-"));
  const guid=randomUUID(), connectorId=randomUUID();
  let checks=0;
  const waiters=[];
  const server=createServer(async(req,res)=>{
    const buffers=[];for await(const chunk of req)buffers.push(chunk);
    const body=Buffer.concat(buffers).toString();
    let response={};
    if(req.url==="/tally") {
      res.setHeader("content-type","text/xml");
      res.end(body.includes("<TYPE>Company</TYPE>")?`<ENVELOPE><COMPANY NAME="Startup test"><NAME>Startup test</NAME><GUID>${guid}</GUID><ALTMSTID>1</ALTMSTID></COMPANY></ENVELOPE>`:"<ENVELOPE><RESULT>Startup test</RESULT></ENVELOPE>");return;
    }
    if(req.url.startsWith("/api/bridge/commands/next"))response={command:null};
    if(req.url.startsWith("/api/bridge/check-jobs/next")){response={job:null};checks++;waiters.splice(0).forEach(resolve=>resolve());}
    res.setHeader("content-type","application/json");res.end(JSON.stringify(response));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${server.address().port}`;
  writeFileSync(path.join(scratch,"config.json"),JSON.stringify({apiBase:base,connectorId,installationKey:"test",controlToken:"test",machineFingerprint:"test",tallyUrl:`${base}/tally`,mode:"server",heartbeatIntervalMs:5000,commandPollIntervalMs:1000}));
  const children=[];
  let diagnostics="";
  const launch=()=>{
    const child=spawn(runtime,[bridge,"start"],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:"1",MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR:scratch,LOCALAPPDATA:scratch},stdio:["ignore","pipe","pipe"]});
    child.stdout.on("data",chunk=>{diagnostics+=String(chunk);});
    child.stderr.on("data",chunk=>{diagnostics+=String(chunk);});
    children.push(child);return child;
  };
  const nextCheck=()=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Package did not poll checks: ${diagnostics}`)),8000);
    waiters.push(()=>{clearTimeout(timer);resolve();});
  });
  try {
    let ready=nextCheck();const first=launch();await ready;
    const second=launch();const [secondExit]=await once(second,"exit");
    assert.notEqual(secondExit,0,"a second shell must not start another reader");
    const exited=once(first,"exit");first.kill();await exited;
    const count=checks;ready=nextCheck();launch();await ready;
    assert.ok(checks>count,"the restarted package must poll the server queue again");
  } finally {
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill();await exited;}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

test("hidden Windows runner uses bundled Node and returns the connector's exit code",{skip:process.platform!=="win32",timeout:10000},async()=>{
  const scratch=mkdtempSync(path.join(tmpdir(),"meenakshi-runner-"));
  const output=path.join(scratch,"env.txt"),script=path.join(scratch,"probe.mjs");
  writeFileSync(script,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(output)},process.env.ELECTRON_RUN_AS_NODE??'missing');process.exit(7);`);
  const child=spawn("cscript.exe",["//Nologo",path.join(root,"scripts/start-server-connector.vbs"),runtime,script],{windowsHide:true,stdio:"pipe"});
  const [code]=await once(child,"exit");
  assert.equal(code,7);
  const {readFileSync}=await import("node:fs");assert.equal(readFileSync(output,"utf8"),"1");
});

test("PowerShell setup waits for the packaged GUI runtime and rejects failed mode changes",{skip:process.platform!=="win32",timeout:30000},async()=>{
  const scratch=mkdtempSync(path.join(tmpdir(),"meenakshi server setup "));
  const configPath=path.join(scratch,"config.json"),registered=path.join(scratch,"registered");
  const harness=path.join(scratch,"setup harness.ps1");
  const quote=value=>`'${value.replaceAll("'","''")}'`;
  // Replace only Task Scheduler operations. The helper and packaged set-mode
  // process are real; the live connector's task and configuration are untouched.
  writeFileSync(harness,`
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
function Get-CimInstance { return @() }
function Get-ScheduledTask { return $null }
function New-ScheduledTaskAction { return 'action' }
function New-ScheduledTaskTrigger { return 'trigger' }
function New-ScheduledTaskPrincipal { return 'principal' }
function New-ScheduledTaskSettingsSet { return 'settings' }
function Register-ScheduledTask { [IO.File]::WriteAllText(${quote(registered)}, 'registered') }
function Start-ScheduledTask {}
& ${quote(path.join(root,"scripts/install-server-task.ps1"))} -NodePath ${quote(runtime)} -BridgePath ${quote(bridge)} -Remove:$Remove
`);
  const run=async(remove=false)=>{
    const child=spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",harness,...(remove?["-Remove"]:[])],{
      windowsHide:true,env:{...process.env,MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR:scratch},stdio:"pipe",
    });
    let output="";
    child.stdout.on("data",chunk=>{output+=String(chunk);});
    child.stderr.on("data",chunk=>{output+=String(chunk);});
    const [code]=await once(child,"exit");
    return {code,output};
  };
  const unpaired=await run();
  assert.notEqual(unpaired.code,0,"a missing configuration must fail setup");
  assert.equal(existsSync(registered),false,"failed mode changes must not register startup");
  writeFileSync(configPath,JSON.stringify({mode:"pc",controlToken:"isolated-test-credential"}));
  const paired=await run();
  assert.equal(paired.code,0,paired.output);
  assert.equal(JSON.parse(readFileSync(configPath,"utf8")).mode,"server");
  assert.equal(existsSync(registered),true,"startup must be registered after a successful mode change");
  const removed=await run(true);
  assert.equal(removed.code,0,removed.output);
  assert.deepEqual(JSON.parse(readFileSync(configPath,"utf8")),{mode:"pc",controlToken:"isolated-test-credential"});
});
