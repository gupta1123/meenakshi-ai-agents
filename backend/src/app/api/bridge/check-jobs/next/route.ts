import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { isUuid, readBridgeToken } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** A server-mode connector claims its next check. PC connectors always get null (their mode is not server). */
export async function GET(request: Request) {
  try {
    const connectorId = new URL(request.url).searchParams.get("connectorId");
    const token = readBridgeToken(request);
    if (!isUuid(connectorId) || !token) return jsonWithCors(request, { error: "connectorId and bridge credential are required." }, { status: 400 });
    const connector = await authenticateMeenakshiBridge(connectorId, token);
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    const workerId = `meenakshi-bridge:${connector.id}:${connector.machine_fingerprint.slice(-32)}`;
    const db = createSupabaseAdminClient();
    const { data, error } = await db.rpc("claim_tally_check_job", { p_connector_id: connector.id, p_worker_id: workerId, p_lease_seconds: 180 });
    if (error) throw error;
    const job = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!job) return jsonWithCors(request, { job: null });
    const { data: binding } = await db.from("tally_connector_company_bindings")
      .select("expected_tally_company_guid, expected_tally_company_name")
      .eq("connector_id", connector.id).eq("company_id", String(job.company_id)).eq("is_active", true).maybeSingle();
    return jsonWithCors(request, {
      job: {
        id: job.id, companyId: job.company_id, kind: job.kind, scopeKey: job.scope_key, request: job.request,
        attempt: job.attempts, requestedBy: job.requested_by,
        expectedTallyCompany: { guid: binding?.expected_tally_company_guid ?? null, name: binding?.expected_tally_company_name ?? null },
      },
    });
  } catch (error) {
    console.error("Error in GET /api/bridge/check-jobs/next:", error);
    return jsonWithCors(request, { error: "Could not claim a check." }, { status: 500 });
  }
}
