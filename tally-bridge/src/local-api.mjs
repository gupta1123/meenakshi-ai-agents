import http from "node:http";

import { fetchLiveCdEvidence } from "./commands/live-cd-evidence.mjs";
import { fetchLiveTodEvidence } from "./commands/live-tod-evidence.mjs";
import { evaluateLocalCashDiscount } from "./local-cd-evaluator.mjs";
import { evaluateCashDiscountSettlements } from "./local-cd-settlement-evaluator.mjs";
import { evaluateLocalTurnoverDiscount } from "./local-tod-evaluator.mjs";
import { probeActiveCompany } from "./tally/company-probe.mjs";
import { readNoteEInvoice } from "./tally/einvoice.mjs";

export const LOCAL_TALLY_PORT = 3219;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function normalized(value) { return String(value ?? "").trim().toLowerCase(); }
export function allowedOrigins(config) {
  return new Set([
    "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001",
    // Both supported Meenakshi frontends must discover the same installation.
    // A reconnect from localhost must not lock the production site out.
    "https://meenakshi-ai-agents.netlify.app",
    config.frontendOrigin,
  ].filter(Boolean).map((value) => String(value).replace(/\/+$/, "")));
}

function respond(response, status, body, origin, config) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (origin && allowedOrigins(config).has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("The local calculation request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("The local calculation request is invalid.")); }
    });
    request.on("error", reject);
  });
}

export function startLocalApi(config) {
  let stopping = false;
  // Progress of the calculation in flight, read by the browser while it waits.
  let progress = null;
  let retryTimer = null;
  const server = http.createServer(async (request, response) => {
    const origin = String(request.headers.origin ?? "").replace(/\/+$/, "");
    if (origin && !allowedOrigins(config).has(origin)) {
      respond(response, 403, { error: "This Meenakshi site is not paired with the local connector." }, null, config);
      return;
    }
    if (request.method === "OPTIONS") {
      respond(response, 204, {}, origin, config);
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      try {
        const activeCompany = await probeActiveCompany(config.tallyUrl);
        respond(response, 200, { ready: true, activeCompany }, origin, config);
      } catch (error) {
        respond(response, 503, { ready: false, error: error instanceof Error ? error.message : String(error) }, origin, config);
      }
      return;
    }
    if (request.method === "GET" && request.url === "/v1/progress") {
      respond(response, 200, { progress }, origin, config);
      return;
    }
    if (request.method === "GET" && request.url === "/v1/identity") {
      // The connector ID is not a credential. It lets this browser choose
      // the connector running on this PC without exposing pairing secrets.
      respond(response, 200, { connectorId: config.connectorId }, origin, config);
      return;
    }
    // IRN / Ack / signed QR of one Credit or Debit Note, for its PDF.
    if (request.method === "POST" && request.url === "/v1/einvoice") {
      try {
        const body = await readJson(request);
        const expectedCompany = body.expectedCompany && typeof body.expectedCompany === "object" ? body.expectedCompany : {};
        const activeCompany = await probeActiveCompany(config.tallyUrl);
        const expectedGuid = String(expectedCompany.guid ?? "").trim();
        const sameCompany = expectedGuid
          ? normalized(activeCompany.guid) === normalized(expectedGuid)
          : Boolean(expectedCompany.name) && normalized(activeCompany.name) === normalized(expectedCompany.name);
        if (!sameCompany) throw new Error(`Open ${expectedCompany.name || "the selected company"} in Tally Prime first.`);
        const einvoice = await readNoteEInvoice({ tallyUrl: config.tallyUrl, companyName: activeCompany.name, date: body.date, voucherNumber: body.voucherNumber, kind: body.kind });
        respond(response, 200, { einvoice }, origin, config);
      } catch (error) {
        respond(response, 422, { error: error instanceof Error ? error.message : String(error) }, origin, config);
      }
      return;
    }
    const isCashDiscount = request.url === "/v1/cash-discount";
    const isTurnoverDiscount = request.url === "/v1/turnover-discount";
    if (request.method !== "POST" || (!isCashDiscount && !isTurnoverDiscount)) {
      respond(response, 404, { error: "Local connector route not found." }, origin, config);
      return;
    }
    const startedAt = performance.now();
    try {
      const body = await readJson(request);
      const expectedCompany = body.expectedCompany && typeof body.expectedCompany === "object" ? body.expectedCompany : {};
      const activeCompany = await probeActiveCompany(config.tallyUrl);
      const expectedGuid = String(expectedCompany.guid ?? "").trim();
      const sameCompany = expectedGuid
        ? normalized(activeCompany.guid) === normalized(expectedGuid)
        : Boolean(expectedCompany.name) && normalized(activeCompany.name) === normalized(expectedCompany.name);
      if (!sameCompany) {
        throw new Error(`Open ${expectedCompany.name || "the selected company"} in Tally Prime before running this calculation.`);
      }
      const command = { payload: { evaluationRunId: null, voucherScope: body.voucherScope } };
      progress = { task: isCashDiscount ? "cash_discount" : "turnover_discount", stage: "reading", done: 0, total: null, from: null, to: null, startedAt: new Date().toISOString() };
      const onProgress = (update) => { progress = { ...progress, ...update }; };
      const evidence = isCashDiscount
        ? await fetchLiveCdEvidence(command, { config, activeCompany, isCancelled: () => false, onProgress }, null)
        : await fetchLiveTodEvidence(command, { config, activeCompany, isCancelled: () => false });
      onProgress({ stage: "calculating" });
      const calculation = isCashDiscount
        ? body.rule?.cdDiscountBasis === "amount_per_tonne"
          ? evaluateCashDiscountSettlements(body.rule, body.evaluatedOn, evidence.invoices)
          : evaluateLocalCashDiscount(body.rule, body.evaluatedOn, evidence.invoices)
        : evaluateLocalTurnoverDiscount(body.rule, body.evaluatedOn, body.periodStart, body.periodEnd, evidence.customerAggregates);
      respond(response, 200, { ...calculation, evidence, durationMs: Math.round(performance.now() - startedAt) }, origin, config);
    } catch (error) {
      respond(response, 422, { error: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - startedAt) }, origin, config);
    }
  });
  const listen = () => {
    if (stopping || server.listening) return;
    server.listen(LOCAL_TALLY_PORT, "127.0.0.1");
  };
  server.on("listening", () => console.log(`MEENAKSHI_LOCAL_API http://127.0.0.1:${LOCAL_TALLY_PORT}`));
  server.on("error", (error) => {
    console.error(`Local calculation API failed; retrying: ${error instanceof Error ? error.message : String(error)}`);
    if (stopping || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      listen();
    }, 2_000);
  });
  listen();
  return {
    close() {
      stopping = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (server.listening) server.close();
    },
  };
}
