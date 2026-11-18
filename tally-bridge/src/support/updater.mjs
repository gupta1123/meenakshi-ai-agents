import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash, verify } from "node:crypto";
import os from "node:os";
import { pathToFileURL } from "node:url";
const hash = (data) => createHash("sha256").update(data).digest("hex");
const semver = (v) => v.split(".").reduce((n, s) => n * 100000 + Number(s), 0);
const configRoot = () =>
  process.env.MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR ||
  path.join(process.env.APPDATA || os.homedir(), "Meenakshi", "TallyBridge");
export function manifestFromEnvelope(envelope, publicKey) {
  const payload = Buffer.from(envelope?.payload || "", "base64");
  if (
    payload.length > 500000 ||
    !verify(
      null,
      payload,
      publicKey,
      Buffer.from(envelope?.signature || "", "base64"),
    )
  )
    throw new Error("Update signature could not be verified.");
  const manifest = JSON.parse(payload);
  if (
    manifest.protocol !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 500
  )
    throw new Error("Unsupported update format.");
  return manifest;
}
function checkedPath(file) {
  if (
    !file ||
    !/^[A-Za-z0-9_./@-]+$/.test(file) ||
    file.startsWith("/") ||
    file
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
      )
  )
    throw new Error("Unsafe update path.");
  if (
    !/^(src\/|node_modules\/decimal\.js\/|main-core\.mjs$|preload\.cjs$|index\.html$|package\.json$|brand\.png$|app\.ico$)/.test(
      file,
    )
  )
    throw new Error(
      "Runtime/configuration replacement is not allowed in an application patch.",
    );
  return file;
}
async function boundedDownload(fetcher, url, maxBytes, progress) {
  const r = await fetcher(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok)
    throw new Error(
      "Update download failed (" + r.status + "). Try again later.",
    );
  const chunks = [];
  let total = 0;
  for await (const chunk of r.body) {
    total += chunk.length;
    if (total > maxBytes)
      throw new Error("Update download exceeded its expected size.");
    chunks.push(chunk);
    progress?.(chunk.length);
  }
  return Buffer.concat(chunks);
}
export class ApplicationUpdater {
  constructor({
    baseDirectory,
    version,
    publicKey,
    onProgress = () => {},
    fetcher = fetch,
    directory = configRoot(),
    blobBase = "https://meenakshi-ai-agents.netlify.app/connector-updates/",
    runtimeMajor = Number(process.versions.electron?.split(".")[0]),
  }) {
    Object.assign(this, {
      baseDirectory,
      version,
      publicKey,
      onProgress,
      fetcher,
      directory,
      blobBase,
      runtimeMajor,
    });
    this.busy = false;
  }
  async check(config) {
    this.onProgress({ state: "checking", message: "Checking for updates..." });
    const r = await this.fetcher(
      config.apiBase.replace(/\/$/, "") +
        "/api/bridge/releases?connectorId=" +
        encodeURIComponent(config.connectorId),
      {
        headers: { "x-bridge-token": config.controlToken },
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok)
      throw new Error("Could not check for updates (" + r.status + ").");
    const envelope = await r.json(),
      manifest = manifestFromEnvelope(envelope, this.publicKey);
    this.envelope = envelope;
    this.manifest = manifest;
    if (semver(manifest.version) <= semver(this.version)) {
      this.onProgress({
        state: "current",
        message: "Your connector is up to date.",
        version: this.version,
      });
      return { available: false, state:"current", message:"Your connector is up to date.", version: this.version };
    }
    const sameRuntime = this.runtimeMajor === manifest.runtimeMajor;
    if (!sameRuntime && !manifest.installer)
      throw new Error(
        "This release needs a newer bundled runtime. Its full update package is not published yet.",
      );
    const state = {
      state: "available",
      version: manifest.version,
      notes: manifest.notes || "",
      fullRuntime: !sameRuntime,
    };
    if (!this.busy) this.onProgress(state);
    return { available: true, ...state };
  }
  async stage(config) {
    if (this.busy) throw new Error("An update is already running.");
    this.busy = true;
    try {
      const check = await this.check(config);
      if (!check.available) return check;
      const m = this.manifest,
        releaseRoot = path.join(this.directory, "application-releases");
      await fs.mkdir(releaseRoot, { recursive: true });
      const target = path.join(releaseRoot, m.version),
        staging = target + ".staging";
      // Every mutation is confined to the validated version directory under application-releases.
      await fs.mkdir(staging, { recursive: true });
      if (check.fullRuntime) {
        const i = m.installer;
        if (
          !/^https:\/\//.test(i.url) ||
          !/^[a-f0-9]{64}$/.test(i.sha256) ||
          !Number.isInteger(i.bytes) ||
          i.bytes > 250000000
        )
          throw new Error("Invalid runtime package.");
        let received = 0;
        const bytes = await boundedDownload(
          this.fetcher,
          i.url,
          i.bytes,
          (n) => {
            received += n;
            this.onProgress({
              state: "downloading",
              received,
              total: i.bytes,
              version: m.version,
            });
          },
        );
        if (bytes.length !== i.bytes || hash(bytes) !== i.sha256)
          throw new Error("Runtime update failed integrity verification.");
        const installer = path.join(staging, "runtime-update.exe");
        await fs.writeFile(installer, bytes);
        const ready = {
          state: "ready",
          version: m.version,
          installer,
          installerSha256: i.sha256,
          fullRuntime: true,
        };
        this.ready = ready;
        this.onProgress(ready);
        return ready;
      }
      let previous = {};
      try {
        previous = JSON.parse(
          await fs.readFile(
            path.join(this.directory, "release-state.json"),
            "utf8",
          ),
        );
      } catch {}
      const sources = [
        /^\d+\.\d+\.\d+$/.test(previous.active || "") &&
          path.join(releaseRoot, previous.active),
        this.baseDirectory,
      ].filter(Boolean);
      const needed = [];
      let reused = 0,
        total = 0;
      const seen = new Set();
      for (const file of m.files) {
        const name = checkedPath(file.path);
        if (
          seen.has(name.toLowerCase()) ||
          !/^[a-f0-9]{64}$/.test(file.sha256) ||
          !/^[a-f0-9]{64}$/.test(file.blob) ||
          !Number.isInteger(file.bytes) ||
          file.bytes < 0 ||
          file.bytes > 12000000 ||
          !Number.isInteger(file.downloadBytes) ||
          file.downloadBytes < 1 ||
          file.downloadBytes > 12000000
        )
          throw new Error("Invalid update file.");
        seen.add(name.toLowerCase());
        const destination = path.join(staging, name);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        let found = false;
        for (const source of sources) {
          const candidate = path.join(source, name);
          try {
            const data = await fs.readFile(candidate);
            if (hash(data) === file.sha256) {
              await fs.writeFile(destination, data);
              found = true;
              reused++;
              break;
            }
          } catch {}
        }
        if (!found) {
          needed.push(file);
          total += file.downloadBytes;
        }
      }
      if (total > 25000000)
        throw new Error("Application patch is unexpectedly large.");
      let received = 0;
      for (const file of needed) {
        const data = await boundedDownload(
          this.fetcher,
          this.blobBase + file.blob + ".bin",
          file.downloadBytes,
          (n) => {
            received += n;
            this.onProgress({
              state: "downloading",
              version: m.version,
              received,
              total,
              reused,
              files: needed.length,
            });
          },
        );
        if (data.length !== file.downloadBytes || hash(data) !== file.blob)
          throw new Error("Downloaded update file failed verification.");
        const plain = gunzipSync(data, { maxOutputLength: file.bytes + 1 });
        if (plain.length !== file.bytes || hash(plain) !== file.sha256)
          throw new Error("Update file checksum did not match.");
        await fs.writeFile(path.join(staging, checkedPath(file.path)), plain);
      }
      for (const required of [
        "main-core.mjs",
        "preload.cjs",
        "index.html",
        "src/bridge.mjs",
        "src/version.mjs",
        "package.json",
      ])
        if (!seen.has(required)) throw new Error("Incomplete update.");
      await fs.writeFile(
        path.join(staging, "release-envelope.json"),
        JSON.stringify(this.envelope),
      );
      // A version is immutable. Reusing a staged release requires the same signed manifest.
      if (existsSync(target)) {
        const existing = JSON.parse(
          readFileSync(path.join(target, "release-envelope.json"), "utf8"),
        );
        if (existing.payload !== this.envelope.payload)
          throw new Error("A different package already uses this version.");
        for (const f of m.files)
          if (
            hash(await fs.readFile(path.join(target, checkedPath(f.path)))) !==
            f.sha256
          )
            throw new Error("Staged version integrity failed.");
      } else await fs.rename(staging, target);
      this.ready = {
        state: "ready",
        version: m.version,
        downloadedBytes: received,
        total,
        reused,
        files: needed.length,
      };
      this.onProgress(this.ready);
      return this.ready;
    } catch (error) {
      this.onProgress({ state: "error", message: error.message });
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async activate() {
    if (!this.ready) throw new Error("Download and verify the update first.");
    if (this.ready.fullRuntime) return this.ready;
    const stableLoader = path.join(this.baseDirectory, "release-loader.mjs");
    if (existsSync(stableLoader)) {
      const { updateReleaseState } = await import(
        pathToFileURL(stableLoader).href
      );
      return updateReleaseState((state) => {
        if (state.active === this.ready.version) return;
        Object.assign(state, {
          active: this.ready.version,
          previous: state.active || null,
          pending: true,
          attempts: {},
          ready: {},
          updatedAt: new Date().toISOString(),
        });
      });
    }
    let previous = {};
    try {
      previous = JSON.parse(
        await fs.readFile(
          path.join(this.directory, "release-state.json"),
          "utf8",
        ),
      );
    } catch {}
    const state = {
      active: this.ready.version,
      previous: previous.active || null,
      pending: true,
      attempts: {},
      ready: {},
      updatedAt: new Date().toISOString(),
    };
    const filename = path.join(this.directory, "release-state.json");
    await fs.writeFile(filename + ".tmp", JSON.stringify(state, null, 2));
    await fs.rename(filename + ".tmp", filename);
    return state;
  }
}
