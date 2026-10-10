type RunStatus = { status: string; error_summary?: string | null };

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
  sleep: (milliseconds: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; attempt <= 40; attempt += 1) {
    if (attempt) await sleep(30_000);
    const run = await read();
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
) {
  let completed = 0;
  for (const period of periods) {
    try { await calculate(period); }
    catch (cause) {
      throw new Error(`${completed} of ${periods.length} periods completed. Stopped at ${period.start} to ${period.end}. ${describeError(cause)} Remaining periods were not started.`);
    }
    completed += 1;
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
