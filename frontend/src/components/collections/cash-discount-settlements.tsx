"use client";

// Per-MT Cash Discount page (docs/CD_LOGIC.md). Invoices go out at full price;
// a customer who pays the discounted amount within the segment's working-day
// window gets a Credit Note for the discount. Shown instead of the recovery
// (Debit Note) page when the active Cash Discount rule is a per-MT rule.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, RefreshCw } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { readLocalProgress, runLocalCashDiscount, type LocalCdBootstrap, type LocalProgress } from "@/lib/local-tally";
import { userFacingError } from "@/lib/user-copy";

import { WorkspacePageHeader } from "./app-shell";
import { useCompany } from "./company-context";
import { Button, Dialog, EmptyState, InlineMessage, Skeleton, StatusBadge, formatDate, formatMoney, formatTonnes } from "./ui";
import { accessToken } from "./workspace";
import { CdInvoicePanel } from "./cd-invoice-panel";
import type { Calendar } from "./types";

const NO_GROUP = "__no_group__";

type Category = "full_payment" | "discounted_payment" | "over_ninety_percent" | "awaiting_payment" | "not_eligible" | "needs_review";
export type CdSettlementRow = {
  customerName: string; invoiceGuid: string; invoiceNumber: string | null; invoiceDate: string;
  segmentLabel: string; windowWorkingDays: number; windowDeadline: string; windowOpen: boolean;
  invoiceAmount: string; eligibleTonnes: string; amountPerTonne: string; discountAmount: string; discountedTarget: string;
  paidByDeadline: string; paidToDate: string; alreadyCredited: string; creditAmount: string;
  category: Category; status: string; gstLastDate: string; gstDeadlinePassed: boolean;
  paymentCount: number; latestPaymentDate: string | null; reviewMessage: string | null;
  customerGroup?: string | null;
  payments?: Array<{ voucherNumber: string | null; voucherType: string | null; date: string; amount: string; counted: boolean }>;
  productLines?: Array<{ name: string; quantity: string; unit: string; tonnes: string }>;
};
type CreditNote = { id: string; status: string; amount: string; verified_voucher_number: string | null; verified_at?: string | null; failure_reason: string | null; whatsapp?: { status: string; sentAt: string | null } | null };
type SettlementData = {
  run: { id: string; completedAt: string | null; periodStart: string | null; periodEnd: string | null } | null;
  results: CdSettlementRow[];
  candidates: Array<{ id: string; invoice_tally_guid: string; status: string; remaining_recovery: string }>;
  creditNotes: Record<string, CreditNote>;
  totals?: { invoicesChecked?: number; notEligibleCount?: number; invoicePeriod?: { from: string; to: string } };
};

