import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { acquireBridgeLock } from "../src/instance-lock.mjs";

test("only one runtime owns an installation; closing it allows a restart", async () => {
  const config={connectorId:randomUUID()};
  const first=await acquireBridgeLock(config);
  try { await assert.rejects(acquireBridgeLock(config),/already running/); }
  finally { await first.close(); }
  const restarted=await acquireBridgeLock(config); await restarted.close();
});
