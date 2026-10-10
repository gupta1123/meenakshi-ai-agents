#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claimNextCommand, pairBridge, renewCommandLease, reportCommandResult, sendDisconnect, sendHeartbeat } from "./api-client.mjs";
import { configurePdfCapture, displayConfigPath, getPdfExportDirectory, loadConfig, parseArguments, saveConfig, stableMachineFingerprint } from "./config.mjs";
import { executeCommand } from "./commands/dispatch.mjs";
import { probeActiveCompany, probeCurrentCompanyName, probeTallyCompanies, probeMasterChangeCounter } from "./tally/company-probe.mjs";
import { startLocalApi } from "./local-api.mjs";
import { busyTallySnapshot, tallyActivity, tryAcquireTallyTask, recordVerifiedCompany } from "./tally/read-coordinator.mjs";

const BRIDGE_VERSION = "0.2.3";
const MAX_RETRY_DELAY_MS = 60_000;
const COMMAND_LEASE_RENEWAL_MS = 30_000;

function readConnectionUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "meenakshi-tally:" || url.hostname !== "connect") {
    throw new Error("This is not a valid Meenakshi Tally connection link.");
  }
  const values = {
    "api-base": url.searchParams.get("apiBase") || "",
    "connector-id": url.searchParams.get("connectorId") || "",
    "installation-key": url.searchParams.get("installationKey") || "",
    "control-token": url.searchParams.get("controlToken") || "",
    "tally-url": url.searchParams.get("tallyUrl") || "http://localhost:9000",
    "frontend-origin": url.searchParams.get("frontendOrigin") || "",
  };
  if (!values["api-base"] || !values["connector-id"] || !values["installation-key"] || !values["control-token"]) {
    throw new Error("The Meenakshi Tally connection link is missing required setup information.");
  }
  return values;
}

function installWindowsProtocolHandler() {
  if (process.platform !== "win32") throw new Error("The Meenakshi Tally launch link is available on Windows only.");
  const protocolKey = "HKCU\\Software\\Classes\\meenakshi-tally";
  const bridgePath = fileURLToPath(import.meta.url);
  const command = `"${process.execPath}" "${bridgePath}" connect-url "%1"`;
  execFileSync("reg.exe", ["add", protocolKey, "/ve", "/d", "URL:Meenakshi Tally Bridge", "/f"], { stdio: "inherit" });
  execFileSync("reg.exe", ["add", protocolKey, "/v", "URL Protocol", "/d", "", "/f"], { stdio: "inherit" });
  execFileSync("reg.exe", ["add", `${protocolKey}\\shell\\open\\command`, "/ve", "/d", command, "/f"], { stdio: "inherit" });
  console.log("Meenakshi Tally launch link installed for this Windows user. Return to the browser and choose Open Meenakshi Tally Bridge.");
}

async function connectBridge(config) {
  const tallySnapshot = { ...(await probeTallyCompanies(config.tallyUrl)), tallyReachable: true, companyLoaded: true, error: null };
  const { activeCompany } = tallySnapshot;
  try {
    await pairBridge(config, BRIDGE_VERSION);
  } catch (error) {
    // A repeated connection link is safe after a successful pairing. The
    // heartbeat below still proves that this exact bridge can reach Tally.
    if (!(error instanceof Error) || !/already paired/i.test(error.message)) throw error;
  }
  await sendHeartbeat(config, BRIDGE_VERSION, tallySnapshot);
  console.log(`Meenakshi bridge connected to Tally company: ${activeCompany.name}.`);
}

