import test from "node:test";
import assert from "node:assert/strict";
import { findBoundTally } from "../src/tally/local-instances.mjs";

test("discovery skips unreachable listeners and requires the active bound GUID", async () => {
  const probe = async url => {
    if (url === "offline") throw Error("Unavailable");
    return { activeCompany: { name: "Same name", guid: url }, availableCompanies: [{ guid: "target" }] };
  };
  assert.equal(await findBoundTally(["offline", "other", "TARGET"], "target", probe), "TARGET");
  assert.equal(await findBoundTally(["other"], "target", probe), null);
});

test("two companies sharing a GUID are told apart by name, and a renamed one is still found", async () => {
  const names = { a: "Co - (2026-2027)", b: "Co - (2025-2026)" };
  const probe = async url => ({ activeCompany: { name: names[url], guid: "same" }, availableCompanies: [] });
  assert.equal(await findBoundTally(["a", "b"], "same", probe, "co - (2025-2026)"), "b");
  assert.equal(await findBoundTally(["a", "b"], "same", probe, "Co - (2024-2025)"), "a");
  assert.equal(await findBoundTally(["a", "b"], "same", probe), "a");
});
