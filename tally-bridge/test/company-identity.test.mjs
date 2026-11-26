import test from "node:test";
import assert from "node:assert/strict";
import { companyKey, normalizeBooksFrom, sameTallyCompany } from "../src/tally/company-identity.mjs";

test("books-from dates are read from Tally's and the product's formats", () => {
  assert.equal(normalizeBooksFrom("20250401"), "2025-04-01");
  assert.equal(normalizeBooksFrom("2025-04-01"), "2025-04-01");
  assert.equal(normalizeBooksFrom(""), null);
  assert.equal(normalizeBooksFrom(null), null);
});

test("two years with one GUID are different companies; a rename is not", () => {
  const a = { guid: "g1", name: "Co (2025-2026)", booksFrom: "20250401" };
  const b = { guid: "G1", name: "Co (2026-2027)", booksFrom: "20260401" };
  assert.equal(sameTallyCompany(a, b), false);
  assert.equal(sameTallyCompany(a, { ...a, name: "Totally renamed" }), true);
  assert.notEqual(companyKey(a), companyKey(b));
  assert.equal(sameTallyCompany({ guid: "x" }, { guid: "y" }), false);
});

test("a side that does not know its year falls back safely", () => {
  const known = { guid: "g", name: "Co", booksFrom: "2025-04-01" };
  // Older connector: no year reported. The year-aware record needs the name to agree.
  assert.equal(sameTallyCompany(known, { guid: "g", name: " co " }), true);
  assert.equal(sameTallyCompany(known, { guid: "g", name: "Other year" }), false);
  // Record without a year: GUID alone, as before.
  assert.equal(sameTallyCompany({ guid: "g" }, { guid: "g", name: "Anything", booksFrom: "2026-04-01" }), true);
  // No GUID at all: names.
  assert.equal(sameTallyCompany({ name: "Co" }, { name: "co" }), true);
  assert.equal(sameTallyCompany({ name: "" }, { name: "" }), false);
});
