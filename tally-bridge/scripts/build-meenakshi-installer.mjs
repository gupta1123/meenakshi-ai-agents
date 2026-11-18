import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {findConnectorRuntime,inspectConnectorRuntime} from "./connector-runtime.mjs";
import {createHash} from "node:crypto";
import {applicationFileBytes} from "./application-file-bytes.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(currentDirectory, "..");
const installerRoot = path.join(bridgeRoot, "installer");
const electronAppRoot = path.join(installerRoot, "electron-app");
const sourceRoot = path.join(bridgeRoot, "src");
const payloadRoot = path.join(installerRoot, "payload-clean");
const outputRoot = path.join(installerRoot, "output");
const definitionPath = path.join(installerRoot, "meenakshi-tally-bridge.iss");
const connector = {
  name: "Meenakshi Tally Connector",
  executableName: "Meenakshi Tally Connector.exe",
  protocol: "meenakshi-tally",
  installDirectory: "C:\\Meenakshi\\tally-bridge",
  runtimeVariable: "MEENAKSHI_CONNECTOR_RUNTIME",
};

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Missing ${label}: ${filePath}`);
}

function ensureContains(filePath, value, label) {
  ensureFile(filePath, label);
  if (!fs.readFileSync(filePath, "utf8").includes(value)) throw new Error(`${label} does not contain ${JSON.stringify(value)}.`);
}

function validateSources() {
  ensureFile(path.join(electronAppRoot, "main.mjs"), "Electron main process");
  ensureFile(path.join(electronAppRoot, "preload.cjs"), "Electron preload");
  ensureFile(path.join(electronAppRoot, "index.html"), "Electron status page");
  ensureFile(path.join(electronAppRoot, "brand.png"), "Meenakshi brand image");
  ensureFile(path.join(electronAppRoot, "app.ico"), "Meenakshi app icon");
  ensureFile(path.join(electronAppRoot, "package.json"), "Electron app package");
  ensureFile(path.join(sourceRoot, "bridge.mjs"), "Meenakshi bridge runtime");
  ensureFile(path.join(sourceRoot, "commands", "live-tod-evidence.mjs"), "live Turnover Discount command");
  ensureFile(path.join(sourceRoot, "commands", "live-cd-evidence.mjs"), "live Cash Discount command");
  ensureFile(definitionPath, "Inno Setup definition");
  ensureFile(path.join(currentDirectory, "install-server-task.ps1"), "server setup script");
  ensureFile(path.join(currentDirectory, "start-server-connector.vbs"), "server startup runner");
  ensureContains(path.join(electronAppRoot, "main.mjs"), connector.protocol, "Electron protocol handler");
  ensureContains(path.join(electronAppRoot, "main.mjs"), "Meenakshi", "Electron product identity");
  ensureContains(path.join(sourceRoot, "commands", "fetch-evidence.mjs"), "fetchLiveTodEvidence", "live Turnover Discount routing");
  ensureContains(path.join(sourceRoot, "commands", "fetch-evidence.mjs"), "fetchLiveCdEvidence", "live Cash Discount routing");
  ensureContains(definitionPath, connector.installDirectory, "Meenakshi install directory");
  ensureContains(definitionPath, connector.protocol, "Meenakshi installer protocol");
  console.log(`Installer sources validated for ${connector.name} (${connector.protocol}://).`);
}

function findInnoCompiler() {
  const candidates = [
    process.env.INNO_SETUP_COMPILER,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ].filter(Boolean);
  const compiler = candidates.find((candidate) => fs.existsSync(candidate));
  if (!compiler) throw new Error("Inno Setup 6 compiler was not found. Install it or set INNO_SETUP_COMPILER.");
  return compiler;
}

function resetDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
}

function copyOptionalRuntimeFiles(runtimeSource) {
  const names = [
    "chrome_100_percent.pak", "chrome_200_percent.pak", "d3dcompiler_47.dll", "ffmpeg.dll", "icudtl.dat",
    "libEGL.dll", "libGLESv2.dll", "LICENSE.electron.txt", "LICENSES.chromium.html", "resources.pak",
    "snapshot_blob.bin", "v8_context_snapshot.bin", "vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll",
  ];
  for (const name of names) {
    const source = path.join(runtimeSource, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(payloadRoot, name));
  }
  const locales = path.join(runtimeSource, "locales");
  if (fs.existsSync(locales)) fs.cpSync(locales, path.join(payloadRoot, "locales"), { recursive: true, force: true });
}

function buildPayload(runtimeExecutable) {
  resetDirectory(payloadRoot);
  fs.mkdirSync(path.join(payloadRoot, "resources", "app"), { recursive: true });
  fs.copyFileSync(runtimeExecutable, path.join(payloadRoot, connector.executableName));
  for (const name of ["install-server-task.ps1", "start-server-connector.vbs", "restart-connector.ps1"])
    fs.copyFileSync(path.join(currentDirectory, name), path.join(payloadRoot, name));
  copyOptionalRuntimeFiles(path.dirname(runtimeExecutable));
  fs.cpSync(sourceRoot, path.join(payloadRoot, "resources", "app", "src"), { recursive: true, force: true });
  fs.mkdirSync(path.join(payloadRoot, "resources", "app", "node_modules"), { recursive: true });
  fs.cpSync(path.join(bridgeRoot, "node_modules", "decimal.js"), path.join(payloadRoot, "resources", "app", "node_modules", "decimal.js"), { recursive: true, force: true });
  for (const name of ["main.mjs", "preload.cjs", "index.html", "package.json", "brand.png", "app.ico", "release-loader.mjs", "worker.mjs", "release-public-key.pem"]) {
    fs.copyFileSync(path.join(electronAppRoot, name), path.join(payloadRoot, "resources", "app", name));
  }
  fs.renameSync(path.join(payloadRoot,"resources","app","main.mjs"),path.join(payloadRoot,"resources","app","main-core.mjs"));
  fs.copyFileSync(path.join(electronAppRoot,"bootstrap.mjs"),path.join(payloadRoot,"resources","app","main.mjs"));
  const envelope=JSON.parse(fs.readFileSync(path.join(bridgeRoot,"..","backend","connector-release.json"),"utf8"));
  const manifest=JSON.parse(Buffer.from(envelope.payload,"base64"));
  for(const file of manifest.files){
    const filename=path.join(payloadRoot,"resources","app",file.path),bytes=applicationFileBytes(filename);
    if(createHash("sha256").update(bytes).digest("hex")!==file.sha256)throw new Error("Rebuild the signed application release before packaging: "+file.path);
    fs.writeFileSync(filename,bytes);
  }
}

validateSources();
if (process.argv.includes("--validate")) process.exit(0);
if (process.platform !== "win32") throw new Error("The Meenakshi setup executable must be built on Windows.");

const runtimeExecutable = findConnectorRuntime();
const actualRuntime=inspectConnectorRuntime(runtimeExecutable);
const signedManifest=JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(path.join(bridgeRoot,"..","backend","connector-release.json"),"utf8")).payload,"base64"));
if(signedManifest.runtimeMajor!==actualRuntime.major)throw new Error("Signed update runtime does not match the runtime being installed. Rebuild the application manifest.");
const compiler = findInnoCompiler();
buildPayload(runtimeExecutable);
fs.mkdirSync(outputRoot, { recursive: true });
execFileSync(compiler, [definitionPath], { cwd: installerRoot, stdio: "inherit" });
console.log(`Created ${path.join(outputRoot, `MeenakshiTallyConnectorSetup-${JSON.parse(fs.readFileSync(path.join(bridgeRoot, "package.json"), "utf8")).version}.exe`)}.`);
