import { workingDayBreakdown } from "./calendar";
import { parseCashDiscountNarration } from "./cash-discount-narration";

// "CD 1.5%", "1.5% cash discount", "Less 2 percent C.D." qualify; "18% GST" or "CD" alone do not.
export function offersCashDiscount(narration: unknown) {
  const text = String(narration ?? "");
  return /\bcash\s*discount\b|\bc\s*\.?\s*d\s*\.?\b/i.test(text) && /%|\bper\s*cent(?:age)?\b/i.test(text);
}
import { decimal, money, nonNegative, percentOf } from "./decimal";
import { loadLiveCdBatchRule, loadLiveCdLocalBootstrap, type EvaluationRunRecord } from "./evidence";
import type { FrozenCdRule } from "./contracts";
import { evaluateCashDiscountSettlements } from "./cd-settlement.mjs";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type LiveCdPayment = {
  receiptGuid: string;
  receiptNumber: string | null;
  receiptDate: string;
  billReference: string | null;
  targetVoucherGuid: string | null;
  allocationType: string;
  allocatedAmount: string;
  // Optional for older connector evidence; New Ref is rejected when its
  // owning-ledger/direction evidence is missing. Agst Ref keeps its behaviour.
  receiptKind?: string;
  receiptType?: string | null;
  allocationKey?: string;
  customerLedgerName?: string | null;
  rawAllocatedAmount?: string | null;
  ledgerIsDeemedPositive?: boolean | null;
};

type LiveCdDebitNote = {
  tallyGuid: string;
  voucherNumber: string | null;
  voucherDate: string;
  customerLedgerName: string;
  status: string;
  billReference: string | null;
  targetVoucherGuid: string | null;
  amount: string;
  narration: string;
};

export type LiveCdInvoice = {
  customerId: string;
  customerLedgerName: string;
  sourceSalesLedgerName: string | null;
  tallyGuid: string;
  voucherNumber: string | null;
  billReferences: string[];
  voucherDate: string;
  grossAmount: string;
  eligibleValue: string;
  narration: string;
  inventoryLineCount: number;
  payments: LiveCdPayment[];
  debitNotes: LiveCdDebitNote[];
};

export type LiveCdBatch = {
  mode: "live_cd_batch";
  evaluationRunId: string | null;
  ruleVersionId: string;
  dateFrom: string;
  dateTo: string;
  chunks: number;
  vouchersScanned: number;
  invoices: LiveCdInvoice[];
  sourceFingerprint: string;
};

type VerifiedDebitNotePosting = {
  verified_tally_guid: string | null;
  verified_voucher_number: string | null;
  verified_amount: string | number | null;
  amount: string | number;
  debit_note_date: string;
  calculation_reference: string;
  cash_discount_recovery_candidates: {
    invoice_tally_guid: string;
    customer_name: string;
    bill_reference: string;
  } | null;
};

export type CashDiscountRecoveryCandidate = {
  customerTallyGuid: string;
  customerName: string;
  sourceSalesLedgerName: string | null;
  invoiceTallyGuid: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  billReference: string;
  netInvoiceAmount: string;
  impliedGrossAmount: string;
  amountPaid: string;
  grantedDiscountPercentage: string;
  earnedDiscountPercentage: string;
  recoveryRequired: string;
  alreadyRecovered: string;
  remainingRecovery: string;
  missedWindowWorkingDays: number;
  missedWindowDeadline: string;
  nextWindowWorkingDays: number | null;
  nextWindowPercentage: string | null;
  status: "action_required" | "review_required";
  reasonCode: string;
  reviewMessage: string | null;
  narration: { checked: boolean; mentioned: boolean; matches: boolean };
  debitNoteReferences: Array<{ tallyGuid: string; voucherNumber: string | null; voucherDate: string; amount: string }>;
};

export type CashDiscountOpenReminderCandidate = {
  customerName: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  billReference: string;
  amountPaid: string;
  shortfallAmount: string;
  eligibilityDeadline: string;
  status: "ready" | "review_required";
  reasonCode: string;
  reviewMessage: string | null;
};

