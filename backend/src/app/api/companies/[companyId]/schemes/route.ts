import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import {
  readBoolean,
  readCashDiscountSlabs,
  readDate,
  readInteger,
  readOptionalText,
  readRequiredText,
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
    };
  }

  const periodMonths = readInteger(input.periodMonths, "initialRule.periodMonths", 1, 36);
  const periodAnchorDate = readDate(input.periodAnchorDate, "initialRule.periodAnchorDate") as string;
  validateTodPeriod({ effectiveFrom, effectiveTo, periodAnchorDate, periodMonths });
  return { effectiveFrom, effectiveTo, slabs: [], checkNarration: true, periodMonths, periodAnchorDate };
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
    const initial = parseInitialRule(schemeType, body.initialRule as InitialRule);
    const calendar = await requireGlobalWorkingCalendar(scope.organization.id);
    const requestPayload = {
      schemeType,
      code,
      name,
      description,
      effectiveFrom: initial.effectiveFrom,
      effectiveTo: initial.effectiveTo,
      slabs: initial.slabs,
      checkNarration: initial.checkNarration,
      periodMonths: initial.periodMonths,
      periodAnchorDate: initial.periodAnchorDate,
    };

    const supabase = createSupabaseAdminClient();
    const { data: created, error: createError } = await supabase.rpc("create_meenakshi_rule", {
      p_company_id: scope.company.id,
      p_actor_id: scope.userId,
      p_idempotency_key: idempotencyKey,
      p_request: requestPayload,
      p_working_calendar_id: calendar.id,
    });
    if (createError) {
      if (createError.code === "23505") {
        const msg = String(createError.message ?? "");
        const isCode = msg.includes("code") || msg.includes("schemes_company_id_code_key");
        return jsonWithCors(request, { error: isCode ? "A rule with this reference code already exists." : "A rule with this name already exists." }, { status: 409 });
      }
      throw createError;
    }

    const result = created as { schemeId?: string; versionId?: string; replayed?: boolean } | null;
    if (!result?.schemeId || !result.versionId) throw new Error("Rule creation did not return its saved records.");
    const [schemeResult, versionResult] = await Promise.all([
      supabase.from("schemes").select("id, company_id, scheme_type, code, name, description, status, created_at, updated_at").eq("id", result.schemeId).single(),
      supabase.from("scheme_versions").select("id, company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to, discount_percentage, calculation_base, rounding_method, rounding_scale, gst_treatment, credit_note_voucher_type_id, discount_ledger_id, requires_approval, working_calendar_id, allowed_working_days, near_eligibility_percent, cd_invoice_treatment, cd_narration_mode, cd_check_narration, period_months, period_anchor_date, tod_review_calendar_id, created_at, updated_at").eq("id", result.versionId).single(),
    ]);
    if (schemeResult.error) throw schemeResult.error;
    if (versionResult.error) throw versionResult.error;

    return jsonWithCors(request, {
      scheme: toSchemeResponse(schemeResult.data as Parameters<typeof toSchemeResponse>[0]),
      version: toVersionResponse(versionResult.data as Parameters<typeof toVersionResponse>[0]),
      replayed: result.replayed === true,
    }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "create rule");
  }
}
