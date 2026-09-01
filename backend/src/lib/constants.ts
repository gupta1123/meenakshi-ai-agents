export const MEENAKSHI_FEATURE = "meenakshi_discounts";

export const MEENAKSHI_ROLES = ["administrator", "finance_approver"] as const;
export type MeenakshiRole = (typeof MEENAKSHI_ROLES)[number];

export const TALLY_COMMAND_TYPES = [
  "sync_meenakshi_masters",
  "sync_meenakshi_vouchers",
  "fetch_meenakshi_evidence",
  "create_credit_note",
  "verify_credit_note",
  "export_credit_note_pdf",
  "create_debit_note",
] as const;
export type TallyCommandType = (typeof TALLY_COMMAND_TYPES)[number];

export const TALLY_OUTBOX_EVENT_TYPES = [
  "tally_masters_sync",
  "tally_vouchers_sync",
  "tally_credit_note_create",
  "tally_credit_note_verify",
  "tally_credit_note_pdf",
  "tally_debit_note_create",
  "tally_targeted_refresh",
] as const;

export const BRIDGE_HEARTBEAT_STALE_MS = 90_000;
export const TALLY_SYNC_STALE_MS = 24 * 60 * 60 * 1_000;
