import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type FinishStatus = "cancelled" | "failed";

export async function stopEvaluationRun(input: {
  companyId: string;
  runId: string;
  status: FinishStatus;
  message: string;
}) {
  const supabase = createSupabaseAdminClient();
  const { data: run, error: runError } = await supabase
    .from("evaluation_runs")
    .select("id, status, summary, idempotency_key, tally_master_refresh_run_id, tally_voucher_refresh_run_id")
    .eq("id", input.runId)
    .eq("company_id", input.companyId)
    .maybeSingle();
  if (runError) throw runError;
  if (!run) return null;

  // A batch TOD run is represented in the UI as one row, but its customer
  // evaluations are child rows (`parentId:customerId`). Cancel the whole
  // family; cancelling only the coordinator leaves the child jobs running.
  const rootId = String(run.idempotency_key ?? "").match(/^([0-9a-f-]{36}):/i)?.[1] ?? run.id;
  const activeStatuses = ["queued", "refreshing_tally", "evaluating"];
  const { data: familyRuns, error: familyError } = await supabase
    .from("evaluation_runs")
    .select("id, status, idempotency_key, summary, tally_master_refresh_run_id, tally_voucher_refresh_run_id")
    .eq("company_id", input.companyId)
    .in("status", activeStatuses);
  if (familyError) throw familyError;
  const runIds = (familyRuns ?? [])
    .filter((candidate) => candidate.id === rootId || candidate.id === run.id || String(candidate.idempotency_key ?? "").startsWith(`${rootId}:`))
    .map((candidate) => candidate.id);
  if (!runIds.includes(run.id)) runIds.push(run.id);

  if (["completed", "completed_with_issues", "failed", "cancelled"].includes(run.status) && runIds.length === 1) return run;

  const completedAt = new Date().toISOString();
  const priorSummary = run.summary && typeof run.summary === "object" && !Array.isArray(run.summary)
    ? run.summary as Record<string, unknown>
    : {};

  const { data: commands, error: commandQueryError } = await supabase
    .from("tally_commands")
    .select("id, payload")
    .eq("company_id", input.companyId)
    .in("status", ["queued", "sending", "accepted", "failed"]);
  if (commandQueryError) throw commandQueryError;
  const commandIds = (commands ?? [])
    .filter((command) => {
      const evaluationRunId = command.payload && typeof command.payload === "object" && !Array.isArray(command.payload)
        ? (command.payload as Record<string, unknown>).evaluationRunId
        : null;
      return typeof evaluationRunId === "string" && runIds.includes(evaluationRunId);
    })
    .map((command) => command.id);
  const { error: commandError } = commandIds.length
    ? await supabase
      .from("tally_commands")
      .update({
        status: "dead_letter",
        failure_reason: input.message,
        completed_at: completedAt,
        locked_at: null,
        locked_by: null,
        lease_expires_at: null,
      })
      .eq("company_id", input.companyId)
      .in("id", commandIds)
    : { error: null };
  if (commandError) throw commandError;

  const syncRunIds = (familyRuns ?? [])
    .filter((candidate) => runIds.includes(candidate.id))
    .flatMap((candidate) => [candidate.tally_master_refresh_run_id, candidate.tally_voucher_refresh_run_id])
    .filter((id): id is string => typeof id === "string");
  if (syncRunIds.length) {
    const { error: syncError } = await supabase.from("tally_sync_runs").update({
      status: "failed",
      error_summary: input.message,
      completed_at: completedAt,
    }).eq("company_id", input.companyId).in("id", syncRunIds).in("status", ["queued", "running"]);
    if (syncError) throw syncError;
  }

  const { data: stopped, error: stopError } = await supabase.from("evaluation_runs").update({
    status: input.status,
    summary: { ...priorSummary, outcome: input.status, message: input.message },
    error_summary: input.status === "failed" ? input.message : null,
    completed_at: completedAt,
    locked_at: null,
    locked_by: null,
    lease_expires_at: null,
  }).eq("company_id", input.companyId)
    .in("id", runIds)
    .in("status", activeStatuses)
    .select("id, company_id, scheme_version_id, evaluation_date, period_start, period_end, status, requested_by, source_fingerprint, summary, error_summary, started_at, completed_at, created_at, updated_at, request_context, tally_master_refresh_run_id, tally_voucher_refresh_run_id, attempts, max_attempts");
  if (stopError) throw stopError;
  return stopped?.find((candidate) => candidate.id === run.id) ?? stopped?.[0] ?? run;
}
