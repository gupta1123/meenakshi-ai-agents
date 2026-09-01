import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { isUuid, readBridgeToken } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type TallyCommandRow = { id: string; company_id: string; command_type: string; correlation_id: string; expected_tally_company_guid: string; expected_tally_company_name: string; payload: Record<string, unknown>; attempts: number };
function serializeCommand(command: TallyCommandRow) {
  return { id: command.id, companyId: command.company_id, commandType: command.command_type, correlationId: command.correlation_id, expectedTallyCompany: { guid: command.expected_tally_company_guid, name: command.expected_tally_company_name }, payload: command.payload, attempt: command.attempts };
}
export function OPTIONS(request: Request) { return optionsWithCors(request); }
export async function GET(request: Request) {
  try {
    const connectorId = new URL(request.url).searchParams.get("connectorId");
    const controlToken = readBridgeToken(request);
    if (!isUuid(connectorId) || !controlToken) return jsonWithCors(request, { error: "connectorId and bridge credential are required." }, { status: 400 });
    const connector = await authenticateMeenakshiBridge(connectorId, controlToken);
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    const workerId = `meenakshi-bridge:${connector.id}:${connector.machine_fingerprint.slice(-32)}`;
    const { data, error } = await createSupabaseAdminClient().rpc("claim_tally_commands", { p_connector_id: connector.id, p_worker_id: workerId, p_limit: 1, p_lease_seconds: 90 });
    if (error) throw error;
    const command = (data as unknown as TallyCommandRow[] | null)?.[0] ?? null;
    if (command && (command.command_type === "sync_meenakshi_masters" || command.command_type === "sync_meenakshi_vouchers" || command.command_type === "fetch_meenakshi_evidence")) {
      const syncRunIds = command.command_type === "fetch_meenakshi_evidence"
        ? [command.payload.masterSyncRunId, command.payload.voucherSyncRunId]
        : [command.payload.syncRunId];
      for (const syncRunId of syncRunIds) {
        if (typeof syncRunId !== "string") continue;
        const { error: syncRunError } = await createSupabaseAdminClient()
          .from("tally_sync_runs")
          .update({ status: "running", started_at: new Date().toISOString(), error_summary: null })
          .eq("id", syncRunId)
          .eq("company_id", command.company_id)
          .eq("status", "queued");
        if (syncRunError) throw syncRunError;
      }
    }
    return jsonWithCors(request, { command: command ? serializeCommand(command) : null });
  } catch (error) {
    console.error("Error in GET /api/bridge/commands/next:", error);
    return jsonWithCors(request, { error: "Could not claim Tally command." }, { status: 500 });
  }
}
