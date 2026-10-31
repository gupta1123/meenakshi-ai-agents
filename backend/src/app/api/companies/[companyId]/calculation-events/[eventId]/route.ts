import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; eventId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

const STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const STEPS = ["server_prepare", "tally_read", "calculation", "save"] as const;
const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const small = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const json = JSON.stringify(value);
  return json.length <= 2_000 ? value : null;
};

// Records how a Calculate click ended and, if it failed, where and why.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, eventId } = await context.params;
    if (!isUuid(companyId) || !isUuid(eventId)) return jsonWithCors(request, { error: "Invalid id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const status = STATUSES.find((value) => value === body.status);
    if (!status) return jsonWithCors(request, { error: "Unknown status." }, { status: 400 });
    const step = STEPS.find((value) => value === body.failingStep) ?? null;
    const { error } = await createSupabaseAdminClient().from("calculation_events").update({
      status,
      failing_step: status === "succeeded" ? null : step,
      failure_reason: status === "succeeded" ? null : text(body.failureReason, 500),
      step_timings: small(body.stepTimings) ?? {},
      last_progress: small(body.lastProgress),
      connector_version: text(body.connectorVersion, 40),
      finished_at: new Date().toISOString(),
    }).eq("id", eventId).eq("company_id", company.id).eq("status", "started");
    if (error) throw error;
    return jsonWithCors(request, { ok: true });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("calculation event finish failed", error instanceof Error ? error.message : error);
    return jsonWithCors(request, { error: "The activity record could not be saved." }, { status: 500 });
  }
}
