"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, RefreshCw, Square } from "lucide-react";

import { apiRequest } from "@/lib/api";
import { userFacingDetail, userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import type { EvaluationRun } from "./types";
import { Button, Card, EmptyState, Skeleton, StatusBadge, formatDate, formatMoney } from "./ui";
import { accessToken } from "./workspace";

type Props = {
  scheme: "cd" | "tod";
  latestRun: EvaluationRun | null;
  onError: (message: string | null) => void;
  onRetry: () => void;
  onViewResults: (run: EvaluationRun, isLatest: boolean) => void;
  onSettled: (run: EvaluationRun) => void | Promise<void>;
};

function periodLabel(run: EvaluationRun) {
  const dateOnly = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" });
  if ((run.periods?.length ?? 0) > 1) return `${run.periods!.length} customer periods`;
  return run.period_start && run.period_end ? `${dateOnly(run.period_start)} – ${dateOnly(run.period_end)}` : "Period unavailable";
}

function progressLabel(run: EvaluationRun) {
  const total = run.total_jobs ?? 1;
  const complete = run.completed_jobs ?? (run.status === "completed" ? total : 0);
  if (run.active_jobs) return `${complete} of ${total} customers checked`;
  if (run.failed_jobs) return `${complete} completed · ${run.failed_jobs} need attention`;
  return `${complete} customer${complete === 1 ? "" : "s"} checked`;
}

function runStatus(run: EvaluationRun, resolved: boolean) {
  if (run.status === "completed") return { label: "Completed", tone: "success" };
  if (run.status === "cancelled") return { label: "Stopped", tone: "resolved" };
  if (resolved) return { label: "Resolved", tone: "resolved" };
  if (["failed", "completed_with_issues"].includes(run.status)) return { label: "Needs attention", tone: "attention" };
  return { label: "Running", tone: "running" };
}

function shortReference(run: EvaluationRun) {
  return (run.run_reference?.split("-").at(-1) ?? run.id.slice(0, 4)).toUpperCase();
}

function durationLabel(run: EvaluationRun) {
  if (!run.completed_at) return "Started and waiting for completion";
  const started = new Date(run.started_at ?? run.created_at).getTime();
  const completed = new Date(run.completed_at).getTime();
  const seconds = Math.max(0, Math.round((completed - started) / 1_000));
  if (!Number.isFinite(seconds)) return `Finished ${formatDate(run.completed_at)}`;
  if (seconds < 60) return `Completed in ${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `Completed in ${minutes}m${remainder ? ` ${remainder}s` : ""}`;
}

export function GuidedEvaluationQueue({ scheme, latestRun, onError, onRetry, onViewResults, onSettled }: Props) {
  const { company, companyKey } = useCompany();
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<"all" | "successful" | "attention">("all");
  const [historyPage, setHistoryPage] = useState(1);
  const [stopping, setStopping] = useState(false);
  const inFlight = useRef(false);
  const settledRunIds = useRef(new Set<string>());
  const load = useCallback(async (fresh = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = await accessToken();
    if (!token) { inFlight.current = false; return; }
    try {
      // Batch TOD runs are stored as one parent plus many customer jobs. Fetch
      // enough rows before collapsing them so history is not silently limited
      // to the first few parent calculations.
      const response = await apiRequest<{ evaluationRuns: EvaluationRun[] }>(token, `/api/companies/${company.id}/evaluations/runs?schemeType=${scheme}&limit=500${fresh ? "&fresh=1" : ""}`);
      setRuns(response.evaluationRuns);
      onError(null);
    } catch (cause) {
      onError(userFacingError(cause, "Could not load evaluations in progress."));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [company.id, onError, scheme]);

  // The parent refreshes latestRun while a calculation is saving. React to a new
  // run only (its id), and add it to the list instead of replacing the list,
  // otherwise history flickers between that one run and all runs.
  const latestRunRef = useRef(latestRun);
  latestRunRef.current = latestRun;
  const latestRunId = latestRun?.id ?? null;
  useEffect(() => { setRuns([]); setLoading(true); }, [companyKey, scheme]);
  useEffect(() => {
    const submitted = latestRunRef.current;
    if (submitted) setRuns((current) => current.some((run) => run.id === submitted.id) ? current : [{ ...submitted, scheme_type: scheme }, ...current]);
    setDismissedRunId(null);
    void load(Boolean(submitted));
  }, [companyKey, latestRunId, load, scheme]);

  const activeRuns = runs.filter((run) => !["completed", "completed_with_issues", "failed", "cancelled"].includes(run.status));
  const submittedRun = latestRun ? runs.find((run) => run.id === latestRun.id) : null;
  const hasLiveRun = activeRuns.length > 0;
  async function stopActiveRun() {
    const active = activeRuns[0];
    if (!active || stopping) return;
    setStopping(true);
    onError(null);
    try {
      const token = await accessToken();
      if (!token) return;
      await apiRequest(token, `/api/companies/${company.id}/evaluations/runs/${active.id}/cancel`, { method: "POST" });
      await load();
    } catch (cause) {
      onError(userFacingError(cause, "Could not stop this calculation."));
    } finally {
      setStopping(false);
    }
  }
  useEffect(() => {
    if (!hasLiveRun) return;
    void load(true);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, scheme === "cd" ? 1_000 : 1_500);
    return () => window.clearInterval(interval);
  }, [hasLiveRun, load, scheme]);
  useEffect(() => {
    if (!submittedRun || !["completed", "completed_with_issues", "failed"].includes(submittedRun.status) || settledRunIds.current.has(submittedRun.id)) return;
    settledRunIds.current.add(submittedRun.id);
    void onSettled(submittedRun);
  }, [onSettled, submittedRun]);

  const title = scheme === "cd" ? "Cash Discount" : "Turnover Discount";
  const successfulRuns = runs.filter((run) => run.status === "completed");
  const issueRuns = runs.filter((run) => ["completed_with_issues", "failed"].includes(run.status));
  const isResolved = (run: EvaluationRun) => successfulRuns.some((successfulRun) => successfulRun.created_at > run.created_at
    && successfulRun.scheme_version_id === run.scheme_version_id
    && successfulRun.period_start === run.period_start
    && successfulRun.period_end === run.period_end);
  const unresolvedIssueRuns = issueRuns.filter((run) => !isResolved(run));
  const issueRun = submittedRun && unresolvedIssueRuns.some((run) => run.id === submittedRun.id) && dismissedRunId !== submittedRun.id ? submittedRun : null;
  const attentionRuns = runs.filter((run) => activeRuns.some((activeRun) => activeRun.id === run.id) || unresolvedIssueRuns.some((issue) => issue.id === run.id));
  const periodKey = (run: EvaluationRun) => `${run.period_start ?? ""}:${run.period_end ?? ""}`;
  const newestFirst = (left: EvaluationRun, right: EvaluationRun) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  const periods = [...runs.reduce((groups, run) => {
    const key = periodKey(run);
    groups.set(key, [...(groups.get(key) ?? []), run]);
    return groups;
  }, new Map<string, EvaluationRun[]>()).values()].map((group) => {
    const sorted = [...group].sort(newestFirst);
    const active = sorted.find((run) => activeRuns.some((item) => item.id === run.id)) ?? null;
    const completed = sorted.filter((run) => run.status === "completed");
    const shown = active ?? completed[0] ?? sorted[0];
    // A newer attempt that failed while an older result is still shown.
    const failedAfter = !active && completed[0] ? sorted.find((run) => newestFirst(run, completed[0]) < 0 && unresolvedIssueRuns.some((issue) => issue.id === run.id)) ?? null : null;
    return { key: periodKey(shown), shown, older: completed.filter((run) => run.id !== shown.id), attempts: sorted.length, failedAfter, lastRunAt: sorted[0].created_at };
  }).sort((left, right) => (right.shown.period_end ?? "").localeCompare(left.shown.period_end ?? "") || newestFirst(left.shown, right.shown));
  const needsAttention = (period: (typeof periods)[number]) => attentionRuns.some((run) => periodKey(run) === period.key);
  const filteredPeriods = historyFilter === "attention" ? periods.filter(needsAttention) : historyFilter === "successful" ? periods.filter((period) => period.shown.status === "completed") : periods;
  const [openPeriod, setOpenPeriod] = useState<string | null>(null);
  // The newest completed run of a period is the live result (actions allowed);
  // older runs of the same period open as read-only snapshots.
  const isLatestForPeriod = (run: EvaluationRun) => !successfulRuns.some((other) => other.id !== run.id
    && other.period_start === run.period_start && other.period_end === run.period_end
    && new Date(other.created_at).getTime() > new Date(run.created_at).getTime());
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(filteredPeriods.length / pageSize));
  const currentPage = Math.min(historyPage, pageCount);
  const visiblePeriods = filteredPeriods.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => { setHistoryPage(1); }, [historyFilter, companyKey]);
  return <Card className="calculation-history-card">
    <div className="card-title calculation-history-heading">
      <div><p className="eyebrow">Calculation history</p><h2>Previous calculations</h2><p className="muted-copy">One row per period with its latest result. Calculating a period again updates its row; earlier calculations stay available as snapshots.</p></div>
      <div className="calculation-history-actions">
        {hasLiveRun && <Button className="button-secondary" disabled={stopping} onClick={() => void stopActiveRun()}><Square size={14} />{stopping ? "Stopping…" : "Stop calculation"}</Button>}
        <Button className="button-secondary" onClick={() => void load(true)} aria-label="Refresh calculation history"><RefreshCw size={15} />Refresh</Button>
      </div>
    </div>
    {loading && !runs.length ? <Skeleton lines={3} /> : <>
      {issueRun ? <div className="drawer-actions"><StatusBadge status={issueRun.status} /><h3>Calculation did not finish</h3><p className="muted-copy">{userFacingDetail(issueRun.summary?.message ?? issueRun.error_summary, "The calculation could not be completed.")}</p><div className="accounting-card-actions"><Button onClick={onRetry}>Try again</Button><Button className="button-secondary" onClick={() => setDismissedRunId(issueRun.id)}>Dismiss</Button></div></div> : null}
      {runs.length ? <><div className="calculation-history-toolbar"><div className="segmented" aria-label="Calculation history filters"><button className={historyFilter === "all" ? "selected" : ""} onClick={() => setHistoryFilter("all")}>All {periods.length}</button><button className={historyFilter === "successful" ? "selected" : ""} onClick={() => setHistoryFilter("successful")}>Completed {periods.filter((period) => period.shown.status === "completed").length}</button>{attentionRuns.length > 0 && <button className={historyFilter === "attention" ? "selected" : ""} onClick={() => setHistoryFilter("attention")}>Needs attention {periods.filter(needsAttention).length}</button>}</div></div><div className="data-table evaluation-run-table calculation-history-table"><div className="table-head"><span>Period</span><span>Business result</span><span>Status</span><span>Next step</span></div>{visiblePeriods.map((period) => {
        const run = period.shown;
        const resolved = isResolved(run);
        const status = runStatus(run, resolved);
        const hasIssue = ["failed", "completed_with_issues"].includes(run.status);
        const wasStopped = run.status === "cancelled";
        const result = run.status === "completed" ? `${run.total_jobs ?? 0} checked · ${run.qualified_jobs ?? 0} qualified · ${formatMoney(run.projected_discount_amount ?? 0)} projected` : wasStopped ? "Calculation stopped" : hasIssue ? "Calculation did not finish" : progressLabel(run);
        const detail = run.status === "completed"
          ? period.failedAfter ? `A recalculation on ${formatDate(period.failedAfter.created_at)} did not finish; this is the last good result.` : `${run.not_qualified_jobs ?? 0} customers did not qualify`
          : wasStopped
            ? "Stopped by the user. Completed customer results remain in history."
          : resolved
            ? "A later successful calculation replaced this result."
            : hasIssue
              ? userFacingDetail(run.summary?.message ?? run.error_summary, "Try the calculation again.")
              : "Customer calculations are still being prepared";
        const expanded = openPeriod === period.key;
        return <article key={period.key} className={expanded ? "is-expanded" : undefined}>
          <div><strong>{periodLabel(run)}</strong><small>Calculated {formatDate(run.created_at)}{period.attempts > 1 ? <> · <button type="button" className="history-older-toggle" aria-expanded={expanded} onClick={() => setOpenPeriod(expanded ? null : period.key)}>{period.attempts} times</button></> : null}</small></div>
          <div><strong>{result}</strong><small>{detail}</small></div>
          <div><span className={`calculation-status calculation-status-${status.tone}`}>{status.label}</span><small>{durationLabel(run)}</small></div>
          <div className="queue-next">{period.failedAfter && <Button className="button-quiet" onClick={onRetry}>Try again</Button>}{run.status === "completed"
            ? <Button className="button-quiet" title="Live results for this period. Credit Notes can be created here." onClick={() => onViewResults(run, isLatestForPeriod(run))}><Eye size={15} />View results</Button>
            : wasStopped
              ? <Button className="button-quiet" onClick={onRetry}>Start again</Button>
            : resolved
              ? <small>No action needed</small>
              : hasIssue
                ? <Button className="button-quiet" onClick={onRetry}>Try again</Button>
                : <small>Keep Tally open</small>}</div>
          {expanded && <div className="history-older">
            <small>Earlier calculations of this period · read-only</small>
            {period.older.length ? period.older.map((older) => <div key={older.id}>
              <span>{formatDate(older.created_at)} · {older.total_jobs ?? 0} checked · {formatMoney(older.projected_discount_amount ?? 0)}</span>
              <Button className="button-quiet" onClick={() => onViewResults(older, false)}><Eye size={14} />View snapshot</Button>
            </div>) : <span>Only unfinished or stopped attempts; nothing else to show.</span>}
          </div>}
        </article>;
      })}</div>{pageCount > 1 && <nav className="table-pagination" aria-label="Calculation history pages"><span>Page {currentPage} of {pageCount} · {filteredPeriods.length} periods</span><div><Button className="button-secondary" disabled={currentPage === 1} onClick={() => setHistoryPage((value) => Math.max(1, value - 1))}>Previous</Button>{Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => <button key={number} className={number === currentPage ? "selected" : ""} aria-current={number === currentPage ? "page" : undefined} onClick={() => setHistoryPage(number)}>{number}</button>)}<Button className="button-secondary" disabled={currentPage === pageCount} onClick={() => setHistoryPage((value) => Math.min(pageCount, value + 1))}>Next</Button></div></nav>}</> : <EmptyState title="No calculations yet" detail={`Start a ${title} calculation to create the first history record.`} />}
    </>}
  </Card>;
}
