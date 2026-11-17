import { apiRequest } from "@/lib/api";
import type { LocalProgress } from "@/lib/local-tally";

export type ServerCheck = {
  id: string; kind: "cd" | "tod"; status: string; created_at: string; finished_at?: string | null;
  cancel_requested?: boolean; failure_reason?: string | null; evaluation_run_id?: string | null;
  progress?: Partial<LocalProgress> & { save?: { state: string; evaluationRunId?: string; message?: string } } | null;
};
export type ServerCheckRun = { id: string; status: string; period_start?: string | null; period_end?: string | null; periods?: Array<{ start: string; end: string }>; error_summary?: string | null };
export type ServerCheckState = { job: ServerCheck; run: ServerCheckRun | null; phase: "reading" | "saving" | null; message: string | null };

export function pickServerCheck(jobs: ServerCheck[], kind: "cd" | "tod", seen: Set<string>, now = Date.now()) {
  const candidates = jobs.filter((job) => job.kind === kind);
  const active = candidates.find((job) => !seen.has(job.id) && ["queued", "running"].includes(job.status));
  if (active) return active;
  // Follow only the latest successful calculation's save. Walking backwards
  // through every historical success would keep replacing the selected period.
  const latest = candidates.find((job) => job.status === "succeeded");
  return latest && !seen.has(latest.id) && (latest.evaluation_run_id || latest.progress?.save || now - Date.parse(latest.finished_at ?? latest.created_at) < 15 * 60_000) ? latest : null;
}

export async function readServerCheck(token: string, companyId: string, id: string): Promise<ServerCheckState> {
  const base = `/api/companies/${companyId}/check-jobs`;
  const { job, queuePosition } = await apiRequest<{ job: ServerCheck; queuePosition: number }>(token, `${base}/${id}?result=0`, { cache: "no-store", timeoutMs: 10_000 });
  if (job.status === "queued") {
    const readiness = await apiRequest<{ message?: string | null }>(token, `${base}/mode`, { timeoutMs: 8_000 });
    return { job, run: null, phase: "reading", message: `Waiting for the Tally server.${queuePosition ? ` ${queuePosition} check${queuePosition === 1 ? "" : "s"} ahead.` : ""}${readiness.message ? ` ${readiness.message}` : ""}` };
  }
  if (job.status === "running") return { job, run: null, phase: "reading", message: job.cancel_requested ? "Stopping the check at the next safe point…" : "The Tally server is checking. You can close this page and return later." };
  if (job.status !== "succeeded" || job.progress?.save?.state === "failed") return { job, run: null, phase: null, message: job.failure_reason ?? job.progress?.save?.message ?? null };
  const runId = job.evaluation_run_id ?? job.progress?.save?.evaluationRunId;
  if (!runId) return { job, run: null, phase: "saving", message: "Saving the result on the server…" };
  const { evaluationRun } = await apiRequest<{ evaluationRun: ServerCheckRun }>(token, `/api/companies/${companyId}/evaluations/runs/${runId}`, { cache: "no-store", timeoutMs: 15_000 });
  const settled = ["completed", "completed_with_issues", "failed", "cancelled"].includes(evaluationRun.status);
  return { job, run: evaluationRun, phase: settled ? null : "saving", message: settled ? evaluationRun.error_summary ?? null : "Saving the customer results on the server…" };
}

export async function stopServerCheck(token: string, companyId: string, id: string) {
  return apiRequest(token, `/api/companies/${companyId}/check-jobs/${id}/cancel`, { method: "POST", timeoutMs: 10_000 });
}
