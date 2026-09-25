import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type ProposalRow = {
  id: string;
  company_id: string;
  customer_id: string;
  scheme_version_id: string;
  scheme_type: "cd" | "tod";
  source_sales_voucher_id: string | null;
  period_start: string | null;
  period_end: string | null;
  source_fingerprint: string;
  invoice_amount_due: string | number;
  amount_paid_by_deadline: string | number;
  calculated_discount_amount: string | number;
  posted_discount_amount: string | number | null;
  eligible_tonnes: string | number | null;
};

type EvaluationRow = { id: string; evaluation_run_id: string | null; source_fingerprint: string; evaluated_at: string; formula_snapshot: unknown };
type SourceLedgerAllocation = { id: string; guid: string; name: string; amount: string };

// A Credit Note may be created from any completed Tally calculation of this
// proposal (a full TOD run or a single-customer refresh) up to 5 days old.
// The created voucher is still read back from Tally and verified.
export const REVIEW_REFRESH_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1_000;
type PostingInput = {
  proposalId: string;
  proposalEvaluationId: string;
  creditNoteDate: string;
  billAllocationType: "agst_ref" | "new_ref" | "on_account";
  tallyBillReference: string | null;
  calculationReference: string;
  creditNoteSnapshot: Record<string, unknown>;
  idempotencyKey: string;
  correlationId: string;
};

function stableReference(parts: string[]) {
  return parts.map((part) => String(part).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80)).join(":");
}

function normalized(value: unknown) { return String(value ?? "").trim().toLowerCase(); }

function contributionRows(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  const rows = (snapshot as Record<string, unknown>).contributions;
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row))) : [];
}

async function automaticPostingMasters(companyId: string, formulaSnapshot: unknown, approvedAmount: Decimal) {
  const supabase = createSupabaseAdminClient();
  const { data: voucherTypes, error: voucherTypeError } = await supabase
    .from("tally_voucher_types")
    .select("id, tally_voucher_type_guid, name")
    .eq("company_id", companyId).eq("is_available", true).eq("is_credit_note_type", true);
  if (voucherTypeError) throw voucherTypeError;
  const exactCreditNotes = (voucherTypes ?? []).filter((row) => normalized(row.name) === "credit note");
  const voucherType = exactCreditNotes.length === 1 ? exactCreditNotes[0] : (voucherTypes?.length === 1 ? voucherTypes[0] : null);
  if (!voucherType) throw new Error("Tally must contain one available standard Credit Note voucher type before this discount can be posted.");

  const weights = new Map<string, { name: string; weight: Decimal }>();
  for (const row of contributionRows(formulaSnapshot)) {
    if (normalized(row.voucherKind) !== "sales") continue;
    const name = String(row.sourceSalesLedgerName ?? "").trim();
    const weight = new Decimal(String(row.taxableValueContribution ?? "0"));
    if (!name || !weight.isPositive()) continue;
    const key = normalized(name);
    const current = weights.get(key);
    weights.set(key, { name, weight: (current?.weight ?? new Decimal(0)).plus(weight) });
  }
  if (!weights.size) throw new Error("Refresh this customer's Turnover Discount calculation from Tally before creating the Credit Note.");

  const names = [...weights.values()].map((row) => row.name);
  const { data: ledgers, error: ledgerError } = await supabase
    .from("tally_ledgers")
    .select("id, tally_ledger_guid, name, parent_group_name")
    .eq("company_id", companyId).eq("is_available", true).in("name", names);
  if (ledgerError) throw ledgerError;
  const ledgerByName = new Map((ledgers ?? []).map((row) => [normalized(row.name), row]));
  const missing = names.filter((name) => !ledgerByName.has(normalized(name)));
  if (missing.length) throw new Error(`The source Sales ledger is no longer available in Tally: ${missing.join(", ")}.`);

  const totalWeight = [...weights.values()].reduce((total, row) => total.plus(row.weight), new Decimal(0));
  let allocated = new Decimal(0);
  const ordered = [...weights.entries()].sort(([left], [right]) => left.localeCompare(right));
  const allocations: SourceLedgerAllocation[] = ordered.map(([key, row], index) => {
    const ledger = ledgerByName.get(key)!;
    const amount = index === ordered.length - 1
      ? approvedAmount.minus(allocated)
      : approvedAmount.mul(row.weight).div(totalWeight).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    allocated = allocated.plus(amount);
    return { id: ledger.id, guid: ledger.tally_ledger_guid, name: ledger.name, amount: amount.toFixed(2) };
  });
  return { voucherType, allocations };
}

