import { firstWorkingDayAfter } from "./calendar";
import type { EvaluationIssue, EvaluationResult, ProposalStatus } from "./contracts";
import { decimal, money, nonNegative, percentOf, quantity } from "./decimal";
import { loadLiveTodContext, type EvaluationRunRecord } from "./evidence";
import { fingerprintEvidence } from "./fingerprint";
import { resolveRuleCoverage } from "./groups";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type LiveTodAggregate = {
  mode: "live_tod_aggregate";
  evaluationRunId: string | null;
  periodStart: string;
  periodEnd: string;
  chunks: number;
  vouchersScanned: number;
  matchingVouchers: number;
  eligibleTaxableValue: string;
  eligibleTonnes: string;
  missingUnits: string[];
  contributions: Array<{
    tallyGuid: string;
    voucherNumber: string | null;
    voucherDate: string;
    voucherKind: string;
    tallyAlterId: string | null;
    linkedSalesVoucherGuid: string | null;
    sourceSalesLedgerName: string | null;
    taxableValueContribution: string;
    tonneContribution: string;
  }>;
  productContributions: Array<{
    productName: string;
    productGroupName: string | null;
    sourceUom: string | null;
    sourceQuantity: string;
    eligibleTonnes: string;
    eligibleTaxableValue: string;
  }>;
  /** Present when the 25-day payment check ran: one row per period Sales invoice. */
  paymentChecks?: TodPaymentCheck[];
  excludedInvoices?: number;
  sourceFingerprint: string;
};

export type TodPaymentCheck = {
  customerId: string;
  customerLedgerName: string;
  tallyGuid: string;
  voucherNumber: string | null;
  invoiceDate: string;
  invoiceAmount: string;
  dueDays: number;
  nominalDueDate: string;
  dueDate: string;
  shiftedFor: Array<{ date: string; reason: "holiday" | "non_working_day" }>;
  paidInFullOn: string | null;
  daysTaken: number | null;
  paidByDueDate: string;
  paidTotal: string;
  payments: Array<{ receiptNumber: string | null; receiptDate: string; amount: string }>;
  tonnes: string;
  taxableValue: string;
  counted: boolean;
  reason: "paid_in_full_on_time" | "paid_after_due_date" | "partly_paid" | "not_paid";
};

export type LiveTodBatchAggregate = {
  mode: "live_tod_batch_aggregate";
  evaluationRunId: string | null;
  periodStart: string;
  periodEnd: string;
  chunks: number;
  vouchersScanned: number;
  matchingVouchers: number;
  customerAggregates: Array<Omit<LiveTodAggregate, "mode" | "evaluationRunId" | "periodStart" | "periodEnd" | "chunks" | "vouchersScanned"> & { customerId: string; customerLedgerName: string }>;
  sourceFingerprint: string;
};

export function isLiveTodAggregate(value: unknown): value is LiveTodAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.mode === "live_tod_aggregate"
    && typeof row.sourceFingerprint === "string"
    && typeof row.eligibleTaxableValue === "string"
    && typeof row.eligibleTonnes === "string"
    && Array.isArray(row.contributions)
    && Array.isArray(row.missingUnits);
}

export function isLiveTodBatchAggregate(value: unknown): value is LiveTodBatchAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.mode === "live_tod_batch_aggregate"
    && typeof row.sourceFingerprint === "string"
    && typeof row.periodStart === "string"
    && typeof row.periodEnd === "string"
    && Array.isArray(row.customerAggregates);
}

