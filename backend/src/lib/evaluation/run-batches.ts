type RunRecord = {
  id: string;
  idempotency_key?: string | null;
  status: string;
  created_at: string;
  completed_at?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  error_summary?: string | null;
  attempts?: number | null;
  max_attempts?: number | null;
  request_context?: Record<string, unknown> | null;
  [key: string]: unknown;
};

const childKeyPattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalStatuses = new Set(["completed", "completed_with_issues", "failed", "cancelled"]);

function isChildRun(run: RunRecord, rootId: string) {
  return String(run.idempotency_key ?? "").startsWith(`${rootId}:`);
}

function rootRunId(run: RunRecord) {
  const match = String(run.idempotency_key ?? "").match(childKeyPattern);
  return match ? match[1] : run.id;
}

function aggregateStatus(runs: RunRecord[]) {
  const statuses = new Set(runs.map((run) => run.status));
  if ([...statuses].some((status) => !terminalStatuses.has(status))) {
    return statuses.has("processing") ? "processing" : statuses.has("queued") ? "queued" : "processing";
  }
  if (statuses.has("cancelled")) return "cancelled";
  if (statuses.size === 1 && statuses.has("completed")) return "completed";
  if (statuses.size === 1 && statuses.has("failed")) return "failed";
  return "completed_with_issues";
}

function referenceFor(run: RunRecord, schemeType: "cd" | "tod" | null | undefined) {
  const created = new Date(run.created_at);
  const date = Number.isNaN(created.getTime())
    ? "UNKNOWN"
    : `${created.getUTCFullYear()}${String(created.getUTCMonth() + 1).padStart(2, "0")}${String(created.getUTCDate()).padStart(2, "0")}`;
  const time = Number.isNaN(created.getTime())
    ? "000000"
    : `${String(created.getUTCHours()).padStart(2, "0")}${String(created.getUTCMinutes()).padStart(2, "0")}${String(created.getUTCSeconds()).padStart(2, "0")}`;
  return `${String(schemeType ?? "run").toUpperCase()}-${date}-${time}-${run.id.slice(0, 4).toUpperCase()}`;
}

export function collapseEvaluationRuns<T extends RunRecord & { scheme_type?: "cd" | "tod" | null }>(runs: T[]) {
  const groups = new Map<string, T[]>();
  for (const run of runs) {
    const rootId = rootRunId(run);
    groups.set(rootId, [...(groups.get(rootId) ?? []), run]);
  }

  return [...groups.entries()].map(([rootId, groupedRuns]) => {
    const root = groupedRuns.find((run) => run.id === rootId) ?? groupedRuns[0];
    const childRuns = groupedRuns.filter((run) => isChildRun(run, rootId));
    const coordinatorOnly = root.request_context?.batch === true && !root.request_context?.customerId;
    const jobs = childRuns.length && coordinatorOnly ? childRuns : groupedRuns;
    const detail = childRuns[0] ?? root;
    const completedJobs = jobs.filter((run) => run.status === "completed").length;
    const failedJobs = jobs.filter((run) => ["failed", "completed_with_issues"].includes(run.status)).length;
    const activeJobs = jobs.filter((run) => !terminalStatuses.has(run.status)).length;
    const qualifiedJobs = jobs.filter((run) => Number((run.summary as Record<string, unknown> | null | undefined)?.calculatedDiscountAmount ?? 0) > 0).length;
    const projectedDiscountAmount = jobs.reduce((total, run) => total + (Number((run.summary as Record<string, unknown> | null | undefined)?.calculatedDiscountAmount ?? 0) || 0), 0);
    const periods = [...new Map(jobs.flatMap((run) => run.period_start && run.period_end
      ? [[`${run.period_start}:${run.period_end}`, { start: String(run.period_start), end: String(run.period_end) }] as const]
      : [])).values()];
    const lastUpdated = groupedRuns.map((run) => run.updated_at ?? run.created_at).sort().at(-1) ?? root.created_at;
    const completedAt = groupedRuns.map((run) => run.completed_at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    const errorSummary = groupedRuns.find((run) => run.error_summary)?.error_summary ?? null;
    return {
      ...root,
      id: rootId,
      scheme_version_id: root.scheme_version_id ?? detail.scheme_version_id ?? null,
      period_start: root.period_start ?? detail.period_start ?? null,
      period_end: root.period_end ?? detail.period_end ?? null,
      status: aggregateStatus(jobs),
      completed_at: activeJobs ? null : completedAt,
      updated_at: lastUpdated,
      error_summary: errorSummary,
      run_reference: referenceFor(root, root.scheme_type),
      total_jobs: jobs.length,
      completed_jobs: completedJobs,
      failed_jobs: failedJobs,
      active_jobs: activeJobs,
      qualified_jobs: qualifiedJobs,
      not_qualified_jobs: Math.max(0, completedJobs - qualifiedJobs),
      projected_discount_amount: projectedDiscountAmount,
      periods,
    };
  }).sort((left, right) => right.created_at.localeCompare(left.created_at));
}
