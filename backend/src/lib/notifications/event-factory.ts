import { randomUUID } from "node:crypto";

import { messageBlockedReason } from "./eligibility";
import { templatePreview } from "./template-renderer";
import type { NotificationEventType, NotificationMessageRow } from "./types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type ProposalState = {
  id: string;
  scheme_type: string;
  status: string;
  shortfall_amount: string | number;
  eligibility_deadline: string | null;
  achieved_tier_id: string | null;
};
type PostingState = { id: string; status: string };

export async function queueInitialNotification(input: {
  companyId: string;
  proposalId: string;
  eventType: NotificationEventType;
  creditNotePostingId?: string | null;
  actorId?: string | null;
}) {
  const supabase = createSupabaseAdminClient();
  const { data: proposalData, error: proposalError } = await supabase
    .from("discount_proposals")
    .select("id, scheme_type, status, shortfall_amount, eligibility_deadline, achieved_tier_id")
    .eq("id", input.proposalId).eq("company_id", input.companyId).maybeSingle();
  if (proposalError) throw proposalError;
  const proposal = proposalData as ProposalState | null;
  if (!proposal) throw new Error("Proposal not found.");
  let posting: PostingState | null = null;
  if (input.creditNotePostingId) {
    const { data, error } = await supabase.from("credit_note_postings").select("id, status")
      .eq("id", input.creditNotePostingId).eq("proposal_id", proposal.id).eq("company_id", input.companyId).maybeSingle();
    if (error) throw error;
    posting = data as PostingState | null;
  }
  const blockedReason = messageBlockedReason(input.eventType, proposal, posting);
  if (blockedReason) return { messageId: null, queued: false, blockedReason };

  const { data, error } = await supabase.rpc("enqueue_phase_6_notification", {
    p_company_id: input.companyId,
    p_proposal_id: proposal.id,
    p_event_type: input.eventType,
    p_credit_note_posting_id: input.creditNotePostingId ?? null,
    p_created_by: input.actorId ?? null,
  });
  if (error) throw error;
  return data ? { messageId: String(data), queued: true, blockedReason: null } : {
    messageId: null,
    queued: false,
    blockedReason: "No active opted-in contact and approved template are available for this event.",
  };
}

export async function resendNotification(input: {
  companyId: string;
  notificationMessageId: string;
  actorId: string;
  reason: string;
  resendKey?: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("resend_phase_6_notification", {
    p_notification_message_id: input.notificationMessageId,
    p_company_id: input.companyId,
    p_actor_id: input.actorId,
    p_reason: input.reason,
    p_resend_key: input.resendKey ?? randomUUID(),
  });
  if (error) throw error;
  return String(data);
}

export function createMessagePreview(message: Pick<NotificationMessageRow, "event_type" | "payload" | "template_snapshot">) {
  return templatePreview(message.event_type, message.payload, message.template_snapshot.componentSchema);
}
