import { assertSelectedTodPeriod } from "./tod-results";

const LOCAL_TALLY_BASE = "http://127.0.0.1:3219";

export async function detectLocalTallyConnector(signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(`${LOCAL_TALLY_BASE}/v1/identity`, {
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { connectorId?: unknown };
    return typeof payload.connectorId === "string" && /^[0-9a-f-]{36}$/i.test(payload.connectorId)
      ? payload.connectorId
      : null;
  } catch {
    return null;
  }
}

export type LocalCdBootstrap = {
  evaluatedOn: string;
  expectedCompany: { name: string; guid: string };
  rule: Record<string, unknown>;
  voucherScope: Record<string, unknown>;
};

export type LocalCdRow = {
  customerTallyGuid: string; customerName: string; sourceSalesLedgerName: string | null;
  invoiceTallyGuid: string; invoiceNumber: string | null; invoiceDate: string; billReference: string;
  netInvoiceAmount: string; impliedGrossAmount: string; amountPaid: string;
  grantedDiscountPercentage: string; earnedDiscountPercentage: string; recoveryRequired: string;
  alreadyRecovered: string; remainingRecovery: string; missedWindowWorkingDays: number; missedWindowDeadline: string;
  nextWindowWorkingDays: number | null; nextWindowPercentage: string | null; status: "action_required" | "review_required";
  reasonCode: string; reviewMessage: string | null;
  narration: { checked: boolean; mentioned: boolean; matches: boolean };
  debitNoteReferences: Array<{ tallyGuid: string; voucherNumber: string | null; voucherDate: string; amount: string }>;
};

export type LocalCdInvoiceCheck = {
  customerName: string; invoiceGuid: string; invoiceNumber: string | null; invoiceDate: string;
  invoiceAmount: string; amountPaid: string; outstandingAmount: string;
  discountPercentage: string; earnedDiscountPercentage: string; eligibilityDeadline: string;
  status: "retained" | "payment_due" | "recovery_due" | "recovered" | "needs_review";
  paymentCount: number; latestPaymentDate: string | null; reviewMessage: string | null;
};

export type LocalCdResult = {
  rows: LocalCdRow[];
  results: LocalCdInvoiceCheck[];
  totals: { invoicesChecked: number; actionRequired: number; reviewRequired: number; recoveryAmount: string; alreadyRecovered: string };
  evidence: Record<string, unknown>;
  durationMs: number;
};

export async function runLocalCashDiscount(bootstrap: LocalCdBootstrap, signal?: AbortSignal): Promise<LocalCdResult> {
  const response = await fetch(`${LOCAL_TALLY_BASE}/v1/cash-discount`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bootstrap),
    cache: "no-store",
    // A per-MT rule reads every invoice since its effective date: 18 months is
    // about 55 batches and 10 minutes. The page shows batch progress meanwhile;
    // aborting early leaves the export running anyway.
    signal: signal ?? AbortSignal.timeout(1_800_000),
  });
  const payload = await response.json().catch(() => ({})) as LocalCdResult & { error?: string };
  if (!response.ok) throw new Error(payload.error || "The local Tally connector could not complete the Cash Discount check.");
  return payload;
}

export type LocalTodBootstrap = {
  evaluatedOn: string;
  expectedCompany: { name: string; guid: string };
  activeSchemeVersionId: string;
  periodStart: string;
  periodEnd: string;
  periods: LocalTodPeriod[];
  batches: LocalTodBatchBootstrap[];
};

export type LocalTodPeriod = {
  key: string;
  start: string;
  end: string;
  state: "completed" | "current" | "upcoming";
};

export type LocalTodBatchBootstrap = {
  periodStart: string;
  periodEnd: string;
  rule: Record<string, unknown>;
  customers: Array<{ customerId: string; ledgerName: string }>;
  voucherScope: Record<string, unknown>;
};

export type LocalTodRow = {
  customerId: string; customerName: string; periodStart: string; periodEnd: string;
  schemeVersionId: string; entitlementKey: string; eligibleProductTaxableValue: string; eligibleTonnes: string;
  achievedTierId: string | null; nextTierTonnes: string | null; additionalTonnesRequired: string | null;
  discountPercentage: string | null; calculatedDiscountAmount: string; eligibilityDeadline: string | null;
  status: "tracking" | "eligible" | "needs_review"; reasonCodes: string[];
};

export type LocalTodBatchEvidence = {
  mode: "live_tod_batch_aggregate"; evaluationRunId: string | null; periodStart: string; periodEnd: string;
  chunks: number; vouchersScanned: number; matchingVouchers: number; sourceFingerprint: string;
  customerAggregates: Array<Record<string, unknown> & { customerId: string; customerLedgerName: string; eligibleTaxableValue: string; eligibleTonnes: string; missingUnits: string[]; periodStart?: string; periodEnd?: string }>;
};

export type LocalTodResult = {
  rows: LocalTodRow[];
  totals: { customersChecked: number; qualified: number; needAttention: number; projectedDiscount: string };
  evidence: LocalTodBatchEvidence;
  durationMs: number;
};

