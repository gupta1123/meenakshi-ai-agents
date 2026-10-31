import { apiRequest, ApiError, jsonBody } from "@/lib/api";
import { LocalCalculationError } from "@/lib/local-tally";

export type CalculationStep = "server_prepare" | "tally_read" | "calculation" | "save";
type Outcome = "succeeded" | "failed" | "cancelled" | "timed_out";

/** Records that a Calculate click started. Returns null (and never throws) if it could not be recorded. */
export async function startCalculationEvent(token: string, companyId: string, scheme: "cd" | "tod", periodStart?: string | null, periodEnd?: string | null, connectorVersion?: string | null) {
  try {
    const response = await apiRequest<{ id: string }>(token, `/api/companies/${companyId}/calculation-events`, {
      method: "POST", body: jsonBody({ scheme, periodStart, periodEnd, connectorVersion }), timeoutMs: 10_000,
    });
    return response.id;
  } catch { return null; }
}

/** Works out how a failed calculation should be recorded. */
export function describeCalculationFailure(cause: unknown, step: CalculationStep): { outcome: Outcome; step: CalculationStep; reason: string; lastProgress: Record<string, unknown> | null } {
  if (cause instanceof LocalCalculationError) {
    return { outcome: cause.timedOut ? "timed_out" : "failed", step: cause.failedStep, reason: cause.message, lastProgress: cause.lastProgress };
  }
  if (cause instanceof ApiError) return { outcome: "failed", step, reason: `${step === "save" ? "The result could not be saved" : "The server could not prepare the check"} (status ${cause.status}).`, lastProgress: null };
  const reason = cause instanceof Error ? cause.message : "Unknown error.";
  return { outcome: cause instanceof Error && cause.name === "TimeoutError" ? "timed_out" : "failed", step, reason, lastProgress: null };
}

/** Records how a Calculate click ended. Never throws. */
export async function finishCalculationEvent(token: string, companyId: string, eventId: string | null, details: { outcome: Outcome; step?: CalculationStep | null; reason?: string | null; timings?: Record<string, number>; lastProgress?: Record<string, unknown> | null; connectorVersion?: string | null }) {
  if (!eventId) return;
  try {
    await apiRequest(token, `/api/companies/${companyId}/calculation-events/${eventId}`, {
      method: "POST", timeoutMs: 10_000,
      body: jsonBody({ status: details.outcome, failingStep: details.step ?? null, failureReason: details.reason ?? null, stepTimings: details.timings ?? {}, lastProgress: details.lastProgress ?? null, connectorVersion: details.connectorVersion ?? null }),
    });
  } catch { /* the calculation result matters more than its activity record */ }
}
