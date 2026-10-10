import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { customerGroupsFor } from "@/lib/customer-groups";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resultResetCutoff, visibleResults } from "@/lib/evaluation/result-visibility";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

const SENT = ["sent", "delivered", "read", "whatsapp_sent"];
const n = (value: unknown) => Number(value ?? 0) || 0;

/**
 * Dashboard facts for one financial year (April-March), compact enough for the
 * page to total by quarter, customer group and scheme:
 *   cash: Cash Discount invoices from the latest check (earned = invoice date),
 *         plus the not-eligible tally per month and customer;
 *   notes: Credit Notes of both schemes (issued = Credit Note date), with WhatsApp and e-Invoice state;
 *   tod: Turnover Discount results per customer and period;
 *   messages: WhatsApp messages (sent date).
 * Customers are keyed by id; `customers` gives each one's name and Tally group.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const today = new Date();
    const currentFy = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    const fy = Number(new URL(request.url).searchParams.get("fy") ?? currentFy);
    if (!Number.isInteger(fy) || fy < 2015 || fy > 2100) return jsonWithCors(request, { error: "Invalid financial year." }, { status: 400 });
    const from = `${fy}-04-01`;
    const to = `${fy + 1}-03-31`;
    const supabase = createSupabaseAdminClient();
    const cutoff = await resultResetCutoff(company.id);

    const [cdRun, cdNotes, todNotes, proposals, messages, einvoices, todRun] = await Promise.all([
      visibleResults(supabase.from("evaluation_runs").select("completed_at, summary").eq("company_id", company.id).eq("status", "completed")
        .eq("summary->>cdDiscountBasis", "amount_per_tonne").order("completed_at", { ascending: false }), cutoff, "created_at").limit(1).maybeSingle(),
      supabase.from("cash_discount_debit_note_postings").select("id, status, amount, verified_amount, debit_note_date, debit_note_snapshot")
        .eq("company_id", company.id).eq("note_kind", "credit_note").neq("status", "cancelled").limit(20000),
      supabase.from("credit_note_postings").select("id, status, customer_id, proposal_id, credit_note_date, discount_amount, verified_amount, credit_note_snapshot")
        .eq("company_id", company.id).neq("status", "cancelled").limit(20000),
      visibleResults(supabase.from("discount_proposals").select("id, customer_id, status, period_start, period_end, eligible_tonnes, calculated_discount_amount, achieved_tier_id, updated_at")
        .eq("company_id", company.id).eq("scheme_type", "tod").lte("period_start", to).gte("period_end", from), cutoff, "latest_evaluated_at").limit(20000),
      supabase.from("notification_messages").select("event_type, status, sent_at, created_at, customer_contact_id, credit_note_posting_id, cash_discount_debit_note_posting_id")
        .eq("company_id", company.id).in("event_type", ["tod_credit_note_created", "cd_credit_note_created"]).limit(20000),
      supabase.from("note_einvoices").select("note_source, posting_id").eq("company_id", company.id).limit(20000),
      visibleResults(supabase.from("evaluation_runs").select("completed_at").eq("company_id", company.id).eq("request_context->>schemeType", "tod").eq("status", "completed")
        .order("completed_at", { ascending: false }), cutoff, "created_at").limit(1).maybeSingle(),
    ]);
    for (const result of [cdRun, cdNotes, todNotes, proposals, messages, todRun]) if (result.error) throw result.error;
    // note_einvoices exists after migration 20260927180000; before it, nothing is e-invoiced.
    const einvoiced = new Set((einvoices.error ? [] : einvoices.data ?? []).map((row) => `${row.note_source}:${row.posting_id}`));

    // WhatsApp per note: sent when any message went out; failed when the latest did not.
    const noteMessages = new Map<string, { sent: boolean; failed: boolean }>();
    for (const message of [...(messages.data ?? [])].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))) {
      const key = message.credit_note_posting_id ? `tod:${message.credit_note_posting_id}` : message.cash_discount_debit_note_posting_id ? `cd:${message.cash_discount_debit_note_posting_id}` : null;
      if (!key) continue;
      const entry = noteMessages.get(key) ?? { sent: false, failed: false };
      entry.sent = entry.sent || SENT.includes(message.status);
      entry.failed = ["failed", "suppressed"].includes(message.status);
      noteMessages.set(key, entry);
    }

    // ---- Cash Discount: invoices (earned) ------------------------------------
    const summary = (cdRun.data?.summary ?? {}) as Record<string, unknown>;
    const results = (Array.isArray(summary.settlementResults) ? summary.settlementResults : []) as Array<Record<string, unknown>>;
    const inFy = (date: unknown) => { const day = String(date ?? "").slice(0, 10); return day >= from && day <= to; };
    // Invoices whose Cash Discount Credit Note is already created in Tally.
    const creditedInvoices = new Set((cdNotes.data ?? []).filter((note) => note.status === "created_verified")
      .map((note) => ((note.debit_note_snapshot ?? {}) as { sourceInvoice?: { guid?: string } }).sourceInvoice?.guid).filter(Boolean));
    const cash = results.filter((row) => inFy(row.invoiceDate)).map((row) => [
      String(row.invoiceDate).slice(0, 10), String(row.customerId ?? ""), String(row.category ?? ""),
      n(row.eligibleTonnes), n(row.discountAmount), n(row.creditAmount),
      creditedInvoices.has(String(row.invoiceGuid)) || row.status === "credited",
    ]);
    const notEligible = Object.entries((summary.notEligibleByMonth ?? {}) as Record<string, [number, number]>)
      .filter(([key]) => { const month = key.slice(0, 7); return month >= from.slice(0, 7) && month <= to.slice(0, 7); })
      .map(([key, [count, tonnes]]) => [key.slice(0, 7), key.slice(8), count, tonnes]);

    // ---- Credit Notes (issued) ------------------------------------------------
    // When each note's discount was earned: TOD = its period start, CD = its invoice date.
    const proposalPeriod = new Map<string, string>();
    const todProposalIds = [...new Set((todNotes.data ?? []).map((note) => note.proposal_id).filter(Boolean))] as string[];
    for (let index = 0; index < todProposalIds.length; index += 200) {
      const { data: rows, error: periodError } = await supabase.from("discount_proposals").select("id, period_start").in("id", todProposalIds.slice(index, index + 200));
      if (periodError) throw periodError;
      for (const row of rows ?? []) proposalPeriod.set(row.id, row.period_start);
    }
    const notes = [
      ...(todNotes.data ?? []).map((note) => {
        const tally = ((note.credit_note_snapshot ?? {}) as { tallyPosting?: { gstNote?: { total?: unknown } } }).tallyPosting;
        const state = noteMessages.get(`tod:${note.id}`);
        return { s: "tod", d: note.credit_note_date, ed: proposalPeriod.get(note.proposal_id as string) ?? note.credit_note_date, c: note.customer_id, a: n(tally?.gstNote?.total ?? note.verified_amount ?? note.discount_amount), st: note.status, w: state?.sent ? "sent" : state?.failed ? "failed" : "none", e: einvoiced.has(`tod_credit_note:${note.id}`) };
      }),
      ...(cdNotes.data ?? []).map((note) => {
        const snapshot = (note.debit_note_snapshot ?? {}) as { party?: { guid?: string }; gstNote?: { total?: unknown }; cashDiscount?: { invoiceDate?: string } };
        const state = noteMessages.get(`cd:${note.id}`);
        return { s: "cd", d: note.debit_note_date, ed: snapshot.cashDiscount?.invoiceDate ?? note.debit_note_date, g: snapshot.party?.guid ?? "", a: n(snapshot.gstNote?.total ?? note.verified_amount ?? note.amount), st: note.status, w: state?.sent ? "sent" : state?.failed ? "failed" : "none", e: einvoiced.has(`cash_discount_note:${note.id}`) };
      }),
    ].filter((note) => inFy(note.d) || inFy(note.ed));

    // ---- Turnover Discount results: latest per customer and period -----------
    const latestTod = new Map<string, Record<string, unknown>>();
    for (const proposal of proposals.data ?? []) {
      const key = `${proposal.customer_id}:${proposal.period_start}:${proposal.period_end}`;
      const current = latestTod.get(key);
      if (!current || String(proposal.updated_at) > String(current.updated_at)) latestTod.set(key, proposal);
    }
    const createdProposals = new Set((todNotes.data ?? []).filter((note) => note.status === "created_verified").map((note) => note.proposal_id));
    const tod = [...latestTod.values()].map((proposal) => ({
      ps: proposal.period_start, pe: proposal.period_end, c: proposal.customer_id,
      q: Boolean(proposal.achieved_tier_id), mt: n(proposal.eligible_tonnes), a: n(proposal.calculated_discount_amount),
      cr: createdProposals.has(proposal.id as string),
    }));

    // ---- Customers and their Tally groups -----------------------------------
    const cdGuids = [...new Set([...cash.map((row) => String(row[1])), ...notEligible.map((row) => String(row[1])), ...notes.map((note) => ("g" in note ? note.g : ""))].filter(Boolean))];
    const ids = [...new Set([...notes.map((note) => ("c" in note ? note.c : "")), ...tod.map((row) => row.c)].filter(Boolean))] as string[];
    const groups = await customerGroupsFor(supabase, company.id, { ids, ledgerGuids: cdGuids });
    const customers: Record<string, { name: string | null; group: string | null }> = {};
    for (const info of [...groups.byId.values(), ...groups.byGuid.values()]) customers[info.customerId] = { name: info.ledgerName, group: info.groupName };
    const guidToId = Object.fromEntries([...groups.byGuid.entries()].map(([guid, info]) => [guid, info.customerId]));

    return jsonWithCors(request, {
      fy, from, to,
      checks: { cashDiscountAt: cdRun.data?.completed_at ?? null, turnoverDiscountAt: todRun.data?.completed_at ?? null },
      // Checks before the per-month tally cannot give an honest "paid on time" share.
      notEligibleTracked: Boolean(summary.notEligibleByMonth) || n(summary.notEligibleCount) === 0,
      customers,
      // Cash Discount rows keyed by customer id (ledger GUIDs mapped).
      // [invoice date, customer id, category, MT, discount, Credit Note amount, credited]
      cash: cash.map((row) => [row[0], guidToId[String(row[1])] ?? `guid:${row[1]}`, row[2], row[3], row[4], row[5], row[6]]),
      notEligible: notEligible.map((row) => [row[0], guidToId[String(row[1])] ?? `guid:${row[1]}`, row[2], row[3]]),
      notes: notes.map((note) => ({ s: note.s, d: note.d, ed: String(note.ed ?? "").slice(0, 10), c: "c" in note ? note.c : guidToId[note.g] ?? `guid:${note.g}`, a: note.a, st: note.st, w: note.w, e: note.e })),
      tod,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load the dashboard:", error);
    return jsonWithCors(request, { error: "Could not load the dashboard." }, { status: 500 });
  }
}
