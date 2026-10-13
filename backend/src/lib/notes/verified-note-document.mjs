import { indianMoney, tallyDate } from "./tally-style-note-pdf.mjs";
import { renderTallyEInvoiceNotePdf } from "./tally-einvoice-note-pdf.mjs";

export const NOTE_DOCUMENTS_BUCKET = "meenakshi-credit-note-documents";
// Bump when the customer-facing layout changes so older copies are re-rendered on resend.
// "tally-einv-v1": TallyPrime e-Invoice layout (Credit Note 301 print).
const LAYOUT = "tally-einv-v1";
const GST_NOTE = {
  credit: "Commercial credit note. GST is not adjusted; the original tax invoices remain unchanged.",
  debit: "Commercial debit note. GST is not adjusted; the original tax invoice remains unchanged.",
};

async function companyDetails(supabase, companyId, fallbackName) {
  const full = await supabase.from("companies").select("tally_company_name,document_address,document_gstin,document_state,document_cin,document_email").eq("id", companyId).maybeSingle();
  // CIN / e-mail columns come with 20260927180000; before it, print without them.
  const { data, error } = full.error ? await supabase.from("companies").select("tally_company_name,document_address,document_gstin,document_state").eq("id", companyId).maybeSingle() : full;
  if (error) return { name: fallbackName };
  return { name: data?.tally_company_name ?? fallbackName, address: data?.document_address, gstin: data?.document_gstin, stateName: data?.document_state, cin: data?.document_cin, email: data?.document_email };
}

/** IRN, Ack No., Ack Date and signed QR read from Tally, once the note is e-invoiced. */
async function einvoiceFor(supabase, source, postingId) {
  const { data, error } = await supabase.from("note_einvoices").select("irn,ack_no,ack_date,signed_qr").eq("note_source", source).eq("posting_id", postingId).maybeSingle();
  if (error || !data) return null;
  return { irn: data.irn, ackNo: data.ack_no, ackDate: data.ack_date, signedQr: data.signed_qr };
}

/** Tax lines of a GST note as the renderer needs them (rate from the ledger name, e.g. "SGST-9%"). */
function gstParts(gst) {
  if (!gst) return null;
  return {
    taxableValue: Number(gst.taxableValue),
    taxes: gst.taxLines.map((line) => ({ name: line.name.replace(/\s+/g, " "), ratePercent: Number((String(line.name).match(/(\d+(?:\.\d+)?)\s*%/) ?? [])[1]), amount: Number(line.amount) })),
    roundOff: Number(gst.roundOff?.amount ?? 0),
    total: Number(gst.total),
  };
}

function shortDate(iso) {
  const [year, month, day] = String(iso).slice(0, 10).split("-").map(Number);
  return `${day}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1]}-${String(year).slice(2)}`;
}

async function partyDetails(supabase, companyId, customerId, ledgerGuid, fallbackName) {
  let query = supabase.from("customers").select("ledger_name,tax_identifier,source_payload").eq("company_id", companyId);
  query = customerId ? query.eq("id", customerId) : query.eq("tally_ledger_guid", ledgerGuid);
  const { data } = await query.maybeSingle();
  const payload = data?.source_payload ?? {};
  const address = [payload.address, payload.pinCode && !String(payload.address ?? "").includes(payload.pinCode) ? payload.pinCode : null].filter(Boolean).join(", ");
  return { name: fallbackName ?? data?.ledger_name, address, gstin: data?.tax_identifier, stateName: payload.stateName };
}

