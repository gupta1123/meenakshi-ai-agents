import { firstWorkingDayAfter } from "./calendar";
import type {
  CustomerEvidence,
  EvaluationIssue,
  EvaluationResult,
  ExistingCreditNoteEvidence,
  FrozenTodRule,
  InventoryLineEvidence,
  ProposalResult,
  VoucherEvidence,
} from "./contracts";
import { decimal, money, nonNegative, percentOf, quantity } from "./decimal";
import { fingerprintEvidence } from "./fingerprint";
import { resolveRuleCoverage } from "./groups";

export type PriorPeriodAdjustmentEvidence = {
  voucher: VoucherEvidence;
  originalPeriodStart: string;
  originalPeriodEnd: string;
  taxableValueAdjustment: string;
  tonneAdjustment: string;
  reason: string;
};

export type TodEvaluationInput = {
  rule: FrozenTodRule;
  customer: CustomerEvidence;
  periodStart: string;
  periodEnd: string;
  // Once a TOD customer-period has been evaluated, its rule version is
  // immutable. A later group move must not retroactively disqualify it.
  lockedPeriod?: boolean;
  vouchers: VoucherEvidence[];
  inventoryLines: InventoryLineEvidence[];
  existingCreditNotes: ExistingCreditNoteEvidence[];
  priorPeriodAdjustments: PriorPeriodAdjustmentEvidence[];
  evaluatedOn: string;
};

type CandidateLine = {
  line: InventoryLineEvidence;
  voucher: VoucherEvidence;
  sign: -1 | 1;
  conversion: string | null;
  blockingReason: string | null;
};

function issue(input: TodEvaluationInput, issueType: EvaluationIssue["issueType"], code: string, details: Record<string, unknown>, tallyVoucherId?: string): EvaluationIssue {
  return {
    issueKey: `tod:${input.rule.companyId}:${input.rule.id}:${input.customer.id}:${input.periodStart}:${code}${tallyVoucherId ? `:${tallyVoucherId}` : ""}`,
    issueType,
    customerId: input.customer.id,
    schemeVersionId: input.rule.id,
    ...(tallyVoucherId ? { tallyVoucherId } : {}),
    details,
  };
}

function snapshotVoucher(voucher: VoucherEvidence) {
  return {
    tallyGuid: voucher.tallyGuid,
    tallyMasterId: voucher.tallyMasterId,
    tallyAlterId: voucher.tallyAlterId,
    voucherNumber: voucher.voucherNumber,
    voucherKind: voucher.voucherKind,
    voucherDate: voucher.voucherDate,
    status: voucher.status,
    linkedSalesVoucherId: voucher.linkedSalesVoucherId,
    source: voucher.sourceSnapshot,
  };
}

function selectedLine(rule: FrozenTodRule, line: InventoryLineEvidence) {
  return (line.stockItemId !== null && rule.selectedStockItemIds.includes(line.stockItemId))
    || (line.stockGroupId !== null && rule.selectedStockGroupIds.includes(line.stockGroupId));
}

function contributionSign(voucher: VoucherEvidence): -1 | 1 | null {
  if (voucher.voucherKind === "sales") return 1;
  if (voucher.voucherKind === "sales_return") return -1;
  if (voucher.voucherKind === "debit_note" && voucher.linkedSalesVoucherId) return 1;
  return null;
}

function relevantVoucher(input: TodEvaluationInput, voucher: VoucherEvidence) {
  return voucher.partyCustomerId === input.customer.id
    && voucher.status === "posted"
    && voucher.voucherDate >= input.periodStart
    && voucher.voucherDate <= input.periodEnd
    && contributionSign(voucher) !== null;
}

