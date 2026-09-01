import { addCalendarMonths, previousCalendarDay, workingDayBreakdown } from "./calendar";
import type { PriorPeriodAdjustmentEvidence } from "./tod";
import type {
  BillAllocationEvidence,
  CustomerEvidence,
  CustomerGroupMembership,
  ExistingCreditNoteEvidence,
  FrozenCdRule,
  FrozenTodRule,
  InventoryLineEvidence,
  VoucherEvidence,
  WorkingCalendar,
} from "./contracts";
import { resolveRuleCoverage } from "./groups";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type SchemeType = "cd" | "tod";
type RuleRow = {
  id: string; company_id: string; scheme_id: string; scheme_type: SchemeType; version_number: number; status: string;
  effective_from: string; effective_to: string | null; discount_percentage: string | null; rounding_method: "half_up" | "half_even" | "truncate";
  rounding_scale: number; working_calendar_id: string | null; allowed_working_days: number | null; near_eligibility_percent: string | null;
  cd_check_narration: boolean | null;
  cd_narration_mode: "informational" | "required" | "disabled" | null;
  period_months: number | null; period_anchor_date: string | null; tod_review_calendar_id: string | null;
};

type RunContext = { schemeType?: unknown; salesVoucherId?: unknown; customerId?: unknown; batch?: unknown; asOfDate?: unknown; evaluatedOn?: unknown };

export type EvaluationRunRecord = {
  id: string;
  company_id: string;
  requested_by: string | null;
  request_context: RunContext;
  tally_master_refresh_run_id: string | null;
  tally_voucher_refresh_run_id: string | null;
  summary?: Record<string, unknown> | null;
};

export type RefreshScope = { masterScope: Record<string, unknown>; voucherScope: Record<string, unknown> };

export type LoadedCdEvaluation = {
  kind: "cd";
  rule: FrozenCdRule;
  customer: CustomerEvidence;
  salesVoucher: VoucherEvidence;
  inventoryLines: InventoryLineEvidence[];
  paymentAllocations: BillAllocationEvidence[];
  existingCreditNotes: ExistingCreditNoteEvidence[];
  evaluatedOn: string;
};

export type LoadedTodEvaluation = {
  kind: "tod";
  rule: FrozenTodRule;
  customer: CustomerEvidence;
  periodStart: string;
  periodEnd: string;
  lockedPeriod: boolean;
  vouchers: VoucherEvidence[];
  inventoryLines: InventoryLineEvidence[];
  existingCreditNotes: ExistingCreditNoteEvidence[];
  priorPeriodAdjustments: PriorPeriodAdjustmentEvidence[];
  evaluatedOn: string;
};

export type LoadedEvaluation = LoadedCdEvaluation | LoadedTodEvaluation;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dateText(value: unknown, fallback: string) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export function utcToday() { return new Date().toISOString().slice(0, 10); }

type AvailableCustomerRow = {
  id: string;
  tally_ledger_guid: string;
  ledger_name: string;
  is_available: boolean;
  current_customer_group_id: string | null;
};

// PostgREST returns at most 1,000 rows by default. Evaluation scopes must not
// depend on that implicit limit: an eligible customer can otherwise vanish from
// a calculation simply because their row falls on a later page.
async function loadAvailableCustomers(companyId: string, currentCustomerGroupIds?: string[]): Promise<AvailableCustomerRow[]> {
  const supabase = createSupabaseAdminClient();
  const pageSize = 1_000;
  const customers: AvailableCustomerRow[] = [];

  for (let page = 0; page < 10_000; page += 1) {
    let query = supabase
      .from("customers")
      .select("id, tally_ledger_guid, ledger_name, is_available, current_customer_group_id")
      .eq("company_id", companyId)
      .eq("is_available", true);
    if (currentCustomerGroupIds?.length) query = query.in("current_customer_group_id", currentCustomerGroupIds);
    const { data, error } = await query.order("id").range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as AvailableCustomerRow[];
    customers.push(...rows);
    if (rows.length < pageSize) return customers;
  }

  throw new Error("Too many available Tally customers to build an evaluation scope.");
}

