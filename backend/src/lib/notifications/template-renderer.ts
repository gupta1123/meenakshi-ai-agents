import { previewValues } from "./eligibility";
import type { NotificationEventType, NotificationPayload, TemplateComponent, TemplateComponentSchema, TemplateSnapshot } from "./types";

const defaultComponents: Record<NotificationEventType, TemplateComponent[]> = {
  cd_shortfall: [
    { component: "body_var_1", value: "customerName" },
    { component: "body_var_2", value: "paidAmountDisplay" },
    { component: "body_var_3", value: "benefitAmountDisplay" },
    { component: "body_var_4", value: "shortfallAmountDisplay" },
    { component: "body_var_5", value: "eligibilityDeadline" },
  ],
  cd_credit_note_created: [
    { component: "body_var_1", value: "customerName" },
    { component: "body_var_2", value: "creditNoteNumber" },
    { component: "body_var_3", value: "creditNoteDate" },
    { component: "body_var_4", value: "creditNoteAmountDisplay" },
    { component: "body_var_5", value: "invoiceReference" },
  ],
  cd_debit_note_created: [
    { component: "body_var_1", value: "customerName" },
    { component: "body_var_2", value: "debitNoteNumber" },
    { component: "body_var_3", value: "debitNoteDate" },
    { component: "body_var_4", value: "debitNoteAmountDisplay" },
    { component: "body_var_5", value: "invoiceReference" },
  ],
  tod_tier_reached: [
    { component: "body_var_1", value: "customerName" },
    { component: "body_var_2", value: "todTierPercentage" },
    { component: "body_var_3", value: "todPeriodDisplay" },
    { component: "body_var_4", value: "todTonnesDisplay" },
    // The proposed MSG91 body already includes the ₹ symbol.
    { component: "body_var_5", value: "benefitAmount" },
  ],
  tod_credit_note_created: [
    { component: "body_var_1", value: "customerName" },
    { component: "body_var_2", value: "creditNoteNumber" },
    { component: "body_var_3", value: "creditNoteAmountDisplay" },
    { component: "body_var_4", value: "todPeriodDisplay" },
    { component: "body_var_5", value: "todTonnesDisplay" },
  ],
};

export class TemplateConfigurationError extends Error {
  readonly retryable = false;
}

function nonEmptyText(value: unknown, field: string) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!text) throw new TemplateConfigurationError(`Approved template requires the ${field} value, but it is not available for this message.`);
  return text;
}

export function readTemplateComponentSchema(value: unknown): TemplateComponentSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = (value as { components?: unknown }).components;
  if (!Array.isArray(raw)) return {};
  const components = raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Template component schema entries must be objects.");
    const row = item as Record<string, unknown>;
    const component = nonEmptyText(row.component, "component");
    const variable = nonEmptyText(row.value, "value");
    const type = row.type === "document" ? "document" : "text";
    const filenameValue = row.filenameValue === undefined ? undefined : nonEmptyText(row.filenameValue, "filenameValue");
    return { component, value: variable, type, filenameValue } satisfies TemplateComponent;
  });
  if (new Set(components.map((item) => item.component)).size !== components.length) throw new Error("Template component names must be unique.");
  return { components };
}

export function templatePreview(eventType: NotificationEventType, payload: NotificationPayload, schema?: unknown) {
  const values = previewValues(payload);
  const configured = readTemplateComponentSchema(schema).components;
  const components = configured && configured.length > 0 ? configured : defaultComponents[eventType];
  return components.map((component) => ({
    component: component.component,
    type: component.type ?? "text",
    value: component.type === "document"
      ? typeof values[component.value] === "string" ? "PDF link will be added only when verified evidence is available." : "PDF omitted: verified evidence is unavailable."
      : String(values[component.value] ?? ""),
    variable: component.value,
  }));
}

/** Builds the MSG91 to_and_components envelope from an approved template snapshot. */
export function renderMsg91Template(input: {
  eventType: NotificationEventType;
  recipient: string;
  payload: NotificationPayload;
  template: TemplateSnapshot;
}) {
  const providerTemplateId = nonEmptyText(input.template.providerTemplateId, "provider template ID");
  const languageCode = nonEmptyText(input.template.languageCode ?? "en", "language code");
  const values = previewValues(input.payload);
  const configured = readTemplateComponentSchema(input.template.componentSchema).components;
  const components = configured && configured.length > 0 ? configured : defaultComponents[input.eventType];
  const mapped: Record<string, { type: "text" | "document"; value: string; filename?: string }> = {};

  for (const component of components) {
    const type = component.type ?? "text";
    const raw = values[component.value];
    if (type === "document" && (raw === null || raw === undefined || raw === "")) continue;
    const value = nonEmptyText(raw, component.value);
    mapped[component.component] = type === "document"
      ? { type, value, filename: component.filenameValue ? nonEmptyText(values[component.filenameValue], component.filenameValue) : undefined }
      : { type, value };
  }

  return {
    messaging_product: "whatsapp",
    type: "template",
    template: {
      name: providerTemplateId,
      language: { code: languageCode, policy: "deterministic" },
      ...(input.template.namespace ? { namespace: input.template.namespace } : {}),
      to_and_components: [{ to: [input.recipient], components: mapped }],
    },
  };
}
