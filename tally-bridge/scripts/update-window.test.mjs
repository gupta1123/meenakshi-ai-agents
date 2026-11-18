import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
test(
  "the three-dot update flow stays in one native window through progress and restart",
  { skip: process.platform !== "win32", timeout: 20000 },
  async () => {
    const scratch = await fs.mkdtemp(
      path.join(os.tmpdir(), "meenakshi-update-window-"),
    );
    const harness = path.join(scratch, "test.mjs"),
      out = path.join(scratch, "result.json");
    await fs.writeFile(
      harness,
      `
 import {app,BrowserWindow,ipcMain} from "electron";
 import assert from "node:assert/strict";
 import fs from "node:fs";
 app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-gpu");
 const delay=ms=>new Promise(r=>setTimeout(r,ms));let restarts=0;
 app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(path.join(root, "installer/electron-app/preload.cjs"))}}});
  ipcMain.handle("app:version",()=>"0.6.0");
  ipcMain.handle("update:check",()=>({state:"available",available:true,version:"0.6.1"}));
  ipcMain.handle("update:download",async()=>{win.webContents.send("update-status",{state:"downloading",received:250,total:1000,version:"0.6.1"});await delay(250);return{state:"ready",version:"0.6.1"};});
  ipcMain.handle("update:restart",()=>{restarts++;return{ok:true};});
  await win.loadFile(${JSON.stringify(path.join(root, "installer/electron-app/index.html"))});
  const run=source=>win.webContents.executeJavaScript(source);
  await run('document.getElementById("menu-button").click();document.getElementById("menu-update").click()');await delay(100);
  assert.match(await run('document.getElementById("update-detail").textContent'),/0.6.1/);
  await run('document.getElementById("update-action").click()');await delay(100);
  assert.equal(await run('document.getElementById("update-progress").hidden'),false);
  assert.equal(await run('document.getElementById("update-action").disabled'),true);
  await delay(250);
  assert.equal(await run('document.getElementById("update-action").textContent'),"Restart and update");
  assert.equal(BrowserWindow.getAllWindows().length,1);
  await run('document.getElementById("update-action").click()');await delay(100);
  assert.equal(restarts,1);fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({windows:1,restarts,progress:true,ready:true}));app.exit(0);
 }).catch(e=>{console.error(e.stack);app.exit(1);});
 `,
    );
    const runtimeSource = path.join(root, "installer/payload-clean");
    const runtimeRoot = path.join(scratch, "runtime");
    async function copyRuntime(source, destination) {
      await fs.mkdir(destination, { recursive: true });
      for (const file of await fs.readdir(source, { withFileTypes: true })) {
        if (file.name === "resources") continue;
        const from = path.join(source, file.name),
          to = path.join(destination, file.name);
        if (file.isDirectory()) await copyRuntime(from, to);
        else await fs.link(from, to).catch(() => fs.copyFile(from, to));
      }
    }
    await copyRuntime(runtimeSource, runtimeRoot);
    const appRoot = path.join(runtimeRoot, "resources/app");
    await fs.mkdir(appRoot, { recursive: true });
    await fs.copyFile(harness, path.join(appRoot, "test.mjs"));
    await fs.writeFile(
      path.join(appRoot, "package.json"),
      JSON.stringify({
        name: "connector-update-window-test",
        version: "1.0.0",
        type: "module",
        main: "test.mjs",
      }),
    );
    const runtime = path.join(runtimeRoot, "Meenakshi Tally Connector.exe");
    const env = { ...process.env, LOCALAPPDATA: scratch, APPDATA: scratch };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(runtime, [], {
      windowsHide: true,
      env,
      stdio: "pipe",
      signal: AbortSignal.timeout(15000),
    });
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      output += b;
    });
    try {
      const [code] = await once(child, "exit");
      assert.equal(code, 0, output);
      assert.deepEqual(JSON.parse(await fs.readFile(out, "utf8")), {
        windows: 1,
        restarts: 1,
        progress: true,
        ready: true,
      });
    } finally {
      if (child.exitCode === null) child.kill();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  },
);
