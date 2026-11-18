import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

const ps = value => "'" + String(value).replaceAll("'", "''") + "'";
function argument(value) {
  if (/["\r\n\0]/.test(String(value))) throw new Error("Invalid restart argument.");
  return '"' + value + '"';
}
const run = (exe, args, env) => new Promise((resolve, reject) => {
  execFile(exe, args, { windowsHide: true, timeout: 20000, env }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout));
});

/** Hand restart to Windows, outside the GUI and server worker process trees. */
export async function launchRestartTask({ home, uiPid = 0, workerPid = 0, closeUi = false, waitForWorkerExit = false, installer, installerSha256, directory = process.env.MEENAKSHI_TALLY_BRIDGE_CONFIG_DIR || path.join(process.env.APPDATA || os.homedir(), "Meenakshi", "TallyBridge"), taskName = "Meenakshi Tally Connector (restart)" }) {
  if (process.platform !== "win32") throw new Error("Connector restart requires Windows.");
  for (const pid of [uiPid, workerPid]) if (!Number.isSafeInteger(pid) || pid < 0 || pid > 2147483647) throw new Error("Invalid restart process.");
  if (!/^Meenakshi Tally Connector \(restart(?: test [a-f0-9-]+)?\)$/.test(taskName)) throw new Error("Invalid restart task.");
  const handoffId = randomUUID(), handoffFile = path.join(directory, "restart-handoffs", handoffId + ".json");
  await fs.mkdir(path.dirname(handoffFile), { recursive: true });
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", argument(path.join(home, "restart-connector.ps1")), "-UiPid", String(uiPid), "-WorkerPid", String(workerPid), "-HandoffFile", argument(handoffFile)];
  if (closeUi) args.push("-CloseUi");
  if (waitForWorkerExit) args.push("-WaitForWorkerExit");
  if (installer) {
    if (!/^[a-f0-9]{64}$/i.test(installerSha256 || "")) throw new Error("Invalid runtime package checksum.");
    args.push("-InstallerPath", argument(installer), "-InstallerSha256", installerSha256);
  }
  const powershell = path.join(process.env.SystemRoot || "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = `$ErrorActionPreference='Stop';$name=${ps(taskName)};$mutex=New-Object Threading.Mutex($false,'Local\\MeenakshiConnectorRestart');if(-not $mutex.WaitOne(0)){throw 'Another connector restart is being prepared.'};try{$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;if($existing -and [string]$existing.State -in @('Running','Queued')){throw 'A connector restart is already running.'};$action=New-ScheduledTaskAction -Execute ${ps(powershell)} -Argument ${ps(args.join(" "))};$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew;$definition=New-ScheduledTask -Action $action -Principal $principal -Settings $settings;Register-ScheduledTask -TaskName $name -InputObject $definition -Force|Out-Null;Start-ScheduledTask -TaskName $name}finally{$mutex.ReleaseMutex();$mutex.Dispose()}`;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], env);
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    let state;
    try { state = JSON.parse(await fs.readFile(handoffFile, "utf8")); } catch {}
    if (state?.state === "failed") throw new Error(state.error || "The restart helper failed.");
    if (state?.state === "started" || state?.state === "completed") return { taskName, handoffId, helperPid: state.pid };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `Stop-ScheduledTask -TaskName ${ps(taskName)} -ErrorAction SilentlyContinue`], env).catch(() => {});
  throw new Error("Windows did not acknowledge the connector restart. The status window remains open; try again.");
}
