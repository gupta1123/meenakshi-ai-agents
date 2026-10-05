import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; postingId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, postingId } = await context.params;
    if (!isUuid(companyId) || !isUuid(postingId)) return jsonWithCors(request, { error: "Invalid company or Debit Note id." }, { status: 400 });
    const { company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    const body = await request.json().catch(() => ({})) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) return jsonWithCors(request, { error: "A reason for checking again is required." }, { status: 400 });
    const { data, error } = await createSupabaseAdminClient().rpc("retry_meenakshi_cd_debit_note", {
      p_posting_id: postingId,
      p_actor_id: userId,
      p_reason: reason,
    });
    if (error) throw error;
    return jsonWithCors(request, { outboxId: data, message: "The existing Tally Debit Note will be checked again. No duplicate is created." }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Could not check this Debit Note again.";
    console.error("Could not retry Debit Note verification:", error);
    return jsonWithCors(request, { error: message }, { status: 400 });
  }
}
