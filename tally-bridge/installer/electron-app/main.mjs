import { app, BrowserWindow, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PRODUCT_NAME = "Meenakshi Tally Connector";
const PROTOCOL_NAME = "meenakshi-tally";
const APP_USER_MODEL_ID = "com.meenakshi.tally-connector";

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const installedBridgePath = path.join(currentDirectory, "src", "bridge.mjs");
const sourceBridgePath = path.resolve(currentDirectory, "..", "..", "src", "bridge.mjs");
const bridgePath = fs.existsSync(installedBridgePath) ? installedBridgePath : sourceBridgePath;
const installDirectory = path.resolve(currentDirectory, "..", "..");
const logPath = path.join(installDirectory, "bridge.log");
const errorLogPath = path.join(installDirectory, "bridge.err.log");
const iconPath = path.join(currentDirectory, "app.ico");

let mainWindow = null;
let bridgeProcess = null;
let bridgeRestartTimer = null;
let bridgeGeneration = 0;
let bridgeRestartAttempts = 0;
let quitting = false;
let disconnectFinished = false;
let pendingProtocolUrl = null;
let activityResetTimer = null;
let currentActivity = { label: "Ready", state: "idle", detail: "Waiting for work from Meenakshi." };
let lastStatus = {
  title: "Not connected to Meenakshi",
  detail: "Open Meenakshi and connect this computer.",
  state: "disconnected",
  checks: { meenakshi: "off", tally: "off", company: "off" },
  activeCompany: null,
  expectedCompany: null,
  availableCompanies: [],
  activity: currentActivity,
  lastSuccessfulCheck: null,
  action: { type: "open", label: "Open Meenakshi" },
};

function appendLog(filePath, message) {
  fs.appendFile(filePath, `[${new Date().toISOString()}] ${message}\n`, () => {});
}

function formatError(error) {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

function sendStatus(status = {}) {
  lastStatus = { ...lastStatus, ...status, activity: currentActivity };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("status", lastStatus);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function parseProtocolUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== `${PROTOCOL_NAME}:` || url.hostname !== "connect") {
    throw new Error("This is not a valid Meenakshi Tally connection link.");
  }
  const args = {
    "api-base": url.searchParams.get("apiBase") || url.searchParams.get("api-base") || "",
    "connector-id": url.searchParams.get("connectorId") || url.searchParams.get("connector-id") || "",
    "installation-key": url.searchParams.get("installationKey") || url.searchParams.get("installation-key") || "",
    "control-token": url.searchParams.get("controlToken") || url.searchParams.get("control-token") || "",
    "tally-url": url.searchParams.get("tallyUrl") || url.searchParams.get("tally-url") || "http://localhost:9000",
    "frontend-origin": url.searchParams.get("frontendOrigin") || url.searchParams.get("frontend-origin") || "",
  };
  if (!args["api-base"] || !args["connector-id"] || !args["installation-key"] || !args["control-token"]) {
    throw new Error("The Meenakshi connection link is missing required pairing details.");
  }
  return args;
}

function bridgeEnvironment() {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}

function stopBridge() {
  bridgeGeneration += 1;
  if (bridgeRestartTimer) clearTimeout(bridgeRestartTimer);
  bridgeRestartTimer = null;
  if (!bridgeProcess || bridgeProcess.killed) return;
  bridgeProcess.kill();
  bridgeProcess = null;
}

function activityForCommand(commandType, customerCount) {
  if (commandType === "sync_meenakshi_masters") return "Reading company information from Tally";
  if (commandType === "sync_meenakshi_vouchers") return "Reading sales from Tally";
  if (commandType === "fetch_meenakshi_evidence") {
    return customerCount ? `Calculating Turnover Discount for ${customerCount} customers` : "Reading sales for discount calculations";
  }
  if (commandType === "create_credit_note") return "Creating an approved Credit Note";
  if (commandType === "verify_credit_note") return "Confirming the Credit Note in Tally";
  if (commandType === "export_credit_note_pdf") return "Preparing the approved Credit Note document";
  return "Working with Tally";
}

function updateActivity(activity) {
  if (activityResetTimer) clearTimeout(activityResetTimer);
  const label = activityForCommand(activity.commandType, activity.customerCount);
  if (activity.state === "running") {
    currentActivity = { label, state: "running", detail: "Keep Tally Prime open while this finishes." };
  } else if (activity.state === "failed") {
    currentActivity = { label: "The last Tally action needs attention", state: "error", detail: "Open Meenakshi to review the next step." };
  } else {
    currentActivity = { label: "Ready", state: "idle", detail: `${label} completed successfully.` };
    activityResetTimer = setTimeout(() => {
      currentActivity = { label: "Ready", state: "idle", detail: "Waiting for work from Meenakshi." };
      sendStatus();
    }, 8_000);
  }
  sendStatus();
}

function updateConnectionStatus(snapshot) {
  const bindings = Array.isArray(snapshot.bindings) ? snapshot.bindings : [];
  const matchingBinding = bindings.find((binding) => binding.matches);
  const expectedBinding = matchingBinding || bindings[0] || null;
  const activeCompany = snapshot.activeCompany?.name || null;
  const expectedCompany = expectedBinding?.expectedCompany?.name || null;
  const availableCompanies = Array.isArray(snapshot.availableCompanies) ? snapshot.availableCompanies : [];

  if (!snapshot.cloudConnected || bindings.length === 0) {
    sendStatus({
      title: "Not connected to Meenakshi",
      detail: "Open Meenakshi and connect this computer.",
      state: "disconnected",
      checks: { meenakshi: "off", tally: snapshot.tallyReachable ? "on" : "off", company: activeCompany ? "on" : "off" },
      activeCompany,
      expectedCompany,
      availableCompanies,
      action: { type: "open", label: "Open Meenakshi" },
    });
    return;
  }
  if (!snapshot.tallyReachable) {
    sendStatus({
      title: "Tally Prime is not available",
      detail: "Open Tally Prime, then check the connection again.",
      state: "error",
      checks: { meenakshi: "on", tally: "off", company: "off" },
      activeCompany: null,
      expectedCompany,
      availableCompanies: [],
      action: { type: "retry", label: "Retry" },
    });
    return;
  }
  if (!activeCompany) {
    sendStatus({
      title: "Open a company in Tally Prime",
      detail: "Tally is available, but no active company was found.",
      state: "warning",
      checks: { meenakshi: "on", tally: "on", company: "warning" },
      activeCompany: null,
      expectedCompany,
      availableCompanies,
      action: { type: "recheck", label: "Recheck" },
    });
    return;
  }
  if (!matchingBinding) {
    sendStatus({
      title: "Wrong company is open",
      detail: "Open the expected company in Tally Prime, then recheck.",
      state: "error",
      checks: { meenakshi: "on", tally: "on", company: "off" },
      activeCompany,
      expectedCompany,
      availableCompanies,
      action: { type: "recheck", label: "Recheck" },
    });
    return;
  }
  sendStatus({
    title: `Connected to ${activeCompany}`,
    detail: "Tally Prime and the active company are confirmed.",
    state: "connected",
    checks: { meenakshi: "on", tally: "on", company: "on" },
    activeCompany,
    expectedCompany,
    availableCompanies,
    lastSuccessfulCheck: new Date().toISOString(),
    action: { type: "open", label: "Open Meenakshi" },
  });
}

function startBridge() {
  stopBridge();
  const generation = bridgeGeneration;
  const child = spawn(process.execPath, [bridgePath, "start"], {
    env: bridgeEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let lastBridgeError = "";
  bridgeProcess = child;
  child.stdout.on("data", (chunk) => {
    const message = String(chunk).trim();
    appendLog(logPath, message);
    for (const line of message.split(/\r?\n/)) {
      try {
        if (line.startsWith("MEENAKSHI_STATUS ")) {
          bridgeRestartAttempts = 0;
          updateConnectionStatus(JSON.parse(line.slice("MEENAKSHI_STATUS ".length)));
        }
        if (line.startsWith("MEENAKSHI_ACTIVITY ")) updateActivity(JSON.parse(line.slice("MEENAKSHI_ACTIVITY ".length)));
      } catch {
        appendLog(errorLogPath, "Could not read connector status output.");
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (!message) return;
    lastBridgeError = message;
    appendLog(errorLogPath, message);
    sendStatus({
      title: "Checking Tally Prime",
      detail: "The connector is retrying automatically.",
      state: "warning",
      checks: { meenakshi: "warning", tally: "warning", company: "warning" },
      action: { type: "retry", label: "Retry" },
    });
  });
  child.on("error", (error) => {
    appendLog(errorLogPath, formatError(error));
    sendStatus({ title: "Not connected to Meenakshi", detail: "The connector could not start.", state: "error", action: { type: "retry", label: "Retry" } });
  });
  child.on("exit", (code, signal) => {
    if (bridgeProcess === child) bridgeProcess = null;
    if (quitting || generation !== bridgeGeneration) return;
    appendLog(errorLogPath, signal ? `Bridge stopped by ${signal}.` : `Bridge stopped with code ${code ?? "unknown"}.`);
    if (code === 2 || /not configured|configuration is missing|missing required setup/i.test(lastBridgeError)) {
      sendStatus({
        title: "Not connected to Meenakshi",
        detail: "Open Meenakshi and connect this computer again.",
        state: "disconnected",
        checks: { meenakshi: "off", tally: "off", company: "off" },
        action: { type: "open", label: "Open Meenakshi" },
      });
      return;
    }
    bridgeRestartAttempts += 1;
    const retryDelay = Math.min(2_000 * 2 ** Math.min(bridgeRestartAttempts - 1, 5), 60_000);
    sendStatus({ title: "Checking Tally Prime", detail: "Connection was interrupted. Retrying automatically.", state: "warning", action: { type: "retry", label: "Retry" } });
    bridgeRestartTimer = setTimeout(() => {
      bridgeRestartTimer = null;
      if (!quitting && generation === bridgeGeneration) startBridge();
    }, retryDelay);
  });
  sendStatus({
    title: "Checking Tally Prime",
    detail: "Confirming Meenakshi, Tally Prime, and the active company.",
    state: "running",
    checks: { meenakshi: "warning", tally: "warning", company: "warning" },
    action: { type: "recheck", label: "Recheck" },
  });
}

function runBridgeCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath, command, ...args.flatMap(([key, value]) => [`--${key}`, value])], {
      env: bridgeEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { errors += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error((errors || output || `Bridge command exited with code ${code ?? "unknown"}`).trim()));
    });
  });
}