async function loadAvailableCustomersByIds(companyId: string, customerIds: string[]): Promise<AvailableCustomerRow[]> {
  if (customerIds.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const chunkSize = 200;
  const chunks = Array.from({ length: Math.ceil(customerIds.length / chunkSize) }, (_, index) =>
    customerIds.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  const results = await Promise.all(chunks.map(async (ids) => {
    const { data, error } = await supabase
      .from("customers")
      .select("id, tally_ledger_guid, ledger_name, is_available, current_customer_group_id")
      .eq("company_id", companyId)
      .eq("is_available", true)
      .in("id", ids)
      .order("id");
    if (error) throw error;
    return (data ?? []) as AvailableCustomerRow[];
  }));
  return results.flat();
}

function voucher(row: Record<string, unknown>): VoucherEvidence {
  return {
    id: String(row.id),
    tallyGuid: String(row.tally_guid ?? ""),
    tallyMasterId: row.tally_master_id ? String(row.tally_master_id) : null,
    tallyAlterId: row.tally_alter_id ? String(row.tally_alter_id) : null,
    voucherNumber: row.voucher_number ? String(row.voucher_number) : null,
    voucherKind: row.voucher_kind as VoucherEvidence["voucherKind"],
    voucherDate: String(row.voucher_date),
    status: row.status as VoucherEvidence["status"],
    partyCustomerId: row.party_customer_id ? String(row.party_customer_id) : null,
    linkedSalesVoucherId: row.linked_sales_voucher_id ? String(row.linked_sales_voucher_id) : null,
    taxableProductValue: String(row.taxable_product_value ?? "0"),
    grossAmount: String(row.gross_amount ?? "0"),
    sourceSnapshot: toRecord(row.source_payload),
  };
}

function inventoryLine(row: Record<string, unknown>): InventoryLineEvidence {
  return {
    id: String(row.id), voucherId: String(row.voucher_id), lineNumber: Number(row.line_number),
    stockItemId: row.stock_item_id ? String(row.stock_item_id) : null,
    stockGroupId: row.stock_group_id ? String(row.stock_group_id) : null,
    sourceUomId: row.source_uom_id ? String(row.source_uom_id) : null,
    sourceUomCode: row.source_uom_code_snapshot ? String(row.source_uom_code_snapshot) : null,
    quantity: String(row.quantity ?? "0"), taxableProductValue: String(row.taxable_product_value ?? "0"),
    freightValue: String(row.freight_value ?? "0"), nonProductValue: String(row.non_product_value ?? "0"),
    lineCategory: row.line_category as InventoryLineEvidence["lineCategory"],
    quantityIsReliable: Boolean(row.quantity_is_reliable), sourceSnapshot: toRecord(row.source_payload),
  };
}

async function loadCalendar(calendarId: string): Promise<WorkingCalendar> {
  const supabase = createSupabaseAdminClient();
  const { data: calendar, error: calendarError } = await supabase
    .from("working_calendars")
    .select("id, revision, is_active")
    .eq("id", calendarId).maybeSingle();
  if (calendarError) throw calendarError;
  if (!calendar || !calendar.is_active) throw new Error("The configured working calendar is unavailable.");
  const [weekdays, holidays] = await Promise.all([
    supabase.from("working_calendar_non_working_weekdays").select("iso_weekday").eq("working_calendar_id", calendarId),
    supabase.from("working_calendar_holidays").select("holiday_date").eq("working_calendar_id", calendarId).eq("is_active", true),
  ]);
  if (weekdays.error) throw weekdays.error;
  if (holidays.error) throw holidays.error;
  return {
    id: calendar.id,
    revision: Number(calendar.revision),
    nonWorkingIsoWeekdays: (weekdays.data ?? []).map((row) => Number(row.iso_weekday)),
    activeHolidayDates: (holidays.data ?? []).map((row) => String(row.holiday_date)),
  };
}

async function loadCustomer(companyId: string, customerId: string): Promise<CustomerEvidence & { ledgerName: string }> {
  const supabase = createSupabaseAdminClient();
  const [{ data: customer, error: customerError }, { data: groups, error: groupError }] = await Promise.all([
    supabase.from("customers").select("id, tally_ledger_guid, ledger_name, is_available, current_customer_group_id").eq("id", customerId).eq("company_id", companyId).maybeSingle(),
    supabase.from("customer_groups").select("id, tally_group_guid, name, is_available, parent_group_id").eq("company_id", companyId),
  ]);
  if (customerError) throw customerError;
  if (groupError) throw groupError;
  if (!customer) throw new Error("The requested Tally customer is unavailable.");
  const byId = new Map((groups ?? []).map((group) => [group.id, group]));
  const path: CustomerGroupMembership[] = [];
  let groupId: string | null = customer.current_customer_group_id;
  for (let guard = 0; groupId && guard < 100; guard += 1) {
    const group = byId.get(groupId);
    if (!group) break;
    path.push({
      customerId: customer.id, customerGroupId: group.id, groupName: group.name, tallyGuid: group.tally_group_guid,
      isAvailable: group.is_available, parentGroupId: group.parent_group_id,
    });
    groupId = group.parent_group_id;
  }
  return {
    id: customer.id, tallyLedgerGuid: customer.tally_ledger_guid, ledgerName: customer.ledger_name,
    isAvailable: customer.is_available, currentCustomerGroupId: customer.current_customer_group_id, groupPath: path,
  };
}

async function loadRule(companyId: string, versionId: string): Promise<FrozenCdRule | FrozenTodRule> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("scheme_versions")
    .select("id, company_id, scheme_id, scheme_type, version_number, status, effective_from, effective_to, discount_percentage, rounding_method, rounding_scale, working_calendar_id, allowed_working_days, near_eligibility_percent, period_months, period_anchor_date, tod_review_calendar_id")
    .eq("id", versionId).eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("The selected rule version is unavailable.");
  const row = { ...data, cd_check_narration: null } as unknown as RuleRow;
  const [customerGroups, stockItems, stockGroups, conversions, tiers, cdSlabs] = await Promise.all([
    supabase.from("scheme_version_group_coverage").select("customer_group_id").eq("scheme_version_id", row.id),
    supabase.from("scheme_version_stock_items").select("stock_item_id").eq("scheme_version_id", row.id),
    supabase.from("scheme_version_stock_groups").select("stock_group_id").eq("scheme_version_id", row.id),
    supabase.from("scheme_version_unit_conversions").select("source_uom_id, tonnes_per_source_unit").eq("scheme_version_id", row.id),
    supabase.from("scheme_version_tiers").select("id, minimum_tonnes, discount_percentage").eq("scheme_version_id", row.id).order("minimum_tonnes"),
    supabase.from("scheme_version_cd_slabs").select("id, allowed_working_days, discount_percentage").eq("scheme_version_id", row.id).order("allowed_working_days"),
  ]);
  for (const result of [customerGroups, stockItems, stockGroups, conversions, tiers, cdSlabs]) if (result.error) throw result.error;
  const sourceSnapshot = {
    schemeVersionId: row.id, schemeId: row.scheme_id, schemeType: row.scheme_type, versionNumber: row.version_number,
    effectiveFrom: row.effective_from, effectiveTo: row.effective_to, roundingMethod: row.rounding_method, roundingScale: row.rounding_scale,
  };
  const base = {
    id: row.id, schemeId: row.scheme_id, companyId: row.company_id, schemeType: row.scheme_type,
    versionNumber: row.version_number, effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
    roundingMethod: row.rounding_method, roundingScale: Number(row.rounding_scale),
    selectedCustomerGroupIds: (customerGroups.data ?? []).map((item) => item.customer_group_id), sourceSnapshot,
  } as const;
  if (row.scheme_type === "cd") {
    const { data: cashDiscountSettings, error: cashDiscountSettingsError } = await supabase
      .from("scheme_versions")
      .select("cd_check_narration, cd_narration_mode")
      .eq("id", row.id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (cashDiscountSettingsError) {
      if (cashDiscountSettingsError.code === "42703") {
        throw new Error("Cash Discount settings are awaiting the prepared database update.");
      }
      throw cashDiscountSettingsError;
    }
    if (!row.working_calendar_id || !row.near_eligibility_percent || !cdSlabs.data?.length) {
      throw new Error("The active Cash Discount rule is incomplete.");
    }
    return {
      ...base, schemeType: "cd",
      slabs: cdSlabs.data.map((slab) => ({ id: slab.id, allowedWorkingDays: Number(slab.allowed_working_days), percentage: String(slab.discount_percentage) })),
      nearEligibilityPercent: row.near_eligibility_percent,
      checkNarration: cashDiscountSettings?.cd_check_narration !== false,
      narrationMode: cashDiscountSettings?.cd_narration_mode === "required" || cashDiscountSettings?.cd_narration_mode === "disabled"
        ? cashDiscountSettings.cd_narration_mode
        : "informational",
      calendar: await loadCalendar(row.working_calendar_id),
    };
  }
  if (!row.period_anchor_date || !row.period_months) throw new Error("The active Turnover Discount rule is incomplete.");
  return {
    ...base, schemeType: "tod", periodAnchorDate: row.period_anchor_date, periodMonths: Number(row.period_months),
    selectedStockItemIds: (stockItems.data ?? []).map((item) => item.stock_item_id),
    selectedStockGroupIds: (stockGroups.data ?? []).map((item) => item.stock_group_id),
    unitConversions: (conversions.data ?? []).map((item) => ({ id: `${row.id}:${item.source_uom_id}`, sourceUomId: item.source_uom_id, tonnesPerUnit: String(item.tonnes_per_source_unit) })),
    tiers: (tiers.data ?? []).map((item) => ({ id: item.id, minimumTonnes: String(item.minimum_tonnes), percentage: String(item.discount_percentage) })),
    reviewCalendar: row.tod_review_calendar_id ? await loadCalendar(row.tod_review_calendar_id) : null,
  };
}

async function activeRuleIds(companyId: string, type: SchemeType, onDate: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("scheme_versions")
    .select("id, status")
    .eq("company_id", companyId).eq("scheme_type", type).eq("status", "active")
    .lte("effective_from", onDate)
    .or(`effective_to.is.null,effective_to.gte.${onDate}`)
    .order("version_number", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => row.id);
}

function periodContaining(anchor: string, months: number, asOfDate: string) {
  if (asOfDate < anchor) return null;
  let start = anchor;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const end = previousCalendarDay(addCalendarMonths(start, months));
    if (asOfDate <= end) return { start, end };
    start = addCalendarMonths(start, months);
  }
  throw new Error("Could not determine the TOD period from its configured anchor.");
}

async function chooseCdRule(companyId: string, customer: CustomerEvidence, invoiceDate: string) {
  for (const id of await activeRuleIds(companyId, "cd", invoiceDate)) {
    const rule = await loadRule(companyId, id) as FrozenCdRule;
    if (resolveRuleCoverage(rule, customer, invoiceDate).state !== "not_in_scheme") return rule;
  }
  return null;
}

async function chooseTodRule(companyId: string, customer: CustomerEvidence, asOfDate: string) {
  const supabase = createSupabaseAdminClient();
  const { data: locks, error: lockError } = await supabase
    .from("tod_customer_period_rule_locks")
    .select("scheme_version_id, period_start, period_end")
    .eq("company_id", companyId).eq("customer_id", customer.id)
    .lte("period_start", asOfDate).gte("period_end", asOfDate);
  if (lockError) throw lockError;
  if ((locks ?? []).length > 1) throw new Error("More than one immutable TOD rule lock matches this customer and date.");
  if (locks?.[0]) {
    return { rule: await loadRule(companyId, locks[0].scheme_version_id) as FrozenTodRule, periodStart: locks[0].period_start, periodEnd: locks[0].period_end, locked: true };
  }
  for (const id of await activeRuleIds(companyId, "tod", asOfDate)) {
    const rule = await loadRule(companyId, id) as FrozenTodRule;
    const period = periodContaining(rule.periodAnchorDate, rule.periodMonths, asOfDate);
    if (period && resolveRuleCoverage(rule, customer, asOfDate).state !== "not_in_scheme") return { rule, periodStart: period.start, periodEnd: period.end, locked: false };
  }
  return null;
}

export async function loadLiveTodBatchContext(run: EvaluationRunRecord) {
  const asOfDate = dateText(run.request_context.asOfDate, utcToday());
  const ruleIds = await activeRuleIds(run.company_id, "tod", asOfDate);
  if (!ruleIds.length) throw new Error("No active Turnover Discount rule is available for this date.");
  if (ruleIds.length > 1) throw new Error("More than one active Turnover Discount rule covers this date.");
  const ruleId = ruleIds[0];
  const rule = await loadRule(run.company_id, ruleId) as FrozenTodRule;
  const period = periodContaining(rule.periodAnchorDate, rule.periodMonths, asOfDate);
  if (!period) throw new Error("The active Turnover Discount rule has not started yet.");
  const supabase = createSupabaseAdminClient();
  const [{ data: groups, error: groupError }, { data: locks, error: lockError }] = await Promise.all([
    supabase.from("customer_groups").select("id, tally_group_guid, name, is_available, parent_group_id").eq("company_id", run.company_id),
    supabase.from("tod_customer_period_rule_locks")
      .select("customer_id, scheme_version_id, period_start, period_end")
      .eq("company_id", run.company_id).lte("period_start", asOfDate).gte("period_end", asOfDate),
  ]);
  if (groupError || lockError) throw groupError ?? lockError;
  const groupsById = new Map((groups ?? []).map((group) => [group.id, group]));
  const locksByCustomerId = new Map<string, { schemeVersionId: string; periodStart: string; periodEnd: string }>();
  for (const lock of locks ?? []) {
    if (locksByCustomerId.has(lock.customer_id)) throw new Error("More than one immutable TOD rule lock matches a customer and date.");
    locksByCustomerId.set(lock.customer_id, { schemeVersionId: lock.scheme_version_id, periodStart: lock.period_start, periodEnd: lock.period_end });
  }
  const coveredGroupIds = new Set(rule.selectedCustomerGroupIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups ?? []) {
      if (group.parent_group_id && coveredGroupIds.has(group.parent_group_id) && !coveredGroupIds.has(group.id)) {
        coveredGroupIds.add(group.id);
        changed = true;
      }
    }
  }
  const [coveredCustomers, lockedCustomers] = await Promise.all([
    loadAvailableCustomers(run.company_id, [...coveredGroupIds]),
    loadAvailableCustomersByIds(run.company_id, [...locksByCustomerId.keys()]),
  ]);
  const customers = [...new Map([...coveredCustomers, ...lockedCustomers].map((customer) => [customer.id, customer])).values()];
  const ruleCache = new Map<string, FrozenTodRule>([[rule.id, rule]]);
  const loadCachedRule = async (id: string) => {
    const cached = ruleCache.get(id);
    if (cached) return cached;
    const loaded = await loadRule(run.company_id, id) as FrozenTodRule;
    ruleCache.set(id, loaded);
    return loaded;
  };
  const batches = new Map<string, { rule: FrozenTodRule; periodStart: string; periodEnd: string; customers: Array<CustomerEvidence & { ledgerName: string }> }>();
  for (const customer of customers ?? []) {
    const groupPath: CustomerGroupMembership[] = [];
    let groupId: string | null = customer.current_customer_group_id;
    for (let guard = 0; groupId && guard < 100; guard += 1) {
      const group = groupsById.get(groupId);
      if (!group) break;
      groupPath.push({ customerId: customer.id, customerGroupId: group.id, groupName: group.name, tallyGuid: group.tally_group_guid, isAvailable: group.is_available, parentGroupId: group.parent_group_id });
      groupId = group.parent_group_id;
    }
    const evidence: CustomerEvidence & { ledgerName: string } = {
      id: customer.id,
      tallyLedgerGuid: customer.tally_ledger_guid,
      ledgerName: customer.ledger_name,
      isAvailable: customer.is_available,
      currentCustomerGroupId: customer.current_customer_group_id,
      groupPath,
    };
    const lock = locksByCustomerId.get(customer.id);
    const candidate = lock
      ? { rule: await loadCachedRule(lock.schemeVersionId), periodStart: lock.periodStart, periodEnd: lock.periodEnd }
      : resolveRuleCoverage(rule, evidence, asOfDate).state === "covered"
        ? { rule, periodStart: period.start, periodEnd: period.end }
        : null;
    if (!candidate) continue;
    const key = `${candidate.rule.id}:${candidate.periodStart}:${candidate.periodEnd}`;
    const batch = batches.get(key) ?? { ...candidate, customers: [] };
    batch.customers.push(evidence);
    batches.set(key, batch);
  }
  if (!batches.size) throw new Error("The active Turnover Discount rule does not cover any available Tally customers.");
  return { groups: [...batches.values()], evaluatedOn: dateText(run.request_context.evaluatedOn, utcToday()) };
}

