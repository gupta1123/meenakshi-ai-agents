import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import {
  readBoolean,
  readCashDiscountSlabs,
  readDate,
  readInteger,
  readTodBenefitBasis,
  readOptionalText,
  readRequiredText,
  readRequiredUuid,
  requireAvailableReference,
  requireCurrentMasterSync,
  requireGlobalWorkingCalendar,
  requireRulebookCompanyAdmin,
  RulebookRequestError,
  rulebookErrorResponse,
  toSchemeResponse,
  toVersionResponse,
  validateTodPeriod,
} from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readIdempotencyKey } from "@/lib/tally/contracts";
import { appendMeenakshiAuditEvent } from "@/lib/audit";

type RouteContext = { params: Promise<{ companyId: string }> };
type InitialRule = Record<string, unknown>;

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const { data, error } = await createSupabaseAdminClient()
      .from("schemes")
      .select("id, company_id, scheme_type, code, name, description, status, created_at, updated_at, scheme_versions(id)")
      .eq("company_id", scope.company.id)
      .order("scheme_type")
      .order("name");
    if (error) throw error;
    return jsonWithCors(request, { schemes: ((data ?? []) as Parameters<typeof toSchemeResponse>[0][]).map(toSchemeResponse) });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load schemes");
  }
}

function parseInitialRule(schemeType: "cd" | "tod", input: InitialRule) {
  const effectiveFrom = readDate(input.effectiveFrom, "initialRule.effectiveFrom") as string;
  const effectiveTo = readDate(input.effectiveTo, "initialRule.effectiveTo", false);
  if (effectiveTo && effectiveTo < effectiveFrom) throw new RulebookRequestError("The rule end date cannot be before its start date.");

  if (schemeType === "cd") {
    const slabs = readCashDiscountSlabs(input.slabs);
    return {
      effectiveFrom,
      effectiveTo,
      slabs,
      checkNarration: input.checkNarration === undefined ? true : readBoolean(input.checkNarration, "initialRule.checkNarration"),
      periodMonths: null,
      periodAnchorDate: null,
      todBenefitBasis: null,
    };
  }

  const periodMonths = readInteger(input.periodMonths, "initialRule.periodMonths", 1, 36);
  const periodAnchorDate = readDate(input.periodAnchorDate, "initialRule.periodAnchorDate") as string;
  validateTodPeriod({ effectiveFrom, effectiveTo, periodAnchorDate, periodMonths });
  return { effectiveFrom, effectiveTo, slabs: [], checkNarration: true, periodMonths, periodAnchorDate, todBenefitBasis: readTodBenefitBasis(input.todBenefitBasis, "initialRule.todBenefitBasis") };
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey || !/^[A-Za-z0-9\-_]{8,120}$/.test(idempotencyKey)) return jsonWithCors(request, { error: "A valid Idempotency-Key (8-120 chars, A-Z 0-9 - _) is required." }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const schemeType = body.schemeType;
    if (schemeType !== "cd" && schemeType !== "tod") return jsonWithCors(request, { error: "Choose Cash Discount or Turnover Discount." }, { status: 400 });
    if (!body.initialRule || typeof body.initialRule !== "object" || Array.isArray(body.initialRule)) {
      return jsonWithCors(request, { error: "Complete the rule terms before saving." }, { status: 400 });
    }

    const name = readRequiredText(body.name, "name", 160);
    const code = readRequiredText(body.code, "code", 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(code)) return jsonWithCors(request, { error: "Reference code must start with a letter and contain only A-Z 0-9 _ -." }, { status: 400 });
    const description = readOptionalText(body.description, 1_000);
    const initialRule = body.initialRule as InitialRule;
    const initial = parseInitialRule(schemeType, initialRule);
    const calendar = await requireGlobalWorkingCalendar(scope.organization.id);
    await requireCurrentMasterSync(scope.company.id);
    const creditNoteVoucherTypeId = schemeType === "tod" ? readRequiredUuid(initialRule.creditNoteVoucherTypeId, "initialRule.creditNoteVoucherTypeId") : null;
    const discountLedgerId = schemeType === "tod" ? readRequiredUuid(initialRule.discountLedgerId, "initialRule.discountLedgerId") : null;
    if (schemeType === "tod") {
      await requireAvailableReference({ table: "tally_voucher_types", id: creditNoteVoucherTypeId!, companyId: scope.company.id, label: "Credit Note voucher type" });
      await requireAvailableReference({ table: "tally_ledgers", id: discountLedgerId!, companyId: scope.company.id, label: "Discount ledger" });
    }
    const supabase = createSupabaseAdminClient();
    const { data: schemeData, error: schemeError } = await supabase.from("schemes").insert({
      company_id: scope.company.id,
      scheme_type: schemeType,
      code,
      name,
      description,
      status: "draft",
      created_by: scope.userId,
    }).select("id, company_id, scheme_type, code, name, description, status, created_at, updated_at").single();
    if (schemeError) {
      if (schemeError.code === "23505") {
        const msg = String(schemeError.message ?? "");
        return jsonWithCors(request, { error: msg.includes("code") ? "A rule with this reference code already exists." : "A rule with this name already exists." }, { status: 409 });
      }
      throw schemeError;
    }
    const compatibility = schemeType === "cd" ? initial.slabs.at(-1)! : null;
    const { data: versionData, error: versionError } = await supabase.from("scheme_versions").insert({
      company_id: scope.company.id,
      scheme_id: schemeData.id,
      scheme_type: schemeType,
      version_number: 1,
      status: "draft",
      effective_from: initial.effectiveFrom,
      effective_to: initial.effectiveTo,
      discount_percentage: compatibility?.discount_percentage ?? null,
      calculation_base: "eligible_product_taxable_value",
      rounding_method: "half_up",
      rounding_scale: 2,
      gst_treatment: "commercial_no_gst",
      credit_note_voucher_type_id: creditNoteVoucherTypeId,
      discount_ledger_id: discountLedgerId,
      requires_approval: true,
      working_calendar_id: schemeType === "cd" ? calendar.id : null,
      allowed_working_days: compatibility?.allowed_working_days ?? null,
      near_eligibility_percent: schemeType === "cd" ? 80 : null,
      cd_invoice_treatment: schemeType === "cd" ? "deducted_upfront" : null,
      cd_narration_mode: schemeType === "cd" ? "informational" : null,
      cd_check_narration: schemeType === "cd" ? initial.checkNarration : true,
      period_months: schemeType === "tod" ? initial.periodMonths : null,
      period_anchor_date: schemeType === "tod" ? initial.periodAnchorDate : null,
      tod_review_calendar_id: schemeType === "tod" ? calendar.id : null,
      tod_benefit_basis: schemeType === "tod" ? initial.todBenefitBasis : null,
      created_by: scope.userId,
    }).select("id, company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to, discount_percentage, calculation_base, rounding_method, rounding_scale, gst_treatment, credit_note_voucher_type_id, discount_ledger_id, requires_approval, working_calendar_id, allowed_working_days, near_eligibility_percent, cd_invoice_treatment, cd_narration_mode, cd_check_narration, period_months, period_anchor_date, tod_review_calendar_id, tod_benefit_basis, created_at, updated_at").single();
    if (versionError) throw versionError;
    if (schemeType === "cd") {
      const { error: slabError } = await supabase.from("scheme_version_cd_slabs").insert(initial.slabs.map((slab) => ({ scheme_version_id: versionData.id, allowed_working_days: slab.allowed_working_days, discount_percentage: slab.discount_percentage })));
      if (slabError) throw slabError;
    }
    await appendMeenakshiAuditEvent({ organizationId: scope.organization.id, companyId: scope.company.id, actorType: "user", actorId: scope.userId, action: "meenakshi_rule_created", entityType: "scheme", entityId: schemeData.id, newValue: { code, name, schemeType, versionId: versionData.id }, metadata: { idempotencyKey } });

    return jsonWithCors(request, {
      scheme: toSchemeResponse(schemeData as Parameters<typeof toSchemeResponse>[0]),
      version: toVersionResponse(versionData as Parameters<typeof toVersionResponse>[0]),
      replayed: false,
    }, { status: 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "create rule");
  }
}
