import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { MeenakshiAccessError, requireMeenakshiOrganizationAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ connectorId: string; bindingId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { connectorId, bindingId } = await context.params;
    if (!isUuid(connectorId) || !isUuid(bindingId)) return jsonWithCors(request, { error: "Invalid connector or binding id." }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { isActive?: unknown };
    if (body.isActive !== false) return jsonWithCors(request, { error: "Only deactivating a binding is supported." }, { status: 400 });
    const supabase = createSupabaseAdminClient();
    const { data: connector, error: connectorError } = await supabase.from("tally_connectors").select("id, organization_id").eq("id", connectorId).maybeSingle();
    if (connectorError) throw connectorError;
    if (!connector) return jsonWithCors(request, { error: "Connector was not found." }, { status: 404 });
    const scope = await requireMeenakshiOrganizationAccess(request, connector.organization_id, ["administrator"]);
    const { data: existing, error: existingError } = await supabase.from("tally_connector_company_bindings")
      .select("id, company_id, is_active, expected_tally_company_guid, expected_tally_company_name")
      .eq("id", bindingId).eq("connector_id", connectorId).eq("organization_id", connector.organization_id).maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return jsonWithCors(request, { error: "Connector binding was not found." }, { status: 404 });
    const { data, error } = await supabase.from("tally_connector_company_bindings").update({ is_active: false })
      .eq("id", bindingId).eq("connector_id", connectorId).select("id, company_id, connector_id, is_active, expected_tally_company_guid, expected_tally_company_name, updated_at").single();
    if (error) throw error;
    await appendMeenakshiAuditEvent({
      organizationId: connector.organization_id,
      companyId: existing.company_id,
      actorType: "user",
      actorId: scope.userId,
      action: "tally_connector_company_binding_deactivated",
      entityType: "tally_connector_company_binding",
      entityId: bindingId,
      previousValue: { isActive: existing.is_active, expectedCompanyGuid: existing.expected_tally_company_guid },
      newValue: { isActive: false },
    });
    return jsonWithCors(request, { binding: data });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not update connector binding:", error);
    return jsonWithCors(request, { error: "Could not update the connector binding." }, { status: 500 });
  }
}