const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-${Date.now()}`;
const shortDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};
// Tabs in the client's order; the rest sit under "Other".
type Tab = Category | "other" | "all";
const CATEGORY_TAG: Record<string, string> = { full_payment: "Full payment", discounted_payment: "Discounted", over_ninety_percent: "Short up to ₹10,000", awaiting_payment: "Window open", needs_review: "Needs review", not_eligible: "Not eligible" };
const TABS: Array<{ key: Tab; label: string; hint: string }> = [
  { key: "all", label: "All", hint: "Every invoice from the latest check, whatever its category." },
  { key: "full_payment", label: "Full payment", hint: "Full bill paid on time. The Credit Note leaves the discount as a credit." },
  { key: "over_ninety_percent", label: "Short up to ₹10,000", hint: "Paid on time but short of the bill by ₹10,000 or less. Review each one." },
  { key: "discounted_payment", label: "Discounted payment", hint: "Bill minus discount paid on time. The Credit Note closes the bill." },
  { key: "other", label: "Waiting / review", hint: "Payment window still open, or the invoice needs review." },
];

export function CashDiscountSettlementsPage({ isAdministrator, setNotice }: {
  isAdministrator: boolean;
  setNotice: (value: string | null) => void; setError?: (value: string | null) => void;
}) {
  const { company, companyKey } = useCompany();
  // Errors stay on this page: the shared workspace error would replace the
  // whole page with "Workspace unavailable".
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => { setNotice(flash); if (!flash) return; const timer = setTimeout(() => setFlash(null), 6000); return () => clearTimeout(timer); }, [flash, setNotice]);
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
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [segmentFilter, setSegmentFilter] = useState("all");
  // Large periods produce thousands of invoices; draw one page at a time.
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [tab, query, groupFilter, segmentFilter]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Bulk creation inside a group, like the Turnover Discount page (25 at a time).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);
  useEffect(() => { setSelectedIds([]); }, [tab, groupFilter, segmentFilter, query]);
  const [openGuid, setOpenGuid] = useState<string | null>(null);
  // Linked from a Credit Note: open that invoice's panel once results are loaded.
  const linkedInvoice = useSearchParams()?.get("invoice") ?? null;
  const [linkHandled, setLinkHandled] = useState(false);
  const [calendar, setCalendar] = useState<Calendar | null>(null);
  useEffect(() => {
    void (async () => {
      const token = await accessToken(); if (!token) return;
      try { const response = await apiRequest<{ calendars: Calendar[] }>(token, `/api/companies/${company.id}/calendars`); setCalendar(response.calendars[0] ?? null); }
      catch { setCalendar(null); }
    })();
  }, [company.id]);

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

  // While the connector reads Tally, poll its progress once a second.
  const [progress, setProgress] = useState<LocalProgress | null>(null);
  useEffect(() => {
    if (phase !== "reading") { setProgress(null); return; }
    let cancelled = false;
    const tick = async () => { const next = await readLocalProgress(); if (!cancelled && next?.task === "cash_discount") setProgress(next); };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [phase]);
  const progressPercent = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const shortDay = (value: string | null | undefined) => value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "";

  const calculate = async () => {
    setPhase("reading"); setError(null); setFlash(null);
    try {
      const token = await accessToken(); if (!token) return;
      const evaluatedOn = new Date().toISOString().slice(0, 10);
      const bootstrap = await apiRequest<LocalCdBootstrap>(token, `/api/companies/${company.id}/evaluations/cd/local-bootstrap?evaluatedOn=${evaluatedOn}`);
      const result = await runLocalCashDiscount(bootstrap) as unknown as { results: CdSettlementRow[]; evidence: Record<string, unknown> };
      setLiveRows((result.results ?? []).filter((row) => row.category !== "not_eligible"));
      setPhase("saving");
      const saved = await apiRequest<{ totals?: { autoQueued?: number } }>(token, `/api/companies/${company.id}/evaluations/cd/local-result`, {
        method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: jsonBody({ evaluatedOn, evidence: result.evidence }), timeoutMs: 300_000,
      });
      await load();
      setLiveRows(null);
      const queued = saved.totals?.autoQueued ?? 0;
      setFlash(queued ? `${queued} Credit Note${queued === 1 ? " is" : "s are"} being created in Tally.` : "Cash Discount check saved. Create Credit Notes from the Full payment, Discounted payment and Short up to ₹10,000 lists.");
    } catch (cause) { setError(userFacingError(cause, "The Cash Discount check did not finish. Keep Tally open and try again.")); }
    finally { setPhase(null); }
  };

  const createCreditNote = async (row: CdSettlementRow, candidateId: string) => {
    if (busyId) return;
    setBusyId(candidateId); setError(null);
    try {
      const token = await accessToken(); if (!token) return;
      await apiRequest(token, `/api/companies/${company.id}/cash-discount/settlements/${candidateId}/credit-note`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, timeoutMs: 45_000 });
      setFlash(`Credit Note for ${row.customerName} (${row.invoiceNumber ?? "invoice"}) is being created in Tally.`);
      await load();
    } catch (cause) { setError(userFacingError(cause, "Could not create this Credit Note.")); }
    finally { setBusyId(null); }
  };

  const createSelectedCreditNotes = async (candidateIds: string[]) => {
    if (!candidateIds.length || bulkCreating) return;
    setBulkCreating(true); setError(null);
    try {
      const token = await accessToken(); if (!token) return;
      const response = await apiRequest<{ queued: number; skipped: number; message: string }>(token, `/api/companies/${company.id}/cash-discount/settlements/bulk-credit-notes`, { method: "POST", body: jsonBody({ candidateIds }), timeoutMs: 90_000 });
      setFlash(`${response.message}${response.skipped ? ` ${response.skipped} changed since the check and ${response.skipped === 1 ? "was" : "were"} skipped.` : ""} Keep Tally open with ${company.tally_company_name}.`);
      setSelectedIds([]);
      await load();
    } catch (cause) { setError(userFacingError(cause, "Could not create the selected Credit Notes.")); }
    finally { setBulkCreating(false); }
  };

  const rows = liveRows ?? data?.results ?? [];
  useEffect(() => {
    if (!linkedInvoice || linkHandled || !rows.length) return;
    setLinkHandled(true);
    if (rows.some((row) => row.invoiceGuid === linkedInvoice)) { setTab("all"); setOpenGuid(linkedInvoice); }
  }, [linkedInvoice, linkHandled, rows]);
  const inTab = (row: CdSettlementRow) => tab === "all" ? true : tab === "other" ? !["full_payment", "over_ninety_percent", "discounted_payment"].includes(row.category) : row.category === tab;
  const q = query.trim().toLowerCase();
  const segments = useMemo(() => [...new Set(rows.map((row) => row.segmentLabel).filter(Boolean))].sort(), [rows]);
  const candidateByInvoice = new Map((data?.candidates ?? []).map((candidate) => [candidate.invoice_tally_guid, candidate]));
  const groupKey = (row: CdSettlementRow) => row.customerGroup || NO_GROUP;
  const matchesFilters = (row: CdSettlementRow) => (groupFilter === "all" || groupKey(row) === groupFilter) && (segmentFilter === "all" || row.segmentLabel === segmentFilter);
  // Salesperson groups for the selected category, like the Turnover Discount page.
  const groupSummaries = useMemo(() => {
    const byGroup = new Map<string, { key: string; name: string; invoices: number; customers: Set<string>; segments: Set<string>; credit: number; billed: number; tonnes: number; toCreate: number; toCreateAmount: number; created: number }>();
    for (const row of rows) {
      if (!inTab(row) || (segmentFilter !== "all" && row.segmentLabel !== segmentFilter)) continue;
      const key = groupKey(row);
      const group = byGroup.get(key) ?? { key, name: key === NO_GROUP ? "No group" : key, invoices: 0, customers: new Set<string>(), segments: new Set<string>(), credit: 0, billed: 0, tonnes: 0, toCreate: 0, toCreateAmount: 0, created: 0 };
      const note = data?.creditNotes[row.invoiceGuid];
      const candidate = candidateByInvoice.get(row.invoiceGuid);
      group.invoices += 1;
      group.customers.add(row.customerName);
      if (row.segmentLabel) group.segments.add(row.segmentLabel);
      group.credit += Number(row.creditAmount || 0);
      group.billed += Number(row.invoiceAmount || 0);
      group.tonnes += Number(row.eligibleTonnes || 0);
      if (note?.status === "created_verified" || row.status === "credited") group.created += 1;
      else if (candidate && ["action_required", "review_required"].includes(candidate.status) && !row.gstDeadlinePassed) { group.toCreate += 1; group.toCreateAmount += Number(row.creditAmount || 0); }
      byGroup.set(key, group);
    }
    return [...byGroup.values()]
      .map((group) => ({ ...group, customers: group.customers.size, segments: [...group.segments].sort() }))
      .sort((left, right) => right.credit - left.credit || right.invoices - left.invoices || left.name.localeCompare(right.name));
  }, [rows, tab, segmentFilter, data, candidateByInvoice]);
  // Cards first; a search goes straight to matching invoices across groups.
  const showCards = groupFilter === "all" && !q && groupSummaries.length > 1;
  const visible = rows.filter(inTab).filter(matchesFilters).filter((row) => !q || row.customerName.toLowerCase().includes(q) || (row.invoiceNumber ?? "").toLowerCase().includes(q));
  const scopedRows = useMemo(() => groupFilter === "all" ? rows : rows.filter((row) => (row.customerGroup || NO_GROUP) === groupFilter), [rows, groupFilter]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((item) => [item.key, scopedRows.filter((row) => item.key === "all" ? true : item.key === "other" ? !["full_payment", "over_ninety_percent", "discounted_payment"].includes(row.category) : row.category === item.key).length])), [scopedRows]);
  // Still to create: has a Credit Note amount, not yet credited, GST deadline not passed.
  const pendingAmount = (key: Tab) => scopedRows.filter((row) => (key === "all" || row.category === key) && Number(row.creditAmount) > 0 && row.status !== "credited" && data?.creditNotes[row.invoiceGuid]?.status !== "created_verified" && !row.gstDeadlinePassed).reduce((total, row) => total + Number(row.creditAmount || 0), 0);
  const tabAmount = (key: Tab) => scopedRows.filter((row) => key === "all" || row.category === key).reduce((total, row) => total + Number(row.creditAmount || 0), 0);
  const activeTab = TABS.find((item) => item.key === tab)!;
  const creatableCandidate = (row: CdSettlementRow) => {
    const candidate = candidateByInvoice.get(row.invoiceGuid);
    const note = data?.creditNotes[row.invoiceGuid];
    return isAdministrator && postingEnabled && candidate && ["action_required", "review_required"].includes(candidate.status) && (!note || ["failed", "cancelled"].includes(note.status)) ? candidate : null;
  };
  // Selection is offered once inside a group (or a search), never on the group cards.
  const pageRows = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selectablePageIds = showCards ? [] : pageRows.map((row) => creatableCandidate(row)?.id).filter((id): id is string => Boolean(id));
  const allPageSelected = selectablePageIds.length > 0 && selectablePageIds.slice(0, 25).every((id) => selectedIds.includes(id));
  const selectedRows = rows.filter((row) => { const id = candidateByInvoice.get(row.invoiceGuid)?.id; return Boolean(id && selectedIds.includes(id)); });
  const selectedTotal = selectedRows.reduce((total, row) => total + Number(row.creditAmount || 0), 0);
  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 25 ? [...current, id] : current);
  const toCreate = rows.filter((row) => {
    if (!["full_payment", "discounted_payment", "over_ninety_percent"].includes(row.category) || row.gstDeadlinePassed) return false;
    const note = data?.creditNotes[row.invoiceGuid];
    const candidate = candidateByInvoice.get(row.invoiceGuid);
    return Boolean(candidate && ["action_required", "review_required"].includes(candidate.status) && (!note || ["failed", "cancelled"].includes(note.status)));
  });
  const toCreateAmount = toCreate.reduce((total, row) => total + Number(row.creditAmount || 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const daysUntil = (date: string) => Math.round((new Date(`${date.slice(0, 10)}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000);
  const percentPaid = (row: CdSettlementRow) => Number(row.invoiceAmount) > 0 ? (Number(row.paidByDeadline) / Number(row.invoiceAmount)) * 100 : 0;

  if (loading) return <><WorkspacePageHeader title="Cash Discount" /><section className="cd-check-summary cd-check-summary-loading" aria-label="Loading Cash Discount"><Skeleton lines={3} /></section></>;

  return <>
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    <WorkspacePageHeader title="Cash Discount" />
    <section className="tod-overview cd-overview" aria-label="Latest Cash Discount check">
      <div className="tod-overview-meta">
        <div className="tod-period-context">{phase ? <StatusBadge status={phase === "saving" ? "posting" : "evaluating"}>{phase === "saving" ? "Saving" : "Checking"}</StatusBadge> : data?.run ? <StatusBadge status="ready" /> : <StatusBadge status="not_started">Not checked</StatusBadge>}{data?.run && !phase && data.totals?.invoicePeriod && <span className="cd-head-facts"><strong>{shortDate(data.totals.invoicePeriod.from)} – {shortDate(data.totals.invoicePeriod.to)}</strong>{typeof data.totals.invoicesChecked === "number" && ` · ${data.totals.invoicesChecked.toLocaleString("en-IN")} checked`}{(data.totals.notEligibleCount ?? 0) > 0 && data.totals.invoicesChecked ? <span title="Paid late, or short of the bill by more than ₹10,000"> · {Math.round((data.totals.notEligibleCount! / data.totals.invoicesChecked) * 100)}% not eligible</span> : null}</span>}</div>
        <div className="tod-overview-actions"><span>{phase ? "Checking Tally…" : data?.run?.completedAt ? `Calculated ${formatDate(data.run.completedAt)}` : "Not calculated yet"}</span>
          <Button className="button-secondary" disabled={Boolean(phase)} onClick={() => void calculate()}><RefreshCw className={phase ? "spin" : undefined} size={15} />{phase ? "Checking Tally…" : "Calculate"}</Button>
          <Link className="button button-quiet" href="/rulebook">Active rule</Link></div>
      </div>
      {phase && <div className="cd-check-progress" role="status" aria-live="polite">
        <div className="cd-check-progress-copy">
          <strong>{phase === "saving" ? "Saving the result…" : progress?.stage === "calculating" ? "Calculating discounts…" : progress?.total ? `Reading Tally · batch ${progress.done} of ${progress.total}` : "Connecting to Tally…"}</strong>
          <span>{phase === "saving" ? "Almost done." : progress?.total && progress.stage !== "calculating" ? `${shortDay(progress.from)} – ${shortDay(progress.to)} in 10-day batches${progress.nextDate ? ` · next from ${shortDay(progress.nextDate)}` : ""}${progress.vouchersScanned ? ` · ${progress.vouchersScanned.toLocaleString("en-IN")} vouchers read` : ""}` : "Keep Tally open. You can keep working in Tally meanwhile."}</span>
        </div>
        <div className="cd-check-progress-track" aria-hidden="true"><span style={{ width: `${phase === "saving" || progress?.stage === "calculating" ? 100 : Math.max(4, progressPercent)}%` }} /></div>
      </div>}
      {!data?.run && !phase && <div className="cd-overview-body"><h2>Run a Tally check</h2><p>Press Calculate to sort invoices into Full payment, Short up to ₹10,000 and Discounted payment.</p></div>}
    </section>
    {!postingEnabled && <InlineMessage tone="info">Credit Note creation is off. Turn it on from Credit Notes to create Credit Notes in Tally.</InlineMessage>}
    {rows.length > 0 && <div className="cd-action-cards cd-category-cards" role="tablist" aria-label="Cash Discount categories">
      {TABS.filter((item) => item.key !== "other" || counts.other > 0 || tab === "other").map((item) => <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={`cd-action-card${tab === item.key ? " selected" : ""}${item.key === "over_ninety_percent" && counts[item.key] ? " has-attention" : ""}`} onClick={() => setTab(item.key)}>
        <span>{item.label}{groupFilter !== "all" && <em className="cd-card-scope">{groupFilter === NO_GROUP ? "No group" : groupFilter}</em>}</span>
        <strong>{item.key !== "other" ? formatMoney(pendingAmount(item.key)) : counts[item.key]}</strong>
        <small>{item.key !== "other" ? `to create · ${counts[item.key]} invoice${counts[item.key] === 1 ? "" : "s"}${pendingAmount(item.key) !== tabAmount(item.key) ? ` · ${formatMoney(tabAmount(item.key))} total` : ""}` : "no discount yet"}</small>
      </button>)}
    </div>}
    {rows.length > 0 && <section className="surface-card cd-settlement-card">
      <div className="tod-results-bar"><div className="tod-table-title">
          {groupFilter !== "all" && <button type="button" className="tod-group-back" onClick={() => setGroupFilter("all")} aria-label="Back to customer groups"><ChevronLeft size={16} />Groups</button>}
          <h2>{groupFilter !== "all" ? `${groupFilter === NO_GROUP ? "No group" : groupFilter} · ${activeTab.label}` : showCards ? <>Customer groups <span>{groupSummaries.length}</span></> : activeTab.label}</h2>
          {!showCards && <p className="tod-table-summary"><span>{activeTab.hint}</span></p>}</div>
        <div className="cd-results-filters">
          {segments.length > 1 && <label><span className="sr-only">Segment</span><select value={segmentFilter} onChange={(event) => setSegmentFilter(event.target.value)}><option value="all">All segments</option>{segments.map((segment) => <option key={segment} value={segment}>{segment}</option>)}</select></label>}
          <label className="tod-results-search"><span className="sr-only">Find customer or invoice</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer or invoice" /></label>
        </div></div>
      {showCards && <div className="tod-group-strip cd-group-strip" role="list" aria-label="Customer groups">
        {groupSummaries.map((group) => {
          const share = group.invoices ? Math.round((group.created / group.invoices) * 100) : 0;
          const hasCredit = tab !== "other";
          return <button type="button" role="listitem" className="tod-group-card" key={group.key} onClick={() => setGroupFilter(group.key)} aria-label={`Open ${group.name}: ${group.invoices} invoices`}>
            <span className="tod-group-card-head">
              <span className="tod-group-title"><strong title={group.name}>{group.name}</strong>{group.segments.length > 0 && <small>{group.segments.join(", ")}</small>}</span>
              <ChevronRight className="tod-group-chevron" size={18} aria-hidden="true" />
            </span>
            <span className="tod-group-amount"><strong>{formatMoney(hasCredit ? group.toCreateAmount : group.billed)}</strong><small>{hasCredit ? `to create${Math.abs(group.credit - group.toCreateAmount) > 1 ? ` · ${formatMoney(group.credit)} total` : ""}` : `invoice value · ${group.customers} customers`}</small></span>
            {hasCredit && <span className="cd-group-progress"><span className="tod-group-meter" role="presentation"><span style={{ width: `${share}%` }} /></span><small>{group.created} of {group.invoices} created</small></span>}
          </button>;
        })}
      </div>}
      {showCards ? null : visible.length ? <div className="data-table cd-settlement-table"><div className="table-head"><span className="cd-head-customer">{selectablePageIds.length > 0 && <input type="checkbox" aria-label="Select invoices on this page (up to 25)" title="Select up to 25 on this page" disabled={bulkCreating} checked={allPageSelected} onChange={(event) => setSelectedIds(event.target.checked ? selectablePageIds.slice(0, 25) : [])} />}Customer and invoice</span><span>Window</span><span>Paid by deadline</span><span>Discount</span><span>Credit Note</span></div>
        {pageRows.map((row) => {
          const note = data?.creditNotes[row.invoiceGuid];
          const candidate = candidateByInvoice.get(row.invoiceGuid);
          const canCreate = isAdministrator && postingEnabled && candidate && ["action_required", "review_required"].includes(candidate.status) && (!note || ["failed", "cancelled"].includes(note.status));
          return <article key={row.invoiceGuid} className="cd-row-clickable" onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input")) setOpenGuid(row.invoiceGuid); }}>
            <div className={selectablePageIds.length ? "cd-select-cell" : undefined}>{selectablePageIds.length > 0 && <span className="cd-row-check">{canCreate && <input type="checkbox" aria-label={`Select ${row.customerName} invoice ${row.invoiceNumber ?? ""}`} disabled={bulkCreating || (!selectedIds.includes(candidate!.id) && selectedIds.length >= 25)} checked={selectedIds.includes(candidate!.id)} onChange={() => toggleSelected(candidate!.id)} />}</span>}<strong>{row.customerName}</strong><small>Inv {row.invoiceNumber ?? "—"} · {shortDate(row.invoiceDate)} · {formatMoney(row.invoiceAmount)}</small>{((row.customerGroup && groupFilter === "all") || tab === "other" || tab === "all") && <span className="cd-row-tags">{row.customerGroup && groupFilter === "all" && <span className="cd-tag">{row.customerGroup}</span>}{(tab === "other" || tab === "all") && <span className={`cd-tag is-${row.category}`}>{CATEGORY_TAG[row.category] ?? row.category.replaceAll("_", " ")}</span>}</span>}</div>
            <div><strong>{row.windowWorkingDays} days</strong><small>due {shortDate(row.windowDeadline)}{row.windowOpen ? " · still open" : ""}</small></div>
            <div><strong>{formatMoney(row.paidByDeadline)} <span className="cd-percent">{percentPaid(row).toFixed(1)}%</span></strong>
              <small>{row.category === "full_payment" ? "full bill, on time" : row.category === "discounted_payment" ? `target ${formatMoney(row.discountedTarget)}` : row.category === "over_ninety_percent" ? `short ${formatMoney(Number(row.invoiceAmount) - Number(row.paidByDeadline))}` : row.category === "awaiting_payment" ? `pay ${formatMoney(Math.max(0, Number(row.discountedTarget) - Number(row.paidByDeadline)))} by ${shortDate(row.windowDeadline)} for the discount` : row.paymentCount ? `${row.paymentCount} payment${row.paymentCount === 1 ? "" : "s"}` : "no payment"}{row.latestPaymentDate ? ` · last ${shortDate(row.latestPaymentDate)}` : ""}</small></div>
            <div><strong>{formatMoney(row.discountAmount)}</strong><small>{formatTonnes(row.eligibleTonnes)} MT × ₹{Number(row.amountPerTonne).toLocaleString("en-IN")}/MT</small></div>
            <div className="cd-settlement-note">
              {note?.status === "created_verified" ? <StatusBadge status="created_verified">CN {note.verified_voucher_number ?? "created"}</StatusBadge>
                : note && ["queued", "sending"].includes(note.status) ? <StatusBadge status="posting">Creating in Tally…</StatusBadge>
                : row.status === "credited" ? <StatusBadge status="created_verified">Already credited</StatusBadge>
                : canCreate ? <Button className="button-secondary" disabled={busyId === candidate!.id} onClick={() => void createCreditNote(row, candidate!.id)}>{busyId === candidate!.id ? "Queuing…" : `Create ₹${Number(row.creditAmount).toLocaleString("en-IN")}`}</Button>
                : <small>{row.category === "full_payment" && !Number(row.creditAmount) ? "Run the check again" : ["full_payment", "discounted_payment", "over_ninety_percent"].includes(row.category) ? row.gstDeadlinePassed ? "GST deadline passed" : postingEnabled ? "Save the check first" : "Creation is off" : row.category === "awaiting_payment" ? "Window open" : row.category === "needs_review" ? row.reviewMessage ?? "Needs review" : "No discount"}</small>}
              {["full_payment", "discounted_payment", "over_ninety_percent"].includes(row.category) && note?.status !== "created_verified" && row.gstLastDate && (row.gstDeadlinePassed || daysUntil(row.gstLastDate) <= 30) && <small className="cd-gst-warning">{row.gstDeadlinePassed ? `GST deadline passed (${shortDate(row.gstLastDate)})` : `Create by ${shortDate(row.gstLastDate)} for GST`}</small>}
              {note?.status === "failed" && <small className="field-error">{/active Tally company does not match/i.test(note.failure_reason ?? "") ? `Tally had another company open. Open ${company.tally_company_name} in Tally, then create again.` : note.failure_reason ?? "Tally rejected it. Create again."}</small>}
            </div>
          </article>;
        })}</div>
        : <EmptyState title="No invoices here" detail={q ? "No customer or invoice matches the search." : groupFilter !== "all" ? `${groupFilter === NO_GROUP ? "Customers without a group have" : `${groupFilter} has`} no ${activeTab.label} invoices in the latest check.` : "Nothing in this category from the latest check."} action={groupFilter !== "all" && !q ? <Button className="button-secondary" onClick={() => setGroupFilter("all")}>All groups</Button> : undefined} />}
      {!showCards && selectedRows.length > 0 && <div className="tod-bulk-bar" role="region" aria-label="Selected invoices">
        <span><strong>{selectedRows.length} selected</strong> · {formatMoney(selectedTotal)}</span>
        <div><button type="button" className="tod-selection-clear" disabled={bulkCreating} onClick={() => setSelectedIds([])}>Clear</button><Button disabled={bulkCreating || !postingEnabled} onClick={() => setBulkConfirmOpen(true)}>{bulkCreating ? "Queuing…" : `Create ${selectedRows.length} Credit Note${selectedRows.length === 1 ? "" : "s"}`}</Button></div>
      </div>}
      {!showCards && visible.length > PAGE_SIZE && (() => {
        const pages = Math.ceil(visible.length / PAGE_SIZE);
        const current = Math.min(page, pages);
        return <nav className="table-pagination" aria-label="Invoice pages">
          <span>{((current - 1) * PAGE_SIZE + 1).toLocaleString("en-IN")}–{Math.min(current * PAGE_SIZE, visible.length).toLocaleString("en-IN")} of {visible.length.toLocaleString("en-IN")} invoices</span>
          <div>
            <Button className="button-secondary" disabled={current === 1} onClick={() => setPage(current - 1)}>Previous</Button>
            <span>Page {current} of {pages}</span>
            <Button className="button-secondary" disabled={current === pages} onClick={() => setPage(current + 1)}>Next</Button>
          </div>
        </nav>;
      })()}
    </section>}
    {(() => {
      const openRow = openGuid ? rows.find((row) => row.invoiceGuid === openGuid) ?? null : null;
      const openNote = openRow ? data?.creditNotes[openRow.invoiceGuid] : undefined;
      const openCandidate = openRow ? candidateByInvoice.get(openRow.invoiceGuid) : undefined;
      const openCanCreate = Boolean(isAdministrator && postingEnabled && openCandidate && ["action_required", "review_required"].includes(openCandidate.status) && (!openNote || ["failed", "cancelled"].includes(openNote.status)));
      return <CdInvoicePanel row={openRow} note={openNote} calendar={calendar} canCreate={openCanCreate} busy={Boolean(openCandidate && busyId === openCandidate.id)} companyName={company.tally_company_name} onCreate={() => { if (openRow && openCandidate) void createCreditNote(openRow, openCandidate.id); }} onClose={() => setOpenGuid(null)} />;
    })()}
    <Dialog open={bulkConfirmOpen} onClose={() => setBulkConfirmOpen(false)} title={`Create ${selectedRows.length} Credit Note${selectedRows.length === 1 ? "" : "s"}?`} description="Review the selected invoices before anything is queued for Tally.">
      <div className="cd-bulk-confirm">
        <div className="cd-bulk-confirm-summary"><strong>{formatMoney(selectedTotal)}</strong><span>{selectedRows.length} invoice{selectedRows.length === 1 ? "" : "s"}</span></div>
        <div className="cd-bulk-confirm-list">{selectedRows.map((row) => <div key={row.invoiceGuid}><span>{row.customerName} · Inv {row.invoiceNumber ?? "—"}</span><strong>{formatMoney(row.creditAmount)}</strong></div>)}</div>
        <p>Each Credit Note is created in Tally by the connector, one after another. Keep Tally open with {company.tally_company_name}. No WhatsApp is sent; send it from Credit Notes when you are ready.</p>
        <div className="dialog-actions"><Button className="button-secondary" onClick={() => setBulkConfirmOpen(false)}>Back</Button><Button disabled={bulkCreating || !selectedRows.length} onClick={() => { setBulkConfirmOpen(false); void createSelectedCreditNotes(selectedRows.map((row) => candidateByInvoice.get(row.invoiceGuid)!.id)); }}>Confirm and create</Button></div>
      </div>
    </Dialog>
    {!rows.length && data?.run && !phase && <EmptyState title="No invoices were checked" detail="No Sales invoice with eligible products was found for customers in the rule's segments." action={<Link className="button button-secondary" href="/rulebook">Review active rule</Link>} />}
  </>;
}
