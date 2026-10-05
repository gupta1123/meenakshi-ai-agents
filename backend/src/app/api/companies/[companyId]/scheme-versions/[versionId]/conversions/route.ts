import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readBoolean, readPositiveDecimal, readRequiredUuid, requireCurrentMasterSync, requireDraftVersion, requireRulebookVersionForCompany, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; versionId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

// TOD rules and per-MT Cash Discount rules both convert quantities to MT.
function requireTod(version: { scheme_type: string; cd_discount_basis?: string | null }) {
  if (version.scheme_type === "tod" || (version.scheme_type === "cd" && version.cd_discount_basis === "amount_per_tonne")) return;
  throw new RulebookRequestError("UOM conversions are available only for TOD and per-MT Cash Discount rule versions.", 409);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireTod(version);
    const { data, error } = await createSupabaseAdminClient().from("scheme_version_unit_conversions").select("source_uom_id, tonnes_per_source_unit, is_builtin, approved_by, approved_at, created_at").eq("scheme_version_id", version.id).order("created_at");
    if (error) throw error;
    return jsonWithCors(request, { conversions: data ?? [] });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load TOD UOM conversions");
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
    const sourceUomId = readRequiredUuid(body.sourceUomId, "sourceUomId");
    const isBuiltin = readBoolean(body.isBuiltin, "isBuiltin");
    const { data: unit, error: unitError } = await createSupabaseAdminClient().from("tally_units").select("id, code, is_available").eq("id", sourceUomId).eq("company_id", scope.company.id).maybeSingle();
    if (unitError) throw unitError;
    const unitRow = unit as { id: string; code: string; is_available: boolean } | null;
    if (!unitRow || !unitRow.is_available) return jsonWithCors(request, { error: "sourceUomId is unavailable for this company." }, { status: 409 });
    const code = unitRow.code.trim().toUpperCase();
    let tonnesPerSourceUnit: string;
    if (isBuiltin) {
      if (code === "MT" || code === "MTS" || code === "TON" || code === "TONNE" || code === "TONNES") tonnesPerSourceUnit = "1";
      else if (code === "KG" || code === "KGS") tonnesPerSourceUnit = "0.001";
      else return jsonWithCors(request, { error: "Only live tonne or kilogram units can use a built-in conversion." }, { status: 400 });
    } else {
      tonnesPerSourceUnit = readPositiveDecimal(body.tonnesPerSourceUnit, "tonnesPerSourceUnit", { maxScale: 9 });
    }
    const row = {
      scheme_version_id: version.id,
      company_id: scope.company.id,
      source_uom_id: sourceUomId,
      tonnes_per_source_unit: tonnesPerSourceUnit,
      is_builtin: isBuiltin,
      approved_by: isBuiltin ? null : scope.userId,
      approved_at: isBuiltin ? null : new Date().toISOString(),
    };
    const { data, error } = await createSupabaseAdminClient().from("scheme_version_unit_conversions")
      .upsert(row, { onConflict: "scheme_version_id,source_uom_id" })
      .select("source_uom_id, tonnes_per_source_unit, is_builtin, approved_by, approved_at, created_at")
      .single();
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "scheme_version_uom_conversion_saved", entityType: "scheme_version", entityId: version.id, newValue: { sourceUomId, sourceUomCode: code, tonnesPerSourceUnit, isBuiltin } });
    return jsonWithCors(request, { conversion: data });
  } catch (error) {
    return rulebookErrorResponse(request, error, "save TOD UOM conversion");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireTod(version);
    requireDraftVersion(version);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const sourceUomId = readRequiredUuid(body.sourceUomId, "sourceUomId");
    const { error } = await createSupabaseAdminClient().from("scheme_version_unit_conversions").delete().eq("scheme_version_id", version.id).eq("source_uom_id", sourceUomId);
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "scheme_version_uom_conversion_removed", entityType: "scheme_version", entityId: version.id, previousValue: { sourceUomId } });
    return jsonWithCors(request, { success: true });
  } catch (error) {
    return rulebookErrorResponse(request, error, "remove TOD UOM conversion");
  }
}
