import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ApplicationUpdater } from "../src/support/updater.mjs";
import { loadApplication } from "../installer/electron-app/release-loader.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const names = [
  "main-core.mjs",
  "preload.cjs",
  "index.html",
  "src/bridge.mjs",
  "src/version.mjs",
  "package.json",
];
async function fixture(change = "index.html") {
  const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "meenakshi-update-"),
    ),
    base = path.join(directory, "runtime", "resources", "app"),
    config = path.join(directory, "settings");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(
    path.join(base, "release-public-key.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const blobs = new Map(),
    files = [];
  for (const name of names) {
    const original = Buffer.from(
      name === "package.json"
        ? JSON.stringify({ version: "0.6.0", type: "module" })
        : name === "main-core.mjs"
          ? "globalThis.__updateFallback=true;"
          : "original " + name,
    );
    await fs.mkdir(path.dirname(path.join(base, name)), { recursive: true });
    await fs.writeFile(path.join(base, name), original);
    const data = name === change ? Buffer.from("new " + name) : original,
      gz = gzipSync(data);
    blobs.set(hash(gz), gz);
    files.push({
      path: name,
      sha256: hash(data),
      blob: hash(gz),
      bytes: data.length,
      downloadBytes: gz.length,
    });
  }
  let manifest = { protocol: 1, version: "0.6.1", runtimeMajor: 37, files },
    envelope;
  const seal = () => {
    const data = Buffer.from(JSON.stringify(manifest));
    envelope = {
      payload: data.toString("base64"),
      signature: sign(null, data, privateKey).toString("base64"),
    };
  };
  seal();
  let downloaded = 0,
    requests = 0;
  const fetcher = async (url) => {
    requests++;
    if (url.includes("/api/bridge/releases"))
      return new Response(JSON.stringify(envelope), { status: 200 });
    downloaded++;
    const id = url.split("/").at(-1).replace(".bin", "");
    return new Response(blobs.get(id), { status: 200 });
  };
  const progress = [],
    updater = new ApplicationUpdater({
      baseDirectory: base,
      version: "0.6.0",
      publicKey,
      runtimeMajor: 37,
      directory: config,
      fetcher,
      onProgress: (v) => progress.push(v),
    });
  return {
    directory,
    base,
    config,
    updater,
    progress,
    manifest,
    blobs,
    seal,
    get envelope() {
      return envelope;
    },
    set envelope(v) {
      envelope = v;
    },
    get downloaded() {
      return downloaded;
    },
    get requests() {
      return requests;
    },
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}
test("an application update downloads only the changed file and keeps the bundled runtime", async () => {
  const f = await fixture();
  try {
    const result = await f.updater.stage({
      apiBase: "https://app.example",
      connectorId: "fixture",
      controlToken: "fixture",
    });
    assert.equal(f.downloaded, 1);
    assert.equal(result.reused, names.length - 1);
    assert.equal(
      result.downloadedBytes,
      f.manifest.files.find((v) => v.path === "index.html").downloadBytes,
    );
    assert.equal(
      await fs.readFile(path.join(f.base, "index.html"), "utf8"),
      "original index.html",
      "the running package is not overwritten",
    );
    await assert.rejects(
      fs.readFile(path.join(f.config, "release-state.json")),
      /ENOENT/,
    );
    const state = await f.updater.activate();
    assert.equal(state.active, "0.6.1");
    assert.equal(state.pending, true);
    assert.ok(f.progress.some((p) => p.state === "downloading"));
    assert.equal(f.progress.at(-1).state, "ready");
  } finally {
    await f.cleanup();
  }
});
test("a bad signature downloads no code", async () => {
  const f = await fixture();
  try {
    f.envelope = {
      ...f.envelope,
      signature: Buffer.alloc(64).toString("base64"),
    };
    await assert.rejects(
      f.updater.stage({
        apiBase: "https://app.example",
        connectorId: "fixture",
      }),
      /signature/,
    );
    assert.equal(f.downloaded, 0);
  } finally {
    await f.cleanup();
  }
});
test("corrupt downloaded bytes cannot activate a release", async () => {
  const f = await fixture();
  try {
    const changed = f.manifest.files.find((v) => v.path === "index.html");
    f.blobs.set(changed.blob, Buffer.from("bad"));
    await assert.rejects(
      f.updater.stage({
        apiBase: "https://app.example",
        connectorId: "fixture",
      }),
      /verification|expected size/,
    );
    await assert.rejects(f.updater.activate(), /Download and verify/);
    await assert.rejects(
      fs.readFile(path.join(f.config, "release-state.json")),
      /ENOENT/,
    );
  } finally {
    await f.cleanup();
  }
});
test("signed path traversal and Windows reserved paths are rejected", async () => {
  for (const filename of [
    "../config.json",
    "src/../../secret",
    "src/CON.txt",
    "C:/outside",
  ]) {
    const f = await fixture();
    try {
      f.manifest.files[0].path = filename;
      f.seal();
      await assert.rejects(
        f.updater.stage({
          apiBase: "https://app.example",
          connectorId: "fixture",
        }),
        /Unsafe update path/,
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("a mismatched runtime requires its full verified package", async () => {
  const f = await fixture();
  try {
    f.manifest.runtimeMajor = 99;
    f.seal();
    await assert.rejects(
      f.updater.stage({
        apiBase: "https://app.example",
        connectorId: "fixture",
      }),
      /full update package/,
    );
    assert.equal(f.downloaded, 0);
  } finally {
    await f.cleanup();
  }
});
test("the stable launcher rolls back an application that cannot start", async () => {
  const f = await fixture("main-core.mjs");
  const previous = process.env.MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR;
  try {
    const failed = Buffer.from(
        "throw new Error('broken updated application');",
      ),
      gz = gzipSync(failed),
      entry = f.manifest.files.find((v) => v.path === "main-core.mjs");
    Object.assign(entry, {
      sha256: hash(failed),
      blob: hash(gz),
      bytes: failed.length,
      downloadBytes: gz.length,
    });
    f.blobs.set(entry.blob, gz);
    f.seal();
    await f.updater.stage({
      apiBase: "https://app.example",
      connectorId: "fixture",
    });
    await f.updater.activate();
    process.env.MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR = f.config;
    await loadApplication(
      "ui",
      new URL("file:///" + path.join(f.base, "main.mjs").replaceAll("\\", "/"))
        .href,
    );
    assert.equal(globalThis.__updateFallback, true);
    const state = JSON.parse(
      await fs.readFile(path.join(f.config, "release-state.json"), "utf8"),
    );
    assert.equal(state.active, null);
    assert.match(state.rollbackReason, /broken updated/);
  } finally {
    if (previous === undefined)
      delete process.env.MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR;
    else process.env.MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR = previous;
    delete process.env.MEENAKSHI_BOOTSTRAP_DIRECTORY;
    delete process.env.MEENAKSHI_CONNECTOR_HOME;
    delete process.env.MEENAKSHI_ACTIVE_RELEASE;
    await f.cleanup();
  }
});
