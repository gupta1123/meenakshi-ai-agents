import { BRIDGE_VERSION } from "./version.mjs";

let status = null;
const company = (value) => value ? { name: value.name ?? null, guid: value.guid ?? null, isActive: Boolean(value.isActive) } : null;

export function beginRuntimeStatus(config) {
  status = { mode: config.mode === "server" ? "server" : "pc", version: BRIDGE_VERSION, pid: process.pid, startedAt: new Date().toISOString(), connection: null, activity: "Waiting for work" };
}
export function readRuntimeStatus() { return status; }
export function recordRuntimeHeartbeat(snapshot, cloud = {}) {
  if (!status) return;
  status.connection = {
    cloudConnected: true, tallyReachable: Boolean(snapshot.tallyReachable), activeCompany: company(snapshot.activeCompany),
    availableCompanies: (snapshot.availableCompanies ?? []).map(company),
    bindings: (cloud.bindings ?? []).map((binding) => ({ matches: Boolean(binding.matches), expectedCompany: company(binding.expectedCompany) })),
    checkedAt: new Date().toISOString(),
  };
}
export function recordRuntimeFailure() {
  if (status?.connection) status.connection = { ...status.connection, cloudConnected: false };
}
export function recordRuntimeActivity(label) { if (status) status.activity = label; }
