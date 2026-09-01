import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readRequiredUuid, requireCurrentMasterSync, requireDraftVersion, requireRulebookVersionForCompany, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; versionId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

async function requireSundryDebtorsGroup(companyId: string, customerGroupId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("customer_groups")
    .select("id, name, parent_group_id, is_available")
    .eq("company_id", companyId);
  if (error) throw error;
  const groups = (data ?? []) as Array<{ id: string; name: string; parent_group_id: string | null; is_available: boolean }>;
  const byId = new Map(groups.map((group) => [group.id, group]));
  const selected = byId.get(customerGroupId);
  if (!selected || selected.is_available !== true) throw new RulebookRequestError("Customer group is unavailable for this company.", 409);
  const visited = new Set<string>();
  let current: typeof selected | undefined = selected;
  while (current && !visited.has(current.id)) {
    if (current.name.trim().toLowerCase() === "sundry debtors") return;
    visited.add(current.id);
    current = current.parent_group_id ? byId.get(current.parent_group_id) : undefined;
  }
  throw new RulebookRequestError("Discount rules can include only Sundry Debtors or one of its customer subgroups.", 409);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    const [selected, coverage] = await Promise.all([
      createSupabaseAdminClient().from("scheme_version_customer_groups").select("customer_group_id, include_descendants, created_at").eq("scheme_version_id", version.id),
      createSupabaseAdminClient().from("scheme_version_group_coverage").select("customer_group_id, created_at").eq("scheme_version_id", version.id),
    ]);
    if (selected.error || coverage.error) throw selected.error ?? coverage.error;
    return jsonWithCors(request, { selectedGroups: selected.data ?? [], recursiveCoverage: coverage.data ?? [] });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load customer-group coverage");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireDraftVersion(version);
    await requireCurrentMasterSync(scope.company.id);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const customerGroupId = readRequiredUuid(body.customerGroupId, "customerGroupId");
    await requireSundryDebtorsGroup(scope.company.id, customerGroupId);
    const { error } = await createSupabaseAdminClient()
      .from("scheme_version_customer_groups")
      .upsert({ scheme_version_id: version.id, company_id: scope.company.id, customer_group_id: customerGroupId, include_descendants: true }, { onConflict: "scheme_version_id,customer_group_id" });
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "scheme_version_customer_group_added", entityType: "scheme_version", entityId: version.id, newValue: { customerGroupId, includeDescendants: true } });
    return jsonWithCors(request, { customerGroupId, includeDescendants: true }, { status: 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "add customer group to rule version");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireDraftVersion(version);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const customerGroupId = readRequiredUuid(body.customerGroupId, "customerGroupId");
    const { error } = await createSupabaseAdminClient().from("scheme_version_customer_groups").delete().eq("scheme_version_id", version.id).eq("customer_group_id", customerGroupId);
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "scheme_version_customer_group_removed", entityType: "scheme_version", entityId: version.id, previousValue: { customerGroupId } });
    return jsonWithCors(request, { success: true });
  } catch (error) {
    return rulebookErrorResponse(request, error, "remove customer group from rule version");
  }
}
