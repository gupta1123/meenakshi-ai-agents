import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const next = spawn(process.execPath, ["--use-system-ca", "node_modules/next/dist/bin/next", "dev", "--turbopack", "--port", "3001"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
const tallyOutbox = spawn(process.execPath, ["--use-system-ca", "--env-file=.env.local", "./worker/process-tally-outbox.mjs"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
const evaluations = spawn(process.execPath, ["--use-system-ca", "--env-file=.env.local", "--import", "tsx", "./worker/process-evaluation-runs.mjs"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
const notifications = spawn(process.execPath, ["--use-system-ca", "--env-file=.env.local", "--import", "tsx", "./worker/process-notification-outbox.mjs"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [next, tallyOutbox, evaluations, notifications]) if (!child.killed) child.kill();
  process.exitCode = exitCode;
}

next.on("exit", (code) => stop(code ?? 1));
tallyOutbox.on("exit", (code) => stop(code ?? 1));
evaluations.on("exit", (code) => stop(code ?? 1));
notifications.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
