import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Saves a long Tally read after every batch so that a connector crash or
// restart resumes where it stopped instead of starting over. One file per
// distinct check (same company, rule, period); anything older than MAX_AGE_MS
// is ignored because the books may have changed since.
const MAX_AGE_MS = 45 * 60_000;

function directory() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Meenakshi", "checkpoints");
}

export function createCheckpoint(key) {
  const file = path.join(directory(), `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || parsed.key !== key || Date.now() - parsed.savedAt > MAX_AGE_MS) return null;
        return parsed.state;
      } catch { return null; }
    },
    save(state) {
      try {
        fs.mkdirSync(directory(), { recursive: true });
        const temporary = `${file}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ key, savedAt: Date.now(), state }));
        fs.renameSync(temporary, file);
      } catch { /* a failed save only costs resume ability */ }
    },
    // The read finished, or the user stopped it on purpose: nothing to resume.
    clear() { try { fs.unlinkSync(file); } catch { /* already gone */ } },
    // Stopped on purpose mid-window: keep the progress but do not count it as a crash.
    settle() {
      const state = this.load();
      if (state?.inFlight) this.save({ ...state, inFlight: null });
    },
  };
}

export function pruneCheckpoints() {
  try {
    for (const name of fs.readdirSync(directory())) {
      const target = path.join(directory(), name);
      if (Date.now() - fs.statSync(target).mtimeMs > 24 * 3_600_000) fs.unlinkSync(target);
    }
  } catch { /* nothing to prune */ }
}
