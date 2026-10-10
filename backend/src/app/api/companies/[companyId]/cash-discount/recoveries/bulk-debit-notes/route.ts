import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClientWithOptions } from "@/lib/supabase/admin";
import { requireVisibleCdCandidate } from "@/lib/evaluation/result-visibility";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company, userId } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = await request.json().catch(() => ({})) as { candidateIds?: unknown };
    const candidateIds = Array.isArray(body.candidateIds) ? [...new Set(body.candidateIds.filter((id): id is string => typeof id === "string" && isUuid(id)))] : [];
    if (!candidateIds.length) return jsonWithCors(request, { error: "Choose at least one Debit Note." }, { status: 400 });
    if (candidateIds.length > 25) return jsonWithCors(request, { error: "Prepare up to 25 Debit Notes in one batch." }, { status: 400 });
    const supabase = createSupabaseAdminClientWithOptions({ timeoutMs: 12_000 });
    const { data: candidates, error } = await supabase.from("cash_discount_recovery_candidates")
      .select("id, status, current_snapshot, remaining_recovery").eq("company_id", company.id).in("id", candidateIds);
    if (error) throw error;
    const byId = new Map((candidates ?? []).map((candidate) => [candidate.id, candidate]));
    const results: Array<{ candidateId: string; status: "queued" | "skipped"; postingId?: string; error?: string }> = [];
    for (const candidateId of candidateIds) {
      try { await requireVisibleCdCandidate(company.id, candidateId); }
      catch (error) { results.push({ candidateId, status: "skipped", error: error instanceof Error ? error.message : "Result is unavailable." }); continue; }
      const candidate = byId.get(candidateId);
      if (!candidate || !candidate.current_snapshot || candidate.status !== "action_required" || Number(candidate.remaining_recovery) <= 0) {
        results.push({ candidateId, status: "skipped", error: "This recovery is no longer ready." });
        continue;
      }
      const { data, error: queueError } = await supabase.rpc("enqueue_meenakshi_cd_debit_note", {
        p_company_id: company.id, p_candidate_id: candidateId, p_actor_id: userId,
        p_idempotency_key: `cd-bulk:${company.id}:${candidateId}`,
      });
      if (queueError) results.push({ candidateId, status: "skipped", error: queueError.message });
      else {
        const posting = Array.isArray(data) ? data[0] : data;
        results.push({ candidateId, status: "queued", postingId: posting && typeof posting === "object" && "id" in posting ? String(posting.id) : undefined });
      }
    }
    const queued = results.filter((result) => result.status === "queued").length;
    return jsonWithCors(request, { queued, skipped: results.length - queued, results, message: `${queued} Debit Note${queued === 1 ? "" : "s"} queued. Tally will create them one at a time.` }, { status: queued ? 202 : 409 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not queue the Debit Notes." }, { status: 500 });
  }
}
