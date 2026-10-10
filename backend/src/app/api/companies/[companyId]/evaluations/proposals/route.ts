import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { REVIEW_REFRESH_MAX_AGE_MS } from "@/lib/credit-notes";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resultResetCutoff, visibleResults } from "@/lib/evaluation/result-visibility";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

type PaymentCheckRow = { voucherNumber?: string | null; invoiceDate?: string; dueDate?: string; paidInFullOn?: string | null; daysTaken?: number | null; invoiceAmount?: string; paidTotal?: string; tonnes?: string; counted?: boolean; reason?: string };

/** Short TOD payment-check summary for the results row: counts plus the invoices that did not count. */
function paymentSummary(checks: unknown) {
  if (!Array.isArray(checks)) return null;
  const rows = checks as PaymentCheckRow[];
  const excluded = rows.filter((row) => !row.counted);
  return {
    total: rows.length,
    counted: rows.length - excluded.length,
    late: excluded.filter((row) => row.reason === "paid_after_due_date").length,
    partlyPaid: excluded.filter((row) => row.reason === "partly_paid").length,
    unpaid: excluded.filter((row) => row.reason === "not_paid").length,
    excludedTonnes: excluded.reduce((total, row) => total + (Number(row.tonnes) || 0), 0).toFixed(3),
    excluded: excluded.map((row) => ({ voucherNumber: row.voucherNumber ?? null, invoiceDate: row.invoiceDate ?? null, dueDate: row.dueDate ?? null, paidInFullOn: row.paidInFullOn ?? null, daysTaken: row.daysTaken ?? null, invoiceAmount: row.invoiceAmount ?? "0", paidTotal: row.paidTotal ?? "0", tonnes: row.tonnes ?? "0", reason: row.reason ?? "not_paid" })),
  };
}

