import test from "node:test";
import assert from "node:assert/strict";
import { beginRuntimeStatus, readRuntimeStatus, recordRuntimeActivity, recordRuntimeFailure, recordRuntimeHeartbeat } from "../src/runtime-status.mjs";

test("the desktop monitor receives connection and activity changes without configuration secrets or business evidence", () => {
  beginRuntimeStatus({ mode: "server", installationKey: "private-installation-key", controlToken: "private-control-token" });
  const activeCompany = { name: "Test company", guid: "company-guid", secret: "private-company-field" };
  recordRuntimeHeartbeat({ tallyReachable: true, activeCompany, availableCompanies: [activeCompany], invoices: [{ amount: 999 }] }, { bindings: [{ matches: true, expectedCompany: activeCompany, token: "private-binding-token" }] });
  recordRuntimeActivity("Checking Turnover Discount");
  const status = readRuntimeStatus();
  assert.equal(status.mode, "server"); assert.equal(status.pid, process.pid);
  assert.equal(status.connection.cloudConnected, true); assert.equal(status.activity, "Checking Turnover Discount");
  assert.equal(status.connection.bindings[0].matches, true);
  assert.equal(status.connection.activeCompany.name, "Test company");
  assert.ok(Date.parse(status.connection.checkedAt));
  assert.doesNotMatch(JSON.stringify(status), /private|invoices|"amount"/);
  recordRuntimeFailure();
  assert.equal(readRuntimeStatus().connection.cloudConnected, false);
  beginRuntimeStatus({ mode: "pc" });
  assert.equal(readRuntimeStatus().mode, "pc"); assert.equal(readRuntimeStatus().connection, null);
});
