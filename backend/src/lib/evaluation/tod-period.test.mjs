import assert from "node:assert/strict";
import test from "node:test";
import { isTodDate, requestedTodPeriod, resolveTodPeriod, validateTodBatchEvidence } from "./tod-period.ts";
import { loadLiveTodBatchContext, loadLiveTodContext } from "./evidence.ts";

const aprilRule = { periodAnchorDate: "2025-04-01", periodMonths: 3, effectiveTo: null };
const april2026 = { start: "2026-04-01", end: "2026-06-30" };
test("explicit and legacy June requests resolve April–June, not May–July", () => {
  assert.deepEqual(resolveTodPeriod(aprilRule, "2026-06-30"), april2026);
  assert.deepEqual(resolveTodPeriod(aprilRule, "2026-06-30", april2026), april2026);
  assert.throws(() => resolveTodPeriod({ ...aprilRule, periodAnchorDate: "2026-05-01" }, "2026-06-30", april2026), /no longer matches/);
});
test("period selection rejects invalid dates, partial periods and changed boundaries", () => {
  assert.equal(isTodDate("2026-02-30"), false);
  assert.throws(() => requestedTodPeriod({ periodStart: "2026-04-01" }), /both start and end/);
  assert.throws(() => requestedTodPeriod({ periodStart: "2026-06-30", periodEnd: "2026-04-01" }), /valid/);
  assert.deepEqual(resolveTodPeriod({ ...aprilRule, effectiveTo: "2026-04-30" }, "2026-04-30"), { start: "2026-04-01", end: "2026-04-30" });
});
test("saving rejects wrong-period, duplicate, missing, foreign and changed-rule evidence", () => {
  const expected = new Map([["c1", "v3"], ["c2", "v4"]]);
  const evidence = { periodStart: april2026.start, periodEnd: april2026.end, customerAggregates: [{ customerId: "c1" }, { customerId: "c2" }] };
  assert.deepEqual(validateTodBatchEvidence(april2026, evidence, expected).map(row => row.schemeVersionId), ["v3", "v4"]);
  assert.throws(() => validateTodBatchEvidence(april2026, { ...evidence, periodStart: "2026-05-01" }, expected), /different.*period/);
  for (const aggregates of [
    [{ customerId: "c1" }],
    [{ customerId: "c1" }, { customerId: "c1" }],
    [{ customerId: "c1" }, { customerId: "foreign" }],
    [{ customerId: "c1", schemeVersionId: "v4" }, { customerId: "c2" }],
    [{ customerId: "c1", periodStart: "2026-05-01", periodEnd: "2026-07-31" }, { customerId: "c2" }],
  ]) assert.throws(() => validateTodBatchEvidence(april2026, { ...evidence, customerAggregates: aggregates }, expected));
});

test("real scope loaders ignore overlapping retired locks but preserve exact old-version locks", async () => {
  process.env.SUPABASE_URL = "https://tod-test.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://tod-test.invalid";
  process.env.SUPABASE_SECRET_KEY = "not-a-real-secret";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "not-a-real-secret";
  const oldFetch = globalThis.fetch;
  const queries = [];
  let overlappingPosting = false;
  const rule = (id) => ({ id, scheme_id: "scheme", scheme_type: "tod", company_id: "company", version_number: id === "v4" ? 4 : 3,
    status: id === "v4" ? "active" : "retired", effective_from: "2025-04-01", effective_to: null, period_anchor_date: "2025-04-01", period_months: 3,
    rounding_method: "half_up", rounding_scale: 2 });
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET", "diagnostic loaders must not mutate records");
    const url = new URL(String(input)); queries.push(url);
    const table = url.pathname.split("/").at(-1);
    let rows = [];
    if (table === "scheme_versions") rows = url.searchParams.has("id") ? [rule(url.searchParams.get("id").slice(3))] : [{ id: "v4", status: "active" }];
    if (table === "scheme_version_group_coverage") rows = [{ customer_group_id: "group" }];
    if (table === "customer_groups") rows = [{ id: "group", name: "Sales", is_available: true, parent_group_id: null }];
    if (table === "customers") rows = [{ id: "customer", ledger_name: "Customer", is_available: true, current_customer_group_id: "group" }];
    if (table === "discount_proposals" && overlappingPosting) rows = [{ id: "posted-overlap", credit_note_postings: [{ id: "note" }] }];
    if (table === "tod_customer_period_rule_locks") {
      // Fail the test if the original date-containing query returns.
      assert.match(url.searchParams.get("period_start") ?? "", /^eq\./);
      assert.match(url.searchParams.get("period_end") ?? "", /^eq\./);
      rows = url.searchParams.get("period_start") === "eq.2025-04-01"
        ? [{ customer_id: "customer", scheme_version_id: "v3", period_start: "2025-04-01", period_end: "2025-06-30" }] : [];
    }
    const single = String(new Headers(init?.headers).get("accept")).includes("vnd.pgrst.object");
    return new Response(JSON.stringify(single ? rows[0] ?? null : rows), { headers: { "Content-Type": "application/json" } });
  };
  const run = (year) => ({ id: "run", company_id: "company", requested_by: null, tally_master_refresh_run_id: null, tally_voucher_refresh_run_id: null,
    request_context: { schemeType: "tod", batch: true, asOfDate: `${year}-06-30`, periodStart: `${year}-04-01`, periodEnd: `${year}-06-30` } });
  try {
    const current = await loadLiveTodBatchContext(run(2026));
    assert.equal(current.groups[0].periodStart, "2026-04-01");
    assert.equal(current.groups[0].rule.id, "v4");
    const historic = await loadLiveTodBatchContext(run(2025));
    assert.equal(historic.activeRule.id, "v4", "active rule metadata must not be replaced by a retired batch's rule");
    assert.equal(historic.groups[0].rule.id, "v3");
    const child = await loadLiveTodContext({ ...run(2026), request_context: { ...run(2026).request_context, batch: false, customerId: "customer", schemeVersionId: "v4" } });
    assert.equal(child.periodEnd, "2026-06-30");
    await assert.rejects(loadLiveTodBatchContext({ ...run(2026), request_context: { ...run(2026).request_context, selectedSchemeVersionId: "v1" } }), /rule changed/);
    overlappingPosting = true;
    await assert.rejects(loadLiveTodBatchContext(run(2026)), /overlapping.*Credit Note/);
    assert.ok(queries.length > 0);
  } finally { globalThis.fetch = oldFetch; }
});
