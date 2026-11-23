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
