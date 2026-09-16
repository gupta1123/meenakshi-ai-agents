import assert from "node:assert/strict";
import test from "node:test";

import { tallyCompanyMatches } from "./bridge.ts";

test("Tally company matching treats the GUID as the authoritative identity", () => {
  assert.equal(tallyCompanyMatches("company-guid-1", "Old Company Name", "company-guid-1", "Renamed Company"), true);
  assert.equal(tallyCompanyMatches("company-guid-1", "Same Company", "company-guid-2", "Same Company"), false);
  assert.equal(tallyCompanyMatches("company-guid-1", "Same Company", null, "Same Company"), false);
});

test("Tally company matching uses names only for legacy records without GUIDs", () => {
  assert.equal(tallyCompanyMatches("", "Company One", null, "company one"), true);
  assert.equal(tallyCompanyMatches("", "Company One", null, "Company Two"), false);
});
