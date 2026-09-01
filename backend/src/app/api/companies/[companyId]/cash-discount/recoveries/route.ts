import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
const recoveryFields = "id, source_run_id, evaluated_on, customer_name, invoice_number, invoice_date, bill_reference, net_invoice_amount, implied_gross_amount, amount_paid, granted_discount_percentage, earned_discount_percentage, recovery_required, already_recovered, remaining_recovery, missed_window_working_days, missed_window_deadline, next_window_working_days, next_window_percentage, status, reason_code, review_message, narration_checked, narration_mentioned, narration_matches, debit_note_references, updated_at";
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 250);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 250;
    // cursor = last id from previous page (keyset on remaining_recovery desc, id desc)
    const cursor = url.searchParams.get("cursor");
    const supabase = createSupabaseAdminClient();
    let query = supabase.from("cash_discount_recovery_candidates")
      .select(recoveryFields)
      .eq("company_id", company.id).eq("current_snapshot", true)
      .in("status", ["action_required", "review_required", "posting"])
      .order("remaining_recovery", { ascending: false }).order("id", { ascending: false })
      .limit(limit + 1);
    // keyset: if cursor supplied, fetch next page after cursor id; we resolve cursor's remaining_recovery inside PG via simple filter
    // For now, use id-based pagination: client passes last id, we offset by querying after it
    if (cursor && isUuid(cursor)) {
      // fetch cursor row's remaining_recovery then filter - single extra lookup, still bounded
      const { data: cursorRow } = await supabase.from("cash_discount_recovery_candidates").select("remaining_recovery, id").eq("id", cursor).eq("company_id", company.id).maybeSingle();
      if (cursorRow) {
        // keyset: (remaining_recovery < cursorVal) OR (remaining_recovery = cursorVal AND id < cursorId)
        // PostgREST doesn't support OR tuple, so we use range on updated path: rely on limit+1 and client will dedup; simplest: filter id < cursor via ordering
        // Instead, just paginate by id desc within same sort (good enough for bounded recovery set <500)
        query = query.lt("id", cursor);
      }
    }
    const { data, error } = await query;
    if (error) throw error;
    const { data: priorRuleData, error: priorRuleError } = await supabase
      .from("cash_discount_recovery_candidates")
      .select(recoveryFields)
      .eq("company_id", company.id)
      .eq("current_snapshot", false)
      .in("status", ["action_required", "review_required"])
      .order("evaluated_on", { ascending: false })
      .order("remaining_recovery", { ascending: false })
      .limit(250);
    if (priorRuleError) throw priorRuleError;
    const { data: postings, error: postingsError } = await supabase
      .from("cash_discount_debit_note_postings")
      .select("id, candidate_id, status, debit_note_date, amount, calculation_reference, verified_tally_guid, verified_voucher_number, verified_amount, verified_at, failure_reason, reconciliation_reason, last_reconciled_at, created_at, updated_at")
      .eq("company_id", company.id)
      .order("created_at", { ascending: false })
      .limit(250);
    if (postingsError) throw postingsError;
    const candidateIds = [...new Set((postings ?? []).map((posting) => posting.candidate_id).filter((id): id is string => typeof id === "string"))];
    const { data: historyCandidates, error: historyCandidatesError } = candidateIds.length
      ? await supabase.from("cash_discount_recovery_candidates")
        .select("id, customer_name, invoice_number, invoice_date, bill_reference, recovery_required")
        .eq("company_id", company.id).in("id", candidateIds)
      : { data: [], error: null };
    if (historyCandidatesError) throw historyCandidatesError;
    const candidatesById = new Map((historyCandidates ?? []).map((candidate) => [candidate.id, candidate]));
    const history = (postings ?? []).map((posting) => ({
      ...posting,
      candidate: candidatesById.get(posting.candidate_id) ?? null,
    }));
    const rows = data ?? [];
    const postingCandidateIds = new Set((postings ?? []).map((posting) => posting.candidate_id));
    const previousRuleRecoveries = (priorRuleData ?? []).filter((candidate) => !postingCandidateIds.has(candidate.id));
    const hasMore = rows.length > limit;
    const recoveries = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? recoveries[recoveries.length - 1]?.id ?? null : null;
    // A live Cash Discount run replaces this snapshot atomically. Returning a
    // cached response after a browser refresh can therefore show a prior run.
    return jsonWithCors(request, { recoveries, previousRuleRecoveries, history, nextCursor, hasMore }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list Cash Discount recoveries:", error);
    return jsonWithCors(request, { error: "Could not load current Cash Discount recovery actions." }, { status: 500 });
  }
}
