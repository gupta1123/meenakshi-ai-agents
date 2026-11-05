import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { describeApiWrite, primaryRole } from "@/lib/audit-request";

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

type AuditScope = {
  userId: string;
  roles: readonly string[];
  organization: { id: string };
  company?: { id: string } | null;
};

/**
 * Records something a signed-in person did. The role they held at that moment
 * is stored in metadata, so no schema change is needed. Never throws: an audit
 * failure must not undo the action the person just took.
 */
export async function auditUserAction(
  scope: AuditScope,
  input: {
    action: string;
    entityType: string;
    entityId?: string | null;
    previousValue?: Record<string, unknown> | null;
    newValue?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  }
) {
  try {
    await appendMeenakshiAuditEvent({
      organizationId: scope.organization.id,
      companyId: scope.company?.id ?? null,
      actorType: "user",
      actorId: scope.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      previousValue: input.previousValue ?? null,
      newValue: input.newValue ?? null,
      metadata: { ...input.metadata, role: primaryRole(scope.roles), roles: [...scope.roles] },
    });
  } catch (error) {
    console.error("Could not audit user action:", error);
  }
}

/**
 * Every write request a signed-in person makes is recorded once: who, which
 * role, which endpoint, which record, when. Fire-and-forget so it adds no
 * latency to the request.
 */
export function auditApiWrite(request: Request, scope: AuditScope) {
  const write = describeApiWrite(request.method, request.url);
  if (!write) return;
  void auditUserAction(scope, {
    action: "api_write",
    entityType: "api_route",
    entityId: write.entityId,
    metadata: { method: write.method, route: write.route },
  });
}
