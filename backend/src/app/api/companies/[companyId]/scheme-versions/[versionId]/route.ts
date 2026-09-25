import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { readBoolean, readCashDiscountSlabs, readDate, readInteger, readPositiveDecimal, readRequiredUuid, readTodBenefitBasis, requireAvailableReference, requireDraftVersion, requireGlobalWorkingCalendar, requireRulebookVersionForCompany, RulebookRequestError, rulebookErrorResponse, toVersionResponse, validateTodPeriod } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; versionId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

function parseRoundingMethod(value: unknown) {
  if (value === "half_up" || value === "half_even" || value === "truncate") return value;
  throw new RulebookRequestError("roundingMethod must be half_up, half_even, or truncate.");
}

function parseInvoiceTreatment(value: unknown) {
  if (value === "after_qualification" || value === "deducted_upfront") return value;
  throw new RulebookRequestError("Choose how this Cash Discount is given.");
}

function parseNarrationMode(value: unknown) {
  if (value === "informational" || value === "required" || value === "disabled") return value;
  throw new RulebookRequestError("Choose how invoice narration should be checked.");
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    const supabase = createSupabaseAdminClient();
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
      version: toVersionResponse(version),
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
    });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load scheme version");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { companyId, versionId } = await context.params;
    const { scope, version } = await requireRulebookVersionForCompany(request, companyId, versionId);
    requireDraftVersion(version);
    const calendar = await requireGlobalWorkingCalendar(scope.organization.id);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    if (body.effectiveFrom !== undefined) update.effective_from = readDate(body.effectiveFrom, "effectiveFrom");
    if (body.effectiveTo !== undefined) update.effective_to = readDate(body.effectiveTo, "effectiveTo", false);
    const effectiveFrom = (update.effective_from as string | undefined) ?? version.effective_from;
    const effectiveTo = (update.effective_to as string | null | undefined) ?? version.effective_to;
    if (effectiveTo && effectiveTo < effectiveFrom) return jsonWithCors(request, { error: "effectiveTo cannot be before effectiveFrom." }, { status: 400 });
    if (body.roundingMethod !== undefined) update.rounding_method = parseRoundingMethod(body.roundingMethod);
    if (body.roundingScale !== undefined) update.rounding_scale = readInteger(body.roundingScale, "roundingScale", 0, 4);
    if (body.requiresApproval !== undefined) update.requires_approval = readBoolean(body.requiresApproval, "requiresApproval");
    if (body.creditNoteVoucherTypeId !== undefined) {
      const id = readRequiredUuid(body.creditNoteVoucherTypeId, "creditNoteVoucherTypeId");
      await requireAvailableReference({ table: "tally_voucher_types", id, companyId: scope.company.id, label: "Credit Note voucher type" });
      update.credit_note_voucher_type_id = id;
    }
    if (body.discountLedgerId !== undefined) {
      const id = readRequiredUuid(body.discountLedgerId, "discountLedgerId");
      await requireAvailableReference({ table: "tally_ledgers", id, companyId: scope.company.id, label: "Discount ledger" });
      update.discount_ledger_id = id;
    }
    if (version.scheme_type === "cd") {
      if (body.discountPercentage !== undefined) update.discount_percentage = readPositiveDecimal(body.discountPercentage, "discountPercentage", { maxScale: 4 });
      update.working_calendar_id = calendar.id;
      if (body.allowedWorkingDays !== undefined) update.allowed_working_days = readInteger(body.allowedWorkingDays, "allowedWorkingDays", 0, 366);
      if (body.invoiceTreatment !== undefined) update.cd_invoice_treatment = parseInvoiceTreatment(body.invoiceTreatment);
      if (body.narrationMode !== undefined) update.cd_narration_mode = parseNarrationMode(body.narrationMode);
      if (body.checkNarration !== undefined) update.cd_check_narration = readBoolean(body.checkNarration, "checkNarration");
      if (body.nearEligibilityPercent !== undefined) update.near_eligibility_percent = readPositiveDecimal(body.nearEligibilityPercent, "nearEligibilityPercent", { maxScale: 2 });
    } else {
      const currentBenefitBasis = version.tod_benefit_basis ?? "percentage_of_eligible_value";
      const requestedBenefitBasis = body.todBenefitBasis === undefined ? currentBenefitBasis : readTodBenefitBasis(body.todBenefitBasis);
      if (requestedBenefitBasis !== currentBenefitBasis) {
        const { count, error } = await createSupabaseAdminClient().from("scheme_version_tiers").select("id", { count: "exact", head: true }).eq("scheme_version_id", version.id);
        if (error) throw error;
        if (count) throw new RulebookRequestError("Remove the existing TOD tiers before changing how its benefit is calculated.", 409);
        update.tod_benefit_basis = requestedBenefitBasis;
      }
      if (body.periodMonths !== undefined) update.period_months = readInteger(body.periodMonths, "periodMonths", 1, 36);
      if (body.periodAnchorDate !== undefined) update.period_anchor_date = readDate(body.periodAnchorDate, "periodAnchorDate");
      update.tod_review_calendar_id = calendar.id;
      validateTodPeriod({
        effectiveFrom,
        effectiveTo,
        periodAnchorDate: (update.period_anchor_date as string | undefined) ?? version.period_anchor_date ?? "",
        periodMonths: (update.period_months as number | undefined) ?? version.period_months ?? 0,
      });
    }
    const slabs = version.scheme_type === "cd" && body.slabs !== undefined ? readCashDiscountSlabs(body.slabs) : null;
    if (slabs) {
      const compatibility = slabs.at(-1)!;
      update.discount_percentage = compatibility.discount_percentage;
      update.allowed_working_days = compatibility.allowed_working_days;
    }
    if (!Object.keys(update).length && !slabs) return jsonWithCors(request, { error: "No editable fields were provided." }, { status: 400 });

    const supabase = createSupabaseAdminClient();
    const { data: saved, error: saveError } = await supabase.rpc("update_meenakshi_rule_draft", {
      p_version_id: version.id,
      p_company_id: scope.company.id,
      p_actor_id: scope.userId,
      p_update: update,
      p_slabs: slabs,
    });
    if (saveError) throw saveError;
    const savedResult = saved as { versionId?: string } | null;
    if (!savedResult?.versionId) throw new Error("The saved working copy was not returned.");
    const { data, error } = await supabase
      .from("scheme_versions")
      .select("id, company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to, discount_percentage, calculation_base, rounding_method, rounding_scale, gst_treatment, credit_note_voucher_type_id, discount_ledger_id, requires_approval, working_calendar_id, allowed_working_days, near_eligibility_percent, cd_invoice_treatment, cd_narration_mode, cd_check_narration, period_months, period_anchor_date, tod_review_calendar_id, tod_benefit_basis, cd_discount_basis, created_at, updated_at")
      .eq("id", savedResult.versionId)
      .single();
    if (error) throw error;
    return jsonWithCors(request, { version: toVersionResponse(data as Parameters<typeof toVersionResponse>[0]) });
  } catch (error) {
    return rulebookErrorResponse(request, error, "update draft scheme version");
  }
}