export async function loadLiveTodContext(run: EvaluationRunRecord) {
  const customerId = run.request_context.customerId;
  if (typeof customerId !== "string") throw new Error("A TOD evaluation requires customerId.");
  const customer = await loadCustomer(run.company_id, customerId);
  const asOfDate = dateText(run.request_context.asOfDate, utcToday());
  const candidate = await chooseTodRule(run.company_id, customer, asOfDate);
  if (!candidate) throw new Error("No active Turnover Discount rule covers this customer and date.");
  return { ...candidate, customer, evaluatedOn: dateText(run.request_context.evaluatedOn, utcToday()) };
}

async function buildLiveTodVoucherScope(
  run: EvaluationRunRecord,
  context: { rule: FrozenTodRule; periodStart: string; periodEnd: string; customers?: Array<CustomerEvidence & { ledgerName: string }>; customer?: CustomerEvidence & { ledgerName: string } },
) {
  const supabase = createSupabaseAdminClient();
  const selectedItemIds = context.rule.selectedStockItemIds;
  const selectedGroupIds = context.rule.selectedStockGroupIds;
  const [{ data: coveredGroups, error: coveredGroupsError }, { data: units, error: unitsError }] = await Promise.all([
    selectedGroupIds.length
      ? supabase.from("scheme_version_stock_group_coverage").select("stock_group_id").eq("scheme_version_id", context.rule.id)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("tally_units").select("id, code, name").eq("company_id", run.company_id).eq("is_available", true),
  ]);
  if (coveredGroupsError || unitsError) throw coveredGroupsError ?? unitsError;
  const coveredGroupIds = (coveredGroups ?? []).map((row) => row.stock_group_id);
  const stockQueries = [
    selectedItemIds.length
      ? supabase.from("stock_items").select("tally_stock_item_guid, name").eq("company_id", run.company_id).eq("is_available", true).in("id", selectedItemIds)
      : Promise.resolve({ data: [], error: null }),
    coveredGroupIds.length
      ? supabase.from("stock_items").select("tally_stock_item_guid, name").eq("company_id", run.company_id).eq("is_available", true).in("current_stock_group_id", coveredGroupIds)
      : Promise.resolve({ data: [], error: null }),
  ];
  const [selectedItems, coveredItems] = await Promise.all(stockQueries);
  if (selectedItems.error || coveredItems.error) throw selectedItems.error ?? coveredItems.error;
  const itemRows = [...(selectedItems.data ?? []), ...(coveredItems.data ?? [])];
  const unitById = new Map((units ?? []).map((unit) => [unit.id, unit]));
  const batchCustomers = context.customers;
  const singleCustomer = context.customer;
  if (!batchCustomers && !singleCustomer) throw new Error("A Turnover Discount Tally scope needs at least one customer.");
  return {
    purpose: "live_tod_evaluation",
    liveAggregation: true,
    schemeType: "tod",
    evaluationRunId: run.id,
    ...(batchCustomers
      ? { customers: batchCustomers.map((customer) => ({ customerId: customer.id, ledgerName: customer.ledgerName })) }
      : { customerId: singleCustomer!.id, customerLedgerName: singleCustomer!.ledgerName }),
    dateFrom: context.periodStart,
    dateTo: context.periodEnd,
    eligibleStockItemGuids: [...new Set(itemRows.map((item) => item.tally_stock_item_guid).filter(Boolean))],
    eligibleStockItemNames: [...new Set(itemRows.map((item) => item.name).filter(Boolean))],
    unitConversions: context.rule.unitConversions.flatMap((conversion) => {
      const unit = unitById.get(conversion.sourceUomId);
      if (!unit) return [];
      return [{ uomCode: unit.code || unit.name, tonnesPerUnit: conversion.tonnesPerUnit }];
    }),
  };
}

