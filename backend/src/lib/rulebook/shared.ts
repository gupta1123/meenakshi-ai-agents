import { jsonWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { TALLY_SYNC_STALE_MS } from "@/lib/constants";
import { isUuid, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type CompanyScope = Awaited<ReturnType<typeof requireMeenakshiCompanyAccess>>;

export type RulebookVersionRow = {
  id: string;
  company_id: string;
  scheme_id: string;
  scheme_type: "cd" | "tod";
  version_number: number;
  status: "draft" | "validated" | "active" | "retired";
  effective_from: string;
  effective_to: string | null;
  discount_percentage: string | null;
  calculation_base: "eligible_product_taxable_value";
  rounding_method: "half_up" | "half_even" | "truncate";
  rounding_scale: number;
  gst_treatment: "commercial_no_gst";
  credit_note_voucher_type_id: string | null;
  discount_ledger_id: string | null;
  requires_approval: boolean;
  working_calendar_id: string | null;
  allowed_working_days: number | null;
  near_eligibility_percent: string | null;
  cd_invoice_treatment: "after_qualification" | "deducted_upfront" | null;
  cd_narration_mode: "informational" | "required" | "disabled" | null;
  cd_check_narration?: boolean | null;
  period_months: number | null;
  period_anchor_date: string | null;
  tod_review_calendar_id: string | null;
  created_at: string;
  updated_at: string;
};

export type RulebookSchemeRow = {
  id: string;
  company_id: string;
  scheme_type: "cd" | "tod";
  code: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "paused" | "expired" | "retired";
  created_at: string;
  updated_at: string;
};

export class RulebookRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function rulebookErrorResponse(request: Request, error: unknown, operation: string) {
  if (error instanceof MeenakshiAccessError || error instanceof RulebookRequestError) {
    return jsonWithCors(request, { error: error.message }, { status: error.status });
  }
  console.error(`Could not ${operation}:`, error);
  return jsonWithCors(request, { error: `Could not ${operation}.` }, { status: 500 });
}

export function readRequiredUuid(value: unknown, field: string) {
  if (!isUuid(value)) throw new RulebookRequestError(`${field} must be a UUID.`);
  return value;
}

export function readRequiredText(value: unknown, field: string, maxLength: number) {
  const text = readText(value, maxLength);
  if (!text) throw new RulebookRequestError(`${field} is required.`);
  return text;
}

export function readOptionalText(value: unknown, maxLength: number) {
  return value === undefined || value === null ? null : readText(value, maxLength);
}

export function readDate(value: unknown, field: string, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new RulebookRequestError(`${field} is required.`);
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RulebookRequestError(`${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RulebookRequestError(`${field} must be a real date.`);
  }
  return value;
}

export function readTimestamp(value: unknown, field: string, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new RulebookRequestError(`${field} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new RulebookRequestError(`${field} must be an ISO timestamp.`);
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new RulebookRequestError(`${field} must be an ISO timestamp.`);
  return timestamp.toISOString();
}

// Amounts and quantities arrive as decimal strings so JavaScript floating point
// never decides a financial value. PostgreSQL numeric performs the final check.
export function readPositiveDecimal(value: unknown, field: string, options?: { allowZero?: boolean; maxScale?: number }) {
  if (typeof value !== "string" || !/^((0|[1-9]\d*)(\.\d+)?|\.\d+)$/.test(value)) {
    throw new RulebookRequestError(`${field} must be a decimal string.`);
  }
  let normalized: string = value;
  if (normalized.startsWith(".")) normalized = `0${normalized}`;
  const [, fraction = ""] = normalized.split(".");
  if (options?.maxScale !== undefined && fraction.length > options.maxScale) {
    throw new RulebookRequestError(`${field} can have at most ${options.maxScale} decimal places.`);
  }
  if (!options?.allowZero && /^0(?:\.0+)?$/.test(normalized)) {
    throw new RulebookRequestError(`${field} must be greater than zero.`);
  }
  return normalized;
}

export function readBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") throw new RulebookRequestError(`${field} must be true or false.`);
  return value;
}

export function readInteger(value: unknown, field: string, min: number, max: number) {
  const coerced = typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
  if (!Number.isInteger(coerced as number) || typeof coerced !== "number" || (coerced as number) < min || (coerced as number) > max) {
    throw new RulebookRequestError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return coerced as number;
}

function addUtcMonths(date: string, months: number) {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

function previousUtcDay(date: string) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function validateTodPeriod({ effectiveFrom, effectiveTo, periodAnchorDate, periodMonths }: {
  effectiveFrom: string;
  effectiveTo: string | null;
  periodAnchorDate: string;
  periodMonths: number;
}) {
  if (effectiveFrom !== periodAnchorDate) {
    throw new RulebookRequestError("The Turnover Discount rule must start on the first day of its calculation period.");
  }
  const firstPeriodEnd = previousUtcDay(addUtcMonths(periodAnchorDate, periodMonths));
  if (effectiveTo && effectiveTo < firstPeriodEnd) {
    throw new RulebookRequestError(`The rule must remain active through ${firstPeriodEnd} to complete its first calculation period.`);
  }
}

export function readCashDiscountSlabs(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) throw new RulebookRequestError("Add between 1 and 12 Cash Discount slabs.");
  const slabs = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RulebookRequestError(`Cash Discount slab ${index + 1} is invalid.`);
    const row = item as Record<string, unknown>;
    return {
      allowed_working_days: readInteger(row.allowedWorkingDays, `slabs[${index}].allowedWorkingDays`, 0, 366),
      discount_percentage: readPositiveDecimal(row.percentage, `slabs[${index}].percentage`, { maxScale: 4 }),
    };
  }).sort((left, right) => left.allowed_working_days - right.allowed_working_days);
  if (new Set(slabs.map((slab) => slab.allowed_working_days)).size !== slabs.length) throw new RulebookRequestError("Each Cash Discount slab must use a different working-day limit.");
  for (let index = 1; index < slabs.length; index += 1) {
    if (Number(slabs[index].discount_percentage) > Number(slabs[index - 1].discount_percentage)) throw new RulebookRequestError("Later payment slabs cannot give a higher discount than earlier slabs.");
  }
  return slabs;
}

export async function requireRulebookCompanyAdmin(request: Request, companyId: string): Promise<CompanyScope> {
  if (!isUuid(companyId)) throw new RulebookRequestError("Invalid company id.");
  return requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
}

export async function requireGlobalWorkingCalendar(organizationId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("working_calendars")
    .select("id, organization_id, name, is_active, revision")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new RulebookRequestError("Set up the Meenakshi business calendar before creating a rule version.", 409);
  return data as { id: string; organization_id: string; name: string; is_active: boolean; revision: number };
}

export async function findScheme(schemeId: string) {
  if (!isUuid(schemeId)) throw new RulebookRequestError("Invalid scheme id.");
  const { data, error } = await createSupabaseAdminClient()
    .from("schemes")
    .select("id, company_id, scheme_type, code, name, description, status, created_at, updated_at")
    .eq("id", schemeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new RulebookRequestError("Scheme was not found.", 404);
  return data as unknown as RulebookSchemeRow;
}

export async function requireRulebookSchemeAdmin(request: Request, schemeId: string) {
  const scheme = await findScheme(schemeId);
  const scope = await requireRulebookCompanyAdmin(request, scheme.company_id);
  return { scope, scheme };
}

export async function requireRulebookSchemeForCompany(request: Request, companyId: string, schemeId: string) {
  const scope = await requireRulebookCompanyAdmin(request, companyId);
  const scheme = await findScheme(schemeId);
  if (scheme.company_id !== scope.company.id) throw new RulebookRequestError("Scheme was not found for this company.", 404);
  return { scope, scheme };
}

export async function findRulebookVersion(versionId: string) {
  if (!isUuid(versionId)) throw new RulebookRequestError("Invalid scheme version id.");
  const { data, error } = await createSupabaseAdminClient()
    .from("scheme_versions")
    .select("id, company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to, discount_percentage, calculation_base, rounding_method, rounding_scale, gst_treatment, credit_note_voucher_type_id, discount_ledger_id, requires_approval, working_calendar_id, allowed_working_days, near_eligibility_percent, cd_invoice_treatment, cd_narration_mode, cd_check_narration, period_months, period_anchor_date, tod_review_calendar_id, created_at, updated_at")
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new RulebookRequestError("Scheme version was not found.", 404);
  return data as unknown as RulebookVersionRow;
}

export async function requireRulebookVersionAdmin(request: Request, versionId: string) {
  const version = await findRulebookVersion(versionId);
  const scope = await requireRulebookCompanyAdmin(request, version.company_id);
  return { scope, version };
}

export async function requireRulebookVersionForCompany(request: Request, companyId: string, versionId: string) {
  const scope = await requireRulebookCompanyAdmin(request, companyId);
  const version = await findRulebookVersion(versionId);
  if (version.company_id !== scope.company.id) throw new RulebookRequestError("Scheme version was not found for this company.", 404);
  return { scope, version };
}

export function requireDraftVersion(version: RulebookVersionRow) {
  if (version.status !== "draft") {
    throw new RulebookRequestError("Only draft rule versions can be changed. Create a new version to change an active or validated rule.", 409);
  }
}

export async function getMasterSyncReadiness(companyId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("tally_sync_runs")
    .select("id, status, completed_at, error_summary, source_fingerprint")
    .eq("company_id", companyId)
    .eq("sync_kind", "masters")
    .order("completed_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const row = data as { id: string; status: string; completed_at: string | null; error_summary: string | null; source_fingerprint: string | null } | null;
  const completedAt = row?.completed_at ?? null;
  const stale = !completedAt || Date.now() - new Date(completedAt).getTime() > TALLY_SYNC_STALE_MS;
  return {
    id: row?.id ?? null,
    status: row?.status === "completed" && !stale ? "current" : row?.status === "completed" ? "stale" : row?.status ?? "required",
    completedAt,
    stale,
    errorSummary: row?.error_summary ?? null,
    fingerprint: row?.source_fingerprint ?? null,
  };
}

export async function requireCurrentMasterSync(companyId: string) {
  const readiness = await getMasterSyncReadiness(companyId);
  if (readiness.status !== "current") {
    throw new RulebookRequestError("A current successful Tally master synchronization is required for this action.", 409);
  }
  return readiness;
}

const ALLOWED_REFERENCE_TABLES = new Set(["tally_voucher_types", "tally_ledgers", "tally_units", "stock_items", "stock_groups", "customer_groups"]);

export async function requireAvailableReference(input: { table: string; id: string; companyId: string; label: string }) {
  const { table, id, companyId, label } = input;
  if (!ALLOWED_REFERENCE_TABLES.has(table)) throw new RulebookRequestError(`Unknown reference table: ${table}.`, 400);
  if (!isUuid(id)) throw new RulebookRequestError(`${label} must be a UUID.`);
  const select = table === "tally_voucher_types" ? "id, company_id, is_available, is_credit_note_type" : table === "tally_ledgers" ? "id, company_id, is_available, gst_applicability" : "id, company_id, is_available";
  const { data, error } = await createSupabaseAdminClient()
    .from(table)
    .select(select)
    .eq("id", id)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { id: string; company_id: string; is_available?: boolean; is_credit_note_type?: boolean; gst_applicability?: string | null } | null;
  if (!row || row.is_available === false) throw new RulebookRequestError(`${label} is unavailable for this company.`, 409);
  if (table === "tally_voucher_types" && row.is_credit_note_type !== true) throw new RulebookRequestError(`${label} must be a Credit Note voucher type.`, 400);
  if (table === "tally_ledgers" && String(row.gst_applicability ?? "").toLowerCase() !== "not applicable") throw new RulebookRequestError(`${label} must have GST set to Not Applicable.`, 400);
  return row;
}

export async function appendRulebookAudit(input: {
  scope: CompanyScope;
  action: string;
  entityType: string;
  entityId?: string | null;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}) {
  await appendMeenakshiAuditEvent({
    organizationId: input.scope.organization.id,
    companyId: input.scope.company.id,
    actorType: "user",
    actorId: input.scope.userId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    previousValue: input.previousValue ?? null,
    newValue: input.newValue ?? null,
    metadata: input.metadata ?? {},
  });
}

export function toSchemeResponse(scheme: RulebookSchemeRow) {
  return {
    id: scheme.id,
    companyId: scheme.company_id,
    schemeType: scheme.scheme_type,
    code: scheme.code,
    name: scheme.name,
    description: scheme.description,
    status: scheme.status,
    createdAt: scheme.created_at,
    updatedAt: scheme.updated_at,
  };
}

export function toVersionResponse(version: RulebookVersionRow) {
  return {
    id: version.id,
    companyId: version.company_id,
    schemeId: version.scheme_id,
    schemeType: version.scheme_type,
    versionNumber: version.version_number,
    status: version.status,
    effectiveFrom: version.effective_from,
    effectiveTo: version.effective_to,
    discountPercentage: version.discount_percentage,
    calculationBase: version.calculation_base,
    roundingMethod: version.rounding_method,
    roundingScale: version.rounding_scale,
    gstTreatment: version.gst_treatment,
    creditNoteVoucherTypeId: version.credit_note_voucher_type_id,
    discountLedgerId: version.discount_ledger_id,
    requiresApproval: version.requires_approval,
    workingCalendarId: version.working_calendar_id,
    allowedWorkingDays: version.allowed_working_days,
    nearEligibilityPercent: version.near_eligibility_percent,
    invoiceTreatment: version.cd_invoice_treatment,
    narrationMode: version.cd_narration_mode,
    checkNarration: version.cd_check_narration !== false,
    periodMonths: version.period_months,
    periodAnchorDate: version.period_anchor_date,
    todReviewCalendarId: version.tod_review_calendar_id,
    createdAt: version.created_at,
    updatedAt: version.updated_at,
  };
}
