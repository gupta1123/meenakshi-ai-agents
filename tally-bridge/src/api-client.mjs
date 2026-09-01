const DEFAULT_API_TIMEOUT_MS = 20_000;

export class BridgeApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "BridgeApiError";
    this.status = status;
  }
}

function endpoint(config, path) {
  return `${config.apiBase.replace(/\/+$/, "")}${path}`;
}

async function request(config, path, { method = "GET", body, timeoutMs = DEFAULT_API_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint(config, path), {
      method,
      headers: {
        "x-bridge-token": config.controlToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) throw new BridgeApiError(payload.error || `Meenakshi API returned HTTP ${response.status}.`, response.status);
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new BridgeApiError(`Meenakshi API did not respond within ${timeoutMs / 1000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function pairBridge(config, bridgeVersion) {
  return request(config, "/api/bridge/pair", {
    method: "POST",
    body: {
      connectorId: config.connectorId,
      installationKey: config.installationKey,
      machineFingerprint: config.machineFingerprint,
      bridgeVersion,
    },
  });
}

export function sendHeartbeat(config, bridgeVersion, tallySnapshot) {
  return request(config, "/api/bridge/heartbeat", {
    method: "POST",
    body: {
      connectorId: config.connectorId,
      machineFingerprint: config.machineFingerprint,
      bridgeVersion,
      tallyUrl: config.tallyUrl,
      tallyReachable: tallySnapshot.tallyReachable,
      companyLoaded: tallySnapshot.companyLoaded,
      companySnapshotFresh: tallySnapshot.companySnapshotFresh !== false,
      activeCompany: tallySnapshot.activeCompany ?? null,
      availableCompanies: tallySnapshot.availableCompanies ?? [],
      error: tallySnapshot.error ?? null,
    },
  });
}

export function sendDisconnect(config) {
  return request(config, "/api/bridge/disconnect", {
    method: "POST",
    body: {
      connectorId: config.connectorId,
      machineFingerprint: config.machineFingerprint,
    },
    timeoutMs: 3_000,
  });
}

export function claimNextCommand(config) {
  return request(config, `/api/bridge/commands/next?connectorId=${encodeURIComponent(config.connectorId)}`);
}

export function renewCommandLease(config, commandId, attempt) {
  return request(config, `/api/bridge/commands/${encodeURIComponent(commandId)}/lease`, {
    method: "POST",
    body: { connectorId: config.connectorId, attempt },
  });
}

export function reportCommandResult(config, commandId, { status, result, error, attempt }) {
  return request(config, `/api/bridge/commands/${encodeURIComponent(commandId)}/result`, {
    method: "POST",
    body: { connectorId: config.connectorId, status, result, attempt, ...(error ? { error } : {}) },
    timeoutMs: 120_000,
  });
}

export async function uploadCreditNotePdf(config, commandId, { pdf, tallyGuid, attempt }) {
  const response = await fetch(endpoint(config, `/api/bridge/commands/${encodeURIComponent(commandId)}/document`), {
    method: "PUT",
    headers: {
      "x-bridge-token": config.controlToken,
      "x-connector-id": config.connectorId,
      "x-tally-voucher-guid": tallyGuid,
      "x-command-attempt": String(attempt),
      "content-type": "application/pdf",
    },
    body: pdf,
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(payload.error || `Meenakshi API returned HTTP ${response.status} while receiving the Credit Note PDF.`);
  return payload;
}
