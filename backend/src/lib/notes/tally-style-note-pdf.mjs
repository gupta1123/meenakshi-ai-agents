import { createHash } from "node:crypto";

// Customer-facing Credit / Debit Note in the classic Tally voucher print
// layout (same structure as Kalika's Debit Note): centred company, title,
// No./Dated/Ref, Party's Name, Particulars | Amount table, amount in words,
// Total, and the "for <company> / Authorised Signatory" block. Every value
// comes from a Tally-verified posting and the Tally masters.

const PAGE_W = 595;
const LEFT = 48;
const RIGHT = 547;
const AMOUNT_COL = 420;

// Helvetica advance widths (1/1000 em) for the characters we print; others use 556.
const WIDTHS = { " ": 278, ",": 278, ".": 278, "-": 333, "/": 278, ":": 278, "(": 333, ")": 333, "'": 191, "&": 667, "@": 1015, "#": 556, "i": 222, "l": 222, "j": 222, "t": 278, "f": 278, "r": 333, "I": 278, "J": 500, "m": 833, "w": 722, "M": 833, "W": 944, "A": 667, "B": 667, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778, "H": 722, "K": 667, "L": 556, "N": 722, "O": 778, "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611, "U": 722, "V": 667, "X": 667, "Y": 667, "Z": 611, "s": 500, "c": 500, "k": 500, "v": 500, "x": 500, "y": 500, "z": 500 };
function textWidth(text, size, bold = false) {
  let units = 0;
  for (const char of text) units += WIDTHS[char] ?? 556;
  return (units * size * (bold ? 1.04 : 1)) / 1000;
}

function printable(value) {
  // Unfilled template values ("<33XXXXXXXXXXXXX>") are treated as missing, so they are left off.
  if (/^\s*<[^>]*>\s*$/.test(String(value ?? ""))) return "";
  return String(value ?? "").normalize("NFKD")
    .replace(/[‐-―]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/₹/g, "Rs. ").replace(/×/g, "x").replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
}
function escape(value) { return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"); }

function wrap(value, size, maxWidth, bold = false) {
  const lines = [];
  let line = "";
  for (const word of printable(value).split(" ").filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size, bold) > maxWidth) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export function indianMoney(value) {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function belowHundred(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`; }
function belowThousand(n) { return n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${belowHundred(n % 100)}` : ""}` : belowHundred(n); }
function indianWords(n) {
  const parts = [];
  for (const [size, name] of [[10_000_000, "Crore"], [100_000, "Lakh"], [1_000, "Thousand"]]) {
    if (n >= size) { parts.push(`${n >= size * 100 && name === "Crore" ? indianWords(Math.floor(n / size)) : belowThousand(Math.floor(n / size))} ${name}`); n %= size; }
  }
  if (n) parts.push(belowThousand(n));
  return parts.join(" ");
}
export function amountInIndianWords(value) {
  const paise = Math.round(value * 100);
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return `Indian Rupees ${indianWords(rupees) || "Zero"}${rest ? ` and ${belowHundred(rest)} Paise` : ""} Only`;
}

function tallyDate(iso) {
  const [year, month, day] = String(iso).slice(0, 10).split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(day).padStart(2, "0")}-${names[month - 1]}-${year}`;
}
export { tallyDate };

function objectPdf(content) {
  const stream = Buffer.from(content, "ascii");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
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
 * input: { kind: "credit" | "debit", company: { name, address?, gstin?, state? },
 *   party: { name, address?, gstin?, state? }, voucherNumber, voucherDate (ISO),
 *   reference?, particulars: string[], amount: number, gstNote?: string }
 */
export function renderTallyStyleNotePdf(input) {
  const title = input.kind === "debit" ? "DEBIT NOTE" : input.kind === "credit" ? "CREDIT NOTE" : null;
  if (!title) throw new Error("A verified note type is required.");
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("The verified voucher amount is invalid.");
  // Tally company names carry the books' year, e.g. "… LTD - (2025-2026)"; the document uses the legal name.
  const companyName = printable(input.company?.name).replace(/\s*-\s*\(\d{4}\s*-\s*\d{4}\)\s*$/, "");
  const partyName = printable(input.party?.name);
  const number = printable(input.voucherNumber);
  if (!companyName || !partyName || !number || !/^\d{4}-\d{2}-\d{2}/.test(String(input.voucherDate))) {
    throw new Error("The verified Tally voucher is missing document identity fields.");
  }

  const ops = ["0.6 w"];
  const text = (value, x, y, size = 10, bold = false) => ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escape(value)}) Tj ET`);
  const centre = (value, y, size, bold) => text(value, (PAGE_W - textWidth(value, size, bold)) / 2, y, size, bold);
  const right = (value, x, y, size, bold) => text(value, x - textWidth(value, size, bold), y, size, bold);
  const hline = (y, x1 = LEFT, x2 = RIGHT) => ops.push(`${x1} ${y} m ${x2} ${y} l S`);

  let y = 790;
  centre(companyName, y, 15, true);
  for (const line of wrap(input.company?.address ?? "", 9, 440)) { y -= 13; centre(line, y, 9); }
  const companyTax = [printable(input.company?.gstin) && `GSTIN/UIN: ${printable(input.company.gstin)}`, printable(input.company?.state) && `State: ${printable(input.company.state)}`].filter(Boolean).join("   ");
  if (companyTax) { y -= 13; centre(companyTax, y, 9); }
  y -= 26; centre(title, y, 14, true);
  y -= 10; hline(y);

  y -= 22;
  text("No.", LEFT, y, 10); text(number, LEFT + 42, y, 10, true);
  right(tallyDate(input.voucherDate), RIGHT, y, 10, true); right("Dated  ", RIGHT - textWidth(tallyDate(input.voucherDate), 10, true), y, 10);
  if (input.reference) { y -= 16; text("Ref.", LEFT, y, 10); text(printable(input.reference), LEFT + 42, y, 10, true); }

  y -= 26; text("Party's Name :", LEFT, y, 10);
  text(partyName, LEFT + 78, y, 11, true);
  for (const line of wrap(input.party?.address ?? "", 9.5, 400)) { y -= 13; text(line, LEFT + 78, y, 9.5); }
  const partyTax = [printable(input.party?.gstin) && `GSTIN/UIN: ${printable(input.party.gstin)}`, printable(input.party?.state) && `State: ${printable(input.party.state)}`].filter(Boolean).join("   ");
  if (partyTax) { y -= 13; text(partyTax, LEFT + 78, y, 9.5); }

  // Particulars | Amount table.
  y -= 22; const tableTop = y;
  hline(tableTop);
  text("Particulars", LEFT + 6, tableTop - 15, 10, true);
  right("Amount", RIGHT - 6, tableTop - 15, 10, true);
  hline(tableTop - 22);
  y = tableTop - 42;
  const particulars = (input.particulars ?? []).flatMap((line) => wrap(line, 10, AMOUNT_COL - LEFT - 18));
  // GST notes: the first amount is the taxable value; tax and round-off rows follow.
  const amountRows = Array.isArray(input.amountRows) ? input.amountRows : [];
  const firstAmount = amountRows.length ? Number(input.taxableValue) : amount;
  right(`Rs. ${indianMoney(firstAmount)}`, RIGHT - 6, y, 10, true);
  particulars.forEach((line, index) => text(line, LEFT + 8, y - index * 15, 10, index === 0));
  y -= Math.max(particulars.length, 1) * 15 + 8;
  for (const row of amountRows) {
    y -= 15;
    right(printable(row.label), AMOUNT_COL - 12, y, 10);
    right(`${Number(row.amount) < 0 ? "(-) " : ""}Rs. ${indianMoney(Math.abs(Number(row.amount)))}`, RIGHT - 6, y, 10);
  }
  y -= Math.max(142 - amountRows.length * 15, 40);
  text("Amount (in words) :", LEFT + 8, y, 9);
  for (const line of wrap(amountInIndianWords(amount), 10, AMOUNT_COL - LEFT - 18, true)) { y -= 14; text(line, LEFT + 8, y, 10, true); }
  y -= 14; const totalTop = y;
  hline(totalTop);
  text("Total", LEFT + 8, totalTop - 15, 10, true);
  right(`Rs. ${indianMoney(amount)}`, RIGHT - 6, totalTop - 15, 10, true);
  const tableBottom = totalTop - 22;
  hline(tableBottom);
  ops.push(`${AMOUNT_COL} ${tableTop} m ${AMOUNT_COL} ${tableBottom} l S`);
  ops.push(`${LEFT} ${tableTop} m ${LEFT} ${tableBottom} l S`, `${RIGHT} ${tableTop} m ${RIGHT} ${tableBottom} l S`);

  y = tableBottom - 18;
  if (input.gstNote) for (const line of wrap(input.gstNote, 8.5, RIGHT - LEFT)) { text(line, LEFT, y, 8.5); y -= 12; }

  const forLine = `for ${companyName}`;
  right(forLine, RIGHT, Math.min(y - 20, 170), 10, true);
  right("Authorised Signatory", RIGHT, Math.min(y - 20, 170) - 60, 10);
  if (Math.min(y - 20, 170) - 60 < 40) throw new Error("The note does not fit on one page.");

  const pdf = objectPdf(ops.join("\n"));
  return { pdf, sha256Hex: createHash("sha256").update(pdf).digest("hex") };
}

// Shared with the Tax Invoice-style note layout.
export { textWidth, printable, escape as pdfEscape, wrap, objectPdf };
