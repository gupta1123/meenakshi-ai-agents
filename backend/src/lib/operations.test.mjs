import assert from "node:assert/strict";
import test from "node:test";
import { buildOperationsAlerts, safeOperationalText } from "./operations.ts";
import { readLaunchControlChange, toLaunchControlResponse } from "./launch-control.ts";
import { toSafeCreditNoteDocument } from "./credit-note-documents.ts";

test("posting launch control requires complete Finance reconciliation metadata", () => {
  assert.throws(() => readLaunchControlChange({ mode: "posting_enabled" }), /reconciliationPeriodFrom/);
  assert.throws(() => readLaunchControlChange({ mode: "posting_enabled", reconciliationPeriodFrom: "2026-08-31", reconciliationPeriodTo: "2026-08-01", reconciliationReference: "FIN-1" }), /must not be before/);
  assert.equal(readLaunchControlChange({ mode: "review_only" }).mode, "review_only");
});

test("missing launch-control row remains safely review-only", () => {
  assert.equal(toLaunchControlResponse("00000000-0000-4000-8000-000000000001", null).mode, "review_only");
});

test("operational text never returns raw Tally XML or credentials", () => {
  assert.match(safeOperationalText("<ENVELOPE><BODY>private</BODY></ENVELOPE>"), /redacted/i);
  assert.match(safeOperationalText("<VOUCHER><LEDGER>private</LEDGER></VOUCHER>"), /redacted/i);
  assert.doesNotMatch(safeOperationalText("Authorization: secret-token") ?? "", /secret-token/);
  assert.doesNotMatch(safeOperationalText("authkey=provider-secret") ?? "", /provider-secret/);
});

test("verified document DTO never exposes a storage path and only returns a configured URL", () => {
  const previous = process.env.MEENAKSHI_CREDIT_NOTE_DOCUMENT_URL_BASE;
  process.env.MEENAKSHI_CREDIT_NOTE_DOCUMENT_URL_BASE = "https://documents.example.test/verified";
  try {
    const document = toSafeCreditNoteDocument({ id: "file-1", status: "verified", storage_path: "company/CN 01.pdf", mime_type: "application/pdf", file_size_bytes: 42, attached_at: null, verified_at: "2026-08-07T00:00:00.000Z", failure_reason: null }, true);
    assert.equal(document.storage_path, undefined);
    assert.equal(document.downloadUrl, "https://documents.example.test/verified/company/CN%2001.pdf");
    assert.equal(toSafeCreditNoteDocument({ id: "file-2", status: "verified", storage_path: "../unsafe.pdf", mime_type: null, file_size_bytes: null, attached_at: null, verified_at: null, failure_reason: null }, true).available, false);
  } finally {
    if (previous === undefined) delete process.env.MEENAKSHI_CREDIT_NOTE_DOCUMENT_URL_BASE;
    else process.env.MEENAKSHI_CREDIT_NOTE_DOCUMENT_URL_BASE = previous;
  }
});

test("health alerts include stale, dead-letter, and review-only actions", () => {
  const alerts = buildOperationsAlerts({ now: "2026-08-06T00:00:00.000Z", tally: { status: "bridge_stale" }, outbox: { failed: 0, deadLetter: 1 }, commands: { failed: 0, deadLetter: 0 }, messages: { retrying: 0, terminalFailures: 0 }, missingConfiguration: ["an active CD or TOD rule version"], staleProposalCount: 1, launchMode: "review_only" });
  assert.deepEqual(alerts.map((alert) => alert.id), ["tally-bridge_stale", "dead-letter-work", "review-invalidated-proposals", "missing-configuration", "review-only"]);
});
