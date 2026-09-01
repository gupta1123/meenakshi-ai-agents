import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { buildCreditNoteApprovalInput } from "@/lib/credit-notes";
import { requirePostingEnabled } from "@/lib/launch-control";
import { RulebookRequestError } from "@/lib/rulebook/shared";
import { isUuid, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; proposalId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, proposalId } = await context.params;
    if (!isUuid(companyId) || !isUuid(proposalId)) return jsonWithCors(request, { error: "Invalid company or proposal id." }, { status: 400 });
    const { company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const decision = body.decision;
    const reason = readText(body.reason, 2_000);
    const supabase = createSupabaseAdminClient();
    if (decision === "reject") {
      if (!isUuid(body.proposalEvaluationId) || !reason) return jsonWithCors(request, { error: "proposalEvaluationId and rejection reason are required." }, { status: 400 });
      const { data, error } = await supabase.rpc("reject_meenakshi_proposal_review", {
        p_proposal_id: proposalId, p_proposal_evaluation_id: body.proposalEvaluationId, p_actor_id: userId, p_reason: reason,
      });
      if (error) throw error;
      return jsonWithCors(request, { reviewId: data, status: "rejected" });
    }
    if (decision !== "create" && decision !== "approve") {
      return jsonWithCors(request, { error: "decision must be create or reject." }, { status: 400 });
    }
    await requirePostingEnabled(company.id);
    const input = await buildCreditNoteApprovalInput(company.id, proposalId);
    const { data, error } = await supabase.rpc("approve_proposal_and_enqueue_credit_note", {
      p_proposal_id: input.proposalId,
      p_proposal_evaluation_id: input.proposalEvaluationId,
      p_actor_id: userId,
      p_credit_note_date: input.creditNoteDate,
      p_bill_allocation_type: input.billAllocationType,
      p_tally_bill_reference: input.tallyBillReference,
      p_calculation_reference: input.calculationReference,
      p_credit_note_snapshot: input.creditNoteSnapshot,
      p_idempotency_key: input.idempotencyKey,
      p_correlation_id: input.correlationId,
    });
    if (error) throw error;
    return jsonWithCors(request, {
      creditNotePostingId: data,
      status: "queued",
      correlationId: input.correlationId,
      next: "tally_creation",
      message: "Credit Note creation was queued for Tally. WhatsApp will be queued automatically after Tally verification.",
    }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError || error instanceof RulebookRequestError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not review proposal:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not review proposal." }, { status: 500 });
  }
}