async function handleConnectUrl(value) {
  try {
    const args = parseProtocolUrl(value);
    showWindow();
    sendStatus({ title: "Checking Tally Prime", detail: "Connecting this computer to Meenakshi.", state: "running" });
    stopBridge();
    await runBridgeCommand("connect", Object.entries(args));
    startBridge();
  } catch (error) {
    const message = formatError(error);
    appendLog(errorLogPath, message);
    sendStatus({ title: "Not connected to Meenakshi", detail: "The connection could not be completed.", state: "error", action: { type: "retry", label: "Retry" } });
    showWindow();
    dialog.showErrorBox(PRODUCT_NAME, message);
  }
}

function handleProtocolUrl(value) {
  if (value?.startsWith(`${PROTOCOL_NAME}://connect`)) void handleConnectUrl(value);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 470,
    height: 520,
    minWidth: 470,
    minHeight: 520,
    resizable: false,
    show: true,
    backgroundColor: "#fffaf7",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(currentDirectory, "preload.cjs"),
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(currentDirectory, "index.html"));
  mainWindow.webContents.once("did-finish-load", () => sendStatus());
}

app.setName(PRODUCT_NAME);
app.setAppUserModelId(APP_USER_MODEL_ID);
app.on("before-quit", (event) => {
  if (disconnectFinished) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  stopBridge();
  Promise.race([
    runBridgeCommand("disconnect"),
    new Promise((resolve) => setTimeout(resolve, 2_500)),
  ]).catch((error) => appendLog(errorLogPath, `Graceful disconnect failed: ${formatError(error)}`)).finally(() => {
    disconnectFinished = true;
    app.quit();
  });
});
app.on("window-all-closed", () => app.quit());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  disconnectFinished = true;
  app.quit();
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_NAME);
  app.on("second-instance", (_event, argv) => {
    const protocolArg = argv.find((entry) => entry.startsWith(`${PROTOCOL_NAME}://`));
    if (protocolArg) handleProtocolUrl(protocolArg);
    showWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (mainWindow) handleProtocolUrl(url);
    else pendingProtocolUrl = url;
  });
  app.whenReady().then(() => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: false, path: process.execPath });
    createWindow();
    const protocolArg = process.argv.find((entry) => entry.startsWith(`${PROTOCOL_NAME}://`)) || pendingProtocolUrl;
    if (protocolArg) handleProtocolUrl(protocolArg);
    else startBridge();
  });
}
