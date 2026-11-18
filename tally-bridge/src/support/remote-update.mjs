import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ApplicationUpdater } from "./updater.mjs";
import { supportRequest } from "./client.mjs";
import { BRIDGE_VERSION } from "../version.mjs";
import { recordRuntimeActivity } from "../runtime-status.mjs";
export async function stageRemoteUpdate(config) {
  const base = process.env.MEENAKSHI_BOOTSTRAP_DIRECTORY,
    home = process.env.MEENAKSHI_CONNECTOR_HOME;
  if (!base || !home)
    throw new Error("Use the installed connector to update its application.");
  const updater = new ApplicationUpdater({
    baseDirectory: base,
    version: BRIDGE_VERSION,
    publicKey: fs.readFileSync(
      path.join(base, "release-public-key.pem"),
      "utf8",
    ),
    onProgress: (s) =>
      recordRuntimeActivity(
        s.state === "downloading"
          ? "Downloading connector update"
          : "Preparing connector update",
      ),
  });
  const ready = await updater.stage(config);
  if (!updater.ready) return ready;
  await supportRequest(config, "/control", { action: "interrupt" });
  const activated = await updater.activate();
  return {
    ...ready,
    afterFinish: () => {
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(home, "restart-connector.ps1"),
        "-WorkerPid",
        String(process.pid),
      ];
      try {
        const gui = JSON.parse(
          fs.readFileSync(
            path.join(updater.directory, "gui-runtime.json"),
            "utf8",
          ),
        );
        if (gui.pid && gui.pid !== process.pid)
          args.push("-UiPid", String(gui.pid), "-CloseUi");
      } catch {}
      if (activated.installer)
        args.push(
          "-InstallerPath",
          activated.installer,
          "-InstallerSha256",
          activated.installerSha256,
        );
      const guiEnvironment={...process.env};delete guiEnvironment.ELECTRON_RUN_AS_NODE;
      const helper = spawn("powershell.exe", args, {
        env:guiEnvironment,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      helper.unref();
      setTimeout(() => process.exit(0), 1000);
    },
  };
}
