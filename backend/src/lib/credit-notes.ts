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
};

type EvaluationRow = { id: string; evaluation_run_id: string | null; source_fingerprint: string; evaluated_at: string; formula_snapshot: unknown };
type SourceLedgerAllocation = { id: string; guid: string; name: string; amount: string };

const REVIEW_REFRESH_MAX_AGE_MS = 15 * 60 * 1_000;
type PostingInput = {
  proposalId: string;
  proposalEvaluationId: string;
  creditNoteDate: string;
  billAllocationType: "agst_ref" | "new_ref";
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
    .select("id, company_id, customer_id, scheme_version_id, scheme_type, source_sales_voucher_id, period_start, period_end, source_fingerprint, invoice_amount_due, amount_paid_by_deadline, calculated_discount_amount, posted_discount_amount")
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
  const refreshWasRequestedForProposal = reviewRefresh?.request_context
    && typeof reviewRefresh.request_context === "object"
    && (reviewRefresh.request_context as Record<string, unknown>).reviewRefreshForProposal === proposal.id;
  if (
    reviewRefresh?.status !== "completed"
    || !refreshWasRequestedForProposal
    || !Number.isFinite(completedAt)
    || Date.now() - completedAt > REVIEW_REFRESH_MAX_AGE_MS
  ) {
    throw new Error("Refresh live Tally evidence and wait for it to complete before creating the Credit Note. A refresh is valid for 15 minutes.");
  }

  const [{ data: company, error: companyError }, { data: customer, error: customerError }, { data: version, error: versionError }] = await Promise.all([
    supabase.from("companies").select("id, tally_company_guid, tally_company_name").eq("id", companyId).maybeSingle(),
    supabase.from("customers").select("id, tally_ledger_guid, ledger_name").eq("id", proposal.customer_id).eq("company_id", companyId).maybeSingle(),
    supabase.from("scheme_versions").select("*").eq("id", proposal.scheme_version_id).eq("company_id", companyId).maybeSingle(),
  ]);
  if (companyError || customerError || versionError) throw companyError ?? customerError ?? versionError;
  if (!company || !customer || !version) throw new Error("The proposal's current company, customer, or rule configuration is unavailable.");
  const billAllocationType = "new_ref" as const;
  const tallyBillReference = stableReference(["TOD", String(version.version_number), proposal.period_start ?? "period", proposal.period_end ?? "period", proposal.customer_id.slice(0, 8)]);
  const calculationReference = stableReference(["TOD", String(version.version_number), proposal.period_start ?? "", proposal.period_end ?? "", evaluation.id]);
  const creditNoteDate = new Date().toISOString().slice(0, 10);
  const approvedAmount = proposal.posted_discount_amount ?? proposal.calculated_discount_amount;
  const amount = new Decimal(String(approvedAmount));
  if (!amount.isPositive()) throw new Error("The approved Credit Note amount must be positive.");
  const postingMasters = await automaticPostingMasters(companyId, evaluation.formula_snapshot, amount);

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
        sourceSalesLedgers: postingMasters.allocations,
      },
      allocation: { type: billAllocationType, tallyBillReference },
      calculationReference,
      creditNoteDate,
      commercialNoGst: true,
    },
  };
}
