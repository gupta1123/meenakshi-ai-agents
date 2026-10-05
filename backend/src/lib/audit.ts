import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AuditInput = {
  organizationId: string;
  companyId?: string | null;
  actorType: "user" | "system" | "tally_connector" | "msg91";
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  correlationId?: string | null;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
};

export async function appendMeenakshiAuditEvent(input: AuditInput) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("audit_events").insert({
    organization_id: input.organizationId,
    company_id: input.companyId ?? null,
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    correlation_id: input.correlationId ?? null,
    previous_value: input.previousValue ?? null,
    new_value: input.newValue ?? null,
    metadata: input.metadata ?? {},
  });
  if (error) console.error("Could not append Meenakshi audit event:", error);
}
