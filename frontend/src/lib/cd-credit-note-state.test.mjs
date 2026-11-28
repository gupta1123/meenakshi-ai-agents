import test from "node:test";
import assert from "node:assert/strict";
import { canCreateCashDiscountNote, supportsCdSettlementChecks } from "./cd-credit-note-state.mjs";
const row = { status: "ready", creditAmount: "5000", gstDeadlinePassed: false };
const candidate = { status: "action_required" };
test("old checks and recognized or unresolved Credit Notes cannot expose Create", () => {
  assert.equal(canCreateCashDiscountNote(row, candidate, null, false), true);
  assert.equal(canCreateCashDiscountNote(row, candidate, null, true), false);
  assert.equal(canCreateCashDiscountNote({ ...row, status: "credited" }, candidate, null, false), false);
  assert.equal(canCreateCashDiscountNote({ ...row, status: "credit_note_review" }, candidate, null, false), false);
  assert.equal(canCreateCashDiscountNote({ ...row, creditNoteReviewRequired: true }, candidate, null, false), false);
  assert.equal(canCreateCashDiscountNote(row, candidate, { status: "created_verified" }, false), false);
});
test("genuine short-payment review remains creatable, but expired or unbacked rows do not", () => {
  assert.equal(canCreateCashDiscountNote({ ...row, status: "review" }, { status: "review_required" }, null, false), true);
  assert.equal(canCreateCashDiscountNote({ ...row, gstDeadlinePassed: true }, candidate, null, false), false);
  assert.equal(canCreateCashDiscountNote(row, null, null, false), false);
});
test("per-MT CD requires the updated connector, with correct version ordering", () => {
  for (const version of [null, "0.5.3", "0.4.9", "invalid", "0.7.4-preview", "0.7.3"]) assert.equal(supportsCdSettlementChecks(version), false);
  for (const version of ["0.7.4", "0.7.5", "0.8.0", "1.0.0"]) assert.equal(supportsCdSettlementChecks(version), true);
});
