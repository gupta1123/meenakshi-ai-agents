import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { authenticateMeenakshiBridge, bridgeVersionIsOlder, MINIMUM_BRIDGE_VERSION, serializeTallyConnector } from "@/lib/bridge";
import { isUuid, readBridgeToken, readText, requestIpHash } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function OPTIONS(request: Request) { return optionsWithCors(request); }
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const connectorId = readText(body.connectorId, 80);
    const installationKey = readText(body.installationKey, 160);
    const machineFingerprint = readText(body.machineFingerprint, 500);
    const bridgeVersion = readText(body.bridgeVersion, 120) ?? "unknown";
    const controlToken = readBridgeToken(request) || readText(body.controlToken, 500) || "";
    if (!isUuid(connectorId) || !installationKey || !machineFingerprint || !controlToken) {
      return jsonWithCors(request, { error: "connectorId, installationKey, machineFingerprint, and controlToken are required." }, { status: 400 });
    }
    if (bridgeVersionIsOlder(bridgeVersion)) return jsonWithCors(request, { error: `Connector update required. Install Meenakshi Tally Connector ${MINIMUM_BRIDGE_VERSION} or newer.` }, { status: 426 });
    const connector = await authenticateMeenakshiBridge(connectorId, controlToken, { allowPending: true });
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    if (connector.status === "paired") return jsonWithCors(request, { error: "Connector is already paired." }, { status: 409 });
    if (connector.installation_key !== installationKey || connector.machine_fingerprint !== machineFingerprint) {
      return jsonWithCors(request, { error: "Connector installation identity does not match." }, { status: 409 });
    }
    const now = new Date().toISOString();
    const { data, error } = await createSupabaseAdminClient().from("tally_connectors").update({ status: "paired", paired_at: now, bridge_version: bridgeVersion, last_heartbeat_at: now, last_ip_hash: requestIpHash(request) }).eq("id", connector.id).eq("status", "pending_pairing").select("id, organization_id, installation_key, display_name, machine_fingerprint, control_token_hash, status, bridge_version, last_heartbeat_at, last_ip_hash, paired_by, paired_at, revoked_at, created_at, updated_at").maybeSingle();
    if (error) throw error;
    if (!data) return jsonWithCors(request, { error: "Connector pairing state changed. Retry from setup." }, { status: 409 });
    const paired = data as typeof connector;
    await appendMeenakshiAuditEvent({ organizationId: paired.organization_id, actorType: "tally_connector", action: "tally_connector_paired", entityType: "tally_connector", entityId: paired.id, newValue: { bridgeVersion, installationKey: paired.installation_key }, metadata: { machineFingerprint: paired.machine_fingerprint } });
    return jsonWithCors(request, { connector: serializeTallyConnector(paired) });
  } catch (error) {
    console.error("Error in POST /api/bridge/pair:", error);
    return jsonWithCors(request, { error: "Could not pair Tally bridge." }, { status: 500 });
  }
}
