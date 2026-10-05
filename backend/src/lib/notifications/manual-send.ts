import { randomUUID } from "node:crypto";

import type { requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { prepareCreditNoteDocument, prepareDebitNoteDocument } from "@/lib/notes/verified-note-document.mjs";
import { appendRulebookAudit } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { liveProviderTemplateProblem } from "./provider-template";
import type { NotificationEventType } from "./types";

type Scope = Awaited<ReturnType<typeof requireMeenakshiCompanyAccess>>;
type Supabase = ReturnType<typeof createSupabaseAdminClient>;

export type ManualSendItem =
  | { kind: "credit_note"; postingId: string; phone: string }
  | { kind: "debit_note"; postingId: string; phone: string }
  | { kind: "cd_reminder"; evaluationRunId: string; customerName: string; invoiceNumber: string; invoiceDate: string; billReference: string; phone: string };

export type ManualSendResult = { ok: true; messageId: string; recipient: string } | { ok: false; error: string; code: string };

/** A message could not be sent for a reason the administrator can act on. */
export class ManualSendProblem extends Error {
  constructor(message: string, readonly code = "blocked") { super(message); }
}

const EVENT_LABELS: Record<NotificationEventType, string> = {
  cd_shortfall: "Cash Discount reminders",
  cd_credit_note_created: "Cash Discount Credit Notes",
  cd_debit_note_created: "Debit Notes",
  tod_tier_reached: "Turnover Discount tier updates",
  tod_credit_note_created: "Turnover Discount Credit Notes",
};

/**
 * Accepts what people actually type: "98765 43210", "09876543210",
 * "919876543210" or "+91 98765 43210". A bare 10-digit number is Indian.
 */
export function normalizeRecipient(value: unknown) {
  const raw = String(value ?? "").trim().replace(/[\s().-]/g, "");
  if (!raw) return null;
  const international = raw.startsWith("+") || raw.startsWith("00");
  let digits = raw.replace(/^\+|^00/, "");
  if (!/^\d+$/.test(digits)) return null;
  if (!international) {
    if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    if (digits.length === 10) digits = `91${digits}`;
  }
  const e164 = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

async function approvedTemplate(supabase: Supabase, organizationId: string, eventType: NotificationEventType) {
  const { data, error } = await supabase.from("whatsapp_templates")
    .select("id, provider_template_id, language_code, component_schema")
    .eq("organization_id", organizationId).eq("event_type", eventType).eq("is_active", true)
    .limit(1).maybeSingle();
  if (error) throw error;
  if (!data?.provider_template_id?.trim()) {
    throw new ManualSendProblem(`No approved WhatsApp template is set up for ${EVENT_LABELS[eventType]}. Add one in Messages → Approved templates.`, "template_missing");
  }
  return data as { id: string; provider_template_id: string; language_code: string | null; component_schema: unknown };
}

async function checkTemplate(template: Awaited<ReturnType<typeof approvedTemplate>>, hasDocument?: boolean) {
  const problem = await liveProviderTemplateProblem({
    providerTemplateId: template.provider_template_id,
    languageCode: template.language_code ?? undefined,
    componentSchema: template.component_schema as never,
  }, hasDocument);
  if (problem) throw new ManualSendProblem(problem, "template_problem");
}

/**
 * Makes the typed number the customer's active primary WhatsApp contact and
 * records the administrator's send as the opt-in, so the message is delivered
 * to exactly that number.
 */
async function ensureRecipient(supabase: Supabase, scope: Scope, customerId: string, phone: string) {
  const companyId = scope.company.id;
  const { data: existing, error: existingError } = await supabase.from("customer_contacts")
    .select("id, is_primary, is_active")
    .eq("company_id", companyId).eq("customer_id", customerId).eq("phone_e164", phone)
    .order("entered_at", { ascending: false }).limit(1).maybeSingle();
  if (existingError) throw existingError;

  const unsetOtherPrimaries = async (keepId?: string) => {
    let query = supabase.from("customer_contacts").update({ is_primary: false })
      .eq("company_id", companyId).eq("customer_id", customerId).eq("is_primary", true);
    if (keepId) query = query.neq("id", keepId);
    const { error } = await query;
    if (error) throw error;
  };

  let contactId: string;
  if (existing) {
    contactId = existing.id;
    if (!existing.is_primary || !existing.is_active) {
      await unsetOtherPrimaries(contactId);
      const { error } = await supabase.from("customer_contacts").update({ is_primary: true, is_active: true }).eq("id", contactId).eq("company_id", companyId);
      if (error) throw error;
    }
  } else {
    await unsetOtherPrimaries();
    const { data, error } = await supabase.from("customer_contacts").insert({
      company_id: companyId, customer_id: customerId, phone_e164: phone,
      source: "controlled_manual_update", is_primary: true, is_active: true, entered_by: scope.userId,
    }).select("id").single();
    if (error) throw error;
    contactId = data.id;
    await appendRulebookAudit({ scope, action: "customer_contact_added", entityType: "customer_contact", entityId: contactId, newValue: { customerId, phoneE164: phone, source: "manual_whatsapp_send" } });
  }

  const { data: optIn, error: optInError } = await supabase.from("whatsapp_opt_ins").select("id")
    .eq("company_id", companyId).eq("customer_contact_id", contactId).eq("is_opted_in", true).is("revoked_at", null)
    .limit(1).maybeSingle();
  if (optInError) throw optInError;
  if (!optIn) {
    const { error } = await supabase.from("whatsapp_opt_ins").insert({
      company_id: companyId, customer_contact_id: contactId, is_opted_in: true,
      source: "Number entered by administrator when sending", recorded_at: new Date().toISOString(),
      evidence: { workflow: "manual_whatsapp_send", enteredBy: scope.userId }, revoked_at: null,
    });
    if (error) throw error;
  }
  return contactId;
}

async function insertMessage(supabase: Supabase, row: Record<string, unknown>) {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("notification_messages").insert({
    ...row, opt_in_snapshot: {}, status: "queued", scheduled_for: now, available_at: now,
  }).select("id").single();
  if (error) throw error;
  return String(data.id);
}

async function customerName(supabase: Supabase, companyId: string, customerId: string) {
  const { data } = await supabase.from("customers").select("ledger_name").eq("id", customerId).eq("company_id", companyId).maybeSingle();
  return data?.ledger_name ?? "Customer";
}

async function sendCreditNote(supabase: Supabase, scope: Scope, postingId: string, phone: string) {
  const companyId = scope.company.id;
  const { data: posting, error } = await supabase.from("credit_note_postings")
    .select("id, proposal_id, customer_id, status, verified_voucher_number, credit_note_date, verified_amount, discount_amount, tally_bill_reference, document_storage_path")
    .eq("id", postingId).eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  if (!posting) throw new ManualSendProblem("This Credit Note was not found.", "not_found");
  if (posting.status !== "created_verified") throw new ManualSendProblem("This Credit Note is not confirmed in Tally yet.", "not_verified");
  const { data: proposal, error: proposalError } = await supabase.from("discount_proposals")
    .select("id, scheme_type, customer_id, period_start, period_end, eligible_tonnes, achieved_tier_id, source_sales_voucher_id")
    .eq("id", posting.proposal_id).eq("company_id", companyId).maybeSingle();
  if (proposalError) throw proposalError;
  if (!proposal) throw new ManualSendProblem("The calculation behind this Credit Note was not found.", "not_found");

  const eventType: NotificationEventType = proposal.scheme_type === "cd" ? "cd_credit_note_created" : "tod_credit_note_created";
  const template = await approvedTemplate(supabase, scope.organization.id, eventType);
  const hasDocument = await prepareCreditNoteDocument(supabase, companyId, posting.id).then(() => true, () => false);
  await checkTemplate(template, hasDocument);
  const contactId = await ensureRecipient(supabase, scope, proposal.customer_id, phone);

  let invoiceReference = posting.tally_bill_reference ?? "";
  if (proposal.source_sales_voucher_id) {
    const { data: voucher } = await supabase.from("tally_vouchers").select("voucher_number, tally_guid").eq("id", proposal.source_sales_voucher_id).eq("company_id", companyId).maybeSingle();
    invoiceReference = voucher?.voucher_number ?? voucher?.tally_guid ?? invoiceReference;
  }
  return insertMessage(supabase, {
    company_id: companyId, proposal_id: proposal.id, credit_note_posting_id: posting.id,
    customer_contact_id: contactId, whatsapp_template_id: template.id, event_type: eventType,
    business_event_key: `manual:credit_note:${posting.id}:${randomUUID()}`, recipient_phone_e164: phone,
    created_by: scope.userId,
    payload: {
      customerName: await customerName(supabase, companyId, proposal.customer_id), companyName: scope.company.tally_company_name,
      creditNoteNumber: posting.verified_voucher_number, creditNoteDate: posting.credit_note_date,
      creditNoteAmount: posting.verified_amount ?? posting.discount_amount, invoiceReference,
      todPeriodStart: proposal.period_start, todPeriodEnd: proposal.period_end, todTonnes: proposal.eligible_tonnes,
      todTierId: proposal.achieved_tier_id, documentStoragePath: posting.document_storage_path, eventType,
    },
  });
}

async function sendDebitNote(supabase: Supabase, scope: Scope, postingId: string, phone: string) {
  const companyId = scope.company.id;
  const { data: posting, error } = await supabase.from("cash_discount_debit_note_postings")
    .select("id, candidate_id, status, verified_voucher_number, debit_note_date, verified_amount, amount, note_kind")
    .eq("id", postingId).eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  // Per-MT Cash Discount Credit Notes share this table; they go out as Credit Notes.
  const isCreditNote = posting?.note_kind === "credit_note";
  const noteName = isCreditNote ? "Credit Note" : "Debit Note";
  if (!posting) throw new ManualSendProblem("This note was not found.", "not_found");
  if (posting.status !== "created_verified") throw new ManualSendProblem(`This ${noteName} is not confirmed in Tally yet.`, "not_verified");
  const { data: candidate, error: candidateError } = await supabase.from("cash_discount_recovery_candidates")
    .select("customer_tally_guid, customer_name, invoice_number, bill_reference")
    .eq("id", posting.candidate_id).eq("company_id", companyId).maybeSingle();
  if (candidateError) throw candidateError;
  if (!candidate) throw new ManualSendProblem(`The invoice behind this ${noteName} was not found.`, "not_found");
  const { data: customer, error: customerError } = await supabase.from("customers").select("id, ledger_name")
    .eq("company_id", companyId).eq("tally_ledger_guid", candidate.customer_tally_guid).maybeSingle();
  if (customerError) throw customerError;
  if (!customer) throw new ManualSendProblem(`${candidate.customer_name} is not in the latest customer list from Tally. Update customers from Tally, then send again.`, "customer_missing");

  const eventType: NotificationEventType = isCreditNote ? "cd_credit_note_created" : "cd_debit_note_created";
  const template = await approvedTemplate(supabase, scope.organization.id, eventType);
  const hasDocument = await prepareDebitNoteDocument(supabase, companyId, posting.id).then(() => true, () => false);
  await checkTemplate(template, hasDocument);
  const contactId = await ensureRecipient(supabase, scope, customer.id, phone);
  return insertMessage(supabase, {
    company_id: companyId, proposal_id: null, credit_note_posting_id: null, cash_discount_debit_note_posting_id: posting.id,
    customer_contact_id: contactId, whatsapp_template_id: template.id, event_type: eventType,
    business_event_key: `manual:${isCreditNote ? "cd_credit_note" : "debit_note"}:${posting.id}:${randomUUID()}`, recipient_phone_e164: phone,
    created_by: scope.userId,
    payload: isCreditNote ? {
      customerName: customer.ledger_name, companyName: scope.company.tally_company_name,
      creditNoteNumber: posting.verified_voucher_number, creditNoteDate: posting.debit_note_date,
      creditNoteAmount: posting.verified_amount ?? posting.amount,
      invoiceReference: candidate.invoice_number ?? candidate.bill_reference ?? "", eventType,
    } : {
      customerName: customer.ledger_name, companyName: scope.company.tally_company_name,
      debitNoteNumber: posting.verified_voucher_number, debitNoteDate: posting.debit_note_date,
      debitNoteAmount: posting.verified_amount ?? posting.amount,
      invoiceReference: candidate.invoice_number ?? candidate.bill_reference ?? "", eventType,
    },
  });
}

type ReminderRow = { customerName: string; invoiceNumber: string | null; invoiceDate: string; billReference: string; amountPaid: string; shortfallAmount: string; eligibilityDeadline: string; reasonCode: string };

function reminderFromRun(summary: unknown, item: Extract<ManualSendItem, { kind: "cd_reminder" }>) {
  const rows = summary && typeof summary === "object" ? (summary as { openReminderCandidates?: unknown }).openReminderCandidates : null;
  if (!Array.isArray(rows)) return null;
  return (rows as ReminderRow[]).find((row) => row && row.customerName === item.customerName
    && String(row.invoiceNumber ?? "") === item.invoiceNumber && row.invoiceDate?.slice(0, 10) === item.invoiceDate
    && row.billReference === item.billReference) ?? null;
}

async function sendCdReminder(supabase: Supabase, scope: Scope, item: Extract<ManualSendItem, { kind: "cd_reminder" }>, phone: string) {
  const companyId = scope.company.id;
  const { data: run, error: runError } = await supabase.from("evaluation_runs")
    .select("id, scheme_version_id, source_fingerprint, summary")
    .eq("id", item.evaluationRunId).eq("company_id", companyId).maybeSingle();
  if (runError) throw runError;
  const reminder = run ? reminderFromRun(run.summary, item) : null;
  if (!run?.scheme_version_id || !reminder) throw new ManualSendProblem("This reminder is no longer in the latest Cash Discount check. Check Tally again, then send.", "stale");
  if (reminder.eligibilityDeadline < new Date().toISOString().slice(0, 10)) throw new ManualSendProblem("The payment deadline for this invoice has passed, so a reminder can no longer help.", "expired");

  const { data: customer, error: customerError } = await supabase.from("customers").select("id, ledger_name, current_customer_group_id")
    .eq("company_id", companyId).eq("ledger_name", reminder.customerName).eq("is_available", true).maybeSingle();
  if (customerError) throw customerError;
  if (!customer) throw new ManualSendProblem(`${reminder.customerName} is not in the latest customer list from Tally. Update customers from Tally, then send again.`, "customer_missing");
  const { data: voucher, error: voucherError } = await supabase.from("tally_vouchers").select("id, voucher_number")
    .eq("company_id", companyId).eq("party_customer_id", customer.id).eq("voucher_kind", "sales")
    .eq("voucher_number", reminder.invoiceNumber).eq("voucher_date", reminder.invoiceDate).maybeSingle();
  if (voucherError) throw voucherError;
  if (!voucher) throw new ManualSendProblem("This invoice has not been copied from Tally yet.", "invoice_not_synced");

  const template = await approvedTemplate(supabase, scope.organization.id, "cd_shortfall");
  await checkTemplate(template);
  const contactId = await ensureRecipient(supabase, scope, customer.id, phone);

  const now = new Date().toISOString();
  const reminderFields = {
    status: "unpaid", eligibility_deadline: reminder.eligibilityDeadline, invoice_amount_due: reminder.shortfallAmount,
    amount_paid_by_deadline: reminder.amountPaid, discounted_settlement_target: reminder.shortfallAmount,
    shortfall_amount: reminder.shortfallAmount, latest_evaluated_at: now, last_live_refresh_at: now, last_manual_change_by: scope.userId,
  };
  const { data: existing, error: existingError } = await supabase.from("discount_proposals").select("id")
    .eq("company_id", companyId).eq("customer_id", customer.id).eq("source_sales_voucher_id", voucher.id)
    .eq("scheme_version_id", run.scheme_version_id).eq("scheme_type", "cd").maybeSingle();
  if (existingError) throw existingError;
  let proposalId = existing?.id as string | undefined;
  if (proposalId) {
    const { error } = await supabase.from("discount_proposals").update(reminderFields).eq("id", proposalId).eq("company_id", companyId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase.from("discount_proposals").insert({
      ...reminderFields, company_id: companyId, customer_id: customer.id, scheme_version_id: run.scheme_version_id,
      scheme_type: "cd", source_sales_voucher_id: voucher.id,
      entitlement_key: `live-cd-reminder:${run.scheme_version_id}:${voucher.id}`,
      source_fingerprint: run.source_fingerprint || `live-cd:${run.id}`,
      customer_group_id_used: customer.current_customer_group_id, calculated_discount_amount: 0, reason_codes: [reminder.reasonCode],
    }).select("id").single();
    if (error) throw error;
    proposalId = String(data.id);
  }

  // Until the manual-sending migration is applied, the old database trigger
  // may already have queued this reminder while the proposal was saved.
  const { data: automatic } = await supabase.from("notification_messages").select("id, created_at")
    .eq("company_id", companyId).eq("business_event_key", `phase6:cd_shortfall:${proposalId}`).eq("status", "queued").maybeSingle();
  if (automatic && Date.now() - new Date(automatic.created_at).getTime() < 120_000) return String(automatic.id);

  return insertMessage(supabase, {
    company_id: companyId, proposal_id: proposalId, credit_note_posting_id: null,
    customer_contact_id: contactId, whatsapp_template_id: template.id, event_type: "cd_shortfall",
    business_event_key: `manual:cd_reminder:${proposalId}:${randomUUID()}`, recipient_phone_e164: phone,
    created_by: scope.userId,
    payload: {
      customerName: customer.ledger_name, companyName: scope.company.tally_company_name,
      invoiceReference: voucher.voucher_number ?? reminder.billReference, paidAmount: reminder.amountPaid,
      benefitAmount: 0, shortfallAmount: reminder.shortfallAmount, eligibilityDeadline: reminder.eligibilityDeadline, eventType: "cd_shortfall",
    },
  });
}

export async function sendManualWhatsApp(scope: Scope, item: ManualSendItem): Promise<ManualSendResult> {
  const phone = normalizeRecipient(item.phone);
  if (!phone) return { ok: false, error: "Enter a valid mobile number, for example 98765 43210 or +91 98765 43210.", code: "invalid_phone" };
  const supabase = createSupabaseAdminClient();
  try {
    const messageId = item.kind === "credit_note" ? await sendCreditNote(supabase, scope, item.postingId, phone)
      : item.kind === "debit_note" ? await sendDebitNote(supabase, scope, item.postingId, phone)
      : await sendCdReminder(supabase, scope, item, phone);
    await appendRulebookAudit({
      scope, action: "manual_whatsapp_queued", entityType: "notification_message", entityId: messageId,
      newValue: { kind: item.kind, recipient: phone, source: item.kind === "cd_reminder" ? item.billReference : item.postingId },
    });
    return { ok: true, messageId, recipient: phone };
  } catch (error) {
    if (error instanceof ManualSendProblem) return { ok: false, error: error.message, code: error.code };
    console.error("Could not queue manual WhatsApp message:", error);
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "The message could not be queued.";
    return { ok: false, error: message, code: "failed" };
  }
}
