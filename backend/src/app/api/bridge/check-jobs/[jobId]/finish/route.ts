import { after } from "next/server";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { saveCheckJobResult } from "@/lib/check-job-save";
import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { isUuid, readBridgeToken } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ jobId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/**
 * The connector ends a check. A successful Cash Discount / Turnover Discount
 * result is then saved as an evaluation run in the background (after the
 * connector has its answer), so no page needs to be open for it to be saved.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const body = await request.json().catch(() => ({})) as { connectorId?: unknown; status?: unknown; result?: unknown; failingStep?: unknown; failureReason?: unknown };
    const token = readBridgeToken(request);
    if (!isUuid(jobId) || !isUuid(body.connectorId) || !token) return jsonWithCors(request, { error: "Invalid request." }, { status: 400 });
    if (body.status !== "succeeded" && body.status !== "failed" && body.status !== "cancelled") return jsonWithCors(request, { error: "status must be succeeded, failed or cancelled." }, { status: 400 });
    const connector = await authenticateMeenakshiBridge(body.connectorId, token);
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    const workerId = `meenakshi-bridge:${connector.id}:${connector.machine_fingerprint.slice(-32)}`;
    const { data, error } = await createSupabaseAdminClient().rpc("finish_tally_check_job", {
      p_job_id: jobId, p_worker_id: workerId, p_status: body.status,
      p_result: body.result && typeof body.result === "object" ? body.result : null,
      p_failing_step: typeof body.failingStep === "string" ? body.failingStep.slice(0, 100) : null,
      p_failure_reason: typeof body.failureReason === "string" ? body.failureReason : null,
      p_evaluation_run_id: null,
    });
    if (error) throw error;
    if (!data) return jsonWithCors(request, { error: "This check is no longer yours (it was stopped, expired or finished)." }, { status: 409 });
    if (body.status === "succeeded") after(() => saveCheckJobResult(jobId).catch((cause) => console.error("Could not save check job result:", cause)));
    return jsonWithCors(request, { ok: true });
  } catch (error) {
    console.error("Error in POST /api/bridge/check-jobs/:id/finish:", error);
    return jsonWithCors(request, { error: "Could not finish the check." }, { status: 500 });
  }
}