export type CashDiscountInvoiceCheck = {
  customerName: string;
  invoiceGuid: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  invoiceAmount: string;
  amountPaid: string;
  outstandingAmount: string;
  discountPercentage: string;
  earnedDiscountPercentage: string;
  eligibilityDeadline: string;
  status: "retained" | "payment_due" | "recovery_due" | "recovered" | "needs_review";
  paymentCount: number;
  latestPaymentDate: string | null;
  reviewMessage: string | null;
};

export function isLiveCdBatch(value: unknown): value is LiveCdBatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.mode === "live_cd_batch" && typeof row.ruleVersionId === "string" && typeof row.sourceFingerprint === "string" && Array.isArray(row.invoices);
}

function completionDate(invoiceAmount: ReturnType<typeof decimal>, payments: LiveCdPayment[], evaluatedOn: string) {
  let paid = decimal(0);
  for (const payment of payments
    .filter((item) => item.allocationType === "agst_ref" && item.receiptDate <= evaluatedOn)
    .sort((left, right) => left.receiptDate.localeCompare(right.receiptDate) || left.receiptGuid.localeCompare(right.receiptGuid))) {
    paid = paid.plus(decimal(payment.allocatedAmount).abs());
    if (paid.greaterThanOrEqualTo(invoiceAmount)) return payment.receiptDate;
  }
  return null;
}

