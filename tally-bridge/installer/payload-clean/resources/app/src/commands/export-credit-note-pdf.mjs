import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { uploadCreditNotePdf } from "../api-client.mjs";
import { getPdfExportDirectory } from "../config.mjs";
import { findCreditNote } from "../tally/credit-notes.mjs";

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export function expectedCreditNotePdfFilename(tallyGuid) {
  const value = String(tallyGuid || "").trim().toLowerCase();
  if (!/^[0-9a-f-]{16,128}$/.test(value)) throw new Error("Tally did not provide a safe Credit Note identity for PDF export.");
  return `${value}.pdf`;
}

export function readNativeCreditNotePdf(filePath) {
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size < 5 || stat.size > MAX_PDF_BYTES) {
    throw new Error("The Tally PDF export is not a supported file size.");
  }
  const pdf = readFileSync(filePath);
  if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("The captured Tally export is not a valid PDF file.");
  }
  return pdf;
}

export async function exportCreditNotePdf(command, { config }) {
  const creditNote = command.payload?.creditNote;
  const postingId = command.payload?.creditNotePostingId;
  if (!command.id || !postingId || !creditNote) throw new Error("Credit Note PDF export is missing its protected command identity.");

  // Tally Prime's HTTP/XML endpoint reliably provides the verification data,
  // but on this Prime transport it does not produce a valid PDF byte stream.
  // The native Alt+E PDF output remains the source document.  We accept only
  // a deterministic local filename after an independent live voucher lookup.
  const voucher = await findCreditNote(creditNote, config);
  if (!voucher?.guid) throw new Error("The verified Tally Credit Note could not be found before PDF capture.");
  const filename = expectedCreditNotePdfFilename(voucher.guid);
  const exportDirectory = getPdfExportDirectory(config);
  const filePath = path.join(exportDirectory, filename);
  const pdf = readNativeCreditNotePdf(filePath);
  if (!pdf) {
    throw new Error(`Native PDF export is ready for capture. In Tally Prime, export verified Credit Note ${voucher.voucherNumber ?? voucher.guid} as PDF to ${filePath}, then request the PDF again.`);
  }

  const uploaded = await uploadCreditNotePdf(config, command.id, { pdf, tallyGuid: voucher.guid, attempt: command.attempt });
  const sha256Hex = createHash("sha256").update(pdf).digest("hex");
  if (uploaded.sha256Hex !== sha256Hex || uploaded.fileSizeBytes !== pdf.length || !uploaded.storagePath) {
    throw new Error("The document service did not confirm the exact native Tally PDF bytes.");
  }
  return {
    storagePath: uploaded.storagePath,
    sha256Hex,
    fileSizeBytes: pdf.length,
    tallyGuid: voucher.guid,
    masterId: voucher.masterId || null,
  };
}
