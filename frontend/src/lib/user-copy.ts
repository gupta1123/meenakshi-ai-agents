import { ApiError } from "./api";
import { tallyReadErrorMessage } from "./tod-calculation";

const labels: Record<string, string> = {
  awaiting_pairing: "Connecting",
  bridge_stale: "Connection needs attention",
  company_mismatch: "Open the selected company",
  connection_check_failed: "Could not check Tally connection",
  completed_with_issues: "Needs attention",
  created_verified: "Created and checked",
  dead_letter: "Needs attention",
  not_bound: "Not connected",
  pending_approval: "Ready to create",
  review_invalidated: "Needs a new review",
  review_only: "Review mode",
  sending_to_tally: "Creating in Tally",
  verification_pending: "Checking in Tally",
  whatsapp_pending: "Preparing WhatsApp",
  cd_shortfall: "Cash Discount reminder",
  cd_credit_note_created: "Cash Discount Credit Note",
  tod_credit_note_created: "Turnover Discount Credit Note",
  cd_debit_note_created: "Debit Note",
  tod_tier_reached: "Turnover Discount tier update",
  cash_discount_narration_check_disabled: "Invoice narration was not checked",
  cash_discount_narration_missing: "Cash Discount terms were not found in the invoice narration",
  cash_discount_narration_conflict: "Invoice narration differs from the approved rule",
  cash_discount_narration_matches_rule: "Invoice narration matches the approved rule",
  recommended_action_credit_note: "Create a Credit Note as Administrator",
  recommended_action_debit_note: "Recover the upfront discount with a Debit Note",
  recommended_action_collect_balance: "Collect the remaining invoice balance",
  recommended_action_send_shortfall_reminder: "Remind the customer about the payment shortfall",
  recommended_action_keep_tracking: "Keep tracking payment",
  recommended_action_finance_review: "Administrator review is required",
  recommended_action_none: "No accounting voucher is required",
};

const technicalLanguage = /\b(api|bridge|command|connector|credential|database|endpoint|exception|failed to fetch|heartbeat|http|idempotency|jwt|lan|metadata|outbox|payload|postgres|provider|raw|rls|runtime|server|sha-?256|sql|supabase|sync|uuid|voucher|worker|xml)\b/i;

export function userLabel(value: string) {
  return labels[value] ?? value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function userFacingError(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    const apiMessage = cause.body && typeof cause.body === "object" && typeof (cause.body as Record<string, unknown>).error === "string"
      ? (cause.body as Record<string, unknown>).error as string
      : null;
    if (cause.status === 401) return "Your session has ended. Please sign in again.";
    if (cause.status === 403) return "You do not have permission to complete that action.";
    const tallyMessage = tallyReadErrorMessage(apiMessage);
    if (tallyMessage) return tallyMessage;
    if (cause.status === 404) return "That item is no longer available. Refresh the page and try again.";
    if (cause.status === 409) return apiMessage && !technicalLanguage.test(apiMessage) ? apiMessage : "This has changed since you opened it. Refresh the page and try again.";
    if (cause.status === 422) return apiMessage && !technicalLanguage.test(apiMessage) ? apiMessage : fallback;
    if (cause.status === 429) return "Please wait a moment, then try again.";
    if (cause.status >= 500) return "We could not complete that right now. Please try again.";
    return fallback;
  }

  const tallyMessage = cause instanceof Error ? tallyReadErrorMessage(cause.message) : null;
  if (tallyMessage) return tallyMessage;
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError" || /timed out/i.test(cause.message))) {
    return fallback;
  }
  if (cause instanceof Error && cause.message && !technicalLanguage.test(cause.message)) return cause.message;
  return fallback;
}

export function userFacingDetail(value: string | null | undefined, fallback: string) {
  const tallyMessage = tallyReadErrorMessage(value);
  if (tallyMessage) return tallyMessage;
  if (/not approved in MSG91/i.test(value ?? "")) return "The selected WhatsApp template is not approved in MSG91. Choose an approved template in Messages.";
  if (/requires a (?:Credit Note|verified note) PDF/i.test(value ?? "")) return "Prepare the PDF from the Tally-verified note before sending this WhatsApp message.";
  if (/provider template ID|approved template requires|template component/i.test(value ?? "")) return "WhatsApp template setup is incomplete. Ask an administrator to configure the approved template in Messages before retrying.";
  if (/\blease\b|\bnot leased\b/i.test(value ?? "")) return "The calculation stopped before saving. Review its status and run a new check.";
  return value && !technicalLanguage.test(value) ? value : fallback;
}
