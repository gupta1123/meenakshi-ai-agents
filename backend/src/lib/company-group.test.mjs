import assert from "node:assert/strict";
import test from "node:test";
import { groupOf, tagYearGroups, periodBookMatches } from "./company-group.ts";

const rows = [
  { id: "a", tally_company_name: "CO (2025-26)", tally_company_guid: "g1", tally_books_from: "2025-04-01" },
  { id: "b", tally_company_name: "CO (2026-27)", tally_company_guid: "g1", tally_books_from: "2026-04-01" },
  { id: "c", tally_company_name: "Other", tally_company_guid: "g2", tally_books_from: "2026-04-01" },
];

test("years of one Tally company form one group, oldest first", () => {
  assert.deepEqual(groupOf(rows, "b").map((m) => m.id), ["a", "b"]);
  assert.deepEqual(groupOf(rows, "c").map((m) => m.id), ["c"]);
});

test("the dropdown shows the newest year once; older years point to it", () => {
  const tagged = tagYearGroups(rows);
  assert.equal(tagged.find((r) => r.id === "a").year_of, "b");
  assert.deepEqual(tagged.find((r) => r.id === "b").year_members.map((m) => m.id), ["a", "b"]);
  assert.equal(tagged.find((r) => r.id === "c").year_of, undefined);
  assert.equal(tagged.find((r) => r.id === "c").year_members, undefined);
});

test("the quarter belongs to its financial-year books regardless of run date", () => {
  const members = groupOf(rows, "a");
  assert.equal(periodBookMatches(members, "a", "2026-01-01"), true);
  assert.equal(periodBookMatches(members, "a", "2026-04-01"), false);
  assert.equal(periodBookMatches(members, "b", "2026-04-01"), true);
});
