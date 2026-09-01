import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const WORKER_NAME = process.env.MEENAKSHI_OUTBOX_WORKER_NAME || `meenakshi-tally-outbox-${process.pid}`;
const POLL_INTERVAL_MS = Math.max(1_000, Number(process.env.MEENAKSHI_OUTBOX_POLL_INTERVAL_MS ?? 5_000));
const BATCH_SIZE = Math.max(1, Math.min(50, Number(process.env.MEENAKSHI_OUTBOX_BATCH_SIZE ?? 10)));
const RUN_ONCE = process.env.MEENAKSHI_OUTBOX_RUN_ONCE === "true";
const MAX_RETRY_DELAY_MS = 60_000;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
function errorText(error) { return error instanceof Error ? error.message : error && typeof error === "object" ? [error.message, error.details, error.hint].filter(Boolean).join(" ") : String(error ?? "Unknown worker error"); }
function retryAt(attempts) { return new Date(Date.now() + Math.min(15 * 2 ** Math.max(0, attempts - 1), 15 * 60) * 1_000).toISOString(); }
async function appendAudit(event) { const { error } = await supabase.from("audit_events").insert(event); if (error) console.error("Could not append Meenakshi outbox audit event:", error.message); }
async function recordWorkerHeartbeat(status, lastError = null) {
  const { error } = await supabase.from("integration_worker_heartbeats").upsert({
    worker_name: WORKER_NAME,
    worker_type: "tally_outbox",
    status,
    last_heartbeat_at: new Date().toISOString(),
    last_error: lastError ? errorText(lastError).slice(0, 2_000) : null,
  }, { onConflict: "worker_name" });
  if (error && error.code !== "42P01" && error.code !== "PGRST205") console.error("Could not record Tally worker heartbeat:", error.message);
}
async function failOutbox(outbox, error) {
  const exhausted = outbox.attempts >= outbox.max_attempts;
  const { error: updateError } = await supabase.from("integration_outbox").update({ status: exhausted ? "dead_letter" : "failed", available_at: exhausted ? outbox.available_at : retryAt(outbox.attempts), last_error: errorText(error).slice(0, 2_000), locked_at: null, locked_by: null, lease_expires_at: null, completed_at: exhausted ? new Date().toISOString() : null }).eq("id", outbox.id).eq("status", "processing");
  if (updateError) throw updateError;
  await appendAudit({ organization_id: outbox.organization_id, company_id: outbox.company_id, actor_type: "system", action: exhausted ? "tally_outbox_dead_lettered" : "tally_outbox_dispatch_failed", entity_type: "integration_outbox", entity_id: outbox.id, correlation_id: outbox.correlation_id, new_value: { status: exhausted ? "dead_letter" : "failed", attempts: outbox.attempts }, metadata: { eventType: outbox.event_type, error: errorText(error).slice(0, 2_000) } });
}
async function findBoundConnector(outbox) {
  const { data, error } = await supabase.from("tally_connector_company_bindings").select("connector_id, tally_connectors!inner(status)").eq("organization_id", outbox.organization_id).eq("company_id", outbox.company_id).eq("is_active", true).limit(1).maybeSingle();
  if (error) throw error;
  const connector = data?.tally_connectors;
  if (!data || !connector || (Array.isArray(connector) ? connector[0] : connector).status !== "paired") throw new Error("No active paired connector is bound to this company.");
  return data.connector_id;
}
async function dispatch(outbox) {
  try {
    const connectorId = await findBoundConnector(outbox);
    const { data: commandId, error } = await supabase.rpc("dispatch_outbox_to_tally_command", { p_outbox_id: outbox.id, p_connector_id: connectorId });
    if (error) throw error;
    await appendAudit({ organization_id: outbox.organization_id, company_id: outbox.company_id, actor_type: "system", action: "tally_outbox_dispatched", entity_type: "integration_outbox", entity_id: outbox.id, correlation_id: outbox.correlation_id, new_value: { status: "completed", tallyCommandId: commandId }, metadata: { eventType: outbox.event_type, connectorId } });
  } catch (error) { await failOutbox(outbox, error); }
}
async function processBatch() {
  const { data, error } = await supabase.rpc("claim_tally_integration_outbox", { p_worker_id: WORKER_NAME, p_limit: BATCH_SIZE, p_lease_seconds: 90 });
  if (error) throw error;
  for (const outbox of data ?? []) await dispatch(outbox);
  return (data ?? []).length;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  let consecutiveFailures = 0;
  do {
    try {
      const count = await processBatch();
      consecutiveFailures = 0;
      await recordWorkerHeartbeat("running");
      if (RUN_ONCE) break;
      await sleep(count ? 100 : POLL_INTERVAL_MS);
    } catch (error) {
      consecutiveFailures += 1;
      await recordWorkerHeartbeat("degraded", error);
      console.error("Tally outbox worker cycle failed; retrying:", errorText(error));
      if (RUN_ONCE) throw error;
      await sleep(Math.min(POLL_INTERVAL_MS * 2 ** Math.min(consecutiveFailures - 1, 5), MAX_RETRY_DELAY_MS));
    }
  } while (true);
}
main().catch((error) => { console.error("Meenakshi Tally outbox worker stopped:", error); process.exitCode = 1; });
