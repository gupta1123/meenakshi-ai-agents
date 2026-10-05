import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { authenticateMeenakshiBridge } from "@/lib/bridge";
import { isUuid, readBridgeToken, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ commandId: string }> };

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { commandId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const connectorId = readText(body.connectorId, 80);
    const controlToken = readBridgeToken(request) || readText(body.controlToken, 500) || "";
    const attempt = Number(body.attempt);
    if (!isUuid(commandId) || !isUuid(connectorId) || !controlToken || !Number.isInteger(attempt) || attempt < 1) {
      return jsonWithCors(request, { error: "commandId, connectorId, bridge credential, and attempt are required." }, { status: 400 });
    }
    const connector = await authenticateMeenakshiBridge(connectorId, controlToken);
    if (!connector) return jsonWithCors(request, { error: "Invalid connector credential." }, { status: 401 });
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 90_000).toISOString();
    const { data, error } = await createSupabaseAdminClient().from("tally_commands")
      .update({ lease_expires_at: leaseExpiresAt })
      .eq("id", commandId)
      .eq("connector_id", connector.id)
      .eq("status", "sending")
      .eq("attempts", attempt)
      .gt("lease_expires_at", now)
      .select("id, attempts, lease_expires_at")
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonWithCors(request, { error: "This command lease is no longer current." }, { status: 409 });
    return jsonWithCors(request, { command: data });
  } catch (error) {
    console.error("Error in POST /api/bridge/commands/[commandId]/lease:", error);
    return jsonWithCors(request, { error: "Could not renew the Tally command lease." }, { status: 500 });
  }
}
