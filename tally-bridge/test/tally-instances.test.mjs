import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTallyInstances } from "../src/tally/instances.mjs";
import { processOneCheckJob } from "../src/server-jobs.mjs";

// A tiny stand-in for a Tally program: tells which company is "current" and lists the open ones.
function fakeTally(companies, current) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(body);
      response.setHeader("content-type", "text/xml");
      if (body.includes("$$CurrentCompany")) return response.end(`<ENVELOPE><RESULT>${current}</RESULT></ENVELOPE>`);
      response.end(`<ENVELOPE>${companies.map((c) => `<COMPANY><NAME>${c.name}</NAME><GUID>${c.guid}</GUID><BOOKSFROM>${c.booksFrom}</BOOKSFROM></COMPANY>`).join("")}</ENVELOPE>`);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

const Y25 = { name: "Co - (2025-2026)", guid: "same-guid", booksFrom: "20250401" };
const Y26 = { name: "Co - (2026-2027)", guid: "same-guid", booksFrom: "20260401" };
const STEELS = { name: "Steels - (2026-2027)", guid: "other-guid", booksFrom: "20260401" };

test("two Tally programs on two ports: each year is found on its own port", async () => {
  const a = await fakeTally([Y26], Y26.name), b = await fakeTally([Y25], Y25.name), c = await fakeTally([STEELS], STEELS.name);
  try {
    const instances = createTallyInstances({ configuredUrl: a.url, listUrls: async () => [a.url, b.url, c.url] });
    const found25 = await instances.find({ guid: "SAME-GUID", name: "Whatever it was called", booksFrom: "2025-04-01" });
    const found26 = await instances.find({ guid: "same-guid", name: "Co - (2026-2027)", booksFrom: "2026-04-01" });
    assert.equal(found25.url, b.url);
    assert.equal(found26.url, a.url);
    assert.equal((await instances.find({ guid: "other-guid" })).url, c.url);
    assert.equal(await instances.find({ guid: "same-guid", booksFrom: "2024-04-01" }), null);
    assert.equal((await instances.all()).length, 3);
  } finally { for (const x of [a, b, c]) x.server.close(); }
});

test("a record that cannot tell years apart never picks a year by luck", async () => {
  const a = await fakeTally([Y26], Y26.name), b = await fakeTally([Y25], Y25.name);
  try {
    const instances = createTallyInstances({ configuredUrl: a.url, listUrls: async () => [a.url, b.url] });
    assert.equal(await instances.find({ guid: "same-guid", name: "Some old name" }), null);
    assert.equal((await instances.find({ guid: "same-guid", name: "Co - (2025-2026)" })).url, b.url);
  } finally { a.server.close(); b.server.close(); }
});

test("a queued check runs against the port that has its company, and an absent year is refused", async () => {
  const a = await fakeTally([Y26], Y26.name), b = await fakeTally([Y25], Y25.name);
  try {
    const instances = createTallyInstances({ configuredUrl: a.url, listUrls: async () => [a.url, b.url] });
    const resolveTarget = async (expected) => {
      const hit = await instances.find(expected);
      return hit ? { config: { tallyUrl: hit.url }, activeCompany: hit.company } : null;
    };
    const run = async (expectedTallyCompany) => {
      const seen = [], finished = [];
      const cp = { clear() {}, settle() {} };
      const deps = {
        createCheckpoint: () => cp,
        fetchLiveCdEvidence: async (_command, ctx) => { seen.push({ url: ctx.config.tallyUrl, company: ctx.activeCompany.name }); return { invoices: [] }; },
        evaluateLocalCashDiscount: () => ({ rows: [] }),
        claimNextCheckJob: async () => ({ job: { id: "j1", kind: "cd", attempt: 1, requestedBy: "u", expectedTallyCompany,
          request: { body: { rule: {}, evaluatedOn: "2026-06-30", voucherScope: { dateFrom: "2025-04-01", dateTo: "2025-06-30" } } } } }),
        reportCheckJobProgress: async () => ({ ok: true }),
        finishCheckJob: async (_c, _id, payload) => { finished.push(payload); },
        sendHeartbeat: async () => ({}),
      };
      // The connector's "current" company is 2026-27 on the configured port.
      await processOneCheckJob({ tallyUrl: a.url }, { ...Y26, booksFrom: "2026-04-01" }, { resolveTarget }, deps);
      return { seen, finished };
    };
    const y25 = await run({ guid: "same-guid", name: "Co - (2025-2026)", booksFrom: "2025-04-01" });
    assert.deepEqual(y25.seen, [{ url: b.url, company: "Co - (2025-2026)" }]);
    assert.equal(y25.finished[0].status, "succeeded");
    // A year that is not open anywhere must fail, and never fall back to the configured company.
    const y24 = await run({ guid: "same-guid", name: "Co - (2024-2025)", booksFrom: "2024-04-01" });
    assert.deepEqual(y24.seen, []);
    assert.equal(y24.finished[0].status, "failed");
    assert.match(y24.finished[0].failureReason, /2024-2025/);
  } finally { a.server.close(); b.server.close(); }
});
