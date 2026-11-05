import assert from "node:assert/strict";
import test from "node:test";
import { describeApiWrite, primaryRole } from "./audit-request.ts";

const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const candidate = "0b2f6d2e-1111-4222-8333-444455556666";

test("reads and noisy routes are not audited", () => {
  assert.equal(describeApiWrite("GET", `https://x/api/companies/${company}/overview`), null);
  assert.equal(describeApiWrite("OPTIONS", `https://x/api/companies/${company}/overview`), null);
  assert.equal(describeApiWrite("POST", `https://x/api/companies/${company}/calculation-events`), null);
  assert.equal(describeApiWrite("POST", `https://x/api/companies/${company}/calculation-events/${candidate}`), null);
  assert.equal(describeApiWrite("POST", `https://x/api/companies/${company}/notifications/previews`), null);
});

test("a write records the method, a readable route and the record acted on", () => {
  assert.deepEqual(
    describeApiWrite("post", `https://x/api/companies/${company}/cash-discount/settlements/${candidate}/credit-note?x=1`),
    { method: "POST", route: "/cash-discount/settlements/:id/credit-note", entityId: candidate }
  );
  assert.deepEqual(
    describeApiWrite("PUT", `/api/companies/${company}/credit-note-accounting-settings`),
    { method: "PUT", route: "/credit-note-accounting-settings", entityId: null }
  );
});

test("the strongest role is reported", () => {
  assert.equal(primaryRole(["finance_approver", "administrator"]), "administrator");
  assert.equal(primaryRole(["finance_approver"]), "finance_approver");
  assert.equal(primaryRole([]), "unknown");
});
