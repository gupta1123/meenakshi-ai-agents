import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { NotificationEventType } from "./types";
import { liveProviderTemplateProblem } from "./provider-template";

export async function notificationTemplateBlock(companyId: string, eventType: NotificationEventType) {
  const supabase = createSupabaseAdminClient();
  const { data: company, error: companyError } = await supabase.from("companies").select("organization_id").eq("id", companyId).single();
  if (companyError) throw companyError;
  const { data: template, error } = await supabase.from("whatsapp_templates")
    .select("provider_template_id, language_code, component_schema").eq("organization_id", company.organization_id)
    .eq("event_type", eventType).eq("is_active", true).limit(1).maybeSingle();
  if (error) throw error;
  if (!template?.provider_template_id?.trim() || !template.language_code?.trim())
    return "WhatsApp template setup is incomplete. Configure the approved template in Messages before sending.";
  return liveProviderTemplateProblem({ providerTemplateId: template.provider_template_id, languageCode: template.language_code, componentSchema: template.component_schema });
}
