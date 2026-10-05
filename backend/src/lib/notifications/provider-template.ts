import { fetchMsg91WhatsappTemplates, getMsg91Config } from "./msg91-client";
import { readTemplateComponentSchema } from "./template-renderer";
import type { TemplateSnapshot } from "./types";

type ProviderLanguage = {
  language?: string;
  status?: string;
  variables?: string[];
  variable_type?: Record<string, { type?: string }>;
};
type ProviderTemplate = { name?: string; languages?: ProviderLanguage[] };

let catalogCache: { expiresAt: number; templates: ProviderTemplate[] } | null = null;

async function approvedCatalog() {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.templates;
  const response = await fetchMsg91WhatsappTemplates();
  const templates = Array.isArray(response?.data) ? response.data as ProviderTemplate[] : [];
  catalogCache = { expiresAt: Date.now() + 30_000, templates };
  return templates;
}

export function providerTemplateProblem(template: TemplateSnapshot, catalog: ProviderTemplate[], hasDocument?: boolean) {
  const name = template.providerTemplateId?.trim();
  if (!name) return "An approved WhatsApp template has not been selected.";
  const provider = catalog.find((item) => item.name === name);
  const language = provider?.languages?.find((item) => item.language === (template.languageCode || "en") && item.status?.toLowerCase() === "approved");
  if (!language) return `WhatsApp template ${name} is not approved in MSG91 for ${template.languageCode || "en"}. Choose an approved template in Messages.`;

  const components = readTemplateComponentSchema(template.componentSchema).components ?? [];
  const configured = new Map(components.map((item) => [item.component, item]));
  const approvedVariables = new Set(language.variables ?? []);
  for (const component of components) {
    if (!approvedVariables.has(component.component)) return `The ${component.component} mapping is not part of the approved MSG91 template. Remove that mapping in Messages.`;
  }
  for (const variable of language.variables ?? []) {
    const component = configured.get(variable);
    if (!component) return `The selected MSG91 template needs ${variable}. Update its variable mapping in Messages.`;
    const document = language.variable_type?.[variable]?.type?.toLowerCase() === "document";
    if (document && component.type !== "document") return `The selected MSG91 template needs a PDF for ${variable}. Update its mapping in Messages.`;
    if (!document && component.type === "document") return `The ${variable} mapping must contain text, not a PDF.`;
    if (document && hasDocument === false) return "This approved WhatsApp template requires a verified note PDF. Prepare the PDF from the Tally-verified voucher before sending.";
  }
  return null;
}

export async function liveProviderTemplateProblem(template: TemplateSnapshot, hasDocument?: boolean) {
  if (getMsg91Config().transport === "mock") return null;
  return providerTemplateProblem(template, await approvedCatalog(), hasDocument);
}
