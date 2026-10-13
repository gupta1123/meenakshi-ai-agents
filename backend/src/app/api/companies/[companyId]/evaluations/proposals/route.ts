import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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

// A saved evaluation never changes, so its summary is read from the database once.
const summaryCache = new Map<string, ReturnType<typeof paymentSummary>>();

async function loadPaymentSummaries(companyId: string, evaluationIds: string[]) {
  const summaries = new Map<string, ReturnType<typeof paymentSummary>>();
  const missing: string[] = [];
  for (const id of evaluationIds) {
    if (summaryCache.has(id)) summaries.set(id, summaryCache.get(id) ?? null);
    else missing.push(id);
  }
  // Small chunks keep the request URL short; several at a time keep it quick.
  const chunks: string[][] = [];
  for (let index = 0; index < missing.length; index += 25) chunks.push(missing.slice(index, index + 25));
  for (let index = 0; index < chunks.length; index += 6) {
    await Promise.all(chunks.slice(index, index + 6).map(async (chunk) => {
      const { data, error } = await createSupabaseAdminClient().from("proposal_evaluations")
        .select("id, paymentChecks:formula_snapshot->paymentChecks").eq("company_id", companyId).in("id", chunk);
      if (error) throw error;
      for (const row of data ?? []) {
        const summary = paymentSummary((row as { paymentChecks?: unknown }).paymentChecks);
        summaries.set(row.id as string, summary);
        summaryCache.set(row.id as string, summary);
      }
    }));
  }
  if (summaryCache.size > 5000) for (const key of summaryCache.keys()) { summaryCache.delete(key); if (summaryCache.size <= 3000) break; }
  return summaries;
}

const postingColumns = "id, proposal_id, status, discount_amount, credit_note_date, verified_voucher_number, verified_at, failure_reason, reconciliation_reason, last_reconciled_at, updated_at";

