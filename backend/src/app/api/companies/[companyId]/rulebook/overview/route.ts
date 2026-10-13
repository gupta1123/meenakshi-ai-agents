import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRulebookCompanyAdmin, rulebookErrorResponse, toSchemeResponse, toVersionResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };

const versionColumns = "id, company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to, discount_percentage, calculation_base, rounding_method, rounding_scale, gst_treatment, credit_note_voucher_type_id, discount_ledger_id, requires_approval, working_calendar_id, allowed_working_days, near_eligibility_percent, cd_invoice_treatment, cd_narration_mode, cd_check_narration, period_months, period_anchor_date, tod_review_calendar_id, tod_benefit_basis, cd_discount_basis, created_at, updated_at";

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const supabase = createSupabaseAdminClient();
    const [schemeResult, versionResult] = await Promise.all([
      supabase.from("schemes")
        .select("id, company_id, scheme_type, code, name, description, status, created_at, updated_at, scheme_versions(status, effective_from, effective_to)")
        .eq("company_id", scope.company.id).order("scheme_type").order("name"),
      supabase.from("scheme_versions").select(versionColumns)
        .eq("company_id", scope.company.id).order("version_number", { ascending: false }),
    ]);
    if (schemeResult.error) throw schemeResult.error;
    if (versionResult.error) throw versionResult.error;

    const schemeRows = schemeResult.data ?? [];
    const versionRows = versionResult.data ?? [];
    const schemes = schemeRows.map((row) => toSchemeResponse(row as Parameters<typeof toSchemeResponse>[0]));
    const url = new URL(request.url);
    const requestedSchemeId = url.searchParams.get("schemeId");
    const requestedVersionId = url.searchParams.get("versionId");
    const requestedVersion = requestedVersionId ? versionRows.find((row) => row.id === requestedVersionId) : null;
    const selectedScheme = (requestedSchemeId ? schemes.find((item) => item.id === requestedSchemeId) : null)
      ?? (requestedVersion ? schemes.find((item) => item.id === requestedVersion.scheme_id) : null)
      ?? schemes.find((item) => item.status === "active")
      ?? schemes[0]
      ?? null;
    if (!selectedScheme) return jsonWithCors(request, { schemes, selected: null, versionDetail: null });

    const selectedVersionRows = versionRows.filter((row) => row.scheme_id === selectedScheme.id);
    const versions = selectedVersionRows.map((row) => toVersionResponse(row as Parameters<typeof toVersionResponse>[0]));
    const version = (requestedVersionId ? selectedVersionRows.find((item) => item.id === requestedVersionId) : null)
      ?? selectedVersionRows.find((item) => item.status === "draft")
      ?? selectedVersionRows.find((item) => item.status === "active")
      ?? selectedVersionRows[0]
      ?? null;
    const selected = { scheme: selectedScheme, versions };
    if (!version) return jsonWithCors(request, { schemes, selected, versionDetail: null });

    const [groups, coverage, stockItems, stockGroups, stockCoverage, conversions, tiers, cdSlabs, cdSegments, cdSegmentGroups] = await Promise.all([
      supabase.from("scheme_version_customer_groups").select("customer_group_id, include_descendants, created_at").eq("scheme_version_id", version.id),
      supabase.from("scheme_version_group_coverage").select("customer_group_id, created_at").eq("scheme_version_id", version.id),
      supabase.from("scheme_version_stock_items").select("stock_item_id").eq("scheme_version_id", version.id),
      supabase.from("scheme_version_stock_groups").select("stock_group_id").eq("scheme_version_id", version.id),
      supabase.from("scheme_version_stock_group_coverage").select("stock_group_id, created_at").eq("scheme_version_id", version.id),
      supabase.from("scheme_version_unit_conversions").select("source_uom_id, tonnes_per_source_unit, is_builtin, approved_by, approved_at, created_at").eq("scheme_version_id", version.id).order("created_at"),
      supabase.from("scheme_version_tiers").select("id, minimum_tonnes, discount_percentage, discount_amount_per_tonne, created_at").eq("scheme_version_id", version.id).order("minimum_tonnes"),
      supabase.from("scheme_version_cd_slabs").select("id, allowed_working_days, discount_percentage").eq("scheme_version_id", version.id).order("allowed_working_days"),
      supabase.from("scheme_version_cd_segments").select("id, label, allowed_working_days, amount_per_tonne, sort_order").eq("scheme_version_id", version.id).order("sort_order"),
      supabase.from("scheme_version_cd_segment_groups").select("segment_id, customer_group_id").eq("scheme_version_id", version.id),
    ]);
    const errors = [groups.error, coverage.error, stockItems.error, stockGroups.error, stockCoverage.error, conversions.error, tiers.error, cdSlabs.error, cdSegments.error, cdSegmentGroups.error].filter(Boolean);
    if (errors.length) throw errors[0];
    return jsonWithCors(request, {
      schemes,
      selected,
      versionDetail: {
        version: toVersionResponse(version as Parameters<typeof toVersionResponse>[0]),
        configuration: {
          customerGroups: groups.data ?? [],
          customerGroupCoverage: coverage.data ?? [],
          stockItems: stockItems.data ?? [],
          stockGroups: stockGroups.data ?? [],
          stockGroupCoverage: stockCoverage.data ?? [],
          conversions: conversions.data ?? [],
          tiers: tiers.data ?? [],
          cdSlabs: (cdSlabs.data ?? []).map((slab) => ({ id: slab.id, allowedWorkingDays: slab.allowed_working_days, percentage: String(slab.discount_percentage) })),
          cdSegments: (cdSegments.data ?? []).map((segment) => ({
            id: segment.id,
            label: segment.label,
            allowedWorkingDays: segment.allowed_working_days,
            amountPerTonne: String(segment.amount_per_tonne),
            customerGroupIds: (cdSegmentGroups.data ?? []).filter((member) => member.segment_id === segment.id).map((member) => member.customer_group_id),
          })),
        },
        companyId: scope.company.id,
      },
    });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load Rulebook overview");
  }
}
