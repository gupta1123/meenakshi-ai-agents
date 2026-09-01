import { workingDayBreakdown } from "./calendar";
import { parseCashDiscountNarration, voucherNarration } from "./cash-discount-narration";
import type {
  BillAllocationEvidence,
  CustomerEvidence,
  EvaluationIssue,
  EvaluationResult,
  ExistingCreditNoteEvidence,
  FrozenCdRule,
  InventoryLineEvidence,
  ProposalResult,
  VoucherEvidence,
} from "./contracts";
import { decimal, money, nonNegative, percentOf } from "./decimal";
import { fingerprintEvidence } from "./fingerprint";
import { resolveRuleCoverage } from "./groups";

export type CdEvaluationInput = {
  rule: FrozenCdRule;
  customer: CustomerEvidence;
  salesVoucher: VoucherEvidence;
  inventoryLines: InventoryLineEvidence[];
  paymentAllocations: BillAllocationEvidence[];
  existingCreditNotes: ExistingCreditNoteEvidence[];
  evaluatedOn: string;
};

function issue(input: CdEvaluationInput, issueType: EvaluationIssue["issueType"], code: string, details: Record<string, unknown>): EvaluationIssue {
  return {
    issueKey: `cd:${input.rule.companyId}:${input.rule.id}:${input.customer.id}:${input.salesVoucher.id}:${code}`,
    issueType,
    customerId: input.customer.id,
    schemeVersionId: input.rule.id,
    tallyVoucherId: input.salesVoucher.id,
    details,
  };
}

