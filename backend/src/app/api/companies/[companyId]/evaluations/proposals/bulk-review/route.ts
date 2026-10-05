import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { buildCreditNoteApprovalInput } from "@/lib/credit-notes";
import { requirePostingEnabled } from "@/lib/launch-control";
import { RulebookRequestError } from "@/lib/rulebook/shared";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    await requirePostingEnabled(company.id);
    const body = await request.json().catch(() => ({})) as { proposalIds?: unknown };
    const proposalIds = Array.isArray(body.proposalIds) ? [...new Set(body.proposalIds.filter((id): id is string => typeof id === "string" && isUuid(id)))] : [];
    if (!proposalIds.length) return jsonWithCors(request, { error: "Choose at least one Credit Note." }, { status: 400 });
    if (proposalIds.length > 25) return jsonWithCors(request, { error: "Create up to 25 Credit Notes in one batch." }, { status: 400 });

    const supabase = createSupabaseAdminClient();
    const results: Array<{ proposalId: string; status: "queued" | "skipped"; postingId?: string; error?: string }> = [];
    for (const proposalId of proposalIds) {
      try {
        const input = await buildCreditNoteApprovalInput(company.id, proposalId);
        const { data, error } = await supabase.rpc("approve_proposal_and_enqueue_credit_note", {
          p_proposal_id: input.proposalId, p_proposal_evaluation_id: input.proposalEvaluationId, p_actor_id: userId,
          p_credit_note_date: input.creditNoteDate, p_bill_allocation_type: input.billAllocationType,
          p_tally_bill_reference: input.tallyBillReference, p_calculation_reference: input.calculationReference,
          p_credit_note_snapshot: input.creditNoteSnapshot, p_idempotency_key: input.idempotencyKey, p_correlation_id: input.correlationId,
        });
        if (error) throw error;
        results.push({ proposalId, status: "queued", postingId: String(data) });
      } catch (error) {
        results.push({ proposalId, status: "skipped", error: error instanceof Error ? error.message : "This result is not ready." });
      }
    }
    const queued = results.filter((result) => result.status === "queued").length;
    return jsonWithCors(request, { queued, skipped: results.length - queued, results, message: `${queued} Credit Note${queued === 1 ? "" : "s"} queued. Tally will create them one at a time.` }, { status: queued ? 202 : 409 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError || error instanceof RulebookRequestError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not queue the Credit Notes." }, { status: 500 });
  }
}
