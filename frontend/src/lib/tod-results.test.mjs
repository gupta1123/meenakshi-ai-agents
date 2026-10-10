import assert from "node:assert/strict";
import test from "node:test";
import { assertSelectedTodPeriod, loadTodPeriodResults } from "./tod-results.ts";

test("Customers loads all 435 results, including exact-period retired-version results", async () => {
  const source = Array.from({ length: 435 }, (_, index) => ({ id: String(index), scheme_version_id: "retired-v3", status: index < 44 ? "eligible" : "tracking" }));
  let offset = 0;
  const rows = await loadTodPeriodResults(async (params) => {
    assert.equal(params.get("periodStart"), "2025-04-01");
    assert.equal(params.get("periodEnd"), "2025-06-30");
    assert.equal(params.has("activeOnly"), false);
    assert.equal(params.has("includeArchived"), false);
    const page = source.slice(offset, offset + 200); offset += page.length;
    return { proposals: page, hasMore: offset < source.length, nextCursor: page.at(-1)?.id ?? null };
  }, "2025-04-01", "2025-06-30");
  assert.equal(rows.length, 435);
  assert.equal(rows.filter(row => row.status === "eligible").length, 44);
});
test("Customers refresh replaces deleted/archived rows rather than retaining a prior page", async () => {
  const page = (proposals) => async () => ({ proposals, hasMore: false, nextCursor: null });
  assert.equal((await loadTodPeriodResults(page([{ id: "old" }]), "2025-04-01", "2025-06-30")).length, 1);
  assert.deepEqual(await loadTodPeriodResults(page([]), "2025-04-01", "2025-06-30"), []);
});
test("broken pagination fails explicitly instead of displaying incomplete totals", async () => {
  await assert.rejects(loadTodPeriodResults(async () => ({ proposals: [{ id: "row" }], hasMore: true, nextCursor: "same" }), "2025-04-01", "2025-06-30"), /all customer results/);
});
test("connector scope/results cannot silently replace April–June with May–July", () => {
  const selection = { start: "2026-04-01", end: "2026-06-30" };
  assertSelectedTodPeriod(selection, [{ periodStart: selection.start, periodEnd: selection.end }]);
  assert.throws(() => assertSelectedTodPeriod(selection, [{ periodStart: "2026-05-01", periodEnd: "2026-07-31" }]), /selected period/);
});
