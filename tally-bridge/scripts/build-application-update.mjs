import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
  sign,
} from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {applicationFileBytes} from "./application-file-bytes.mjs";
import {findConnectorRuntime,inspectConnectorRuntime} from "./connector-runtime.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.dirname(root),
  shell = path.join(root, "installer", "electron-app");
const keyDir =
  process.env.MEENAKSHI_RELEASE_SIGNING_DIR ||
  path.join(process.env.APPDATA || os.homedir(), "Meenakshi", "ReleaseSigning");
const privateFile = path.join(keyDir, "connector-ed25519.pem"),
  publicFile = path.join(shell, "release-public-key.pem");
fs.mkdirSync(keyDir, { recursive: true });
if (!fs.existsSync(privateFile)) {
  if (fs.existsSync(publicFile))
    throw new Error(
      "The release signing key is unavailable. Restore the existing signing key; never rotate it silently.",
    );
  const key = generateKeyPairSync("ed25519");
  fs.writeFileSync(
    privateFile,
    key.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    publicFile,
    key.publicKey.export({ type: "spki", format: "pem" }),
  );
}
const secret = fs.readFileSync(privateFile);
const publicKey = createPublicKey(secret).export({
  type: "spki",
  format: "pem",
});
if (
  fs.existsSync(publicFile) &&
  fs.readFileSync(publicFile, "utf8") !== publicKey
)
  throw new Error("Signing key differs from the installed trust key.");
fs.writeFileSync(publicFile, publicKey);
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
fs.mkdirSync(path.join(root, "installer", "output"), { recursive: true });
const output = path.join(repo, "frontend", "public", "connector-updates");
fs.mkdirSync(output, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [];
function add(file, relative) {
  const bytes = applicationFileBytes(file),
    compressed = gzipSync(bytes, { level: 9 }),
    blob = sha(compressed);
  fs.writeFileSync(path.join(output, blob + ".bin"), compressed);
  files.push({
    path: relative,
    sha256: sha(bytes),
    bytes: bytes.length,
    blob,
    downloadBytes: compressed.length,
  });
}
function walk(directory, prefix) {
  for (const item of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.isSymbolicLink())
      throw new Error("Release source contains a symlink.");
    const next = path.join(directory, item.name),
      name = prefix + item.name;
    if (item.isDirectory()) walk(next, name + "/");
    else add(next, name);
  }
}
walk(path.join(root, "src"), "src/");
walk(path.join(root, "node_modules", "decimal.js"), "node_modules/decimal.js/");
for (const file of [
  "preload.cjs",
  "index.html",
  "package.json",
  "brand.png",
  "app.ico",
])
  add(path.join(shell, file), file);
add(path.join(shell, "main.mjs"), "main-core.mjs");
const runtime=inspectConnectorRuntime(findConnectorRuntime());
const manifest = {
  protocol: 1,
  version,
  runtimeMajor: runtime.major,
  runtimeVersion:runtime.electron,
  publishedAt: new Date().toISOString(),
  notes: "Remote support, one-step server setup and small in-app updates.",
  files,
};
if (process.env.MEENAKSHI_FULL_INSTALLER_URL) {
  const installer = path.join(
    root,
    "installer",
    "output",
    "MeenakshiTallyConnectorSetup-" + version + ".exe",
  );
  const bytes = fs.readFileSync(installer);
  manifest.installer = {
    url: process.env.MEENAKSHI_FULL_INSTALLER_URL,
    bytes: bytes.length,
    sha256: sha(bytes),
  };
}
const payload = Buffer.from(JSON.stringify(manifest));
const envelope = {
  payload: payload.toString("base64"),
  signature: sign(null, payload, secret).toString("base64"),
};
fs.writeFileSync(
  path.join(repo, "backend", "connector-release.json"),
  JSON.stringify(envelope, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(
    root,
    "installer",
    "output",
    "application-update-" + version + ".json",
  ),
  JSON.stringify(
    {
      version,
      files: files.length,
      uncompressedBytes: files.reduce((n, f) => n + f.bytes, 0),
      downloadBytes: files.reduce((n, f) => n + f.downloadBytes, 0),
      runtimeIncluded: false,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    version,
    files: files.length,
    applicationDownloadBytes: files.reduce((n, f) => n + f.downloadBytes, 0),
    runtimeIncluded: false,
  }),
);
