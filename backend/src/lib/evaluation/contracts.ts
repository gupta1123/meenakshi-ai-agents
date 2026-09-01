export type EvaluationSchemeType = "cd" | "tod";
export type DecimalString = string;
export type IsoDate = string;

export type ProposalStatus =
  | "tracking"
  | "near_eligibility"
  | "partially_paid"
  | "unpaid"
  | "eligible"
  | "needs_review"
  | "deadline_expired"
  | "not_in_scheme"
  | "already_credited";

export type ProcessingIssueType =
  | "wrong_tally_company"
  | "tally_unavailable"
  | "configured_group_unavailable"
  | "ambiguous_group_membership"
  | "no_active_rule"
  | "missing_rule_configuration"
  | "missing_against_reference"
  | "ambiguous_payment_allocation"
  | "missing_unit_conversion"
  | "source_changed_after_review"
  | "possible_duplicate_credit_note"
  | "posting_verification_failed"
  | "other";

export type RoundingMethod = "half_up" | "half_even" | "truncate";
export type CdRecommendedAction = "credit_note" | "debit_note" | "collect_balance" | "send_shortfall_reminder" | "keep_tracking" | "finance_review" | "none";

export type CdSlab = {
  id: string;
  allowedWorkingDays: number;
  percentage: DecimalString;
};

export type WorkingCalendar = {
  id: string;
  revision: number;
  nonWorkingIsoWeekdays: number[];
  activeHolidayDates: IsoDate[];
};

export type WorkingDayBreakdown = {
  businessDate: IsoDate;
  isWorkingDay: boolean;
  countedWorkingDay: number;
  exclusionReason: "invoice_day_zero" | "holiday" | "weekly_holiday" | null;
  isDeadline: boolean;
};

export type CustomerGroupMembership = {
  customerId: string;
  customerGroupId: string;
  groupName: string;
  tallyGuid: string;
  isAvailable: boolean;
  parentGroupId: string | null;
};

export type CustomerEvidence = {
  id: string;
  tallyLedgerGuid: string;
  ledgerName: string;
  isAvailable: boolean;
  currentCustomerGroupId: string | null;
  groupPath: CustomerGroupMembership[];
};

export type VoucherEvidence = {
  id: string;
  tallyGuid: string;
  tallyMasterId: string | null;
  tallyAlterId: string | null;
  voucherNumber: string | null;
  voucherKind: "sales" | "receipt" | "sales_return" | "debit_note" | "credit_note" | "other";
  voucherDate: IsoDate;
  status: "posted" | "cancelled" | "optional" | "reversed";
  partyCustomerId: string | null;
  linkedSalesVoucherId: string | null;
  taxableProductValue: DecimalString;
  grossAmount: DecimalString;
  sourceSnapshot: Record<string, unknown>;
};

export type InventoryLineEvidence = {
  id: string;
  voucherId: string;
  lineNumber: number;
  stockItemId: string | null;
  stockGroupId: string | null;
  sourceUomId: string | null;
  sourceUomCode: string | null;
  quantity: DecimalString;
  taxableProductValue: DecimalString;
  freightValue: DecimalString;
  nonProductValue: DecimalString;
  lineCategory: "inventory" | "freight" | "non_product" | "other";
  quantityIsReliable: boolean;
  sourceSnapshot: Record<string, unknown>;
};

export type BillAllocationEvidence = {
  id: string;
  sourceVoucherId: string;
  targetVoucherId: string | null;
  targetReference: string | null;
  allocationType: "agst_ref" | "new_ref" | "on_account" | "advance" | "other";
  allocatedAmount: DecimalString;
  receiptVoucherDate: IsoDate;
  receiptVoucherStatus: VoucherEvidence["status"];
  sourceSnapshot: Record<string, unknown>;
};

export type Tier = {
  id: string;
  minimumTonnes: DecimalString;
  percentage: DecimalString;
};

export type UnitConversion = {
  id: string;
  sourceUomId: string;
  tonnesPerUnit: DecimalString;
};

export type FrozenRuleBase = {
  id: string;
  schemeId: string;
  companyId: string;
  schemeType: EvaluationSchemeType;
  versionNumber: number;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  roundingMethod: RoundingMethod;
  roundingScale: number;
  selectedCustomerGroupIds: string[];
  sourceSnapshot: Record<string, unknown>;
};