function startBridgeInBackground() {
  const bridgePath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [bridgePath, "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function readTallySnapshot(config, cachedCompanies = null) {
  try {
    if (Array.isArray(cachedCompanies) && cachedCompanies.length) {
      const activeName = await probeCurrentCompanyName(config.tallyUrl);
      const activeCompany = cachedCompanies.find((company) => company.name.trim().toLowerCase() === activeName.toLowerCase());
      if (activeCompany) {
        return {
          activeCompany: { name: activeCompany.name, guid: activeCompany.guid },
          availableCompanies: cachedCompanies.map((company) => ({ ...company, isActive: company.guid === activeCompany.guid })),
          companySnapshotFresh: false,
          tallyReachable: true,
          companyLoaded: true,
          error: null,
        };
      }
    }
    const snapshot = await probeTallyCompanies(config.tallyUrl);
    return { ...snapshot, companySnapshotFresh: true, tallyReachable: true, companyLoaded: Boolean(snapshot.activeCompany), error: null };
  } catch (error) {
    return {
      tallyReachable: false,
      companyLoaded: false,
      activeCompany: null,
      availableCompanies: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Tally's master change counter, read at most every 3 minutes while idle and
// sent with the heartbeat so the cloud can start a master sync when Tally changed.
const CHANGE_COUNTER_INTERVAL_MS = 3 * 60 * 1000;
let changeCounter = { value: null, readAt: 0, company: null };

async function heartbeat(config, cachedCompanies = null, previousSnapshot = null) {
  const task = tryAcquireTallyTask(config.tallyUrl, "connection_check");
  if (!task) {
    const snapshot = busyTallySnapshot(tallyActivity(config.tallyUrl), previousSnapshot);
    const cloud = await sendHeartbeat(config, BRIDGE_VERSION, snapshot);
    console.log(`MEENAKSHI_STATUS ${JSON.stringify({ ...snapshot, cloudConnected: true, bindings: cloud.bindings ?? [] })}`);
    return snapshot;
  }
  const snapshot = await task.run(async () => {
    const snapshot = await readTallySnapshot(config, cachedCompanies);
    if (snapshot.companyLoaded && snapshot.activeCompany?.name) {
      const company = snapshot.activeCompany.name;
      if (company !== changeCounter.company || Date.now() - changeCounter.readAt > CHANGE_COUNTER_INTERVAL_MS) {
        const value = await probeMasterChangeCounter(config.tallyUrl, company).catch(() => null);
        changeCounter = { value: value ?? (company === changeCounter.company ? changeCounter.value : null), readAt: Date.now(), company };
      }
      snapshot.masterChangeCounter = changeCounter.company === company ? changeCounter.value : null;
    }
    return snapshot;
  });
  const cloud = await sendHeartbeat(config, BRIDGE_VERSION, snapshot);
  console.log(`MEENAKSHI_STATUS ${JSON.stringify({ ...snapshot, cloudConnected: true, bindings: cloud.bindings ?? [] })}`);
  return snapshot;
}

function commandActivity(command, state, error = null) {
  const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
  const voucherScope = payload.voucherScope && typeof payload.voucherScope === "object" ? payload.voucherScope : {};
  const customers = Array.isArray(payload.customers) ? payload.customers : voucherScope.customers;
  const customerCount = Array.isArray(customers) ? customers.length : null;
  console.log(`MEENAKSHI_ACTIVITY ${JSON.stringify({
    state,
    commandType: command.commandType,
    customerCount,
    error,
    at: new Date().toISOString(),
  })}`);
}

function commandLease(config, command, activeCompany) {
  let valid = true;
  let heartbeatInFlight = false;
  const timer = setInterval(() => {
    void renewCommandLease(config, command.id, command.attempt).catch((error) => {
      valid = false;
      console.error(`Could not renew command ${command.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, COMMAND_LEASE_RENEWAL_MS);
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void sendHeartbeat(config, BRIDGE_VERSION, {
      tallyReachable: true,
      companyLoaded: true,
      activeCompany,
      availableCompanies: [{ ...activeCompany, isActive: true }],
      companySnapshotFresh: false,
      error: null,
    }).catch((error) => {
      console.error(`Command heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { heartbeatInFlight = false; });
  }, config.heartbeatIntervalMs);
  timer.unref?.();
  heartbeatTimer.unref?.();
  return {
    get valid() { return valid; },
    setActiveCompany(company) { activeCompany = company; },
    stop() { clearInterval(timer); clearInterval(heartbeatTimer); },
  };
}

function tallyCompaniesMatch(expectedCompany, activeCompany) {
  const expectedGuid = String(expectedCompany?.guid ?? "").trim().toLowerCase();
  const activeGuid = String(activeCompany?.guid ?? "").trim().toLowerCase();
  // GUID is Tally's stable company identity. A display-name change must not
  // redirect a command away from the company currently open in Tally Prime.
  if (expectedGuid || activeGuid) return Boolean(expectedGuid && activeGuid) && expectedGuid === activeGuid;
  return String(expectedCompany?.name ?? "").trim().toLowerCase() === String(activeCompany?.name ?? "").trim().toLowerCase();
}

async function processOneCommand(config, activeCompany) {
  if (!activeCompany) return false;
  const task = tryAcquireTallyTask(config.tallyUrl, "command_poll");
  if (!task) return false;
  return task.run(async () => {
    const { command } = await claimNextCommand(config);
    if (!command) return false;
    task.setName("cloud_command");
    commandActivity(command, "running");
    const lease = commandLease(config, command, activeCompany);
    try {
      // A cached heartbeat is liveness evidence only. Recheck identity inside
      // this exclusive task before any read or accounting command is executed.
      activeCompany = await probeActiveCompany(config.tallyUrl);
      recordVerifiedCompany(config.tallyUrl, activeCompany);
      lease.setActiveCompany(activeCompany);
      if (!tallyCompaniesMatch(command.expectedTallyCompany, activeCompany)) {
        lease.stop();
        await reportCommandResult(config, command.id, {
          status: "failed",
          error: "The active Tally company does not match this Meenakshi command.",
          result: { activeCompany, expectedCompany: command.expectedTallyCompany },
          attempt: command.attempt,
        });
        commandActivity(command, "failed", "The active Tally company does not match Meenakshi.");
        return true;
      }
      const result = await executeCommand(command, { config, activeCompany, isCancelled: () => !lease.valid });
      lease.stop();
      if (!lease.valid) throw new Error("The command lease was lost before its result could be confirmed.");
      await reportCommandResult(config, command.id, { status: "verified", result, attempt: command.attempt });
      commandActivity(command, "completed");
    } catch (error) {
      lease.stop();
      if (!lease.valid) throw error;
      await reportCommandResult(config, command.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        attempt: command.attempt,
      });
      commandActivity(command, "failed", error instanceof Error ? error.message : String(error));
    }
    return true;
  });
}

function isTerminalConnectorError(error) {
  return error?.status === 401
    || error?.status === 426
    || /invalid connector credential|different connector installation|update required/i.test(String(error?.message ?? ""));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startBridge(config) {
  const localApi = startLocalApi(config);
  let consecutiveFailures = 0;
  let snapshot = null;
  let cachedCompanies = [];
  let nextHeartbeatAt = 0;
  let nextCompanyListAt = 0;
  try { for (;;) {
    try {
      const now = Date.now();
      if (!snapshot || now >= nextHeartbeatAt) {
        const refreshCompanyList = now >= nextCompanyListAt || cachedCompanies.length === 0;
        snapshot = await heartbeat(config, refreshCompanyList ? null : cachedCompanies, snapshot);
        cachedCompanies = snapshot.availableCompanies;
        nextHeartbeatAt = Date.now() + config.heartbeatIntervalMs;
        if (refreshCompanyList || snapshot.companySnapshotFresh) nextCompanyListAt = Date.now() + config.companyListIntervalMs;
      }
      const processed = await processOneCommand(config, snapshot.activeCompany);
      consecutiveFailures = 0;
      if (processed) nextHeartbeatAt = 0;
      await sleep(processed ? 250 : config.commandPollIntervalMs);
    } catch (error) {
      if (isTerminalConnectorError(error)) throw error;
      consecutiveFailures += 1;
      const retryDelay = Math.min(config.heartbeatIntervalMs * 2 ** Math.min(consecutiveFailures - 1, 4), MAX_RETRY_DELAY_MS);
      console.error(`Connector cycle failed; retrying in ${Math.ceil(retryDelay / 1000)} seconds: ${error instanceof Error ? error.message : String(error)}`);
      snapshot = null;
      await sleep(retryDelay + Math.floor(Math.random() * 1_000));
    }
  } } finally { localApi.close(); }
}

async function run() {
  const [command = ""] = process.argv.slice(2);
  const args = parseArguments(process.argv.slice(3));
  if (command === "machine-id") {
    console.log(stableMachineFingerprint());
    return;
  }
  if (command === "configure") {
    saveConfig(args);
    console.log(`Meenakshi Tally bridge configured at ${displayConfigPath()}.`);
    return;
  }
  if (command === "configure-pdf-capture") {
    const config = configurePdfCapture(args);
    console.log(`Native Credit Note PDF capture is ready at ${getPdfExportDirectory(config)}.`);
    return;
  }
  if (command === "install-protocol") {
    installWindowsProtocolHandler();
    return;
  }

  // This is the operator-friendly equivalent of configure, probe, and pair.
  // Keeping the three operations together means a person setting up a new
  // bridge cannot accidentally pair a machine before verifying that it can
  // actually read the currently open Tally company.
  if (command === "connect") {
    const config = saveConfig(args);
    await connectBridge(config);
    return;
  }
  if (command === "connect-url") {
    const config = saveConfig(readConnectionUrl(process.argv[3]));
    await connectBridge(config);
    startBridgeInBackground();
    console.log("Meenakshi bridge is now running in the background.");
    return;
  }

  const config = loadConfig();
  if (command === "probe") {
    console.log(JSON.stringify(await probeActiveCompany(config.tallyUrl), null, 2));
    return;
  }
  if (command === "pair") {
    const tallySnapshot = { ...(await probeTallyCompanies(config.tallyUrl)), tallyReachable: true, companyLoaded: true, error: null };
    const { activeCompany } = tallySnapshot;
    await pairBridge(config, BRIDGE_VERSION);
    await sendHeartbeat(config, BRIDGE_VERSION, tallySnapshot);
    console.log(`Paired Meenakshi bridge with active Tally company: ${activeCompany.name}.`);
    return;
  }
  if (command === "once") {
    const snapshot = await heartbeat(config);
    await processOneCommand(config, snapshot.activeCompany);
    console.log(JSON.stringify({ activeCompany: snapshot.activeCompany, tallyReachable: snapshot.tallyReachable }));
    return;
  }
  if (command === "disconnect") {
    await sendDisconnect(config);
    return;
  }
  if (command === "start") {
    await startBridge(config);
    return;
  }
  throw new Error("Use one of: machine-id, configure, configure-pdf-capture, install-protocol, connect, connect-url, probe, pair, once, disconnect, start.");
}

run().catch((error) => {
  console.error(`Meenakshi Tally bridge stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = isTerminalConnectorError(error) ? 2 : 1;
});
