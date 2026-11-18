import fs from "node:fs";
import path from "node:path";
import { launchRestartTask } from "./restart-task.mjs";
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
  let uiPid = 0;
  try { uiPid = Number(JSON.parse(fs.readFileSync(path.join(updater.directory, "gui-runtime.json"), "utf8")).pid) || 0; } catch {}
  const handoff = await launchRestartTask({home,directory:updater.directory,workerPid:process.pid,uiPid:uiPid===process.pid?0:uiPid,closeUi:true,waitForWorkerExit:true,installer:activated.installer,installerSha256:activated.installerSha256});
  return {
    ...ready,
    restartScheduled: true,
    ...handoff,
    afterFinish: () => {
      setTimeout(() => process.exit(0), 1000);
    },
  };
}
