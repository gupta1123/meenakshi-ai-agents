import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { uploadLogs } from "./api-client.mjs";
import { listLogDays, logLine, readLogDay, recentLogLines } from "./connector-log.mjs";
import { BRIDGE_VERSION } from "./version.mjs";

// The compressed upload must stay under the server's 2 MB cap.
const MAX_GZ_BYTES = 1_800_000;
const bridgeErrorLog = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bridge.err.log");

function header(reason) {
  return [
    `# Meenakshi connector logs`,
    `# version ${BRIDGE_VERSION}, computer ${os.hostname()}, Windows ${os.release()}, ${Math.round(os.totalmem() / 1048576)} MB RAM, ${Math.round(os.freemem() / 1048576)} MB free`,
    `# sent ${new Date().toISOString()}${reason ? `, reason: ${reason}` : ""}`,
    "",
  ].join("\n");
}

function errorLogTail() {
  try {
    const lines = fs.readFileSync(bridgeErrorLog, "utf8").split(/\r?\n/).filter(Boolean).slice(-80);
    return lines.length ? `\n# --- bridge.err.log (last ${lines.length} lines) ---\n${lines.join("\n")}\n` : "";
  } catch { return ""; }
}

function pack(text) {
  let body = text;
  let gz = gzipSync(Buffer.from(body, "utf8"));
  // Too big: keep the newest part of the text.
  while (gz.length > MAX_GZ_BYTES && body.length > 10_000) {
    body = body.slice(Math.floor(body.length * 0.3));
    gz = gzipSync(Buffer.from(`# (older lines cut to fit)\n${body}`, "utf8"));
  }
  return gz;
}

async function send(config, { kind, reason, days, text }) {
  const gz = pack(text);
  const result = await uploadLogs(config, { kind, reason, bridgeVersion: BRIDGE_VERSION, days, contentGzBase64: gz.toString("base64") });
  logLine("INFO", `logs sent to Meenakshi (${kind})`, { bytes: gz.length, days: days.length });
  return { id: result.id, bytes: gz.length };
}

/** The Send logs button: the chosen days, whole. */
export async function sendLogDays(config, days) {
  const available = new Set(listLogDays().map((entry) => entry.day));
  const chosen = days.filter((day) => available.has(day));
  if (!chosen.length) throw new Error("There are no logs for those days on this computer.");
  const text = header("sent by the user") + chosen.sort().map((day) => `\n# ===== ${day} =====\n${readLogDay(day)}`).join("") + errorLogTail();
  return send(config, { kind: "manual", reason: "sent by the user", days: chosen, text });
}

// At most a few automatic reports per hour, so a repeating problem cannot flood us.
const recent = [];
export async function sendIncident(config, kind, reason) {
  const now = Date.now();
  while (recent.length && now - recent[0] > 3_600_000) recent.shift();
  if (recent.length >= 4) return null;
  recent.push(now);
  try {
    const text = header(reason) + recentLogLines(150).join("\n") + "\n" + errorLogTail();
    return await send(config, { kind, reason, days: [new Date().toISOString().slice(0, 10)], text });
  } catch (error) {
    // Reporting must never break the connector (offline, not paired, etc.).
    logLine("WARN", `could not send ${kind} report: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
