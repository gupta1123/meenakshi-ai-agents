import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { readIdempotencyKey } from "@/lib/tally/contracts";
import { createSupabaseAdminClientWithOptions } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; candidateId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || /timed out|aborted/i.test(error.message));
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, candidateId } = await context.params;
    if (!isUuid(companyId) || !isUuid(candidateId)) return jsonWithCors(request, { error: "Invalid recovery action." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const { company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClientWithOptions({ timeoutMs: 12_000 });
    const { data: candidate, error: candidateError } = await supabase.from("cash_discount_recovery_candidates")
      // The posting RPC owns the authoritative Tally-ledger validation. Do
      // not query optional snapshot columns here: older, supported company
      // schemas use the configured recovery ledger and do not have them.
      .select("id, status, current_snapshot, remaining_recovery")
      .eq("id", candidateId).eq("company_id", company.id).maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidate || candidate.current_snapshot !== true) {
      return jsonWithCors(request, { error: "This recovery is no longer current. Run Cash Discount again." }, { status: 409 });
    }
    if (candidate.status === "posting") {
      return jsonWithCors(request, { error: "This Debit Note is already being prepared." }, { status: 409 });
    }
    if (candidate.status !== "action_required" || Number(candidate.remaining_recovery) <= 0) {
      return jsonWithCors(request, { error: "This recovery no longer needs a Debit Note." }, { status: 409 });
    }
    const { data, error } = await supabase.rpc("enqueue_meenakshi_cd_debit_note", {
      p_company_id: company.id,
      p_candidate_id: candidateId,
      p_actor_id: userId,
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    const posting = Array.isArray(data) ? data[0] : data;
    return jsonWithCors(request, {
      debitNotePosting: posting && typeof posting === "object" ? {
        id: "id" in posting ? posting.id : null,
        status: "status" in posting ? posting.status : "queued",
        amount: "amount" in posting ? posting.amount : null,
        createdAt: "created_at" in posting ? posting.created_at : null,
      } : null,
    }, { status: 202 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    if (isTimeout(error)) {
      console.error("Timed out while enqueueing Cash Discount Debit Note:", error);
      return jsonWithCors(request, { error: "Preparing the Debit Note took too long. No second request was started; wait a moment and refresh the recovery actions." }, { status: 503 });
    }
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Could not prepare the Debit Note.";
    console.error("Could not enqueue Cash Discount Debit Note:", error);
    const status = error && typeof error === "object" && "code" in error && error.code === "55P03" ? 409 : 400;
    return jsonWithCors(request, { error: message }, { status });
  }
}
