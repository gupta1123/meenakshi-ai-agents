// Server mode: runs Cash Discount / Turnover Discount checks that web users
// queued in the backend. The PC connector never uses this file; it is only
// reached when config.mode === "server".
//
// The job's `request.body` is exactly what the web page sends to a PC
// connector today (rule, evaluatedOn, voucherScope, expectedCompany,
// periodStart/periodEnd), so the same readers and evaluators produce the same
// numbers.
import { canonicalJson, fetchLiveCdEvidence } from "./commands/live-cd-evidence.mjs";
import { fetchLiveTodEvidence } from "./commands/live-tod-evidence.mjs";
import { createCheckpoint } from "./checkpoint.mjs";
import { evaluateLocalCashDiscount } from "./local-cd-evaluator.mjs";
import { evaluateCashDiscountSettlements } from "./local-cd-settlement-evaluator.mjs";
import { evaluateLocalTurnoverDiscount } from "./local-tod-evaluator.mjs";
import { readNoteEInvoice } from "./tally/einvoice.mjs";
import { claimNextCheckJob, finishCheckJob, reportCheckJobProgress } from "./api-client.mjs";
import { logLine } from "./connector-log.mjs";

const PROGRESS_INTERVAL_MS = 20_000;

const defaultDeps = {
  fetchLiveCdEvidence, fetchLiveTodEvidence, createCheckpoint,
  evaluateLocalCashDiscount, evaluateCashDiscountSettlements, evaluateLocalTurnoverDiscount, readNoteEInvoice,
  claimNextCheckJob, reportCheckJobProgress, finishCheckJob,
};

function normalized(value) { return String(value ?? "").trim().toLowerCase(); }

export function companiesMatch(expected, active) {
  const expectedGuid = normalized(expected?.guid);
  const activeGuid = normalized(active?.guid);
  if (expectedGuid || activeGuid) return Boolean(expectedGuid && activeGuid) && expectedGuid === activeGuid;
  return normalized(expected?.name) !== "" && normalized(expected?.name) === normalized(active?.name);
}

/** Does the Tally company that is open match the one the job was queued for? */
export function assertRightCompany(job, activeCompany) {
  if (!companiesMatch(job.expectedTallyCompany, activeCompany)) {
    const error = new Error(`Tally has "${activeCompany?.name ?? "no company"}" open, but this check is for "${job.expectedTallyCompany?.name ?? "another company"}". Open the right company on the Tally server.`);
    error.failingStep = "tally_read";
    throw error;
  }
}

/**
 * Runs one claimed check job and returns the result in the same shape the PC
 * connector gives the browser: { ...calculation, evidence, durationMs, timings }.
 */
export async function runCheckJob(job, { config, activeCompany, isCancelled, onProgress, betweenWindows }, deps = defaultDeps) {
  assertRightCompany(job, activeCompany);
  if (job.kind === "einvoice") {
    // One company, one day, one voucher: a small read, so it needs no windows or checkpoint.
    const { date, voucherNumber, noteKind } = job.request ?? {};
    const started = performance.now();
    let einvoice;
    try {
      einvoice = await deps.readNoteEInvoice({ tallyUrl: config.tallyUrl, companyName: activeCompany.name, date, voucherNumber, kind: noteKind });
    } catch (error) {
      error.failingStep ??= "tally_read";
      throw error;
    }
    const tallyReadMs = Math.round(performance.now() - started);
    return { einvoice: einvoice ?? null, durationMs: tallyReadMs, timings: { tallyReadMs, calculationMs: 0 } };
  }
  const body = job.request?.body && typeof job.request.body === "object" ? job.request.body : null;
  if (!body || (job.kind !== "cd" && job.kind !== "tod")) {
    const error = new Error(`This server cannot run a "${job.kind}" check yet.`);
    error.failingStep = "tally_read";
    throw error;
  }
  const isCashDiscount = job.kind === "cd";
  const command = { payload: { evaluationRunId: null, voucherScope: body.voucherScope } };
  const readStarted = performance.now();
  // Resume after a restart: the checkpoint is keyed by company, scope and date.
  const checkpoint = isCashDiscount
    ? deps.createCheckpoint(canonicalJson({ company: activeCompany.guid || activeCompany.name, scope: body.voucherScope, evaluatedOn: body.evaluatedOn }))
    : null;
  let evidence;
  try {
    evidence = isCashDiscount
      ? await deps.fetchLiveCdEvidence(command, {
        config, activeCompany, isCancelled, onProgress, checkpoint, betweenWindows,
        onResume: (info) => logLine("WARN", "server check resumed after the connector stopped", { job: job.id, ...info }),
      }, null)
      : await deps.fetchLiveTodEvidence(command, { config, activeCompany, isCancelled });
  } catch (error) {
    // Stopped on purpose mid-window: keep the progress, but don't count it as a crash.
    if (isCancelled()) checkpoint?.settle();
    error.failingStep ??= "tally_read";
    throw error;
  }
  const tallyReadMs = Math.round(performance.now() - readStarted);
  checkpoint?.clear();
  if (isCancelled()) throw Object.assign(new Error("The check was stopped."), { cancelled: true });
  onProgress({ stage: "calculating" });
  const calcStarted = performance.now();
  let calculation;
  try {
    calculation = isCashDiscount
      ? body.rule?.cdDiscountBasis === "amount_per_tonne"
        ? deps.evaluateCashDiscountSettlements(body.rule, body.evaluatedOn, evidence.invoices)
        : deps.evaluateLocalCashDiscount(body.rule, body.evaluatedOn, evidence.invoices)
      : deps.evaluateLocalTurnoverDiscount(body.rule, body.evaluatedOn, body.periodStart, body.periodEnd, evidence.customerAggregates);
  } catch (error) {
    error.failingStep = "calculation";
    throw error;
  }
  const timings = { tallyReadMs, calculationMs: Math.round(performance.now() - calcStarted) };
  return { ...calculation, evidence, durationMs: timings.tallyReadMs + timings.calculationMs, timings };
}

