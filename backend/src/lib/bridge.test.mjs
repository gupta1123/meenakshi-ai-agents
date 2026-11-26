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

test("two financial years sharing one GUID are different companies", async () => {
  const { sameTallyCompany } = await import("./bridge.ts");
  const y25 = { guid: "g", name: "Co (2025-2026)", booksFrom: "2025-04-01" };
  const y26 = { guid: "G", name: "Co (2026-2027)", booksFrom: "20260401" };
  assert.equal(sameTallyCompany(y25, y26), false);
  assert.equal(sameTallyCompany(y25, { ...y25, guid: "G", name: "Renamed" }), true);
  assert.equal(sameTallyCompany({ guid: "g" }, y26), true);
  assert.equal(sameTallyCompany(y25, { guid: "g", name: "Co (2025-2026)" }), true);
  assert.equal(sameTallyCompany(y25, { guid: "g", name: "Co (2026-2027)" }), false);
});
