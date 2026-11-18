// Stable bootstrap: application updates cannot replace this trust boundary.
import fs from "node:fs";
import path from "node:path";
import { createHash, verify } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import os from "node:os";
export const stateDirectory = () =>
  process.env.MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR ||
  path.join(process.env.APPDATA || os.homedir(), "Meenakshi", "TallyBridge");
export const releasesDirectory = () =>
  path.join(stateDirectory(), "application-releases");
export const statePath = () =>
  path.join(stateDirectory(), "release-state.json");
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export function readReleaseState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}
export function writeReleaseState(state) {
  fs.mkdirSync(stateDirectory(), { recursive: true });
  const file = statePath() + "." + process.pid + ".tmp";
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  fs.renameSync(file, statePath());
}
export function updateReleaseState(change) {
  fs.mkdirSync(stateDirectory(), { recursive: true });
  const lock = statePath() + ".lock",
    until = Date.now() + 3000;
  let handle;
  while (handle === undefined) {
    try {
      handle = fs.openSync(lock, "wx");
      fs.writeFileSync(handle, String(process.pid));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const pid = Number(fs.readFileSync(lock, "utf8"));
        if (pid) {
          try {
            process.kill(pid, 0);
          } catch (dead) {
            if (dead.code === "ESRCH") {
              fs.unlinkSync(lock);
              continue;
            }
          }
        } else if (Date.now() - fs.statSync(lock).mtimeMs > 3000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {}
      if (Date.now() > until)
        throw new Error(
          "Another connector process is changing its release. Try again.",
        );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const state = readReleaseState();
    const result = change(state);
    writeReleaseState(state);
    return result ?? state;
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}
export function safeRelative(value) {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !/^[A-Za-z0-9_./@-]+$/.test(value) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (s) =>
          !s ||
          s === "." ||
          s === ".." ||
          /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s),
      )
  )
    throw new Error("Unsafe update file path.");
  if (
    !/^(src\/|node_modules\/decimal\.js\/|main-core\.mjs$|preload\.cjs$|index\.html$|package\.json$|brand\.png$|app\.ico$)/.test(
      value,
    )
  )
    throw new Error("Update tried to replace a runtime or configuration file.");
  return value;
}
export function verifyRelease(envelope, publicKey) {
  if (
    !envelope ||
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string"
  )
    throw new Error("Unsigned connector update.");
  const bytes = Buffer.from(envelope.payload, "base64");
  if (
    bytes.length > 500000 ||
    !verify(null, bytes, publicKey, Buffer.from(envelope.signature, "base64"))
  )
    throw new Error("Connector update signature is invalid.");
  const manifest = JSON.parse(bytes);
  if (
    manifest.protocol !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 500
  )
    throw new Error("Unsupported update manifest.");
  const seen = new Set();
  for (const file of manifest.files) {
    safeRelative(file.path);
    const normalized = file.path.toLowerCase();
    if (
      seen.has(normalized) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !/^[a-f0-9]{64}$/.test(file.blob) ||
      !Number.isInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 12000000 ||
      !Number.isInteger(file.downloadBytes) ||
      file.downloadBytes < 0 ||
      file.downloadBytes > 12000000
    )
      throw new Error("Invalid update file manifest.");
    seen.add(normalized);
  }
  for (const name of [
    "main-core.mjs",
    "preload.cjs",
    "index.html",
    "src/bridge.mjs",
    "src/version.mjs",
    "package.json",
  ])
    if (!seen.has(name)) throw new Error("Incomplete connector update.");
  return manifest;
}
function checkedRelease(version, base) {
  if (!/^\d+\.\d+\.\d+$/.test(version || ""))
    throw new Error("Invalid installed release.");
  const directory = path.join(releasesDirectory(), version);
  const publicKey = fs.readFileSync(
    path.join(base, "release-public-key.pem"),
    "utf8",
  );
  const manifest = verifyRelease(
    JSON.parse(
      fs.readFileSync(path.join(directory, "release-envelope.json"), "utf8"),
    ),
    publicKey,
  );
  if (manifest.version !== version)
    throw new Error("Release identity mismatch.");
  if (
    process.versions.electron &&
    manifest.runtimeMajor !== Number(process.versions.electron.split(".")[0])
  )
    throw new Error("Application update needs a different bundled runtime.");
  for (const file of manifest.files) {
    const filename = path.join(directory, safeRelative(file.path));
    if (
      fs.lstatSync(filename).isSymbolicLink() ||
      sha256(fs.readFileSync(filename)) !== file.sha256
    )
      throw new Error("Installed update failed its file integrity check.");
  }
  return directory;
}
export function markReleaseReady(role) {
  updateReleaseState((state) => {
    if (!state.pending || state.active !== process.env.MEENAKSHI_ACTIVE_RELEASE)
      return;
    state.ready = { ...state.ready, [role]: true };
    state.attempts = { ...state.attempts, [role]: 0 };
    if (state.ready.worker && state.ready.ui) state.pending = false;
  });
}
export async function loadApplication(role, url) {
  const base = path.dirname(fileURLToPath(url));
  process.env.MEENAKSHI_CONNECTOR_HOME = path.resolve(base, "..", "..");
  process.env.MEENAKSHI_BOOTSTRAP_DIRECTORY = base;
  let state = readReleaseState();
  let directory = base;
  const bundled = JSON.parse(
    fs.readFileSync(path.join(base, "package.json"), "utf8"),
  ).version;
  const numeric = (v) =>
    String(v)
      .split(".")
      .reduce((n, s) => n * 100000 + Number(s), 0);
  if (
    state.active &&
    /^\d+\.\d+\.\d+$/.test(bundled || "") &&
    numeric(bundled) >= numeric(state.active)
  )
    state = updateReleaseState((s) => {
      s.active = null;
      s.previous = null;
      s.pending = false;
    });
  if (state.active) {
    try {
      if (state.pending && (state.attempts?.[role] || 0) >= 2)
        throw new Error("Updated connector did not finish starting.");
      directory = checkedRelease(state.active, base);
      if (
        state.pending &&
        (role === "ui" ||
          process.argv.includes("start") ||
          process.argv.includes("once"))
      )
        state = updateReleaseState((s) => {
          if (s.active === state.active)
            s.attempts = {
              ...s.attempts,
              [role]: (s.attempts?.[role] || 0) + 1,
            };
        });
    } catch (error) {
      state = updateReleaseState((s) => {
        if (s.active === state.active) {
          s.rollbackReason = error.message;
          s.active = s.previous || null;
          s.previous = null;
          s.pending = false;
        }
      });
      directory = state.active ? checkedRelease(state.active, base) : base;
    }
  }
  process.env.MEENAKSHI_ACTIVE_RELEASE = state.active || "base";
  try {
    await import(
      pathToFileURL(
        path.join(
          directory,
          role === "ui" ? "main-core.mjs" : "src/bridge.mjs",
        ),
      ).href
    );
  } catch (error) {
    if (directory === base) throw error;
    const failed = updateReleaseState((s) => {
      if (s.active === state.active) {
        s.rollbackReason = error.message;
        s.active = s.previous || null;
        s.previous = null;
        s.pending = false;
      }
    });
    const fallback = failed.active ? checkedRelease(failed.active, base) : base;
    process.env.MEENAKSHI_ACTIVE_RELEASE = failed.active || "base";
    await import(
      pathToFileURL(
        path.join(fallback, role === "ui" ? "main-core.mjs" : "src/bridge.mjs"),
      ).href
    );
  }
}