function required(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Verified voucher is missing ${label}.`);
  return text;
}

function amount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("Verified voucher amount is invalid.");
  return number;
}

async function putPdf(supabase, path, pdf) {
  const { error } = await supabase.storage.from(NOTE_DOCUMENTS_BUCKET).upload(path, pdf, {
    contentType: "application/pdf", cacheControl: "3600", upsert: false,
  });
  if (error && !["409", "Duplicate"].includes(String(error.statusCode ?? error.error ?? "")) && !/already exists|duplicate/i.test(error.message ?? "")) throw error;
}

export async function prepareCreditNoteDocument(supabase, companyId, postingId) {
  const { data: posting, error: postingError } = await supabase.from("credit_note_postings")
    .select("id,company_id,customer_id,proposal_id,proposal_evaluation_id,status,credit_note_date,credit_note_snapshot,verified_tally_guid,verified_voucher_number,verified_amount,verified_at")
    .eq("id", postingId).eq("company_id", companyId).maybeSingle();
  if (postingError) throw postingError;
  if (!posting) throw new Error("Credit Note was not found.");
  if (posting.status !== "created_verified" || !posting.verified_at) throw new Error("Credit Note has not been verified in Tally.");
  const { data: existing, error: documentError } = await supabase.from("credit_note_documents")
    .select("id,status,storage_path,tally_voucher_guid").eq("credit_note_posting_id", postingId)
    .eq("document_kind", "credit_note_pdf").maybeSingle();
  if (documentError) throw documentError;
  const einvoice = await einvoiceFor(supabase, "tod_credit_note", postingId);
  // A copy made before the e-invoice was read is redrawn once it exists.
  const layoutKey = einvoice ? `${LAYOUT}-irn${einvoice.irn.slice(0, 12)}` : LAYOUT;
  if (existing?.status === "verified" && existing.storage_path?.includes(`/${layoutKey}-`) && existing.tally_voucher_guid === posting.verified_tally_guid) return existing;
  const snapshot = posting.credit_note_snapshot ?? {};
  const tally = snapshot.tallyPosting ?? {};
  const total = amount(posting.verified_amount);
  const partyName = required(tally.party?.name ?? snapshot.customer?.ledgerName, "customer name");
  // Particulars in plain words: the period and, for TOD, tonnes x rate.
  const { data: proposal } = await supabase.from("discount_proposals").select("scheme_type,period_start,period_end,eligible_tonnes").eq("id", posting.proposal_id).maybeSingle();
  const { data: evaluation } = posting.proposal_evaluation_id
    ? await supabase.from("proposal_evaluations").select("formula_snapshot").eq("id", posting.proposal_evaluation_id).maybeSingle()
    : { data: null };
  const rate = Number(evaluation?.formula_snapshot?.achievedTierRatePerMt);
  const tonnes = Number(proposal?.eligible_tonnes);
  const period = proposal?.period_start && proposal?.period_end ? `${tallyDate(proposal.period_start)} to ${tallyDate(proposal.period_end)}` : null;
  const description = proposal?.scheme_type === "tod"
    ? [`Turnover discount${period ? ` for ${period}` : ""}`, ...(tonnes > 0 && rate > 0 ? [`Eligible quantity ${tonnes.toFixed(2)} MT @ Rs. ${indianMoney(rate)} per MT`] : [])]
    : ["Cash discount"];
  // GST credit notes: taxable value, GST lines, round off, total.
  const gst = gstParts(tally.gstNote);
  const { pdf, sha256Hex } = renderTallyEInvoiceNotePdf({
    kind: "credit",
    company: await companyDetails(supabase, companyId, required(tally.company?.name, "company name")),
    party: await partyDetails(supabase, companyId, posting.customer_id, tally.party?.guid, partyName),
    voucherNumber: required(posting.verified_voucher_number, "voucher number"),
    voucherDate: required(posting.credit_note_date, "voucher date"),
    originalInvoice: period ? `${shortDate(proposal.period_start)} to ${shortDate(proposal.period_end)}` : null,
    einvoice,
    line: { label: "Discount Allowed", description },
    ...(gst ?? { taxableValue: total, taxes: [], roundOff: 0, total, note: GST_NOTE.credit }),
  });
  const path = `${companyId}/credit-notes/${postingId}/${layoutKey}-${sha256Hex}.pdf`;
  await putPdf(supabase, path, pdf);
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("credit_note_documents").upsert({
    credit_note_posting_id: postingId, company_id: companyId, document_kind: "credit_note_pdf",
    status: "verified", storage_path: path, sha256_hex: sha256Hex, mime_type: "application/pdf",
    file_size_bytes: pdf.length, tally_voucher_guid: posting.verified_tally_guid,
    attached_at: now, verified_at: now, failure_reason: null,
  }, { onConflict: "credit_note_posting_id,document_kind" }).select("id,status,storage_path").single();
  if (error) throw error;
  return data;
}

export async function prepareDebitNoteDocument(supabase, companyId, postingId) {
  const { data: posting, error } = await supabase.from("cash_discount_debit_note_postings")
    .select("id,company_id,candidate_id,status,debit_note_date,debit_note_snapshot,verified_tally_guid,verified_voucher_number,verified_amount,verified_at")
    .eq("id", postingId).eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  if (!posting) throw new Error("Debit Note was not found.");
  if (posting.status !== "created_verified" || !posting.verified_at) throw new Error("Debit Note has not been verified in Tally.");
  const snapshot = posting.debit_note_snapshot ?? {};
  // Tally rounds the voucher to paise; print what Tally holds.
  const total = Math.round(amount(posting.verified_amount) * 100) / 100;
  const party = required(snapshot.party?.name, "customer ledger");
  // Per-MT Cash Discount Credit Notes share this table (note_kind = credit_note).
  const isCreditNote = snapshot.noteKind === "credit_note";
  const { data: candidate } = posting.candidate_id
    ? await supabase.from("cash_discount_recovery_candidates").select(isCreditNote ? "invoice_number,invoice_date,missed_window_deadline,eligible_tonnes,amount_per_tonne" : "invoice_number,invoice_date,granted_discount_percentage,missed_window_deadline").eq("id", posting.candidate_id).maybeSingle()
    : { data: null };
  const invoiceNumber = candidate?.invoice_number ?? snapshot.sourceInvoice?.number;
  const percentage = Number(candidate?.granted_discount_percentage);
  const tonnes = Number(candidate?.eligible_tonnes);
  const rate = Number(candidate?.amount_per_tonne);
  const description = isCreditNote ? [
    ...(Number.isFinite(tonnes) && Number.isFinite(rate) ? [`Cash discount: ${tonnes.toLocaleString("en-IN", { maximumFractionDigits: 3 })} MT @ Rs.${rate.toLocaleString("en-IN")} per MT`] : ["Cash discount"]),
    ...(candidate?.missed_window_deadline ? [`Payment due by ${shortDate(candidate.missed_window_deadline)}`] : []),
  ] : [
    `Cash discount${percentage > 0 ? ` of ${percentage}%` : ""} recovered`,
    ...(candidate?.missed_window_deadline ? [`Invoice was not paid in full by ${shortDate(candidate.missed_window_deadline)}`] : []),
  ];
  const gst = gstParts(snapshot.gstNote);
  const { pdf, sha256Hex } = renderTallyEInvoiceNotePdf({
    kind: isCreditNote ? "credit" : "debit",
    company: await companyDetails(supabase, companyId, required(snapshot.company?.name, "company name")),
    party: await partyDetails(supabase, companyId, null, snapshot.party?.guid, party),
    voucherNumber: required(posting.verified_voucher_number, "voucher number"),
    voucherDate: required(posting.debit_note_date, "voucher date"),
    originalInvoice: invoiceNumber ? `${invoiceNumber}${candidate?.invoice_date ? ` dt. ${shortDate(candidate.invoice_date)}` : ""}` : null,
    einvoice: await einvoiceFor(supabase, "cash_discount_note", postingId),
    line: { label: isCreditNote ? "Discount Allowed" : "Cash Discount Recovered", description },
    ...(gst ?? { taxableValue: total, taxes: [], roundOff: 0, total, note: GST_NOTE.debit }),
  });
  const path = `${companyId}/debit-notes/${postingId}/${LAYOUT}-${sha256Hex}.pdf`;
  await putPdf(supabase, path, pdf);
  return { path, sha256Hex, size: pdf.length, voucherNumber: posting.verified_voucher_number };
}

export async function signedNoteDocumentUrl(supabase, path, expiresIn = 300) {
  const { data, error } = await supabase.storage.from(NOTE_DOCUMENTS_BUCKET).createSignedUrl(path, expiresIn);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error("Could not sign the verified voucher PDF.");
  return data.signedUrl;
}
