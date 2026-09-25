import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { requirePostingEnabled } from "@/lib/launch-control";
import { RulebookRequestError } from "@/lib/rulebook/shared";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readIdempotencyKey } from "@/lib/tally/contracts";

type RouteContext = { params: Promise<{ companyId: string; candidateId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/**
 * Staff creates the Cash Discount Credit Note for one invoice: a More-than-90%
 * payment (capped at the discount), or a Discounted payment while automatic
 * creation was off. The note is created and verified in Tally by the connector.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, candidateId } = await context.params;
    if (!isUuid(companyId) || !isUuid(candidateId)) return jsonWithCors(request, { error: "Invalid id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const { company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator"]);
    await requirePostingEnabled(company.id);
    const { data, error } = await createSupabaseAdminClient().rpc("enqueue_meenakshi_cd_credit_note", {
      p_company_id: company.id, p_candidate_id: candidateId, p_actor_id: userId, p_idempotency_key: idempotencyKey,
    });
    if (error) return jsonWithCors(request, { error: error.message }, { status: 409 });
    return jsonWithCors(request, { posting: data }, { status: 201 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError || error instanceof RulebookRequestError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not queue the Cash Discount Credit Note:", error);
    return jsonWithCors(request, { error: "Could not queue the Credit Note." }, { status: 500 });
  }
}