async function liveTodVoucherScope(run: EvaluationRunRecord) {
  const batchContext = run.request_context.batch === true ? await loadLiveTodBatchContext(run) : null;
  if (batchContext && batchContext.groups.length !== 1) {
    throw new Error("This Turnover Discount calculation has customers in different locked rule periods. Use the local Tally calculation so each period is checked safely.");
  }
  const context = batchContext?.groups[0] ?? await loadLiveTodContext(run);
  return buildLiveTodVoucherScope(run, context);
}

export async function loadLiveTodLocalBootstrap(run: EvaluationRunRecord) {
  const context = await loadLiveTodBatchContext(run);
  return {
    evaluatedOn: context.evaluatedOn,
    batches: await Promise.all(context.groups.map(async (group) => ({
      rule: group.rule,
      periodStart: group.periodStart,
      periodEnd: group.periodEnd,
      customers: group.customers.map((customer) => ({ customerId: customer.id, ledgerName: customer.ledgerName })),
      voucherScope: await buildLiveTodVoucherScope(run, group),
    }))),
  };
}

export async function loadLiveCdContext(run: EvaluationRunRecord, customerId: string, invoiceDate: string) {
  const customer = await loadCustomer(run.company_id, customerId);
  const ruleIds = await activeRuleIds(run.company_id, "cd", invoiceDate);
  if (ruleIds.length !== 1) throw new Error(ruleIds.length ? "More than one active Cash Discount rule is available." : "No active Cash Discount rule is available.");
  const rule = await loadRule(run.company_id, ruleIds[0]) as FrozenCdRule;
  if (resolveRuleCoverage(rule, customer, invoiceDate).state === "not_in_scheme") throw new Error("The customer is not covered by the active Cash Discount rule.");
  return { rule, customer, evaluatedOn: dateText(run.request_context.evaluatedOn, utcToday()) };
}

