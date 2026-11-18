import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { bridgeSupportAccess } from "@/lib/bridge-support";
import { SupportError, interruptConnectorWork } from "@/lib/connector-support";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { bridgeVersionIsOlder } from "@/lib/bridge";
export function OPTIONS(r: Request) {
  return optionsWithCors(r);
}
export async function POST(r: Request) {
  try {
    const body = await r.json();
    const connector = await bridgeSupportAccess(r, body.connectorId);
    if (
      bridgeVersionIsOlder(body.version || "0.0.0", "0.6.0") ||
      body.mode !== "server" ||
      body.startupEnabled !== true
    )
      throw new SupportError("Verify the background server task first.", 409);
    const db = createSupabaseAdminClient();
    const { data: bindings, error } = await db
      .from("tally_connector_company_bindings")
      .select("company_id")
      .eq("connector_id", connector.id)
      .eq("is_active", true);
    if (error) throw error;
    if (!bindings?.length)
      throw new SupportError(
        "Pair this Tally company before completing server setup.",
        409,
      );
    const { data: previous, error: pe } = await db
      .from("tally_connector_modes")
      .select("mode")
      .eq("connector_id", connector.id)
      .maybeSingle();
    if (pe) throw pe;
    if(previous?.mode!=="server"||bridgeVersionIsOlder(connector.bridge_version||"0.0.0",body.version))await interruptConnectorWork(connector.id);
    // This paired worker has already entered server mode and verified startup.
    // Complete the one-way website handover without stranding queued work behind
    // the older, website-only mode-switch guard. The same worker processes it.
    const { error: modeError } = await db
      .from("tally_connector_modes")
      .upsert(
        {
          connector_id: connector.id,
          mode: "server",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "connector_id" },
      );
    if (modeError) throw modeError;
    if (previous?.mode !== "server")
      await appendMeenakshiAuditEvent({
        organizationId: connector.organization_id,
        companyId: bindings[0].company_id,
        actorType: "tally_connector",
        action: "tally_server_setup_completed",
        entityType: "tally_connector",
        entityId: connector.id,
        newValue: { mode: "server", startupEnabled: true },
      });
    return jsonWithCors(r, { ok: true, mode: "server" });
  } catch (e) {
    return jsonWithCors(
      r,
      {
        error:
          e instanceof Error ? e.message : "Server setup could not finish.",
      },
      { status: e instanceof SupportError ? e.status : 500 },
    );
  }
}
