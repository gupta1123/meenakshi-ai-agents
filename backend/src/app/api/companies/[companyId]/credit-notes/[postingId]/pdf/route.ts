import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { createCorrelationId } from "@/lib/credit-notes";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; postingId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** Queue a fresh capture of an already verified native Tally Credit Note PDF. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, postingId } = await context.params;
    if (!isUuid(companyId) || !isUuid(postingId)) return jsonWithCors(request, { error: "Invalid company or Credit Note posting id." }, { status: 400 });
    const { userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const { data, error } = await createSupabaseAdminClient().rpc("retry_meenakshi_credit_note_pdf_export", {
      p_credit_note_posting_id: postingId,
      p_actor_id: userId,
      p_correlation_id: createCorrelationId(),
    });
    if (error) throw error;
    return jsonWithCors(request, { outboxId: data, status: "queued" }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not request a native Credit Note PDF:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not request a native Credit Note PDF." }, { status: 500 });
  }
}