export async function loadLiveCdBatchRule(run: EvaluationRunRecord, ruleVersionId: string) {
  const rule = await loadRule(run.company_id, ruleVersionId);
  if (rule.schemeType !== "cd") throw new Error("The selected rule is not a Cash Discount rule.");
  return { rule, evaluatedOn: dateText(run.request_context.evaluatedOn, utcToday()) };
}

export async function loadLiveCdLocalBootstrap(run: EvaluationRunRecord) {
  const evaluatedOn = dateText(run.request_context.evaluatedOn, utcToday());
  const ruleIds = await activeRuleIds(run.company_id, "cd", evaluatedOn);
  if (ruleIds.length !== 1) throw new Error(ruleIds.length ? "More than one active Cash Discount rule is available." : "No active Cash Discount rule is available.");
  const rule = await loadRule(run.company_id, ruleIds[0]) as FrozenCdRule;
  const supabase = createSupabaseAdminClient();
  const { data: groups, error: groupError } = await supabase
    .from("customer_groups")
    .select("id, tally_group_guid, name, parent_group_id")
    .eq("company_id", run.company_id);
  if (groupError) throw groupError;
  const selectedGroupIds = new Set(rule.selectedCustomerGroupIds);
  const coveredGroupIds = new Set(selectedGroupIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups ?? []) {
      if (group.parent_group_id && coveredGroupIds.has(group.parent_group_id) && !coveredGroupIds.has(group.id)) {
        coveredGroupIds.add(group.id);
        changed = true;
      }
    }
  }
  const selectedGroups = (groups ?? [])
    .filter((group) => selectedGroupIds.has(group.id))
    .map((group) => ({ tallyGuid: group.tally_group_guid, name: group.name }));
  const customers = await loadAvailableCustomers(run.company_id, [...coveredGroupIds]);
  const eligibleCustomers = (customers ?? [])
    .filter((customer) => customer.current_customer_group_id && coveredGroupIds.has(customer.current_customer_group_id))
    .map((customer) => ({ customerId: customer.tally_ledger_guid || customer.id, ledgerName: customer.ledger_name }));
  if (!selectedGroups.length) throw new Error("Choose at least one Tally customer group in the active Cash Discount rule.");
  if (!eligibleCustomers.length) throw new Error("The selected Cash Discount groups do not contain any available customers.");
  const voucherScope = {
    purpose: "live_cd_evaluation",
    liveAggregation: "cd",
    schemeType: "cd",
    evaluationRunId: run.id,
    ruleVersionId: rule.id,
    groups: selectedGroups,
    customers: eligibleCustomers,
    dateFrom: rule.effectiveFrom,
    dateTo: evaluatedOn,
    maxWorkingDays: Math.max(...rule.slabs.map((slab) => slab.allowedWorkingDays)),
    checkNarration: rule.checkNarration,
  };
  return { rule, evaluatedOn, voucherScope };
}

