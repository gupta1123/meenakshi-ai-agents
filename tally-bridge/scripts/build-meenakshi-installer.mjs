import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(currentDirectory, "..");
const installerRoot = path.join(bridgeRoot, "installer");
const electronAppRoot = path.join(installerRoot, "electron-app");
const sourceRoot = path.join(bridgeRoot, "src");
const payloadRoot = path.join(installerRoot, "payload-clean");
const outputRoot = path.join(installerRoot, "output");
const definitionPath = path.join(installerRoot, "meenakshi-tally-bridge.iss");
const appVersion = JSON.parse(fs.readFileSync(path.join(electronAppRoot, "package.json"), "utf8")).version;
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
  ensureContains(path.join(electronAppRoot, "main.mjs"), connector.protocol, "Electron protocol handler");
  ensureContains(path.join(electronAppRoot, "main.mjs"), "Meenakshi", "Electron product identity");
  ensureContains(path.join(sourceRoot, "commands", "fetch-evidence.mjs"), "fetchLiveTodEvidence", "live Turnover Discount routing");
  ensureContains(path.join(sourceRoot, "commands", "fetch-evidence.mjs"), "fetchLiveCdEvidence", "live Cash Discount routing");
  ensureContains(definitionPath, connector.installDirectory, "Meenakshi install directory");
  ensureContains(definitionPath, connector.protocol, "Meenakshi installer protocol");
  ensureContains(definitionPath, `#define AppVersion "${appVersion}"`, "Meenakshi installer version");
  if (JSON.parse(fs.readFileSync(path.join(bridgeRoot, "package.json"), "utf8")).version !== appVersion) {
    throw new Error("Bridge and Electron package versions must match.");
  }
  console.log(`Installer sources validated for ${connector.name} (${connector.protocol}://).`);
}

function findRuntime() {
  const candidates = [process.env[connector.runtimeVariable], connector.installDirectory].filter(Boolean);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const entries = fs.readdirSync(candidate, { withFileTypes: true });
    const preferred = entries.find((entry) => entry.isFile() && entry.name === connector.executableName);
    if (preferred) return path.join(candidate, preferred.name);
    const electron = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "electron.exe");
    if (electron) return path.join(candidate, electron.name);
    const runtimes = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
      .filter((entry) => !/(setup|unins|update|squirrel)/i.test(entry.name));
    if (runtimes.length === 1) return path.join(candidate, runtimes[0].name);
  }
  throw new Error(`Missing Electron runtime. Set ${connector.runtimeVariable} to an Electron runtime directory.`);
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
  copyOptionalRuntimeFiles(path.dirname(runtimeExecutable));
  fs.cpSync(sourceRoot, path.join(payloadRoot, "resources", "app", "src"), { recursive: true, force: true });
  fs.mkdirSync(path.join(payloadRoot, "resources", "app", "node_modules"), { recursive: true });
  fs.cpSync(path.join(bridgeRoot, "node_modules", "decimal.js"), path.join(payloadRoot, "resources", "app", "node_modules", "decimal.js"), { recursive: true, force: true });
  for (const name of ["main.mjs", "preload.cjs", "index.html", "package.json", "brand.png", "app.ico"]) {
    fs.copyFileSync(path.join(electronAppRoot, name), path.join(payloadRoot, "resources", "app", name));
  }
}

validateSources();
if (process.argv.includes("--validate")) process.exit(0);
if (process.platform !== "win32") throw new Error("The Meenakshi setup executable must be built on Windows.");

const runtimeExecutable = findRuntime();
const compiler = findInnoCompiler();
buildPayload(runtimeExecutable);
fs.mkdirSync(outputRoot, { recursive: true });
execFileSync(compiler, [definitionPath], { cwd: installerRoot, stdio: "inherit" });
console.log(`Created ${path.join(outputRoot, `MeenakshiTallyConnectorSetup-${appVersion}.exe`)}.`);