// Credit Notes follow the client's own GST credit note (e.g. No. 15): the
// discount goes to their "(Discount)" sales ledger, GST is added on top, the
// total is rounded to rupees, and the party is credited On Account.
const MEENAKSHI_STATE_GSTIN_PREFIX = "33"; // Tamil Nadu
const GST_LEDGERS = {
  intraState: { discount: "TN SGST Sales (Discount)", taxes: [["SGST-9%", "9"], ["CGST - 9%", "9"]] as const },
  interState: { discount: "TN IGST Sales (Discount)", taxes: [["IGST @  18%", "18"]] as const },
  roundOff: "Round Off",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortMonth(iso: string | null) { if (!iso) return ""; const [y, m] = iso.split("-"); return `${MONTHS[Number(m) - 1]}-${y.slice(2)}`; }
function inr(value: Decimal) { return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value.toNumber()); }

export type GstCreditNotePlan = {
  mode: "intra_state" | "inter_state";
  taxableValue: string;
  discountLedger: { id: string; guid: string; name: string };
  taxLines: Array<{ guid: string; name: string; rate: string; amount: string }>;
  roundOff: { guid: string; name: string; amount: string };
  total: string;
  narration: string;
  reference: string;
  partyGstin: string | null;
  placeOfSupply: string | null;
};

async function gstCreditNotePlan(companyId: string, customerId: string, taxable: Decimal, proposal: ProposalRow, formulaSnapshot: unknown): Promise<GstCreditNotePlan> {
  const supabase = createSupabaseAdminClient();
  const { data: customer, error } = await supabase.from("customers").select("tax_identifier, source_payload").eq("id", customerId).eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  const gstin = String(customer?.tax_identifier ?? "").trim().toUpperCase() || null;
  const stateName = String((customer?.source_payload as Record<string, unknown> | null)?.stateName ?? "").trim() || null;
  // GSTIN state code is authoritative; fall back to the ledger's state.
  const intraState = gstin ? gstin.startsWith(MEENAKSHI_STATE_GSTIN_PREFIX) : stateName ? /^tamil\s*nadu$/i.test(stateName) : null;
  if (intraState === null) throw new Error("The customer's GSTIN and state are missing in Tally, so CGST/SGST or IGST cannot be decided. Update the customer ledger and refresh Tally masters.");
  const set = intraState ? GST_LEDGERS.intraState : GST_LEDGERS.interState;
  const names = [set.discount, ...set.taxes.map(([name]) => name), GST_LEDGERS.roundOff];
  // Synced master names can differ from Tally only in spacing ("IGST @  18%"
  // vs "IGST @ 18%"); match ignoring spaces, but post Tally's exact name.
  const collapse = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const { data: ledgers, error: ledgerError } = await supabase.from("tally_ledgers").select("id, tally_ledger_guid, name").eq("company_id", companyId).eq("is_available", true)
    .in("name", [...new Set([...names, ...names.map((name) => name.replace(/\s+/g, " "))])]);
  if (ledgerError) throw ledgerError;
  const synced = new Map((ledgers ?? []).map((row) => [collapse(row.name), row]));
  const byName = new Map(names.flatMap((name) => { const row = synced.get(collapse(name)); return row ? [[name, row] as const] : []; }));
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`These Tally ledgers are required for the Credit Note but were not found: ${missing.join(", ")}.`);

  const taxLines = set.taxes.map(([name, rate]) => ({ guid: byName.get(name)!.tally_ledger_guid, name, rate, amount: taxable.mul(rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) }));
  const exact = taxLines.reduce((sum, line) => sum.plus(line.amount), taxable);
  const total = exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const roundOff = total.minus(exact); // positive: added (debit); negative: reduced (credit)
  const formula = (formulaSnapshot && typeof formulaSnapshot === "object" ? formulaSnapshot : {}) as Record<string, unknown>;
  const rate = formula.achievedTierRatePerMt != null ? new Decimal(String(formula.achievedTierRatePerMt)) : null;
  const tonnes = proposal.eligible_tonnes != null ? String(proposal.eligible_tonnes) : null;
  // Slab start (e.g. "200 MT & above") from the rule tier that pays this rate.
  const { data: tiers } = rate
    ? await supabase.from("scheme_version_tiers").select("minimum_tonnes, discount_amount_per_tonne").eq("scheme_version_id", proposal.scheme_version_id)
    : { data: [] as Array<{ minimum_tonnes: number; discount_amount_per_tonne: number | null }> };
  const tier = (tiers ?? []).find((row) => row.discount_amount_per_tonne != null && rate !== null && new Decimal(String(row.discount_amount_per_tonne)).equals(rate));
  const tierFrom = tier ? String(Number(tier.minimum_tonnes)) : null;
  const period = proposal.period_start && proposal.period_end ? `${shortMonth(proposal.period_start)} to ${shortMonth(proposal.period_end)}` : "the period";
  const narration = [
    `Being amount credited twds Turnover Discount for ${period}`,
    rate ? `Slab ${tierFrom ? `${tierFrom} MT and above ` : ""}@ Rs.${inr(rate)}/MT` : null,
    tonnes ? `Total qty ${Number(tonnes).toFixed(3)} MT` : null,
    `Value Rs.${inr(taxable)}`,
    `Credit note amount Rs.${inr(total)}`,
  ].filter(Boolean).join(" - ");
  const discount = byName.get(set.discount)!;
  return {
    mode: intraState ? "intra_state" : "inter_state",
    taxableValue: taxable.toFixed(2),
    discountLedger: { id: discount.id, guid: discount.tally_ledger_guid, name: discount.name },
    taxLines,
    roundOff: { guid: byName.get(GST_LEDGERS.roundOff)!.tally_ledger_guid, name: GST_LEDGERS.roundOff, amount: roundOff.toFixed(2) },
    total: total.toFixed(2),
    narration,
    reference: `TOD ${period}`.slice(0, 50),
    partyGstin: gstin,
    placeOfSupply: stateName,
  };
}

