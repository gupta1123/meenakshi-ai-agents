type RunStatus = { status: string; error_summary?: string | null };
const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isTransientTodReadError(cause: unknown) {
  if (!(cause instanceof Error) || cause.name === "AbortError") return false;
  if ("status" in cause && typeof cause.status === "number") {
    return [408, 429].includes(cause.status) || (cause.status >= 500 && cause.status < 600);
  }
  return cause.name === "TimeoutError" || /failed to fetch|fetch failed|networkerror|network error|load failed/i.test(cause.message);
}

// Use ONLY for GET/read operations. Never retry starting a Tally calculation
// or saving its result: a failed response does not prove the write failed.
export async function retryTodRead<T>(
  read: () => Promise<T>, sleep = sleepDefault, onRetry: () => void = () => {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await read(); }
    catch (cause) {
      if (!isTransientTodReadError(cause) || attempt >= 2) throw cause;
      onRetry();
      await sleep(2_000 * 2 ** attempt);
    }
  }
}

// Display refresh is not part of calculation success. Confirmed saved results
// must not be counted as failed or stop the next period because a list GET failed.
export async function refreshSavedTodResults(refresh: () => Promise<void>, onFailure: (cause: unknown) => void) {
  try { await refresh(); return true; }
  catch (cause) { onFailure(cause); return false; }
}

export type TodBatchProgress = { index: number; total: number; completed: number; start: string; end: string };

// A failed browser request does not prove that the connector is outdated.
// The original read may still be running, so never start a second cloud read
// unless the local API explicitly says the calculation route is absent.
export function canUseTodCloudFallback(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "LOCAL_ROUTE_NOT_FOUND";
}

export function tallyReadErrorMessage(value: string | null | undefined): string | null {
  if (/Tally.*(?:timed out|exceeded .*minutes)|Read active Tally company timed out/i.test(value ?? "")) {
    return "Tally did not respond in time. Keep the selected company open, wait for any active check to stop, then try one period again.";
  }
  if (/Tally is busy|Tally read.*already running/i.test(value ?? "")) {
    return "Another Tally check is still running. Wait for it to finish before starting another calculation.";
  }
  return null;
}

export async function waitForTodRun<T extends RunStatus>(
  read: () => Promise<T>,
  onStatus: (run: T) => void,
  sleep: (milliseconds: number) => Promise<void> = sleepDefault,
  onReadRetry: () => void = () => {},
) {
  for (let attempt = 0; attempt <= 40; attempt += 1) {
    if (attempt) await sleep(30_000);
    let run: T;
    try { run = await retryTodRead(read, sleep, onReadRetry); }
    catch (cause) {
      if (!isTransientTodReadError(cause)) throw cause;
      throw new Error("Could not confirm whether this period finished saving. It may still finish in the background. Check Run history before calculating again.");
    }
    onStatus(run);
    if (["failed", "completed_with_issues", "cancelled"].includes(run.status)) {
      throw new Error(tallyReadErrorMessage(run.error_summary) ?? "This calculation did not finish. Review Calculation history before starting another check.");
    }
    if (run.status === "completed") return run;
  }
  throw new Error("The customer results are still being finalized. Open Calculation history before trying again.");
}

export async function runTodPeriodsInOrder<T extends { start: string; end: string }>(
  periods: T[], calculate: (period: T) => Promise<void>, describeError: (cause: unknown) => string,
  onProgress: (progress: TodBatchProgress) => void = () => {},
) {
  let completed = 0;
  for (const period of periods) {
    onProgress({ index: completed + 1, total: periods.length, completed, start: period.start, end: period.end });
    try { await calculate(period); }
    catch (cause) {
      throw new Error(`${completed} of ${periods.length} periods completed. Stopped at ${period.start} to ${period.end}. ${describeError(cause)} Remaining periods were not started.`);
    }
    completed += 1;
    onProgress({ index: completed, total: periods.length, completed, start: period.start, end: period.end });
  }
}

export async function runExclusiveTodCalculation(
  gate: { current: boolean }, calculate: () => Promise<void>, onBusy: (busy: boolean) => void,
) {
  if (gate.current) throw new Error("Another Tally check is still running. Wait for it to finish before starting another calculation.");
  gate.current = true;
  onBusy(true);
  try { await calculate(); }
  finally { gate.current = false; onBusy(false); }
}
