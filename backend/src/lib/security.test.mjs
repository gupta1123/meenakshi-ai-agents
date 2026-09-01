import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorControlToken, hashConnectorSecret, isUuid, safeBridgeResult, secretsMatch } from "./security.ts";

test("connector tokens are random and only validate against their own hash", () => {
  const first = createConnectorControlToken();
  const second = createConnectorControlToken();
  assert.notEqual(first, second);
  assert.equal(secretsMatch(first, hashConnectorSecret(first)), true);
  assert.equal(secretsMatch(second, hashConnectorSecret(first)), false);
  assert.equal(secretsMatch("", hashConnectorSecret(first)), false);
});
test("bridge results remove credentials and raw XML before persistence", () => {
  assert.deepEqual(safeBridgeResult({ voucherGuid: "guid-1", accessToken: "must-not-persist", nested: { rawXml: "<ENVELOPE />", amount: 25 } }), { voucherGuid: "guid-1", nested: { amount: 25 } });
});
test("UUID validation rejects non-UUID identifiers", () => {
  assert.equal(isUuid("4c4c12c8-1c36-4f23-bce9-0d7a64ac8843"), true);
  assert.equal(isUuid("connector-1"), false);
});
