import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { MeenakshiAccessError, requireMeenakshiOrganizationAccess } from "@/lib/authorization";
import { TALLY_CONNECTOR_SELECT, type TallyConnectorRow } from "@/lib/bridge";
import { isUuid, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ connectorId: string }> };
async function findConnector(id: string) {
  const { data, error } = await createSupabaseAdminClient().from("tally_connectors").select(TALLY_CONNECTOR_SELECT).eq("id", id).maybeSingle();
  if (error) throw error;
  return data as unknown as TallyConnectorRow | null;
}
function errorResponse(request: Request, error: unknown) {
  if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
  console.error("Meenakshi connector binding request failed:", error);
  return jsonWithCors(request, { error: "Could not process the company binding." }, { status: 500 });
}
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { connectorId } = await context.params;
    if (!isUuid(connectorId)) return jsonWithCors(request, { error: "Invalid connector id." }, { status: 400 });
    const connector = await findConnector(connectorId);
    if (!connector) return jsonWithCors(request, { error: "Connector not found." }, { status: 404 });
    await requireMeenakshiOrganizationAccess(request, connector.organization_id);
    const { data, error } = await createSupabaseAdminClient().from("tally_connector_company_bindings").select("id, company_id, connector_id, expected_tally_company_guid, expected_tally_company_name, observed_tally_company_guid, observed_tally_company_name, is_active, last_validated_at, last_mismatch_at, created_at, updated_at").eq("connector_id", connector.id).order("created_at", { ascending: false });
    if (error) throw error;
    return jsonWithCors(request, { bindings: data ?? [] });
  } catch (error) { return errorResponse(request, error); }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { connectorId } = await context.params;
    if (!isUuid(connectorId)) return jsonWithCors(request, { error: "Invalid connector id." }, { status: 400 });
    const connector = await findConnector(connectorId);
    if (!connector || connector.status === "revoked") return jsonWithCors(request, { error: "Connector not found." }, { status: 404 });
    const scope = await requireMeenakshiOrganizationAccess(request, connector.organization_id, ["administrator"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const companyId = readText(body.companyId, 80);
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "companyId must be a UUID." }, { status: 400 });
    const supabase = createSupabaseAdminClient();
    const { data: company, error: companyError } = await supabase.from("companies").select("id, organization_id, tally_company_guid, tally_company_name, is_active").eq("id", companyId).maybeSingle();
    if (companyError) throw companyError;
    const row = company as { id: string; organization_id: string; tally_company_guid: string; tally_company_name: string; is_active: boolean } | null;
    if (!row || !row.is_active || row.organization_id !== connector.organization_id) return jsonWithCors(request, { error: "Company is not available to this connector." }, { status: 404 });
    const { data: bindingId, error: assignmentError } = await supabase.rpc("assign_tally_company_connector", { p_company_id: row.id, p_connector_id: connector.id });
    let bindingQuery = bindingId
      ? supabase.from("tally_connector_company_bindings").select("id, company_id, connector_id, expected_tally_company_guid, expected_tally_company_name, is_active, created_at").eq("id", bindingId).single()
      : null;
    // Keep ordinary first-time registration working while the additive
    // migration awaits its deliberate manual application. Reassignment still
    // requires the migration because the legacy unique constraint rejects it.
    if (assignmentError?.code === "PGRST202") {
      bindingQuery = supabase.from("tally_connector_company_bindings").insert({ organization_id: connector.organization_id, company_id: row.id, connector_id: connector.id, expected_tally_company_guid: row.tally_company_guid, expected_tally_company_name: row.tally_company_name, is_active: true }).select("id, company_id, connector_id, expected_tally_company_guid, expected_tally_company_name, is_active, created_at").single();
    } else if (assignmentError) {
      throw assignmentError;
    }
    if (!bindingQuery) throw new Error("Connector assignment did not return a binding.");
    const { data: binding, error } = await bindingQuery;
    if (error?.code === "23505") return jsonWithCors(request, { error: "This company already has a connector binding. Apply the multi-installation routing migration before moving it." }, { status: 409 });
    if (error) throw error;
    await appendMeenakshiAuditEvent({ organizationId: connector.organization_id, companyId: row.id, actorType: "user", actorId: scope.userId, action: "tally_connector_company_bound", entityType: "tally_connector_company_binding", entityId: (binding as { id: string }).id, newValue: { connectorId: connector.id, expectedCompanyGuid: row.tally_company_guid } });
    return jsonWithCors(request, { binding }, { status: 201 });
  } catch (error) { return errorResponse(request, error); }
}
