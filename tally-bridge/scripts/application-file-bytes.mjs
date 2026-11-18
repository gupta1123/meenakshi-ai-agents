import fs from "node:fs";
import path from "node:path";

// Git checkout line endings differ between Windows release hosts and Linux CI.
// Both the signed files and full installer use identical LF text bytes.
export function applicationFileBytes(filename){
 const bytes=fs.readFileSync(filename);
 return /\.(?:mjs|cjs|js|json|html|md|ts|txt)$/i.test(path.basename(String(filename)))
  ?Buffer.from(bytes.toString("utf8").replaceAll("\r\n","\n")):bytes;
}
