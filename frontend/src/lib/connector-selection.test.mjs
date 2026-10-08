import assert from "node:assert/strict";
import test from "node:test";
import { selectReconnectConnector } from "./connector-selection.ts";

const old = { id: "old", machineFingerprint: "same-machine", status: "paired" };
const local = { id: "local", machineFingerprint: "same-machine", status: "pending_pairing" };
test("reconnect reuses the local claimed installation instead of creating a computer", () => {
  assert.equal(selectReconnectConnector([old, local], "local", null, "old"), local);
});
test("offline connector resumes the browser's known session", () => {
  assert.equal(selectReconnectConnector([old, local], null, "local", "old"), local);
});
test("company binding is the fallback when local detection and memory are unavailable", () => {
  assert.equal(selectReconnectConnector([old, local], null, null, "old"), old);
});
test("revoked and foreign workspace identities are never reused", () => {
  assert.equal(selectReconnectConnector([{ ...local, status: "revoked" }, old], "local", "foreign", null), old);
});
test("multiple unknown computers require identification, not a random choice", () => {
  assert.equal(selectReconnectConnector([old, local], null, null, null), null);
});
test("first setup has no reusable connector", () => {
  assert.equal(selectReconnectConnector([], null, null, null), null);
});
