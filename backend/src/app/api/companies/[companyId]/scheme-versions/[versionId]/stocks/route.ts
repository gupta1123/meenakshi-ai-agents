import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readRequiredUuid, requireAvailableReference, requireCurrentMasterSync, requireDraftVersion, requireRulebookVersionForCompany, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; versionId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

// TOD rules and per-MT Cash Discount rules both need eligible products.
function requireTod(version: { scheme_type: string; cd_discount_basis?: string | null }) {
  if (version.scheme_type === "tod" || (version.scheme_type === "cd" && version.cd_discount_basis === "amount_per_tonne")) return;
  throw new RulebookRequestError("Stock eligibility is available only for TOD and per-MT Cash Discount rule versions.", 409);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireTod(version);
    const [items, groups, coverage] = await Promise.all([
      createSupabaseAdminClient().from("scheme_version_stock_items").select("stock_item_id").eq("scheme_version_id", version.id),
      createSupabaseAdminClient().from("scheme_version_stock_groups").select("stock_group_id").eq("scheme_version_id", version.id),
      createSupabaseAdminClient().from("scheme_version_stock_group_coverage").select("stock_group_id, created_at").eq("scheme_version_id", version.id),
    ]);
    if (items.error || groups.error || coverage.error) throw items.error ?? groups.error ?? coverage.error;
    return jsonWithCors(request, { stockItems: items.data ?? [], stockGroups: groups.data ?? [], recursiveStockGroupCoverage: coverage.data ?? [] });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load TOD stock eligibility");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireTod(version);
    requireDraftVersion(version);
    await requireCurrentMasterSync(scope.company.id);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = body.kind;
    if (kind !== "stockItem" && kind !== "stockGroup") return jsonWithCors(request, { error: "kind must be stockItem or stockGroup." }, { status: 400 });
    const id = readRequiredUuid(body.id, "id");
    const table = kind === "stockItem" ? "stock_items" : "stock_groups";
    const targetTable = kind === "stockItem" ? "scheme_version_stock_items" : "scheme_version_stock_groups";
    const targetColumn = kind === "stockItem" ? "stock_item_id" : "stock_group_id";
    await requireAvailableReference({ table, id, companyId: scope.company.id, label: kind === "stockItem" ? "Stock item" : "Stock group" });
    const { error } = await createSupabaseAdminClient().from(targetTable).upsert({ scheme_version_id: version.id, company_id: scope.company.id, [targetColumn]: id }, { onConflict: `scheme_version_id,${targetColumn}` });
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "scheme_version_stock_eligibility_added", entityType: "scheme_version", entityId: version.id, newValue: { kind, id } });
    return jsonWithCors(request, { kind, id }, { status: 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "add TOD stock eligibility");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireTod(version);
    requireDraftVersion(version);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = body.kind;
    if (kind !== "stockItem" && kind !== "stockGroup") return jsonWithCors(request, { error: "kind must be stockItem or stockGroup." }, { status: 400 });
    const id = readRequiredUuid(body.id, "id");
    const table = kind === "stockItem" ? "scheme_version_stock_items" : "scheme_version_stock_groups";
    const column = kind === "stockItem" ? "stock_item_id" : "stock_group_id";
    const { error } = await createSupabaseAdminClient().from(table).delete().eq("scheme_version_id", version.id).eq(column, id);
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "scheme_version_stock_eligibility_removed", entityType: "scheme_version", entityId: version.id, previousValue: { kind, id } });
    return jsonWithCors(request, { success: true });
  } catch (error) {
    return rulebookErrorResponse(request, error, "remove TOD stock eligibility");
  }
}
