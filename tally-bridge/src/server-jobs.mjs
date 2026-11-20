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
import { claimNextCheckJob, finishCheckJob, reportCheckJobProgress, sendHeartbeat } from "./api-client.mjs";
import { BRIDGE_VERSION } from "./version.mjs";
import { logLine } from "./connector-log.mjs";
import { recordRuntimeActivity, recordRuntimeHeartbeat } from "./runtime-status.mjs";
import Decimal from "decimal.js";

const PROGRESS_INTERVAL_MS = 20_000;

const defaultDeps = {
  fetchLiveCdEvidence, fetchLiveTodEvidence, createCheckpoint,
  evaluateLocalCashDiscount, evaluateCashDiscountSettlements, evaluateLocalTurnoverDiscount, readNoteEInvoice,
  claimNextCheckJob, reportCheckJobProgress, finishCheckJob, sendHeartbeat,
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
  if (job.kind === "tod" && Array.isArray(body.batches)) {
    if (!body.batches.length || body.batches.length > 24) throw new Error("Invalid Turnover Discount period count.");
    const results = [];
    for (const batch of body.batches) {
      if (isCancelled()) throw Object.assign(new Error("The check was stopped."), { cancelled: true });
      results.push(await runCheckJob({ ...job, request: { body: { ...batch, evaluatedOn: body.evaluatedOn } } }, { config, activeCompany, isCancelled, onProgress, betweenWindows }, deps));
    }
    const first = results[0];
    return {
      rows: results.flatMap((r) => r.rows),
      totals: {
        customersChecked: results.reduce((n,r) => n + r.totals.customersChecked, 0),
        qualified: results.reduce((n,r) => n + r.totals.qualified, 0),
        needAttention: results.reduce((n,r) => n + r.totals.needAttention, 0),
        projectedDiscount: results.reduce((n,r) => n.plus(r.totals.projectedDiscount), new Decimal(0)).toFixed(2),
      },
      evidence: { ...first.evidence,
        chunks: results.reduce((n,r) => n + r.evidence.chunks, 0),
        vouchersScanned: results.reduce((n,r) => n + r.evidence.vouchersScanned, 0),
        matchingVouchers: results.reduce((n,r) => n + r.evidence.matchingVouchers, 0),
        sourceFingerprint: results.map((r) => r.evidence.sourceFingerprint).join(":"),
        customerAggregates: results.flatMap((r,i) => r.evidence.customerAggregates.map((a) => ({ ...a, periodStart: body.batches[i].periodStart, periodEnd: body.batches[i].periodEnd }))),
      },
      durationMs: results.reduce((n,r) => n + r.durationMs, 0),
      timings: { tallyReadMs: results.reduce((n,r) => n + r.timings.tallyReadMs, 0), calculationMs: results.reduce((n,r) => n + r.timings.calculationMs, 0) },
    };
  }
  const isCashDiscount = job.kind === "cd";
  const command = { payload: { evaluationRunId: null, voucherScope: body.voucherScope } };
  const readStarted = performance.now();
  // Resume after a restart: the checkpoint is keyed by company, scope and date.
  const checkpoint = isCashDiscount
    ? deps.createCheckpoint(canonicalJson({ evidenceVersion: 2, company: activeCompany.guid || activeCompany.name, scope: body.voucherScope, evaluatedOn: body.evaluatedOn }))
    : null;
  let evidence;
  try {
    evidence = isCashDiscount
      ? await deps.fetchLiveCdEvidence(command, {
        config, activeCompany, isCancelled, onProgress, checkpoint, betweenWindows,
        onResume: (info) => logLine("WARN", "server check resumed after the connector stopped", { job: job.id, ...info }),
      }, null)
      : await deps.fetchLiveTodEvidence(command, { config, activeCompany, isCancelled, onProgress, betweenWindows });
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
        ? deps.evaluateCashDiscountSettlements(body.rule, body.evaluatedOn, evidence.invoices, evidence.customerCredits ?? [])
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
  const activity = job.kind === "cd" ? "Checking Cash Discount" : job.kind === "tod" ? "Checking Turnover Discount" : "Reading an e-Invoice";
  recordRuntimeActivity(activity);
  let cancelRequested = false;
  let leaseLost = false;
  let progress = { stage: "reading", done: 0, total: null };
  let sending = false;
  let lastRenewedAt = Date.now();
  const send = async () => {
    if (sending) return;
    sending = true;
    try {
      const answer = await deps.reportCheckJobProgress(config, job.id, progress, job.attempt);
      if (answer?.ok === false) leaseLost = true;
      else lastRenewedAt = Date.now();
      if (answer?.cancelRequested) cancelRequested = true;
      if (!leaseLost) {
        const snapshot = {
        tallyReachable: true, companyLoaded: true, activeCompany,
        availableCompanies: [{ ...activeCompany, isActive: true }], companySnapshotFresh: false,
        };
        const cloud = await deps.sendHeartbeat(config, BRIDGE_VERSION, snapshot);
        recordRuntimeHeartbeat(snapshot, cloud);
      }
    } catch (error) {
      // A network blip is fine: the lease lasts 3 minutes. Only a refusal means the job is no longer ours.
      if ([401, 404, 409, 426].includes(error?.status)) leaseLost = true;
      logLine("WARN", `could not send check progress: ${error instanceof Error ? error.message : error}`, { job: job.id });
    } finally { sending = false; }
  };
  const timer = setInterval(() => { void send(); }, PROGRESS_INTERVAL_MS);
  timer.unref?.();
  const isCancelled = () => cancelRequested || leaseLost || Date.now() - lastRenewedAt >= 180_000;
  let calculated = false;
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
          } finally { recordRuntimeActivity(activity); }
        }
        : undefined,
    }, deps);
    calculated = true;
    await send();
    clearInterval(timer);
    if (isCancelled()) {
      if (cancelRequested) await deps.finishCheckJob(config, job.id, { status: "cancelled", attempt: job.attempt, failureReason: "Stopped by a user." });
      return true;
    }
    await deps.finishCheckJob(config, job.id, { status: "succeeded", result, attempt: job.attempt });
    logLine("INFO", "server check finished", { job: job.id, ...result.timings });
  } catch (error) {
    clearInterval(timer);
    if (calculated) { logLine("WARN", "result upload interrupted; the leased job can be recovered", { job: job.id, reason: String(error) }); return true; }
    if (leaseLost) { logLine("WARN", "server check stopped: the lease was lost", { job: job.id }); return true; }
    const cancelled = Boolean(error?.cancelled) || cancelRequested;
    const reason = cancelled ? "Stopped by a user." : (error instanceof Error ? error.message : String(error));
    await deps.finishCheckJob(config, job.id, { status: cancelled ? "cancelled" : "failed", attempt: job.attempt, failingStep: error?.failingStep ?? "tally_read", failureReason: reason })
      .catch((finishError) => logLine("ERROR", `could not report the check ending: ${finishError instanceof Error ? finishError.message : finishError}`, { job: job.id }));
    logLine(cancelled ? "INFO" : "ERROR", `server check ${cancelled ? "stopped" : "failed"}: ${reason}`, { job: job.id });
  } finally { recordRuntimeActivity("Waiting for work"); }
  return true;
}