function exactSalesReference(input: CdEvaluationInput, allocation: BillAllocationEvidence) {
  return allocation.targetVoucherId === input.salesVoucher.id
    || (Boolean(input.salesVoucher.voucherNumber) && allocation.targetReference === input.salesVoucher.voucherNumber);
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

export function evaluateCashDiscount(input: CdEvaluationInput): EvaluationResult {
  const { rule, customer, salesVoucher } = input;
  const legacyRule = rule as FrozenCdRule & { discountPercentage?: string; allowedWorkingDays?: number; invoiceTreatment?: string; narrationMode?: string };
  const checkNarration = rule.checkNarration ?? legacyRule.narrationMode !== "disabled";
  const strictNarration = legacyRule.narrationMode === "required";
  const legacyUpfrontTreatment = legacyRule.invoiceTreatment === "deducted_upfront";
  const coverage = resolveRuleCoverage(rule, customer, salesVoucher.voucherDate);
  const orderedSlabs = [...(rule.slabs?.length ? rule.slabs : legacyRule.discountPercentage != null && legacyRule.allowedWorkingDays != null ? [{ id: rule.id, percentage: legacyRule.discountPercentage, allowedWorkingDays: legacyRule.allowedWorkingDays }] : [])].sort((left, right) => left.allowedWorkingDays - right.allowedWorkingDays);
  const finalSlab = orderedSlabs.at(-1);
  if (!finalSlab) throw new Error("The Cash Discount rule has no payment slabs.");
  const workingDays = workingDayBreakdown(rule.calendar, salesVoucher.voucherDate, finalSlab.allowedWorkingDays);
  const deadline = workingDays.find((row) => row.isDeadline)?.businessDate ?? null;
  const issues: EvaluationIssue[] = [];
  const reasonCodes = [...coverage.reasonCodes];
  const narration = parseCashDiscountNarration(voucherNarration(salesVoucher.sourceSnapshot));
  const narrationPercentage = narration.percentage;
  const narrationDays = narration.allowedDays;
  const narrationSlab = narrationPercentage === null || narrationDays === null ? null : orderedSlabs.find((slab) => slab.allowedWorkingDays === narrationDays && decimal(slab.percentage).equals(narrationPercentage));
  const narrationUsesCalendarDays = narration.dayType === "calendar_days";
  const narrationCompleteMatch = narration.mentioned && Boolean(narrationSlab) && !narrationUsesCalendarDays;

  if (checkNarration) {
    if (!narration.mentioned) reasonCodes.push("cash_discount_narration_missing");
    else if (!narrationCompleteMatch) reasonCodes.push("cash_discount_narration_conflict");
    else reasonCodes.push("cash_discount_narration_matches_rule");
  } else {
    reasonCodes.push("cash_discount_narration_check_disabled");
  }
  if (strictNarration && !narrationCompleteMatch) {
    issues.push(issue(input, "other", "cash_discount_narration_conflict", { observed: narration }));
  }

  if (coverage.state === "needs_review") {
    issues.push(issue(input, "ambiguous_group_membership", "customer_group_coverage_unavailable", { groupPath: customer.groupPath }));
  }

  if (salesVoucher.voucherKind !== "sales" || salesVoucher.status !== "posted") {
    issues.push(issue(input, "other", "sales_voucher_not_posted", { voucherKind: salesVoucher.voucherKind, status: salesVoucher.status }));
    reasonCodes.push("sales_voucher_not_posted");
  }
  if (!deadline) {
    issues.push(issue(input, "missing_rule_configuration", "calendar_deadline_unavailable", { calendarId: rule.calendar.id }));
    reasonCodes.push("calendar_deadline_unavailable");
  }

  const eligibleLines = input.inventoryLines.filter((line) => line.voucherId === salesVoucher.id && line.lineCategory === "inventory");
  const unreliableLines = eligibleLines.filter((line) => !line.quantityIsReliable);
  if (unreliableLines.length > 0) {
    issues.push(issue(input, "other", "unreliable_inventory_line", { lineIds: unreliableLines.map((line) => line.id) }));
    reasonCodes.push("unreliable_inventory_line");
  }

  const eligibleValue = eligibleLines
    .filter((line) => line.quantityIsReliable)
    .reduce((total, line) => total.plus(decimal(line.taxableProductValue)), decimal(0));
  const roundedEligibleValue = money(eligibleValue, rule.roundingScale, rule.roundingMethod);
  const invoiceAmountDue = decimal(salesVoucher.grossAmount);
  if (!invoiceAmountDue.greaterThan(0)) {
    issues.push(issue(input, "other", "invoice_amount_due_unavailable", { grossAmount: salesVoucher.grossAmount }));
    reasonCodes.push("invoice_amount_due_unavailable");
  }
  if (!eligibleValue.greaterThan(0)) {
    issues.push(issue(input, "other", "eligible_product_value_zero", { eligibleLineCount: eligibleLines.length }));
    reasonCodes.push("eligible_product_value_zero");
  }

  const allocationEvidence = input.paymentAllocations
    .filter((allocation) => exactSalesReference(input, allocation))
    .sort((left, right) => left.id.localeCompare(right.id));
  const qualifyingAllocations = allocationEvidence.filter((allocation) =>
    allocation.allocationType === "agst_ref"
    && allocation.receiptVoucherStatus === "posted"
    && Boolean(deadline)
    && allocation.receiptVoucherDate <= deadline!,
  );
  const paidByDeadline = qualifyingAllocations.reduce((total, allocation) => total.plus(decimal(allocation.allocatedAmount)), decimal(0));
  const achievedSlab = orderedSlabs.find((slab) => {
    const slabDeadline = workingDayBreakdown(rule.calendar, salesVoucher.voucherDate, slab.allowedWorkingDays).at(-1)?.businessDate;
    if (!slabDeadline) return false;
    const paid = allocationEvidence.filter((allocation) => allocation.allocationType === "agst_ref" && allocation.receiptVoucherStatus === "posted" && allocation.receiptVoucherDate <= slabDeadline).reduce((total, allocation) => total.plus(decimal(allocation.allocatedAmount)), decimal(0));
    return paid.greaterThanOrEqualTo(invoiceAmountDue);
  }) ?? null;
  const discountPercentage = achievedSlab?.percentage ?? finalSlab.percentage;
  const discountAmount = percentOf(eligibleValue, discountPercentage);
  const roundedDiscountAmount = decimal(money(discountAmount, rule.roundingScale, rule.roundingMethod));
  const settlementTarget = invoiceAmountDue;
  const shortfall = nonNegative(settlementTarget.minus(paidByDeadline));
  // The posting record has already matched this exact entitlement key. The
  // fetched Tally voucher is retained as evidence, but its original-invoice
  // link is not required a second time: older Tally exports do not always
  // expose that link on Credit Notes.
  const existingCreditNote = input.existingCreditNotes.find((creditNote) =>
    creditNote.verifiedForProposal && creditNote.status === "posted",
  );

  let status: ProposalResult["status"];
  if (existingCreditNote) {
    status = "already_credited";
    reasonCodes.push("verified_credit_note_exists");
  } else if (issues.length > 0 || coverage.state === "needs_review") {
    status = "needs_review";
  } else if (coverage.state === "not_in_scheme") {
    status = "not_in_scheme";
  } else if (achievedSlab) {
    status = "eligible";
  } else if (deadline && input.evaluatedOn > deadline) {
    status = "deadline_expired";
    reasonCodes.push("payment_deadline_expired");
  } else if (paidByDeadline.greaterThanOrEqualTo(percentOf(invoiceAmountDue, rule.nearEligibilityPercent))) {
    status = "near_eligibility";
    reasonCodes.push("at_least_80_percent_of_invoice_due");
  } else if (paidByDeadline.isZero()) {
    status = "unpaid";
  } else {
    status = "partially_paid";
  }

  const deadlineExpired = Boolean(deadline && input.evaluatedOn > deadline);
  // A customer does not need to be near the 80% threshold to receive a
  // Cash Discount reminder.  The agreed policy is to remind every covered,
  // open invoice before its final payment deadline.  Consent, an approved
  // template and duplicate-send protection are enforced separately by the
  // notification queue.
  const isOpenReminderCandidate = ["unpaid", "partially_paid", "near_eligibility"].includes(status)
    && !deadlineExpired
    && decimal(shortfall).greaterThan(0);
  const recommendedAction = issues.length > 0
    ? "finance_review"
    : status === "eligible"
      ? "none"
      : isOpenReminderCandidate
        ? "send_shortfall_reminder"
        : deadlineExpired
          ? "debit_note"
          : status === "already_credited" || status === "not_in_scheme"
            ? "none"
            : "keep_tracking";
  reasonCodes.push(`recommended_action_${recommendedAction}`);

  const sourceFingerprint = fingerprintEvidence({
    rule: { id: rule.id, versionNumber: rule.versionNumber, source: rule.sourceSnapshot, calendar: rule.calendar },
    customer: { id: customer.id, currentCustomerGroupId: customer.currentCustomerGroupId, groupPath: customer.groupPath },
    salesVoucher: snapshotVoucher(salesVoucher),
    inventoryLines: eligibleLines.sort((left, right) => left.id.localeCompare(right.id)),
    paymentAllocations: allocationEvidence,
    existingCreditNote: existingCreditNote ? snapshotVoucher(existingCreditNote) : null,
  });

  const proposal: ProposalResult = {
    companyId: rule.companyId,
    customerId: customer.id,
    schemeVersionId: rule.id,
    schemeType: "cd",
    sourceSalesVoucherId: salesVoucher.id,
    periodStart: salesVoucher.voucherDate,
    periodEnd: salesVoucher.voucherDate,
    evaluationDate: input.evaluatedOn,
    entitlementKey: `cd:${rule.companyId}:${customer.id}:${salesVoucher.id}:${rule.id}`,
    status,
    sourceFingerprint,
    customerGroupIdUsed: coverage.coveredGroupId,
    eligibilityDeadline: deadline,
    eligibleProductTaxableValue: roundedEligibleValue,
    eligibleTonnes: "0.000000",
    achievedTierId: null,
    nextTierTonnes: null,
    additionalTonnesRequired: null,
    invoiceAmountDue: money(invoiceAmountDue),
    amountPaidByDeadline: money(paidByDeadline),
    discountedSettlementTarget: money(settlementTarget),
    shortfallAmount: money(shortfall),
    discountPercentage,
    calculatedDiscountAmount: money(roundedDiscountAmount, rule.roundingScale, rule.roundingMethod),
    postedDiscountAmount: null,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    recommendedAction,
  };

  return {
    proposal,
    evaluation: {
      ruleSnapshot: { ...rule.sourceSnapshot, ruleVersionId: rule.id, versionNumber: rule.versionNumber, slabs: orderedSlabs, checkNarration },
      customerGroupSnapshot: { customerId: customer.id, customerGroupId: customer.currentCustomerGroupId, coverageState: coverage.state, groupPath: customer.groupPath },
      calendarSnapshot: { calendarId: rule.calendar.id, revision: rule.calendar.revision, nonWorkingIsoWeekdays: rule.calendar.nonWorkingIsoWeekdays, activeHolidayDates: rule.calendar.activeHolidayDates },
      formulaSnapshot: {
        basis: "eligible_product_taxable_value_before_gst",
        roundingMethod: rule.roundingMethod,
        roundingScale: rule.roundingScale,
        slabs: rule.slabs,
        nearEligibilityPercent: rule.nearEligibilityPercent,
        narrationVerification: { enabled: checkNarration, observed: narration, matched: narrationCompleteMatch },
        recommendedAction,
        paymentRule: "posted_receipt_agst_ref_exact_sales_reference_on_or_before_deadline",
      },
      groupMemberships: coverage.memberships.map((membership) => ({
        customerId: customer.id,
        customerGroupId: membership.customerGroupId,
        isCoveredByRule: rule.selectedCustomerGroupIds.includes(membership.customerGroupId),
        snapshot: membership,
      })),
      workingDayBreakdown: workingDays,
      sourceVouchers: [
        { tallyVoucherId: salesVoucher.id, contributionType: "sale", taxableValueContribution: roundedEligibleValue, tonneContribution: "0.000000", snapshot: snapshotVoucher(salesVoucher) },
        ...[...new Map(qualifyingAllocations.map((allocation) => [allocation.sourceVoucherId, allocation])).values()].map((allocation) => ({
          tallyVoucherId: allocation.sourceVoucherId,
          contributionType: "payment_evidence" as const,
          taxableValueContribution: "0.0000",
          tonneContribution: "0.000000",
          snapshot: allocation.sourceSnapshot,
        })),
        ...(existingCreditNote ? [{ tallyVoucherId: existingCreditNote.id, contributionType: "existing_credit_note" as const, taxableValueContribution: "0.0000", tonneContribution: "0.000000", snapshot: snapshotVoucher(existingCreditNote) }] : []),
      ],
      sourceInventoryLines: eligibleLines.map((line) => ({
        tallyVoucherInventoryLineId: line.id,
        tonnesPerSourceUnit: null,
        eligibleQuantity: "0.000000",
        eligibleTonnes: "0.000000",
        eligibleTaxableValue: line.quantityIsReliable ? money(line.taxableProductValue, rule.roundingScale, rule.roundingMethod) : "0.0000",
        contributionSign: 1 as const,
        blockingReason: line.quantityIsReliable ? null : "quantity_unreliable",
      })),
      paymentAllocations: allocationEvidence.map((allocation) => ({
        tallyBillAllocationId: allocation.id,
        receiptVoucherDate: allocation.receiptVoucherDate,
        allocatedAmount: money(allocation.allocatedAmount),
        countsForCd: qualifyingAllocations.some((qualified) => qualified.id === allocation.id),
        snapshot: allocation.sourceSnapshot,
      })),
      priorPeriodAdjustments: [],
    },
    issues,
    hasBlockingIssues: issues.length > 0 || coverage.state === "needs_review",
    summary: {
      schemeType: "cd",
      outcome: status,
      invoiceReference: salesVoucher.voucherNumber,
      eligibilityDeadline: deadline,
      amountPaidByDeadline: money(paidByDeadline),
      discountedSettlementTarget: money(settlementTarget),
      shortfallAmount: money(shortfall),
      recommendedAction,
    },
  };
}
