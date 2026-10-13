import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { postingProgress } from "@/lib/notes/posting-progress.mjs";

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
    const invoiceGuid = new URL(request.url).searchParams.get("invoice");
    // The check, the candidates, the Credit Notes and the WhatsApp messages do not depend on each other.
    const [runResult, candidates, notes, messageResult] = await Promise.all([
      supabase.from("evaluation_runs")
        .select("id, status, scheme_version_id, period_start, period_end, completed_at, created_at, summary")
        .eq("company_id", company.id).eq("status", "completed").eq("summary->>cdDiscountBasis", "amount_per_tonne")
        .order("completed_at", { ascending: false }).limit(1),
      invoiceGuid ? null : supabase.from("cash_discount_recovery_candidates").select("id, invoice_tally_guid, status, remaining_recovery, settlement_category")
        .eq("company_id", company.id).eq("current_snapshot", true).eq("candidate_kind", "settlement"),
      invoiceGuid ? null : supabase.from("cash_discount_debit_note_postings").select("id, status, amount, verified_voucher_number, verified_at, failure_reason, created_at, invoice:debit_note_snapshot->sourceInvoice->>guid")
        .eq("company_id", company.id).eq("note_kind", "credit_note").order("created_at", { ascending: false }).limit(5000),
      invoiceGuid ? null : supabase.from("notification_messages")
        .select("cash_discount_debit_note_posting_id, status, sent_at, created_at")
        .eq("company_id", company.id).not("cash_discount_debit_note_posting_id", "is", null)
        .order("created_at", { ascending: false }).limit(5000),
    ]);
    if (runResult.error) throw runResult.error;
    const run = runResult.data?.[0] ?? null;

    // One invoice (the Credit Note page opens its check in place): only that
    // invoice's row and Credit Note, not the whole period.
    if (invoiceGuid) {
      const allRows = ((run?.summary as { settlementResults?: unknown } | null)?.settlementResults ?? []) as Array<Record<string, unknown>>;
      const row = allRows.find((item) => item.invoiceGuid === invoiceGuid) ?? null;
      if (row && row.customerGroup === undefined && row.customerId) {
        const { data: customer } = await supabase.from("customers").select("customer_groups(name)")
          .eq("company_id", company.id).eq("tally_ledger_guid", String(row.customerId)).maybeSingle();
        const group = customer?.customer_groups as { name?: string } | { name?: string }[] | null | undefined;
        row.customerGroup = (Array.isArray(group) ? group[0]?.name : group?.name) ?? null;
      }
      const { data: noteRows, error: noteError } = await supabase.from("cash_discount_debit_note_postings")
        .select("id, status, amount, verified_voucher_number, verified_at, failure_reason, created_at")
        .eq("company_id", company.id).eq("note_kind", "credit_note").eq("debit_note_snapshot->sourceInvoice->>guid", invoiceGuid)
        .order("created_at", { ascending: false }).limit(1);
      if (noteError) throw noteError;
      const creditNote = (noteRows?.[0] ?? null) as Record<string, unknown> | null;
      if (creditNote) {
        const { data: latest, error: latestError } = await supabase.from("notification_messages")
          .select("status, sent_at, created_at").eq("company_id", company.id).eq("cash_discount_debit_note_posting_id", String(creditNote.id))
          .order("created_at", { ascending: false }).limit(1);
        if (latestError) throw latestError;
        creditNote.whatsapp = latest?.[0] ? { status: String(latest[0].status), sentAt: latest[0].sent_at ?? null } : null;
      }
      return jsonWithCors(request, { row, creditNote }, { headers: { "Cache-Control": "no-store" } });
    }

    if (!candidates || !notes || !messageResult) throw new Error("Cash Discount lists were not loaded.");
    if (candidates.error) throw candidates.error;
    if (notes.error) throw notes.error;
    const summary = (run?.summary ?? {}) as Record<string, unknown>;
    const { settlementResults, ...totals } = summary;
    const allResults = (Array.isArray(settlementResults) ? settlementResults : []) as Array<Record<string, unknown>>;
    // Checks saved before these fields existed: drop not-eligible rows (kept as
    // a count), and derive the invoice period and customer groups here.
    const results = allResults.filter((row) => row.category !== "not_eligible");
    if (typeof totals.notEligibleCount !== "number") totals.notEligibleCount = allResults.length - results.length;
    if (typeof totals.invoicesChecked !== "number") totals.invoicesChecked = allResults.length;
    if (!totals.invoicePeriod && run?.period_start && run.period_end) {
      const { data: version } = await supabase.from("scheme_versions").select("effective_to").eq("id", run.scheme_version_id).maybeSingle();
      const endDate = version?.effective_to && version.effective_to < run.period_end ? version.effective_to : run.period_end;
      totals.invoicePeriod = { from: run.period_start, to: endDate };
    }
    const missingGroups = [...new Set(results.filter((row) => row.customerGroup === undefined).map((row) => String(row.customerId ?? "")).filter(Boolean))];
    if (missingGroups.length) {
      const groupByCustomer = new Map<string, string>();
      for (let index = 0; index < missingGroups.length; index += 200) {
        const { data: customers, error: customerError } = await supabase.from("customers")
          .select("tally_ledger_guid, customer_groups(name)")
          .eq("company_id", company.id).in("tally_ledger_guid", missingGroups.slice(index, index + 200));
        if (customerError) throw customerError;
        for (const customer of customers ?? []) {
          const group = customer.customer_groups as { name?: string } | { name?: string }[] | null;
          const name = Array.isArray(group) ? group[0]?.name : group?.name;
          if (name) groupByCustomer.set(customer.tally_ledger_guid, name);
        }
      }
      for (const row of results) if (row.customerGroup === undefined) row.customerGroup = groupByCustomer.get(String(row.customerId ?? "")) ?? null;
    }
    // Newest Credit Note per invoice.
    const noteByInvoice: Record<string, Record<string, unknown>> = {};
    for (const note of (notes.data ?? []) as Array<Record<string, unknown>>) {
      const invoice = String(note.invoice ?? "");
      if (invoice && !noteByInvoice[invoice]) noteByInvoice[invoice] = note;
    }
    const pendingNotes = Object.values(noteByInvoice).filter((note) => ["queued", "sending"].includes(String(note.status)));
    if (pendingNotes.length) {
      const { data: commands, error: progressError } = await supabase.from("tally_commands")
        .select("status,command_type,payload,locked_at,created_at")
        .eq("company_id", company.id).eq("command_type", "create_debit_note")
        .in("payload->>debitNotePostingId", pendingNotes.map((note) => String(note.id)))
        .order("created_at", { ascending: false });
      if (progressError) throw progressError;
      const commandByNote = new Map<string, NonNullable<typeof commands>[number]>();
      for (const command of commands ?? []) {
        const id = String(command.payload?.debitNotePostingId ?? "");
        if (!commandByNote.has(id)) commandByNote.set(id, command);
      }
      for (const note of pendingNotes) note.progress = postingProgress(note, commandByNote.get(String(note.id)));
    }
    // Latest WhatsApp message for each created Credit Note (sent manually from Credit Notes).
    const { data: messages, error: messagesError } = messageResult;
    if (messagesError) throw messagesError;
    const messageByNote = new Map<string, { status: string; sentAt: string | null }>();
    for (const message of messages ?? []) {
      const noteId = String(message.cash_discount_debit_note_posting_id);
      if (!messageByNote.has(noteId)) messageByNote.set(noteId, { status: String(message.status), sentAt: message.sent_at ?? null });
    }
    for (const note of Object.values(noteByInvoice)) note.whatsapp = messageByNote.get(String(note.id)) ?? null;
    return jsonWithCors(request, {
      run: run ? { id: run.id, status: run.status, ruleVersionId: run.scheme_version_id, periodStart: run.period_start, periodEnd: run.period_end, completedAt: run.completed_at } : null,
      totals,
      results,
      candidates: candidates.data ?? [],
      creditNotes: noteByInvoice,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load Cash Discount settlements:", error);
    return jsonWithCors(request, { error: "Could not load Cash Discount results." }, { status: 500 });
  }
}
