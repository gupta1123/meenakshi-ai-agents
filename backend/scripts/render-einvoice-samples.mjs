// Read-only: render sample Credit Notes in the Tally e-Invoice layout to a folder.
// 1. CN 301 rebuilt from Tally's print + the IRN / Ack / signed QR read from Tally.
// 2. CN 164, a real app-created Cash Discount Credit Note from the database.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { renderTallyEInvoiceNotePdf } from "../src/lib/notes/tally-einvoice-note-pdf.mjs";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const [outDir, tallyXml] = process.argv.slice(2);
const company = {
  name: "MEENAKSHI UDYOG (INDIA) PVT LTD",
  address: "S.F.NO.291&292, Kapakal Village, Uliveeranapalli (Via), Nagondapally Post, Krishnagiri ( Dist ), Tamil Nadu - 635 110",
  gstin: "33AADCM9365L1Z1", stateName: "Tamil Nadu", cin: "U27106TN2004PTCO53555", email: "meenakshiudyogindia@gmail.com",
};

// 1. CN 301: e-invoice fields exactly as Tally holds them.
const raw = readFileSync(tallyXml, "latin1");
const at = raw.indexOf("152624980976106");
const around = raw.slice(Math.max(0, at - 2000), at + 8000);
const pick = (tag) => (around.match(new RegExp(`<${tag} TYPE="[A-Za-z]+">([^<]*)</${tag}>`)) ?? [])[1] ?? "";
const cn301 = renderTallyEInvoiceNotePdf({
  kind: "credit", company,
  party: { name: "Shakti Agro Industries", address: "237/2A-2B, KALUKONDAPLLI VILLAGE, DENKANIKOOTAI TALUK, Krishnagiri, TamilNadu, 635114", gstin: "33AASFA3725G1ZJ", stateName: "Tamil Nadu" },
  voucherNumber: "301", voucherDate: "2026-03-09", originalInvoice: "Jan & Feb' 26 dt. 9-Mar-26",
  einvoice: { irn: pick("IRN"), ackNo: pick("IRNACKNO"), ackDate: `${pick("IRNACKDATE").slice(0, 4)}-${pick("IRNACKDATE").slice(4, 6)}-${pick("IRNACKDATE").slice(6, 8)}`, signedQr: pick("IRNQRCODE") },
  line: { label: "Discount Allowed", hsn: "1" },
  taxableValue: 1009458, taxes: [{ name: "SGST-9%", ratePercent: 9, amount: 90851.22 }, { name: "CGST - 9%", ratePercent: 9, amount: 90851.22 }],
  roundOff: -0.44, total: 1191160,
});
writeFileSync(`${outDir}/Sample CN 301 (Meenakshi layout) v2.pdf`, cn301.pdf);
console.log("CN 301 IRN", pick("IRN").slice(0, 16) + "…", "ack", pick("IRNACKNO"), "qr chars", pick("IRNQRCODE").length);

// 2. CN 164 from the database.
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data: note } = await db.from("cash_discount_debit_note_postings").select("verified_voucher_number, debit_note_date, verified_amount, debit_note_snapshot").eq("note_kind", "credit_note").eq("verified_voucher_number", "164").single();
const snap = note.debit_note_snapshot;
const { data: customer } = await db.from("customers").select("ledger_name, tax_identifier, source_payload").eq("tally_ledger_guid", snap.party.guid).maybeSingle();
const cd = snap.cashDiscount ?? {};
const gst = snap.gstNote;
const date = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return `${d}-${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]}-${String(y).slice(2)}`; };
const cn164 = renderTallyEInvoiceNotePdf({
  kind: "credit", company,
  party: { name: snap.party.name, address: [customer?.source_payload?.address, customer?.source_payload?.pinCode && !String(customer?.source_payload?.address ?? "").includes(customer.source_payload.pinCode) ? customer.source_payload.pinCode : null].filter(Boolean).join(", "), gstin: customer?.tax_identifier, stateName: customer?.source_payload?.stateName },
  voucherNumber: note.verified_voucher_number, voucherDate: note.debit_note_date,
  originalInvoice: `${snap.sourceInvoice?.number ?? ""}${cd.invoiceDate ? ` dt. ${date(cd.invoiceDate)}` : ""}`,
  einvoice: null,
  line: { label: "Discount Allowed", description: [`Cash discount: ${Number(cd.eligibleTonnes).toLocaleString("en-IN", { maximumFractionDigits: 3 })} MT @ Rs.${Number(cd.amountPerTonne)} per MT`, `Payment due by ${date(cd.windowDeadline)}`] },
  taxableValue: gst.taxableValue,
  taxes: gst.taxLines.map((tax) => ({ name: tax.name, ratePercent: Number((tax.name.match(/(\d+(?:\.\d+)?)\s*%/) ?? [])[1]), amount: tax.amount })),
  roundOff: gst.roundOff?.amount ?? 0, total: gst.total,
});
writeFileSync(`${outDir}/Sample CN 164 (Meenakshi layout) v2.pdf`, cn164.pdf);
console.log("CN 164 total", gst.total, "taxes", gst.taxLines.map((t) => `${t.name}=${t.amount}`).join(", "), "roundOff", gst.roundOff?.amount ?? 0);