async function loadPostings(companyId: string, ids: string[]) {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 100) chunks.push(ids.slice(index, index + 100));
  const results = await Promise.all(chunks.map((chunk) => createSupabaseAdminClient().from("credit_note_postings").select(postingColumns).eq("company_id", companyId).in("proposal_id", chunk)));
  const failed = results.find((result) => result.error);
  if (failed?.error) return { data: null, error: failed.error };
  return { data: results.flatMap((result) => result.data ?? []) as unknown as Array<{ id: string; proposal_id: string; status: string; discount_amount: unknown; credit_note_date: unknown; verified_voucher_number: unknown; verified_at: unknown; failure_reason: unknown; reconciliation_reason: unknown; last_reconciled_at: unknown; updated_at: unknown }>, error: null };
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
    // withPosting=true: only proposals that already have a Credit Note posting.
    const withPosting = url.searchParams.get("withPosting") === "true";
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
    // The select string is built from the request (embedded joins), which the generated types can't follow.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = (createSupabaseAdminClient().from("discount_proposals") as any)
      .select(`id, customer_id, customers(ledger_name, is_available), ${withPosting ? "credit_note_postings!inner(id), " : ""}${activeOnly && (schemeType === "cd" || schemeType === "tod") ? "scheme_versions!inner(id), " : ""}scheme_version_id, scheme_type, source_sales_voucher_id, period_start, period_end, entitlement_key, status, source_fingerprint, last_live_refresh_at, eligibility_deadline, eligible_product_taxable_value, eligible_tonnes, achieved_tier_id, next_tier_tonnes, additional_tonnes_required, invoice_amount_due, amount_paid_by_deadline, discounted_settlement_target, shortfall_amount, discount_percentage, calculated_discount_amount, posted_discount_amount, reason_codes, latest_evaluated_at, updated_at`)
      .eq("company_id", company.id);
    // A period request pages by id so the id cursor is exact; the default list stays newest-updated first.
    query = byPeriod ? query.order("id", { ascending: false }) : query.order("updated_at", { ascending: false }).order("id", { ascending: false });
    query = query.limit(limit + 1);
    if (byPeriod) query = query.eq("period_start", periodStart!).eq("period_end", periodEnd!);
    if (schemeVersionId) query = query.eq("scheme_version_id", schemeVersionId);
    if (schemeType === "cd" || schemeType === "tod") query = query.eq("scheme_type", schemeType);
    if (activeOnly && (schemeType === "cd" || schemeType === "tod")) {
      // Filter on the rule version inside the same query (one database call instead of two).
      const today = new Date().toISOString().slice(0, 10);
      query = query.eq("scheme_versions.status", "active").lte("scheme_versions.effective_from", today)
        .or(`effective_to.is.null,effective_to.gte.${today}`, { referencedTable: "scheme_versions" });
    }
    if (status) query = query.eq("status", status);
    if (cursor && isUuid(cursor)) query = query.lt("id", cursor);
    const { data: rawData, error } = await query;
    if (error) throw error;
    const rows = (rawData ?? []) as unknown as Array<Record<string, unknown> & { id: string; customer_id: string; scheme_type: string; customers?: { ledger_name?: string; is_available?: boolean } | null; scheme_versions?: unknown; credit_note_postings?: unknown }>;
    const hasMore = rows.length > limit;
    const proposals = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? proposals[proposals.length - 1]?.id ?? null : null;
    const ids = proposals.map((proposal) => proposal.id);
    const hasTod = proposals.some((proposal) => proposal.scheme_type === "tod");
    type LatestEvaluation = { id: string; evaluation_run_id: string | null; evaluation_number: number; source_fingerprint: string; evaluated_at: string };
    type RunInfo = { status: string; completed_at: string | null };
    const evaluationByProposal = new Map<string, LatestEvaluation>();
    const runById = new Map<string, RunInfo>();
    const summaryByEvaluation = new Map<string, ReturnType<typeof paymentSummary>>();
    const supabase = createSupabaseAdminClient();
    const [{ data: postings, error: postingsError }, latest] = ids.length
      ? await Promise.all([
        // 100 ids at a time: a long list in one request URL is rejected by the database gateway.
        loadPostings(company.id, ids),
        // One database call returns each customer's newest evaluation, its run status and the payment summary.
        supabase.rpc("proposal_latest_evaluations", { p_company_id: company.id, p_proposal_ids: ids, p_with_payment: hasTod }),
      ])
      : [{ data: [], error: null }, { data: [], error: null }];
    if (postingsError) throw postingsError;
    const rpcRows = (latest as { data: Array<{ proposal_id: string; evaluation_id: string; evaluation_run_id: string | null; evaluation_number: number; source_fingerprint: string; evaluated_at: string; run_status: string | null; run_completed_at: string | null; payment_summary: ReturnType<typeof paymentSummary> }> | null; error: unknown }).data;
    if (ids.length && (latest as { error: unknown }).error) {
      // The database function isn't installed yet: use the slower per-table reads.
      console.warn("proposal_latest_evaluations unavailable, falling back:", (latest as { error: unknown }).error);
      const { data: evaluations, error: evaluationsError } = await supabase.from("proposal_evaluations").select("id, proposal_id, evaluation_run_id, evaluation_number, source_fingerprint, evaluated_at").eq("company_id", company.id).in("proposal_id", ids).order("evaluation_number", { ascending: false });
      if (evaluationsError) throw evaluationsError;
      for (const evaluation of evaluations ?? []) if (!evaluationByProposal.has(evaluation.proposal_id)) evaluationByProposal.set(evaluation.proposal_id, evaluation);
      const reviewRunIds = [...evaluationByProposal.values()].map((evaluation) => evaluation.evaluation_run_id).filter((id): id is string => Boolean(id));
      const { data: reviewRuns, error: reviewRunsError } = reviewRunIds.length
        ? await supabase.from("evaluation_runs").select("id, status, completed_at").eq("company_id", company.id).in("id", reviewRunIds)
        : { data: [], error: null };
      if (reviewRunsError) throw reviewRunsError;
      for (const run of reviewRuns ?? []) runById.set(run.id, run);
      const todEvaluationIds = proposals.filter((proposal) => proposal.scheme_type === "tod").map((proposal) => evaluationByProposal.get(proposal.id)?.id).filter((id): id is string => Boolean(id));
      if (todEvaluationIds.length) for (const [key, value] of await loadPaymentSummaries(company.id, todEvaluationIds)) summaryByEvaluation.set(key, value);
    } else {
      for (const row of rpcRows ?? []) {
        evaluationByProposal.set(row.proposal_id, { id: row.evaluation_id, evaluation_run_id: row.evaluation_run_id, evaluation_number: row.evaluation_number, source_fingerprint: row.source_fingerprint, evaluated_at: row.evaluated_at });
        if (row.evaluation_run_id && row.run_status) runById.set(row.evaluation_run_id, { status: row.run_status, completed_at: row.run_completed_at });
        summaryByEvaluation.set(row.evaluation_id, row.payment_summary);
      }
    }
    const postingByProposal = new Map((postings ?? []).map((posting) => [posting.proposal_id, posting]));
    return jsonWithCors(request, {
      // A customer Tally no longer lists (is_available = false) is left out of Turnover Discount results
      // unless a Credit Note already exists, so it doesn't inflate customer counts.
      proposals: proposals.filter((proposal) => !(proposal.scheme_type === "tod" && proposal.customers?.is_available === false && !postingByProposal.has(proposal.id))).map((proposal) => {
        const { customers: customerRow, scheme_versions: _ruleVersion, credit_note_postings: _postingJoin, ...proposalFields } = proposal;
        void _ruleVersion; void _postingJoin;
        const customerName = customerRow?.ledger_name;
        const evaluation = evaluationByProposal.get(proposal.id) ?? null;
        const run = evaluation?.evaluation_run_id ? runById.get(evaluation.evaluation_run_id) : null;
        // Matches the Credit Note creation check: the latest calculation completed.
        const freshForApproval = Boolean(run?.status === "completed" && run.completed_at);
        return {
          ...proposalFields,
          customer_name: customerName ?? null,
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
