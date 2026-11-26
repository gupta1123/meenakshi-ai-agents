import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

