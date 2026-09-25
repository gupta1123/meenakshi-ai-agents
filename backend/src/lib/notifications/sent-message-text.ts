import { fetchMsg91WhatsappTemplates } from "./msg91-client";

// The approved MSG91 template text, filled with the values this message was
// sent with, so the Messages page shows exactly what the customer received.
type PreviewItem = { component: string; type: string; value: string; variable: string };
type ProviderTemplate = { body: string; headerFormat: string | null };

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; templates: Map<string, ProviderTemplate> } | null = null;

async function providerTemplates() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.templates;
  const payload = await fetchMsg91WhatsappTemplates() as { data?: unknown };
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const templates = new Map<string, ProviderTemplate>();
  for (const template of list as Array<{ name?: string; languages?: Array<{ language?: string; code?: Array<{ type?: string; text?: string; format?: string }> }> }>) {
    for (const language of template.languages ?? []) {
      const parts = language.code ?? [];
      const body = parts.find((part) => part.type === "BODY")?.text;
      if (!template.name || !body) continue;
      templates.set(`${template.name}:${language.language ?? "en"}`, { body, headerFormat: parts.find((part) => part.type === "HEADER")?.format ?? null });
    }
  }
  cache = { at: Date.now(), templates };
  return templates;
}

// body_1 / body_var_1 fill {{1}}; body_customer_name fills {{customer_name}}.
function placeholderKey(component: string) {
  const match = component.match(/^body_(?:var_)?(.+)$/);
  return match ? match[1] : null;
}

export async function sentMessageText(providerTemplateId: string | undefined, languageCode: string | undefined, preview: PreviewItem[]) {
  if (!providerTemplateId) return null;
  try {
    const template = (await providerTemplates()).get(`${providerTemplateId}:${languageCode || "en"}`);
    if (!template) return null;
    const values = new Map(preview.flatMap((item) => {
      const key = placeholderKey(item.component);
      return key ? [[key, item.value] as const] : [];
    }));
    const text = template.body.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (placeholder, key: string) => values.get(key) || placeholder);
    return { text, attachment: template.headerFormat === "DOCUMENT" ? "PDF document" : null, templateName: providerTemplateId };
  } catch {
    // Provider unavailable: the page falls back to the stored values.
    return null;
  }
}
