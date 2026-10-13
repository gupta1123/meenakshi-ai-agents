// Local calculations already read Tally. Their legacy refresh commands must
// never repeat that read or overwrite the saved result on a later retry.
export const OBSOLETE_READ_PREFIX = "Obsolete evaluation read:";

export function obsoleteEvaluationReadReason(command, run) {
  if (command.command_type !== "fetch_meenakshi_evidence" || !run
    || run.company_id !== command.company_id
    || run.id !== command.payload?.evaluationRunId) return null;
  if (run.request_context?.localFirst === true) return `${OBSOLETE_READ_PREFIX} calculation uses local Tally evidence.`;
  if (["completed", "completed_with_issues", "cancelled"].includes(run.status)
    || (run.status === "failed" && Number(run.attempts) >= Number(run.max_attempts))) {
    return `${OBSOLETE_READ_PREFIX} calculation is already ${run.status}.`;
  }
  return null;
}

export async function getObsoleteEvaluationReadReason(supabase, command) {
  if (command.command_type !== "fetch_meenakshi_evidence" || typeof command.payload?.evaluationRunId !== "string") return null;
  const { data, error } = await supabase.from("evaluation_runs")
    .select("id,company_id,status,request_context,attempts,max_attempts")
    .eq("company_id", command.company_id).eq("id", command.payload.evaluationRunId).maybeSingle();
  if (error) throw error;
  return obsoleteEvaluationReadReason(command, data);
}

export async function retireEvaluationRead(supabase, command, reason) {
  if (command.command_type !== "fetch_meenakshi_evidence" || !reason?.startsWith(OBSOLETE_READ_PREFIX)) return;
  const now = new Date().toISOString();
  if (command.id) {
    const { error } = await supabase.from("tally_commands").update({
      status: "dead_letter", failure_reason: reason, completed_at: now,
      locked_at: null, locked_by: null, lease_expires_at: null,
    }).eq("company_id", command.company_id).eq("id", command.id)
      .eq("command_type", "fetch_meenakshi_evidence").in("status", ["queued", "failed", "sending"]);
    if (error) throw error;
  }
  const syncIds = [command.payload?.masterSyncRunId, command.payload?.voucherSyncRunId].filter((id) => typeof id === "string");
  if (syncIds.length) {
    const { error } = await supabase.from("tally_sync_runs").update({ status: "failed", error_summary: reason, completed_at: now })
      .eq("company_id", command.company_id).in("id", syncIds).in("status", ["queued", "running", "failed"]);
    if (error) throw error;
  }
}

// Batched lookup keeps connector polling to one query when idle and two when
// reads exist. Financial commands are never selected by this cleanup.
export async function retireObsoleteEvaluationReads(supabase, scope) {
  if (!scope?.connectorId && !scope?.companyId) throw new Error("A company or connector scope is required for evaluation-read cleanup.");
  let query = supabase.from("tally_commands").select("id,company_id,command_type,payload")
    .eq("command_type", "fetch_meenakshi_evidence").in("status", ["queued", "failed", "sending"]);
  if (scope.connectorId) query = query.eq("connector_id", scope.connectorId);
  if (scope.companyId) query = query.eq("company_id", scope.companyId);
  if (scope.runId) query = query.eq("payload->>evaluationRunId", scope.runId);
  const { data: commands, error } = await query.limit(200);
  if (error) throw error;
  const runIds = [...new Set((commands ?? []).map((command) => command.payload?.evaluationRunId).filter((id) => typeof id === "string"))];
  if (!runIds.length) return 0;
  const { data: runs, error: runError } = await supabase.from("evaluation_runs")
    .select("id,company_id,status,request_context,attempts,max_attempts").in("id", runIds);
  if (runError) throw runError;
  const byId = new Map((runs ?? []).map((run) => [run.id, run]));
  let count = 0;
  for (const command of commands ?? []) {
    const reason = obsoleteEvaluationReadReason(command, byId.get(command.payload?.evaluationRunId));
    if (!reason) continue;
    await retireEvaluationRead(supabase, command, reason);
    count += 1;
  }
  return count;
}
