import { apiRequest } from "@/lib/api";

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


// --- Server mode -------------------------------------------------------------
// When a company's Tally connector runs on a permanent server, the page cannot
// reach it directly. Checks are queued in the cloud instead and followed from
// there. PC-mode companies never set this context, so they keep the code path above.
export type ServerCheckContext = { companyId: string; getToken: () => Promise<string | null> };
let serverContext: ServerCheckContext | null = null;
let lookupMode: (() => Promise<void>) | null = null;
let serverProgress: LocalProgress | null = null;

/** Called by the page once it knows the company's mode (null = PC mode). */
export function setServerCheckContext(context: ServerCheckContext | null) { serverContext = context; if (!context) serverProgress = null; }
/** Lets runs wait for the page's mode lookup instead of racing it. */
export function setServerModeLookup(lookup: () => Promise<void>) { lookupMode = lookup; }

async function runServerJob<T>(task: "cash_discount" | "turnover_discount", body: Record<string, unknown>, overallTimeoutMs: number, options: LocalRunOptions | undefined, timeoutMessage: string): Promise<T> {
  if (options?.signal?.aborted) throw new LocalCalculationError("The check was cancelled.", "tally_read");
  const context = serverContext!;
  const token = async () => { const value = await context.getToken(); if (!value) throw new LocalCalculationError("You are signed out. Sign in again, then calculate.", "tally_read"); return value; };
  const base = `/api/companies/${context.companyId}/check-jobs`;
  const serverSave = options?.serverSave ?? (task === "cash_discount" ? {} : undefined);
  const input = task === "cash_discount"
    ? { kind: "cd", body, ...(serverSave ? { save: true } : {}) }
    : { kind: "tod", periodStart: String(body.periodStart), periodEnd: String(body.periodEnd), body, ...(serverSave?.asOfDate ? { saveAsOfDate: serverSave.asOfDate } : {}) };
  let created: { job: { id: string }; joined: boolean; queuePosition: number };
  try {
    created = await apiRequest(await token(), base, { method: "POST", body: JSON.stringify(input), timeoutMs: 30_000 });
  } catch (cause) {
    throw new LocalCalculationError(cause instanceof Error ? cause.message : "Could not start the check on the Tally server.", "tally_read");
  }
  const jobId = created.job.id;
  const stop = () => { void token().then((t) => apiRequest(t, `${base}/${jobId}/cancel`, { method: "POST", timeoutMs: 10_000 })).catch(() => {}); };
  const started = Date.now();
  let offlineSince: number | null = null;
  let attempt = 0;
  try {
    for (;;) {
      if (options?.signal?.aborted) { stop(); throw new LocalCalculationError("The check was cancelled.", "tally_read"); }
      if (Date.now() - started > overallTimeoutMs) { throw new LocalCalculationError(timeoutMessage, "tally_read", null, true); }
      await sleep(2_000);
      type ServerJob = { status: string; progress?: Partial<LocalProgress> | null; result?: T | null; failure_reason?: string | null; failing_step?: string | null; started_at?: string | null };
      let state: { job: ServerJob; queuePosition: number };
      try {
        state = await apiRequest(await token(), `${base}/${jobId}`, { timeoutMs: 10_000 });
        if (offlineSince !== null) { offlineSince = null; attempt = 0; options?.onReconnecting?.(null); }
      } catch (cause) {
        if (cause instanceof LocalCalculationError) throw cause;
        offlineSince ??= Date.now();
        attempt += 1;
        const offlineMs = Date.now() - offlineSince;
        options?.onReconnecting?.({ attempt, offlineMs });
        if (offlineMs > 3 * 60_000) { options?.onReconnecting?.(null); throw new LocalCalculationError("Lost contact with Meenakshi for over 3 minutes. The check keeps running on the Tally server: press Calculate to pick it back up.", "tally_read"); }
        continue;
      }
      const { job, queuePosition } = state;
      if (job.status === "queued") {
        // After a reboot Tally is opened by hand, so say plainly why a check is waiting.
        const readiness = await apiRequest<{ message?: string | null }>(await token(), `${base}/mode`, { timeoutMs: 8_000 }).catch(() => null);
        const ahead = queuePosition > 0 ? `${queuePosition} check${queuePosition === 1 ? "" : "s"} ahead of yours. ` : "";
        options?.onStatus?.(readiness?.message ? `Waiting. ${ahead}${readiness.message}` : queuePosition > 0 ? `Waiting for the Tally server — ${ahead.trim()}` : "Waiting for the Tally server to pick this up…");
        continue;
      }
      if (job.status === "running") {
        options?.onStatus?.(null);
        const p = job.progress ?? {};
        serverProgress = { task, stage: p.stage ?? "reading", done: p.done ?? 0, total: p.total ?? null, from: p.from ?? null, to: p.to ?? null, nextDate: p.nextDate ?? null, vouchersScanned: p.vouchersScanned, startedAt: job.started_at ?? new Date(started).toISOString() };
        continue;
      }
      options?.onStatus?.(null);
      if (job.status === "succeeded" && job.result) {
        const savedOnServer = serverSave ? await waitForServerSave(base, jobId, token, options) : null;
        return (savedOnServer ? { ...job.result, savedOnServer } : job.result) as T;
      }
      throw new LocalCalculationError(job.failure_reason || "The check did not finish.", job.failing_step === "calculation" ? "calculation" : "tally_read");
    }
  } finally { serverProgress = null; }
}

