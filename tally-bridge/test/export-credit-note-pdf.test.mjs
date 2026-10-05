import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { expectedCreditNotePdfFilename, readNativeCreditNotePdf } from "../src/commands/export-credit-note-pdf.mjs";

test("Credit Note PDF capture uses the exact verified Tally GUID as its filename", () => {
  assert.equal(
    expectedCreditNotePdfFilename("A40939E2-530A-4D85-8F83-33C8BBD5F932-00000020"),
    "a40939e2-530a-4d85-8f83-33c8bbd5f932-00000020.pdf",
  );
  assert.throws(() => expectedCreditNotePdfFilename("../invoice.pdf"), /safe Credit Note identity/);
});

test("Credit Note PDF capture rejects non-native or malformed files", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "meenakshi-pdf-"));
  const validPath = path.join(directory, "valid.pdf");
  const invalidPath = path.join(directory, "invalid.pdf");
  writeFileSync(validPath, "%PDF-1.7\nTally native PDF test\n");
  writeFileSync(invalidPath, "not a PDF");
  assert.equal(readNativeCreditNotePdf(validPath)?.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.throws(() => readNativeCreditNotePdf(invalidPath), /not a valid PDF/);
});
