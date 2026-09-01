import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readRequiredUuid, requireRulebookCompanyAdmin, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
type MappingInput = { voucherTypeId: string | null; ledgerId: string | null };
type SettingsRow = {
  company_id: string;
  gst_treatment: "commercial_no_gst";
  turnover_discount_voucher_type_id: string | null;
  turnover_discount_ledger_id: string | null;
  updated_at: string;
};

export function OPTIONS(request: Request) { return optionsWithCors(request); }

function response(row: SettingsRow | null) {
  return row ? {
    gstTreatment: row.gst_treatment,
    turnoverDiscount: { voucherTypeId: row.turnover_discount_voucher_type_id, ledgerId: row.turnover_discount_ledger_id },
    updatedAt: row.updated_at,
  } : null;
}

function mapping(value: unknown, label: string): MappingInput {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const voucherTypeId = raw.voucherTypeId === null || raw.voucherTypeId === "" || raw.voucherTypeId === undefined ? null : readRequiredUuid(raw.voucherTypeId, `${label}.voucherTypeId`);
  const ledgerId = raw.ledgerId === null || raw.ledgerId === "" || raw.ledgerId === undefined ? null : readRequiredUuid(raw.ledgerId, `${label}.ledgerId`);
  if (Boolean(voucherTypeId) !== Boolean(ledgerId)) throw new RulebookRequestError(`${label} requires both a Tally voucher type and a ledger.`);
  return { voucherTypeId, ledgerId };
}

async function validateMapping(companyId: string, value: MappingInput, label: string) {
  if (!value.voucherTypeId || !value.ledgerId) return;
  const supabase = createSupabaseAdminClient();
  const [{ data: voucherType, error: voucherError }, { data: ledger, error: ledgerError }] = await Promise.all([
    supabase.from("tally_voucher_types").select("id, name, is_available, is_credit_note_type").eq("id", value.voucherTypeId).eq("company_id", companyId).maybeSingle(),
    supabase.from("tally_ledgers").select("id, is_available, gst_applicability").eq("id", value.ledgerId).eq("company_id", companyId).maybeSingle(),
  ]);
  if (voucherError || ledgerError) throw voucherError ?? ledgerError;
  if (!voucherType || voucherType.is_available !== true || voucherType.is_credit_note_type !== true) {
    throw new RulebookRequestError(`${label} must use an available Credit Note type from this Tally company.`, 409);
  }
  if (!ledger || ledger.is_available !== true || String(ledger.gst_applicability ?? "").toLowerCase() !== "not applicable") {
    throw new RulebookRequestError(`${label} must use an available ledger that does not alter GST.`, 409);
  }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const { data, error } = await createSupabaseAdminClient()
      .from("company_credit_note_accounting_settings")
      .select("company_id, gst_treatment, turnover_discount_voucher_type_id, turnover_discount_ledger_id, updated_at")
      .eq("company_id", scope.company.id)
      .maybeSingle();
    if (error) throw error;
    return jsonWithCors(request, { settings: response(data as SettingsRow | null) });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load Credit Note setup");
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const turnoverDiscount = mapping(body.turnoverDiscount, "Turnover Discount");
    if (!turnoverDiscount.voucherTypeId) {
      throw new RulebookRequestError("Choose the Turnover Discount Credit Note type and ledger before saving.");
    }
    await validateMapping(scope.company.id, turnoverDiscount, "Turnover Discount");

    const supabase = createSupabaseAdminClient();
    const { data: previous, error: previousError } = await supabase
      .from("company_credit_note_accounting_settings")
      .select("company_id, gst_treatment, turnover_discount_voucher_type_id, turnover_discount_ledger_id, updated_at")
      .eq("company_id", scope.company.id)
      .maybeSingle();
    if (previousError) throw previousError;
    const { data, error } = await supabase
      .from("company_credit_note_accounting_settings")
      .upsert({
        company_id: scope.company.id,
        gst_treatment: "commercial_no_gst",
        turnover_discount_voucher_type_id: turnoverDiscount.voucherTypeId,
        turnover_discount_ledger_id: turnoverDiscount.ledgerId,
        updated_by: scope.userId,
      }, { onConflict: "company_id" })
      .select("company_id, gst_treatment, turnover_discount_voucher_type_id, turnover_discount_ledger_id, updated_at")
      .single();
    if (error) throw error;
    const saved = data as SettingsRow;
    await appendRulebookAudit({
      scope,
      action: "credit_note_accounting_settings_updated",
      entityType: "company_credit_note_accounting_settings",
      entityId: scope.company.id,
      previousValue: previous ? response(previous as SettingsRow) : null,
      newValue: response(saved),
    });
    return jsonWithCors(request, { settings: response(saved) });
  } catch (error) {
    return rulebookErrorResponse(request, error, "save Credit Note setup");
  }
}