export function evaluateLiveCdInvoices(rule: FrozenCdRule, evaluatedOn: string, invoices: LiveCdInvoice[]) {
  const candidates: CashDiscountRecoveryCandidate[] = [];
  const reminders: CashDiscountOpenReminderCandidate[] = [];
  const results: CashDiscountInvoiceCheck[] = [];
  const slabs = [...rule.slabs]
    .sort((left, right) => left.allowedWorkingDays - right.allowedWorkingDays || decimal(right.percentage).comparedTo(decimal(left.percentage)));
  const highestPercentage = slabs.reduce((highest, slab) => decimal(slab.percentage).greaterThan(highest) ? decimal(slab.percentage) : highest, decimal(0));

  for (const invoice of invoices) {
    const netInvoiceAmount = decimal(invoice.grossAmount).abs();
    if (netInvoiceAmount.lessThanOrEqualTo(0)) continue;
    // Only invoices whose narration offers Cash Discount count: it must mention
    // CD / cash discount together with a percentage ("%" or "percent"). The
    // rule percentage always applies; the narration only qualifies the invoice.
    if (!offersCashDiscount(invoice.narration)) continue;
    const narration = parseCashDiscountNarration(invoice.narration);
    const narrationPercentage = narration.percentage;
    const narrationSlab = narrationPercentage === null
      ? null
      : slabs.find((slab) => decimal(slab.percentage).equals(narrationPercentage));
    const narrationMatches = Boolean(narrationSlab)
      && (narration.allowedDays === null || narrationSlab?.allowedWorkingDays === narration.allowedDays)
      && narration.dayType !== "calendar_days";
    const narrationConflict = rule.narrationMode === "required" && (!narration.mentioned || !narrationMatches);
    const grantedPercentage = highestPercentage;
    if (grantedPercentage.lessThanOrEqualTo(0) || grantedPercentage.greaterThanOrEqualTo(100)) continue;

    const impliedGrossAmount = netInvoiceAmount.div(decimal(1).minus(grantedPercentage.div(100)));
    const paidToDate = invoice.payments
      .filter((payment) => payment.allocationType === "agst_ref" && payment.receiptDate <= evaluatedOn)
      .reduce((total, payment) => total.plus(decimal(payment.allocatedAmount).abs()), decimal(0));
    const paidInFullOn = completionDate(netInvoiceAmount, invoice.payments, evaluatedOn);
    const windows = slabs.map((slab) => ({
      ...slab,
      deadline: workingDayBreakdown(rule.calendar, invoice.voucherDate, slab.allowedWorkingDays).at(-1)!.businessDate,
    }));
    const earnedWindow = paidInFullOn
      ? windows.filter((window) => paidInFullOn <= window.deadline).sort((left, right) => decimal(right.percentage).comparedTo(decimal(left.percentage)))[0] ?? null
      : windows.filter((window) => evaluatedOn <= window.deadline).sort((left, right) => decimal(right.percentage).comparedTo(decimal(left.percentage)))[0] ?? null;
    // Invoices paid in full after the deadline are not recovered and not listed.
    if (paidInFullOn && !earnedWindow) continue;
    const earnedPercentage = earnedWindow ? decimal(earnedWindow.percentage) : decimal(0);
    const finalDeadline = windows.at(-1)!.deadline;
    const openShortfall = nonNegative(netInvoiceAmount.minus(paidToDate));
    if (openShortfall.greaterThan(0) && finalDeadline >= evaluatedOn) {
      const status = narrationConflict ? "review_required" : "ready";
      reminders.push({
        customerName: invoice.customerLedgerName,
        invoiceNumber: invoice.voucherNumber,
        invoiceDate: invoice.voucherDate,
        billReference: invoice.billReferences[0] || invoice.voucherNumber || invoice.tallyGuid,
        amountPaid: money(paidToDate),
        shortfallAmount: money(openShortfall),
        eligibilityDeadline: finalDeadline,
        status,
        reasonCode: narrationConflict ? "cash_discount_narration_conflict" : "open_invoice_before_payment_deadline",
        reviewMessage: narrationConflict ? "The invoice narration does not match the active Cash Discount rule. Review it before sending a reminder." : null,
      });
    }
    const recoveryRequired = nonNegative(percentOf(impliedGrossAmount, grantedPercentage.minus(earnedPercentage)));
    const postedDebitNotes = (invoice.debitNotes ?? []).filter((note) => note.status === "posted");
    const alreadyRecovered = postedDebitNotes.reduce((total, note) => total.plus(decimal(note.amount).abs()), decimal(0));
    const remainingRecovery = nonNegative(recoveryRequired.minus(alreadyRecovered));
    // Debit Notes are posted rounded to whole rupees (with GST), so a
    // difference under Rs.1 either way is rounding, not a new recovery.
    const overRecovered = alreadyRecovered.greaterThan(recoveryRequired.plus(decimal("1")));
    const missingSalesLedger = !String(invoice.sourceSalesLedgerName ?? "").trim();
    const needsRecovery = alreadyRecovered.greaterThan(0) ? remainingRecovery.greaterThanOrEqualTo(decimal("1")) : remainingRecovery.greaterThan(decimal("0.0049"));
    const needsReview = overRecovered || narrationConflict || (needsRecovery && missingSalesLedger);
    const fullyRecovered = !overRecovered && alreadyRecovered.greaterThan(0) && !needsRecovery;
    const status = needsReview ? "needs_review" : needsRecovery ? "recovery_due" : fullyRecovered ? "recovered" : openShortfall.greaterThan(0) ? "payment_due" : "retained";
    const reviewMessage = overRecovered
      ? "Existing Debit Notes exceed the recovery now supported by the latest receipts. Review possible backdated payment or duplicate recovery."
      : narrationConflict
        ? "The invoice narration does not match the active Cash Discount rule. Review this invoice before posting."
        : needsRecovery && missingSalesLedger
          ? "The original invoice Sales ledger could not be identified from Tally. Refresh the calculation before posting."
          : null;
    const paymentsToDate = invoice.payments.filter((payment) => payment.allocationType === "agst_ref" && payment.receiptDate <= evaluatedOn);
    const latestPaymentDate = paymentsToDate.map((payment) => payment.receiptDate).sort().at(-1) ?? null;

    results.push({
      customerName: invoice.customerLedgerName,
      invoiceGuid: invoice.tallyGuid,
      invoiceNumber: invoice.voucherNumber,
      invoiceDate: invoice.voucherDate,
      invoiceAmount: money(netInvoiceAmount),
      amountPaid: money(paidToDate),
      outstandingAmount: money(openShortfall),
      discountPercentage: money(grantedPercentage),
      earnedDiscountPercentage: money(earnedPercentage),
      eligibilityDeadline: finalDeadline,
      status,
      paymentCount: paymentsToDate.length,
      latestPaymentDate,
      reviewMessage,
    });

    if (!needsRecovery && !overRecovered && !narrationConflict) continue;

    const missedWindow = [...windows]
      .filter((window) => window.deadline < evaluatedOn && decimal(window.percentage).greaterThan(earnedPercentage))
      .sort((left, right) => right.allowedWorkingDays - left.allowedWorkingDays)[0] ?? windows.at(-1)!;
    const nextWindow = windows
      .filter((window) => window.deadline >= evaluatedOn && window.deadline > missedWindow.deadline && decimal(window.percentage).lessThan(decimal(missedWindow.percentage)))
      .sort((left, right) => left.allowedWorkingDays - right.allowedWorkingDays)[0] ?? null;
    const recoveryStatus = needsReview ? "review_required" : "action_required";
    const reasonCode = overRecovered
      ? "existing_debit_note_exceeds_recovery"
      : narrationConflict
        ? "cash_discount_narration_conflict"
        : missingSalesLedger
          ? "source_sales_ledger_unavailable"
          : earnedPercentage.equals(0)
            ? "final_payment_window_missed"
            : "higher_discount_window_missed";
    candidates.push({
      customerTallyGuid: invoice.customerId,
      customerName: invoice.customerLedgerName,
      sourceSalesLedgerName: invoice.sourceSalesLedgerName,
      invoiceTallyGuid: invoice.tallyGuid,
      invoiceNumber: invoice.voucherNumber,
      invoiceDate: invoice.voucherDate,
      billReference: invoice.billReferences[0] || invoice.voucherNumber || invoice.tallyGuid,
      netInvoiceAmount: money(netInvoiceAmount),
      impliedGrossAmount: money(impliedGrossAmount),
      amountPaid: money(paidToDate),
      grantedDiscountPercentage: money(grantedPercentage),
      earnedDiscountPercentage: money(earnedPercentage),
      recoveryRequired: money(recoveryRequired),
      alreadyRecovered: money(alreadyRecovered),
      remainingRecovery: money(remainingRecovery),
      missedWindowWorkingDays: missedWindow.allowedWorkingDays,
      missedWindowDeadline: missedWindow.deadline,
      nextWindowWorkingDays: nextWindow?.allowedWorkingDays ?? null,
      nextWindowPercentage: nextWindow?.percentage ?? null,
      status: recoveryStatus,
      reasonCode,
      reviewMessage,
      narration: { checked: rule.checkNarration, mentioned: narration.mentioned, matches: narrationMatches },
      debitNoteReferences: postedDebitNotes.map((note) => ({ tallyGuid: note.tallyGuid, voucherNumber: note.voucherNumber, voucherDate: note.voucherDate, amount: money(decimal(note.amount).abs()) })),
    });
  }

  const totals = {
    invoicesChecked: invoices.length,
    actionRequired: candidates.filter((row) => row.status === "action_required").length,
    reviewRequired: candidates.filter((row) => row.status === "review_required").length,
    recoveryAmount: money(candidates.filter((row) => row.status === "action_required").reduce((total, row) => total.plus(decimal(row.remainingRecovery)), decimal(0))),
    alreadyRecovered: money(candidates.reduce((total, row) => total.plus(decimal(row.alreadyRecovered)), decimal(0))),
    openReminderReady: reminders.filter((row) => row.status === "ready").length,
    openReminderReview: reminders.filter((row) => row.status === "review_required").length,
  };
  return { rows: candidates, reminders, results, totals };
}

