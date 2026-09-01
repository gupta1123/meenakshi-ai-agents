import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const schemeType = url.searchParams.get("schemeType");
    const status = url.searchParams.get("status");
    const requestedLimit = Number(url.searchParams.get("limit") ?? 250);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 250;
    const cursor = url.searchParams.get("cursor");
    let query = createSupabaseAdminClient()
      .from("discount_proposals")
      .select("id, customer_id, scheme_version_id, scheme_type, source_sales_voucher_id, period_start, period_end, entitlement_key, status, source_fingerprint, last_live_refresh_at, eligibility_deadline, eligible_product_taxable_value, eligible_tonnes, achieved_tier_id, next_tier_tonnes, additional_tonnes_required, invoice_amount_due, amount_paid_by_deadline, discounted_settlement_target, shortfall_amount, discount_percentage, calculated_discount_amount, posted_discount_amount, reason_codes, latest_evaluated_at, updated_at")
      .eq("company_id", company.id).order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    if (schemeType === "cd" || schemeType === "tod") query = query.eq("scheme_type", schemeType);
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
    const now = Date.now();
    return jsonWithCors(request, {
      proposals: proposals.map((proposal) => {
        const evaluation = evaluationByProposal.get(proposal.id) ?? null;
        const run = evaluation?.evaluation_run_id ? runById.get(evaluation.evaluation_run_id) : null;
        const context = run?.request_context && typeof run.request_context === "object" ? run.request_context as Record<string, unknown> : null;
        const completedAt = run?.completed_at ? new Date(run.completed_at).getTime() : Number.NaN;
        const freshForApproval = Boolean(
          run?.status === "completed"
          && context?.reviewRefreshForProposal === proposal.id
          && Number.isFinite(completedAt)
          && now - completedAt <= 15 * 60 * 1_000
        );
        return {
          ...proposal,
          customer_name: customerNameById.get(proposal.customer_id) ?? null,
          latestEvaluation: evaluation ? { id: evaluation.id, evaluated_at: evaluation.evaluated_at, freshForApproval } : null,
          creditNotePosting: postingByProposal.get(proposal.id) ?? null,
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
