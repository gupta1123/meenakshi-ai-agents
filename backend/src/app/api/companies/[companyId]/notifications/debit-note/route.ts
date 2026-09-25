import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { appendRulebookAudit, readRequiredUuid, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { notificationTemplateBlock } from "@/lib/notifications/template-readiness";
import { prepareDebitNoteDocument } from "@/lib/notes/verified-note-document.mjs";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const postingId = readRequiredUuid(body.postingId, "postingId");
    const templateBlock = await notificationTemplateBlock(scope.company.id, "cd_debit_note_created");
    if (templateBlock) return jsonWithCors(request, { error: templateBlock, queued: false }, { status: 422 });
    const supabase = createSupabaseAdminClient();
    await prepareDebitNoteDocument(supabase, scope.company.id, postingId);
    const { data, error } = await supabase.rpc("enqueue_meenakshi_cd_debit_note_notification", {
      p_company_id: scope.company.id,
      p_posting_id: postingId,
      p_created_by: scope.userId,
    });
    if (error) throw error;
    if (!data) return jsonWithCors(request, { queued: false, messageId: null, blockedReason: "A verified Debit Note, opted-in customer number, and approved Debit Note template are required." }, { status: 409 });
    await appendRulebookAudit({ scope, action: "verified_debit_note_notification_queued", entityType: "cash_discount_debit_note_posting", entityId: postingId, newValue: { notificationMessageId: String(data) } });
    return jsonWithCors(request, { queued: true, messageId: String(data), blockedReason: null }, { status: 201 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    return rulebookErrorResponse(request, error, "queue verified Debit Note notification");
  }
}
