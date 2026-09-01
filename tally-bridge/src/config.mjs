import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const configDirectory = process.env.MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR
  || path.join(process.env.APPDATA || os.homedir(), "Meenakshi", "TallyBridge");
const configPath = path.join(configDirectory, "config.json");
const installationIdPath = path.join(configDirectory, "installation-id");
const defaultPdfExportDirectory = path.join(configDirectory, "credit-note-pdfs");

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) continue;
    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      values[key] = "true";
      continue;
    }
    values[key] = next;
    index += 1;
  }
  return values;
}

function ensureConfigDirectory() {
  mkdirSync(configDirectory, { recursive: true });
}

export function stableMachineFingerprint() {
  ensureConfigDirectory();
  let installationId = existsSync(installationIdPath)
    ? readFileSync(installationIdPath, "utf8").trim()
    : "";
  if (!installationId) {
    installationId = randomUUID();
    writeFileSync(installationIdPath, `${installationId}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return `${os.hostname()}-${os.platform()}-${os.arch()}-${installationId}`;
}

export function loadConfig() {
  if (!existsSync(configPath)) {
    throw new Error("Bridge is not configured. Run npm.cmd run connect -- --api-base <URL> --connector-id <UUID> --installation-key <key> --control-token <token>.");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const required = ["apiBase", "connectorId", "installationKey", "controlToken", "machineFingerprint", "tallyUrl"];
  for (const key of required) {
    if (!config[key] || typeof config[key] !== "string") throw new Error(`Bridge configuration is missing ${key}. Reconfigure the bridge.`);
  }
  return {
    ...config,
    heartbeatIntervalMs: Math.max(5_000, Number(config.heartbeatIntervalMs || 15_000)),
    commandPollIntervalMs: Math.max(1_000, Number(config.commandPollIntervalMs || 2_000)),
    companyListIntervalMs: Math.max(30_000, Number(config.companyListIntervalMs || 60_000)),
  };
}

export function getPdfExportDirectory(config) {
  return String(config.pdfExportDirectory || defaultPdfExportDirectory).trim();
}

export function configurePdfCapture(values = {}) {
  const config = loadConfig();
  const pdfExportDirectory = String(values.pdfExportDirectory || values["pdf-export-directory"] || getPdfExportDirectory(config)).trim();
  if (!pdfExportDirectory) throw new Error("A PDF export directory is required.");
  mkdirSync(pdfExportDirectory, { recursive: true });
  const updated = { ...config, pdfExportDirectory };
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return updated;
}

export function saveConfig(values) {
  const apiBase = String(values.apiBase || values["api-base"] || "").trim().replace(/\/+$/, "");
  const connectorId = String(values.connectorId || values["connector-id"] || "").trim();
  const installationKey = String(values.installationKey || values["installation-key"] || "").trim();
  const controlToken = String(values.controlToken || values["control-token"] || "").trim();
  const tallyUrl = String(values.tallyUrl || values["tally-url"] || "http://localhost:9000").trim().replace(/\/+$/, "");
  const frontendOrigin = String(values.frontendOrigin || values["frontend-origin"] || "").trim().replace(/\/+$/, "");
  if (!apiBase || !connectorId || !installationKey || !controlToken) {
    throw new Error("configure requires --api-base, --connector-id, --installation-key, and --control-token.");
  }

  const config = {
    apiBase,
    connectorId,
    installationKey,
    controlToken,
    tallyUrl,
    frontendOrigin,
    machineFingerprint: stableMachineFingerprint(),
    heartbeatIntervalMs: Math.max(5_000, Number(values.heartbeatIntervalMs || values["heartbeat-interval-ms"] || 15_000)),
    commandPollIntervalMs: Math.max(1_000, Number(values.commandPollIntervalMs || values["command-poll-interval-ms"] || 2_000)),
    companyListIntervalMs: Math.max(30_000, Number(values.companyListIntervalMs || values["company-list-interval-ms"] || 60_000)),
    pdfExportDirectory: String(values.pdfExportDirectory || values["pdf-export-directory"] || defaultPdfExportDirectory).trim(),
  };
  ensureConfigDirectory();
  mkdirSync(config.pdfExportDirectory, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return config;
}

export function displayConfigPath() {
  return configPath;
}
