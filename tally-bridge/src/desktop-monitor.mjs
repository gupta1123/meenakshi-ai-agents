import { execFile } from "node:child_process";
import { loadConfig } from "./config.mjs";
import { readBridgeStatus } from "./instance-lock.mjs";

export async function readDesktopRuntime() {
  const config = loadConfig();
  return { mode: config.mode, runtime: await readBridgeStatus(config) };
}

/** Read the current user's installed startup task; never change or start it. */
export function readWindowsStartup() {
  if (process.platform !== "win32") return Promise.resolve({ state: "unsupported", enabled: false, atLogon: false });
  const script = "$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName 'Meenakshi Tally Connector (server)' -ErrorAction SilentlyContinue;if($null -eq $t){@{state='missing';enabled=$false;atLogon=$false}|ConvertTo-Json -Compress}else{@{state=[string]$t.State;enabled=[bool]$t.Settings.Enabled;atLogon=[bool](@($t.Triggers|Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'}).Count)}|ConvertTo-Json -Compress}";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 8_000 }, (error, stdout) => {
      try { resolve(error ? { state: "unknown" } : JSON.parse(stdout)); }
      catch { resolve({ state: "unknown" }); }
    });
  });
}
