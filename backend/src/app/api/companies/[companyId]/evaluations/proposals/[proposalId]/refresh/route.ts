import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; proposalId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

/**
 * Queues a targeted, live Tally refresh for the exact proposal before the
 * administrator creates a Credit Note. The amount is never accepted from the browser.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, proposalId } = await context.params;
    if (!isUuid(companyId) || !isUuid(proposalId)) return jsonWithCors(request, { error: "Invalid company or proposal id." }, { status: 400 });
    const { organization, company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const { data: proposal, error: proposalError } = await supabase
      .from("discount_proposals")
      .select("id, scheme_type, scheme_version_id, customer_id, source_sales_voucher_id, period_start, period_end")
      .eq("id", proposalId).eq("company_id", company.id).maybeSingle();
    if (proposalError) throw proposalError;
    if (!proposal) return jsonWithCors(request, { error: "Proposal not found." }, { status: 404 });

    const evaluatedOn = new Date().toISOString().slice(0, 10);
    const requestContext = proposal.scheme_type === "cd"
      ? { schemeType: "cd", salesVoucherId: proposal.source_sales_voucher_id, evaluatedOn, reviewRefreshForProposal: proposal.id }
      : { schemeType: "tod", schemeVersionId: proposal.scheme_version_id, customerId: proposal.customer_id, periodStart: proposal.period_start, periodEnd: proposal.period_end, asOfDate: proposal.period_end, evaluatedOn, reviewRefreshForProposal: proposal.id };
    if (proposal.scheme_type === "cd" && !proposal.source_sales_voucher_id) {
      return jsonWithCors(request, { error: "This CD proposal no longer identifies its source sales voucher." }, { status: 409 });
    }
    if (proposal.scheme_type === "tod" && !proposal.period_end) {
      return jsonWithCors(request, { error: "This TOD proposal no longer identifies the period being prepared for a Credit Note." }, { status: 409 });
    }
    const { data, error } = await supabase.rpc("create_meenakshi_evaluation_run", {
      p_organization_id: organization.id,
      p_company_id: company.id,
      p_actor_id: userId,
      p_request_context: requestContext,
      // Repeating the same user action in a minute returns its existing run
      // instead of asking Tally for duplicate evidence refreshes.
      p_idempotency_key: `proposal-review-refresh:${proposal.id}:${new Date().toISOString().slice(0, 16)}`,
    });
    if (error) throw error;
    return jsonWithCors(request, {
      evaluationRun: data,
      message: "A targeted Tally refresh was queued. When it completes, create the Credit Note within 5 days.",
    }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not queue proposal review refresh:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not queue the proposal refresh." }, { status: 500 });
  }
}