/**
 * Claims and runs at most one queued check. `processCommand` lets a waiting
 * Credit Note run between read windows. Returns true when a job was handled.
 */
export async function processOneCheckJob(config, activeCompany, { processCommand = null } = {}, deps = defaultDeps) {
  if (!activeCompany) return false;
  const { job } = await deps.claimNextCheckJob(config);
  if (!job) return false;
  logLine("INFO", `server check started`, { job: job.id, kind: job.kind, attempt: job.attempt, requestedBy: job.requestedBy });
  let cancelRequested = false;
  let leaseLost = false;
  let progress = { stage: "reading", done: 0, total: null };
  let sending = false;
  const send = async () => {
    if (sending) return;
    sending = true;
    try {
      const answer = await deps.reportCheckJobProgress(config, job.id, progress);
      if (answer?.ok === false) leaseLost = true;
      if (answer?.cancelRequested) cancelRequested = true;
    } catch (error) {
      // A network blip is fine: the lease lasts 3 minutes. Only a refusal means the job is no longer ours.
      if (error?.status === 409 || error?.status === 404) leaseLost = true;
      logLine("WARN", `could not send check progress: ${error instanceof Error ? error.message : error}`, { job: job.id });
    } finally { sending = false; }
  };
  const timer = setInterval(() => { void send(); }, PROGRESS_INTERVAL_MS);
  timer.unref?.();
  const isCancelled = () => cancelRequested || leaseLost;
  try {
    const result = await runCheckJob(job, {
      config, activeCompany, isCancelled,
      onProgress: (update) => { progress = { ...progress, ...update }; },
      betweenWindows: processCommand
        ? async () => {
          await send();
          if (isCancelled()) return;
          // A waiting Credit Note is a side task: if looking for it fails (a network blip),
          // the check carries on and the note is picked up next time.
          try { await processCommand(); } catch (error) {
            logLine("WARN", `could not run a waiting Tally command between windows: ${error instanceof Error ? error.message : error}`, { job: job.id });
          }
        }
        : undefined,
    }, deps);
    clearInterval(timer);
    if (leaseLost) { logLine("WARN", "server check finished but the lease was lost; result dropped", { job: job.id }); return true; }
    await deps.finishCheckJob(config, job.id, { status: "succeeded", result });
    logLine("INFO", "server check finished", { job: job.id, ...result.timings });
  } catch (error) {
    clearInterval(timer);
    if (leaseLost) { logLine("WARN", "server check stopped: the lease was lost", { job: job.id }); return true; }
    const cancelled = Boolean(error?.cancelled) || cancelRequested;
    const reason = cancelled ? "Stopped by a user." : (error instanceof Error ? error.message : String(error));
    await deps.finishCheckJob(config, job.id, { status: cancelled ? "cancelled" : "failed", failingStep: error?.failingStep ?? "tally_read", failureReason: reason })
      .catch((finishError) => logLine("ERROR", `could not report the check ending: ${finishError instanceof Error ? finishError.message : finishError}`, { job: job.id }));
    logLine(cancelled ? "INFO" : "ERROR", `server check ${cancelled ? "stopped" : "failed"}: ${reason}`, { job: job.id });
  }
  return true;
}
