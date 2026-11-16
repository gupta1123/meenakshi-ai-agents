import test from "node:test";
import assert from "node:assert/strict";
import { executeCommand } from "../src/commands/dispatch.mjs";
import { fetchLiveTodEvidence, todPaymentDueDate } from "../src/commands/live-tod-evidence.mjs";

test("TOD payment due date is day 25, shifted past Sundays and holidays", () => {
  const check = { dueDays: 25, holidays: [], nonWorkingIsoWeekdays: [7] };
  assert.deepEqual(todPaymentDueDate("2026-08-01", check), { nominalDueDate: "2026-08-26", dueDate: "2026-08-26", shiftedFor: [] });
  assert.equal(todPaymentDueDate("2026-08-05", check).dueDate, "2026-08-31", "Sunday 30 Aug moves to Monday");
  const withHoliday = todPaymentDueDate("2026-08-05", { ...check, holidays: ["2026-08-31"] });
  assert.equal(withHoliday.dueDate, "2026-09-01", "Monday holiday moves to the next working day");
  assert.deepEqual(withHoliday.shiftedFor.map((item) => item.reason), ["non_working_day", "holiday"]);
  assert.equal(todPaymentDueDate("2026-08-01", { ...check, holidays: ["2026-08-15"] }).dueDate, "2026-08-26", "holidays inside the 25 days still count");
});

test("targeted evidence command keeps paired master and voucher checkpoints distinct", async () => {
  const originalFetch = globalThis.fetch;
  const exports = [];
  globalThis.fetch = async (_url, options) => {
    exports.push(String(options?.body ?? ""));
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
    assert.equal(exports.filter((xml) => xml.includes("<TYPE>Voucher</TYPE>")).length, 1);
    for (const type of ["Group", "Unit", "StockGroup", "StockItem", "VoucherType", "Ledger"])
      assert.ok(exports.some((xml) => xml.includes(`<TYPE>${type}</TYPE>`)), `missing ${type} export`);
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

    assert.equal(calls, 4, "a 31-day period is read in four paced windows of at most 10 days, with only voucher exports");
    assert.equal(result.mode, "live_tod_batch_aggregate");
    assert.equal(result.customerAggregates.length, 1);
    assert.equal(result.customerAggregates[0].customerId, "customer-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cash Discount fast path covers the whole year in bounded voucher windows without master exports", async () => {
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

    const dates = requests.map((xml) => {
      assert.match(xml, /<TYPE>Voucher<\/TYPE>/, "only voucher exports are permitted");
      const from = /<SVFROMDATE TYPE="Date">(\d{8})/.exec(xml)?.[1];
      const to = /<SVTODATE TYPE="Date">(\d{8})/.exec(xml)?.[1];
      const iso = value => `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
      return [new Date(iso(from)), new Date(iso(to))];
    });
    assert.equal(dates[0][0].toISOString().slice(0,10), "2026-01-01");
    assert.equal(dates.at(-1)[1].toISOString().slice(0,10), "2026-12-31");
    dates.forEach(([from,to], i) => {
      assert.ok((to - from) / 86400000 < 10, "each window must be at most ten days");
      if(i) assert.equal(+from, +dates[i-1][1] + 86400000, "no date gap or overlap");
    });
    assert.match(requests[0], /TYPE>Voucher</);
    assert.doesNotMatch(requests[0], /TYPE>StockItem</);
    assert.equal(result.masters.skipped, true);
    assert.equal(result.vouchers.mode, "live_cd_batch");
    assert.equal(result.vouchers.chunks, requests.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
