import {readFile} from "node:fs/promises";
import path from "node:path";
import {jsonWithCors,optionsWithCors} from "@/lib/api/cors";
import {authenticateMeenakshiBridge} from "@/lib/bridge";
import {isUuid,readBridgeToken} from "@/lib/security";
export function OPTIONS(r:Request){return optionsWithCors(r);}
export async function GET(r:Request){
 try{const id=new URL(r.url).searchParams.get("connectorId");const token=readBridgeToken(r);
 if(!isUuid(id)||!token)return jsonWithCors(r,{error:"Connector identity required."},{status:401});
 const connector=await authenticateMeenakshiBridge(id,token);if(!connector)return jsonWithCors(r,{error:"Invalid connector credential."},{status:401});
 const release=JSON.parse(await readFile(path.join(process.cwd(),"connector-release.json"),"utf8"));
 return jsonWithCors(r,release,{headers:{"Cache-Control":"no-store"}});
 }catch{return jsonWithCors(r,{error:"Connector release is not published yet."},{status:503});}
}
