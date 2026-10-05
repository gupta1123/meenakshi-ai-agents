import type { NotificationEventType, NotificationPayload } from "./types";

const E164 = /^\+[1-9]\d{7,14}$/;

/** Contacts are stored as E.164. Never infer a country code in the sender. */
export function normalizeStoredE164(value: unknown) {
  const text = String(value ?? "").trim().replace(/[\s()-]/g, "");
  return E164.test(text) ? text : null;
}

export function msg91Recipient(value: unknown) {
  const phone = normalizeStoredE164(value);
  return phone ? phone.slice(1) : null;
}

export function canQueueNotification(eventType: NotificationEventType, proposal: {
  scheme_type?: string | null;
  status?: string | null;
  shortfall_amount?: string | number | null;
  eligibility_deadline?: string | null;
  achieved_tier_id?: string | null;
}, posting?: { status?: string | null } | null) {
  if (eventType === "cd_debit_note_created") return posting?.status === "created_verified";
  if (eventType === "cd_shortfall") {
    // Product decision confirmed on 25 Aug 2026: an open Cash Discount
    // invoice may receive a reminder even before it reaches 80% payment.
    // Expired, credited and review cases remain excluded.
    return proposal.scheme_type === "cd"
      && ["unpaid", "partially_paid", "near_eligibility"].includes(String(proposal.status ?? ""))
      && Number(proposal.shortfall_amount ?? 0) > 0
      && (!proposal.eligibility_deadline || proposal.eligibility_deadline >= new Date().toISOString().slice(0, 10));
  }
  if (eventType === "tod_tier_reached") {
    // A TOD tier may be reached while the period is still being tracked.
    // This deliberately does not claim that a Credit Note has been created.
    return proposal.scheme_type === "tod"
      && ["tracking", "eligible"].includes(String(proposal.status ?? ""))
      && Boolean(proposal.achieved_tier_id);
  }
  const correctScheme = eventType === "cd_credit_note_created" ? proposal.scheme_type === "cd" : proposal.scheme_type === "tod";
  return correctScheme && posting?.status === "created_verified";
}

export function messageBlockedReason(eventType: NotificationEventType, proposal: {
  scheme_type?: string | null;
  status?: string | null;
  shortfall_amount?: string | number | null;
}, posting?: { status?: string | null } | null) {
  if (canQueueNotification(eventType, proposal, posting)) return null;
  if (eventType === "cd_shortfall") return "Cash Discount reminder is blocked because the invoice is not currently open with a positive amount still to settle.";
  if (eventType === "tod_tier_reached") return "Turnover Discount update is blocked because the customer has not currently reached a tier in a valid evaluation.";
  if (eventType === "cd_debit_note_created") return "Debit Note is not yet verified in Tally. No WhatsApp message can be queued.";
  return "Credit Note is not yet verified in Tally. No WhatsApp message can be queued.";
}

function decimal(value: unknown, fractionDigits = 2) {
  const parsed = Number(value ?? 0);
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(Number.isFinite(parsed) ? parsed : 0);
}

export function previewValues(payload: NotificationPayload) {
  const period = payload.todPeriodStart && payload.todPeriodEnd ? `${payload.todPeriodStart} to ${payload.todPeriodEnd}` : "";
  return {
    ...payload,
    // Raw amount fields are used by provider templates that already contain
    // the ₹ symbol. Keep the Indian number formatting but never duplicate it.
    paidAmount: decimal(payload.paidAmount),
    benefitAmount: decimal(payload.benefitAmount),
    shortfallAmount: decimal(payload.shortfallAmount),
    creditNoteAmount: decimal(payload.creditNoteAmount),
    paidAmountDisplay: `₹${decimal(payload.paidAmount)}`,
    benefitAmountDisplay: `₹${decimal(payload.benefitAmount)}`,
    shortfallAmountDisplay: `₹${decimal(payload.shortfallAmount)}`,
    creditNoteAmountDisplay: `₹${decimal(payload.creditNoteAmount)}`,
    debitNoteAmountDisplay: `₹${decimal(payload.debitNoteAmount)}`,
    todTonnesDisplay: payload.todTonnes === null || payload.todTonnes === undefined ? "" : decimal(payload.todTonnes, 3),
    todPeriodDisplay: period,
  } as Record<string, unknown>;
}