async function runLocalTurnoverDiscountBatch(bootstrap: LocalTodBootstrap, batch: LocalTodBatchBootstrap, signal?: AbortSignal): Promise<LocalTodResult> {
  const response = await fetch(`${LOCAL_TALLY_BASE}/v1/turnover-discount`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...batch, evaluatedOn: bootstrap.evaluatedOn, expectedCompany: bootstrap.expectedCompany }),
    cache: "no-store",
    // A completed quarter can contain materially more vouchers than the live
    // projection. Give Tally enough time to finish its chunked read instead of
    // turning a healthy, long-running calculation into a false failure.
    signal: signal ?? AbortSignal.timeout(180_000),
  });
  const payload = await response.json().catch(() => ({})) as LocalTodResult & { error?: string };
  if (!response.ok) throw new Error(payload.error || "The local Tally connector could not complete the Turnover Discount calculation.");
  assertSelectedTodPeriod({ start: batch.periodStart, end: batch.periodEnd }, [payload.evidence, ...payload.rows]);
  return payload;
}

export async function runLocalTurnoverDiscount(bootstrap: LocalTodBootstrap, signal?: AbortSignal): Promise<LocalTodResult> {
  if (!bootstrap.batches.length) throw new Error("No eligible Turnover Discount customers are available for the current rule.");
  // The local Tally connector has one active company context. Running two
  // periods at the same time can make their Tally responses cross over, so
  // calculate each locked-period batch in order.
  const results: LocalTodResult[] = [];
  for (const batch of bootstrap.batches) results.push(await runLocalTurnoverDiscountBatch(bootstrap, batch, signal));
  const primary = results[0];
  return {
    rows: results.flatMap((result) => result.rows),
    totals: results.reduce((total, result) => ({
      customersChecked: total.customersChecked + result.totals.customersChecked,
      qualified: total.qualified + result.totals.qualified,
      needAttention: total.needAttention + result.totals.needAttention,
      projectedDiscount: String(Number(total.projectedDiscount) + Number(result.totals.projectedDiscount)),
    }), { customersChecked: 0, qualified: 0, needAttention: 0, projectedDiscount: "0" }),
    evidence: {
      mode: "live_tod_batch_aggregate",
      evaluationRunId: null,
      // Every individual customer aggregate below has its own authoritative
      // period. These top-level values preserve backwards compatibility with
      // the existing batch payload shape.
      periodStart: primary.evidence.periodStart,
      periodEnd: primary.evidence.periodEnd,
      chunks: results.reduce((total, result) => total + result.evidence.chunks, 0),
      vouchersScanned: results.reduce((total, result) => total + result.evidence.vouchersScanned, 0),
      matchingVouchers: results.reduce((total, result) => total + result.evidence.matchingVouchers, 0),
      sourceFingerprint: results.map((result) => result.evidence.sourceFingerprint).join(":"),
      customerAggregates: results.flatMap((result, index) => result.evidence.customerAggregates.map((aggregate) => ({
        ...aggregate,
        periodStart: result.evidence.periodStart,
        periodEnd: result.evidence.periodEnd,
        schemeVersionId: String(bootstrap.batches[index].rule.id),
      }))),
    },
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
  };
}

export type LocalProgress = {
  task: "cash_discount" | "turnover_discount";
  stage: "reading" | "calculating";
  done: number;
  total: number | null;
  from: string | null;
  to: string | null;
  nextDate?: string | null;
  vouchersScanned?: number;
  startedAt: string;
};

/** Progress of the calculation the local connector is running; null if none or unsupported. */
export async function readLocalProgress(signal?: AbortSignal): Promise<LocalProgress | null> {
  try {
    const response = await fetch(`${LOCAL_TALLY_BASE}/v1/progress`, { cache: "no-store", signal: signal ?? AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const payload = await response.json() as { progress?: LocalProgress | null };
    return payload.progress ?? null;
  } catch { return null; }
}

export type LocalNoteEInvoice = { irn: string; ackNo: string; ackDate: string | null; signedQr: string };

/**
 * IRN / Ack No. / Ack Date / signed QR of one Credit or Debit Note, read from
 * Tally by the connector on this PC (one company, one day). Returns null when
 * the note is not e-invoiced yet; throws when the connector or Tally is not ready.
 */
export async function readLocalNoteEInvoice(input: { expectedCompany: { guid?: string | null; name?: string | null }; date: string; voucherNumber: string; kind: "credit" | "debit" }): Promise<LocalNoteEInvoice | null> {
  const response = await fetch(`${LOCAL_TALLY_BASE}/v1/einvoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
    signal: AbortSignal.timeout(40_000),
  });
  const payload = await response.json().catch(() => ({})) as { einvoice?: LocalNoteEInvoice | null; error?: string };
  if (!response.ok) throw new Error(payload.error || "The local Tally connector could not read the e-Invoice.");
  return payload.einvoice ?? null;
}
