import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { verifyRelease } from "../installer/electron-app/release-loader.mjs";
import {applicationFileBytes} from "../scripts/application-file-bytes.mjs";

test("published signed manifest and blobs exactly match this connector's source", async () => {
  const root = new URL("../", import.meta.url),
    repo = new URL("../", root);
  const envelope = JSON.parse(
    await fs.readFile(new URL("backend/connector-release.json", repo), "utf8"),
  );
  const key = await fs.readFile(
    new URL("installer/electron-app/release-public-key.pem", root),
    "utf8",
  );
  const manifest = verifyRelease(envelope, key);
  const pkg = JSON.parse(
    await fs.readFile(new URL("package.json", root), "utf8"),
  );
  assert.equal(
    manifest.version,
    pkg.version,
    "Bump the version and rebuild the signed application release before deployment",
  );
  const shellFiles = new Set([
    "main-core.mjs",
    "preload.cjs",
    "index.html",
    "package.json",
    "brand.png",
    "app.ico",
  ]);
  const hash = (b) => createHash("sha256").update(b).digest("hex");
  for (const file of manifest.files) {
    const name = file.path === "main-core.mjs" ? "main.mjs" : file.path;
    const source = new URL(
      shellFiles.has(file.path) ? "installer/electron-app/" + name : name,
      root,
    );
    const bytes = applicationFileBytes(source);
    assert.equal(
      hash(bytes),
      file.sha256,
      "Signed release is stale: " + file.path,
    );
    const blob = await fs.readFile(
      new URL("frontend/public/connector-updates/" + file.blob + ".bin", repo),
    );
    assert.equal(hash(blob), file.blob);
    assert.equal(blob.length, file.downloadBytes);
    assert.deepEqual(gunzipSync(blob), bytes);
  }
});
