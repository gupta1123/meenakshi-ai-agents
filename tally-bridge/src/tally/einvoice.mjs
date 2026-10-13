// Collection names must be plain words: Tally rejects a hyphen ("e-Invoice")
// with "Could not find description" and blocks on an error dialog.
// e-Invoice details (IRN, Ack No., Ack Date, signed QR) of one Credit or Debit
// Note, for printing on its PDF. Tally holds them once the note is e-invoiced.
//
// The request reads one company for ONE day with a short field list: the same
// bounded read the connector makes after creating a note (about 0.3-1.2 s on
// the MUIPL books). Never widen it: an unbounded voucher scan hangs Tally.
import { buildCollectionExportXml, postTallyXml } from "./xml.mjs";

const FIELDS = ["Date,VoucherTypeName,VoucherNumber,GUID,IRN,IRNAckNo,IRNAckDate,IRNQRCode,IRNCancelled"];

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() : "";
}

/**
 * @param {{ tallyUrl: string, companyName: string, date: string (YYYY-MM-DD), voucherNumber: string, kind: "credit" | "debit" }} input
 * @returns {Promise<{ irn, ackNo, ackDate, signedQr } | null>} null when the note is not e-invoiced (or is cancelled).
 */
export async function readNoteEInvoice({ tallyUrl, companyName, date, voucherNumber, kind }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error("A single note date is required.");
  if (!String(voucherNumber ?? "").trim()) throw new Error("The note number is required.");
  const xml = buildCollectionExportXml({
    collectionName: "Meenakshi Note EInvoice Readback", tallyType: "Voucher", fetchFields: FIELDS,
    companyName, dateFrom: date, dateTo: date,
  });
  const response = await postTallyXml(tallyUrl, xml, { timeoutMs: 30_000, operation: "Read the note e-Invoice" });
  const typeWord = kind === "debit" ? "debit" : "credit";
  const blocks = String(response).match(/<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/gi) ?? [];
  const voucher = blocks.find((block) => tag(block, "VOUCHERNUMBER") === String(voucherNumber).trim()
    && tag(block, "VOUCHERTYPENAME").toLowerCase().includes(typeWord));
  if (!voucher) return null;
  const irn = tag(voucher, "IRN").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(irn) || /^yes$/i.test(tag(voucher, "IRNCANCELLED"))) return null;
  const ackDate = tag(voucher, "IRNACKDATE");
  return {
    irn,
    ackNo: tag(voucher, "IRNACKNO"),
    ackDate: /^\d{8}$/.test(ackDate) ? `${ackDate.slice(0, 4)}-${ackDate.slice(4, 6)}-${ackDate.slice(6, 8)}` : null,
    signedQr: tag(voucher, "IRNQRCODE"),
  };
}