export async function evaluateLiveTodAggregate(run: EvaluationRunRecord, aggregate: LiveTodAggregate) {
  const context = await loadLiveTodContext(run);
  if (aggregate.evaluationRunId !== run.id || aggregate.periodStart !== context.periodStart || aggregate.periodEnd !== context.periodEnd) {
    throw new Error("The live Tally result does not match this evaluation and period.");
  }
  const { rule, customer } = context;
  const currentCoverage = resolveRuleCoverage(rule, customer, context.evaluatedOn);
  // A locked period keeps the version that was valid when the customer first
  // entered that period. Current membership can be different after a later
  // Tally master sync, but it must not rewrite the prior entitlement.
  const coverage = context.locked && currentCoverage.state === "not_in_scheme"
    ? { ...currentCoverage, state: "covered" as const }
    : currentCoverage;
  const issues: EvaluationIssue[] = [];
  const reasonCodes = [...coverage.reasonCodes];
  if (aggregate.missingUnits.length) {
    issues.push({ issueKey: `tod:${rule.companyId}:${rule.id}:${customer.id}:${context.periodStart}:missing-live-conversion`, issueType: "missing_unit_conversion", customerId: customer.id, schemeVersionId: rule.id, details: { units: aggregate.missingUnits } });
    reasonCodes.push("approved_conversion_missing");
  }
  if (!rule.reviewCalendar) {
    issues.push({ issueKey: `tod:${rule.companyId}:${rule.id}:${customer.id}:${context.periodStart}:review-calendar`, issueType: "missing_rule_configuration", customerId: customer.id, schemeVersionId: rule.id, details: { message: "A review calendar is required." } });
    reasonCodes.push("tod_review_calendar_missing");
  }
  if (coverage.state === "needs_review") {
    issues.push({ issueKey: `tod:${rule.companyId}:${rule.id}:${customer.id}:${context.periodStart}:group`, issueType: "ambiguous_group_membership", customerId: customer.id, schemeVersionId: rule.id, details: { groupPath: customer.groupPath } });
  }

  const eligibleTaxableValue = nonNegative(aggregate.eligibleTaxableValue);
  const eligibleTonnes = nonNegative(aggregate.eligibleTonnes);
  const orderedTiers = [...rule.tiers].sort((left, right) => decimal(left.minimumTonnes).comparedTo(decimal(right.minimumTonnes)));
  const achievedTier = orderedTiers.filter((tier) => eligibleTonnes.greaterThanOrEqualTo(tier.minimumTonnes)).at(-1) ?? null;
  const nextTier = orderedTiers.find((tier) => decimal(tier.minimumTonnes).greaterThan(eligibleTonnes)) ?? null;
  const entitlementKey = `tod:${rule.companyId}:${customer.id}:${context.periodStart}:${context.periodEnd}:${rule.id}`;
  const { data: existingProposal, error: proposalError } = await createSupabaseAdminClient().from("discount_proposals").select("id").eq("company_id", rule.companyId).eq("entitlement_key", entitlementKey).maybeSingle();
  if (proposalError) throw proposalError;
  const { data: existingPosting, error: postingError } = existingProposal
    ? await createSupabaseAdminClient().from("credit_note_postings").select("id").eq("proposal_id", existingProposal.id).eq("company_id", rule.companyId).eq("status", "created_verified").maybeSingle()
    : { data: null, error: null };
  if (postingError) throw postingError;
  const reviewOpenDate = rule.reviewCalendar ? firstWorkingDayAfter(rule.reviewCalendar, context.periodEnd) : null;
  let status: ProposalStatus;
  if (existingPosting) status = "already_credited";
  else if (issues.length || coverage.state === "needs_review") status = "needs_review";
  else if (coverage.state === "not_in_scheme") status = "not_in_scheme";
  else if (!reviewOpenDate || context.evaluatedOn < reviewOpenDate) status = "tracking";
  else if (achievedTier) status = "eligible";
  else { status = "tracking"; reasonCodes.push("tier_not_achieved"); }

  const sourceFingerprint = fingerprintEvidence({ rule: rule.sourceSnapshot, customer: customer.id, connector: aggregate.sourceFingerprint });
  const usesAmountPerTonne = rule.todBenefitBasis === "amount_per_eligible_tonne";
  const calculatedDiscount = !achievedTier
    ? decimal(0)
    : usesAmountPerTonne
      ? eligibleTonnes.mul(decimal(achievedTier.amountPerTonne ?? "0"))
      : percentOf(eligibleTaxableValue, achievedTier.percentage ?? "0");
  const result: EvaluationResult = {
    proposal: {
      companyId: rule.companyId, customerId: customer.id, schemeVersionId: rule.id, schemeType: "tod", sourceSalesVoucherId: null,
      periodStart: context.periodStart, periodEnd: context.periodEnd, evaluationDate: context.evaluatedOn, entitlementKey, status,
      sourceFingerprint, customerGroupIdUsed: coverage.coveredGroupId, eligibilityDeadline: reviewOpenDate,
      eligibleProductTaxableValue: money(eligibleTaxableValue, rule.roundingScale, rule.roundingMethod), eligibleTonnes: quantity(eligibleTonnes),
      achievedTierId: achievedTier?.id ?? null, nextTierTonnes: nextTier ? quantity(nextTier.minimumTonnes) : null,
      additionalTonnesRequired: nextTier ? quantity(nonNegative(decimal(nextTier.minimumTonnes).minus(eligibleTonnes))) : null,
      invoiceAmountDue: "0.0000", amountPaidByDeadline: "0.0000", discountedSettlementTarget: "0.0000", shortfallAmount: "0.0000",
      discountPercentage: usesAmountPerTonne ? null : achievedTier?.percentage ?? null,
      calculatedDiscountAmount: money(calculatedDiscount, rule.roundingScale, rule.roundingMethod), postedDiscountAmount: null,
      reasonCodes: [...new Set(reasonCodes)].sort(),
    },
    evaluation: {
      ruleSnapshot: { ...rule.sourceSnapshot, ruleVersionId: rule.id, versionNumber: rule.versionNumber, periodAnchorDate: rule.periodAnchorDate, periodMonths: rule.periodMonths },
      customerGroupSnapshot: { customerId: customer.id, customerGroupId: customer.currentCustomerGroupId, coverageState: coverage.state, groupPath: customer.groupPath },
      calendarSnapshot: rule.reviewCalendar,
      formulaSnapshot: {
        basis: usesAmountPerTonne ? "live_tally_eligible_tonnes" : "live_tally_eligible_product_value_and_tonnes",
        todBenefitBasis: rule.todBenefitBasis,
        achievedTierRatePerMt: usesAmountPerTonne ? achievedTier?.amountPerTonne ?? null : null,
        sourceFingerprint: aggregate.sourceFingerprint,
        chunks: aggregate.chunks,
        vouchersScanned: aggregate.vouchersScanned,
        matchingVouchers: aggregate.matchingVouchers,
        contributionCount: aggregate.contributions.length,
        contributions: aggregate.contributions,
        productContributions: aggregate.productContributions,
        paymentChecks: aggregate.paymentChecks ?? null,
        excludedInvoices: aggregate.excludedInvoices ?? 0,
        rawVouchersStored: false,
      },
      groupMemberships: coverage.memberships.map((membership) => ({ customerId: customer.id, customerGroupId: membership.customerGroupId, isCoveredByRule: rule.selectedCustomerGroupIds.includes(membership.customerGroupId), snapshot: membership })),
      workingDayBreakdown: [], sourceVouchers: [], sourceInventoryLines: [], paymentAllocations: [], priorPeriodAdjustments: [],
    },
    issues,
    hasBlockingIssues: issues.length > 0,
    summary: { schemeType: "tod", outcome: status, eligibleTonnes: quantity(eligibleTonnes), calculatedDiscountAmount: money(calculatedDiscount), source: "live_tally_aggregate" },
  };
  return { context, result };
}
