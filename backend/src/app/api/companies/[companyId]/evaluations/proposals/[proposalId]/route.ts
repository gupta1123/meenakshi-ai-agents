import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { toSafeCreditNoteDocument, type CreditNoteDocumentRow } from "@/lib/credit-note-documents";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; proposalId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

type NotificationSummary = {
  eventType: "cd_shortfall" | "cd_credit_note_created" | "tod_tier_reached" | "tod_credit_note_created" | null;
  messageId: string | null;
  status: string | null;
  canQueue: boolean;
  blockedReason: string | null;
};

async function notificationSummary(input: {
  companyId: string;
  organizationId: string;
  proposal: { id: string; customer_id: string; scheme_type: string; status: string; shortfall_amount: string | number | null; achieved_tier_id: string | null };
  posting: { id: string; status: string } | null;
}) : Promise<NotificationSummary> {
  const eventType = input.proposal.scheme_type === "tod" && ["tracking", "eligible"].includes(input.proposal.status) && input.proposal.achieved_tier_id
    ? "tod_tier_reached"
    : input.proposal.status === "near_eligibility" && input.proposal.scheme_type === "cd"
    ? "cd_shortfall"
    : input.posting?.status === "created_verified"
      ? input.proposal.scheme_type === "tod" ? "tod_credit_note_created" : "cd_credit_note_created"
      : null;
  if (!eventType) return { eventType: null, messageId: null, status: null, canQueue: false, blockedReason: "A message is not applicable at the current workflow state." };

  const supabase = createSupabaseAdminClient();
  if (eventType === "tod_tier_reached") {
    const { data: tierIssue, error: tierIssueError } = await supabase.from("processing_issues")
      .select("id").eq("company_id", input.companyId).eq("proposal_id", input.proposal.id)
      .eq("issue_type", "tod_tier_reduced_after_notification").in("status", ["open", "in_progress"]).limit(1).maybeSingle();
    if (tierIssueError) throw tierIssueError;
    if (tierIssue) return { eventType, messageId: null, status: null, canQueue: false, blockedReason: "A previously messaged TOD tier was reduced after refreshed Tally data. Review is required before any further customer message." };
  }
  let existingQuery = supabase.from("notification_messages")
    .select("id, status").eq("company_id", input.companyId).eq("proposal_id", input.proposal.id).eq("event_type", eventType);
  if (eventType === "tod_tier_reached" && input.proposal.achieved_tier_id) {
    existingQuery = existingQuery.eq("business_event_key", `phase6:tod_tier_reached:${input.proposal.id}:${input.proposal.achieved_tier_id}`);
  }
  const { data: existing, error: existingError } = await existingQuery.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { eventType, messageId: existing.id, status: existing.status, canQueue: false, blockedReason: "An event already exists for this business action." };

  const { data: contact, error: contactError } = await supabase.from("customer_contacts")
    .select("id").eq("company_id", input.companyId).eq("customer_id", input.proposal.customer_id).eq("is_active", true)
    .order("is_primary", { ascending: false }).order("entered_at", { ascending: true }).limit(1).maybeSingle();
  if (contactError) throw contactError;
  if (!contact) return { eventType, messageId: null, status: null, canQueue: false, blockedReason: "No active controlled customer contact is recorded." };
  const [{ data: optIn, error: optInError }, { data: template, error: templateError }] = await Promise.all([
    supabase.from("whatsapp_opt_ins").select("id").eq("company_id", input.companyId).eq("customer_contact_id", contact.id).eq("is_opted_in", true).is("revoked_at", null).limit(1).maybeSingle(),
    supabase.from("whatsapp_templates").select("id").eq("organization_id", input.organizationId).eq("event_type", eventType).eq("is_active", true).limit(1).maybeSingle(),
  ]);
  if (optInError || templateError) throw optInError ?? templateError;
  if (!optIn) return { eventType, messageId: null, status: null, canQueue: false, blockedReason: "The active controlled contact has no recorded WhatsApp opt-in." };
  if (!template) return { eventType, messageId: null, status: null, canQueue: false, blockedReason: "No active approved WhatsApp template is available for this event." };
  return { eventType, messageId: null, status: null, canQueue: true, blockedReason: null };
}