export type ServerSaved = { evaluationRunId: string; totals?: { autoQueued?: number } & Record<string, unknown> };

/**
 * Server mode saves the result itself when the check finishes (so it is saved
 * even if this page closes). Wait for that; null means the page must save it.
 */
async function waitForServerSave(base: string, jobId: string, token: () => Promise<string>, options: LocalRunOptions | undefined): Promise<ServerSaved | null> {
  const started = Date.now();
  options?.onStatus?.("Saving the result on the server…");
  try {
    while (Date.now() - started < 15 * 60_000) {
      type SaveState = { state: "saving" | "saved" | "failed"; evaluationRunId?: string; totals?: ServerSaved["totals"] };
      const state = await apiRequest<{ job: { progress?: { save?: SaveState } | null } }>(await token(), `${base}/${jobId}?result=0`, { timeoutMs: 10_000 }).catch(() => null);
      const save = state?.job.progress?.save;
      if (save?.state === "saved" && save.evaluationRunId) return { evaluationRunId: save.evaluationRunId, totals: save.totals };
      if (save?.state === "failed") throw new Error("The server could not save this check after retrying. Contact the administrator before starting another check.");
      await sleep(2_000);
    }
    throw new Error("The server is still saving this check. You can reopen the page later to see the result.");
  } finally { options?.onStatus?.(null); }
}

export type ReconnectState = { attempt: number; offlineMs: number } | null;
export type LocalRunOptions = { signal?: AbortSignal; onReconnecting?: (state: ReconnectState) => void; /** Server mode: a plain-language waiting message, or null when it clears. */ onStatus?: (message: string | null) => void; /** Server mode: the server saves the result itself (TOD: under this as-of date). */ serverSave?: { asOfDate?: string } };

const MAX_OFFLINE_MS = 3 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Runs a check as a background job inside the connector and follows it. A
 * dropped page, reload or short network blip no longer loses the read: the
 * page keeps trying to reach the connector and picks the job back up.
 */
