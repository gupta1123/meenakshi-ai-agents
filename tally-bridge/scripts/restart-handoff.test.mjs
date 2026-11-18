import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const ps=value=>"'"+value.replaceAll("'","''")+"'";
const shell=command=>new Promise((resolve,reject)=>execFile("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{windowsHide:true,timeout:15000},(e,out,err)=>e?reject(new Error(err||e.message)):resolve(out)));
test("Windows acknowledges an independent restart task that survives the real Electron parent's exit",{skip:process.platform!=="win32",timeout:45000},async()=>{
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),"meenakshi restart's "));
 assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir())+path.sep));
 const taskName="Meenakshi Tally Connector (restart test "+randomUUID()+")",marker=path.join(scratch,"survived.txt"),ack=path.join(scratch,"ack.json");
 const runtimeRoot=path.join(scratch,"runtime"),appRoot=path.join(runtimeRoot,"resources/app");let child;
 try{
  async function copyRuntime(source,destination){await fs.mkdir(destination,{recursive:true});for(const item of await fs.readdir(source,{withFileTypes:true})){if(item.name==="resources")continue;const from=path.join(source,item.name),to=path.join(destination,item.name);if(item.isDirectory())await copyRuntime(from,to);else await fs.link(from,to).catch(()=>fs.copyFile(from,to));}}
  await copyRuntime(path.join(root,"installer/payload-clean"),runtimeRoot);await fs.mkdir(appRoot,{recursive:true});
  await fs.writeFile(path.join(scratch,"restart-connector.ps1"),`param([int]$UiPid,[int]$WorkerPid,[string]$HandoffFile)\n$ErrorActionPreference='Stop'\n[IO.File]::WriteAllText($HandoffFile,(@{state='started';pid=$PID}|ConvertTo-Json -Compress))\nWait-Process -Id $UiPid -Timeout 20 -ErrorAction SilentlyContinue\n[IO.File]::WriteAllText(${ps(marker)},'survived')\n`);
  await fs.writeFile(path.join(appRoot,"package.json"),JSON.stringify({name:"restart-handoff-test",version:"1.0.0",type:"module",main:"test.mjs"}));
  await fs.writeFile(path.join(appRoot,"test.mjs"),`import {app} from 'electron';import fs from 'node:fs';import {launchRestartTask} from ${JSON.stringify(new URL('../src/support/restart-task.mjs',import.meta.url).href)};app.whenReady().then(async()=>{const result=await launchRestartTask({home:${JSON.stringify(scratch)},directory:${JSON.stringify(scratch)},taskName:${JSON.stringify(taskName)},uiPid:process.pid});fs.writeFileSync(${JSON.stringify(ack)},JSON.stringify(result));app.exit(0);}).catch(e=>{console.error(e.stack);app.exit(1)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(path.join(runtimeRoot,"Meenakshi Tally Connector.exe"),[],{env,windowsHide:true,stdio:"pipe",signal:AbortSignal.timeout(30000)});let output="";child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>output+=b);
  const [code]=await once(child,"exit");assert.equal(code,0,output);assert.ok(JSON.parse(await fs.readFile(ack,"utf8")).helperPid>0);
  const until=Date.now()+5000;let survived=false;while(Date.now()<until){try{survived=(await fs.readFile(marker,"utf8"))==="survived";}catch{}if(survived)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(survived,"Windows must execute the helper after the Electron parent has exited");
 }finally{
  if(child?.exitCode===null)child.kill();
  await shell(`$task=Get-ScheduledTask -TaskName ${ps(taskName)} -ErrorAction SilentlyContinue;if($task){Stop-ScheduledTask -InputObject $task;Unregister-ScheduledTask -TaskName ${ps(taskName)} -Confirm:$false}`).catch(()=>{});
  await fs.rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:500});
 }
});
