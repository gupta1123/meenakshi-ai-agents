import assert from "node:assert/strict";
import test from "node:test";
import { allowedOrigins } from "../src/local-api.mjs";

test("localhost pairing keeps the production Meenakshi site allowed", () => {
  const origins = allowedOrigins({ frontendOrigin: "http://localhost:3000" });
  assert.ok(origins.has("https://meenakshi-ai-agents.netlify.app"));
  assert.ok(origins.has("http://localhost:3000"));
  assert.equal(origins.has("https://untrusted.example"), false);
  assert.equal(origins.has("https://meenakshi-ai-agents.netlify.app.evil.example"), false);
});
test("production pairing also permits local development and normalizes configured origins", () => {
  const origins = allowedOrigins({ frontendOrigin: "https://approved.example/" });
  assert.ok(origins.has("http://127.0.0.1:3000"));
  assert.ok(origins.has("https://approved.example"));
  assert.equal(origins.has("*"), false);
});
