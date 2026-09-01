import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { getMsg91Config, sendMsg91Notification } from "@/lib/notifications/msg91-client";
import { RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const { data, error } = await createSupabaseAdminClient().from("audit_events")
      .select("id, created_at, new_value").eq("company_id", scope.company.id)
      .eq("action", "whatsapp_test_message_sent").order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    return jsonWithCors(request, { tests: (data ?? []).map((row) => {
      const details = row.new_value && typeof row.new_value === "object" ? row.new_value as Record<string, unknown> : {};
      return { id: row.id, sentAt: row.created_at, providerMessageId: typeof details.providerMessageId === "string" ? details.providerMessageId : null };
    }) });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load controlled WhatsApp tests");
  }
}

/** Sends an explicitly confirmed, audit-tracked test to the configured test number only. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const body = await request.json().catch(() => ({})) as { confirm?: unknown; retest?: unknown };
    if (body.confirm !== true) throw new RulebookRequestError("Confirm the controlled test before sending it.");

    const config = getMsg91Config();
    if (!config.testRecipientE164) throw new RulebookRequestError("A test recipient is not configured on this backend.", 409);
    if (!config.isConfigured || config.transport === "mock") throw new RulebookRequestError("Live MSG91 WhatsApp is not configured.", 409);

    const supabase = createSupabaseAdminClient();
    const { count, error: auditLookupError } = await supabase.from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("company_id", scope.company.id).eq("action", "whatsapp_test_message_sent");
    if (auditLookupError) throw auditLookupError;
    const priorTests = count ?? 0;
    if (priorTests >= 2) throw new RulebookRequestError("The controlled WhatsApp test and its correction retest have already been sent for this company.", 409);
    if (priorTests === 1 && body.retest !== "currency_format_correction") {
      throw new RulebookRequestError("A second test is allowed only as the audited currency-format correction retest.", 409);
    }

    const { data: template, error: templateError } = await supabase.from("whatsapp_templates")
      .select("id, provider_name, provider_template_id, language_code, template_namespace, template_version, component_schema")
      .eq("organization_id", scope.organization.id).eq("event_type", "cd_shortfall").eq("is_active", true).maybeSingle();
    if (templateError) throw templateError;
    if (!template) throw new RulebookRequestError("No active CD-shortfall WhatsApp template is configured.", 409);

    const delivery = await sendMsg91Notification({
      eventType: "cd_shortfall",
      recipientPhoneE164: config.testRecipientE164,
      payload: { customerName: "Apex Rebar Projects", paidAmount: "150000.00", shortfallAmount: "25000.00", eligibilityDeadline: "15 Sep 2026" },
      template: {
        templateId: template.id,
        provider: template.provider_name,
        providerTemplateId: template.provider_template_id,
        eventType: "cd_shortfall",
        languageCode: template.language_code,
        namespace: template.template_namespace,
        version: template.template_version,
        componentSchema: template.component_schema as { components?: Array<{ component: string; value: string; type?: "text" | "document" }> },
      },
    });

    await appendMeenakshiAuditEvent({
      organizationId: scope.organization.id, companyId: scope.company.id, actorType: "user", actorId: scope.userId,
      action: "whatsapp_test_message_sent", entityType: "whatsapp_test", entityId: template.id,
      newValue: { eventType: "cd_shortfall", templateId: template.provider_template_id, providerMessageId: delivery.providerMessageId, recipient: "configured_test_recipient", testKind: priorTests === 0 ? "initial" : "currency_format_correction" },
      metadata: { controlled: true, testKind: priorTests === 0 ? "initial" : "currency_format_correction" },
    });
    return jsonWithCors(request, { sent: true, providerMessageId: delivery.providerMessageId });
  } catch (error) {
    return rulebookErrorResponse(request, error, "send controlled WhatsApp test");
  }
}
