import Decimal from "decimal.js";

// Cash Discount Debit Notes in the client's GST style (mirror of the Credit
// Note): party debited with the rounded total On Account; the "(Discount)"
// sales ledger and SGST+CGST (Tamil Nadu) or IGST (other states) credited;
// Round Off to whole rupees. The recovery amount already includes GST (the
// discount was taken on the GST-inclusive invoice), so it is split into
// value + GST and the customer is charged the same amount, rounded.

const MEENAKSHI_STATE_GSTIN_PREFIX = "33"; // Tamil Nadu
const LEDGERS = {
  intraState: { discount: "TN SGST Sales (Discount)", taxes: [["SGST-9%", "9"], ["CGST - 9%", "9"]] },
  interState: { discount: "TN IGST Sales (Discount)", taxes: [["IGST @  18%", "18"]] },
  roundOff: "Round Off",
};

function dotted(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}.${m}.${y.slice(2)}`;
}
function inr(value) { return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value)); }
const collapse = (value) => String(value).replace(/\s+/g, " ").trim().toLowerCase();

/** Pure calculation, shared by the worker and tests. */
export function splitDebitNoteAmount(recovery, intraState) {
  const set = intraState ? LEDGERS.intraState : LEDGERS.interState;
  const gross = new Decimal(String(recovery));
  const totalRate = set.taxes.reduce((sum, [, rate]) => sum.plus(rate), new Decimal(0));
  const taxable = gross.mul(100).div(new Decimal(100).plus(totalRate)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const taxLines = set.taxes.map(([name, rate]) => ({ name, rate, amount: taxable.mul(rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) }));
  const exact = taxLines.reduce((sum, line) => sum.plus(line.amount), taxable);
  const total = exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return { set, taxable: taxable.toFixed(2), taxLines, roundOff: total.minus(exact).toFixed(2), total: total.toFixed(2) };
}

/** Adds `gstNote` to the posting's snapshot once; the connector posts from it. */
export async function attachDebitNoteGstPlan(supabase, postingId) {
  const { data: posting, error } = await supabase.from("cash_discount_debit_note_postings")
    .select("id, company_id, candidate_id, amount, debit_note_snapshot").eq("id", postingId).maybeSingle();
  if (error) throw error;
  if (!posting) throw new Error("Debit Note posting was not found.");
  const snapshot = posting.debit_note_snapshot ?? {};
  if (snapshot.gstNote) return snapshot.gstNote;

  const { data: candidate } = await supabase.from("cash_discount_recovery_candidates")
    .select("invoice_number, invoice_date, missed_window_deadline, granted_discount_percentage, eligible_tonnes, amount_per_tonne, settlement_category").eq("id", posting.candidate_id).maybeSingle();
  // Per-MT Cash Discount (docs/CD_LOGIC.md) gives the discount by Credit Note.
  const isCreditNote = snapshot.noteKind === "credit_note";
  const { data: customer } = await supabase.from("customers").select("tax_identifier, source_payload")
    .eq("company_id", posting.company_id).eq("tally_ledger_guid", snapshot.party?.guid).maybeSingle();
  const gstin = String(customer?.tax_identifier ?? "").trim().toUpperCase() || null;
  const stateName = String(customer?.source_payload?.stateName ?? "").trim() || null;
  const intraState = gstin ? gstin.startsWith(MEENAKSHI_STATE_GSTIN_PREFIX) : stateName ? /^tamil\s*nadu$/i.test(stateName) : null;
  if (intraState === null) throw new Error(`${snapshot.party?.name ?? "The customer"} has no GSTIN or state in Tally, so CGST/SGST or IGST cannot be decided. Update the customer ledger and refresh Tally masters.`);

  const split = splitDebitNoteAmount(posting.amount, intraState);
  const names = [split.set.discount, ...split.taxLines.map((line) => line.name), LEDGERS.roundOff];
  const { data: ledgers, error: ledgerError } = await supabase.from("tally_ledgers").select("tally_ledger_guid, name")
    .eq("company_id", posting.company_id).eq("is_available", true).in("name", [...new Set([...names, ...names.map((name) => name.replace(/\s+/g, " "))])]);
  if (ledgerError) throw ledgerError;
  const synced = new Map((ledgers ?? []).map((row) => [collapse(row.name), row]));
  const missing = names.filter((name) => !synced.has(collapse(name)));
  if (missing.length) throw new Error(`These Tally ledgers are required for the ${isCreditNote ? "Credit" : "Debit"} Note but were not found: ${missing.join(", ")}.`);

  const invoiceNumber = candidate?.invoice_number ?? snapshot.sourceInvoice?.number ?? null;
  const percentage = Number(candidate?.granted_discount_percentage);
  const tonnes = Number(candidate?.eligible_tonnes ?? snapshot.cashDiscount?.eligibleTonnes);
  const rate = Number(candidate?.amount_per_tonne ?? snapshot.cashDiscount?.amountPerTonne);
  const narration = isCreditNote ? [
    `Being Cash Discount allowed against Inv No. ${invoiceNumber}${candidate?.invoice_date ? ` dt. ${dotted(candidate.invoice_date)}` : ""}`,
    `${Number.isFinite(tonnes) ? `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(tonnes)} MT` : ""}${Number.isFinite(rate) ? ` @ Rs.${inr(rate)}/MT` : ""}`,
    `${candidate?.settlement_category === "over_ninety_percent" ? "Short payment allowed" : "Paid"}${candidate?.missed_window_deadline ? ` by ${dotted(candidate.missed_window_deadline)}` : ""}`,
    `Value Rs.${inr(split.taxable)}`,
    `Credit note amount Rs.${inr(split.total)}`,
  ].join(" - ") : [
    `Being amount debited twds Cash Discount recovery against Inv No. ${invoiceNumber}${candidate?.invoice_date ? ` dt. ${dotted(candidate.invoice_date)}` : ""}`,
    `${percentage > 0 ? `${percentage}% ` : ""}discount not eligible${candidate?.missed_window_deadline ? `, payment not received by ${dotted(candidate.missed_window_deadline)}` : ""}`,
    `Value Rs.${inr(split.taxable)}`,
    `Debit note amount Rs.${inr(split.total)}`,
  ].join(" - ");
  const gstNote = {
    mode: intraState ? "intra_state" : "inter_state",
    recovery: new Decimal(String(posting.amount)).toFixed(2),
    taxableValue: split.taxable,
    discountLedger: { name: split.set.discount, guid: synced.get(collapse(split.set.discount)).tally_ledger_guid },
    taxLines: split.taxLines.map((line) => ({ ...line, guid: synced.get(collapse(line.name)).tally_ledger_guid })),
    roundOff: { name: LEDGERS.roundOff, amount: split.roundOff },
    total: split.total,
    narration,
    reference: invoiceNumber,
    partyGstin: gstin,
    placeOfSupply: stateName,
  };
  const { error: updateError } = await supabase.from("cash_discount_debit_note_postings")
    .update({ debit_note_snapshot: { ...snapshot, gstNote } }).eq("id", posting.id);
  if (updateError) throw updateError;
  return gstNote;
}