export function evaluateTurnoverDiscount(input: TodEvaluationInput): EvaluationResult {
  const { rule, customer } = input;
  const currentCoverage = resolveRuleCoverage(rule, customer, input.periodStart);
  const coverage = input.lockedPeriod && currentCoverage.state === "not_in_scheme"
    ? { ...currentCoverage, state: "covered" as const }
    : currentCoverage;
  const issues: EvaluationIssue[] = [];
  const reasonCodes = [...coverage.reasonCodes];
  const vouchersById = new Map(input.vouchers.map((voucher) => [voucher.id, voucher]));
  const conversionByUom = new Map<string, string[]>();
  for (const conversion of rule.unitConversions) {
    conversionByUom.set(conversion.sourceUomId, [...(conversionByUom.get(conversion.sourceUomId) ?? []), conversion.tonnesPerUnit]);
  }

  const candidates: CandidateLine[] = input.inventoryLines
    .map((line) => ({ line, voucher: vouchersById.get(line.voucherId) }))
    .filter((entry): entry is { line: InventoryLineEvidence; voucher: VoucherEvidence } => Boolean(entry.voucher))
    .filter(({ line, voucher }) => relevantVoucher(input, voucher) && line.lineCategory === "inventory" && selectedLine(rule, line))
    .map(({ line, voucher }) => {
      const sign = contributionSign(voucher)!;
      if (!line.quantityIsReliable) return { line, voucher, sign, conversion: null, blockingReason: "quantity_unreliable" };
      if (!line.sourceUomId) return { line, voucher, sign, conversion: null, blockingReason: "source_uom_missing" };
      const matches = conversionByUom.get(line.sourceUomId) ?? [];
      if (matches.length !== 1) return { line, voucher, sign, conversion: null, blockingReason: matches.length === 0 ? "approved_conversion_missing" : "approved_conversion_ambiguous" };
      return { line, voucher, sign, conversion: matches[0], blockingReason: null };
    });

  for (const candidate of candidates.filter((candidate) => candidate.blockingReason)) {
    issues.push(issue(input, "missing_unit_conversion", candidate.blockingReason!, {
      lineId: candidate.line.id,
      sourceUomId: candidate.line.sourceUomId,
      sourceUomCode: candidate.line.sourceUomCode,
      voucherKind: candidate.voucher.voucherKind,
    }, candidate.voucher.id));
    reasonCodes.push(candidate.blockingReason!);
  }

  if (coverage.state === "needs_review") {
    issues.push(issue(input, "ambiguous_group_membership", "customer_group_coverage_unavailable", { groupPath: customer.groupPath }));
  }

  const positiveCandidates = candidates.filter((candidate) => !candidate.blockingReason && candidate.conversion !== null);
  const candidateIdsByVoucher = new Map<string, CandidateLine[]>();
  for (const candidate of positiveCandidates) {
    candidateIdsByVoucher.set(candidate.voucher.id, [...(candidateIdsByVoucher.get(candidate.voucher.id) ?? []), candidate]);
  }
  const resolvedPriorAdjustments = input.priorPeriodAdjustments.map((adjustment) => {
    const sourceCandidates = candidateIdsByVoucher.get(adjustment.voucher.id) ?? [];
    // A late return/Debit Note is still present in this period's normalized
    // Tally evidence. Use that value once, and preserve the prior-period
    // label for audit rather than adding the same adjustment twice.
    const taxableValueAdjustment = sourceCandidates.length > 0
      ? sourceCandidates.reduce((total, candidate) => total.plus(decimal(candidate.line.taxableProductValue).mul(candidate.sign)), decimal(0))
      : decimal(adjustment.taxableValueAdjustment);
    const tonneAdjustment = sourceCandidates.length > 0
      ? sourceCandidates.reduce((total, candidate) => total.plus(decimal(candidate.line.quantity).mul(candidate.conversion!).mul(candidate.sign)), decimal(0))
      : decimal(adjustment.tonneAdjustment);
    return { ...adjustment, taxableValueAdjustment: taxableValueAdjustment.toFixed(), tonneAdjustment: tonneAdjustment.toFixed(), isPresentInCurrentEvidence: sourceCandidates.length > 0 };
  });
  const netTaxableValue = positiveCandidates.reduce(
    (total, candidate) => total.plus(decimal(candidate.line.taxableProductValue).mul(candidate.sign)),
    decimal(0),
  );
  const netTonnes = positiveCandidates.reduce(
    (total, candidate) => total.plus(decimal(candidate.line.quantity).mul(candidate.conversion!).mul(candidate.sign)),
    decimal(0),
  );
  const priorTaxableAdjustment = resolvedPriorAdjustments
    .filter((adjustment) => !adjustment.isPresentInCurrentEvidence)
    .reduce((total, adjustment) => total.plus(decimal(adjustment.taxableValueAdjustment)), decimal(0));
  const priorTonneAdjustment = resolvedPriorAdjustments
    .filter((adjustment) => !adjustment.isPresentInCurrentEvidence)
    .reduce((total, adjustment) => total.plus(decimal(adjustment.tonneAdjustment)), decimal(0));
  const eligibleTaxableValue = nonNegative(netTaxableValue.plus(priorTaxableAdjustment));
  const eligibleTonnes = nonNegative(netTonnes.plus(priorTonneAdjustment));
  const achievedTier = [...rule.tiers]
    .sort((left, right) => decimal(left.minimumTonnes).comparedTo(decimal(right.minimumTonnes)))
    .filter((tier) => eligibleTonnes.greaterThanOrEqualTo(decimal(tier.minimumTonnes)))
    .at(-1) ?? null;
  const nextTier = [...rule.tiers]
    .sort((left, right) => decimal(left.minimumTonnes).comparedTo(decimal(right.minimumTonnes)))
    .find((tier) => decimal(tier.minimumTonnes).greaterThan(eligibleTonnes)) ?? null;

  if (rule.tiers.length === 0 || (rule.selectedStockItemIds.length === 0 && rule.selectedStockGroupIds.length === 0)) {
    issues.push(issue(input, "missing_rule_configuration", "tod_rule_configuration_missing", { tierCount: rule.tiers.length, stockItemCount: rule.selectedStockItemIds.length, stockGroupCount: rule.selectedStockGroupIds.length }));
    reasonCodes.push("tod_rule_configuration_missing");
  }
  if (!rule.reviewCalendar) {
    issues.push(issue(input, "missing_rule_configuration", "tod_review_calendar_missing", { message: "A TOD review calendar must be selected before evaluation can open review." }));
    reasonCodes.push("tod_review_calendar_missing");
  }

  const reviewOpenDate = rule.reviewCalendar ? firstWorkingDayAfter(rule.reviewCalendar, input.periodEnd) : null;
  const existingCreditNote = input.existingCreditNotes.find((creditNote) => creditNote.verifiedForProposal && creditNote.status === "posted");
  const discountPercentage = achievedTier?.percentage ?? null;
  const calculatedDiscount = achievedTier ? percentOf(eligibleTaxableValue, achievedTier.percentage) : decimal(0);

  let status: ProposalResult["status"];
  if (existingCreditNote) {
    status = "already_credited";
    reasonCodes.push("verified_credit_note_exists");
  } else if (issues.length > 0 || coverage.state === "needs_review") {
    status = "needs_review";
  } else if (coverage.state === "not_in_scheme") {
    status = "not_in_scheme";
  } else if (!reviewOpenDate || input.evaluatedOn < reviewOpenDate) {
    status = "tracking";
  } else if (achievedTier) {
    status = "eligible";
  } else {
    status = "tracking";
    reasonCodes.push("tier_not_achieved");
  }

  const sourceFingerprint = fingerprintEvidence({
    rule: { id: rule.id, versionNumber: rule.versionNumber, source: rule.sourceSnapshot, periodAnchorDate: rule.periodAnchorDate, periodMonths: rule.periodMonths, reviewCalendar: rule.reviewCalendar },
    customer: { id: customer.id, currentCustomerGroupId: customer.currentCustomerGroupId, groupPath: customer.groupPath },
    period: { start: input.periodStart, end: input.periodEnd },
    vouchers: input.vouchers.filter((voucher) => relevantVoucher(input, voucher)).sort((left, right) => left.id.localeCompare(right.id)).map(snapshotVoucher),
    candidates: candidates.sort((left, right) => left.line.id.localeCompare(right.line.id)),
    priorPeriodAdjustments: resolvedPriorAdjustments.map((adjustment) => ({ ...adjustment, voucher: snapshotVoucher(adjustment.voucher) })),
    existingCreditNote: existingCreditNote ? snapshotVoucher(existingCreditNote) : null,
  });

  const proposal: ProposalResult = {
    companyId: rule.companyId,
    customerId: customer.id,
    schemeVersionId: rule.id,
    schemeType: "tod",
    sourceSalesVoucherId: null,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    evaluationDate: input.evaluatedOn,
    entitlementKey: `tod:${rule.companyId}:${customer.id}:${input.periodStart}:${input.periodEnd}:${rule.id}`,
    status,
    sourceFingerprint,
    customerGroupIdUsed: coverage.coveredGroupId,
    eligibilityDeadline: reviewOpenDate,
    eligibleProductTaxableValue: money(eligibleTaxableValue, rule.roundingScale, rule.roundingMethod),
    eligibleTonnes: quantity(eligibleTonnes),
    achievedTierId: achievedTier?.id ?? null,
    nextTierTonnes: nextTier ? quantity(nextTier.minimumTonnes) : null,
    additionalTonnesRequired: nextTier ? quantity(nonNegative(decimal(nextTier.minimumTonnes).minus(eligibleTonnes))) : null,
    invoiceAmountDue: "0.0000",
    amountPaidByDeadline: "0.0000",
    discountedSettlementTarget: "0.0000",
    shortfallAmount: "0.0000",
    discountPercentage,
    calculatedDiscountAmount: money(calculatedDiscount, rule.roundingScale, rule.roundingMethod),
    postedDiscountAmount: null,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };

  const sourceVouchers = new Map<string, { tallyVoucherId: string; contributionType: "sale" | "sales_return" | "debit_note" | "prior_period_adjustment" | "existing_credit_note"; taxableValueContribution: string; tonneContribution: string; snapshot: Record<string, unknown> }>();
  const adjustmentByVoucherId = new Map(resolvedPriorAdjustments.map((adjustment) => [adjustment.voucher.id, adjustment]));
  for (const candidate of positiveCandidates) {
    const contributionType = adjustmentByVoucherId.has(candidate.voucher.id)
      ? "prior_period_adjustment"
      : candidate.voucher.voucherKind === "sales" ? "sale" : candidate.voucher.voucherKind === "sales_return" ? "sales_return" : "debit_note";
    const existing = sourceVouchers.get(candidate.voucher.id);
    const taxableValue = decimal(candidate.line.taxableProductValue).mul(candidate.sign);
    const tonnes = decimal(candidate.line.quantity).mul(candidate.conversion!).mul(candidate.sign);
    sourceVouchers.set(candidate.voucher.id, {
      tallyVoucherId: candidate.voucher.id,
      contributionType,
      taxableValueContribution: money((existing ? decimal(existing.taxableValueContribution) : decimal(0)).plus(taxableValue)),
      tonneContribution: quantity((existing ? decimal(existing.tonneContribution) : decimal(0)).plus(tonnes)),
      snapshot: snapshotVoucher(candidate.voucher),
    });
  }
  for (const adjustment of resolvedPriorAdjustments.filter((item) => !item.isPresentInCurrentEvidence)) {
    sourceVouchers.set(`adjustment:${adjustment.voucher.id}`, {
      tallyVoucherId: adjustment.voucher.id,
      contributionType: "prior_period_adjustment",
      taxableValueContribution: money(adjustment.taxableValueAdjustment),
      tonneContribution: quantity(adjustment.tonneAdjustment),
      snapshot: snapshotVoucher(adjustment.voucher),
    });
  }
  if (existingCreditNote) {
    sourceVouchers.set(`credit-note:${existingCreditNote.id}`, {
      tallyVoucherId: existingCreditNote.id,
      contributionType: "existing_credit_note",
      taxableValueContribution: "0.0000",
      tonneContribution: "0.000000",
      snapshot: snapshotVoucher(existingCreditNote),
    });
  }

  return {
    proposal,
    evaluation: {
      ruleSnapshot: { ...rule.sourceSnapshot, ruleVersionId: rule.id, versionNumber: rule.versionNumber, periodAnchorDate: rule.periodAnchorDate, periodMonths: rule.periodMonths },
      customerGroupSnapshot: { customerId: customer.id, customerGroupId: customer.currentCustomerGroupId, coverageState: coverage.state, groupPath: customer.groupPath },
      calendarSnapshot: rule.reviewCalendar ? { calendarId: rule.reviewCalendar.id, revision: rule.reviewCalendar.revision, nonWorkingIsoWeekdays: rule.reviewCalendar.nonWorkingIsoWeekdays, activeHolidayDates: rule.reviewCalendar.activeHolidayDates } : null,
      formulaSnapshot: {
        basis: "eligible_product_taxable_value_before_gst",
        roundingMethod: rule.roundingMethod,
        roundingScale: rule.roundingScale,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        reviewOpenDate,
        tierRule: "highest_achieved_rate_applies_to_full_net_eligible_value",
      },
      groupMemberships: coverage.memberships.map((membership) => ({
        customerId: customer.id,
        customerGroupId: membership.customerGroupId,
        isCoveredByRule: rule.selectedCustomerGroupIds.includes(membership.customerGroupId),
        snapshot: membership,
      })),
      workingDayBreakdown: [],
      sourceVouchers: [...sourceVouchers.values()],
      sourceInventoryLines: candidates.map((candidate) => ({
        tallyVoucherInventoryLineId: candidate.line.id,
        tonnesPerSourceUnit: candidate.conversion,
        eligibleQuantity: quantity(candidate.line.quantity),
        eligibleTonnes: candidate.conversion ? quantity(decimal(candidate.line.quantity).mul(candidate.conversion)) : "0.000000",
        eligibleTaxableValue: money(candidate.line.taxableProductValue, rule.roundingScale, rule.roundingMethod),
        contributionSign: candidate.sign,
        blockingReason: candidate.blockingReason,
      })),
      paymentAllocations: [],
      priorPeriodAdjustments: resolvedPriorAdjustments.map((adjustment) => ({
        tallyVoucherId: adjustment.voucher.id,
        originalPeriodStart: adjustment.originalPeriodStart,
        originalPeriodEnd: adjustment.originalPeriodEnd,
        taxableValueAdjustment: money(adjustment.taxableValueAdjustment, rule.roundingScale, rule.roundingMethod),
        tonneAdjustment: quantity(adjustment.tonneAdjustment),
        reason: adjustment.reason,
      })),
    },
    issues,
    hasBlockingIssues: issues.length > 0 || coverage.state === "needs_review",
    summary: {
      schemeType: "tod",
      outcome: status,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      reviewOpenDate,
      eligibleTonnes: quantity(eligibleTonnes),
      achievedTierId: achievedTier?.id ?? null,
      calculatedDiscountAmount: money(calculatedDiscount, rule.roundingScale, rule.roundingMethod),
    },
  };
}
