import { createHash } from "node:crypto";

// A reference copy, not Tally's print layout. Every value comes from an
// already verified posting and its immutable, approved accounting snapshot.
const MAX_LINES = 42;

function printable(value, label) {
  const text = String(value ?? "").normalize("NFKD")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u20b9/g, "INR ")
    .replace(/[\u0300-\u036f]/g, "");
  if (/[^\x20-\x7e]/.test(text)) {
    throw new Error(`${label} contains characters this PDF renderer cannot represent. Use a supported document renderer before sending it.`);
  }
  return text.trim();
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("The verified voucher amount is invalid.");
  return `INR ${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`;
}

function pdfEscape(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function wrap(value, max = 88) {
  const words = value.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (word.length > max) throw new Error("A voucher field is too long for the PDF layout.");
    if (line && `${line} ${word}`.length > max) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function objectPdf(content) {
  const stream = Buffer.from(content, "ascii");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"), stream, Buffer.from("\nendstream", "ascii")]),
  ];
  const parts = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`, "ascii"));
    parts.push(Buffer.isBuffer(objects[index]) ? objects[index] : Buffer.from(objects[index], "ascii"));
    parts.push(Buffer.from("\nendobj\n", "ascii"));
  }
  const xrefOffset = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, "ascii"));
  for (const offset of offsets.slice(1)) parts.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`, "ascii"));
  parts.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii"));
  return Buffer.concat(parts);
}

export function renderVerifiedVoucherPdf(input) {
  const kind = input.kind === "debit" ? "Debit Note" : input.kind === "credit" ? "Credit Note" : null;
  if (!kind) throw new Error("A verified note type is required.");
  const company = printable(input.companyName, "Company name");
  const customer = printable(input.customerName, "Customer name");
  const number = printable(input.voucherNumber, "Voucher number");
  const date = printable(input.voucherDate, "Voucher date");
  const guid = printable(input.voucherGuid, "Tally voucher identity");
  const reference = printable(input.reference, "Reference");
  const narration = printable(input.narration, "Narration");
  if (!company || !customer || !number || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !guid || !reference) {
    throw new Error("The verified Tally voucher is missing document identity fields.");
  }
  const amount = money(input.amount);
  const lines = [
    { text: company, bold: true, size: 16, gap: 29 },
    { text: `${kind} - verified Tally data`, bold: true, size: 18, gap: 38 },
    { text: `Voucher no.  ${number}`, bold: true },
    { text: `Voucher date  ${date}` },
    { text: `Customer  ${customer}`, gap: 28 },
    { text: `Amount  ${amount}`, bold: true, size: 15, gap: 33 },
    { text: "Accounting reference", bold: true, gap: 18 },
    ...wrap(reference).map((text) => ({ text })),
    { text: "Ledger entries", bold: true, gap: 25 },
  ];
  for (const ledger of input.ledgerLines ?? []) {
    const name = printable(ledger.name, "Ledger name");
    if (!name || !["Debit", "Credit"].includes(ledger.side)) throw new Error("Verified ledger evidence is incomplete.");
    lines.push(...wrap(`${ledger.side}: ${name} - ${money(ledger.amount)}`).map((text) => ({ text })));
  }
  lines.push({ text: "Tally voucher GUID", bold: true, gap: 27 });
  lines.push(...wrap(guid).map((text) => ({ text })));
  if (narration) {
    lines.push({ text: "Narration", bold: true, gap: 27 });
    lines.push(...wrap(narration).map((text) => ({ text })));
  }
  if (lines.length > MAX_LINES) throw new Error("The verified voucher has too many lines for a single-page PDF.");
  let y = 786;
  const commands = ["0.35 w", "48 741 m 547 741 l S", "48 83 m 547 83 l S"];
  for (const line of lines) {
    y -= line.gap ?? 20;
    if (y < 105) throw new Error("The verified voucher does not fit the PDF page.");
    commands.push(`BT /${line.bold ? "F2" : "F1"} ${line.size ?? 10} Tf 48 ${y} Td (${pdfEscape(line.text)}) Tj ET`);
  }
  commands.push("BT /F1 8 Tf 48 64 Td (System-generated reference copy from a verified Tally voucher.) Tj ET");
  commands.push("BT /F1 8 Tf 48 52 Td (This is not TallyPrime's native print layout or a signed document.) Tj ET");
  const pdf = objectPdf(commands.join("\n"));
  return { pdf, sha256Hex: createHash("sha256").update(pdf).digest("hex") };
}
