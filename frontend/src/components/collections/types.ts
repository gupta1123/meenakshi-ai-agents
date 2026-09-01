export type Company = {
  id: string;
  code: string;
  tally_company_name: string;
  tally_company_guid: string;
};

export type Organization = {
  id: string;
  code: string;
  name: string;
  roles: string[];
  companies: Company[];
};

export type Bootstrap = { organizations: Organization[] };

export type CollectionsPage =
  | "control-centre"
  | "cash-discount"
  | "turnover-discount"
  | "credit-notes"
  | "messages"
  | "rulebook"
  | "tally";

export type TallyHealth = {
  status: string;
  ready: boolean;
  companyId: string;
  connector?: { id: string; displayName: string; bridgeVersion: string | null; lastHeartbeatAt: string | null };
  binding?: { id: string; expectedCompanyName: string; observedCompanyName: string | null; lastValidatedAt: string | null; lastMismatchAt: string | null };
  sync?: {
    masters: { status: string; completedAt: string | null; stale: boolean; errorSummary: string | null };
    vouchers: { status: string; completedAt: string | null; stale: boolean; errorSummary: string | null };
  };
};

export type Master = {
  id: string;
  name?: string;
  ledger_name?: string;
  code?: string;
  is_available: boolean;
  is_credit_note_type?: boolean;
  gst_applicability?: string | null;
  parent_group_name?: string | null;
  parent_group_id?: string | null;
  current_customer_group_id?: string | null;
  current_stock_group_id?: string | null;
  default_uom_id?: string | null;
};

export type ReferenceData = {
  masterSync: { status: string; completedAt: string | null; stale: boolean; errorSummary: string | null };
  masters: {
    customerGroups: Master[];
    customers: Master[];
    stockGroups: Master[];
    stockItems: Master[];
    units: Master[];
    voucherTypes: Master[];
    ledgers: Master[];
  };
};

export type Proposal = {
  id: string;
  customer_id: string;
  customer_name?: string | null;
  scheme_type: "cd" | "tod";
  status: string;
  period_start: string | null;
  period_end: string | null;
  eligibility_deadline: string | null;
  calculated_discount_amount: string;
  scheme_version_id?: string;
  source_sales_voucher_id?: string | null;
  entitlement_key?: string;
  eligible_product_taxable_value?: string | null;
  achieved_tier_id?: string | null;
  next_tier_tonnes?: string | null;
  additional_tonnes_required?: string | null;
  invoice_amount_due?: string | null;
  amount_paid_by_deadline?: string | null;
  discounted_settlement_target?: string | null;
  discount_percentage?: string | null;
  eligible_tonnes?: string | null;
  shortfall_amount?: string | null;
  latest_evaluated_at: string | null;
  reason_codes: string[];
  latestEvaluation: { id: string; evaluated_at: string; freshForApproval: boolean } | null;
  creditNotePosting: {
    id: string;
    status: string;
    discount_amount: string;
    credit_note_date: string;
    verified_voucher_number: string | null;
    verified_at: string | null;
    failure_reason: string | null;
    reconciliation_reason?: string | null;
    last_reconciled_at?: string | null;
  } | null;
};

export type CreditNotePosting = {
  id: string;
  proposal_id: string;
  customer_id: string;
  status: string;
  credit_note_date: string;
  discount_amount: string;
  calculation_reference?: string | null;
  bill_allocation_type?: string | null;
  tally_bill_reference?: string | null;
  verified_tally_guid?: string | null;
  verified_voucher_number: string | null;
  verified_amount?: string | null;
  verified_at: string | null;
  failure_reason: string | null;
  reconciliation_reason?: string | null;
  last_reconciled_at?: string | null;
  updated_at: string;
};

export type NotificationMessage = {
  id: string;
  proposal_id: string | null;
  credit_note_posting_id: string | null;
  event_type: string;
  recipient_phone_e164: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  resend_of_notification_id: string | null;
  resend_reason: string | null;
  sent_at: string | null;
  failure_reason: string | null;
  created_at: string;
  opt_in_snapshot?: Record<string, unknown>;
};

export type NotificationHealth = { counts: Record<string, number>; retrying: number; terminalFailures: number };

export type OverviewSummary = {
  generatedAt: string;
  tally: { status: string; ready: boolean; heartbeatAt: string | null };
  recoveries: { actionCount: number; reviewCount: number; amount: number };
  turnoverDiscount: { reviewCount: number; resultCount: number; projectedAmount: number };
  creditNotes: { total: number; awaiting: number };
  messages: { queued: number; retrying: number; terminalFailures: number };
  activity: Array<{ id: string; title: string; detail: string; at: string | null }>;
};

