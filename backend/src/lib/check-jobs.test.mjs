import test from "node:test";
import assert from "node:assert/strict";
import { buildCheckJobInput, describeJobStatus, describeServerReadiness } from "./check-jobs.ts";

test("cd request key is per scheme version", () => {
  assert.equal(buildCheckJobInput({ kind: "cd", body: {} }).scopeKey, "cd:all");
  assert.equal(buildCheckJobInput({ kind: "cd", schemeVersionId: "abc-1", body: {} }).scopeKey, "cd:abc-1");
});

test("same tod period gives the same key so users join one run", () => {
  const a = buildCheckJobInput({ kind: "tod", periodStart: "2026-04-01", periodEnd: "2026-06-30", body: {} });
  const b = buildCheckJobInput({ kind: "tod", periodStart: "2026-04-01", periodEnd: "2026-06-30", body: {} });
  assert.equal(a.scopeKey, b.scopeKey);
  assert.equal(a.scopeKey, "tod:2026-04-01:2026-06-30");
});

test("bad input is refused", () => {
  assert.throws(() => buildCheckJobInput({ kind: "nope" }));
  assert.throws(() => buildCheckJobInput(null));
  assert.throws(() => buildCheckJobInput({ kind: "tod", periodStart: "2026-06-30", periodEnd: "2026-04-01" }));
  assert.throws(() => buildCheckJobInput({ kind: "tod", periodStart: "2026-13-45", periodEnd: "2026-14-01" }));
  assert.throws(() => buildCheckJobInput({ kind: "einvoice" }));
  assert.throws(() => buildCheckJobInput({ kind: "einvoice", noteKind: "credit", date: "2026-06-30", voucherNumber: "  " }));
  assert.throws(() => buildCheckJobInput({ kind: "cd", schemeVersionId: "x y; drop" }));
});

test("cd and tod need the calculation body, which is carried to the connector", () => {
  assert.throws(() => buildCheckJobInput({ kind: "cd" }));
  assert.throws(() => buildCheckJobInput({ kind: "cd", body: [] }));
  const job = buildCheckJobInput({ kind: "cd", body: { rule: { a: 1 }, evaluatedOn: "2026-06-30" } });
  assert.deepEqual(job.request.body, { rule: { a: 1 }, evaluatedOn: "2026-06-30" });
});

test("an e-invoice read is keyed by note, so two people reading the same note share one read", () => {
  const a = buildCheckJobInput({ kind: "einvoice", noteKind: "credit", date: "2026-06-30", voucherNumber: "CN/25-26/12" });
  assert.equal(a.scopeKey, "einvoice:credit:2026-06-30:CN/25-26/12");
  assert.deepEqual(a.request, { noteKind: "credit", date: "2026-06-30", voucherNumber: "CN/25-26/12" });
});

test("status text", () => {
  assert.match(describeJobStatus("queued", 2), /2 checks ahead/);
  assert.equal(describeJobStatus("running", 0), "Running on the Tally server.");
});

test("server readiness explains each reason in plain words", () => {
  const now = Date.parse("2026-11-05T10:00:00Z");
  const base = { lastSeenAt: "2026-11-05T09:59:30Z", tallyReachable: true, companyLoaded: true, activeCompanyName: "Meenakshi Udyog", expectedCompanyName: "Meenakshi Udyog", now };
  assert.equal(describeServerReadiness(base).state, "ready");
  assert.equal(describeServerReadiness({ ...base, lastSeenAt: "2026-11-05T09:50:00Z" }).state, "connector_offline");
  assert.equal(describeServerReadiness({ ...base, lastSeenAt: null }).state, "connector_offline");
  assert.equal(describeServerReadiness({ ...base, tallyReachable: false }).state, "tally_closed");
  assert.match(describeServerReadiness({ ...base, tallyReachable: false }).message, /open Tally Prime/);
  assert.equal(describeServerReadiness({ ...base, companyLoaded: false, activeCompanyName: null }).state, "company_not_open");
  assert.equal(describeServerReadiness({ ...base, activeCompanyName: "Another Co" }).state, "wrong_company");
});

test("a check can ask the server to save its result", () => {
  assert.equal(buildCheckJobInput({ kind: "cd", body: {} }).request.save, null);
  assert.deepEqual(buildCheckJobInput({ kind: "cd", save: true, body: {} }).request.save, {});
  const tod = buildCheckJobInput({ kind: "tod", periodStart: "2026-04-01", periodEnd: "2026-06-30", saveAsOfDate: "2026-06-30", body: {} });
  assert.deepEqual(tod.request.save, { asOfDate: "2026-06-30" });
  assert.equal(buildCheckJobInput({ kind: "tod", periodStart: "2026-04-01", periodEnd: "2026-06-30", body: {} }).request.save, null);
  assert.throws(() => buildCheckJobInput({ kind: "tod", periodStart: "2026-04-01", periodEnd: "2026-06-30", saveAsOfDate: "soon", body: {} }));
});
