import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import {
  readBoolean,
  readCashDiscountSlabs,
  readDate,
  readInteger,
  readRequiredUuid,
  requireGlobalWorkingCalendar,
  requireRulebookSchemeForCompany,
  RulebookRequestError,
  rulebookErrorResponse,
  toVersionResponse,
  validateTodPeriod,
  type RulebookVersionRow,
} from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readIdempotencyKey } from "@/lib/tally/contracts";

type RouteContext = { params: Promise<{ companyId: string; schemeId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

function roundingMethod(value: unknown) {
  if (value === "half_up" || value === "half_even" || value === "truncate") return value;
  throw new RulebookRequestError("Choose a supported rounding method.");
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, schemeId } = await context.params;
    const { scope, scheme } = await requireRulebookSchemeForCompany(request, companyId, schemeId);
    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey && !/^[A-Za-z0-9\-_]{8,120}$/.test(idempotencyKey)) return jsonWithCors(request, { error: "Idempotency-Key must be 8-120 chars (A-Z 0-9 - _)." }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const supabase = createSupabaseAdminClient();

    let source: RulebookVersionRow | null = null;
    if (body.copyFromVersionId !== undefined) {
      const sourceId = readRequiredUuid(body.copyFromVersionId, "copyFromVersionId");
      const { data, error } = await supabase
        .from("scheme_versions")
        .select("id, company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to, discount_percentage, calculation_base, rounding_method, rounding_scale, gst_treatment, credit_note_voucher_type_id, discount_ledger_id, requires_approval, working_calendar_id, allowed_working_days, near_eligibility_percent, cd_invoice_treatment, cd_narration_mode, cd_check_narration, period_months, period_anchor_date, tod_review_calendar_id, created_at, updated_at")
        .eq("id", sourceId)
        .eq("scheme_id", scheme.id)
        .eq("company_id", scope.company.id)
        .maybeSingle();
      if (error) throw error;
      if (!data || data.status !== "active") throw new RulebookRequestError("This rule changed after you opened it. Reload and edit the current rule.", 409);
      source = data as RulebookVersionRow;
    }

    const effectiveFrom = readDate(body.effectiveFrom, "effectiveFrom") as string;
    const effectiveTo = readDate(body.effectiveTo, "effectiveTo", false);
    if (effectiveTo && effectiveTo < effectiveFrom) throw new RulebookRequestError("The rule end date cannot be before its start date.");
    const calendar = await requireGlobalWorkingCalendar(scope.organization.id);
    const common = {
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      calculation_base: "eligible_product_taxable_value",
      rounding_method: roundingMethod(body.roundingMethod ?? source?.rounding_method ?? "half_up"),
      rounding_scale: readInteger(body.roundingScale ?? source?.rounding_scale ?? 2, "roundingScale", 0, 4),
      gst_treatment: "commercial_no_gst",
      requires_approval: scheme.scheme_type === "cd" ? false : body.requiresApproval === undefined ? source?.requires_approval ?? true : readBoolean(body.requiresApproval, "requiresApproval"),
    };

    let slabs: ReturnType<typeof readCashDiscountSlabs> = [];
    const typeTerms = scheme.scheme_type === "cd"
      ? (() => {
          slabs = readCashDiscountSlabs(body.slabs);
          const compatibility = slabs.at(-1)!;
          return {
            discount_percentage: compatibility.discount_percentage,
            working_calendar_id: calendar.id,
            allowed_working_days: compatibility.allowed_working_days,
            near_eligibility_percent: String(body.nearEligibilityPercent ?? source?.near_eligibility_percent ?? "80"),
            cd_check_narration: body.checkNarration === undefined ? source?.cd_check_narration !== false : readBoolean(body.checkNarration, "checkNarration"),
            period_months: null,
            period_anchor_date: null,
            tod_review_calendar_id: null,
          };
        })()
      : (() => {
          const periodMonths = readInteger(body.periodMonths ?? source?.period_months, "periodMonths", 1, 36);
          const periodAnchorDate = readDate(body.periodAnchorDate ?? source?.period_anchor_date, "periodAnchorDate") as string;
          validateTodPeriod({ effectiveFrom, effectiveTo, periodAnchorDate, periodMonths });
          return {
            discount_percentage: null,
            working_calendar_id: null,
            allowed_working_days: null,
            near_eligibility_percent: null,
            cd_check_narration: true,
            period_months: periodMonths,
            period_anchor_date: periodAnchorDate,
            tod_review_calendar_id: calendar.id,
          };
        })();

    const { data: draftResult, error: draftError } = await supabase.rpc("get_or_create_meenakshi_rule_draft", {
      p_company_id: scope.company.id,
      p_scheme_id: scheme.id,
      p_source_version_id: source?.id ?? null,
      p_actor_id: scope.userId,
      p_terms: { ...common, ...typeTerms },
      p_slabs: slabs,
    });
    if (draftError) {
      if (draftError.code === "23505" || String(draftError.message ?? "").includes("one_draft")) {
        return jsonWithCors(request, { error: "A draft already exists for this rule. Reload to continue." }, { status: 409 });
      }
      throw draftError;
    }
    const result = draftResult as { versionId?: string; replayed?: boolean } | null;
    if (!result?.versionId) throw new Error("The working copy was not returned.");

    const { data, error } = await supabase
      .from("scheme_versions")
      .select("id, company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to, discount_percentage, calculation_base, rounding_method, rounding_scale, gst_treatment, credit_note_voucher_type_id, discount_ledger_id, requires_approval, working_calendar_id, allowed_working_days, near_eligibility_percent, cd_invoice_treatment, cd_narration_mode, cd_check_narration, period_months, period_anchor_date, tod_review_calendar_id, created_at, updated_at")
      .eq("id", result.versionId)
      .single();
    if (error) throw error;
    return jsonWithCors(request, { version: toVersionResponse(data as Parameters<typeof toVersionResponse>[0]), resumed: result.replayed === true }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "open rule working copy");
  }
}