async function liveCdVoucherScope(run: EvaluationRunRecord) {
  return (await loadLiveCdLocalBootstrap(run)).voucherScope;
}

async function loadVouchers(companyId: string, start: string, end: string, customerId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("tally_vouchers")
    .select("id, tally_guid, tally_master_id, tally_alter_id, voucher_number, voucher_kind, voucher_date, party_customer_id, linked_sales_voucher_id, status, taxable_product_value, gross_amount, source_payload")
    .eq("company_id", companyId).eq("party_customer_id", customerId).gte("voucher_date", start).lte("voucher_date", end);
  if (error) throw error;
  return (data ?? []).map((row) => voucher(row as unknown as Record<string, unknown>));
}

async function loadInventoryLines(companyId: string, voucherIds: string[]) {
  if (!voucherIds.length) return [];
  const { data, error } = await createSupabaseAdminClient()
    .from("tally_voucher_inventory_lines")
    .select("id, voucher_id, line_number, stock_item_id, stock_group_id, source_uom_id, source_uom_code_snapshot, quantity, taxable_product_value, freight_value, non_product_value, line_category, quantity_is_reliable, source_payload")
    .eq("company_id", companyId).in("voucher_id", voucherIds);
  if (error) throw error;
  return (data ?? []).map((row) => inventoryLine(row as unknown as Record<string, unknown>));
}

async function loadExistingCreditNotes(companyId: string, entitlementKey: string, knownVouchers: VoucherEvidence[]) {
  const supabase = createSupabaseAdminClient();
  const { data: proposal, error: proposalError } = await supabase
    .from("discount_proposals").select("id").eq("company_id", companyId).eq("entitlement_key", entitlementKey).maybeSingle();
  if (proposalError) throw proposalError;
  if (!proposal) return [];
  const { data: postings, error: postingError } = await supabase
    .from("credit_note_postings").select("status, tally_credit_note_voucher_id").eq("proposal_id", proposal.id).eq("company_id", companyId).eq("status", "created_verified");
  if (postingError) throw postingError;
  const byId = new Map(knownVouchers.map((item) => [item.id, item]));
  const missingVoucherIds = [...new Set((postings ?? [])
    .map((posting) => posting.tally_credit_note_voucher_id)
    .filter((id): id is string => typeof id === "string" && !byId.has(id)))];
  if (missingVoucherIds.length > 0) {
    const { data: missingVouchers, error: missingVouchersError } = await supabase
      .from("tally_vouchers")
      .select("id, tally_guid, tally_master_id, tally_alter_id, voucher_number, voucher_kind, voucher_date, party_customer_id, linked_sales_voucher_id, status, taxable_product_value, gross_amount, source_payload")
      .eq("company_id", companyId)
      .in("id", missingVoucherIds);
    if (missingVouchersError) throw missingVouchersError;
    for (const row of missingVouchers ?? []) {
      const evidence = voucher(row as unknown as Record<string, unknown>);
      byId.set(evidence.id, evidence);
    }
  }
  return (postings ?? []).flatMap((posting) => {
    const evidence = posting.tally_credit_note_voucher_id ? byId.get(posting.tally_credit_note_voucher_id) : undefined;
    return evidence ? [{ ...evidence, verifiedForProposal: true }] satisfies ExistingCreditNoteEvidence[] : [];
  });
}