export function createCorrelationId() {
  return randomUUID();
}

export function resultLedgerEntriesHash(entries: unknown) {
  return createHash("sha256").update(JSON.stringify(entries ?? [])).digest("hex");
}

/**
 * Builds server-side Credit Note creation data from the most recent frozen evaluation.
 * No amount, ledger, voucher type, or posting date is accepted from a browser.
 */
export async function buildCreditNoteApprovalInput(companyId: string, proposalId: string): Promise<PostingInput> {
  const supabase = createSupabaseAdminClient();
  const { data: proposalData, error: proposalError } = await supabase
    .from("discount_proposals")
    .select("id, company_id, customer_id, scheme_version_id, scheme_type, source_sales_voucher_id, period_start, period_end, source_fingerprint, invoice_amount_due, amount_paid_by_deadline, calculated_discount_amount, posted_discount_amount, eligible_tonnes")
    .eq("id", proposalId).eq("company_id", companyId).maybeSingle();
  if (proposalError) throw proposalError;
  const proposal = proposalData as ProposalRow | null;
  if (!proposal) throw new Error("Proposal not found.");
  if (proposal.scheme_type !== "tod") throw new Error("Cash Discount recovery uses a Debit Note prepared from the live source invoice.");

  const { data: evaluationData, error: evaluationError } = await supabase
    .from("proposal_evaluations")
    .select("id, evaluation_run_id, source_fingerprint, evaluated_at, formula_snapshot")
    .eq("proposal_id", proposal.id).eq("company_id", companyId)
    .order("evaluation_number", { ascending: false }).limit(1).maybeSingle();
  if (evaluationError) throw evaluationError;
  const evaluation = evaluationData as EvaluationRow | null;
  if (!evaluation || evaluation.source_fingerprint !== proposal.source_fingerprint) {
    throw new Error("A fresh matching proposal evaluation is required before creating the Credit Note.");
  }

  if (!evaluation.evaluation_run_id) {
    throw new Error("Refresh live Tally evidence before creating this Credit Note.");
  }
  const { data: reviewRefresh, error: reviewRefreshError } = await supabase
    .from("evaluation_runs")
    .select("id, status, completed_at, request_context")
    .eq("id", evaluation.evaluation_run_id)
    .eq("company_id", companyId)
    .maybeSingle();
  if (reviewRefreshError) throw reviewRefreshError;
  const completedAt = reviewRefresh?.completed_at ? new Date(reviewRefresh.completed_at).getTime() : Number.NaN;
  if (
    reviewRefresh?.status !== "completed"
    || !Number.isFinite(completedAt)
    || Date.now() - completedAt > REVIEW_REFRESH_MAX_AGE_MS
  ) {
    throw new Error("This result was calculated more than 5 days ago. Check the latest Tally information, then create the Credit Note.");
  }

  const [{ data: company, error: companyError }, { data: customer, error: customerError }, { data: version, error: versionError }] = await Promise.all([
    supabase.from("companies").select("id, tally_company_guid, tally_company_name").eq("id", companyId).maybeSingle(),
    supabase.from("customers").select("id, tally_ledger_guid, ledger_name").eq("id", proposal.customer_id).eq("company_id", companyId).maybeSingle(),
    supabase.from("scheme_versions").select("*").eq("id", proposal.scheme_version_id).eq("company_id", companyId).maybeSingle(),
  ]);
  if (companyError || customerError || versionError) throw companyError ?? customerError ?? versionError;
  if (!company || !customer || !version) throw new Error("The proposal's current company, customer, or rule configuration is unavailable.");
  // The credit is left On Account; the accountant adjusts it against bills.
  const billAllocationType = "on_account" as const;
  const tallyBillReference = null;
  const calculationReference = stableReference(["TOD", String(version.version_number), proposal.period_start ?? "", proposal.period_end ?? "", evaluation.id]);
  const creditNoteDate = new Date().toISOString().slice(0, 10);
  const approvedAmount = proposal.posted_discount_amount ?? proposal.calculated_discount_amount;
  const amount = new Decimal(String(approvedAmount));
  if (!amount.isPositive()) throw new Error("The approved Credit Note amount must be positive.");
  const postingMasters = await automaticPostingMasters(companyId, evaluation.formula_snapshot, amount);
  const gst = await gstCreditNotePlan(companyId, proposal.customer_id, amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP), proposal, evaluation.formula_snapshot);

  return {
    proposalId: proposal.id,
    proposalEvaluationId: evaluation.id,
    creditNoteDate,
    billAllocationType,
    tallyBillReference,
    calculationReference,
    idempotencyKey: `credit-note:${proposal.id}`,
    correlationId: createCorrelationId(),
    creditNoteSnapshot: {
      schemaVersion: 1,
      proposal: {
        id: proposal.id, schemeType: proposal.scheme_type, sourceFingerprint: proposal.source_fingerprint,
        sourceSalesVoucherId: proposal.source_sales_voucher_id, periodStart: proposal.period_start, periodEnd: proposal.period_end,
        invoiceAmountDue: String(proposal.invoice_amount_due), amountPaidByDeadline: String(proposal.amount_paid_by_deadline),
        approvedAmount: String(approvedAmount),
      },
      evaluation: { id: evaluation.id, evaluationRunId: evaluation.evaluation_run_id, evaluatedAt: evaluation.evaluated_at, sourceFingerprint: evaluation.source_fingerprint },
      ruleVersion: { id: version.id, number: version.version_number, gstTreatment: "commercial_no_gst" },
      customer: { id: customer.id, tallyLedgerGuid: customer.tally_ledger_guid, ledgerName: customer.ledger_name },
      tallyPosting: {
        company: { guid: company.tally_company_guid, name: company.tally_company_name },
        voucherType: { id: postingMasters.voucherType.id, guid: postingMasters.voucherType.tally_voucher_type_guid, name: postingMasters.voucherType.name },
        party: { guid: customer.tally_ledger_guid, name: customer.ledger_name },
        // The discount ledger carries the whole taxable value (verified as the "source" ledger).
        sourceSalesLedgers: [{ id: gst.discountLedger.id, guid: gst.discountLedger.guid, name: gst.discountLedger.name, amount: gst.taxableValue }],
        originalSalesLedgers: postingMasters.allocations,
        gstNote: gst,
      },
      allocation: { type: billAllocationType, tallyBillReference },
      calculationReference,
      creditNoteDate,
      commercialNoGst: true,
    },
  };
}
