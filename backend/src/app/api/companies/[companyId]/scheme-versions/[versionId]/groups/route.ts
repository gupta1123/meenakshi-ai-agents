import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readRequiredUuid, requireCurrentMasterSync, requireDraftVersion, requireRulebookVersionForCompany, requireSundryDebtorsGroup, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; versionId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

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