export type OperationsAlert = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  nextAction: string;
  createdAt: string;
  correlationId?: string | null;
  detailTarget?: { correlationId?: string; entityType?: string; entityId?: string };
};

export type LaunchControl = {
  companyId: string;
  mode: "review_only" | "posting_enabled";
  reconciliation: { periodFrom: string | null; periodTo: string | null; reference: string | null; reconciledAt: string | null };
  postingEnabledAt: string | null;
};

export type OperationsHealth = {
  launchControl: LaunchControl;
  tally: { status: string; ready: boolean; heartbeat: { at: string | null; stale: boolean }; sync: { masters: { status: string; completedAt: string | null }; vouchers: { status: string; completedAt: string | null } } };
  outbox: { backlog: number; failed: number; deadLetter: number };
  bridgeCommands: { failed: number; deadLetter: number };
  messages: { queue: number; retrying: number; terminalFailures: number };
  configuration: { missing: string[] };
  proposals: { reviewInvalidatedOrNeedsReview: number };
  alerts: OperationsAlert[];
};

export type CashDiscountOpenReminder = {
  customerName: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  billReference: string;
  amountPaid: string;
  shortfallAmount: string;
  eligibilityDeadline: string;
  status: "ready" | "review_required";
  reasonCode: string;
  reviewMessage: string | null;
};

export type CashDiscountInvoiceCheck = {
  customerName: string;
  invoiceGuid: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  invoiceAmount: string;
  amountPaid: string;
  outstandingAmount: string;
  discountPercentage: string;
  earnedDiscountPercentage: string;
  eligibilityDeadline: string;
  status: "retained" | "payment_due" | "recovery_due" | "needs_review";
  paymentCount: number;
  latestPaymentDate: string | null;
  reviewMessage: string | null;
};

export type EvaluationRun = {
  id: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  error_summary: string | null;
  summary?: { message?: string | null; outcome?: string | null; liveOnly?: boolean; invoicesChecked?: number; actionRequired?: number; reviewRequired?: number; recoveryAmount?: string; alreadyRecovered?: string; openReminderReady?: number; openReminderReview?: number; openReminderCandidates?: CashDiscountOpenReminder[]; retained?: number; paymentDue?: number; tracking?: number; recoveryDue?: number; debitNoteAmount?: string; results?: CashDiscountInvoiceCheck[] } | null;
  scheme_type?: "cd" | "tod" | null;
  evaluation_date?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  attempts?: number | null;
  max_attempts?: number | null;
  run_reference?: string;
  total_jobs?: number;
  completed_jobs?: number;
  failed_jobs?: number;
  active_jobs?: number;
  qualified_jobs?: number;
  not_qualified_jobs?: number;
  projected_discount_amount?: number;
};

export type CashDiscountRecovery = {
  id: string;
  source_run_id: string;
  evaluated_on: string;
  customer_name: string;
  invoice_number: string | null;
  invoice_date: string;
  bill_reference: string;
  net_invoice_amount: string;
  implied_gross_amount: string;
  amount_paid: string;
  granted_discount_percentage: string;
  earned_discount_percentage: string;
  recovery_required: string;
  already_recovered: string;
  remaining_recovery: string;
  missed_window_working_days: number;
  missed_window_deadline: string;
  next_window_working_days: number | null;
  next_window_percentage: string | null;
  status: "action_required" | "review_required" | "posting";
  reason_code: string;
  review_message: string | null;
  narration_checked: boolean;
  narration_mentioned: boolean;
  narration_matches: boolean;
  debit_note_references: Array<{ voucherNumber?: string | null; amount?: string | null; status?: string | null }>;
  updated_at: string;
};

export type CashDiscountLiveResult = { customerId: string; customerName: string; invoiceGuid: string; invoiceNumber: string | null; invoiceDate: string; invoiceAmount: string; eligibleValue: string; amountPaid: string; amountPaidByDeadline: string; outstandingAmount: string; status: "retained" | "payment_due" | "recovery_due" | "tracking"; recommendedAction: "debit_note" | "send_reminder" | "wait" | "none"; retainedSlab: { workingDays: number; percentage: string; deadline: string } | null; applicableSlab: { workingDays: number; percentage: string; deadline: string }; discountAtRisk: string; debitNoteAmount: string; narration: { checked: boolean; mentioned: boolean; matches: boolean }; paymentCount: number; latestPaymentDate: string | null };

export type Voucher = { id: string; voucher_number: string; voucher_date: string; gross_amount: string | number; party_customer_id: string | null };

export type Calendar = { id: string; name: string; isActive: boolean; revision: number; nonWorkingWeekdays: number[]; holidays: Array<{ id: string; holiday_date: string; name: string; is_active: boolean }> };

