import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { isUuid, readBridgeToken, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const connectorId = readText(body.connectorId, 80);
    const machineFingerprint = readText(body.machineFingerprint, 500);
    const controlToken = readBridgeToken(request) || readText(body.controlToken, 500) || "";
    if (!isUuid(connectorId) || !machineFingerprint || !controlToken) {
      return jsonWithCors(request, { error: "Connector identity is required." }, { status: 400 });
    }
    const connector = await authenticateMeenakshiBridge(connectorId, controlToken);
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    if (connector.machine_fingerprint !== machineFingerprint) {
      return jsonWithCors(request, { error: "Disconnect came from a different connector installation." }, { status: 409 });
    }
    const disconnectedAt = new Date().toISOString();
    const staleHeartbeat = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const { error } = await createSupabaseAdminClient().from("tally_connectors").update({
      last_heartbeat_at: staleHeartbeat,
      last_tally_reachable: false,
      last_company_loaded: false,
      last_company_name: null,
      last_error: "Connector closed",
      last_tested_at: disconnectedAt,
    }).eq("id", connector.id).eq("status", "paired");
    if (error && !/last_tally_reachable|last_company_loaded|last_company_name|last_error|last_tested_at/i.test(error.message)) throw error;
    if (error) {
      const legacy = await createSupabaseAdminClient().from("tally_connectors").update({ last_heartbeat_at: staleHeartbeat }).eq("id", connector.id).eq("status", "paired");
      if (legacy.error) throw legacy.error;
    }
    await appendMeenakshiAuditEvent({
      organizationId: connector.organization_id,
      actorType: "tally_connector",
      action: "tally_connector_disconnected",
      entityType: "tally_connector",
      entityId: connector.id,
      metadata: { disconnectedAt, reason: "connector_closed" },
    });
    return jsonWithCors(request, { disconnectedAt });
  } catch (error) {
    console.error("Error in POST /api/bridge/disconnect:", error);
    return jsonWithCors(request, { error: "Could not record connector shutdown." }, { status: 500 });
  }
}
