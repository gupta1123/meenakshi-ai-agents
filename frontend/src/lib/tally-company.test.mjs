import assert from "node:assert/strict";
import test from "node:test";
import { sameTallyCompany } from "./tally-company.ts";

test("two financial years with one Tally ID are different companies; a rename is not", () => {
  const y25 = { guid: "g", name: "Co (2025-2026)", booksFrom: "2025-04-01" };
  const y26 = { guid: "G", name: "Co (2026-2027)", booksFrom: "2026-04-01" };
  assert.equal(sameTallyCompany(y25, y26), false);
  assert.equal(sameTallyCompany(y25, { ...y25, guid: "G", name: "Renamed" }), true);
  assert.equal(sameTallyCompany({ guid: "g" }, y26), true);
  assert.equal(sameTallyCompany(y25, { guid: "g", name: "Co (2025-2026)" }), true);
  assert.equal(sameTallyCompany(y25, { guid: "g", name: "Co (2026-2027)" }), false);
  assert.equal(sameTallyCompany({ guid: "a" }, { guid: "b" }), false);
});
