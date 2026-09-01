import { appendMeenakshiAuditEvent } from "@/lib/audit";
import type { TallySyncKind, TallySyncRun } from "@/lib/tally/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function requestTallySync(input: {
  organizationId: string;
  companyId: string;
  syncKind: TallySyncKind;
  requestedScope: Record<string, unknown>;
  idempotencyKey: string;
  actorId: string;
}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("request_meenakshi_tally_sync", {
    p_organization_id: input.organizationId,
    p_company_id: input.companyId,
    p_sync_kind: input.syncKind,
    p_requested_scope: input.requestedScope,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  const run = data as unknown as TallySyncRun;
  await appendMeenakshiAuditEvent({
    organizationId: input.organizationId,
    companyId: input.companyId,
    actorType: "user",
    actorId: input.actorId,
    action: `tally_${input.syncKind}_sync_requested`,
    entityType: "tally_sync_run",
    entityId: run.id,
    newValue: { syncKind: run.sync_kind, requestedScope: run.requested_scope, status: run.status },
    metadata: { idempotencyKey: input.idempotencyKey },
  });
  return run;
}
