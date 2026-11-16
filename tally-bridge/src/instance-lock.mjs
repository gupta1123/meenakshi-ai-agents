import { createServer } from "node:net";
import { createHash } from "node:crypto";

/** OS-owned lock: disappears when the process dies, with no stale lock file. */
export async function acquireBridgeLock(config) {
  const key = createHash("sha256").update(config.connectorId).digest("hex").slice(0, 24);
  const address = process.platform === "win32" ? `\\\\.\\pipe\\meenakshi-tally-${key}` : `\0meenakshi-tally-${key}`;
  const server = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", (cause) => {
      reject(cause.code === "EADDRINUSE" ? new Error("This Tally connector is already running. Close the other instance before starting it again.") : cause);
    });
    server.listen(address, resolve);
  });
  server.unref();
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}
