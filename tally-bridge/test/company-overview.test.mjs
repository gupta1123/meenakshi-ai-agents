import test from "node:test";
import assert from "node:assert/strict";
import { runCompanyOverview, validateCompanyOverview } from "../src/support/company-overview.mjs";

const voucher = (date) => `<VOUCHER><DATE>${date}</DATE></VOUCHER>`;

test("company overview counts vouchers per month from small date windows", async () => {
  const requests = [];
  const post = async (_url, xml) => {
    requests.push(xml);
    const from = /<SVFROMDATE TYPE="Date">(\d{8})/.exec(xml)[1];
    // Tally may also return days outside the window; those must not be counted.
    return `<ENVELOPE>${voucher(from)}${voucher(from)}${voucher("20990101")}</ENVELOPE>`;
  };
  const result = await runCompanyOverview(
    { dateFrom: "2026-03-25", dateTo: "2026-04-14", pauseMs: 1000 },
    { config: { tallyUrl: "http://localhost:9000" }, activeCompany: { name: "Test Co", guid: "g-1" } },
    { post, pause: async () => {} },
  );
  assert.equal(requests.length, 3);
  assert.match(requests[0], /<SVCURRENTCOMPANY>Test Co<\/SVCURRENTCOMPANY>/);
  assert.match(requests[0], /<FETCH>Date<\/FETCH>/);
  assert.deepEqual(result.months, [{ month: "2026-03", vouchers: 2 }, { month: "2026-04", vouchers: 4 }]);
  assert.equal(result.totalVouchers, 6);
  assert.equal(result.company.name, "Test Co");
});

test("company overview refuses bad or very long ranges and stops when cancelled", async () => {
  assert.throws(() => validateCompanyOverview({ dateFrom: "2026-05-01", dateTo: "2026-04-01" }), /valid date range/);
  assert.throws(() => validateCompanyOverview({ dateFrom: "2020-01-01", dateTo: "2026-01-01" }), /at most 36 months/);
  await assert.rejects(
    runCompanyOverview({ dateFrom: "2026-04-01", dateTo: "2026-04-30" },
      { config: {}, activeCompany: { name: "X" }, isCancelled: () => true }, { post: async () => "" }),
    /stopped/,
  );
});
