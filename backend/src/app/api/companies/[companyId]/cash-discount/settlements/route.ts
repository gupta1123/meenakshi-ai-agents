import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/**
 * Latest per-MT Cash Discount check (docs/CD_LOGIC.md): every checked invoice
 * with its category, plus the Credit Note status of each invoice.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const { data: runs, error: runError } = await supabase.from("evaluation_runs")
      .select("id, status, scheme_version_id, period_start, period_end, completed_at, created_at, summary")
      .eq("company_id", company.id).eq("status", "completed").eq("summary->>cdDiscountBasis", "amount_per_tonne")
      .order("completed_at", { ascending: false }).limit(1);
    if (runError) throw runError;
    const run = runs?.[0] ?? null;
    const [candidates, notes] = await Promise.all([
      supabase.from("cash_discount_recovery_candidates").select("id, invoice_tally_guid, status, remaining_recovery, settlement_category")
        .eq("company_id", company.id).eq("current_snapshot", true).eq("candidate_kind", "settlement"),
      supabase.from("cash_discount_debit_note_postings").select("id, status, amount, verified_voucher_number, verified_at, failure_reason, created_at, invoice:debit_note_snapshot->sourceInvoice->>guid")
        .eq("company_id", company.id).eq("note_kind", "credit_note").order("created_at", { ascending: false }).limit(5000),
    ]);
    if (candidates.error) throw candidates.error;
    if (notes.error) throw notes.error;
    const summary = (run?.summary ?? {}) as Record<string, unknown>;
    const { settlementResults, ...totals } = summary;
    // Newest Credit Note per invoice.
    const noteByInvoice: Record<string, unknown> = {};
    for (const note of (notes.data ?? []) as Array<Record<string, unknown>>) {
      const invoice = String(note.invoice ?? "");
      if (invoice && !noteByInvoice[invoice]) noteByInvoice[invoice] = note;
    }
    return jsonWithCors(request, {
      run: run ? { id: run.id, status: run.status, ruleVersionId: run.scheme_version_id, periodStart: run.period_start, periodEnd: run.period_end, completedAt: run.completed_at } : null,
      totals,
      results: Array.isArray(settlementResults) ? settlementResults : [],
      candidates: candidates.data ?? [],
      creditNotes: noteByInvoice,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load Cash Discount settlements:", error);
    return jsonWithCors(request, { error: "Could not load Cash Discount results." }, { status: 500 });
  }
}
