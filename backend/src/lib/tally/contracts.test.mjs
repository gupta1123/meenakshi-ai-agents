import test from "node:test";
import assert from "node:assert/strict";
import { parseVoucherSyncScope } from "./contracts.ts";

test("voucher synchronization requires a bounded scope", () => {
  assert.equal(parseVoucherSyncScope({}).error, "Voucher sync requires a date range, customerId, or voucherReference.");
  assert.equal(parseVoucherSyncScope({ dateFrom: "2026-04-01", dateTo: "2027-04-07" }).error, "A voucher sync can cover at most 370 days; request the next chunk separately.");
});

test("voucher synchronization keeps a valid date chunk and targeted reference", () => {
  const byDate = parseVoucherSyncScope({ dateFrom: "2026-04-01", dateTo: "2026-04-30", cursor: "2026-04-15" });
  assert.deepEqual(byDate.scope, { dateFrom: "2026-04-01", dateTo: "2026-04-30", cursor: "2026-04-15" });
  const byReference = parseVoucherSyncScope({ voucherReference: "S-100" });
  assert.deepEqual(byReference.scope, { voucherReference: "S-100" });
});