async function loadTodPriorPeriodAdjustments(
  companyId: string,
  customerId: string,
  periodStart: string,
  currentPeriodVouchers: VoucherEvidence[],
): Promise<PriorPeriodAdjustmentEvidence[]> {
  const lateAdjustmentVouchers = currentPeriodVouchers.filter((voucher) =>
    voucher.status === "posted"
    && (voucher.voucherKind === "sales_return" || voucher.voucherKind === "debit_note")
    && voucher.linkedSalesVoucherId,
  );
  const linkedSalesVoucherIds = [...new Set(lateAdjustmentVouchers
    .map((voucher) => voucher.linkedSalesVoucherId)
    .filter((id): id is string => typeof id === "string"))];
  if (linkedSalesVoucherIds.length === 0) return [];

  const supabase = createSupabaseAdminClient();
  const [{ data: linkedSales, error: linkedSalesError }, { data: priorProposals, error: priorProposalsError }] = await Promise.all([
    supabase.from("tally_vouchers").select("id, voucher_date").eq("company_id", companyId).in("id", linkedSalesVoucherIds),
    supabase.from("discount_proposals").select("id, period_start, period_end").eq("company_id", companyId).eq("customer_id", customerId).eq("scheme_type", "tod").lt("period_end", periodStart),
  ]);
  if (linkedSalesError) throw linkedSalesError;
  if (priorProposalsError) throw priorProposalsError;
  const proposalIds = (priorProposals ?? []).map((proposal) => proposal.id);
  if (proposalIds.length === 0) return [];
  const { data: verifiedPostings, error: verifiedPostingsError } = await supabase
    .from("credit_note_postings")
    .select("proposal_id")
    .eq("company_id", companyId)
    .eq("status", "created_verified")
    .in("proposal_id", proposalIds);
  if (verifiedPostingsError) throw verifiedPostingsError;
  const verifiedProposalIds = new Set((verifiedPostings ?? []).map((posting) => posting.proposal_id));
  const verifiedPeriods = (priorProposals ?? []).filter((proposal) => verifiedProposalIds.has(proposal.id));
  const saleDateById = new Map((linkedSales ?? []).map((sale) => [sale.id, sale.voucher_date]));

  return lateAdjustmentVouchers.flatMap((voucher) => {
    const linkedSaleDate = voucher.linkedSalesVoucherId ? saleDateById.get(voucher.linkedSalesVoucherId) : null;
    const originalPeriod = linkedSaleDate
      ? verifiedPeriods.find((period) => linkedSaleDate >= period.period_start && linkedSaleDate <= period.period_end)
      : undefined;
    if (!originalPeriod) return [];
    return [{
      voucher,
      originalPeriodStart: originalPeriod.period_start,
      originalPeriodEnd: originalPeriod.period_end,
      // The pure evaluator derives these values only once from the current
      // normalized voucher lines and their approved conversion.
      taxableValueAdjustment: "0",
      tonneAdjustment: "0",
      reason: voucher.voucherKind === "sales_return"
        ? "sales_return_after_verified_tod_credit_note"
        : "linked_debit_note_after_verified_tod_credit_note",
    }];
  });
}

