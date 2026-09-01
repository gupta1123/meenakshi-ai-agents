import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const WORKER_NAME = process.env.MEENAKSHI_NOTIFICATION_WORKER_NAME || `meenakshi-notifications-${process.pid}`;
const POLL_INTERVAL_MS = Math.max(1_000, Number(process.env.MEENAKSHI_NOTIFICATION_POLL_INTERVAL_MS ?? 5_000));
const BATCH_SIZE = Math.max(1, Math.min(50, Number(process.env.MEENAKSHI_NOTIFICATION_BATCH_SIZE ?? 10)));
const RUN_ONCE = process.env.MEENAKSHI_NOTIFICATION_RUN_ONCE === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") return [error.message, error.details, error.hint].filter(Boolean).join(" ");
  return String(error ?? "MSG91 delivery failed.");
}

function safeProviderResponse(value) {
  if (!value || typeof value !== "object") return value ?? {};
  // The request is intentionally never retained here: it could include a
  // short-lived document URL and should not duplicate message content.
  return value;
}

function documentUrlFromPayload(payload) {
  const path = typeof payload?.documentStoragePath === "string" ? payload.documentStoragePath.trim() : "";
  if (!path) return null;
  if (/^https:\/\//i.test(path)) return path;
  const base = String(process.env.MEENAKSHI_CREDIT_NOTE_DOCUMENT_URL_BASE ?? "").trim().replace(/\/+$/, "");
  if (!base || path.includes("..")) return null;
  return `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function organizationId(companyId) {
  const { data, error } = await supabase.from("companies").select("organization_id").eq("id", companyId).maybeSingle();
  if (error) throw error;
  return data?.organization_id ?? null;
}

async function appendAudit(message, action, newValue, metadata = {}) {
  try {
    const organization_id = await organizationId(message.company_id);
    if (!organization_id) return;
    const { error } = await supabase.from("audit_events").insert({
      organization_id, company_id: message.company_id, actor_type: "msg91", action,
      entity_type: "notification_message", entity_id: message.id,
      new_value: newValue, metadata: { eventType: message.event_type, ...metadata },
    });
    if (error) console.error("Could not append notification audit event:", error.message);
  } catch (error) {
    console.error("Could not resolve organization for notification audit:", errorText(error));
  }
}

async function insertAttempt(message) {
  const { data, error } = await supabase.from("notification_attempts").insert({
    notification_message_id: message.id, attempt_number: message.attempt_count, status: "sending",
  }).select("id").single();
  if (error) throw error;
  return data.id;
}

async function markSent(message, attemptId, result) {
  const now = new Date().toISOString();
  const attempt = await supabase.from("notification_attempts").update({
    provider_message_id: result.providerMessageId, provider_response: safeProviderResponse(result.payload),
    status: "sent", completed_at: now, failure_reason: null,
  }).eq("id", attemptId);
  if (attempt.error) throw attempt.error;
  const messageUpdate = await supabase.from("notification_messages").update({
    status: "sent", sent_at: now, failure_reason: null, locked_at: null, locked_by: null, lease_expires_at: null,
    provider_metadata: { provider: "msg91", providerMessageId: result.providerMessageId, mocked: result.mocked, lastResponse: safeProviderResponse(result.payload) },
  }).eq("id", message.id).eq("status", "sending").eq("locked_by", WORKER_NAME);
  if (messageUpdate.error) throw messageUpdate.error;
  await appendAudit(message, "notification_sent_to_msg91", { status: "sent", providerMessageId: result.providerMessageId }, { mocked: result.mocked === true });
}

async function markFailed(message, attemptId, error) {
  const { deliveryFailure, isTerminalFailure, retryAt } = await import("../src/lib/notifications/delivery-state.ts");
  const failure = deliveryFailure(error);
  const terminal = isTerminalFailure(message.attempt_count, message.max_attempts, failure);
  const now = new Date().toISOString();
  const failureReason = `${terminal ? "Permanent" : "Temporary"} MSG91 failure: ${failure.message}`.slice(0, 2_000);
  const attempt = await supabase.from("notification_attempts").update({
    status: "failed", completed_at: now, failure_reason: failureReason,
    provider_response: safeProviderResponse(failure.providerResponse),
  }).eq("id", attemptId);
  if (attempt.error) throw attempt.error;
  const messageUpdate = await supabase.from("notification_messages").update({
    status: "failed", failure_reason: failureReason,
    available_at: terminal ? now : retryAt(message.attempt_count),
    locked_at: null, locked_by: null, lease_expires_at: null,
    provider_metadata: {
      provider: "msg91", terminal, retryable: failure.retryable, statusCode: failure.statusCode,
      lastResponse: safeProviderResponse(failure.providerResponse),
    },
  }).eq("id", message.id).eq("status", "sending").eq("locked_by", WORKER_NAME);
  if (messageUpdate.error) throw messageUpdate.error;
  await appendAudit(message, terminal ? "notification_msg91_permanent_failure" : "notification_msg91_retry_scheduled",
    { status: "failed", attempt: message.attempt_count, terminal }, { error: failureReason, statusCode: failure.statusCode });
}

async function processOne(message) {
  let attemptId = null;
  try {
    attemptId = await insertAttempt(message);
    const { sendMsg91Notification } = await import("../src/lib/notifications/msg91-client.ts");
    const documentUrl = documentUrlFromPayload(message.payload);
    const result = await sendMsg91Notification({
      eventType: message.event_type, recipientPhoneE164: message.recipient_phone_e164,
      payload: { ...(message.payload ?? {}), ...(documentUrl ? { documentUrl, documentName: `${message.payload?.creditNoteNumber ?? "credit-note"}.pdf` } : {}) },
      template: message.template_snapshot ?? {},
    });
    await markSent(message, attemptId, result);
  } catch (error) {
    console.error("Meenakshi notification delivery failed", { notificationMessageId: message.id, error: errorText(error) });
    if (attemptId) {
      try { await markFailed(message, attemptId, error); }
      catch (failure) { console.error("Could not record notification delivery failure", failure); }
    }
  }
}

async function claim() {
  const { data, error } = await supabase.rpc("claim_phase_6_notification_messages", {
    p_worker_id: WORKER_NAME, p_limit: BATCH_SIZE, p_lease_seconds: 90,
  });
  if (error) throw error;
  return data ?? [];
}

async function main() {
  let consecutiveFailures = 0;
  do {
    try {
      const messages = await claim();
      for (const message of messages) await processOne(message);
      consecutiveFailures = 0;
      if (RUN_ONCE) break;
      await sleep(messages.length ? 100 : POLL_INTERVAL_MS);
    } catch (error) {
      if (RUN_ONCE) throw error;
      consecutiveFailures += 1;
      console.error("Meenakshi notification worker cycle failed; retrying:", errorText(error));
      await sleep(Math.min(POLL_INTERVAL_MS * 2 ** Math.min(consecutiveFailures - 1, 5), 60_000));
    }
  } while (true);
}

main().catch((error) => { console.error("Meenakshi notification worker stopped:", error); process.exitCode = 1; });