export async function evaluateLiveCdBatch(run: EvaluationRunRecord, batch: LiveCdBatch) {
  if (batch.evaluationRunId !== run.id) throw new Error("The live Tally result does not belong to this Cash Discount calculation.");
  const { rule, evaluatedOn } = await loadLiveCdBatchRule(run, batch.ruleVersionId);
  return { ...(evaluateLiveCdInvoices(rule, evaluatedOn, batch.invoices)), rule, evaluatedOn };
}

export function mergeVerifiedDebitNotes(invoices: LiveCdInvoice[], postings: VerifiedDebitNotePosting[]) {
  const byInvoiceGuid = new Map<string, VerifiedDebitNotePosting[]>();
  for (const posting of postings) {
    const invoiceGuid = posting.cash_discount_recovery_candidates?.invoice_tally_guid;
    if (!invoiceGuid || !posting.verified_tally_guid) continue;
    const existing = byInvoiceGuid.get(invoiceGuid) ?? [];
    existing.push(posting);
    byInvoiceGuid.set(invoiceGuid, existing);
  }
  return invoices.map((invoice) => {
    const known = byInvoiceGuid.get(invoice.tallyGuid) ?? [];
    if (!known.length) return invoice;
    const seen = new Set((invoice.debitNotes ?? []).map((note) => note.tallyGuid));
    const recovered = known
      .filter((posting) => !seen.has(posting.verified_tally_guid!))
      .map((posting): LiveCdDebitNote => ({
        tallyGuid: posting.verified_tally_guid!,
        voucherNumber: posting.verified_voucher_number,
        voucherDate: posting.debit_note_date,
        customerLedgerName: posting.cash_discount_recovery_candidates!.customer_name,
        status: "posted",
        billReference: posting.cash_discount_recovery_candidates!.bill_reference,
        targetVoucherGuid: invoice.tallyGuid,
        amount: String(posting.verified_amount ?? posting.amount),
        narration: posting.calculation_reference,
      }));
    return recovered.length ? { ...invoice, debitNotes: [...(invoice.debitNotes ?? []), ...recovered] } : invoice;
  });
}