async function runLocalJob<T>(task: "cash_discount" | "turnover_discount", body: Record<string, unknown>, overallTimeoutMs: number, options: LocalRunOptions | undefined, legacy: () => Promise<T>, timeoutMessage: string): Promise<T> {
  await lookupMode?.();
  if (options?.signal?.aborted) throw new LocalCalculationError("The check was cancelled.", "tally_read");
  if (serverContext) return runServerJob<T>(task, body, overallTimeoutMs, options, timeoutMessage);
  const begin = async (): Promise<string | "legacy"> => {
    try {
      const response = await fetch(`${LOCAL_TALLY_BASE}/v1/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, task }), cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      // An older connector has no job routes; use the single long request instead.
      if (response.status === 404) return "legacy";
      const payload = await response.json().catch(() => ({})) as { jobId?: string; jobTask?: string; error?: string; failedStep?: string };
      if (response.status === 409 && payload.jobId && payload.jobTask === task) return payload.jobId; // a check is already running: follow it
      if (!response.ok || !payload.jobId) throw new LocalCalculationError(payload.error || "The connector could not start the check.", "tally_read");
      return payload.jobId;
    } catch (cause) {
      if (cause instanceof LocalCalculationError) throw cause;
      throw new LocalCalculationError("The Meenakshi connector on this PC is offline. Open the Meenakshi Tally Connector, then calculate again.", "tally_read");
    }
  };
  const first = await begin();
  if (first === "legacy") return legacy();
  let jobId: string = first;
  let restarts = 0;

  const started = Date.now();
  let offlineSince: number | null = null;
  let attempt = 0;
  for (;;) {
    if (options?.signal?.aborted) {
      void fetch(`${LOCAL_TALLY_BASE}/v1/jobs/${jobId}`, { method: "DELETE", cache: "no-store", signal: AbortSignal.timeout(5_000) }).catch(() => {});
      throw new LocalCalculationError("The check was cancelled.", "tally_read");
    }
    if (Date.now() - started > overallTimeoutMs) {
      void fetch(`${LOCAL_TALLY_BASE}/v1/jobs/${jobId}`, { method: "DELETE", cache: "no-store", signal: AbortSignal.timeout(5_000) }).catch(() => {});
      throw new LocalCalculationError(timeoutMessage, "tally_read", null, true);
    }
    await sleep(1_500);
    type JobSummary = { status: string; error?: string | null; failedStep?: string | null; lastProgress?: Record<string, unknown> | null };
    let fetched = null as JobSummary | null;
    try {
      const response = await fetch(`${LOCAL_TALLY_BASE}/v1/jobs/${jobId}`, { cache: "no-store", signal: AbortSignal.timeout(6_000) });
      if (response.status === 404) {
        // The connector program restarted and lost the running check. It saves its
        // progress after every batch, so starting the same check again resumes it.
        if (restarts >= 3) throw new LocalCalculationError("The connector keeps restarting while it reads Tally, so the check could not finish. Send the connector log to support.", "tally_read");
        restarts += 1;
        const next = await begin();
        if (next === "legacy") throw new LocalCalculationError("The connector was restarted, so this check was lost. Calculate again.", "tally_read");
        jobId = next;
        continue;
      }
      const payload = await response.json() as { job: JobSummary };
      fetched = payload.job;
      if (offlineSince !== null) { offlineSince = null; attempt = 0; options?.onReconnecting?.(null); }
    } catch (cause) {
      if (cause instanceof LocalCalculationError) throw cause;
      offlineSince ??= Date.now();
      attempt += 1;
      const offlineMs = Date.now() - offlineSince;
      options?.onReconnecting?.({ attempt, offlineMs });
      if (offlineMs > MAX_OFFLINE_MS) {
        options?.onReconnecting?.(null);
        throw new LocalCalculationError("Lost contact with the connector on this PC for over 3 minutes. If it is still open, the check keeps running there: press Calculate to pick it back up.", "tally_read");
      }
      continue;
    }
    const summary = fetched as JobSummary;
    if (summary.status === "running") continue;
    if (summary.status === "done") {
      for (let tries = 0; ; tries += 1) {
        try {
          const response = await fetch(`${LOCAL_TALLY_BASE}/v1/jobs/${jobId}/result`, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
          if (!response.ok) throw new Error("result");
          return await response.json() as T;
        } catch {
          if (tries >= 4) throw new LocalCalculationError("The check finished but its result could not be fetched from the connector. Calculate again.", "tally_read");
          options?.onReconnecting?.({ attempt: tries + 1, offlineMs: 0 });
          await sleep(2_000);
        }
      }
    }
    throw new LocalCalculationError(summary.error || "The check did not finish.", summary.failedStep === "calculation" ? "calculation" : "tally_read", summary.lastProgress ?? null);
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
  /** Server mode: the server already saved this result as an evaluation run. */
  savedOnServer?: ServerSaved | null;
  rows: LocalCdRow[];
  results: LocalCdInvoiceCheck[];
  totals: { invoicesChecked: number; actionRequired: number; reviewRequired: number; recoveryAmount: string; alreadyRecovered: string };
  evidence: Record<string, unknown>;
  durationMs: number;
};

export async function runLocalCashDiscount(bootstrap: LocalCdBootstrap, signal?: AbortSignal, options?: LocalRunOptions): Promise<LocalCdResult> {
  // A per-MT rule reads every invoice since its effective date: 18 months is
  // about 55 batches and 10 minutes. The page shows batch progress meanwhile.
  const timeoutMessage = "Tally didn't finish within 30 minutes. Try a shorter period or check Tally.";
  return runLocalJob<LocalCdResult>("cash_discount", bootstrap as unknown as Record<string, unknown>, 1_800_000, { ...options, signal: options?.signal ?? signal },
    () => postToLocalConnector<LocalCdResult>("/v1/cash-discount", bootstrap, 1_800_000, signal, timeoutMessage, "The local Tally connector could not complete the Cash Discount check."),
    timeoutMessage);
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
  calculated?: boolean;
};

/** Prepare every selected period before submitting one durable server job. */
export function combineTodBootstraps(bootstraps: LocalTodBootstrap[]): LocalTodBootstrap {
  const first = bootstraps[0];
  if (!first) throw new Error("Choose at least one Turnover Discount period.");
  for (const bootstrap of bootstraps) {
    if (bootstrap.expectedCompany.guid !== first.expectedCompany.guid || bootstrap.activeSchemeVersionId !== first.activeSchemeVersionId || bootstrap.evaluatedOn !== first.evaluatedOn) {
      throw new Error("The company or active rule changed while preparing the periods. Reopen Calculate period and try again.");
    }
  }
  const batches = bootstraps.flatMap((bootstrap) => bootstrap.batches);
  if (!batches.length || batches.length > 24) throw new Error("Choose up to 24 Turnover Discount calculation periods at a time.");
  return { ...first, batches };
}

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
  /** Server mode: the server already saved this result as an evaluation run. */
  savedOnServer?: ServerSaved | null;
  rows: LocalTodRow[];
  totals: { customersChecked: number; qualified: number; needAttention: number; projectedDiscount: string };
  evidence: LocalTodBatchEvidence;
  durationMs: number;
};

async function runLocalTurnoverDiscountBatch(bootstrap: LocalTodBootstrap, batch: LocalTodBatchBootstrap, signal?: AbortSignal, options?: LocalRunOptions): Promise<LocalTodResult> {
  // A completed quarter can contain materially more vouchers than the live
  // projection; give Tally time to finish its paced read.
  const body = { ...batch, evaluatedOn: bootstrap.evaluatedOn, expectedCompany: bootstrap.expectedCompany };
  const timeoutMessage = "Tally didn't answer within 15 minutes. Check that Tally is responding, then calculate again.";
  return runLocalJob<LocalTodResult>("turnover_discount", body, 900_000, { ...options, signal: options?.signal ?? signal },
    () => postToLocalConnector<LocalTodResult>("/v1/turnover-discount", body, 600_000, signal, timeoutMessage, "The local Tally connector could not complete the Turnover Discount calculation."),
    timeoutMessage);
}

export async function runLocalTurnoverDiscount(bootstrap: LocalTodBootstrap, signal?: AbortSignal, options?: LocalRunOptions): Promise<LocalTodResult> {
  if (!bootstrap.batches.length) throw new Error("No eligible Turnover Discount customers are available for the current rule.");
  await lookupMode?.();
  if (serverContext) {
    const periodStart = bootstrap.batches.map((b) => b.periodStart).sort()[0];
    const periodEnd = bootstrap.batches.map((b) => b.periodEnd).sort().at(-1)!;
    return runServerJob<LocalTodResult>("turnover_discount", { ...bootstrap, periodStart, periodEnd }, Math.max(1_800_000, bootstrap.batches.length * 900_000),
      { ...options, signal: options?.signal ?? signal, serverSave: options?.serverSave ?? { asOfDate: bootstrap.evaluatedOn } },
      "The Tally server is still checking these periods. Reopen the page later to see the saved result.");
  }
  // The local Tally connector has one active company context. Running two
  // periods at the same time can make their Tally responses cross over, so
  // calculate each locked-period batch in order.
  const results: LocalTodResult[] = [];
  const batchOptions = options;
  for (const batch of bootstrap.batches) results.push(await runLocalTurnoverDiscountBatch(bootstrap, batch, signal, batchOptions));
  const primary = results[0];
  return {
    savedOnServer: results.length === 1 ? results[0].savedOnServer : undefined,
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
  if (serverContext) return serverProgress;
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
  await lookupMode?.();
  if (serverContext) {
    // Server mode: ask the Tally server through the cloud queue (a small read, answered in seconds).
    const context = serverContext;
    const token = await context.getToken();
    if (!token) throw new Error("You are signed out. Sign in again.");
    const base = `/api/companies/${context.companyId}/check-jobs`;
    const created = await apiRequest<{ job: { id: string } }>(token, base, { method: "POST", body: JSON.stringify({ kind: "einvoice", noteKind: input.kind, date: input.date, voucherNumber: input.voucherNumber }), timeoutMs: 20_000 });
    const started = Date.now();
    while (Date.now() - started < 90_000) {
      await sleep(1_500);
      const state = await apiRequest<{ job: { status: string; result?: { einvoice?: LocalNoteEInvoice | null } | null; failure_reason?: string | null } }>(token, `${base}/${created.job.id}`, { timeoutMs: 10_000 });
      if (state.job.status === "succeeded") return state.job.result?.einvoice ?? null;
      if (state.job.status === "failed" || state.job.status === "cancelled" || state.job.status === "expired") throw new Error(state.job.failure_reason || "The Tally server could not read the e-Invoice.");
    }
    throw new Error("The Tally server did not answer in time. Try again in a moment.");
  }
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
