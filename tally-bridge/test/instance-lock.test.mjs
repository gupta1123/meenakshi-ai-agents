import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { acquireBridgeLock, readBridgeStatus } from "../src/instance-lock.mjs";

test("only one runtime owns an installation; closing it allows a restart", async () => {
  const config={connectorId:randomUUID()};
  const first=await acquireBridgeLock(config);
  try { await assert.rejects(acquireBridgeLock(config),/already running/); }
  finally { await first.close(); }
  const restarted=await acquireBridgeLock(config); await restarted.close();
});

test("status viewers observe the existing worker without acquiring ownership and detect its exit", async () => {
  const config = { connectorId: randomUUID() };
  assert.equal(await readBridgeStatus(config), null);
  let state = { pid: process.pid, mode: "server", activity: "Waiting for work" };
  const worker = await acquireBridgeLock(config, () => state);
  try {
    assert.deepEqual(await readBridgeStatus(config), state);
    state = { ...state, activity: "Checking Cash Discount" };
    assert.equal((await readBridgeStatus(config)).activity, "Checking Cash Discount");
    await assert.rejects(acquireBridgeLock(config), /already running/);
  } finally { await worker.close(); }
  assert.equal(await readBridgeStatus(config), null);
});
