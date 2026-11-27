import assert from "node:assert/strict";
import test from "node:test";
import { booksYearEnd, creditNoteDateFor, dateInBooksYear, continuationWindow, CONTINUATION_HORIZON_DAYS } from "./year-continuation.ts";

const next = { name: "CO - (2026-2027)", guid: "g", booksFrom: "2026-04-01" };

test("no continuation when the check ends before the next year starts", () => {
  assert.equal(continuationWindow(next, "2026-03-31"), null);
  assert.equal(continuationWindow(next, ""), null);
});

test("a check reaching past the boundary reads the next year, capped at the horizon", () => {
  const window = continuationWindow(next, "2026-11-26");
  assert.equal(window.dateFrom, "2026-04-01");
  assert.equal(CONTINUATION_HORIZON_DAYS, 60);
  assert.equal(window.dateTo, "2026-05-30");
  assert.deepEqual(window.company, next);
});

test("a check ending soon after the boundary reads only up to its own end", () => {
  assert.equal(continuationWindow(next, "2026-04-20").dateTo, "2026-04-20");
});

test("a company takes only dates inside its own financial year", () => {
  assert.equal(booksYearEnd("2025-04-01"), "2026-03-31");
  assert.equal(dateInBooksYear("2025-04-01", "2026-03-31"), true);
  assert.equal(dateInBooksYear("2025-04-01", "2026-11-27"), false);
  assert.equal(dateInBooksYear("2026-04-01", "2026-11-27"), true);
  assert.equal(dateInBooksYear(null, "2026-11-27"), true);
});

test("a Credit Note is dated today inside the year, else the last day of its year", () => {
  assert.equal(creditNoteDateFor("2026-04-01", "2026-11-27"), "2026-11-27");
  assert.equal(creditNoteDateFor("2025-04-01", "2026-11-27"), "2026-03-31");
  assert.equal(creditNoteDateFor("2025-04-01", "2026-03-31"), "2026-03-31");
  assert.equal(creditNoteDateFor("2027-04-01", "2026-11-27"), "2027-04-01");
  assert.equal(creditNoteDateFor(null, "2026-11-27"), "2026-11-27");
});
