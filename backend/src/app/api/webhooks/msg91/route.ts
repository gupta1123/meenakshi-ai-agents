import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Msg91DeliveryEvent = "sent" | "delivered" | "read" | "failed";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function eventName(value: unknown): Msg91DeliveryEvent | null {
  const normalized = stringValue(value).toLowerCase();
  return normalized === "sent" || normalized === "delivered" || normalized === "read" || normalized === "failed"
    ? normalized
    : null;
}

function occurredAt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function sameSecret(received: string, expected: string) {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function providerEventKey(payload: Record<string, unknown>, event: Msg91DeliveryEvent, requestId: string) {
  const parts = [requestId, event, stringValue(payload.uuid), stringValue(payload.ts), stringValue(payload.reason)];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function providerMetadata(current: unknown, details: Record<string, unknown>) {
  const prior = asRecord(current) ?? {};
  return { ...prior, provider: "msg91", delivery: details };
}

async function recordDeliveryEvent(payload: Record<string, unknown>) {
  const event = eventName(payload.eventName ?? payload.event_name ?? payload.status);
  const requestId = stringValue(payload.requestId ?? payload.request_id ?? payload.messageId ?? payload.message_id);
  if (!event || !requestId) return { accepted: false, ignored: true };

  const supabase = createSupabaseAdminClient();
  const { data: attempt, error: attemptError } = await supabase
    .from("notification_attempts")
    .select("id, notification_message_id")
    .eq("provider_message_id", requestId)
    .maybeSingle();
  if (attemptError) throw attemptError;

  const key = providerEventKey(payload, event, requestId);
  const { data: inserted, error: eventError } = await supabase
    .from("msg91_delivery_events")
    .upsert({
      provider_event_key: key,
      provider_message_id: requestId,
      event_name: event,
      occurred_at: occurredAt(payload.ts ?? payload.timestamp ?? payload.occurredAt),
      notification_attempt_id: attempt?.id ?? null,
      notification_message_id: attempt?.notification_message_id ?? null,
      payload,
    }, { onConflict: "provider_event_key", ignoreDuplicates: true })
    .select("id");
  if (eventError) throw eventError;
  if (!inserted?.length) return { accepted: true, duplicate: true, matched: Boolean(attempt) };
  if (!attempt) return { accepted: true, matched: false };

  const { data: message, error: messageError } = await supabase
    .from("notification_messages")
    .select("id, company_id, status, sent_at, delivered_at, read_at, provider_metadata, attempt_count, max_attempts")
    .eq("id", attempt.notification_message_id)
    .maybeSingle();
  if (messageError) throw messageError;
  if (!message) return { accepted: true, matched: false };

  const timestamp = occurredAt(payload.ts ?? payload.timestamp ?? payload.occurredAt);
  const delivery = { event, occurredAt: timestamp, providerMessageId: requestId, reason: stringValue(payload.reason) || null };
  const terminalFailure = event === "failed";
  const nextStatus = terminalFailure
    ? (["delivered", "read"].includes(message.status) ? message.status : "failed")
    : event === "read"
      ? "read"
      : event === "delivered"
        ? (message.status === "read" ? "read" : "delivered")
        : (["delivered", "read"].includes(message.status) ? message.status : "sent");

  const messageUpdate = {
    status: nextStatus,
    sent_at: message.sent_at ?? timestamp,
    delivered_at: nextStatus === "delivered" || nextStatus === "read" ? (message.delivered_at ?? timestamp) : message.delivered_at,
    read_at: nextStatus === "read" ? (message.read_at ?? timestamp) : message.read_at,
    failure_reason: terminalFailure && nextStatus === "failed" ? `MSG91 delivery failed: ${delivery.reason || "No reason supplied."}`.slice(0, 2_000) : null,
    available_at: terminalFailure && nextStatus === "failed" ? timestamp : undefined,
    attempt_count: terminalFailure && nextStatus === "failed" ? message.max_attempts : message.attempt_count,
    provider_metadata: providerMetadata(message.provider_metadata, { ...delivery, terminal: terminalFailure && nextStatus === "failed" }),
    locked_at: null,
    locked_by: null,
    lease_expires_at: null,
  };
  const { error: updateError } = await supabase.from("notification_messages").update(messageUpdate).eq("id", message.id);
  if (updateError) throw updateError;

  const attemptUpdate = event === "failed" && nextStatus === "failed"
    ? { status: "failed", completed_at: timestamp, failure_reason: messageUpdate.failure_reason }
    : { status: nextStatus, completed_at: timestamp, failure_reason: null };
  const { error: attemptUpdateError } = await supabase.from("notification_attempts").update(attemptUpdate).eq("id", attempt.id);
  if (attemptUpdateError) throw attemptUpdateError;

  const { data: company, error: companyError } = await supabase.from("companies").select("organization_id").eq("id", message.company_id).maybeSingle();
  if (companyError) throw companyError;
  if (company?.organization_id) {
    const { error: auditError } = await supabase.from("audit_events").insert({
      organization_id: company.organization_id,
      company_id: message.company_id,
      actor_type: "msg91",
      action: "notification_msg91_delivery_event",
      entity_type: "notification_message",
      entity_id: message.id,
      new_value: { status: nextStatus, providerMessageId: requestId },
      metadata: { event, occurredAt: timestamp, reason: delivery.reason },
    });
    if (auditError) console.error("Could not write MSG91 delivery audit event:", auditError.message);
  }
  return { accepted: true, matched: true, status: nextStatus };
}

export async function POST(request: Request) {
  const secret = process.env.MSG91_WEBHOOK_SECRET?.trim();
  const supplied = request.headers.get("x-meenakshi-msg91-secret") ?? "";
  if (!secret || !sameSecret(supplied, secret)) {
    return NextResponse.json({ error: "Unauthorized webhook." }, { status: 401 });
  }

  try {
    const body = await request.text();
    if (body.length > 100_000) return NextResponse.json({ error: "Webhook payload is too large." }, { status: 413 });
    const parsed = JSON.parse(body) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const outcomes = [];
    for (const row of rows) {
      const payload = asRecord(row);
      if (payload) outcomes.push(await recordDeliveryEvent(payload));
    }
    return NextResponse.json({ accepted: true, outcomes });
  } catch (error) {
    console.error("Could not process MSG91 delivery webhook:", error);
    return NextResponse.json({ error: "Could not process delivery webhook." }, { status: 500 });
  }
}
