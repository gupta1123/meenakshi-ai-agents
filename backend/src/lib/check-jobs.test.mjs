import test from "node:test";
import assert from "node:assert/strict";
import { buildCheckJobInput, describeJobStatus, describeServerReadiness } from "./check-jobs.ts";

test("cd request key is per scheme version", () => {
  assert.notEqual(buildCheckJobInput({ kind: "cd", body: {} }).scopeKey, buildCheckJobInput({ kind: "cd", schemeVersionId: "abc-1", body: {} }).scopeKey);
});

test("same tod period gives the same key so users join one run", () => {
  const a = buildCheckJobInput({ kind: "tod", periodStart: "2026-04-01", periodEnd: "2026-06-30", body: {} });
  const b = buildCheckJobInput({ kind: "tod", periodStart: "2026-04-01", periodEnd: "2026-06-30", body: {} });
  assert.equal(a.scopeKey, b.scopeKey);
  assert.notEqual(a.scopeKey, buildCheckJobInput({ kind: "tod", periodStart: "2026-07-01", periodEnd: "2026-09-30", body: {} }).scopeKey);
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

test("browser requests share only identical calculation inputs, regardless of object key order", () => {
  const input = { kind: "cd", save: true, body: { rule: { id: "version-A" }, evaluatedOn: "2026-11-16", voucherScope: { dateFrom: "2026-04-01", dateTo: "2026-11-16" } } };
  const first = buildCheckJobInput(input);
  assert.equal(first.scopeKey, buildCheckJobInput({ ...input, body: { voucherScope: input.body.voucherScope, evaluatedOn: input.body.evaluatedOn, rule: input.body.rule } }).scopeKey);
  for (const change of [
    { rule: { id: "version-B" } }, { evaluatedOn: "2026-11-17" },
    { voucherScope: { ...input.body.voucherScope, dateFrom: "2025-04-01" } },
  ]) assert.notEqual(first.scopeKey, buildCheckJobInput({ ...input, body: { ...input.body, ...change } }).scopeKey);
});

test("TOD cannot join a different rule or saving date in the same quarter", () => {
  const input = { kind: "tod", periodStart: "2026-04-01", periodEnd: "2026-06-30", saveAsOfDate: "2026-06-30", body: { rule: { id: "A" } } };
  const key = buildCheckJobInput(input).scopeKey;
  assert.notEqual(key, buildCheckJobInput({ ...input, body: { rule: { id: "B" } } }).scopeKey);
  assert.notEqual(key, buildCheckJobInput({ ...input, saveAsOfDate: "2026-07-01" }).scopeKey);
});

test("a server holding two financial years is ready for each year by its own books-from date", () => {
  const base = { lastSeenAt: "2026-11-26T10:00:00Z", tallyReachable: true, companyLoaded: true, activeCompanyName: "Co - (2026-2027)", now: Date.parse("2026-11-26T10:00:30Z") };
  const open = [
    { guid: "g", name: "Co - (2026-2027)", booksFrom: "2026-04-01" },
    { guid: "g", name: "Co - (2025-2026)", booksFrom: "2025-04-01" },
  ];
  const y25 = { guid: "G", name: "Old name of Co", booksFrom: "2025-04-01" };
  assert.equal(describeServerReadiness({ ...base, expectedCompanyName: y25.name, openCompanies: open, expectedCompany: y25 }).state, "ready");
  const y24 = { guid: "g", name: "Co - (2024-2025)", booksFrom: "2024-04-01" };
  const missing = describeServerReadiness({ ...base, expectedCompanyName: y24.name, openCompanies: open, expectedCompany: y24 });
  assert.equal(missing.state, "wrong_company");
  assert.match(missing.message, /Co - \(2024-2025\)/);
});
