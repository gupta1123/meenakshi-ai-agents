"use client";

// Per-MT Cash Discount page (docs/CD_LOGIC.md). Invoices go out at full price;
// a customer who pays the discounted amount within the segment's working-day
// window gets a Credit Note for the discount. Shown instead of the recovery
// (Debit Note) page when the active Cash Discount rule is a per-MT rule.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { runLocalCashDiscount, type LocalCdBootstrap } from "@/lib/local-tally";
import { userFacingError } from "@/lib/user-copy";

import { WorkspacePageHeader } from "./app-shell";
import { useCompany } from "./company-context";
import { Button, EmptyState, InlineMessage, Skeleton, StatusBadge, formatDate, formatMoney, formatTonnes } from "./ui";
import { accessToken } from "./workspace";

type Category = "full_payment" | "discounted_payment" | "over_ninety_percent" | "awaiting_payment" | "not_eligible" | "needs_review";
export type CdSettlementRow = {
  customerName: string; invoiceGuid: string; invoiceNumber: string | null; invoiceDate: string;
  segmentLabel: string; windowWorkingDays: number; windowDeadline: string; windowOpen: boolean;
  invoiceAmount: string; eligibleTonnes: string; amountPerTonne: string; discountAmount: string; discountedTarget: string;
  paidByDeadline: string; paidToDate: string; alreadyCredited: string; creditAmount: string;
  category: Category; status: string; gstLastDate: string; gstDeadlinePassed: boolean;
  paymentCount: number; latestPaymentDate: string | null; reviewMessage: string | null;
};
type CreditNote = { id: string; status: string; amount: string; verified_voucher_number: string | null; failure_reason: string | null };
type SettlementData = {
  run: { id: string; completedAt: string | null; periodStart: string | null; periodEnd: string | null } | null;
  results: CdSettlementRow[];
  candidates: Array<{ id: string; invoice_tally_guid: string; status: string; remaining_recovery: string }>;
  creditNotes: Record<string, CreditNote>;
};