async function loadCd(run: EvaluationRunRecord): Promise<LoadedCdEvaluation> {
  const salesVoucherId = run.request_context.salesVoucherId;
  if (typeof salesVoucherId !== "string") throw new Error("A CD evaluation requires salesVoucherId.");
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("tally_vouchers")
    .select("id, tally_guid, tally_master_id, tally_alter_id, voucher_number, voucher_kind, voucher_date, party_customer_id, linked_sales_voucher_id, status, taxable_product_value, gross_amount, source_payload")
    .eq("id", salesVoucherId).eq("company_id", run.company_id).maybeSingle();
  if (error) throw error;
  if (!data || !data.party_customer_id) throw new Error("The requested sales voucher or its Tally customer is unavailable.");
  const salesVoucher = voucher(data as unknown as Record<string, unknown>);
  const customer = await loadCustomer(run.company_id, salesVoucher.partyCustomerId!);
  const rule = await chooseCdRule(run.company_id, customer, salesVoucher.voucherDate);
  if (!rule) throw new Error("No active Cash Discount rule covers this customer and invoice date.");
  const maximumDays = Math.max(...rule.slabs.map((slab) => slab.allowedWorkingDays));
  const deadline = workingDayBreakdown(rule.calendar, salesVoucher.voucherDate, maximumDays).at(-1)?.businessDate;
  if (!deadline) throw new Error("The Cash Discount calendar has no deadline.");
  const vouchers = await loadVouchers(run.company_id, salesVoucher.voucherDate, deadline, customer.id);
  const allVouchers = new Map(vouchers.map((item) => [item.id, item]));
  allVouchers.set(salesVoucher.id, salesVoucher);
  const inventoryLines = await loadInventoryLines(run.company_id, [salesVoucher.id]);
  const allocations = await Promise.all([
    supabase.from("tally_bill_allocations").select("id, source_voucher_id, target_voucher_id, bill_reference, allocation_type, allocation_date, allocated_amount, source_payload").eq("company_id", run.company_id).eq("target_voucher_id", salesVoucher.id),
    salesVoucher.voucherNumber ? supabase.from("tally_bill_allocations").select("id, source_voucher_id, target_voucher_id, bill_reference, allocation_type, allocation_date, allocated_amount, source_payload").eq("company_id", run.company_id).eq("bill_reference", salesVoucher.voucherNumber) : Promise.resolve({ data: [], error: null }),
  ]);
  if (allocations[0].error || allocations[1].error) throw allocations[0].error ?? allocations[1].error;
  const allocationRows = [...(allocations[0].data ?? []), ...(allocations[1].data ?? [])];
  const paymentAllocations: BillAllocationEvidence[] = [...new Map(allocationRows.map((row) => [row.id, row])).values()].flatMap((row) => {
    const receipt = allVouchers.get(row.source_voucher_id);
    return receipt ? [{
      id: row.id, sourceVoucherId: row.source_voucher_id, targetVoucherId: row.target_voucher_id,
      targetReference: row.bill_reference, allocationType: row.allocation_type,
      allocatedAmount: String(row.allocated_amount), receiptVoucherDate: receipt.voucherDate,
      receiptVoucherStatus: receipt.status, sourceSnapshot: toRecord(row.source_payload),
    }] : [];
  });
  const entitlementKey = `cd:${rule.companyId}:${customer.id}:${salesVoucher.id}:${rule.id}`;
  return {
    kind: "cd", rule, customer, salesVoucher, inventoryLines, paymentAllocations,
    existingCreditNotes: await loadExistingCreditNotes(run.company_id, entitlementKey, [...allVouchers.values()]),
    evaluatedOn: dateText(run.request_context.evaluatedOn, utcToday()),
  };
}

async function loadTod(run: EvaluationRunRecord): Promise<LoadedTodEvaluation> {
  const customerId = run.request_context.customerId;
  if (typeof customerId !== "string") throw new Error("A TOD evaluation requires customerId.");
  const customer = await loadCustomer(run.company_id, customerId);
  const asOfDate = dateText(run.request_context.asOfDate, utcToday());
  const candidate = await chooseTodRule(run.company_id, customer, asOfDate);
  if (!candidate) throw new Error("No active Turnover Discount rule covers this customer and date.");
  const vouchers = await loadVouchers(run.company_id, candidate.periodStart, candidate.periodEnd, customer.id);
  const inventoryLines = await loadInventoryLines(run.company_id, vouchers.map((item) => item.id));
  const entitlementKey = `tod:${candidate.rule.companyId}:${customer.id}:${candidate.periodStart}:${candidate.periodEnd}:${candidate.rule.id}`;
  return {
    kind: "tod", rule: candidate.rule, customer, periodStart: candidate.periodStart, periodEnd: candidate.periodEnd,
    lockedPeriod: candidate.locked,
    vouchers, inventoryLines, existingCreditNotes: await loadExistingCreditNotes(run.company_id, entitlementKey, vouchers),
    priorPeriodAdjustments: await loadTodPriorPeriodAdjustments(run.company_id, customer.id, candidate.periodStart, vouchers),
    evaluatedOn: dateText(run.request_context.evaluatedOn, utcToday()),
  };
}

export async function deriveRefreshScope(run: EvaluationRunRecord): Promise<RefreshScope> {
  if (run.request_context.schemeType === "tod") {
    const voucherScope = await liveTodVoucherScope(run);
    return { masterScope: "customerId" in voucherScope ? { purpose: "evaluation", customerId: voucherScope.customerId } : { purpose: "batch_evaluation" }, voucherScope };
  }
  if (run.request_context.batch === true) {
    return { masterScope: { purpose: "batch_evaluation" }, voucherScope: await liveCdVoucherScope(run) };
  }
  const loaded = await loadCd(run);
  const maximumDays = Math.max(...loaded.rule.slabs.map((slab) => slab.allowedWorkingDays));
  const deadline = workingDayBreakdown(loaded.rule.calendar, loaded.salesVoucher.voucherDate, maximumDays).at(-1)!.businessDate;
  return {
    masterScope: { purpose: "evaluation", customerId: loaded.customer.id },
    voucherScope: { purpose: "evaluation", customerId: loaded.customer.id, customerLedgerName: loaded.customer.ledgerName, voucherReference: loaded.salesVoucher.voucherNumber, dateFrom: loaded.salesVoucher.voucherDate, dateTo: deadline },
  };
}

export async function loadFreshEvaluation(run: EvaluationRunRecord): Promise<LoadedEvaluation> {
  return run.request_context.schemeType === "cd" ? loadCd(run) : loadTod(run);
}
