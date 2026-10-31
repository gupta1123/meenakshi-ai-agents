const LOCAL_TALLY_BASE = "http://127.0.0.1:3219";

/** A calculation that failed on this PC, with where it failed and how far it got. */
export class LocalCalculationError extends Error {
  constructor(message: string, readonly failedStep: "tally_read" | "calculation", readonly lastProgress: Record<string, unknown> | null = null, readonly timedOut = false) {
    super(message);
    this.name = "LocalCalculationError";
  }
}

async function postToLocalConnector<T>(path: string, body: unknown, timeoutMs: number, signal: AbortSignal | undefined, timeoutMessage: string, fallbackMessage: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${LOCAL_TALLY_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw new LocalCalculationError(timeoutMessage, "tally_read", null, cause.name === "TimeoutError");
    }
    throw new LocalCalculationError("The Meenakshi connector on this PC is offline. Open the Meenakshi Tally Connector, then calculate again.", "tally_read");
  }
  const payload = await response.json().catch(() => ({})) as T & { error?: string; failedStep?: string; lastProgress?: Record<string, unknown> | null };
  if (!response.ok) {
    throw new LocalCalculationError(payload.error || fallbackMessage, payload.failedStep === "calculation" ? "calculation" : "tally_read", payload.lastProgress ?? null);
  }
  return payload;
}

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

/** Version of the connector running on this PC; null if it is not reachable or is an older build. */
export async function readLocalConnectorVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${LOCAL_TALLY_BASE}/v1/identity`, { cache: "no-store", signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const payload = await response.json() as { version?: unknown };
    return typeof payload.version === "string" ? payload.version.slice(0, 40) : null;
  } catch { return null; }
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
  // A per-MT rule reads every invoice since its effective date: 18 months is
  // about 55 batches and 10 minutes. The page shows batch progress meanwhile.
  return postToLocalConnector<LocalCdResult>("/v1/cash-discount", bootstrap, 1_800_000, signal,
    "Tally didn't finish within 30 minutes. Try a shorter period or check Tally.", "The local Tally connector could not complete the Cash Discount check.");
}

export type LocalTodBootstrap = {
  evaluatedOn: string;
  expectedCompany: { name: string; guid: string };
  activeSchemeVersionId: string;
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
  // A completed quarter can contain materially more vouchers than the live
  // projection; give Tally time to finish its paced read.
  return postToLocalConnector<LocalTodResult>("/v1/turnover-discount", { ...batch, evaluatedOn: bootstrap.evaluatedOn, expectedCompany: bootstrap.expectedCompany }, 600_000, signal,
    "Tally didn't answer within 10 minutes. Check that Tally is responding, then calculate again.", "The local Tally connector could not complete the Turnover Discount calculation.");
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
        periodStart: bootstrap.batches[index].periodStart,
        periodEnd: bootstrap.batches[index].periodEnd,
      }))),
    },
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
  };
}

export type LocalProgress = {
  task: "cash_discount" | "turnover_discount";
  stage: "reading" | "calculating" | "done" | "failed";
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
