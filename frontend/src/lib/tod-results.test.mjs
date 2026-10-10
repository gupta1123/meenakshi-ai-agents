import assert from "node:assert/strict";
import test from "node:test";
import { assertSelectedTodPeriod, loadTodPeriodResults, todPeriodReadStatus } from "./tod-results.ts";

test("a new company or period stays loading until its own read finishes, never briefly empty", () => {
  const scope = "company-a:2026-04-01:2026-06-30";
  assert.equal(todPeriodReadStatus(scope, null), "loading");
  assert.equal(todPeriodReadStatus(scope, { scope: "company-a:2025-04-01:2025-06-30", status: "loaded" }), "loading");
  assert.equal(todPeriodReadStatus(scope, { scope: "company-b:2026-04-01:2026-06-30", status: "loaded" }), "loading");
  assert.equal(todPeriodReadStatus(scope, { scope, status: "loading" }), "loading");
  assert.equal(todPeriodReadStatus(scope, { scope, status: "loaded" }), "loaded");
});

test("a failed period read shows an error, not a skeleton forever or an empty result", () => {
  const scope = "company-a:2026-04-01:2026-06-30";
  assert.equal(todPeriodReadStatus(scope, { scope, status: "error" }), "error");
  assert.equal(todPeriodReadStatus("another-period", { scope, status: "error" }), "loading");
});

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