/**
 * Per-MT Cash Discount (docs/CD_LOGIC.md): re-run the settlement calculation on
 * the connector's evidence and save the current snapshot. No Credit Note is
 * queued here: staff create each one from the Cash Discount page. The
 * database allows one live Credit Note per invoice.
 */
export async function completeCdSettlementRun(run: EvaluationRunRecord, batch: LiveCdBatch) {
  const supabase = createSupabaseAdminClient();
  const bootstrap = await loadLiveCdLocalBootstrap(run, batch.ruleVersionId);
  const rule = bootstrap.rule as FrozenCdRule & { customerSegments?: Record<string, number> };
  const result = evaluateCashDiscountSettlements(rule, bootstrap.evaluatedOn, batch.invoices) as {
    results: Array<Record<string, unknown>>;
    candidates: Array<Record<string, unknown> & { customerId: string; invoiceGuid: string; category: string }>;
    totals: Record<string, unknown>;
  };
  // Not-eligible invoices (paid late or under 90%) need no action and were
  // ~96% of a large period (14 MB per check). Keep full rows only for the
  // rest and store the not-eligible ones as a count.
  const actionable = result.results.filter((row) => row.category !== "not_eligible");
  // Tag each row with the customer's Tally group (the salesperson), which the
  // Cash Discount page filters by.
  const customerIds = [...new Set(actionable.map((row) => String(row.customerId ?? "")).filter(Boolean))];
  const groupByCustomer = new Map<string, string>();
  for (let index = 0; index < customerIds.length; index += 200) {
    const { data: customers, error: customerError } = await supabase.from("customers")
      .select("tally_ledger_guid, customer_groups(name)")
      .eq("company_id", run.company_id).in("tally_ledger_guid", customerIds.slice(index, index + 200));
    if (customerError) throw customerError;
    for (const customer of customers ?? []) {
      const group = customer.customer_groups as { name?: string } | { name?: string }[] | null;
      const name = Array.isArray(group) ? group[0]?.name : group?.name;
      if (name) groupByCustomer.set(customer.tally_ledger_guid, name);
    }
  }
  for (const row of actionable) row.customerGroup = groupByCustomer.get(String(row.customerId ?? "")) ?? null;
  const summary = {
    schemeType: "cd", cdDiscountBasis: "amount_per_tonne", outcome: "completed", liveOnly: true, ...result.totals,
    invoicesChecked: result.results.length,
    notEligibleCount: result.results.length - actionable.length,
    // Not-eligible invoices are not stored one by one (size); the dashboard
    // needs them per quarter and group, so keep a compact tally:
    // "YYYY-MM|customer ledger GUID" -> [invoices, MT].
    notEligibleByMonth: result.results.filter((row) => row.category === "not_eligible").reduce<Record<string, [number, number]>>((tally, row) => {
      const key = `${String(row.invoiceDate ?? "").slice(0, 7)}|${String(row.customerId ?? "")}`;
      const entry: [number, number] = tally[key] ?? [0, 0];
      entry[0] += 1;
      entry[1] = Math.round((entry[1] + Number(row.eligibleTonnes ?? 0)) * 1000) / 1000;
      tally[key] = entry;
      return tally;
    }, {}),
    invoicePeriod: { from: batch.dateFrom, to: (bootstrap.voucherScope as { invoiceDateTo?: string }).invoiceDateTo ?? batch.dateTo },
    settlementResults: actionable,
  };
  const { error: snapshotError } = await supabase.rpc("replace_meenakshi_cd_settlement_snapshot", {
    p_company_id: run.company_id,
    p_evaluation_run_id: run.id,
    p_rule_version_id: rule.id,
    p_source_fingerprint: batch.sourceFingerprint,
    p_period_start: batch.dateFrom,
    p_period_end: batch.dateTo,
    p_candidates: result.candidates.map((candidate) => ({ ...candidate, evaluatedOn: bootstrap.evaluatedOn, customerTallyGuid: candidate.customerId, invoiceTallyGuid: candidate.invoiceGuid })),
    p_summary: summary,
  });
  if (snapshotError) throw snapshotError;

  // Credit Notes are never created automatically: staff create each one
  // from the Cash Discount page (cash-discount/settlements/[id]/credit-note).
  const autoQueued = 0;
  return { totals: { ...result.totals, autoQueued }, rule, evaluatedOn: bootstrap.evaluatedOn };
}