async function loadProposalDetailFallback(company: { id: string; organization_id: string }, proposalId: string) {
  const supabase = createSupabaseAdminClient();
  const { data: proposal, error: proposalError } = await supabase.from("discount_proposals").select("id, customer_id, scheme_version_id, scheme_type, source_sales_voucher_id, period_start, period_end, entitlement_key, status, source_fingerprint, last_live_refresh_at, eligibility_deadline, eligible_product_taxable_value, eligible_tonnes, achieved_tier_id, next_tier_tonnes, additional_tonnes_required, invoice_amount_due, amount_paid_by_deadline, discounted_settlement_target, shortfall_amount, discount_percentage, calculated_discount_amount, reason_codes, latest_evaluated_at").eq("id", proposalId).eq("company_id", company.id).maybeSingle();
  if (proposalError) throw proposalError;
  if (!proposal) return null;
  const [{ data: latestEvaluation, error: evaluationError }, { data: issues, error: issuesError }, { data: reviews, error: reviewsError }, { data: posting, error: postingError }] = await Promise.all([
    supabase.from("proposal_evaluations").select("id, evaluation_run_id, evaluation_number, outcome_status, source_fingerprint, rule_snapshot, customer_group_snapshot, calendar_snapshot, formula_snapshot, reason_codes, evaluated_at").eq("proposal_id", proposal.id).eq("company_id", company.id).order("evaluation_number", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("processing_issues").select("id, issue_key, issue_type, status, details, created_at, updated_at").eq("proposal_id", proposal.id).eq("company_id", company.id).in("status", ["open", "in_progress"]).order("created_at"),
    supabase.from("proposal_reviews").select("id, proposal_evaluation_id, status, source_fingerprint, review_reason, reviewed_by, reviewed_at, invalidation_reason, invalidated_at").eq("proposal_id", proposal.id).order("created_at", { ascending: false }),
    supabase.from("credit_note_postings").select("id, status, credit_note_date, discount_amount, calculation_reference, bill_allocation_type, tally_bill_reference, verified_tally_guid, verified_voucher_number, verified_amount, verified_at, failure_reason, reconciliation_reason, last_reconciled_at, created_at, updated_at").eq("proposal_id", proposal.id).eq("company_id", company.id).maybeSingle(),
  ]);
  if (evaluationError || issuesError || reviewsError || postingError) throw evaluationError ?? issuesError ?? reviewsError ?? postingError;
  const { data: document, error: documentError } = posting ? await supabase.from("credit_note_documents").select("id, status, storage_path, mime_type, file_size_bytes, attached_at, verified_at, failure_reason").eq("credit_note_posting_id", posting.id).maybeSingle() : { data: null, error: null };
  if (documentError) throw documentError;
  const evaluationId = latestEvaluation?.id ?? null;
  const [tiersResult, sourceVouchersResult, sourceLinesResult] = await Promise.all([
    proposal.scheme_type === "tod" && proposal.scheme_version_id ? supabase.from("scheme_version_tiers").select("id, minimum_tonnes, discount_percentage").eq("scheme_version_id", proposal.scheme_version_id).order("minimum_tonnes") : Promise.resolve({ data: [], error: null }),
    evaluationId ? supabase.from("proposal_source_vouchers").select("tally_voucher_id, contribution_type, taxable_value_contribution, tonne_contribution, source_snapshot").eq("proposal_evaluation_id", evaluationId).order("created_at") : Promise.resolve({ data: [], error: null }),
    evaluationId ? supabase.from("proposal_source_inventory_lines").select("tally_voucher_inventory_line_id, eligible_quantity, eligible_tonnes, eligible_taxable_value, contribution_sign, blocking_reason").eq("proposal_evaluation_id", evaluationId).order("created_at") : Promise.resolve({ data: [], error: null }),
  ]);
  if (tiersResult.error || sourceVouchersResult.error || sourceLinesResult.error) throw tiersResult.error ?? sourceVouchersResult.error ?? sourceLinesResult.error;
  const inventoryLineIds = (sourceLinesResult.data ?? []).map((line) => line.tally_voucher_inventory_line_id);
  const { data: tallyLines, error: tallyLinesError } = inventoryLineIds.length ? await supabase.from("tally_voucher_inventory_lines").select("id, voucher_id, line_number, source_uom_code_snapshot, quantity, source_payload").eq("company_id", company.id).in("id", inventoryLineIds) : { data: [], error: null };
  if (tallyLinesError) throw tallyLinesError;
  const tallyLineById = new Map((tallyLines ?? []).map((line) => [line.id, line]));
  const formulaSnapshot = latestEvaluation?.formula_snapshot && typeof latestEvaluation.formula_snapshot === "object" ? latestEvaluation.formula_snapshot as Record<string, unknown> : {};
  const liveContributions = Array.isArray(formulaSnapshot.contributions) ? formulaSnapshot.contributions as Array<Record<string, unknown>> : [];
  const liveProducts = Array.isArray(formulaSnapshot.productContributions) ? formulaSnapshot.productContributions as Array<Record<string, unknown>> : [];
  const storedVouchers = sourceVouchersResult.data ?? [];
  const storedLines = sourceLinesResult.data ?? [];
  const tallyEvidence = {
    tiers: tiersResult.data ?? [],
    vouchers: storedVouchers.length ? storedVouchers.map((row) => {
      const snapshot = row.source_snapshot && typeof row.source_snapshot === "object" ? row.source_snapshot as Record<string, unknown> : {};
      const source = snapshot.source && typeof snapshot.source === "object" ? snapshot.source as Record<string, unknown> : {};
      return { tallyVoucherId: row.tally_voucher_id, voucherNumber: snapshot.voucherNumber ? String(snapshot.voucherNumber) : null, voucherDate: snapshot.voucherDate ? String(snapshot.voucherDate) : null, voucherKind: snapshot.voucherKind ? String(snapshot.voucherKind) : row.contribution_type, voucherTypeName: source.voucherTypeName ? String(source.voucherTypeName) : null, contributionType: row.contribution_type, taxableValueContribution: String(row.taxable_value_contribution ?? "0"), tonneContribution: String(row.tonne_contribution ?? "0") };
    }) : liveContributions.map((row) => ({ tallyVoucherId: String(row.tallyGuid ?? `${row.voucherNumber ?? "voucher"}:${row.voucherDate ?? "unknown"}`), voucherNumber: row.voucherNumber ? String(row.voucherNumber) : null, voucherDate: row.voucherDate ? String(row.voucherDate) : null, voucherKind: String(row.voucherKind ?? "sales"), voucherTypeName: null, contributionType: String(row.voucherKind ?? "sale"), taxableValueContribution: String(row.taxableValueContribution ?? "0"), tonneContribution: String(row.tonneContribution ?? "0") })),
    lines: storedLines.length ? storedLines.map((row) => {
      const tallyLine = tallyLineById.get(row.tally_voucher_inventory_line_id);
      const source = tallyLine?.source_payload && typeof tallyLine.source_payload === "object" ? tallyLine.source_payload as Record<string, unknown> : {};
      return { tallyVoucherId: tallyLine?.voucher_id ?? null, lineNumber: tallyLine?.line_number ?? null, productName: source.stockItemName ? String(source.stockItemName) : "Tally item", productGroupName: source.stockGroupName ? String(source.stockGroupName) : null, sourceQuantity: String(tallyLine?.quantity ?? row.eligible_quantity ?? "0"), sourceUom: tallyLine?.source_uom_code_snapshot ?? null, eligibleTonnes: String(row.eligible_tonnes ?? "0"), eligibleTaxableValue: String(row.eligible_taxable_value ?? "0"), contributionSign: Number(row.contribution_sign), blockingReason: row.blocking_reason };
    }) : liveProducts.map((row, index) => ({ tallyVoucherId: null, lineNumber: index + 1, productName: String(row.productName ?? "Tally item"), productGroupName: row.productGroupName ? String(row.productGroupName) : null, sourceQuantity: String(row.sourceQuantity ?? "0"), sourceUom: row.sourceUom ? String(row.sourceUom) : null, eligibleTonnes: String(row.eligibleTonnes ?? "0"), eligibleTaxableValue: String(row.eligibleTaxableValue ?? "0"), contributionSign: 1, blockingReason: null })),
  };
  const notification = await notificationSummary({ companyId: company.id, organizationId: company.organization_id, proposal: proposal as { id: string; customer_id: string; scheme_type: string; status: string; shortfall_amount: string | number | null; achieved_tier_id: string | null }, posting: posting as { id: string; status: string } | null });
  return { proposal, latestEvaluation: latestEvaluation ?? null, openIssues: issues ?? [], reviews: reviews ?? [], creditNotePosting: posting ? { ...posting, document: toSafeCreditNoteDocument(document as CreditNoteDocumentRow | null) } : null, notification, tallyEvidence };
}

// This intentionally returns finance-safe summaries rather than raw Tally XML
// or source payloads. The immutable raw evidence remains server-side only.
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, proposalId } = await context.params;
    if (!isUuid(companyId) || !isUuid(proposalId)) return jsonWithCors(request, { error: "Invalid company or proposal id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const { data: rpcData, error: rpcError } = await supabase.rpc("get_proposal_detail", { p_proposal_id: proposalId, p_company_id: company.id });
    const isMissingRpc = rpcError && (String((rpcError as { code?: string }).code) === "42883" || String(rpcError.message ?? "").includes("get_proposal_detail"));
    if (!isMissingRpc && rpcData) {
      const raw = rpcData as { proposal: Record<string, unknown> | null; error?: string; latestEvaluation: Record<string, unknown> | null; openIssues: unknown[]; reviews: unknown[]; creditNotePosting: Record<string, unknown> | null; tallyEvidence: { tiers: unknown[]; vouchers: unknown[]; lines: unknown[]; tallyLines: unknown[] }; notification: NotificationSummary };
      if ((raw as { error?: string }).error === "not_found" || !raw.proposal) return jsonWithCors(request, { error: "Proposal not found." }, { status: 404 });
      // Rebuild tallyEvidence to match existing frontend shape (live fallback handled in RPC raw, but keep mapping for voucher/line shape)
      const tallyLines = (raw.tallyEvidence as { tallyLines?: unknown[] })?.tallyLines ?? [];
      const tallyLineById = new Map((tallyLines as Array<{ id: string }>).map((l) => [(l as { id: string }).id, l]));
      const evaluation = raw.latestEvaluation as Record<string, unknown> | null;
      const formulaSnapshot = evaluation?.formula_snapshot && typeof evaluation.formula_snapshot === "object" ? evaluation.formula_snapshot as Record<string, unknown> : {};
      const liveContributions = Array.isArray(formulaSnapshot.contributions) ? formulaSnapshot.contributions as Array<Record<string, unknown>> : [];
      const liveProducts = Array.isArray(formulaSnapshot.productContributions) ? formulaSnapshot.productContributions as Array<Record<string, unknown>> : [];
      const storedVouchers = (raw.tallyEvidence as { vouchers: unknown[] }).vouchers ?? [];
      const storedLines = (raw.tallyEvidence as { lines: unknown[] }).lines ?? [];
      const mappedEvidence = {
        tiers: (raw.tallyEvidence as { tiers: unknown[] }).tiers ?? [],
        vouchers: (storedVouchers as Array<Record<string, unknown>>).length ? (storedVouchers as Array<{ tally_voucher_id: string; contribution_type: string; taxable_value_contribution: unknown; tonne_contribution: unknown; source_snapshot: unknown }>).map((row) => {
          const snapshot = row.source_snapshot && typeof row.source_snapshot === "object" ? row.source_snapshot as Record<string, unknown> : {};
          const source = snapshot.source && typeof snapshot.source === "object" ? snapshot.source as Record<string, unknown> : {};
          return { tallyVoucherId: row.tally_voucher_id, voucherNumber: snapshot.voucherNumber ? String(snapshot.voucherNumber) : null, voucherDate: snapshot.voucherDate ? String(snapshot.voucherDate) : null, voucherKind: snapshot.voucherKind ? String(snapshot.voucherKind) : row.contribution_type, voucherTypeName: source.voucherTypeName ? String(source.voucherTypeName) : null, contributionType: row.contribution_type, taxableValueContribution: String(row.taxable_value_contribution ?? "0"), tonneContribution: String(row.tonne_contribution ?? "0") };
        }) : liveContributions.map((row) => ({ tallyVoucherId: String(row.tallyGuid ?? `${row.voucherNumber ?? "voucher"}:${row.voucherDate ?? "unknown"}`), voucherNumber: row.voucherNumber ? String(row.voucherNumber) : null, voucherDate: row.voucherDate ? String(row.voucherDate) : null, voucherKind: String(row.voucherKind ?? "sales"), voucherTypeName: null, contributionType: String(row.voucherKind ?? "sale"), taxableValueContribution: String(row.taxableValueContribution ?? "0"), tonneContribution: String(row.tonneContribution ?? "0") })),
        lines: (storedLines as Array<Record<string, unknown>>).length ? (storedLines as Array<{ tally_voucher_inventory_line_id: string; eligible_quantity: unknown; eligible_tonnes: unknown; eligible_taxable_value: unknown; contribution_sign: unknown; blocking_reason: unknown }>).map((row) => {
          const tallyLine = tallyLineById.get(row.tally_voucher_inventory_line_id) as { voucher_id: string | null; line_number: number | null; source_uom_code_snapshot: string | null; quantity: unknown; source_payload: unknown } | undefined;
          const source = tallyLine?.source_payload && typeof tallyLine.source_payload === "object" ? tallyLine.source_payload as Record<string, unknown> : {};
          return { tallyVoucherId: tallyLine?.voucher_id ?? null, lineNumber: tallyLine?.line_number ?? null, productName: source.stockItemName ? String(source.stockItemName) : "Tally item", productGroupName: source.stockGroupName ? String(source.stockGroupName) : null, sourceQuantity: String(tallyLine?.quantity ?? row.eligible_quantity ?? "0"), sourceUom: tallyLine?.source_uom_code_snapshot ?? null, eligibleTonnes: String(row.eligible_tonnes ?? "0"), eligibleTaxableValue: String(row.eligible_taxable_value ?? "0"), contributionSign: Number(row.contribution_sign), blockingReason: row.blocking_reason as string | null };
        }) : liveProducts.map((row, index) => ({ tallyVoucherId: null, lineNumber: index + 1, productName: String(row.productName ?? "Tally item"), productGroupName: row.productGroupName ? String(row.productGroupName) : null, sourceQuantity: String(row.sourceQuantity ?? "0"), sourceUom: row.sourceUom ? String(row.sourceUom) : null, eligibleTonnes: String(row.eligibleTonnes ?? "0"), eligibleTaxableValue: String(row.eligibleTaxableValue ?? "0"), contributionSign: 1, blockingReason: null })),
      };
      const posting = raw.creditNotePosting as Record<string, unknown> | null;
      // The RPC embeds the raw document row. Normalize it before returning it:
      // callers need `available`/`failureReason`, and private storage paths
      // must never be exposed to the browser.
      const safeDocument = posting?.document ? toSafeCreditNoteDocument(posting.document as CreditNoteDocumentRow) : null;
      const notification = await notificationSummary({
        companyId: company.id,
        organizationId: company.organization_id,
        proposal: raw.proposal as { id: string; customer_id: string; scheme_type: string; status: string; shortfall_amount: string | number | null; achieved_tier_id: string | null },
        posting: posting as { id: string; status: string } | null,
      });
      return jsonWithCors(request, { proposal: raw.proposal, latestEvaluation: raw.latestEvaluation ?? null, openIssues: raw.openIssues ?? [], reviews: raw.reviews ?? [], creditNotePosting: posting ? { ...posting, document: safeDocument } : null, notification, tallyEvidence: mappedEvidence }, { headers: { "Cache-Control": "no-store", "X-Cache": "MISS" } });
    }
    if (rpcError && !isMissingRpc) console.warn("get_proposal_detail RPC failed, falling back:", rpcError);
    const fallback = await loadProposalDetailFallback(company, proposalId);
    if (!fallback) return jsonWithCors(request, { error: "Proposal not found." }, { status: 404 });
    return jsonWithCors(request, fallback, { headers: { "Cache-Control": "no-store", "X-Cache": isMissingRpc ? "FALLBACK-MISSING-RPC" : "FALLBACK" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not read proposal:", error);
    return jsonWithCors(request, { error: "Could not read proposal." }, { status: 500 });
  }
}
