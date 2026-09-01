import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { fetchMsg91WhatsappTemplates, getMsg91Config } from "@/lib/notifications/msg91-client";
import { readTemplateComponentSchema } from "@/lib/notifications/template-renderer";
import { isNotificationEventType } from "@/lib/notifications/types";
import { appendRulebookAudit, readBoolean, readOptionalText, readRequiredText, requireRulebookCompanyAdmin, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function isDuplicateTemplateError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function templateInput(body: Record<string, unknown>) {
  if (!isNotificationEventType(body.eventType)) throw new RulebookRequestError("eventType must be cd_shortfall, cd_credit_note_created, or tod_credit_note_created.");
  let componentSchema;
  try { componentSchema = readTemplateComponentSchema(body.componentSchema); }
  catch (error) { throw new RulebookRequestError(error instanceof Error ? error.message : "Invalid componentSchema."); }
  if (!componentSchema.components?.length) throw new RulebookRequestError("componentSchema must contain at least one approved component mapping.");
  return {
    event_type: body.eventType,
    provider_template_id: readRequiredText(body.providerTemplateId, "providerTemplateId", 160),
    name: readRequiredText(body.name, "name", 160),
    language_code: readOptionalText(body.languageCode, 32) ?? "en",
    template_namespace: readOptionalText(body.templateNamespace, 160),
    template_version: readOptionalText(body.templateVersion, 64) ?? "1",
    component_schema: componentSchema,
    is_active: body.isActive === undefined ? true : readBoolean(body.isActive, "isActive"),
  };
}

async function assertNoOpenTemplateMessages(templateId: string) {
  const { count, error } = await createSupabaseAdminClient().from("notification_messages")
    .select("id", { count: "exact", head: true }).eq("whatsapp_template_id", templateId).in("status", ["queued", "failed", "sending"]);
  if (error) throw error;
  if ((count ?? 0) > 0) throw new RulebookRequestError("This template has queued or retrying messages. Wait for them to finish before replacing the active template.", 409);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const url = new URL(request.url);
    if (url.searchParams.get("providerCatalog") === "true") {
      const config = getMsg91Config();
      if (!config.isConfigured || config.transport === "mock") return jsonWithCors(request, { configured: false, templates: [] });
      const catalog = await fetchMsg91WhatsappTemplates();
      return jsonWithCors(request, { configured: true, templates: catalog });
    }
    const { data, error } = await createSupabaseAdminClient().from("whatsapp_templates")
      .select("id, event_type, provider_name, provider_template_id, name, is_active, language_code, template_namespace, template_version, component_schema, created_at, updated_at")
      .eq("organization_id", scope.organization.id).order("event_type").order("updated_at", { ascending: false });
    if (error) throw error;
    return jsonWithCors(request, { templates: data ?? [] });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load message templates");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input = templateInput(body);
    const supabase = createSupabaseAdminClient();
    // Insert inactive first so replacing a template never leaves a period with
    // two active versions. The old one is preserved for historical snapshots.
    const { data, error } = await supabase.from("whatsapp_templates").insert({ ...input, is_active: false, organization_id: scope.organization.id })
      .select("id, event_type, provider_name, provider_template_id, name, is_active, language_code, template_namespace, template_version, component_schema, created_at, updated_at").single();
    if (error) throw error;
    const template = data as { id: string; event_type: string };
    if (input.is_active) {
      const { data: existing, error: existingError } = await supabase.from("whatsapp_templates").select("id")
        .eq("organization_id", scope.organization.id).eq("event_type", input.event_type).eq("is_active", true);
      if (existingError) throw existingError;
      for (const current of existing ?? []) await assertNoOpenTemplateMessages((current as { id: string }).id);
      const { error: retireError } = await supabase.from("whatsapp_templates").update({ is_active: false })
        .eq("organization_id", scope.organization.id).eq("event_type", input.event_type).eq("is_active", true);
      if (retireError) throw retireError;
      const { error: activateError } = await supabase.from("whatsapp_templates").update({ is_active: true }).eq("id", template.id);
      if (activateError) throw activateError;
    }
    await appendRulebookAudit({ scope, action: "whatsapp_template_created", entityType: "whatsapp_template", entityId: template.id, newValue: { eventType: input.event_type, providerTemplateId: input.provider_template_id, active: input.is_active } });
    return jsonWithCors(request, { template: { ...data, is_active: input.is_active } }, { status: 201 });
  } catch (error) {
    if (isDuplicateTemplateError(error)) {
      return jsonWithCors(request, { error: "This approved template mapping already exists. It was not created a second time." }, { status: 409 });
    }
    return rulebookErrorResponse(request, error, "create message template");
  }
}
