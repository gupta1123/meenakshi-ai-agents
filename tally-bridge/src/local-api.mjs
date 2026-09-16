import http from "node:http";

import { fetchLiveCdEvidence } from "./commands/live-cd-evidence.mjs";
import { fetchLiveTodEvidence } from "./commands/live-tod-evidence.mjs";
import { evaluateLocalCashDiscount } from "./local-cd-evaluator.mjs";
import { evaluateLocalTurnoverDiscount } from "./local-tod-evaluator.mjs";
import { probeActiveCompany } from "./tally/company-probe.mjs";

export const LOCAL_TALLY_PORT = 3219;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function normalized(value) { return String(value ?? "").trim().toLowerCase(); }
function allowedOrigins(config) {
  return new Set([
    "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001",
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
      const evidence = isCashDiscount
        ? await fetchLiveCdEvidence(command, { config, activeCompany, isCancelled: () => false }, null)
        : await fetchLiveTodEvidence(command, { config, activeCompany, isCancelled: () => false });
      const calculation = isCashDiscount
        ? evaluateLocalCashDiscount(body.rule, body.evaluatedOn, evidence.invoices)
        : evaluateLocalTurnoverDiscount(body.rule, body.evaluatedOn, body.periodStart, body.periodEnd, evidence.customerAggregates);
      respond(response, 200, { ...calculation, evidence, durationMs: Math.round(performance.now() - startedAt) }, origin, config);
    } catch (error) {
      respond(response, 422, { error: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - startedAt) }, origin, config);
    }
  });
  server.on("error", (error) => console.error(`Local calculation API failed: ${error instanceof Error ? error.message : String(error)}`));
  server.listen(LOCAL_TALLY_PORT, "127.0.0.1", () => console.log(`MEENAKSHI_LOCAL_API http://127.0.0.1:${LOCAL_TALLY_PORT}`));
  return server;
}
