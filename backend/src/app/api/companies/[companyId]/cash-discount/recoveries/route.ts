import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
const recoveryFields = "id, source_run_id, evaluated_on, customer_name, invoice_number, invoice_date, bill_reference, net_invoice_amount, implied_gross_amount, amount_paid, granted_discount_percentage, earned_discount_percentage, recovery_required, already_recovered, remaining_recovery, missed_window_working_days, missed_window_deadline, next_window_working_days, next_window_percentage, status, reason_code, review_message, narration_checked, narration_mentioned, narration_matches, debit_note_references, updated_at";
type RecoveryCase = "all" | "not_paid" | "partially_paid" | "paid_late" | "review";
function recoveryCase(row: { amount_paid: number | string | null; net_invoice_amount: number | string | null; status: string }) : Exclude<RecoveryCase, "all"> {
  if (row.status === "review_required") return "review";
  const paid = Number(row.amount_paid ?? 0);
  const net = Number(row.net_invoice_amount ?? 0);
  if (paid <= 0) return "not_paid";
  if (paid < net) return "partially_paid";
  return "paid_late";
}
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const requestedCase = (url.searchParams.get("case") ?? "all") as RecoveryCase;
    if (!["all", "not_paid", "partially_paid", "paid_late", "review"].includes(requestedCase)) return jsonWithCors(request, { error: "Invalid recovery case filter." }, { status: 400 });
    const search = url.searchParams.get("q")?.trim().slice(0, 120) ?? "";
    const requestedLimit = Number(url.searchParams.get("limit") ?? 250);
    // The page asks for the whole current snapshot (a few thousand invoices at
    // most) so its totals are correct; rows are read in 1,000-row batches below.
    const limit = Number.isFinite(requestedLimit) ? Math.min(5000, Math.max(1, Math.floor(requestedLimit))) : 250;
    // cursor = last id from previous page (keyset on remaining_recovery desc, id desc)
    const cursor = url.searchParams.get("cursor");
    const supabase = createSupabaseAdminClient();
    // Several Cash Discount rules can be active; show one rule's results
    // (all versions of that rule) when the page selects it.
    const requestedRule = url.searchParams.get("ruleVersionId");
    let ruleVersionIds: string[] | null = null;
    if (requestedRule && isUuid(requestedRule)) {
      const { data: selected } = await supabase.from("scheme_versions").select("scheme_id").eq("id", requestedRule).eq("company_id", company.id).maybeSingle();
      const { data: versions } = selected ? await supabase.from("scheme_versions").select("id").eq("scheme_id", selected.scheme_id) : { data: [] };
      ruleVersionIds = (versions ?? []).map((row) => row.id);
      if (!ruleVersionIds.length) ruleVersionIds = [requestedRule];
    }
    const buildQuery = () => {
      const query = supabase.from("cash_discount_recovery_candidates")
        .select(recoveryFields)
        .eq("company_id", company.id).eq("current_snapshot", true)
        .in("status", ["action_required", "review_required", "posting"])
        .order("remaining_recovery", { ascending: false }).order("id", { ascending: false });
      return ruleVersionIds ? query.in("rule_version_id", ruleVersionIds) : query;
    };
    const { data: cursorRow } = cursor && isUuid(cursor)
      ? await supabase.from("cash_discount_recovery_candidates").select("id").eq("id", cursor).eq("company_id", company.id).maybeSingle()
      : { data: null };
    const filtered = () => {
      let query = buildQuery();
      if (requestedCase === "review") query = query.eq("status", "review_required");
      if (requestedCase === "not_paid") query = query.eq("amount_paid", 0);
      if (search) {
        const safe = search.replace(/[%,()]/g, " ").trim();
        if (safe) query = query.or(`customer_name.ilike.%${safe}%,invoice_number.ilike.%${safe}%,bill_reference.ilike.%${safe}%`);
      }
      if (cursorRow) query = query.lt("id", cursorRow.id);
      return query;
    };
    // PostgREST returns at most 1,000 rows per request; read in batches up to limit + 1.
    const query = (async () => {
      const rows: unknown[] = [];
      for (let from = 0; from <= limit; from += 1000) {
        const result = await filtered().range(from, Math.min(from + 999, limit));
        if (result.error) return { data: null, error: result.error };
        rows.push(...(result.data ?? []));
        if ((result.data ?? []).length < 1000) break;
      }
      return { data: rows as Awaited<ReturnType<typeof buildQuery>>["data"], error: null };
    })();
    const priorRuleBase = supabase
      .from("cash_discount_recovery_candidates")
      .select(recoveryFields)
      .eq("company_id", company.id)
      .eq("current_snapshot", false)
      .in("status", ["action_required", "review_required"])
      .order("evaluated_on", { ascending: false })
      .order("remaining_recovery", { ascending: false })
      .limit(250);
    const priorRuleQuery = ruleVersionIds ? priorRuleBase.in("rule_version_id", ruleVersionIds) : priorRuleBase;
    const postingsQuery = supabase
      .from("cash_discount_debit_note_postings")
      // note_kind: per-MT Cash Discount Credit Notes share this table (docs/CD_LOGIC.md).
      .select("id, candidate_id, status, debit_note_date, amount, calculation_reference, verified_tally_guid, verified_voucher_number, verified_amount, verified_at, failure_reason, reconciliation_reason, last_reconciled_at, created_at, updated_at, note_kind:debit_note_snapshot->>noteKind")
      .eq("company_id", company.id)
      .order("created_at", { ascending: false })
      .limit(250);
    const [currentResult, priorRuleResult, postingsResult] = await Promise.all([query, priorRuleQuery, postingsQuery]);
    if (currentResult.error) throw currentResult.error;
    if (priorRuleResult.error) throw priorRuleResult.error;
    if (postingsResult.error) throw postingsResult.error;
    const data = currentResult.data;
    const priorRuleData = priorRuleResult.data;
    const postings = postingsResult.data;
    const candidateIds = [...new Set((postings ?? []).map((posting) => posting.candidate_id).filter((id): id is string => typeof id === "string"))];
    const { data: historyCandidates, error: historyCandidatesError } = candidateIds.length
      ? await supabase.from("cash_discount_recovery_candidates")
        .select("id, customer_tally_guid, customer_name, invoice_number, invoice_date, bill_reference, recovery_required")
        .eq("company_id", company.id).in("id", candidateIds)
      : { data: [], error: null };
    if (historyCandidatesError) throw historyCandidatesError;
    const customerGuids = [...new Set((historyCandidates ?? []).map((candidate) => candidate.customer_tally_guid))];
    const { data: customers, error: customersError } = customerGuids.length
      ? await supabase.from("customers").select("id, tally_ledger_guid").eq("company_id", company.id).in("tally_ledger_guid", customerGuids)
      : { data: [], error: null };
    if (customersError) throw customersError;
    const customerIdByGuid = new Map((customers ?? []).map((customer) => [customer.tally_ledger_guid, customer.id]));
    const candidatesById = new Map((historyCandidates ?? []).map((candidate) => [candidate.id, { ...candidate, customer_id: customerIdByGuid.get(candidate.customer_tally_guid) ?? null }]));
    const history = (postings ?? []).map((posting) => ({
      ...posting,
      candidate: candidatesById.get(posting.candidate_id) ?? null,
    }));
    const rows = (data ?? []).map((row) => ({ ...row, recovery_case: recoveryCase(row) })).filter((row) => requestedCase === "all" || row.recovery_case === requestedCase);
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
