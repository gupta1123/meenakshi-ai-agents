import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeTallyCompanies } from "./company-probe.mjs";

const run = promisify(execFile);

// Read the local OS listener table; only the Tally application's own listeners qualify.
const listListeners = `
$pids = @(Get-Process -Name tally,tallyprime -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
netstat.exe -ano -p TCP | ForEach-Object {
  $fields = $_.Trim() -split '\\s+'
  if ($fields.Length -eq 5 -and $fields[3] -eq 'LISTENING' -and $pids -contains [int]$fields[4]) { $fields[1] }
}`;

export async function localTallyUrls() {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", listListeners],
    { windowsHide: true, timeout: 6000 });
  const urls = new Set();
  for (const address of stdout.trim().split(/\s+/)) {
    const match = /^(0\.0\.0\.0|127\.0\.0\.1|\[::\]|\[::1\]):(\d+)$/.exec(address);
    if (match) urls.add("http://" + (match[1].startsWith("[") ? "[::1]" : "127.0.0.1") + ":" + match[2]);
  }
  return [...urls];
}

// Two Tally companies (for example two financial years split from one company) can share
// one GUID and differ only by name, so when a name is given the listener holding that exact
// name wins, and a renamed company on its own is still found by GUID.
export async function findBoundTally(urls, guid, probe = probeTallyCompanies, expectedName = "") {
  const wanted = String(expectedName ?? "").trim().toLowerCase();
  let byGuid = null;
  for (const url of urls) {
    const snapshot = await probe(url, { timeoutMs: 2000, redirect: "error" }).catch(() => null);
    if (!guid || snapshot?.activeCompany?.guid?.toLowerCase() !== guid.toLowerCase()) continue;
    if (!wanted || String(snapshot.activeCompany.name ?? "").trim().toLowerCase() === wanted) return url;
    byGuid ??= url;
  }
  return byGuid;
}
