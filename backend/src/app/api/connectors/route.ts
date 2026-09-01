import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { MeenakshiAccessError, requireMeenakshiOrganizationAccess } from "@/lib/authorization";
import { serializeTallyConnector, TALLY_CONNECTOR_SELECT, type TallyConnectorRow } from "@/lib/bridge";
import { createConnectorControlToken, hashConnectorSecret, isUuid, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function errorResponse(request: Request, error: unknown) {
  if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
  console.error("Meenakshi connector request failed:", error);
  return jsonWithCors(request, { error: "Could not process the connector request." }, { status: 500 });
}
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request) {
  try {
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    if (!isUuid(organizationId)) return jsonWithCors(request, { error: "organizationId must be a UUID." }, { status: 400 });
    await requireMeenakshiOrganizationAccess(request, organizationId);
    const { data, error } = await createSupabaseAdminClient().from("tally_connectors").select(TALLY_CONNECTOR_SELECT).eq("organization_id", organizationId).order("created_at", { ascending: false });
    if (error) throw error;
    return jsonWithCors(request, { connectors: ((data ?? []) as unknown as TallyConnectorRow[]).map(serializeTallyConnector) });
  } catch (error) { return errorResponse(request, error); }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = readText(body.organizationId, 80);
    const installationKey = readText(body.installationKey, 160);
    const displayName = readText(body.displayName, 160) ?? "Meenakshi Tally Bridge";
    const machineFingerprint = readText(body.machineFingerprint, 500);
    if (!isUuid(organizationId) || !installationKey || !machineFingerprint) {
      return jsonWithCors(request, { error: "organizationId, installationKey, and machineFingerprint are required." }, { status: 400 });
    }
    const scope = await requireMeenakshiOrganizationAccess(request, organizationId, ["administrator"]);
    const controlToken = createConnectorControlToken();
    const { data, error } = await createSupabaseAdminClient().from("tally_connectors").insert({
      organization_id: organizationId, installation_key: installationKey, display_name: displayName, machine_fingerprint: machineFingerprint,
      control_token_hash: hashConnectorSecret(controlToken), status: "pending_pairing", paired_by: scope.userId,
    }).select(TALLY_CONNECTOR_SELECT).single();
    if (error) {
      if (error.code === "23505") return jsonWithCors(request, { error: "That installation key is already registered." }, { status: 409 });
      throw error;
    }
    const connector = data as unknown as TallyConnectorRow;
    await appendMeenakshiAuditEvent({ organizationId, actorType: "user", actorId: scope.userId, action: "tally_connector_created", entityType: "tally_connector", entityId: connector.id, newValue: { installationKey, displayName, status: connector.status } });
    return jsonWithCors(request, { connector: serializeTallyConnector(connector), controlToken }, { status: 201 });
  } catch (error) { return errorResponse(request, error); }
}
