import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { safeOperationalSummary } from "@/lib/operations";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const correlationId = url.searchParams.get("correlationId");
    const entityId = url.searchParams.get("entityId");
    const entityType = url.searchParams.get("entityType");
    if (!isUuid(correlationId) && !(isUuid(entityId) && entityType && entityType.length <= 100)) {
      return jsonWithCors(request, { error: "Provide a correlationId or an entityId with entityType." }, { status: 400 });
    }
    const supabase = createSupabaseAdminClient();
    const outboxQuery = supabase.from("integration_outbox").select("id, event_type, status, attempts, max_attempts, available_at, completed_at, created_at, correlation_id, last_error").eq("company_id", company.id).order("created_at", { ascending: false }).limit(100);
    const commandQuery = supabase.from("tally_commands").select("id, command_type, status, attempts, max_attempts, available_at, completed_at, created_at, correlation_id, failure_reason").eq("company_id", company.id).order("created_at", { ascending: false }).limit(100);
    const auditQuery = supabase.from("audit_events").select("id, action, entity_type, entity_id, correlation_id, created_at").eq("company_id", company.id).order("created_at", { ascending: false }).limit(100);
    const entityOutboxQuery = isUuid(correlationId) ? outboxQuery.eq("correlation_id", correlationId) : outboxQuery.eq("aggregate_id", entityId!);
    const entityCommandQuery = isUuid(correlationId) ? commandQuery.eq("correlation_id", correlationId) : commandQuery.limit(0);
    const entityAuditQuery = isUuid(correlationId) ? auditQuery.eq("correlation_id", correlationId) : auditQuery.eq("entity_type", entityType!).eq("entity_id", entityId!);
    const [outboxResult, commandResult, auditResult] = await Promise.all([entityOutboxQuery, entityCommandQuery, entityAuditQuery]);
    if (outboxResult.error || commandResult.error || auditResult.error) throw outboxResult.error ?? commandResult.error ?? auditResult.error;
    return jsonWithCors(request, {
      companyId: company.id,
      target: { correlationId: isUuid(correlationId) ? correlationId : null, entityType: isUuid(correlationId) ? null : entityType, entityId: isUuid(correlationId) ? null : entityId },
      // Payloads, provider data, raw XML, phone data, and credentials are deliberately never selected.
      outbox: (outboxResult.data ?? []).map((row) => ({ id: row.id, type: row.event_type, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, availableAt: row.available_at, completedAt: row.completed_at, createdAt: row.created_at, correlationId: row.correlation_id, summary: safeOperationalSummary({ status: row.status, failureReason: row.last_error }) })),
      commands: (commandResult.data ?? []).map((row) => ({ id: row.id, type: row.command_type, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, availableAt: row.available_at, completedAt: row.completed_at, createdAt: row.created_at, correlationId: row.correlation_id, summary: safeOperationalSummary({ status: row.status, failureReason: row.failure_reason }) })),
      audit: (auditResult.data ?? []).map((row) => ({ id: row.id, action: row.action, entityType: row.entity_type, entityId: row.entity_id, correlationId: row.correlation_id, createdAt: row.created_at, summary: safeOperationalSummary({ action: row.action }) })),
    });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load operational detail:", error);
    return jsonWithCors(request, { error: "Could not load operational detail." }, { status: 500 });
  }
}
