import assert from "node:assert/strict";
import test from "node:test";

import { collapseEvaluationRuns } from "./run-batches.ts";
import { requiresTallyRefresh } from "./refresh-policy.ts";
import { restoreCompactSummary } from "./run-summary.ts";
import { evaluateLiveTodAggregate } from "./live-tod.ts";

test("new TOD persistence rejects missing or incomplete payment checks before loading data", async () => {
  for (const extra of [{}, { paymentChecks: [], contributions: [{ tallyGuid: "unchecked-sale", voucherKind: "sales" }] }]) {
    await assert.rejects(evaluateLiveTodAggregate({}, { contributions: [], ...extra }), /TOD payment check required/);
  }
});

test("compact run reads preserve zero totals and flags without invoice evidence", () => {
  const row = restoreCompactSummary({ id: "run", status: "completed", compact_invoicesChecked: 444, compact_calculatedDiscountAmount: "0.0000", compact_reviewRequired: 0, compact_liveOnly: false, compact_message: null });
  assert.deepEqual(row, { id: "run", status: "completed", summary: { calculatedDiscountAmount: "0.0000", liveOnly: false, invoicesChecked: 444, reviewRequired: 0 } });
});

test("completed local TOD evidence never requests another Tally refresh", () => {
  const liveTodEvidence = {
    mode: "live_tod_aggregate",
    sourceFingerprint: "fingerprint",
    eligibleTaxableValue: "1000.00",
    eligibleTonnes: "2.0000",
    contributions: [],
    missingUnits: [],
  };
  assert.equal(requiresTallyRefresh({
    request_context: { schemeType: "tod" },
    summary: { liveTodEvidence },
    tally_master_refresh_run_id: null,
    tally_voucher_refresh_run_id: null,
  }), false);
});

test("customer jobs collapse into one visible calculation", () => {
  const parentId = "dbd0698f-b77e-453c-96cf-b92425b4cf04";
  const childId = "934d56ba-afc7-4cfd-94e4-5f090978eb85";
  const customerId = "43b04374-cea3-467a-b9dc-5aca0099a1f1";
  const runs = collapseEvaluationRuns([
    { id: childId, idempotency_key: `${parentId}:${customerId}`, status: "queued", created_at: "2026-08-11T16:26:00.000Z", scheme_type: "tod", scheme_version_id: "version-1", period_start: "2026-05-01", period_end: "2027-04-30" },
    { id: parentId, idempotency_key: "user-request", status: "completed", created_at: "2026-08-11T16:26:00.000Z", completed_at: "2026-08-11T16:27:00.000Z", scheme_type: "tod", request_context: { batch: true } },
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, parentId);
  assert.equal(runs[0].status, "queued");
  assert.equal(runs[0].total_jobs, 1);
  assert.equal(runs[0].completed_jobs, 0);
  assert.equal(runs[0].active_jobs, 1);
  assert.equal(runs[0].period_start, "2026-05-01");
  assert.equal(runs[0].period_end, "2027-04-30");
  assert.match(runs[0].run_reference, /^TOD-20260811-162600-DBD0$/);
});

test("completed customer jobs remain as one completed calculation", () => {
  const parentId = "dbd0698f-b77e-453c-96cf-b92425b4cf04";
  const runs = collapseEvaluationRuns([
    { id: parentId, status: "completed", created_at: "2026-08-11T16:26:00.000Z", completed_at: "2026-08-11T16:27:00.000Z", scheme_type: "tod", request_context: { batch: true } },
    { id: "934d56ba-afc7-4cfd-94e4-5f090978eb85", idempotency_key: `${parentId}:43b04374-cea3-467a-b9dc-5aca0099a1f1`, status: "completed", created_at: "2026-08-11T16:26:00.000Z", completed_at: "2026-08-11T16:27:10.000Z", scheme_type: "tod", summary: { calculatedDiscountAmount: "25000.00" } },
  ]);
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].completed_jobs, 1);
  assert.equal(runs[0].total_jobs, 1);
  assert.equal(runs[0].active_jobs, 0);
  assert.equal(runs[0].qualified_jobs, 1);
  assert.equal(runs[0].not_qualified_jobs, 0);
  assert.equal(runs[0].projected_discount_amount, 25000);
});

test("children still group when the coordinator is outside the query window", () => {
  const parentId = "dbd0698f-b77e-453c-96cf-b92425b4cf04";
  const runs = collapseEvaluationRuns([
    { id: "934d56ba-afc7-4cfd-94e4-5f090978eb85", idempotency_key: `${parentId}:43b04374-cea3-467a-b9dc-5aca0099a1f1`, status: "completed", created_at: "2026-08-11T16:26:01.000Z", scheme_type: "tod" },
    { id: "a311f602-8826-45d6-bc82-7b69359e53ee", idempotency_key: `${parentId}:dd2bbec5-1dec-4fc3-b830-32982d873c57`, status: "completed", created_at: "2026-08-11T16:26:02.000Z", scheme_type: "tod" },
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, parentId);
  assert.equal(runs[0].total_jobs, 2);
  assert.equal(runs[0].completed_jobs, 2);
});

test("a cancelled customer job makes a settled batch stopped instead of running", () => {
  const parentId = "dbd0698f-b77e-453c-96cf-b92425b4cf04";
  const runs = collapseEvaluationRuns([
    { id: parentId, status: "failed", created_at: "2026-08-11T16:26:00.000Z", scheme_type: "tod", request_context: { customerId: "0f0c1e81-9480-45f6-88ff-3a442000c4a4" } },
    { id: "934d56ba-afc7-4cfd-94e4-5f090978eb85", idempotency_key: `${parentId}:43b04374-cea3-467a-b9dc-5aca0099a1f1`, status: "cancelled", created_at: "2026-08-11T16:26:01.000Z", scheme_type: "tod" },
    { id: "a311f602-8826-45d6-bc82-7b69359e53ee", idempotency_key: `${parentId}:dd2bbec5-1dec-4fc3-b830-32982d873c57`, status: "completed", created_at: "2026-08-11T16:26:02.000Z", scheme_type: "tod" },
  ]);

  assert.equal(runs[0].status, "cancelled");
  assert.equal(runs[0].active_jobs, 0);
});

test("the root counts when it is also the first customer calculation", () => {
  const parentId = "dbd0698f-b77e-453c-96cf-b92425b4cf04";
  const runs = collapseEvaluationRuns([
    { id: parentId, status: "completed", created_at: "2026-08-11T16:26:00.000Z", scheme_type: "tod", request_context: { customerId: "0f0c1e81-9480-45f6-88ff-3a442000c4a4" } },
    { id: "934d56ba-afc7-4cfd-94e4-5f090978eb85", idempotency_key: `${parentId}:43b04374-cea3-467a-b9dc-5aca0099a1f1`, status: "completed", created_at: "2026-08-11T16:26:01.000Z", scheme_type: "tod" },
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].total_jobs, 2);
  assert.equal(runs[0].completed_jobs, 2);
});