async function loadPaymentSummaries(companyId: string, evaluationIds: string[]) {
  const summaries = new Map<string, ReturnType<typeof paymentSummary>>();
  // Small chunks keep the request URL short.
  for (let index = 0; index < evaluationIds.length; index += 100) {
    const { data, error } = await createSupabaseAdminClient().from("proposal_evaluations")
      .select("id, paymentChecks:formula_snapshot->paymentChecks").eq("company_id", companyId).in("id", evaluationIds.slice(index, index + 100));
    if (error) throw error;
    for (const row of data ?? []) summaries.set(row.id as string, paymentSummary((row as { paymentChecks?: unknown }).paymentChecks));
  }
  return summaries;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const schemeType = url.searchParams.get("schemeType");
    const status = url.searchParams.get("status");
    const activeOnly = url.searchParams.get("activeOnly") === "true";
    // Credit Notes still need their historical proposal/accounting links.
    const cutoff = url.searchParams.get("includeArchived") === "true" ? null : await resultResetCutoff(company.id);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 250);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 250;
    const cursor = url.searchParams.get("cursor");
    // Optional: one period (and rule version) — used by "View results" in TOD history.
    const periodStart = url.searchParams.get("periodStart");
    const periodEnd = url.searchParams.get("periodEnd");
    const schemeVersionId = url.searchParams.get("schemeVersionId");
    const isDate = (value: string | null) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
    if ((periodStart || periodEnd) && !(isDate(periodStart) && isDate(periodEnd))) return jsonWithCors(request, { error: "periodStart and periodEnd must both be YYYY-MM-DD." }, { status: 400 });
    if (schemeVersionId && !isUuid(schemeVersionId)) return jsonWithCors(request, { error: "Invalid schemeVersionId." }, { status: 400 });
    const byPeriod = Boolean(periodStart && periodEnd);
    let query = createSupabaseAdminClient()
      .from("discount_proposals")
      .select("id, customer_id, scheme_version_id, scheme_type, source_sales_voucher_id, period_start, period_end, entitlement_key, status, source_fingerprint, last_live_refresh_at, eligibility_deadline, eligible_product_taxable_value, eligible_tonnes, achieved_tier_id, next_tier_tonnes, additional_tonnes_required, invoice_amount_due, amount_paid_by_deadline, discounted_settlement_target, shortfall_amount, discount_percentage, calculated_discount_amount, posted_discount_amount, reason_codes, latest_evaluated_at, updated_at")
      .eq("company_id", company.id);
    query = visibleResults(query, cutoff, "latest_evaluated_at");
    // A period request pages by id so the id cursor is exact; the default list stays newest-updated first.
    query = byPeriod ? query.order("id", { ascending: false }) : query.order("updated_at", { ascending: false }).order("id", { ascending: false });
    query = query.limit(limit + 1);
    if (byPeriod) query = query.eq("period_start", periodStart!).eq("period_end", periodEnd!);
    if (schemeVersionId) query = query.eq("scheme_version_id", schemeVersionId);
    if (schemeType === "cd" || schemeType === "tod") query = query.eq("scheme_type", schemeType);
    if (activeOnly && (schemeType === "cd" || schemeType === "tod")) {
      const today = new Date().toISOString().slice(0, 10);
      const { data: activeVersions, error: activeVersionsError } = await createSupabaseAdminClient()
        .from("scheme_versions").select("id").eq("company_id", company.id).eq("scheme_type", schemeType).eq("status", "active")
        .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`);
      if (activeVersionsError) throw activeVersionsError;
      const ids = (activeVersions ?? []).map((version) => version.id);
      if (!ids.length) return jsonWithCors(request, { proposals: [], nextCursor: null, hasMore: false });
      query = query.in("scheme_version_id", ids);
    }
    if (status) query = query.eq("status", status);
    if (cursor && isUuid(cursor)) query = query.lt("id", cursor);
    const { data: rawData, error } = await query;
    if (error) throw error;
    const rows = rawData ?? [];
    const hasMore = rows.length > limit;
    const proposals = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? proposals[proposals.length - 1]?.id ?? null : null;
    const ids = proposals.map((proposal) => proposal.id);
    const customerIds = [...new Set(proposals.map((proposal) => proposal.customer_id))];
    const [{ data: postings, error: postingsError }, { data: evaluations, error: evaluationsError }, { data: customers, error: customersError }] = ids.length
      ? await Promise.all([
        createSupabaseAdminClient().from("credit_note_postings").select("id, proposal_id, status, discount_amount, credit_note_date, verified_voucher_number, verified_at, failure_reason, reconciliation_reason, last_reconciled_at, updated_at").eq("company_id", company.id).in("proposal_id", ids),
        createSupabaseAdminClient().from("proposal_evaluations").select("id, proposal_id, evaluation_run_id, evaluation_number, source_fingerprint, evaluated_at").eq("company_id", company.id).in("proposal_id", ids).order("evaluation_number", { ascending: false }),
        createSupabaseAdminClient().from("customers").select("id, ledger_name").eq("company_id", company.id).in("id", customerIds),
      ])
      : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
    if (postingsError || evaluationsError || customersError) throw postingsError ?? evaluationsError ?? customersError;
    const postingByProposal = new Map((postings ?? []).map((posting) => [posting.proposal_id, posting]));
    const customerNameById = new Map((customers ?? []).map((customer) => [customer.id, customer.ledger_name]));
    const evaluationByProposal = new Map<string, { id: string; evaluation_run_id: string | null; evaluation_number: number; source_fingerprint: string; evaluated_at: string }>();
    for (const evaluation of evaluations ?? []) if (!evaluationByProposal.has(evaluation.proposal_id)) evaluationByProposal.set(evaluation.proposal_id, evaluation);
    const reviewRunIds = [...evaluationByProposal.values()].map((evaluation) => evaluation.evaluation_run_id).filter((id): id is string => Boolean(id));
    const { data: reviewRuns, error: reviewRunsError } = reviewRunIds.length
      ? await createSupabaseAdminClient().from("evaluation_runs").select("id, status, completed_at, request_context").eq("company_id", company.id).in("id", reviewRunIds)
      : { data: [], error: null };
    if (reviewRunsError) throw reviewRunsError;
    const runById = new Map((reviewRuns ?? []).map((run) => [run.id, run]));
    const todEvaluationIds = proposals.filter((proposal) => proposal.scheme_type === "tod").map((proposal) => evaluationByProposal.get(proposal.id)?.id).filter((id): id is string => Boolean(id));
    const summaryByEvaluation = todEvaluationIds.length ? await loadPaymentSummaries(company.id, todEvaluationIds) : new Map();
    const now = Date.now();
    return jsonWithCors(request, {
      proposals: proposals.map((proposal) => {
        const evaluation = evaluationByProposal.get(proposal.id) ?? null;
        const run = evaluation?.evaluation_run_id ? runById.get(evaluation.evaluation_run_id) : null;
        const completedAt = run?.completed_at ? new Date(run.completed_at).getTime() : Number.NaN;
        // Matches the Credit Note creation check: any completed calculation up to 5 days old.
        const freshForApproval = Boolean(
          run?.status === "completed"
          && Number.isFinite(completedAt)
          && now - completedAt <= REVIEW_REFRESH_MAX_AGE_MS
        );
        return {
          ...proposal,
          customer_name: customerNameById.get(proposal.customer_id) ?? null,
          latestEvaluation: evaluation ? { id: evaluation.id, evaluated_at: evaluation.evaluated_at, freshForApproval } : null,
          creditNotePosting: postingByProposal.get(proposal.id) ?? null,
          ...(proposal.scheme_type === "tod" ? { paymentSummary: evaluation ? summaryByEvaluation.get(evaluation.id) ?? null : null } : {}),
        };
      }),
      nextCursor,
      hasMore,
    }, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list evaluation proposals:", error);
    return jsonWithCors(request, { error: "Could not list evaluation proposals." }, { status: 500 });
  }
}
