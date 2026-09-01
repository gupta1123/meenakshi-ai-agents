import test from "node:test";
import assert from "node:assert/strict";
import { executeCommand } from "../src/commands/dispatch.mjs";
import { fetchLiveTodEvidence } from "../src/commands/live-tod-evidence.mjs";

test("targeted evidence command keeps paired master and voucher checkpoints distinct", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("<ENVELOPE></ENVELOPE>", { status: 200 });
  };
  try {
    const result = await executeCommand({
      commandType: "fetch_meenakshi_evidence",
      payload: {
        evaluationRunId: "evaluation-1", masterSyncRunId: "master-sync-1", voucherSyncRunId: "voucher-sync-1",
        voucherScope: { dateFrom: "2026-08-01", dateTo: "2026-08-31", customerLedgerName: "ACME" },
      },
    }, { config: { tallyUrl: "http://localhost:9000" }, activeCompany: { name: "Test Company", guid: "company-1" } });
    assert.equal(calls, 8, "seven master exports plus one voucher export");
    assert.equal(result.evaluationRunId, "evaluation-1");
    assert.equal(result.masters.syncRunId, "master-sync-1");
    assert.equal(result.vouchers.syncRunId, "voucher-sync-1");
    assert.equal(result.vouchers.cursorTo, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Turnover Discount local fast path needs no cloud voucher-sync record", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("<ENVELOPE></ENVELOPE>", { status: 200 });
  };
  try {
    const result = await fetchLiveTodEvidence({
      payload: {
        evaluationRunId: "evaluation-1",
        masterSyncRunId: "master-sync-1",
        voucherScope: {
          purpose: "live_tod_evaluation",
          liveAggregation: true,
          dateFrom: "2026-08-01",
          dateTo: "2026-08-31",
          customers: [{ customerId: "customer-1", ledgerName: "ACME" }],
          eligibleStockItemNames: ["Steel"],
          unitConversions: [{ uomCode: "MT", tonnesPerUnit: "1" }],
        },
      },
    }, { config: { tallyUrl: "http://localhost:9000" }, activeCompany: { name: "Test Company", guid: "company-1" }, isCancelled: () => false });

    assert.equal(calls, 1, "TOD live aggregation needs only the voucher export");
    assert.equal(result.mode, "live_tod_batch_aggregate");
    assert.equal(result.customerAggregates.length, 1);
    assert.equal(result.customerAggregates[0].customerId, "customer-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cash Discount fast path performs one live voucher export and no master exports", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(String(options?.body ?? ""));
    return new Response("<ENVELOPE></ENVELOPE>", { status: 200 });
  };
  try {
    const result = await executeCommand({
      commandType: "fetch_meenakshi_evidence",
      payload: {
        evaluationRunId: "evaluation-cd-1",
        fastCashDiscount: true,
        voucherScope: {
          purpose: "live_cd_evaluation",
          liveAggregation: "cd",
          ruleVersionId: "rule-1",
          dateFrom: "2026-01-01",
          dateTo: "2026-12-31",
          customers: [{ customerId: "customer-1", ledgerName: "ACME" }],
        },
      },
    }, { config: { tallyUrl: "http://localhost:9000" }, activeCompany: { name: "Test Company", guid: "company-1" } });

    assert.equal(requests.length, 1);
    assert.match(requests[0], /TYPE>Voucher</);
    assert.doesNotMatch(requests[0], /TYPE>StockItem</);
    assert.equal(result.masters.skipped, true);
    assert.equal(result.vouchers.mode, "live_cd_batch");
    assert.equal(result.vouchers.chunks, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
