export type StatusTone = "good" | "attention" | "danger" | "neutral" | "info";

import { userLabel } from "./user-copy";

const staffStatuses: Record<string, { label: string; tone: StatusTone }> = {
  tracking: { label: "Tracking", tone: "info" },
  retained: { label: "Discount retained", tone: "good" },
  payment_due: { label: "Payment due", tone: "attention" },
  recovery_due: { label: "Debit Note required", tone: "danger" },
  near_eligibility: { label: "Near eligibility", tone: "attention" },
  eligible: { label: "Eligible", tone: "good" },
  partially_paid: { label: "Tracking", tone: "info" },
  unpaid: { label: "Tracking", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "attention" },
  review_invalidated: { label: "Needs review", tone: "attention" },
  deadline_expired: { label: "Deadline expired", tone: "danger" },
  pending_approval: { label: "Ready to create", tone: "attention" },
  queued: { label: "Queued", tone: "info" },
  refreshing_tally: { label: "Reading Tally", tone: "info" },
  evaluating: { label: "Calculating", tone: "info" },
  saving: { label: "Checking Tally", tone: "info" },
  sending: { label: "Sending", tone: "info" },
  verification_pending: { label: "Sending to Tally", tone: "info" },
  sending_to_tally: { label: "Sending to Tally", tone: "info" },
  created_verified: { label: "Created and verified", tone: "good" },
  whatsapp_pending: { label: "WhatsApp pending", tone: "attention" },
  whatsapp_sent: { label: "WhatsApp sent", tone: "good" },
  sent: { label: "WhatsApp sent", tone: "good" },
  delivered: { label: "WhatsApp sent", tone: "good" },
  read: { label: "WhatsApp sent", tone: "good" },
  failed: { label: "Failed", tone: "danger" },
  correction_required: { label: "Failed", tone: "danger" },
  dead_letter: { label: "Failed", tone: "danger" },
  already_credited: { label: "Already credited", tone: "neutral" },
  historical: { label: "Historical", tone: "neutral" },
  current: { label: "Current", tone: "good" },
  ready: { label: "Ready", tone: "good" },
  stale: { label: "Sync required", tone: "attention" },
  required: { label: "Sync required", tone: "attention" },
  not_bound: { label: "Not connected", tone: "attention" },
  awaiting_pairing: { label: "Connecting", tone: "attention" },
  bridge_stale: { label: "Connection needs attention", tone: "danger" },
  company_mismatch: { label: "Open the selected company", tone: "danger" },
  review_only: { label: "Review mode", tone: "info" },
  posting_enabled: { label: "Posting enabled", tone: "good" },
  expired: { label: "Expired", tone: "danger" },
  scheduled: { label: "Scheduled", tone: "info" },
  setup_incomplete: { label: "Setup incomplete", tone: "attention" },
};

export function staffStatusLabel(status: string) {
  return staffStatuses[status]?.label ?? userLabel(status);
}

export function toneForStaffStatus(status: string): StatusTone {
  return staffStatuses[status]?.tone ?? "neutral";
}

/** A notification queue is separate from the Tally Credit Note outbox. */
export function notificationStatusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: "WhatsApp queued",
    sending: "Sending WhatsApp",
    retrying: "WhatsApp retrying",
    suppressed: "WhatsApp not queued",
  };

  return labels[status] ?? staffStatusLabel(status);
}