export type FrozenCdRule = FrozenRuleBase & {
  schemeType: "cd";
  slabs: CdSlab[];
  nearEligibilityPercent: DecimalString;
  checkNarration: boolean;
  narrationMode: "informational" | "required" | "disabled";
  calendar: WorkingCalendar;
};

export type FrozenTodRule = FrozenRuleBase & {
  schemeType: "tod";
  periodAnchorDate: IsoDate;
  periodMonths: number;
  selectedStockItemIds: string[];
  selectedStockGroupIds: string[];
  unitConversions: UnitConversion[];
  tiers: Tier[];
  reviewCalendar: WorkingCalendar | null;
};

export type ExistingCreditNoteEvidence = VoucherEvidence & {
  verifiedForProposal: boolean;
};

export type EvaluationIssue = {
  issueKey: string;
  issueType: ProcessingIssueType;
  customerId?: string;
  schemeVersionId?: string;
  tallyVoucherId?: string;
  details: Record<string, unknown>;
};

export type ProposalResult = {
  companyId: string;
  customerId: string;
  schemeVersionId: string;
  schemeType: EvaluationSchemeType;
  sourceSalesVoucherId: string | null;
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  evaluationDate: IsoDate;
  entitlementKey: string;
  status: ProposalStatus;
  sourceFingerprint: string;
  customerGroupIdUsed: string | null;
  eligibilityDeadline: IsoDate | null;
  eligibleProductTaxableValue: DecimalString;
  eligibleTonnes: DecimalString;
  achievedTierId: string | null;
  nextTierTonnes: DecimalString | null;
  additionalTonnesRequired: DecimalString | null;
  invoiceAmountDue: DecimalString;
  amountPaidByDeadline: DecimalString;
  discountedSettlementTarget: DecimalString;
  shortfallAmount: DecimalString;
  discountPercentage: DecimalString | null;
  calculatedDiscountAmount: DecimalString;
  postedDiscountAmount: DecimalString | null;
  reasonCodes: string[];
  recommendedAction?: CdRecommendedAction;
};

export type EvaluationEvidenceSnapshot = {
  ruleSnapshot: Record<string, unknown>;
  customerGroupSnapshot: Record<string, unknown>;
  calendarSnapshot: Record<string, unknown> | null;
  formulaSnapshot: Record<string, unknown>;
  groupMemberships: Array<{
    customerId: string;
    customerGroupId: string;
    isCoveredByRule: boolean;
    snapshot: Record<string, unknown>;
  }>;
  workingDayBreakdown: WorkingDayBreakdown[];
  sourceVouchers: Array<{
    tallyVoucherId: string;
    contributionType: "sale" | "sales_return" | "debit_note" | "prior_period_adjustment" | "payment_evidence" | "existing_credit_note";
    taxableValueContribution: DecimalString;
    tonneContribution: DecimalString;
    snapshot: Record<string, unknown>;
  }>;
  sourceInventoryLines: Array<{
    tallyVoucherInventoryLineId: string;
    tonnesPerSourceUnit: DecimalString | null;
    eligibleQuantity: DecimalString;
    eligibleTonnes: DecimalString;
    eligibleTaxableValue: DecimalString;
    contributionSign: -1 | 1;
    blockingReason: string | null;
  }>;
  paymentAllocations: Array<{
    tallyBillAllocationId: string;
    receiptVoucherDate: IsoDate;
    allocatedAmount: DecimalString;
    countsForCd: boolean;
    snapshot: Record<string, unknown>;
  }>;
  priorPeriodAdjustments: Array<{
    tallyVoucherId: string;
    originalPeriodStart: IsoDate;
    originalPeriodEnd: IsoDate;
    taxableValueAdjustment: DecimalString;
    tonneAdjustment: DecimalString;
    reason: string;
  }>;
};

export type EvaluationResult = {
  proposal: ProposalResult | null;
  evaluation: EvaluationEvidenceSnapshot;
  issues: EvaluationIssue[];
  hasBlockingIssues: boolean;
  summary: Record<string, unknown>;
};
