import { randomUUID } from "node:crypto";

import { msg91Recipient } from "./eligibility";
import { renderMsg91Template } from "./template-renderer";
import type { NotificationEventType, NotificationPayload, TemplateSnapshot } from "./types";

const DEFAULT_BASE_URL = "https://control.msg91.com/api/v5/whatsapp";

type FetchLike = typeof fetch;

export class Msg91DeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly statusCode: number | null = null, readonly providerResponse?: unknown) {
    super(message);
  }
}

function env(name: string) { return String(process.env[name] ?? "").trim(); }

export function getMsg91Config() {
  const authKey = env("MSG91_AUTHKEY");
  const senderNumber = env("MSG91_WHATSAPP_NUMBER");
  const baseUrl = (env("MSG91_WHATSAPP_API_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const transport = env("MEENAKSHI_MSG91_TRANSPORT").toLowerCase() || "live";
  return { authKey, senderNumber, baseUrl, transport, isConfigured: Boolean(authKey && senderNumber) || transport === "mock" };
}

export async function fetchMsg91WhatsappTemplates(fetcher: FetchLike = fetch) {
  const config = getMsg91Config();
  if (!config.authKey || !config.senderNumber) throw new Error("MSG91 WhatsApp is not configured.");
  const response = await fetcher(`${config.baseUrl}/get-template-client/${config.senderNumber}`, {
    headers: { authkey: config.authKey, "content-type": "application/json" }, cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload && typeof payload === "object" && "hasError" in payload && payload.hasError === true)) {
    throw new Msg91DeliveryError(readProviderError(payload, response.status), response.status === 429 || response.status >= 500, response.status, payload);
  }
  return payload;
}

function readProviderError(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const value = payload as { message?: unknown; error?: unknown; errors?: unknown };
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    if (value.errors) return JSON.stringify(value.errors).slice(0, 2_000);
  }
  return `MSG91 request failed with ${status}.`;
}

export function providerMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const direct = [row.messageId, row.message_id, row.id, row.requestId, row.request_id].find((item) => typeof item === "string" || typeof item === "number");
  if (direct !== undefined) return String(direct).slice(0, 500);
  const data = Array.isArray(row.data) ? row.data[0] : row.data;
  return data && typeof data === "object" ? providerMessageId(data) : null;
}

export async function sendMsg91Notification(input: {
  eventType: NotificationEventType;
  recipientPhoneE164: string;
  payload: NotificationPayload;
  template: TemplateSnapshot;
  fetcher?: FetchLike;
}) {
  const config = getMsg91Config();
  const recipient = msg91Recipient(input.recipientPhoneE164);
  if (!recipient) throw new Msg91DeliveryError("Recipient phone must be a stored E.164 number.", false);
  if (!config.isConfigured) throw new Msg91DeliveryError("MSG91 WhatsApp is not configured.", false);

  const templatePayload = renderMsg91Template({ eventType: input.eventType, recipient, payload: input.payload, template: input.template });
  const request = { integrated_number: config.senderNumber || "mock-sender", content_type: "template", payload: templatePayload };
  if (config.transport === "mock") {
    const mode = env("MEENAKSHI_MSG91_MOCK_RESULT").toLowerCase();
    if (mode === "temporary_failure") throw new Msg91DeliveryError("Mock MSG91 temporary failure.", true, 503, { mock: true, mode });
    if (mode === "permanent_failure") throw new Msg91DeliveryError("Mock MSG91 permanent failure.", false, 400, { mock: true, mode });
    const payload = { mock: true, accepted: true, messageId: `mock-${randomUUID()}` };
    return { request, payload, providerMessageId: providerMessageId(payload), mocked: true };
  }
  if (!config.authKey || !config.senderNumber) throw new Msg91DeliveryError("MSG91 WhatsApp is not configured.", false);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Number(env("MEENAKSHI_MSG91_TIMEOUT_MS") || 15_000)));
  try {
    const response = await (input.fetcher ?? fetch)(`${config.baseUrl}/whatsapp-outbound-message/bulk/`, {
      method: "POST", headers: { authkey: config.authKey, "content-type": "application/json" },
      body: JSON.stringify(request), signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (payload && typeof payload === "object" && "hasError" in payload && payload.hasError === true)) {
      throw new Msg91DeliveryError(readProviderError(payload, response.status), response.status === 429 || response.status >= 500, response.status, payload);
    }
    return { request, payload, providerMessageId: providerMessageId(payload), mocked: false };
  } catch (error) {
    if (error instanceof Msg91DeliveryError) throw error;
    const message = error instanceof Error && error.name === "AbortError" ? "MSG91 request timed out." : error instanceof Error ? error.message : "MSG91 request failed.";
    throw new Msg91DeliveryError(message, true, null);
  } finally {
    clearTimeout(timeout);
  }
}
