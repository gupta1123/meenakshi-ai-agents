import { randomUUID } from "node:crypto";

import { messageBlockedReason } from "./eligibility";
import { templatePreview } from "./template-renderer";
import { notificationTemplateBlock } from "./template-readiness";
import { liveProviderTemplateProblem } from "./provider-template";
import type { NotificationEventType, NotificationMessageRow } from "./types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type ProposalState = {
  id: string;
  scheme_type: string;
  status: string;
  shortfall_amount: string | number;
  eligibility_deadline: string | null;
  achieved_tier_id: string | null;
  discount_percentage: string | number | null;
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
    .select("id, scheme_type, status, shortfall_amount, eligibility_deadline, achieved_tier_id, discount_percentage")
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
  if (input.eventType === "tod_tier_reached" && (!proposal.discount_percentage || Number(proposal.discount_percentage) <= 0))
    return { messageId: null, queued: false, blockedReason: "This rule pays a fixed amount per tonne, but the approved WhatsApp template describes a percentage. Configure a matching fixed-rate template before sending a tier update." };
  const templateBlock = await notificationTemplateBlock(input.companyId, input.eventType);
  if (templateBlock) return { messageId: null, queued: false, blockedReason: templateBlock };
  if (input.creditNotePostingId) {
    const { data: document, error: documentError } = await supabase.from("credit_note_documents")
      .select("status,storage_path").eq("credit_note_posting_id", input.creditNotePostingId).maybeSingle();
    if (documentError) throw documentError;
    const { data: template, error: templateError } = await supabase.from("whatsapp_templates")
      .select("provider_template_id,language_code,component_schema").eq("organization_id", (await supabase.from("companies").select("organization_id").eq("id", input.companyId).single()).data?.organization_id)
      .eq("event_type", input.eventType).eq("is_active", true).limit(1).maybeSingle();
    if (templateError) throw templateError;
    if (template) {
      const documentBlock = await liveProviderTemplateProblem({ providerTemplateId: template.provider_template_id, languageCode: template.language_code, componentSchema: template.component_schema }, document?.status === "verified" && Boolean(document.storage_path));
      if (documentBlock) return { messageId: null, queued: false, blockedReason: documentBlock };
    }
  }

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
  const supabase = createSupabaseAdminClient();
  const { data: original, error: originalError } = await supabase.from("notification_messages")
    .select("event_type,credit_note_posting_id,payload").eq("id", input.notificationMessageId).eq("company_id", input.companyId).single();
  if (originalError) throw originalError;
  const templateBlock = await notificationTemplateBlock(input.companyId, original.event_type);
  if (templateBlock) throw new Error(templateBlock);
  if (original.credit_note_posting_id) {
    const { data: document, error: documentError } = await supabase.from("credit_note_documents")
      .select("status,storage_path").eq("credit_note_posting_id", original.credit_note_posting_id).maybeSingle();
    if (documentError) throw documentError;
    const { data: company, error: companyError } = await supabase.from("companies").select("organization_id").eq("id", input.companyId).single();
    if (companyError) throw companyError;
    const { data: template, error: templateError } = await supabase.from("whatsapp_templates")
      .select("provider_template_id,language_code,component_schema").eq("organization_id", company.organization_id)
      .eq("event_type", original.event_type).eq("is_active", true).limit(1).maybeSingle();
    if (templateError) throw templateError;
    if (template) {
      const documentBlock = await liveProviderTemplateProblem({ providerTemplateId: template.provider_template_id, languageCode: template.language_code, componentSchema: template.component_schema }, document?.status === "verified" && Boolean(document.storage_path));
      if (documentBlock) throw new Error(documentBlock);
    }
  }
  const { data, error } = await supabase.rpc("resend_phase_6_notification", {
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
