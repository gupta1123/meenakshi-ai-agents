import assert from "node:assert/strict";
import test from "node:test";
import { mergeCdSettlements } from "./cd-group-merge.ts";

const part = (id, booksFrom, totals, results, run = { id: `run-${id}` }) => ({
  companyId: id, companyName: `CO ${booksFrom}`, booksFrom,
  data: { run, totals, requiresRecheck: false, results, candidates: [{ id: `c-${id}` }], creditNotes: { [`inv-${id}`]: { id: `n-${id}` } } },
});

test("years are added up and every row keeps the company it belongs to", () => {
  const merged = mergeCdSettlements([
    part("a", "2025-04-01", { invoicesChecked: 10, readyCreditAmount: "100.50", invoicePeriod: { from: "2025-04-01", to: "2026-03-31" }, creditNoteMatchingVersion: 3 }, [{ invoiceGuid: "x" }]),
    part("b", "2026-04-01", { invoicesChecked: 5, readyCreditAmount: "20.00", invoicePeriod: { from: "2026-04-01", to: "2026-11-27" }, creditNoteMatchingVersion: 3 }, [{ invoiceGuid: "y" }]),
  ]);
  assert.equal(merged.totals.invoicesChecked, 15);
  assert.equal(merged.totals.readyCreditAmount, "120.50");
  assert.deepEqual(merged.totals.invoicePeriod, { from: "2025-04-01", to: "2026-11-27" });
  assert.deepEqual(merged.results.map((row) => [row.invoiceGuid, row.companyId]), [["x", "a"], ["y", "b"]]);
  assert.deepEqual(Object.keys(merged.creditNotes).sort(), ["inv-a", "inv-b"]);
  assert.equal(merged.run.id, "run-b");
  assert.equal(merged.runs.length, 2);
});

test("a year with no saved check adds nothing", () => {
  const merged = mergeCdSettlements([
    part("a", "2025-04-01", { invoicesChecked: 0 }, [], null),
    part("b", "2026-04-01", { invoicesChecked: 5 }, [{ invoiceGuid: "y" }]),
  ]);
  assert.equal(merged.totals.invoicesChecked, 5);
  assert.equal(merged.results.length, 1);
});

test("a single company behaves as before, with rows tagged", () => {
  const merged = mergeCdSettlements([part("b", "2026-04-01", { invoicesChecked: 5 }, [{ invoiceGuid: "y" }])]);
  assert.equal(merged.totals.invoicesChecked, 5);
  assert.equal(merged.results[0].companyId, "b");
});
