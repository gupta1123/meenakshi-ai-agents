import { createHash } from "node:crypto";
import QRCode from "qrcode";

import { amountInIndianWords, indianMoney, printable, textWidth, wrap } from "./tally-style-note-pdf.mjs";

// Credit / Debit Note in the layout TallyPrime prints for a GST voucher
// (checked against Tally's print of Credit Note 301): e-Invoice header with
// IRN, Ack No., Ack Date and the signed QR code; company, consignee and buyer
// blocks; the voucher details grid; Sl/Particulars/HSN/Qty/Rate/per/Amount;
// round off and total; amounts in words; the HSN tax summary; PAN and the
// signatory block. Values come from the verified Tally voucher.

const PAGE_W = 595;
const PAGE_H = 842;
const L = 40;
const R = 555;
const MID = 300; // left blocks | voucher details grid
const GRID_MID = 428;

function tallyShortDate(iso) {
  const [year, month, day] = String(iso).slice(0, 10).split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${day}-${names[month - 1]}-${String(year).slice(2)}`;
}

/** Tally-style words for a tax amount: "... Two and Forty Four paise Only". */
function taxWords(value) {
  return amountInIndianWords(value).replace(/ Paise Only$/, " paise Only");
}

function cleanAddress(value) {
  return printable(value).replace(/\s*,(\s*,)+/g, ",").replace(/,\s*$/, "");
}

function pdfDocument(content) {
  const stream = Buffer.from(content, "latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"), stream, Buffer.from("\nendstream", "ascii")]),
  ];
  const parts = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`, "ascii"));
    parts.push(Buffer.isBuffer(objects[index]) ? objects[index] : Buffer.from(objects[index], "ascii"));
    parts.push(Buffer.from("\nendobj\n", "ascii"));
  }
  const xrefOffset = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, "ascii"));
  for (const offset of offsets) parts.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`, "ascii"));
  parts.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii"));
  return Buffer.concat(parts);
}

/**
 * input: {
 *   kind: "credit" | "debit", title?,
 *   company: { name, address, gstin, stateName, cin?, email? },
 *   party: { name, address, gstin, stateName }            (printed as Consignee and Buyer)
 *   voucherNumber, voucherDate (ISO), originalInvoice?: string,
 *   einvoice?: { irn, ackNo, ackDate (ISO), signedQr } | null,
 *   line: { label, description?: string[], hsn? },
 *   taxableValue, taxes: [{ name, ratePercent, amount }], roundOff?, total
 * }
 */
export function renderTallyEInvoiceNotePdf(input) {
  const noteName = input.kind === "debit" ? "Debit Note" : input.kind === "credit" ? "Credit Note" : null;
  if (!noteName) throw new Error("A verified note type is required.");
  const total = Number(input.total);
  const taxable = Number(input.taxableValue);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(taxable) || taxable <= 0) throw new Error("The verified voucher amounts are invalid.");
  const companyName = printable(input.company?.name).replace(/\s*-\s*\(\d{4}\s*-\s*\d{4}\)\s*$/, "");
  const partyName = printable(input.party?.name);
  if (!companyName || !partyName || !printable(input.voucherNumber)) throw new Error("The verified Tally voucher is missing document identity fields.");

  const ops = ["0.5 w"];
  const font = { regular: "F1", bold: "F2", italic: "F3" };
  const text = (value, x, y, size = 8, style = "regular") => { const v = printable(value); if (v) ops.push(`BT /${font[style]} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${v.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj ET`); };
  const width = (value, size, style = "regular") => textWidth(printable(value), size, style === "bold");
  const right = (value, x, y, size = 8, style = "regular") => text(value, x - width(value, size, style), y, size, style);
  const centre = (value, x1, x2, y, size = 8, style = "regular") => text(value, (x1 + x2 - width(value, size, style)) / 2, y, size, style);
  const line = (x1, y1, x2, y2) => ops.push(`${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  const box = (x1, y1, x2, y2) => ops.push(`${x1.toFixed(2)} ${y2.toFixed(2)} ${(x2 - x1).toFixed(2)} ${(y1 - y2).toFixed(2)} re S`);
  // The rupee sign is not in the standard PDF fonts; draw it.
  const rupee = (x, y, s) => {
    ops.push("q 0.7 w");
    line(x, y + 0.72 * s, x + 0.56 * s, y + 0.72 * s);
    line(x, y + 0.52 * s, x + 0.56 * s, y + 0.52 * s);
    ops.push(`${x.toFixed(2)} ${(y + 0.72 * s).toFixed(2)} m ${(x + 0.46 * s).toFixed(2)} ${(y + 0.72 * s).toFixed(2)} ${(x + 0.46 * s).toFixed(2)} ${(y + 0.36 * s).toFixed(2)} ${x.toFixed(2)} ${(y + 0.36 * s).toFixed(2)} c S`);
    line(x, y + 0.36 * s, x + 0.44 * s, y);
    ops.push("Q");
  };

  const gstin = printable(input.company?.gstin);
  const stateCode = (value) => /^\d{2}/.test(printable(value)) ? printable(value).slice(0, 2) : null;
  const pan = gstin.length >= 12 ? gstin.slice(2, 12) : "";
  const einv = input.einvoice?.irn ? input.einvoice : null;

  // ---- Title and e-Invoice header ------------------------------------------
  let top = 812;
  centre(einv ? "Tax Invoice" : noteName, L, R, top, 11, "bold");
  if (einv) {
    const qr = QRCode.create(String(einv.signedQr ?? einv.irn), { errorCorrectionLevel: "L" });
    const size = qr.modules.size;
    const qrSide = 104;
    const cell = qrSide / size;
    const qx = R - qrSide;
    const qy = top - 14 - qrSide;
    centre("e-Invoice", qx, R, top, 8, "bold");
    const cells = [];
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (qr.modules.get(row, col)) cells.push(`${(qx + col * cell).toFixed(3)} ${(qy + qrSide - (row + 1) * cell).toFixed(3)} ${cell.toFixed(3)} ${cell.toFixed(3)} re`);
      }
    }
    ops.push(`q 0 g ${cells.join(" ")} f Q`);
    const irn = printable(einv.irn);
    const rows = [["IRN", [irn.slice(0, 44), irn.slice(44)].filter(Boolean)], ["Ack No.", [printable(einv.ackNo)]], ["Ack Date", [einv.ackDate ? tallyShortDate(einv.ackDate) : ""]]];
    let y = qy + 36;
    for (const [label, values] of rows) {
      text(label, L, y, 8);
      text(":", L + 50, y, 8);
      values.forEach((value, index) => text(value, L + 58, y - index * 10, 8, "bold"));
      y -= values.length * 10 + 1;
    }
    top = qy - 8;
  } else {
    top -= 14;
  }

  // ---- Company / consignee / buyer | voucher details grid ----------------------
  const leftWidth = MID - L - 28;
  const companyLines = [
    [companyName, "bold"],
    ...wrap(cleanAddress(input.company?.address), 8, leftWidth).map((value) => [value, "regular"]),
    ...(gstin ? [[`GSTIN/UIN: ${gstin}`, "regular"]] : []),
    ...(printable(input.company?.stateName) ? [[`State Name :  ${printable(input.company.stateName)}${stateCode(gstin) ? `, Code : ${stateCode(gstin)}` : ""}`, "regular"]] : []),
    ...(printable(input.company?.cin) ? [[`CIN: ${printable(input.company.cin)}`, "regular"]] : []),
    ...(printable(input.company?.email) ? [[`E-Mail : ${printable(input.company.email)}`, "regular"]] : []),
  ];
  const partyGstin = printable(input.party?.gstin);
  const partyLines = [
    [partyName, "bold"],
    ...wrap(cleanAddress(input.party?.address), 8, leftWidth).map((value) => [value, "regular"]),
    ...(partyGstin ? [[`GSTIN/UIN      : ${partyGstin}`, "regular"]] : []),
    ...(printable(input.party?.stateName) ? [[`State Name     : ${printable(input.party.stateName)}${stateCode(partyGstin) ? `, Code : ${stateCode(partyGstin)}` : ""}`, "regular"]] : []),
  ];
  const LINE = 10.5;
  const drawBlock = (lines, heading, yTop) => {
    let y = yTop - 11;
    if (heading) { text(heading, L + 4, y, 7.5); y -= LINE; }
    for (const [value, style] of lines) { text(value, L + 4, y, style === "bold" ? 8.5 : 8, style); y -= LINE; }
    return y + LINE - 6;
  };
  const mainTop = top;
  const companyBottom = drawBlock(companyLines, null, mainTop);
  line(L, companyBottom, MID, companyBottom);
  const consigneeBottom = drawBlock(partyLines, "Consignee (Ship to)", companyBottom);
  line(L, consigneeBottom, MID, consigneeBottom);
  const buyerBottom = drawBlock(partyLines, "Buyer (Bill to)", consigneeBottom);
  const gridRows = [
    [`${noteName} No.`, printable(input.voucherNumber), "Dated", tallyShortDate(input.voucherDate)],
    ["", "", "Mode/Terms of Payment", ""],
    ["Original Invoice No. & Date.", printable(input.originalInvoice ?? ""), "Other References", ""],
    ["Buyer's Order No.", "", "Dated", ""],
    ["Dispatch Doc No.", "", "", ""],
    ["Dispatched through", "", "Destination", ""],
  ];
  const ROW = 27;
  gridRows.forEach(([leftLabel, leftValue, rightLabel, rightValue], index) => {
    const rowTop = mainTop - index * ROW;
    if (leftLabel) text(leftLabel, MID + 4, rowTop - 10, 7.5);
    if (leftValue) text(leftValue, MID + 4, rowTop - 20, 8, "bold");
    if (rightLabel) text(rightLabel, GRID_MID + 4, rowTop - 10, 7.5);
    if (rightValue) text(rightValue, GRID_MID + 4, rowTop - 20, 8, "bold");
    line(MID, rowTop - ROW, R, rowTop - ROW);
  });
  const gridBottom = mainTop - gridRows.length * ROW;
  line(GRID_MID, mainTop, GRID_MID, gridBottom);
  text("Terms of Delivery", MID + 4, gridBottom - 10, 7.5);
  const mainBottom = Math.min(buyerBottom, gridBottom - 40);
  line(MID, mainTop, MID, mainBottom);

  // ---- Items table ------------------------------------------------------------
  const COLS = { sl: L, part: L + 20, hsn: 330, qty: 375, rate: 425, per: 462, amt: 482 };
  const itemsTop = mainBottom;
  const headerBottom = itemsTop - 22;
  text("Sl", COLS.sl + 3, itemsTop - 10, 7);
  text("No.", COLS.sl + 3, itemsTop - 18, 6);
  centre("Particulars", COLS.part, COLS.hsn, itemsTop - 13, 7.5);
  centre("HSN/SAC", COLS.hsn, COLS.qty, itemsTop - 13, 7.5);
  centre("Quantity", COLS.qty, COLS.rate, itemsTop - 13, 7.5);
  centre("Rate", COLS.rate, COLS.per, itemsTop - 13, 7.5);
  centre("per", COLS.per, COLS.amt, itemsTop - 13, 7.5);
  centre("Amount", COLS.amt, R, itemsTop - 13, 7.5);
  line(L, headerBottom, R, headerBottom);

  let y = headerBottom - 16;
  text("1", COLS.sl + 4, y, 8);
  text(input.line?.label ?? "Discount Allowed", COLS.part + 14, y, 9, "bold");
  if (printable(input.line?.hsn)) text(input.line.hsn, COLS.hsn + 3, y, 8);
  right(indianMoney(taxable), R - 4, y, 9, "bold");
  for (const description of (input.line?.description ?? []).flatMap((value) => wrap(value, 7.5, COLS.hsn - COLS.part - 20))) {
    y -= 10;
    text(description, COLS.part + 14, y, 7.5, "italic");
  }
  y -= 4;
  for (const tax of input.taxes ?? []) {
    y -= 12;
    right(printable(tax.name), COLS.hsn - 6, y, 8.5, "bold");
    if (Number.isFinite(Number(tax.ratePercent))) right(String(Number(tax.ratePercent)), COLS.per - 3, y, 8, "italic");
    text("%", COLS.per + 3, y, 8);
    right(indianMoney(Number(tax.amount)), R - 4, y, 9, "bold");
  }
  const roundOff = Number(input.roundOff ?? 0);
  if (roundOff) {
    y -= 16;
    text("Less :", COLS.part + 4, y, 8, "italic");
    text("Round Off", COLS.part + 30, y, 8.5, "bold");
    right(`${roundOff < 0 ? "(-)" : ""}${indianMoney(Math.abs(roundOff))}`, R - 4, y, 9, "bold");
  }
  const totalTop = Math.min(y - 30, headerBottom - 190);
  const totalBottom = totalTop - 16;
  line(L, totalTop, R, totalTop);
  right("Total", COLS.hsn - 6, totalTop - 11, 8.5);
  const totalText = indianMoney(total);
  right(totalText, R - 4, totalTop - 12, 10, "bold");
  rupee(R - 4 - width(totalText, 10, "bold") - 9, totalTop - 12, 9);
  line(L, totalBottom, R, totalBottom);
  for (const x of [COLS.part, COLS.hsn, COLS.qty, COLS.rate, COLS.per, COLS.amt]) line(x, itemsTop, x, totalBottom);

  // ---- Amount in words --------------------------------------------------------
  y = totalBottom - 10;
  text("Amount Chargeable (in words)", L + 4, y, 7);
  right("E. & O.E", R - 4, y, 7.5, "italic");
  y -= 11;
  for (const words of wrap(amountInIndianWords(total), 9, R - L - 10, true)) { text(words, L + 4, y, 9, "bold"); y -= 11; }
  const wordsBottom = y + 3;
  line(L, wordsBottom, R, wordsBottom);

  // ---- HSN / tax summary (GST notes only) ------------------------------------------
  const taxes = input.taxes ?? [];
  let y2 = wordsBottom;
  if (taxes.length) {
  const igst = taxes.filter((tax) => /igst/i.test(tax.name));
  const cgst = taxes.filter((tax) => /cgst/i.test(tax.name));
  const sgst = taxes.filter((tax) => /sgst|utgst/i.test(tax.name));
  const groups = igst.length ? [["IGST", igst]] : [["CGST", cgst], ["SGST/UTGST", sgst]];
  const sum = (list) => list.reduce((acc, tax) => acc + Number(tax.amount), 0);
  const totalTax = sum(taxes);
  const T = igst.length
    ? { hsn: L, taxable: 250, cols: [[330, 380, 455]], total: 455 }
    : { hsn: L, taxable: 232, cols: [[305, 335, 400], [400, 430, 495]], total: 495 };
  const taxTop = wordsBottom;
  centre("HSN/SAC", T.hsn, T.taxable, taxTop - 14, 7.5);
  centre("Taxable", T.taxable, T.cols[0][0], taxTop - 9, 7.5);
  centre("Value", T.taxable, T.cols[0][0], taxTop - 18, 7.5);
  groups.forEach(([name], index) => {
    const [start, mid, end] = T.cols[index];
    centre(name, start, end, taxTop - 9, 7.5);
    line(start, taxTop - 12, end, taxTop - 12);
    centre("Rate", start, mid, taxTop - 20, 7);
    centre("Amount", mid, end, taxTop - 20, 7);
  });
  centre("Total", T.total, R, taxTop - 9, 7.5);
  centre("Tax Amount", T.total, R, taxTop - 18, 7.5);
  const taxHeaderBottom = taxTop - 23;
  line(L, taxHeaderBottom, R, taxHeaderBottom);
  const rateOf = (list) => list.length ? `${Number(list[0].ratePercent)}%` : "";
  const valueRow = taxHeaderBottom - 10;
  text(printable(input.line?.hsn) || "", T.hsn + 4, valueRow, 8);
  right(indianMoney(taxable), T.cols[0][0] - 3, valueRow, 8);
  groups.forEach(([, list], index) => {
    const [start, mid, end] = T.cols[index];
    centre(rateOf(list), start, mid, valueRow, 8);
    right(indianMoney(sum(list)), end - 3, valueRow, 8);
  });
  right(indianMoney(totalTax), R - 3, valueRow, 8);
  const taxTotalTop = valueRow - 5;
  line(L, taxTotalTop, R, taxTotalTop);
  const totalRow = taxTotalTop - 10;
  right("Total", T.taxable - 4, totalRow, 8, "bold");
  right(indianMoney(taxable), T.cols[0][0] - 3, totalRow, 8, "bold");
  groups.forEach(([, list], index) => right(indianMoney(sum(list)), T.cols[index][2] - 3, totalRow, 8, "bold"));
  right(indianMoney(totalTax), R - 3, totalRow, 8, "bold");
  const taxBottom = totalRow - 5;
  line(L, taxBottom, R, taxBottom);
  for (const x of [T.taxable, ...T.cols.map(([start]) => start), T.total]) line(x, taxTop, x, taxBottom);
  // Rate | Amount dividers start under the group heading (CGST, SGST/UTGST).
  for (const [, mid] of T.cols) line(mid, taxTop - 12, mid, taxBottom);

  y = taxBottom - 14;
  text("Tax Amount (in words)  :", L + 4, y, 7.5);
  const taxWordLines = wrap(taxWords(totalTax), 9, R - L - 120, true);
  taxWordLines.forEach((words, index) => text(words, L + 100, y - index * 11, 9, "bold"));
  y2 = y - taxWordLines.length * 11 - 6;
  } else if (printable(input.note)) {
    // Commercial notes without GST say so, as before.
    y2 = wordsBottom - 12;
    for (const noteLine of wrap(input.note, 8, R - L - 10)) { text(noteLine, L + 4, y2, 8, "italic"); y2 -= 10; }
  }

  // ---- PAN, signatory -----------------------------------------------------------
  const signTop = y2;
  const signBottom = signTop - 46;
  line(MID + 30, signTop, R, signTop);
  line(MID + 30, signTop, MID + 30, signBottom);
  right(`for ${companyName}`, R - 4, signTop - 12, 8, "bold");
  right("Authorised Signatory", R - 4, signBottom + 6, 7.5);
  if (pan) { text("Company's PAN", L + 4, signBottom + 6, 7.5); text(`:  ${pan}`, L + 110, signBottom + 6, 8, "bold"); }
  box(L, mainTop, R, signBottom);
  centre("This is a Computer Generated Document", L, R, signBottom - 14, 7.5);
  if (signBottom - 14 < 20) throw new Error("The note does not fit on one page.");

  const pdf = pdfDocument(ops.join("\n"));
  return { pdf, sha256Hex: createHash("sha256").update(pdf).digest("hex") };
}
