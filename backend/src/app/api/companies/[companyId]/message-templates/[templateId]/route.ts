import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { readTemplateComponentSchema } from "@/lib/notifications/template-renderer";
import { liveProviderTemplateProblem } from "@/lib/notifications/provider-template";
import { appendRulebookAudit, readBoolean, readOptionalText, readRequiredText, requireRulebookCompanyAdmin, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; templateId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

async function assertNoOpenTemplateMessages(templateId: string) {
  const { count, error } = await createSupabaseAdminClient().from("notification_messages")
    .select("id", { count: "exact", head: true }).eq("whatsapp_template_id", templateId).in("status", ["queued", "sending"]);
  if (error) throw error;
  if ((count ?? 0) > 0) throw new RulebookRequestError("This template has queued or sending messages. It cannot be changed yet.", 409);
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { companyId, templateId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    if (!isUuid(templateId)) throw new RulebookRequestError("Invalid template id.");
    const supabase = createSupabaseAdminClient();
    const { data: existingData, error: existingError } = await supabase.from("whatsapp_templates")
      .select("id, event_type, name, is_active, provider_template_id, language_code, component_schema").eq("id", templateId).eq("organization_id", scope.organization.id).maybeSingle();
    if (existingError) throw existingError;
    const existing = existingData as { id: string; event_type: string; name: string; is_active: boolean; provider_template_id: string; language_code: string; component_schema: unknown } | null;
    if (!existing) return jsonWithCors(request, { error: "Message template was not found." }, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = readRequiredText(body.name, "name", 160);
    if (body.languageCode !== undefined) update.language_code = readRequiredText(body.languageCode, "languageCode", 32);
    if (body.templateNamespace !== undefined) update.template_namespace = readOptionalText(body.templateNamespace, 160);
    if (body.templateVersion !== undefined) update.template_version = readRequiredText(body.templateVersion, "templateVersion", 64);
    if (body.componentSchema !== undefined) {
      try { update.component_schema = readTemplateComponentSchema(body.componentSchema); }
      catch (error) { throw new RulebookRequestError(error instanceof Error ? error.message : "Invalid componentSchema."); }
      if (!(update.component_schema as { components?: unknown[] }).components?.length) throw new RulebookRequestError("componentSchema must contain at least one approved component mapping.");
    }
    if (body.isActive !== undefined) update.is_active = readBoolean(body.isActive, "isActive");
    if (!Object.keys(update).length) throw new RulebookRequestError("Provide one or more editable template fields.");
    if (update.is_active === true || (existing.is_active && (update.component_schema || update.language_code))) {
      const problem = await liveProviderTemplateProblem({ providerTemplateId: existing.provider_template_id, languageCode: String(update.language_code ?? existing.language_code), componentSchema: readTemplateComponentSchema(update.component_schema ?? existing.component_schema) });
      if (problem) throw new RulebookRequestError(problem, 422);
    }
    if (Object.keys(update).some((key) => key !== "name") || update.is_active === false) await assertNoOpenTemplateMessages(existing.id);
    if (update.is_active === true && !existing.is_active) {
      const { data: active, error } = await supabase.from("whatsapp_templates").select("id")
        .eq("organization_id", scope.organization.id).eq("event_type", existing.event_type).eq("is_active", true).neq("id", existing.id);
      if (error) throw error;
      for (const current of active ?? []) await assertNoOpenTemplateMessages((current as { id: string }).id);
      const { error: retireError } = await supabase.from("whatsapp_templates").update({ is_active: false })
        .eq("organization_id", scope.organization.id).eq("event_type", existing.event_type).eq("is_active", true).neq("id", existing.id);
      if (retireError) throw retireError;
    }
    const { data, error } = await supabase.from("whatsapp_templates").update(update).eq("id", existing.id)
      .select("id, event_type, provider_name, provider_template_id, name, is_active, language_code, template_namespace, template_version, component_schema, created_at, updated_at").single();
    if (error) throw error;
    await appendRulebookAudit({ scope, action: "whatsapp_template_updated", entityType: "whatsapp_template", entityId: existing.id, previousValue: { name: existing.name, isActive: existing.is_active }, newValue: update });
    return jsonWithCors(request, { template: data });
  } catch (error) {
    return rulebookErrorResponse(request, error, "update message template");
  }
}
