import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
export function findConnectorRuntime(){
 const candidates=[process.env.MEENAKSHI_CONNECTOR_RUNTIME,"C:\\Meenakshi\\tally-bridge"].filter(Boolean);
 for(const directory of candidates){
  if(!fs.existsSync(directory))continue;
  const entries=fs.readdirSync(directory,{withFileTypes:true});
  for(const name of ["Meenakshi Tally Connector.exe","electron.exe"]){const file=entries.find(e=>e.isFile()&&e.name.toLowerCase()===name.toLowerCase());if(file)return path.join(directory,file.name);}
 }
 throw new Error("Set MEENAKSHI_CONNECTOR_RUNTIME to the Electron runtime directory.");
}
export function inspectConnectorRuntime(executable){
 const output=execFileSync(executable,["-p","JSON.stringify({electron:process.versions.electron,node:process.versions.node})"],{encoding:"utf8",windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:"1"},timeout:15000});
 const versions=JSON.parse(output.trim());
 if(!/^\d+\.\d+\.\d+$/.test(versions.electron||""))throw new Error("The release runtime is not Electron.");
 return {...versions,major:Number(versions.electron.split(".")[0])};
}
