import { renderTallyStyleNotePdf, indianMoney, tallyDate } from "./tally-style-note-pdf.mjs";

export const NOTE_DOCUMENTS_BUCKET = "meenakshi-credit-note-documents";
// Bump when the customer-facing layout changes so older copies are re-rendered on resend.
const LAYOUT = "tally-v2";
const GST_NOTE = {
  credit: "Commercial credit note. GST is not adjusted; the original tax invoices remain unchanged.",
  debit: "Commercial debit note. GST is not adjusted; the original tax invoice remains unchanged.",
};

async function companyDetails(supabase, companyId, fallbackName) {
  const { data, error } = await supabase.from("companies").select("tally_company_name,document_address,document_gstin,document_state").eq("id", companyId).maybeSingle();
  // Columns are added by 20260925120000; before that migration only the name is known.
  if (error) return { name: fallbackName };
  return { name: data?.tally_company_name ?? fallbackName, address: data?.document_address, gstin: data?.document_gstin, state: data?.document_state };
}

async function partyDetails(supabase, companyId, customerId, ledgerGuid, fallbackName) {
  let query = supabase.from("customers").select("ledger_name,tax_identifier,source_payload").eq("company_id", companyId);
  query = customerId ? query.eq("id", customerId) : query.eq("tally_ledger_guid", ledgerGuid);
  const { data } = await query.maybeSingle();
  const payload = data?.source_payload ?? {};
  const address = [payload.address, payload.pinCode && !String(payload.address ?? "").includes(payload.pinCode) ? payload.pinCode : null].filter(Boolean).join(", ");
  return { name: fallbackName ?? data?.ledger_name, address, gstin: data?.tax_identifier, state: payload.stateName };
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
  if (existing?.status === "verified" && existing.storage_path?.includes(`/${LAYOUT}-`) && existing.tally_voucher_guid === posting.verified_tally_guid) return existing;
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
  const particulars = proposal?.scheme_type === "tod"
    ? [`Turnover discount${period ? ` for ${period}` : ""}`, ...(tonnes > 0 && rate > 0 ? [`Eligible quantity ${tonnes.toFixed(2)} MT @ Rs. ${indianMoney(rate)} per MT`] : [])]
    : ["Cash discount"];
  // GST credit notes (client style): taxable value, GST lines, round off, total.
  const gst = tally.gstNote;
  const gstRows = gst ? [
    ...gst.taxLines.map((line) => ({ label: `${line.name.replace(/\s+/g, " ")}`, amount: line.amount })),
    ...(Number(gst.roundOff?.amount ?? 0) ? [{ label: "Round Off", amount: gst.roundOff.amount }] : []),
  ] : [];
  const { pdf, sha256Hex } = renderTallyStyleNotePdf({
    kind: "credit",
    ...(gst ? { amountRows: gstRows, taxableValue: gst.taxableValue } : {}),
    company: await companyDetails(supabase, companyId, required(tally.company?.name, "company name")),
    party: await partyDetails(supabase, companyId, posting.customer_id, tally.party?.guid, partyName),
    voucherNumber: required(posting.verified_voucher_number, "voucher number"),
    voucherDate: required(posting.credit_note_date, "voucher date"),
    reference: proposal?.scheme_type === "tod" && period ? `Turnover discount ${period}` : null,
    particulars,
    // The customer is credited with the GST-inclusive total on GST notes.
    amount: gst ? Number(gst.total) : total,
    gstNote: gst ? null : GST_NOTE.credit,
  });
  const path = `${companyId}/credit-notes/${postingId}/${LAYOUT}-${sha256Hex}.pdf`;
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
  const { data: candidate } = posting.candidate_id
    ? await supabase.from("cash_discount_recovery_candidates").select("invoice_number,invoice_date,granted_discount_percentage,missed_window_deadline").eq("id", posting.candidate_id).maybeSingle()
    : { data: null };
  const invoiceNumber = candidate?.invoice_number ?? snapshot.sourceInvoice?.number;
  const percentage = Number(candidate?.granted_discount_percentage);
  const particulars = [
    `Cash discount${percentage > 0 ? ` of ${percentage}%` : ""} recovered`,
    ...(invoiceNumber ? [`Against invoice ${invoiceNumber}${candidate?.invoice_date ? ` dated ${tallyDate(candidate.invoice_date)}` : ""}`] : []),
    ...(candidate?.missed_window_deadline ? [`Invoice was not paid in full by ${tallyDate(candidate.missed_window_deadline)}`] : []),
  ];
  const { pdf, sha256Hex } = renderTallyStyleNotePdf({
    kind: "debit",
    company: await companyDetails(supabase, companyId, required(snapshot.company?.name, "company name")),
    party: await partyDetails(supabase, companyId, null, snapshot.party?.guid, party),
    voucherNumber: required(posting.verified_voucher_number, "voucher number"),
    voucherDate: required(posting.debit_note_date, "voucher date"),
    reference: invoiceNumber ? `Inv. ${invoiceNumber}` : null,
    particulars,
    // GST Debit Notes (client style): value, GST lines, Round Off, rounded total.
    ...(snapshot.gstNote ? {
      taxableValue: snapshot.gstNote.taxableValue,
      amountRows: [
        ...snapshot.gstNote.taxLines.map((line) => ({ label: line.name.replace(/\s+/g, " "), amount: line.amount })),
        ...(Number(snapshot.gstNote.roundOff?.amount ?? 0) ? [{ label: "Round Off", amount: snapshot.gstNote.roundOff.amount }] : []),
      ],
      amount: Number(snapshot.gstNote.total),
      gstNote: null,
    } : { amount: total, gstNote: GST_NOTE.debit }),
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
