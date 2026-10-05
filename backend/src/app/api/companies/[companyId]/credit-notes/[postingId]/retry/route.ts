import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { createCorrelationId } from "@/lib/credit-notes";
import { requirePostingEnabled } from "@/lib/launch-control";
import { RulebookRequestError } from "@/lib/rulebook/shared";
import { isUuid, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; postingId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, postingId } = await context.params;
    if (!isUuid(companyId) || !isUuid(postingId)) return jsonWithCors(request, { error: "Invalid company or Credit Note posting id." }, { status: 400 });
    const { userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = readText(body.reason, 2_000);
    if (!reason) return jsonWithCors(request, { error: "A retry reason is required." }, { status: 400 });
    await requirePostingEnabled(companyId);
    const { data, error } = await createSupabaseAdminClient().rpc("retry_meenakshi_credit_note_posting", {
      p_credit_note_posting_id: postingId, p_actor_id: userId, p_reason: reason, p_correlation_id: createCorrelationId(),
    });
    if (error) throw error;
    return jsonWithCors(request, { outboxId: data, status: "queued" }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError || error instanceof RulebookRequestError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not retry Credit Note posting:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not retry Credit Note posting." }, { status: 500 });
  }
}
