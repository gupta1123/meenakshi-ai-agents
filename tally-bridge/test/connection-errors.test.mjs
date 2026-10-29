import test from "node:test";
import assert from "node:assert/strict";
import { postTallyXml } from "../src/tally/xml.mjs";
import { pairBridge, BridgeApiError } from "../src/api-client.mjs";

test("connection failures identify Tally separately from the cloud and preserve their cause", async (t) => {
  const failure = new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
  t.mock.method(globalThis, "fetch", async () => { throw failure; });
  await assert.rejects(postTallyXml("http://localhost:9000", "<ENVELOPE/>", { operation: "Read active Tally company" }), (error) => {
    assert.match(error.message, /cannot reach Tally at http:\/\/localhost:9000 \(ECONNREFUSED\)/);
    assert.match(error.message, /Open Tally Prime, load the required company/);
    assert.equal(error.cause, failure);
    return true;
  });
  await assert.rejects(pairBridge({ apiBase: "https://example.com", controlToken: "secret" }, "0.2.3"), (error) => {
    assert.ok(error instanceof BridgeApiError);
    assert.match(error.message, /Cannot reach the Meenakshi server at https:\/\/example.com \(ECONNREFUSED\)/);
    assert.doesNotMatch(error.message, /secret/);
    assert.equal(error.cause, failure);
    return true;
  });
});

test("Tally application errors retain their original message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<RESPONSE><LINEERROR>Company unavailable</LINEERROR></RESPONSE>"));
  await assert.rejects(postTallyXml("http://localhost:9000", "<ENVELOPE/>"), /Tally request failed: Company unavailable/);
});
