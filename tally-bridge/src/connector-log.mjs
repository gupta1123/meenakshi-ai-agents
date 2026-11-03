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

/** Days that have a log file, newest first, with sizes. */
export function listLogDays() {
  try {
    return fs.readdirSync(logDirectory())
      .map((name) => /^connector-(\d{4}-\d{2}-\d{2})\.log$/.exec(name))
      .filter(Boolean)
      .map((match) => ({ day: match[1], bytes: fs.statSync(path.join(logDirectory(), match[0])).size }))
      .sort((left, right) => right.day.localeCompare(left.day));
  } catch { return []; }
}

export function readLogDay(day) {
  try { return fs.readFileSync(path.join(logDirectory(), `connector-${day}.log`), "utf8"); } catch { return ""; }
}

/** The last `count` lines across today's and yesterday's logs. */
export function recentLogLines(count) {
  const today = new Date();
  const days = [0, 1].map((back) => new Date(today.getTime() - back * 86_400_000).toISOString().slice(0, 10)).reverse();
  return days.flatMap((day) => readLogDay(day).split("\n").filter(Boolean)).slice(-count);
}

// A marker that exists while the bridge is running. The desktop app removes it
// when it stops the bridge on purpose; if it is still there at the next start,
// the bridge was killed or crashed.
function markerPath() { return path.join(path.dirname(logDirectory()), "running.json"); }
export function previousRunEndedBadly() {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(), "utf8"));
    try { process.kill(marker.pid, 0); if (marker.pid !== process.pid) return null; } catch { /* that process is gone */ }
    return marker;
  } catch { return null; }
}
export function markRunning(version) {
  try { fs.mkdirSync(path.dirname(markerPath()), { recursive: true }); fs.writeFileSync(markerPath(), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version })); } catch { /* ignore */ }
}
export function clearRunning() { try { fs.unlinkSync(markerPath()); } catch { /* ignore */ } }
