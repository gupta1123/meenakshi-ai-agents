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
  onViewResults: () => void;
  onSettled: (run: EvaluationRun) => void | Promise<void>;
};

function periodLabel(run: EvaluationRun) {
  const dateOnly = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" });
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
  if (run.status === "completed") return { label: "Successful", tone: "success" };
  if (run.status === "cancelled") return { label: "Stopped", tone: "resolved" };
  if (resolved) return { label: "Resolved", tone: "resolved" };
  if (["failed", "completed_with_issues"].includes(run.status)) return { label: "Needs attention", tone: "attention" };
  return { label: "Running", tone: "running" };
}

function shortReference(run: EvaluationRun) {
  return (run.run_reference?.split("-").at(-1) ?? run.id.slice(0, 4)).toUpperCase();
}

export function GuidedEvaluationQueue({ scheme, latestRun, onError, onRetry, onViewResults, onSettled }: Props) {
  const { company, companyKey } = useCompany();
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<"all" | "successful" | "attention">("all");
  const [showPrevious, setShowPrevious] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inFlight = useRef(false);
  const settledRunIds = useRef(new Set<string>());
  const load = useCallback(async (fresh = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = await accessToken();
    if (!token) { inFlight.current = false; return; }
    try {
      const response = await apiRequest<{ evaluationRuns: EvaluationRun[] }>(token, `/api/companies/${company.id}/evaluations/runs?schemeType=${scheme}${fresh ? "&fresh=1" : ""}`);
      setRuns(response.evaluationRuns);
      onError(null);
    } catch (cause) {
      onError(userFacingError(cause, "Could not load evaluations in progress."));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [company.id, onError, scheme]);

  useEffect(() => {
    setRuns(latestRun ? [{ ...latestRun, scheme_type: scheme }] : []);
    setDismissedRunId(null);
    setLoading(true);
    void load();
  }, [companyKey, latestRun, load, scheme]);

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
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, scheme === "cd" ? 1_000 : 10_000);
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
  const isResolved = (run: EvaluationRun) => successfulRuns.some((successfulRun) => successfulRun.created_at > run.created_at);
  const unresolvedIssueRuns = issueRuns.filter((run) => !isResolved(run));
  const resolvedIssueRuns = issueRuns.filter(isResolved);
  const issueRun = submittedRun && unresolvedIssueRuns.some((run) => run.id === submittedRun.id) && dismissedRunId !== submittedRun.id ? submittedRun : null;
  const attentionRuns = runs.filter((run) => activeRuns.some((activeRun) => activeRun.id === run.id) || unresolvedIssueRuns.some((issue) => issue.id === run.id));
  const currentRuns = runs.filter((run) => !resolvedIssueRuns.some((resolvedRun) => resolvedRun.id === run.id));
  const filteredRuns = historyFilter === "attention" ? attentionRuns : historyFilter === "successful" ? successfulRuns : showPrevious ? runs : currentRuns;
  const visibleRuns = showPrevious ? filteredRuns.slice(0, 20) : filteredRuns.filter((run, index) => run.status !== "completed" || index === filteredRuns.findIndex((item) => item.status === "completed"));
  const hiddenPreviousCount = showPrevious ? 0 : Math.max(0, runs.length - visibleRuns.length);
  return <Card className="calculation-history-card">
    <div className="card-title calculation-history-heading">
      <div><p className="eyebrow">Calculation history</p><h2>Previous calculations</h2><p className="muted-copy">Use Customers for daily work. History keeps a record of what ran and whether it succeeded.</p></div>
      <div className="calculation-history-actions">
        {hasLiveRun && <Button className="button-secondary" disabled={stopping} onClick={() => void stopActiveRun()}><Square size={14} />{stopping ? "Stopping…" : "Stop calculation"}</Button>}
        <Button className="button-secondary" onClick={() => void load()} aria-label="Refresh calculation history"><RefreshCw size={15} />Refresh</Button>
      </div>
    </div>
    {loading && !runs.length ? <Skeleton lines={3} /> : <>
      {issueRun ? <div className="drawer-actions"><StatusBadge status={issueRun.status} /><h3>Calculation did not finish</h3><p className="muted-copy">{userFacingDetail(issueRun.summary?.message ?? issueRun.error_summary, "The calculation could not be completed.")}</p><div className="accounting-card-actions"><Button onClick={onRetry}>Try again</Button><Button className="button-secondary" onClick={() => setDismissedRunId(issueRun.id)}>Dismiss</Button></div></div> : null}
      {runs.length ? <><div className="calculation-history-toolbar"><div className="segmented" aria-label="Calculation history filters"><button className={historyFilter === "all" ? "selected" : ""} onClick={() => { setHistoryFilter("all"); setShowPrevious(false); }}>All {runs.length}</button><button className={historyFilter === "successful" ? "selected" : ""} onClick={() => { setHistoryFilter("successful"); setShowPrevious(false); }}>Successful {successfulRuns.length}</button>{attentionRuns.length > 0 && <button className={historyFilter === "attention" ? "selected" : ""} onClick={() => { setHistoryFilter("attention"); setShowPrevious(true); }}>Needs attention {attentionRuns.length}</button>}</div></div><div className="data-table evaluation-run-table calculation-history-table"><div className="table-head"><span>Started</span><span>Business result</span><span>Status</span><span>Next step</span></div>{visibleRuns.map((run) => {
        const resolved = isResolved(run);
        const status = runStatus(run, resolved);
        const hasIssue = ["failed", "completed_with_issues"].includes(run.status);
        const wasStopped = run.status === "cancelled";
        const result = run.status === "completed" ? `${run.total_jobs ?? 0} checked · ${run.qualified_jobs ?? 0} qualified · ${formatMoney(run.projected_discount_amount ?? 0)} projected` : wasStopped ? "Calculation stopped" : hasIssue ? "Calculation did not finish" : progressLabel(run);
        const detail = run.status === "completed"
          ? `${run.not_qualified_jobs ?? 0} customers did not qualify in this calculation`
          : wasStopped
            ? "Stopped by the user. Completed customer results remain in history."
          : resolved
            ? "A later successful calculation replaced this result."
            : hasIssue
              ? userFacingDetail(run.summary?.message ?? run.error_summary, "Try the calculation again.")
              : "Customer calculations are still being prepared";
        return <article key={run.id}>
          <div><strong>{formatDate(run.created_at)}</strong><small>{periodLabel(run)} · Ref {shortReference(run)}</small></div>
          <div><strong>{result}</strong><small>{detail}</small></div>
          <div><span className={`calculation-status calculation-status-${status.tone}`}>{status.label}</span><small>{run.completed_at ? `Finished ${formatDate(run.completed_at)}` : "Started and waiting for completion"}</small></div>
          <div className="queue-next">{run.status === "completed"
            ? <Button className="button-quiet" onClick={onViewResults}><Eye size={15} />View results</Button>
            : wasStopped
              ? <Button className="button-quiet" onClick={onRetry}>Start again</Button>
            : resolved
              ? <small>No action needed</small>
              : hasIssue
                ? <Button className="button-quiet" onClick={onRetry}>Try again</Button>
                : <small>Keep Tally open</small>}</div>
        </article>;
      })}</div>{hiddenPreviousCount > 0 && historyFilter === "all" && <div className="calculation-history-more"><Button className="button-secondary" onClick={() => setShowPrevious(true)}>Show {hiddenPreviousCount} previous calculation{hiddenPreviousCount === 1 ? "" : "s"}</Button></div>}</> : <EmptyState title="No calculations yet" detail={`Start a ${title} calculation to create the first history record.`} />}
    </>}
  </Card>;
}
