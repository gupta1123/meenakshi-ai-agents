export const notificationEventTypes = [
  "cd_shortfall",
  "cd_credit_note_created",
  "tod_tier_reached",
  "tod_credit_note_created",
] as const;

export type NotificationEventType = (typeof notificationEventTypes)[number];
export type NotificationStatus = "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "suppressed" | "cancelled";

export type NotificationPayload = {
  customerName?: string | null;
  companyName?: string | null;
  invoiceReference?: string | null;
  paidAmount?: string | number | null;
  benefitAmount?: string | number | null;
  shortfallAmount?: string | number | null;
  eligibilityDeadline?: string | null;
  creditNoteNumber?: string | null;
  creditNoteDate?: string | null;
  creditNoteAmount?: string | number | null;
  todPeriodStart?: string | null;
  todPeriodEnd?: string | null;
  todTonnes?: string | number | null;
  todTierId?: string | null;
  todTierPercentage?: string | number | null;
  documentStoragePath?: string | null;
  documentUrl?: string | null;
  documentName?: string | null;
  eventType?: NotificationEventType;
  [key: string]: unknown;
};

export type TemplateComponent = {
  component: string;
  value: string;
  type?: "text" | "document";
  filenameValue?: string;
};

export type TemplateComponentSchema = {
  components?: TemplateComponent[];
};

export type TemplateSnapshot = {
  templateId?: string;
  provider?: string;
  providerTemplateId?: string;
  eventType?: NotificationEventType;
  languageCode?: string;
  namespace?: string | null;
  version?: string;
  componentSchema?: TemplateComponentSchema;
};

export type NotificationMessageRow = {
  id: string;
  company_id: string;
  proposal_id: string;
  credit_note_posting_id: string | null;
  customer_contact_id: string;
  whatsapp_template_id: string;
  event_type: NotificationEventType;
  business_event_key: string;
  recipient_phone_e164: string;
  payload: NotificationPayload;
  template_snapshot: TemplateSnapshot;
  status: NotificationStatus;
  scheduled_for: string | null;
  available_at: string;
  attempt_count: number;
  max_attempts: number;
  locked_by: string | null;
  lease_expires_at: string | null;
  document_storage_path?: string | null;
};

export function isNotificationEventType(value: unknown): value is NotificationEventType {
  return typeof value === "string" && (notificationEventTypes as readonly string[]).includes(value);
}
