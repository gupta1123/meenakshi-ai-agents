import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { queueInitialNotification } from "@/lib/notifications/event-factory";
import { appendRulebookAudit, readRequiredUuid, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
type PostingRow = { id: string; proposal_id: string; status: string };
type ProposalRow = { id: string; scheme_type: string };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

/**
 * Creates the one idempotent initial event for an already verified Credit
 * Note when its original transition happened before notification setup.
 * It cannot select a recipient, template, or message content.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const creditNotePostingId = readRequiredUuid(body.creditNotePostingId, "creditNotePostingId");
    const supabase = createSupabaseAdminClient();
    const { data: postingData, error: postingError } = await supabase.from("credit_note_postings")
      .select("id, proposal_id, status").eq("id", creditNotePostingId).eq("company_id", scope.company.id).maybeSingle();
    if (postingError) throw postingError;
    const posting = postingData as PostingRow | null;
    if (!posting) throw new RulebookRequestError("Credit Note posting was not found for this company.", 404);
    const { data: proposalData, error: proposalError } = await supabase.from("discount_proposals")
      .select("id, scheme_type").eq("id", posting.proposal_id).eq("company_id", scope.company.id).maybeSingle();
    if (proposalError) throw proposalError;
    const proposal = proposalData as ProposalRow | null;
    if (!proposal || (proposal.scheme_type !== "cd" && proposal.scheme_type !== "tod")) {
      throw new RulebookRequestError("Credit Note proposal was not found for this company.", 404);
    }
    const eventType = proposal.scheme_type === "cd" ? "cd_credit_note_created" : "tod_credit_note_created";
    const result = await queueInitialNotification({
      companyId: scope.company.id,
      proposalId: proposal.id,
      eventType,
      creditNotePostingId: posting.id,
      actorId: scope.userId,
    });
    await appendRulebookAudit({
      scope,
      action: result.queued ? "verified_credit_note_notification_recovered" : "verified_credit_note_notification_recovery_blocked",
      entityType: "credit_note_posting",
      entityId: posting.id,
      newValue: { eventType, notificationMessageId: result.messageId, queued: result.queued },
      metadata: result.blockedReason ? { blockedReason: result.blockedReason } : {},
    });
    return jsonWithCors(request, { creditNotePostingId: posting.id, eventType, ...result, ...(!result.queued ? { error: result.blockedReason } : {}) }, { status: result.queued ? 201 : 409 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    return rulebookErrorResponse(request, error, "recover verified Credit Note notification");
  }
}
