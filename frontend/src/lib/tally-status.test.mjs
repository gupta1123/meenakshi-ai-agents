import assert from "node:assert/strict";
import test from "node:test";
import { savedPostingFailure, tallyConnectionStatus, tallyConnectionView } from "./tally-status.ts";

test("an initial health read is checking, not disconnected", () => {
  assert.equal(tallyConnectionStatus(null), "checking");
  const view = tallyConnectionView("checking");
  assert.equal(view.tone, "busy");
  assert.equal(view.connected, false);
  assert.doesNotMatch(view.title, /not connected/i);
});

test("a failed health read does not reuse a previous ready status or assert disconnection", () => {
  const status = tallyConnectionStatus({ status: "ready" }, "Request timed out");
  assert.equal(status, "connection_check_failed");
  const view = tallyConnectionView(status);
  assert.equal(view.connected, false);
  assert.equal(view.title, "Could not check Tally");
});

test("confirmed connectivity and mismatch retain their distinct meanings", () => {
  assert.equal(tallyConnectionView(tallyConnectionStatus({ status: "ready" })).connected, true);
  assert.equal(tallyConnectionView("bridge_stale").title, "Tally not connected");
  assert.equal(tallyConnectionView("company_mismatch").title, "Other company open in Tally");
  assert.equal(tallyConnectionView("not_ready").connected, false);
});

test("company mismatch is labelled as a dated previous attempt, without automatic retry advice", () => {
  const text = savedPostingFailure("The active Tally company does not match this Meenakshi command.", "Meenakshi", "2026-09-26T07:14:02Z");
  assert.match(text, /Previous Credit Note attempt failed/);
  assert.match(text, /26 Sept 2026/);
  assert.match(text, /a different company was active/);
  assert.match(text, /confirm Meenakshi is open/);
  assert.doesNotMatch(text, /create again|not connected/i);
});

test("legacy failed records without dates retain their reason", () => {
  assert.equal(savedPostingFailure("Voucher rejected", "Meenakshi"), "Previous Credit Note attempt failed: Voucher rejected");
  assert.doesNotMatch(savedPostingFailure(null, "Meenakshi", "invalid"), /Invalid Date/);
});
