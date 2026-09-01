import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { MeenakshiAccessError, requireMeenakshiOrganizationAccess } from "@/lib/authorization";
import { serializeTallyConnector, TALLY_CONNECTOR_SELECT, type TallyConnectorRow } from "@/lib/bridge";
import { createConnectorControlToken, hashConnectorSecret, isUuid, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ connectorId: string }> };

function normalizeTallyUrl(value: string | null) {
  if (!value) return "http://localhost:9000";
  const candidate = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Tally server URL must use http or https.");
  return url.toString().replace(/\/$/, "");
}

function isRuntimeSchemaUnavailable(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "PGRST204" || /tally_url/i.test(value?.message ?? "");
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { connectorId } = await context.params;
    if (!isUuid(connectorId)) return jsonWithCors(request, { error: "Invalid connector id." }, { status: 400 });
    const supabase = createSupabaseAdminClient();
    const { data: existing, error: existingError } = await supabase.from("tally_connectors").select(TALLY_CONNECTOR_SELECT).eq("id", connectorId).maybeSingle();
    if (existingError) throw existingError;
    const connector = existing as unknown as TallyConnectorRow | null;
    if (!connector || connector.status === "revoked") return jsonWithCors(request, { error: "Connector was not found." }, { status: 404 });
    const scope = await requireMeenakshiOrganizationAccess(request, connector.organization_id, ["administrator"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const tallyUrl = normalizeTallyUrl(readText(body.tallyUrl, 500));
    const controlToken = createConnectorControlToken();
    const controlTokenHash = hashConnectorSecret(controlToken);
    const rotation = await supabase.rpc("rotate_meenakshi_connector_session", {
      p_connector_id: connector.id,
      p_control_token_hash: controlTokenHash,
      p_tally_url: tallyUrl,
    });
    const migrationUnavailable = rotation.error?.code === "PGRST202" || rotation.error?.code === "42883" || /rotate_meenakshi_connector_session/i.test(rotation.error?.message ?? "");
    if (rotation.error && !migrationUnavailable) throw rotation.error;
    if (migrationUnavailable) {
      const fallback = await supabase.from("tally_connectors")
        .update({ control_token_hash: controlTokenHash, status: "pending_pairing", paired_at: null, last_heartbeat_at: null })
        .eq("id", connector.id);
      if (fallback.error) throw fallback.error;
      const runtimeUpdate = await supabase.from("tally_connectors").update({ tally_url: tallyUrl }).eq("id", connector.id);
      if (runtimeUpdate.error && !isRuntimeSchemaUnavailable(runtimeUpdate.error)) throw runtimeUpdate.error;
    }
    const { data, error } = await supabase.from("tally_connectors").select(TALLY_CONNECTOR_SELECT).eq("id", connector.id).single();
    if (error) throw error;
    await appendMeenakshiAuditEvent({
      organizationId: connector.organization_id,
      actorType: "user",
      actorId: scope.userId,
      action: "tally_connector_credential_rotated",
      entityType: "tally_connector",
      entityId: connector.id,
      previousValue: { status: connector.status },
      newValue: { status: "pending_pairing", tallyUrl },
    });
    // The token is intentionally returned exactly for this response. It is
    // never persisted by the browser and must be copied to the local bridge.
    return jsonWithCors(request, { connector: serializeTallyConnector(data as unknown as TallyConnectorRow), controlToken, tallyUrl }, { status: 201 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not rotate connector credential:", error);
    return jsonWithCors(request, { error: "Could not rotate the connector credential." }, { status: 500 });
  }
}