export type Scheme = { id: string; schemeType: "cd" | "tod"; code: string; name: string; status: string; description: string | null };
export type Version = { id: string; versionNumber: number; schemeType: "cd" | "tod"; status: string; effectiveFrom: string; effectiveTo: string | null; discountPercentage: string | null; roundingMethod: "half_up" | "half_even" | "truncate"; roundingScale: number; creditNoteVoucherTypeId: string | null; discountLedgerId: string | null; workingCalendarId: string | null; allowedWorkingDays: number | null; nearEligibilityPercent: string | null; checkNarration: boolean; invoiceTreatment: "after_qualification" | "deducted_upfront" | null; narrationMode: "informational" | "required" | "disabled" | null; periodMonths: number | null; periodAnchorDate: string | null; todReviewCalendarId: string | null };
export type SchemeDetail = { scheme: Scheme; versions: Version[] };
export type VersionDetail = { version: Version; configuration: { customerGroups: Array<{ customer_group_id: string }>; stockItems: Array<{ stock_item_id: string }>; stockGroups: Array<{ stock_group_id: string }>; conversions: Array<{ source_uom_id: string; tonnes_per_source_unit: string; is_builtin: boolean }>; tiers: Array<{ id: string; minimum_tonnes: string; discount_percentage: string }>; cdSlabs: Array<{ id?: string; allowedWorkingDays: number; percentage: string }> } };
export type TaxPolicy = { id: string; effective_from: string; effective_to: string | null; approval_reference: string; approver_name_snapshot: string; approved_at: string };
export type CreditNoteAccountingSettings = {
  gstTreatment: "commercial_no_gst";
  turnoverDiscount: { voucherTypeId: string | null; ledgerId: string | null };
  updatedAt: string;
};
export type Contact = { id: string; customer_id: string; phone_e164: string; contact_name: string | null; is_primary: boolean; is_active: boolean; customer: { ledgerName: string } | null };
export type MessageTemplate = {
  id: string;
  event_type: string;
  provider_template_id: string;
  name: string;
  is_active: boolean;
  language_code: string;
  component_schema?: { components?: Array<{ component: string; value: string; type?: "text" | "document"; filenameValue?: string }> };
  updated_at: string;
};

export type CashDiscountDebitNoteHistory = {
  id: string;
  candidate_id: string;
  status: "queued" | "sending" | "created_verified" | "reconciliation_required" | "failed" | "cancelled";
  debit_note_date: string;
  amount: string;
  calculation_reference: string;
  verified_tally_guid: string | null;
  verified_voucher_number: string | null;
  verified_amount: string | null;
  verified_at: string | null;
  failure_reason: string | null;
  reconciliation_reason: string | null;
  last_reconciled_at: string | null;
  created_at: string;
  updated_at: string;
  candidate: {
    id: string;
    customer_name: string;
    invoice_number: string | null;
    invoice_date: string;
    bill_reference: string;
    recovery_required: string;
  } | null;
};
export type ProposalDetail = {
  proposal: Proposal;
  latestEvaluation: { evaluated_at: string; outcome_status: string; rule_snapshot: Record<string, unknown>; customer_group_snapshot: Record<string, unknown>; calendar_snapshot: Record<string, unknown> | null; formula_snapshot: Record<string, unknown>; reason_codes: string[] } | null;
  openIssues: Array<{ id: string; issue_type: string; status: string; details: Record<string, unknown>; created_at: string }>;
  reviews: Array<{ id: string; status: string; review_reason: string | null; reviewed_at: string | null; invalidation_reason: string | null }>;
  creditNotePosting: (CreditNotePosting & { verified_tally_guid?: string | null; verified_amount?: string | null; document: SafeCreditNoteDocument | null }) | null;
  notification: NotificationSummary;
  tallyEvidence: {
    tiers: Array<{ id: string; minimum_tonnes: string | number; discount_percentage: string | number }>;
    vouchers: Array<{
      tallyVoucherId: string;
      voucherNumber: string | null;
      voucherDate: string | null;
      voucherKind: string;
      voucherTypeName: string | null;
      contributionType: string;
      taxableValueContribution: string;
      tonneContribution: string;
    }>;
    lines: Array<{
      tallyVoucherId: string | null;
      lineNumber: number | null;
      productName: string;
      productGroupName: string | null;
      sourceQuantity: string;
      sourceUom: string | null;
      eligibleTonnes: string;
      eligibleTaxableValue: string;
      contributionSign: number;
      blockingReason: string | null;
    }>;
  };
};

export type SafeCreditNoteDocument = { id: string; status: string; mimeType: string | null; fileSizeBytes: number | null; attachedAt: string | null; verifiedAt: string | null; failureReason: string | null; available: boolean; downloadUrl?: string };
export type NotificationSummary = { eventType: string | null; messageId: string | null; status: string | null; canQueue: boolean; blockedReason: string | null };