export async function completeLiveCdRun(run: EvaluationRunRecord, batch: LiveCdBatch) {
  const supabase = createSupabaseAdminClient();
  const { rule: selectedRule } = await loadLiveCdBatchRule(run, batch.ruleVersionId);
  if (selectedRule.schemeType === "cd" && selectedRule.cdDiscountBasis === "amount_per_tonne") return completeCdSettlementRun(run, batch);
  const { data: verifiedPostings, error: postingError } = await supabase
    .from("cash_discount_debit_note_postings")
    .select("verified_tally_guid, verified_voucher_number, verified_amount, amount, debit_note_date, calculation_reference, cash_discount_recovery_candidates!inner(invoice_tally_guid, customer_name, bill_reference)")
    .eq("company_id", run.company_id)
    .eq("status", "created_verified");
  if (postingError) throw postingError;
  const enrichedBatch = {
    ...batch,
    invoices: mergeVerifiedDebitNotes(batch.invoices, (verifiedPostings ?? []) as unknown as VerifiedDebitNotePosting[]),
  };
  const result = await evaluateLiveCdBatch(run, enrichedBatch);
  const compactSummary = {
    schemeType: "cd",
    outcome: "completed",
    liveOnly: true,
    ...result.totals,
    openReminderCandidates: result.reminders,
    results: result.results,
  };
  const candidatePayload = result.rows.map((row) => ({
    ...row,
    ruleVersionId: result.rule.id,
    sourceRunId: run.id,
    sourceFingerprint: batch.sourceFingerprint,
    evaluatedOn: result.evaluatedOn,
  }));
  const { error: snapshotError } = await supabase.rpc("replace_meenakshi_cd_recovery_snapshot", {
    p_company_id: run.company_id,
    p_evaluation_run_id: run.id,
    p_rule_version_id: result.rule.id,
    p_source_fingerprint: batch.sourceFingerprint,
    p_period_start: batch.dateFrom,
    p_period_end: batch.dateTo,
    p_candidates: candidatePayload,
    p_summary: compactSummary,
  });
  if (snapshotError && snapshotError.code !== "PGRST202" && snapshotError.code !== "42883") throw snapshotError;
  if (!snapshotError) {
    // Some existing database installations use an earlier version of the
    // snapshot RPC. It persists recovery candidates correctly, but its run
    // summary can omit fields that did not exist when it was installed (such
    // as openReminderCandidates). Write the full calculated summary here as
    // well, so a newly created invoice remains visible after page refresh.
    const { error } = await supabase.from("evaluation_runs").update({
      summary: compactSummary,
      updated_at: new Date().toISOString(),
    }).eq("id", run.id).eq("company_id", run.company_id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("evaluation_runs").update({
      status: "completed",
      scheme_version_id: result.rule.id,
      period_start: batch.dateFrom,
      period_end: batch.dateTo,
      source_fingerprint: batch.sourceFingerprint,
      summary: { ...compactSummary, results: result.rows },
      error_summary: null,
      completed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      lease_expires_at: null,
    }).eq("id", run.id).eq("company_id", run.company_id);
    if (error) throw error;
  }
  return result;
}
