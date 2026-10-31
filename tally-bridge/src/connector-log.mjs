import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Daily connector log kept in a fixed folder so support can open it directly.
const KEEP_DAYS = 14;

export function logDirectory() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Meenakshi", "logs");
}

let pruned = false;
function prune(directory) {
  if (pruned) return;
  pruned = true;
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const name of fs.readdirSync(directory)) {
      if (!/^connector-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const file = path.join(directory, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch { /* logging must never break the connector */ }
}

export function logLine(level, message, details) {
  try {
    const directory = logDirectory();
    fs.mkdirSync(directory, { recursive: true });
    prune(directory);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const extra = details ? ` ${JSON.stringify(details)}` : "";
    fs.appendFileSync(path.join(directory, `connector-${day}.log`), `${now.toISOString()} ${level} ${message}${extra}\n`);
  } catch { /* ignore */ }
}
