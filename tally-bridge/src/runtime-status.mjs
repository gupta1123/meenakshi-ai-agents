import os from "node:os";
import {randomUUID} from "node:crypto";
import {SUPPORT_CAPABILITIES,SUPPORT_PROTOCOL} from "./support/diagnostics.mjs";
import { BRIDGE_VERSION } from "./version.mjs";

let status = null;
const company = (value) => value ? { name: value.name ?? null, guid: value.guid ?? null, isActive: Boolean(value.isActive) } : null;

export function beginRuntimeStatus(config) {
  status = { protocol:SUPPORT_PROTOCOL,capabilities:SUPPORT_CAPABILITIES,bootId:randomUUID(),windowsUser:os.userInfo().username,osRelease:os.release(),freeMemoryMb:Math.round(os.freemem()/1048576), mode: config.mode === "server" ? "server" : "pc", version: BRIDGE_VERSION, pid: process.pid, startedAt: new Date().toISOString(), connection: null, activity: "Waiting for work" };
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

export function recordRuntimeStartup(startup){if(status)status.startup=startup;}

export function recordRuntimeRead(){if(status)status.lastTallyReadAt=new Date().toISOString();}