const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-${Date.now()}`;
const shortDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};
// Tabs in the client's order; the rest sit under "Other".
const TABS: Array<{ key: Category | "other"; label: string; hint: string }> = [
  { key: "full_payment", label: "Full payment", hint: "Paid in full — no discount claimed" },
  { key: "over_ninety_percent", label: "More than 90%", hint: "Your decision — Credit Note for what is short, up to the discount" },
  { key: "discounted_payment", label: "Discounted payment", hint: "Paid invoice − discount on time — Credit Note for the discount" },
  { key: "other", label: "Other", hint: "Window still open, paid late or too little, or needs review" },
];

export function CashDiscountSettlementsPage({ isAdministrator, setNotice, setError }: {
  isAdministrator: boolean;
  setNotice: (value: string | null) => void; setError: (value: string | null) => void;
}) {
  const { company, companyKey } = useCompany();
  // Credit Notes are created only while Credit Note creation is on for the company.
  const [postingEnabled, setPostingEnabled] = useState(false);
  useEffect(() => {
    void (async () => {
      const token = await accessToken(); if (!token) return;
      try {
        const response = await apiRequest<{ launchControl: { mode: string } }>(token, `/api/companies/${company.id}/launch-control`, { cache: "no-store" });
        setPostingEnabled(response.launchControl.mode === "posting_enabled");
      } catch { setPostingEnabled(false); }
    })();
  }, [company.id]);
  const [data, setData] = useState<SettlementData | null>(null);
  const [liveRows, setLiveRows] = useState<CdSettlementRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<"reading" | "saving" | null>(null);
  const [tab, setTab] = useState<Category | "other">("discounted_payment");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await accessToken(); if (!token) return;
    try { setData(await apiRequest<SettlementData>(token, `/api/companies/${company.id}/cash-discount/settlements`, { cache: "no-store" })); }
    catch (cause) { setError(userFacingError(cause, "Could not load Cash Discount results.")); }
    finally { setLoading(false); }
  }, [company.id, setError]);
  useEffect(() => { setLoading(true); setData(null); setLiveRows(null); void load(); }, [companyKey, load]);
  // Follow Credit Notes that are being created in Tally.
  const creating = Object.values(data?.creditNotes ?? {}).some((note) => ["queued", "sending"].includes(note.status));
  useEffect(() => {
    if (!creating) return;
    const timer = window.setInterval(() => { void load(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [creating, load]);

  const calculate = async () => {
    setPhase("reading"); setError(null); setNotice(null);
    try {
      const token = await accessToken(); if (!token) return;
      const evaluatedOn = new Date().toISOString().slice(0, 10);
      const bootstrap = await apiRequest<LocalCdBootstrap>(token, `/api/companies/${company.id}/evaluations/cd/local-bootstrap?evaluatedOn=${evaluatedOn}`);
      const result = await runLocalCashDiscount(bootstrap) as unknown as { results: CdSettlementRow[]; evidence: Record<string, unknown> };
      setLiveRows(result.results ?? []);
      setPhase("saving");
      const saved = await apiRequest<{ totals?: { autoQueued?: number } }>(token, `/api/companies/${company.id}/evaluations/cd/local-result`, {
        method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: jsonBody({ evaluatedOn, evidence: result.evidence }), timeoutMs: 90_000,
      });
      await load();
      setLiveRows(null);
      const queued = saved.totals?.autoQueued ?? 0;
      setNotice(queued ? `${queued} Credit Note${queued === 1 ? " is" : "s are"} being created in Tally for discounted payments.` : "Cash Discount check saved.");
    } catch (cause) { setError(userFacingError(cause, "The Cash Discount check did not finish. Keep Tally open and try again.")); }
    finally { setPhase(null); }
  };

  const createCreditNote = async (row: CdSettlementRow, candidateId: string) => {
    if (busyId) return;
    setBusyId(candidateId); setError(null);
    try {
      const token = await accessToken(); if (!token) return;
      await apiRequest(token, `/api/companies/${company.id}/cash-discount/settlements/${candidateId}/credit-note`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, timeoutMs: 45_000 });
      setNotice(`Credit Note for ${row.customerName} (${row.invoiceNumber ?? "invoice"}) is being created in Tally.`);
      await load();
    } catch (cause) { setError(userFacingError(cause, "Could not create this Credit Note.")); }
    finally { setBusyId(null); }
  };

  const rows = liveRows ?? data?.results ?? [];
  const inTab = (row: CdSettlementRow) => tab === "other" ? !["full_payment", "over_ninety_percent", "discounted_payment"].includes(row.category) : row.category === tab;
  const q = query.trim().toLowerCase();
  const visible = rows.filter(inTab).filter((row) => !q || row.customerName.toLowerCase().includes(q) || (row.invoiceNumber ?? "").toLowerCase().includes(q));
  const counts = useMemo(() => Object.fromEntries(TABS.map((item) => [item.key, rows.filter((row) => item.key === "other" ? !["full_payment", "over_ninety_percent", "discounted_payment"].includes(row.category) : row.category === item.key).length])), [rows]);
  const tabAmount = (key: Category | "other") => rows.filter((row) => row.category === key).reduce((total, row) => total + Number(row.creditAmount || 0), 0);
  const candidateByInvoice = new Map((data?.candidates ?? []).map((candidate) => [candidate.invoice_tally_guid, candidate]));
  const activeTab = TABS.find((item) => item.key === tab)!;

  if (loading) return <><WorkspacePageHeader title="Cash Discount" /><section className="cd-check-summary cd-check-summary-loading" aria-label="Loading Cash Discount"><Skeleton lines={3} /></section></>;

  return <>
    <WorkspacePageHeader title="Cash Discount" />
    <section className="tod-overview cd-overview" aria-label="Latest Cash Discount check">
      <div className="tod-overview-meta">
        <div className="tod-period-context">{phase ? <StatusBadge status={phase === "saving" ? "posting" : "evaluating"}>{phase === "saving" ? "Saving" : "Checking"}</StatusBadge> : data?.run ? <StatusBadge status="ready" /> : <StatusBadge status="not_started">Not checked</StatusBadge>}<strong>₹ per MT · working-day windows</strong><span><CircleAlert size={13} />Credit Note when the discounted amount is paid on time</span></div>
        <div className="tod-overview-actions"><span>{phase ? "Checking Tally…" : data?.run?.completedAt ? `Calculated ${formatDate(data.run.completedAt)}` : "Not calculated yet"}</span>
          <Button className="button-secondary" disabled={Boolean(phase)} onClick={() => void calculate()}><RefreshCw className={phase ? "spin" : undefined} size={15} />{phase ? "Checking Tally…" : "Calculate"}</Button>
          <Link className="button button-quiet" href="/rulebook">Active rule</Link></div>
      </div>
      {!data?.run && !phase && <div className="cd-overview-body"><h2>Run a Tally check</h2><p>Press Calculate to sort invoices into Full payment, More than 90% and Discounted payment.</p></div>}
    </section>
    {!postingEnabled && <InlineMessage tone="info">Credit Note creation is off, so nothing is created in Tally automatically. Turn it on from Turnover Discount → Ready to create.</InlineMessage>}
    {rows.length > 0 && <div className="cd-action-cards" role="tablist" aria-label="Cash Discount categories">
      {TABS.map((item) => <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={`cd-action-card${tab === item.key ? " selected" : ""}${item.key === "over_ninety_percent" && counts[item.key] ? " has-attention" : ""}`} onClick={() => setTab(item.key)}>
        <span>{item.label}</span>
        <strong>{item.key === "discounted_payment" || item.key === "over_ninety_percent" ? formatMoney(tabAmount(item.key)) : counts[item.key]}</strong>
        <small>{item.key === "discounted_payment" || item.key === "over_ninety_percent" ? `${counts[item.key]} invoice${counts[item.key] === 1 ? "" : "s"}` : item.key === "full_payment" ? "no Credit Note" : "no discount yet"}</small>
      </button>)}
    </div>}
    {rows.length > 0 && <section className="surface-card cd-settlement-card">
      <div className="tod-results-bar"><div className="tod-table-title"><h2>{activeTab.label}</h2><p className="tod-table-summary"><span>{activeTab.hint}</span></p></div>
        <label className="tod-results-search"><span className="sr-only">Find customer or invoice</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer or invoice" /></label></div>
      {visible.length ? <div className="data-table cd-settlement-table"><div className="table-head"><span>Customer and invoice</span><span>Window</span><span>Paid by deadline</span><span>Discount</span><span>Credit Note</span></div>
        {visible.map((row) => {
          const note = data?.creditNotes[row.invoiceGuid];
          const candidate = candidateByInvoice.get(row.invoiceGuid);
          const canCreate = isAdministrator && postingEnabled && candidate && ["action_required", "review_required"].includes(candidate.status) && (!note || ["failed", "cancelled"].includes(note.status));
          return <article key={row.invoiceGuid}>
            <div><strong>{row.customerName}</strong><small>Inv {row.invoiceNumber ?? "—"} · {shortDate(row.invoiceDate)} · {formatMoney(row.invoiceAmount)}</small></div>
            <div><strong>{row.windowWorkingDays} working days</strong><small>{row.segmentLabel} · due {shortDate(row.windowDeadline)}{row.windowOpen ? " · open" : ""}</small></div>
            <div><strong>{formatMoney(row.paidByDeadline)}</strong><small>{row.category === "discounted_payment" ? `target ${formatMoney(row.discountedTarget)}` : row.category === "over_ninety_percent" ? `${(Number(row.paidByDeadline) / Number(row.invoiceAmount) * 100).toFixed(1)}% · short ${formatMoney(Number(row.invoiceAmount) - Number(row.paidByDeadline))}` : row.latestPaymentDate ? `last payment ${shortDate(row.latestPaymentDate)}` : "no payment"}</small></div>
            <div><strong>{formatMoney(row.discountAmount)}</strong><small>{formatTonnes(row.eligibleTonnes)} MT × ₹{Number(row.amountPerTonne).toLocaleString("en-IN")}/MT</small></div>
            <div className="cd-settlement-note">
              {note?.status === "created_verified" ? <StatusBadge status="created_verified">CN {note.verified_voucher_number ?? "created"}</StatusBadge>
                : note && ["queued", "sending"].includes(note.status) ? <StatusBadge status="posting">Creating in Tally…</StatusBadge>
                : row.status === "credited" ? <StatusBadge status="created_verified">Already credited</StatusBadge>
                : canCreate ? <Button className="button-secondary" disabled={busyId === candidate!.id} onClick={() => void createCreditNote(row, candidate!.id)}>{busyId === candidate!.id ? "Queuing…" : `Create ₹${Number(row.creditAmount).toLocaleString("en-IN")}`}</Button>
                : <small>{row.category === "full_payment" ? "Not needed" : row.category === "discounted_payment" || row.category === "over_ninety_percent" ? row.gstDeadlinePassed ? "GST deadline passed" : postingEnabled ? "Save the check first" : "Creation is off" : row.category === "awaiting_payment" ? "Window open" : row.category === "needs_review" ? row.reviewMessage ?? "Needs review" : "No discount"}</small>}
              {note?.status === "failed" && <small className="field-error">{note.failure_reason ?? "Tally rejected it"}</small>}
            </div>
          </article>;
        })}</div>
        : <EmptyState title="No invoices here" detail={q ? "No customer or invoice matches the search." : "Nothing in this category from the latest check."} />}
    </section>}
    {!rows.length && data?.run && !phase && <EmptyState title="No invoices were checked" detail="No Sales invoice with eligible products was found for customers in the rule's segments." action={<Link className="button button-secondary" href="/rulebook">Review active rule</Link>} />}
  </>;
}
