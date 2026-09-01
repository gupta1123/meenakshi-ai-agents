import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readPositiveDecimal, readRequiredUuid, requireDraftVersion, requireRulebookVersionForCompany, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; versionId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

function requireTod(versionType: string) {
  if (versionType !== "tod") throw new RulebookRequestError("Quantity tiers are available only for TOD rule versions.", 409);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireTod(version.scheme_type);
    const { data, error } = await createSupabaseAdminClient().from("scheme_version_tiers").select("id, minimum_tonnes, discount_percentage, created_at").eq("scheme_version_id", version.id).order("minimum_tonnes");
    if (error) throw error;
    return jsonWithCors(request, { tiers: data ?? [] });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load TOD tiers");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireTod(version.scheme_type);
    requireDraftVersion(version);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const minimumTonnes = readPositiveDecimal(body.minimumTonnes, "minimumTonnes", { allowZero: true, maxScale: 6 });
    const discountPercentage = readPositiveDecimal(body.discountPercentage, "discountPercentage", { maxScale: 4 });
    const { data, error } = await createSupabaseAdminClient().from("scheme_version_tiers")
      .upsert({ scheme_version_id: version.id, minimum_tonnes: minimumTonnes, discount_percentage: discountPercentage }, { onConflict: "scheme_version_id,minimum_tonnes" })
      .select("id, minimum_tonnes, discount_percentage, created_at")
      .single();
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "scheme_version_tier_saved", entityType: "scheme_version", entityId: version.id, newValue: { minimumTonnes, discountPercentage } });
    return jsonWithCors(request, { tier: data });
  } catch (error) {
    return rulebookErrorResponse(request, error, "save TOD tier");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireTod(version.scheme_type);
    requireDraftVersion(version);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const tierId = readRequiredUuid(body.tierId, "tierId");
    const { error } = await createSupabaseAdminClient().from("scheme_version_tiers").delete().eq("id", tierId).eq("scheme_version_id", version.id);
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "scheme_version_tier_removed", entityType: "scheme_version", entityId: version.id, previousValue: { tierId } });
  } catch (error) {
    return rulebookErrorResponse(request, error, "remove TOD tier");
  }
}
