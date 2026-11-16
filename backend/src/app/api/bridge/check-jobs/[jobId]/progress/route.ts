import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { isUuid, readBridgeToken } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ jobId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Keeps the lease alive and stores progress. The answer says whether a user asked to stop. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const body = await request.json().catch(() => ({})) as { connectorId?: unknown; progress?: unknown; attempt?: unknown };
    const token = readBridgeToken(request);
    if (!Number.isInteger(body.attempt) || Number(body.attempt) < 1) return jsonWithCors(request, { error: "A valid attempt is required." }, { status: 400 });
    if (!isUuid(jobId) || !isUuid(body.connectorId) || !token) return jsonWithCors(request, { error: "Invalid request." }, { status: 400 });
    const connector = await authenticateMeenakshiBridge(body.connectorId, token);
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    const workerId = `meenakshi-bridge:${connector.id}:${connector.machine_fingerprint.slice(-32)}`;
    const progress = body.progress && typeof body.progress === "object" ? body.progress : null;
    const { data, error } = await createSupabaseAdminClient().rpc("renew_tally_check_job_v2", { p_attempt: body.attempt, p_job_id: jobId, p_worker_id: workerId, p_lease_seconds: 180, p_progress: progress });
    if (error) throw error;
    return jsonWithCors(request, data);
  } catch (error) {
    console.error("Error in POST /api/bridge/check-jobs/:id/progress:", error);
    return jsonWithCors(request, { error: "Could not record progress." }, { status: 500 });
  }
}
