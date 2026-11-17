import { createServer, createConnection } from "node:net";
import { createHash } from "node:crypto";

/** OS-owned lock: disappears when the process dies, with no stale lock file. */
function addressFor(config) {
  const key = createHash("sha256").update(config.connectorId).digest("hex").slice(0, 24);
  return process.platform === "win32" ? `\\\\.\\pipe\\meenakshi-tally-${key}` : `\0meenakshi-tally-${key}`;
}

export async function acquireBridgeLock(config, readStatus = () => ({})) {
  // A status viewer can inspect the existing owner without starting a reader.
  // Only an explicitly sanitized status object is exposed, never configuration.
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.end(JSON.stringify(readStatus()));
  });
  await new Promise((resolve, reject) => {
    server.once("error", (cause) => {
      reject(cause.code === "EADDRINUSE" ? new Error("This Tally connector is already running. Close the other instance before starting it again.") : cause);
    });
    server.listen(addressFor(config), resolve);
  });
  server.unref();
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

export function readBridgeStatus(config, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = createConnection(addressFor(config));
    let output = "", settled = false;
    const done = (value) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.on("error", () => done(null));
    socket.on("data", (chunk) => { output += chunk; if (output.length > 32_768) done(null); });
    socket.on("end", () => { try { done(JSON.parse(output)); } catch { done(null); } });
  });
}
