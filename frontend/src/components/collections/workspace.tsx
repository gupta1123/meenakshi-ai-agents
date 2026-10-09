"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowRight, BellRing, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, CircleAlert, ClipboardCheck, Eye, FileCheck2, List, RefreshCw, Search, Send, Square, Users } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { staffStatusLabel } from "@/lib/staff-status";
import { userFacingDetail, userFacingError, userLabel } from "@/lib/user-copy";
import { supabase } from "@/lib/supabase";
import { runLocalCashDiscount, runLocalTurnoverDiscount, type LocalCdBootstrap, type LocalCdInvoiceCheck, type LocalCdRow, type LocalTodBootstrap, type LocalTodRow } from "@/lib/local-tally";

import { AppShell, WorkspacePageHeader } from "./app-shell";
import { useCompany } from "./company-context";
import { RulebookWorkspace } from "./rulebook-workspace";
import { TallyReadiness, syncIsCurrent, workspaceCanCalculateLive } from "./tally-readiness";
import { useWorkspaceSession, type WorkspaceData } from "./workspace-session";
import { MessagesWorkspace } from "./messages-workspace";
import { GuidedEvaluationQueue } from "./guided-evaluation-queue";
import { GuidedEvaluationDrawer } from "./guided-evaluation-drawer";
import { VerifiedCreditNoteDocument } from "./verified-credit-note-document";
import { CreditNotesLoadingContent, MessagesLoadingContent, TodPageSkeleton } from "./workspace-loading-shell";
import { CashDiscountSettlementsPage } from "./cash-discount-settlements";
import { CreditNotePanel, type CreditNotePanelNote } from "./credit-note-panel";
import { FinanceDashboard } from "./finance-dashboard";
import { PeriodFilter, defaultPeriod, inPeriod, periodLabel, type Period } from "./period-filter";
import { WhatsAppSendDrawer, type WhatsAppTarget } from "./whatsapp-send-drawer";
import type { CashDiscountDebitNoteHistory, CashDiscountInvoiceCheck, CashDiscountLiveResult, CashDiscountRecovery, CollectionsPage, Contact, CreditNotePosting, EvaluationRun, LaunchControl, MessageTemplate, NotificationHealth, NotificationMessage, OperationsHealth, Proposal, ProposalDetail, ReferenceData, TallyHealth, Voucher } from "./types";
import { Button, Card, Dialog, Drawer, EmptyState, IconButton, InlineMessage, MetricCard, SectionHeading, Skeleton, StatusBadge, formatDate, formatMoney, formatTonnes, labelFor, safePhone } from "./ui";

const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-${Date.now()}`;
const formatBusinessDate = (value: string | null | undefined, fallback = "Not set") => {
  if (!value) return fallback;
  const dateOnly = value.slice(0, 10);
  const date = new Date(`${dateOnly}T00:00:00`);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};
const formatPercentage = (value: string | number | null | undefined) => Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const recoveryCaseLabel = (row: CashDiscountRecovery) => row.recovery_case ?? (row.status === "review_required" ? "review" : Number(row.amount_paid ?? 0) <= 0 ? "not_paid" : Number(row.amount_paid ?? 0) < Number(row.net_invoice_amount ?? 0) ? "partially_paid" : "paid_late");
const RESULT_PAGE_SIZE = 20;

function ResultPagination({ page, totalItems, onPageChange, pageSize = RESULT_PAGE_SIZE }: { page: number; totalItems: number; onPageChange: (page: number) => void; pageSize?: number }) {
  const totalPages = Math.ceil(totalItems / pageSize);
  if (totalPages <= 1) return null;
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1).filter((candidate) => candidate === 1 || candidate === totalPages || Math.abs(candidate - page) <= 1);
  const items: Array<number | "ellipsis"> = [];
  pages.forEach((candidate, index) => {
    if (index > 0 && candidate - pages[index - 1] > 1) items.push("ellipsis");
    items.push(candidate);
  });
  const firstItem = (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, totalItems);
  return <nav className="result-pagination" aria-label="Results pages">
    <span className="result-pagination-summary">{firstItem}–{lastItem} of {totalItems}</span>
    <div className="result-pagination-pages">
      <button type="button" className="result-pagination-nav" disabled={page === 1} aria-label="Previous page" onClick={() => onPageChange(page - 1)}><ChevronLeft size={14} /> Previous</button>
      {items.map((item, index) => item === "ellipsis"
        ? <span key={`ellipsis-${index}`} className="result-pagination-ellipsis" aria-hidden="true">…</span>
        : <button type="button" key={item} className={item === page ? "selected" : ""} aria-label={`Page ${item}`} aria-current={item === page ? "page" : undefined} onClick={() => onPageChange(item)}>{item}</button>)}
      <button type="button" className="result-pagination-nav" disabled={page === totalPages} aria-label="Next page" onClick={() => onPageChange(page + 1)}>Next <ChevronRight size={14} /></button>
    </div>
  </nav>;
}

function CashDiscountRecoverySkeleton() {
  return <div className="cd-recovery-skeleton" aria-label="Loading recovery results">{Array.from({ length: 6 }, (_, index) => <div className="cd-recovery-skeleton-row" key={index}><Skeleton lines={1} style={{ width: 16, height: 16 }} /><div><Skeleton lines={1} style={{ width: `${58 + (index % 3) * 8}%`, height: 13 }} /><Skeleton lines={1} style={{ width: "72%", height: 9 }} /><Skeleton lines={1} style={{ width: "54%", height: 9 }} /></div><div><Skeleton lines={1} style={{ width: "72%", height: 12 }} /><Skeleton lines={1} style={{ width: "52%", height: 9 }} /></div><Skeleton lines={1} style={{ width: 78, height: 13 }} /><Skeleton lines={1} style={{ width: 70, height: 32 }} /></div>)}</div>;
}

export async function accessToken() {
  const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

export function WorkspaceEntry({ page, email, signOut }: { page: CollectionsPage; email: string; signOut: () => Promise<void> }) {
  const { health, tallyStatus, tallyError, reloadTally } = useWorkspaceSession();
  if (page === "tally") {
    return <AppShell email={email} onSignOut={signOut} tallyStatus={tallyStatus}><TallyReadiness health={health} healthError={tallyError} onRefresh={reloadTally} /></AppShell>;
  }
  // Every page stays usable without Tally: saved results and history remain
  // visible, and WorkspaceAvailabilityNotice explains what needs Tally.
  return <Workspace page={page} email={email} signOut={signOut} tallyHealth={health} />;
}

function Workspace({ page, email, signOut, tallyHealth }: { page: CollectionsPage; email: string; signOut: () => Promise<void>; tallyHealth: TallyHealth | null }) {
  const { company, companyKey, isAdministrator } = useCompany();
  const { data, loading, error, refresh, setError, tallyStatus } = useWorkspaceSession();
  const [notice, setNotice] = useState<string | null>(null);
  const customerNames = useMemo(() => new Map(data.reference?.masters.customers.map((customer) => [customer.id, labelFor(customer)]) ?? []), [data.reference]);
  const pageProps = { data, refresh, setNotice, setError, customerNames, isAdministrator };
  const hasLoadedWorkspace = Boolean(data.overview || data.operations || data.launchControl || data.reference || data.proposals.length || data.creditNotes.length || data.debitNotes.length || data.messages.length);
  const tallyEvidenceCurrent = page === "rulebook"
    ? Boolean(tallyHealth?.ready && syncIsCurrent(tallyHealth.sync?.masters))
    : workspaceCanCalculateLive(tallyHealth);
  const companyMismatch = tallyHealth?.status === "company_mismatch";

  return <AppShell email={email} onSignOut={signOut} tallyStatus={tallyStatus}>
    <div className="workspace-content" key={companyKey}>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : notice ? <InlineMessage tone="success">{notice}</InlineMessage> : null}
      {error && !loading && !hasLoadedWorkspace ? <EmptyState title="Workspace unavailable" detail="The latest data could not be loaded. This is not an empty result." action={<Button onClick={() => void refresh()}>Try again</Button>} /> : loading && !hasLoadedWorkspace ? page === "credit-notes" ? <><WorkspacePageHeader eyebrow="" title="Credit Notes" detail="Create and track Credit Notes." /><CreditNotesLoadingContent /></> : page === "messages" ? <><WorkspacePageHeader eyebrow="" title="Messages" detail="WhatsApp delivery status and audit history." /><MessagesLoadingContent /></> : page === "turnover-discount" ? <><WorkspacePageHeader title="Turnover Discount" /><TodPageSkeleton /></> : <Skeleton lines={7} /> : companyMismatch ? <TallyCompanyMismatchNotice health={tallyHealth} expectedCompanyName={company.tally_company_name} /> : <>{!tallyEvidenceCurrent && <WorkspaceAvailabilityNotice page={page} connected={Boolean(tallyHealth?.ready)} tallyStatus={tallyStatus} />}{page === "control-centre" ? <OverviewPage {...pageProps} /> : page === "cash-discount" || page === "turnover-discount" ? <DiscountPage scheme={page === "cash-discount" ? "cd" : "tod"} {...pageProps} /> : page === "credit-notes" ? <CreditNotesPage {...pageProps} /> : page === "debit-notes" ? <DebitNotesPage {...pageProps} /> : page === "messages" ? <MessagesWorkspace {...pageProps} /> : <RulebookWorkspace {...pageProps} />}</>}
    </div>
  </AppShell>;
}

function TallyCompanyMismatchNotice({ health, expectedCompanyName }: { health: TallyHealth | null; expectedCompanyName: string }) {
  const activeCompanyName = health?.binding?.observedCompanyName || "another company";
  return <InlineMessage tone="warning"><strong>Company context locked.</strong> Tally Prime is open to <strong>{activeCompanyName}</strong>. Switch it to <strong>{expectedCompanyName}</strong>; Meenakshi will update automatically and no data or actions are shown until the companies match.</InlineMessage>;
}

function WorkspaceAvailabilityNotice({ page, connected, tallyStatus }: { page: CollectionsPage; connected: boolean; tallyStatus: string }) {
  if (tallyStatus === "checking") return <InlineMessage tone="info"><strong>Checking Tally connection…</strong> Saved information remains available.</InlineMessage>;
  if (tallyStatus === "connection_check_failed") return <InlineMessage tone="warning"><strong>Could not check the Tally connection.</strong> Showing saved information; connection status is unknown. <Link href="/tally">Check connection</Link></InlineMessage>;
  // Connected, but the Rulebook also needs freshly synced customers, groups and ledgers.
  if (connected && page === "rulebook") {
    return <InlineMessage tone="info"><strong>Tally data needs a refresh.</strong> Rules can be viewed; refresh customers and ledgers from Tally before changing them. <Link href="/tally">Refresh</Link></InlineMessage>;
  }
  const copy = page === "rulebook"
    ? "Rules can be viewed; connect Tally before changing them."
    : page === "messages"
      ? "WhatsApp messages can still be sent and tracked."
    : page === "debit-notes" || page === "credit-notes"
      ? "History and WhatsApp sending still work. Creating new notes needs Tally."
      : "Showing saved results.";
  return <InlineMessage tone="info"><strong>Tally not connected.</strong> {copy} <Link href="/tally">Connect</Link></InlineMessage>;
}

type CashDiscountAction = "credit_note" | "debit_note" | "collect_balance" | "send_shortfall_reminder" | "keep_tracking" | "finance_review" | "none";

function cashDiscountActionFrom(record: Proposal, formula?: Record<string, unknown> | null): CashDiscountAction {
  const allowed: CashDiscountAction[] = ["credit_note", "debit_note", "collect_balance", "send_shortfall_reminder", "keep_tracking", "finance_review", "none"];
  const formulaAction = formula?.recommendedAction;
  if (typeof formulaAction === "string" && allowed.includes(formulaAction as CashDiscountAction)) return formulaAction as CashDiscountAction;
  const reason = record.reason_codes.find((code) => code.startsWith("recommended_action_"));
  const action = reason?.slice("recommended_action_".length) as CashDiscountAction | undefined;
  return action && allowed.includes(action) ? action : "finance_review";
}

function cashDiscountActionCopy(action: CashDiscountAction) {
  switch (action) {
    case "credit_note": return { title: "Create a Credit Note", detail: "The customer qualified under the active rule. Check the latest Tally information, then create the Credit Note as Administrator.", tone: "success" as const };
    case "debit_note": return { title: "Recover the upfront discount", detail: "The invoice already included the discount, but the payment deadline was missed. The Administrator should review a Debit Note recovery.", tone: "warning" as const };
    case "collect_balance": return { title: "Collect the remaining invoice balance", detail: "The invoice did not include an upfront discount. Collect the existing balance; do not create a Debit Note.", tone: "warning" as const };
    case "send_shortfall_reminder": return { title: "Remind the customer", detail: "The customer is close to qualifying and can still pay the shortfall before the working-day deadline.", tone: "info" as const };
    case "keep_tracking": return { title: "Keep tracking payment", detail: "No accounting voucher is needed yet. Check again when new payment information is available in Tally.", tone: "info" as const };
    case "none": return { title: "No accounting voucher required", detail: "The Cash Discount outcome is already reflected in the invoice or no further action is needed.", tone: "success" as const };
    default: return { title: "Administrator review required", detail: "Resolve the listed difference before creating any customer communication or Tally voucher.", tone: "warning" as const };
  }
}

function openIssueCopy(issue: ProposalDetail["openIssues"][number]) {
  if (issue.issue_type === "tod_tier_reduced_after_notification") {
    const oldPercentage = issue.details.oldTierPercentage;
    const newPercentage = issue.details.newTierPercentage;
    const previousTier = typeof oldPercentage === "number" || typeof oldPercentage === "string" ? `${oldPercentage}%` : "the previously messaged tier";
    const currentTier = newPercentage === null || newPercentage === undefined ? "no qualifying tier" : `${newPercentage}%`;
    return {
      title: "TOD tier reduced after WhatsApp",
      detail: `The latest Tally calculation changed this customer from ${previousTier} to ${currentTier}. No correction or duplicate WhatsApp was sent automatically. Finance must review the customer communication before any further message.`,
    };
  }
  const recordedMessage = issue.details?.message;
  return {
    title: userLabel(issue.issue_type),
    detail: typeof recordedMessage === "string" && recordedMessage.trim() ? recordedMessage : "Review this item before creating another Tally voucher or customer message.",
  };
}

function OpenIssueSummary({ issue }: { issue: ProposalDetail["openIssues"][number] }) {
  const copy = openIssueCopy(issue);
  return <div className="safe-issue"><StatusBadge status={issue.status} /><div><strong>{copy.title}</strong><small>{copy.detail}</small></div></div>;
}

export type PageProps = { data: WorkspaceData; refresh: () => Promise<void>; setNotice: (value: string | null) => void; setError: (value: string |null) => void; customerNames: Map<string, string>; isAdministrator: boolean };

function OverviewPage({ data, isAdministrator, refresh }: PageProps) {
  const overview = data.overview;
  // The dashboard itself (financial year, quarters, groups) loads its own data.
  return <>
    <WorkspacePageHeader eyebrow="" title="Overview" action={<IconButton label="Refresh workspace" onClick={() => void refresh()}><RefreshCw size={16} /></IconButton>} />
    {!isAdministrator && <InlineMessage tone="info"><strong>Finance workspace:</strong> Manage discounts, approvals, and WhatsApp notifications. Rules and system configurations are Administrator-controlled.</InlineMessage>}
    {overview && !overview.tally.ready && <InlineMessage tone="warning"><strong>Tally needs attention.</strong> Meenakshi cannot reach Tally Prime right now. <Link href="/tally">Open Tally connection</Link></InlineMessage>}
    <FinanceDashboard />
  </>;
}

function DiscountPage(props: PageProps & { scheme: "cd" | "tod" }) {
  return props.scheme === "cd" ? <CashDiscountRecoveryPage {...props} /> : <DiscountPageBody {...props} />;
}

function CashDiscountRecoveryPage({ data, setNotice, setError, isAdministrator }: PageProps & { scheme: "cd" | "tod" }) {
  const { company, companyKey } = useCompany();
  const searchParams = useSearchParams();
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(true);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [recoveries, setRecoveries] = useState<CashDiscountRecovery[]>([]);
  // Unfiltered copy for the action cards, so search and case filters do not change their totals.
  const [recoverySummary, setRecoverySummary] = useState<CashDiscountRecovery[]>([]);
  const [previousRuleRecoveries, setPreviousRuleRecoveries] = useState<CashDiscountRecovery[]>([]);
  // Loaded with the recoveries; issued Debit Notes are shown on the Debit Notes page.
  const [, setDebitNoteHistory] = useState<CashDiscountDebitNoteHistory[]>([]);
  const [localInvoiceChecks, setLocalInvoiceChecks] = useState<LocalCdInvoiceCheck[] | null>(null);
  const [resultTab, setResultTab] = useState<"recover" | "review" | "all">("recover");
  // Inside the read-only view: retained invoices or results from an earlier rule.
  const [allView, setAllView] = useState<"retained" | "previous">("retained");
  const [filter, setFilter] = useState<"all" | "not_paid" | "partially_paid" | "paid_late" | "review">("all");
  const [query, setQuery] = useState("");
  const [resultPage, setResultPage] = useState(1);
  const [selectedRecovery, setSelectedRecovery] = useState<CashDiscountRecovery | null>(null);
  const [stopping, setStopping] = useState(false);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [bulkPosting, setBulkPosting] = useState(false);
  const [selectedRecoveryIds, setSelectedRecoveryIds] = useState<Set<string>>(() => new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [localBootstrap, setLocalBootstrap] = useState<LocalCdBootstrap | null>(null);
  const [localChecking, setLocalChecking] = useState(false);
  const [recoveriesLoading, setRecoveriesLoading] = useState(false);
  const [recoveriesError, setRecoveriesError] = useState<string | null>(null);
  const recoveryRequest = useRef(0);
  const [localPhase, setLocalPhase] = useState<"reading" | "saving" | null>(null);
  const postingKeys = useRef(new Map<string, string>());
  const recoveryFilterInitialized = useRef(false);
  // Several Cash Discount rules can be active; each keeps its own results.
  type CdRuleOption = { id: string; name: string; versionNumber: number; discountPercentage: string; allowedWorkingDays: number | null; cdDiscountBasis?: "percentage_of_bill" | "amount_per_tonne" };
  const [cdRules, setCdRules] = useState<CdRuleOption[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const token = await accessToken(); if (!token) return;
      try {
        const response = await apiRequest<{ rules: CdRuleOption[] }>(token, `/api/companies/${company.id}/evaluations/cd/rules`, { cache: "no-store" });
        setCdRules(response.rules);
        setSelectedRuleId((current) => current && response.rules.some((rule) => rule.id === current) ? current : response.rules[0]?.id ?? null);
      } catch { setCdRules([]); }
    })();
  }, [company.id]);

  const loadRecoveries = useCallback(async (caseFilter: "all" | "not_paid" | "partially_paid" | "paid_late" | "review" = "all", search = "") => {
    const requestId = ++recoveryRequest.current;
    const token = await accessToken();
    if (!token) return [];
    setRecoveriesLoading(true);
    setRecoveriesError(null);
    // These actions can be replaced by the just-finished local Tally check.
    // Never allow an HTTP cache to put an earlier snapshot back on screen
    // after the user refreshes the page.
    // Load every current recovery: the "To recover" total and counts are summed
    // from this list, so a partial page under-reports the amount.
    const params = new URLSearchParams({ case: caseFilter, limit: "5000" });
    if (search.trim()) params.set("q", search.trim());
    if (selectedRuleId) params.set("ruleVersionId", selectedRuleId);
    try {
      const response = await apiRequest<{ recoveries: CashDiscountRecovery[]; previousRuleRecoveries?: CashDiscountRecovery[]; history: CashDiscountDebitNoteHistory[] }>(token, `/api/companies/${company.id}/cash-discount/recoveries?${params.toString()}`, { cache: "no-store" });
      if (requestId !== recoveryRequest.current) return response.recoveries;
      setRecoveries(response.recoveries);
      if (caseFilter === "all" && !search.trim()) setRecoverySummary(response.recoveries);
      setPreviousRuleRecoveries(response.previousRuleRecoveries ?? []);
      setDebitNoteHistory(response.history ?? []);
      return response.recoveries;
    } catch (cause) {
      if (requestId === recoveryRequest.current) {
        setRecoveries([]);
        setRecoveriesError(userFacingError(cause, "Could not load recovery results. Try again."));
      }
      throw cause;
    } finally {
      if (requestId === recoveryRequest.current) setRecoveriesLoading(false);
    }
  }, [company.id, selectedRuleId]);
  const loadLatest = useCallback(async () => {
    const token = await accessToken();
    if (!token) return;
    try {
      const [response] = await Promise.all([
        apiRequest<{ evaluationRuns: EvaluationRun[] }>(token, `/api/companies/${company.id}/evaluations/runs?schemeType=cd&limit=30&detail=compact&fresh=1`, { cache: "no-store" }),
        loadRecoveries("all", ""),
      ]);
      // The latest run of the selected rule (older runs carry no rule in their context).
      const ruleOf = (item: EvaluationRun) => item.scheme_version_id ?? ((item as EvaluationRun & { request_context?: { ruleVersionId?: string } }).request_context?.ruleVersionId ?? null);
      const latest = selectedRuleId && cdRules.length > 1
        ? response.evaluationRuns.find((item) => ruleOf(item) === selectedRuleId) ?? null
        : response.evaluationRuns[0] ?? null;
      // Load invoice details for one selected run, rather than all 30 history entries.
      const detail = latest ? await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/runs/${latest.id}`, { cache: "no-store" }) : null;
      setRun(detail?.evaluationRun ?? null);
    } catch (cause) { setError(userFacingError(cause, "Could not load the latest Cash Discount recovery check.")); }
    finally { setLoadingLatest(false); }
  }, [cdRules.length, company.id, loadRecoveries, selectedRuleId, setError]);
  useEffect(() => { recoveryFilterInitialized.current = false; setLoadingLatest(true); setRun(null); setRecoveries([]); setRecoverySummary([]); setPreviousRuleRecoveries([]); setDebitNoteHistory([]); setLocalInvoiceChecks(null); void loadLatest(); }, [companyKey, loadLatest]);
  const preloadLocalBootstrap = useCallback(async (evaluatedOn?: string) => {
    const token = await accessToken();
    if (!token) throw new Error("Sign in again before checking Cash Discounts.");
    const params = new URLSearchParams();
    if (evaluatedOn) params.set("evaluatedOn", evaluatedOn);
    if (selectedRuleId) params.set("ruleVersionId", selectedRuleId);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const bootstrap = await apiRequest<LocalCdBootstrap>(token, `/api/companies/${company.id}/evaluations/cd/local-bootstrap${suffix}`);
    setLocalBootstrap(bootstrap);
    return bootstrap;
  }, [company.id, selectedRuleId]);
  useEffect(() => { setLocalBootstrap(null); void preloadLocalBootstrap().catch(() => {}); }, [companyKey, preloadLocalBootstrap]);
  const running = localChecking || Boolean(run && !["completed", "completed_with_issues", "failed", "cancelled"].includes(run.status));
  useEffect(() => {
    if (!run || !running) return;
    let busy = false;
    const update = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const token = await accessToken();
        if (!token) return;
        const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/runs/${run.id}`);
        setRun(response.evaluationRun);
        if (["completed", "completed_with_issues", "failed", "cancelled"].includes(response.evaluationRun.status)) await loadRecoveries();
      } catch (cause) { setError(userFacingError(cause, "Could not update the Cash Discount recovery check.")); }
      finally { busy = false; }
    };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void update(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [company.id, loadRecoveries, run, running, setError]);

  // Cases whose Debit Note is being created or exists are tracked in Debit Notes.
  const rows = recoveries
    .filter((row) => !["posting", "completed"].includes(row.status))
    .filter((row) => resultTab === "review" ? row.status === "review_required" : row.status !== "review_required");
  const selectableRecoveryRows = rows.filter((row) => row.status === "action_required" && !row.id.startsWith("local:"));
  const selectedRecoveryRows = recoveries.filter((row) => selectedRecoveryIds.has(row.id) && row.status === "action_required" && !row.id.startsWith("local:"));
  const allVisibleSelected = selectableRecoveryRows.length > 0 && selectableRecoveryRows.every((row) => selectedRecoveryIds.has(row.id));
  const pageSlice = <T,>(items: T[]) => items.slice((resultPage - 1) * RESULT_PAGE_SIZE, resultPage * RESULT_PAGE_SIZE);
  const actionCount = recoverySummary.filter((row) => row.status === "action_required").length;
  const reviewCount = recoverySummary.filter((row) => row.status === "review_required").length;
  const recoveryTotal = recoverySummary.filter((row) => row.status === "action_required").reduce((total, row) => total + Number(row.remaining_recovery || 0), 0);
  const invoiceChecks: CashDiscountInvoiceCheck[] = localInvoiceChecks ?? run?.summary?.results ?? [];
  const eligibleInvoices = invoiceChecks.filter((row) => row.status === "retained");
  const invoiceCheckForRecovery = (recovery: CashDiscountRecovery) => invoiceChecks.find((check) => check.customerName === recovery.customer_name && check.invoiceNumber === recovery.invoice_number && check.invoiceDate === recovery.invoice_date) ?? null;
  const selectedRecoveryCheck = selectedRecovery ? invoiceCheckForRecovery(selectedRecovery) : null;
  const invoicesChecked = run?.summary?.invoicesChecked ?? 0;
  const attentionCount = reviewCount;
  const checkedPeriod = run?.period_start && run?.period_end ? `${formatBusinessDate(run.period_start)} – ${formatBusinessDate(run.period_end)}` : null;
  const selectResultTab = useCallback((tab: typeof resultTab) => { setError(null); setResultPage(1); setResultTab(tab); }, [setError]);
  useEffect(() => {
    setResultPage(1);
    if (!recoveryFilterInitialized.current) {
      recoveryFilterInitialized.current = true;
      return;
    }
    setRecoveriesLoading(true);
    const timer = window.setTimeout(() => { void loadRecoveries(filter, query).catch(() => {}); }, query.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [filter, query, loadRecoveries]);
  useEffect(() => {
    setSelectedRecoveryIds((current) => new Set([...current].filter((id) => recoveries.some((row) => row.id === id && row.status === "action_required"))));
  }, [recoveries]);
  useEffect(() => {
    const currentLength = resultTab === "all" ? (allView === "previous" ? previousRuleRecoveries.length : eligibleInvoices.length) : rows.length;
    setResultPage((current) => Math.min(current, Math.max(1, Math.ceil(currentLength / RESULT_PAGE_SIZE))));
  }, [allView, eligibleInvoices.length, previousRuleRecoveries.length, resultTab, rows.length]);
  useEffect(() => {
    if (loadingLatest) return;
    const requested = searchParams?.get("view");
    if (requested === "review") { setFilter("all"); selectResultTab("review"); }
    else if (requested === "all" || requested === "eligible") selectResultTab("all");
    else selectResultTab("recover");
  }, [companyKey, loadingLatest]);
  const stopRun = async () => {
    if (!run || !running || stopping) return;
    setStopping(true); setError(null);
    try {
      const token = await accessToken();
      if (!token) return;
      const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/runs/${run.id}/cancel`, { method: "POST" });
      setRun(response.evaluationRun); setNotice("Cash Discount check stopped.");
    } catch (cause) { setError(userFacingError(cause, "Could not stop this Cash Discount check.")); }
    finally { setStopping(false); }
  };
  const prepareDebitNote = async (row: CashDiscountRecovery) => {
    if (row.id.startsWith("local:")) {
      setNotice("This result is being saved. Debit Note preparation will be available in a moment.");
      return;
    }
    if (postingId) return;
    setPostingId(row.id); setError(null);
    try {
      const token = await accessToken();
      if (!token) return;
      const key = postingKeys.current.get(row.id) ?? idempotencyKey();
      postingKeys.current.set(row.id, key);
      await apiRequest(token, `/api/companies/${company.id}/cash-discount/recoveries/${row.id}/debit-note`, { method: "POST", headers: { "Idempotency-Key": key }, timeoutMs: 45_000 });
      postingKeys.current.delete(row.id);
      setNotice(`Debit Note for ${row.customer_name} is being created in Tally. Track it and send it on WhatsApp in Debit Notes.`); await loadRecoveries();
    } catch (cause) {
      const latest = await loadRecoveries().catch(() => []);
      if (latest.some((candidate) => candidate.id === row.id && candidate.status === "posting")) {
        setNotice(`Debit Note for ${row.customer_name} is being created in Tally. Track it and send it on WhatsApp in Debit Notes.`);
      } else {
        setError(userFacingError(cause, "Could not prepare this Debit Note. Wait a moment, then try again."));
      }
    }
    finally { setPostingId(null); }
  };
  const prepareSelectedDebitNotes = async () => {
    const candidateIds = selectedRecoveryRows.slice(0, 25).map((row) => row.id);
    if (!candidateIds.length || bulkPosting) return;
    setBulkPosting(true); setError(null);
    try {
      const token = await accessToken();
      if (!token) return;
      const response = await apiRequest<{ queued: number; skipped: number; message: string }>(token, `/api/companies/${company.id}/cash-discount/recoveries/bulk-debit-notes`, {
        method: "POST", body: jsonBody({ candidateIds }), timeoutMs: 45_000,
      });
      setNotice(`${response.skipped ? `${response.message} ${response.skipped} changed or invalid result${response.skipped === 1 ? " was" : "s were"} skipped.` : response.message} Track them and send on WhatsApp in Debit Notes.`);
      await loadRecoveries();
    } catch (cause) { setError(userFacingError(cause, "Could not prepare the selected Debit Notes.")); }
    finally { setBulkPosting(false); }
  };
  const toggleRecoverySelection = (id: string) => {
    setSelectedRecoveryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else if (next.size < 25) next.add(id);
      return next;
    });
  };
  const toggleAllVisibleRecoveries = () => {
    setSelectedRecoveryIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) selectableRecoveryRows.forEach((row) => next.delete(row.id));
      else selectableRecoveryRows.slice(0, Math.max(0, 25 - next.size)).forEach((row) => next.add(row.id));
      return next;
    });
  };
  const provisionalRecovery = (row: LocalCdRow, evaluatedOn: string): CashDiscountRecovery => ({
    id: `local:${row.invoiceTallyGuid}`, source_run_id: "local", evaluated_on: evaluatedOn, customer_name: row.customerName,
    invoice_number: row.invoiceNumber, invoice_date: row.invoiceDate, bill_reference: row.billReference,
    net_invoice_amount: row.netInvoiceAmount, implied_gross_amount: row.impliedGrossAmount, amount_paid: row.amountPaid,
    granted_discount_percentage: row.grantedDiscountPercentage, earned_discount_percentage: row.earnedDiscountPercentage,
    recovery_required: row.recoveryRequired, already_recovered: row.alreadyRecovered, remaining_recovery: row.remainingRecovery,
    missed_window_working_days: row.missedWindowWorkingDays, missed_window_deadline: row.missedWindowDeadline,
    next_window_working_days: row.nextWindowWorkingDays, next_window_percentage: row.nextWindowPercentage, status: row.status,
    reason_code: row.reasonCode, review_message: row.reviewMessage, narration_checked: row.narration.checked,
    narration_mentioned: row.narration.mentioned, narration_matches: row.narration.matches,
    debit_note_references: row.debitNoteReferences, updated_at: new Date().toISOString(),
  });
  const runLocalCheck = async (evaluatedOn: string) => {
    setLocalChecking(true); setLocalPhase("reading"); setError(null);
    setLocalInvoiceChecks(null);
    let result: Awaited<ReturnType<typeof runLocalCashDiscount>>;
    try {
      // A voucher can be added in Tally while this page is open. Never reuse
      // the preloaded snapshot for a user-triggered check: it would omit that
      // newer voucher even though the check reports as completed.
      const bootstrap = await preloadLocalBootstrap(evaluatedOn);
      result = await runLocalCashDiscount(bootstrap);
    } catch (cause) {
      setLocalChecking(false); setLocalPhase(null);
      // Older installed connectors do not expose the local API. Preserve the
      // existing server path until every desktop connector has been upgraded.
      const token = await accessToken();
      if (!token) throw cause;
      try {
        const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/cd`, {
          method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: jsonBody({ batch: true, evaluatedOn }),
        });
        setRun(response.evaluationRun); setEvaluationOpen(false);
        setNotice("The installed connector needs the speed update, so this check is using the compatible server path.");
      } catch { throw cause; }
      return;
    }

    // Render the local result at once, but keep the check in its saving state
    // until the verified snapshot is durable. Previously this POST was left in
    // the background, so a browser refresh could cancel it and restore the
    // previous Cash Discount snapshot.
    const provisionalRows = result.rows.map((row) => provisionalRecovery(row, evaluatedOn));
    setRecoveries(provisionalRows);
    setRecoverySummary(provisionalRows);
    setLocalInvoiceChecks(Array.isArray(result.results) ? result.results : []);
    setLocalPhase("saving");
    setNotice("Current Tally results are ready. Saving the verified result…");
    try {
      const token = await accessToken();
      if (!token) return;
      const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/cd/local-result`, {
        method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: jsonBody({ evaluatedOn, evidence: result.evidence }), timeoutMs: 60_000,
      });
      setRun(response.evaluationRun);
      setLocalInvoiceChecks(null);
      await loadRecoveries();
      setNotice(null);
      setEvaluationOpen(false);
    } catch (cause) {
      setError(userFacingError(cause, "The live result is visible, but it could not be saved yet. Run the check again before posting."));
    } finally {
      setLocalChecking(false); setLocalPhase(null);
    }
  };
  const activity = running ? run?.status === "queued" ? "Waiting to begin" : run?.status === "evaluating" ? "Calculating recoveries" : "Reading invoices, receipts, and Debit Notes" : run?.completed_at ? `Latest check completed ${formatDate(run.completed_at)}` : "No completed check yet";
  const checkHeadline = running ? "Checking current Tally data" : !run ? "Run a Tally check to calculate Cash Discounts" : invoicesChecked === 0 ? "No invoices matched the active rule" : `${invoicesChecked} Sales invoice${invoicesChecked === 1 ? "" : "s"} evaluated`;

  // A per-MT rule (docs/CD_LOGIC.md) gives the discount by Credit Note, not by Debit Note recovery.
  if (cdRules.some((rule) => rule.cdDiscountBasis === "amount_per_tonne")) return <CashDiscountSettlementsPage isAdministrator={isAdministrator} setNotice={setNotice} setError={setError} />;

  if (loadingLatest) return <>
    <WorkspacePageHeader eyebrow="" title="Cash Discount" detail="" />
    <section className="cd-check-summary cd-check-summary-loading" aria-label="Loading latest Cash Discount check"><Skeleton lines={3} /><Skeleton lines={1} style={{ width: 180, height: 32 }} /></section>
    <Card className="cd-live-results cd-results-surface"><div className="cd-recovery-loading-toolbar"><Skeleton lines={1} style={{ width: "42%", height: 35 }} /><Skeleton lines={1} style={{ width: 118, height: 35 }} /><Skeleton lines={1} style={{ width: 128, height: 35 }} /></div><CashDiscountRecoverySkeleton /></Card>
  </>;

  return <>
    <WorkspacePageHeader eyebrow="" title="Cash Discount" detail="" />
    {run?.status === "failed" && <InlineMessage tone="error">{userFacingDetail(run.summary?.message ?? run.error_summary, "Check didn't finish. Previous results are unchanged.")}</InlineMessage>}
    {run?.status === "cancelled" && <InlineMessage tone="warning">Check stopped. Previous results are unchanged.</InlineMessage>}
    {/* Same bar as Turnover Discount: status on the left, last check and the Calculate button on the right. */}
    <section className="tod-overview cd-overview" aria-label="Latest Cash Discount check">
      <div className="tod-overview-meta">
        <div className="tod-period-context">{localPhase ? <StatusBadge status={localPhase === "saving" ? "posting" : "evaluating"}>{localPhase === "saving" ? "Saving" : "Checking"}</StatusBadge> : running && run ? <StatusBadge status={run.status} /> : run ? <StatusBadge status="ready" /> : <StatusBadge status="not_started">Not checked</StatusBadge>}{cdRules.length > 1
          ? <label className="cd-rule-select"><span className="sr-only">Cash Discount rule</span><select value={selectedRuleId ?? ""} disabled={running} onChange={(event) => setSelectedRuleId(event.target.value)}>{cdRules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name} · {Number(rule.discountPercentage)}% · {rule.allowedWorkingDays} days</option>)}</select></label>
          : <strong>{checkedPeriod || "Cash Discount"}</strong>}<span><CircleAlert size={13} />{running ? activity : run ? "Payments checked against the rule deadline" : "Check Tally to see which Cash Discounts to recover"}</span></div>
        <div className="tod-overview-actions"><span>{running ? "Checking Tally…" : run?.completed_at ? `Calculated ${formatDate(run.completed_at)}` : "Not calculated yet"}</span>
          {localChecking ? <Button className="button-secondary" disabled><RefreshCw className="spin" size={15} />Checking Tally…</Button>
            : running ? <Button className="button-secondary" disabled={stopping} onClick={() => void stopRun()}><Square size={15} />{stopping ? "Stopping…" : "Stop"}</Button>
            : <Button className="button-secondary" onClick={() => setEvaluationOpen(true)}><RefreshCw size={15} />Calculate</Button>}
          <Link className="button button-quiet" href="/rulebook">Active rule</Link></div>
      </div>
      {(running || !run) && <div className="cd-overview-body"><h2>{running ? "Checking Tally" : checkHeadline}</h2><p>{running ? "Existing results remain available until this check is saved." : "Press Calculate to see which Cash Discounts to recover."}</p></div>}
    </section>
    {run && <div className="cd-action-cards" role="tablist" aria-label="Cash Discount actions">
      <button type="button" role="tab" aria-selected={resultTab === "recover"} className={resultTab === "recover" ? "cd-action-card selected" : "cd-action-card"} onClick={() => { setFilter("all"); selectResultTab("recover"); }}><span>To recover</span><strong>{formatMoney(recoveryTotal)}</strong><small>{actionCount} invoice{actionCount === 1 ? "" : "s"}</small></button>
      <button type="button" role="tab" aria-selected={resultTab === "review"} className={`cd-action-card${resultTab === "review" ? " selected" : ""}${attentionCount ? " has-attention" : ""}`} onClick={() => { setFilter("all"); selectResultTab("review"); }}><span>Needs review</span><strong>{attentionCount}</strong><small>{attentionCount ? "your decision" : "nothing to decide"}</small></button>
    </div>}
    {run && <div className="cd-view-switch">{resultTab === "all" ? <>{previousRuleRecoveries.length > 0 && <div className="segmented cd-reference-tabs" role="tablist" aria-label="Checked invoices"><button type="button" role="tab" aria-selected={allView === "retained"} className={allView === "retained" ? "selected" : ""} onClick={() => { setAllView("retained"); setResultPage(1); }}>Discount retained <span>{eligibleInvoices.length}</span></button><button type="button" role="tab" aria-selected={allView === "previous"} className={allView === "previous" ? "selected" : ""} onClick={() => { setAllView("previous"); setResultPage(1); }}>Earlier results <span>{previousRuleRecoveries.length}</span></button></div>}<button type="button" onClick={() => { setFilter("all"); selectResultTab("recover"); }}><ChevronLeft size={14} />Back to actions</button></> : <button type="button" onClick={() => { setAllView("retained"); selectResultTab("all"); }}>View {eligibleInvoices.length.toLocaleString("en-IN")} invoices with discount retained{previousRuleRecoveries.length ? " and earlier results" : ""}<ChevronRight size={14} /></button>}</div>}
    {resultTab === "all" && (allView === "retained" || !previousRuleRecoveries.length) && <Card className="cd-live-results"><div className="card-title"><div><h2>Discount retained</h2><p className="muted-copy">Paid in full by the rule deadline; no recovery is needed.</p></div></div>
      {eligibleInvoices.length ? <><div className="data-table cd-live-table"><div className="table-head"><span>Customer and invoice</span><span>Payment received</span><span>Cash Discount</span><span>Verified from Tally</span></div>{pageSlice(eligibleInvoices).map((row) => <article key={row.invoiceGuid} className="cd-result-row is-retained"><div><strong>{row.customerName}</strong><small>Invoice {row.invoiceNumber ?? "—"} · {formatBusinessDate(row.invoiceDate)}</small></div><div><strong>{formatMoney(row.invoiceAmount)} invoice</strong><small>{formatMoney(row.amountPaid)} allocated across {row.paymentCount === 1 ? "1 receipt" : `${row.paymentCount} receipts`}{Number(row.amountPaid) > Number(row.invoiceAmount) ? " · includes excess receipt value" : " · paid in full"}</small></div><div><StatusBadge status="retained" /><small>{formatPercentage(row.earnedDiscountPercentage)}% of {formatPercentage(row.discountPercentage)}% earned</small></div><div><strong>{formatBusinessDate(row.latestPaymentDate, "Payment date unavailable")}</strong><small>Payment deadline {formatBusinessDate(row.eligibilityDeadline)}</small></div></article>)}</div><ResultPagination page={resultPage} totalItems={eligibleInvoices.length} onPageChange={setResultPage} /></> : <EmptyState title={running ? "Checking Tally" : invoicesChecked === 0 && run ? "No invoices were evaluated" : "No discounts were retained"} detail={running ? "Retained discounts will appear when the current check finishes." : run ? invoicesChecked === 0 ? `The latest check found no posted Sales invoices matching the active rule${checkedPeriod ? ` for ${checkedPeriod}` : ""}. Review the rule's customer coverage and dates before checking again.` : "No evaluated invoice was paid in full by its Cash Discount deadline." : "Run a Tally check to find invoices that retained their Cash Discount."} action={!running && (!run || invoicesChecked === 0) ? <div className="cd-empty-actions"><Link className="button button-secondary" href="/rulebook">Review active rule</Link><Button onClick={() => setEvaluationOpen(true)}>{run ? "Check again" : "Check Cash Discounts"}</Button></div> : undefined} />}
    </Card>}
    {(resultTab === "recover" || resultTab === "review") && <Card className="cd-live-results cd-results-surface">
      <div className="cd-recovery-toolbar"><label className="queue-search cd-recovery-search"><span className="sr-only">Find customer or invoice</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer or invoice" /></label><div className="cd-recovery-toolbar-actions">{resultTab === "recover" && <label className="cd-status-filter"><span>Case</span><select aria-label="Filter recovery cases" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">All cases</option><option value="not_paid">Not paid</option><option value="partially_paid">Partly paid</option></select></label>}<Button className="cd-bulk-action" disabled={bulkPosting || selectedRecoveryRows.length === 0} onClick={() => setBulkConfirmOpen(true)}>{bulkPosting ? "Preparing…" : selectedRecoveryRows.length ? `Prepare ${selectedRecoveryRows.length} selected` : "Prepare selected"}</Button></div></div>
      {recoveriesLoading ? <CashDiscountRecoverySkeleton /> : recoveriesError ? <EmptyState title="Recovery results unavailable" detail={recoveriesError} action={<Button className="button-secondary" onClick={() => void loadRecoveries(filter, query).catch(() => {})}>Try again</Button>} /> : rows.length ? <><div className="cd-bulk-selection-note"><span>{selectedRecoveryRows.length ? `${selectedRecoveryRows.length} of 25 selected` : "Select recoveries to prepare Debit Notes together"}</span>{selectedRecoveryRows.length > 0 && <button type="button" onClick={() => setSelectedRecoveryIds(new Set())}>Clear selection</button>}</div><div className="data-table cd-live-table cd-recovery-table"><div className="table-head"><span className="cd-select-column"><input type="checkbox" aria-label="Select all recoveries in this view" checked={allVisibleSelected} onChange={toggleAllVisibleRecoveries} /></span><span>Customer and invoice</span><span>Why recovery is due</span><span>Recovery amount</span><span>Action</span></div>{pageSlice(rows).map((row) => { const check = invoiceCheckForRecovery(row); const selectable = row.status === "action_required" && !row.id.startsWith("local:"); return <article key={row.id} className={`cd-result-row cd-recovery-row is-${row.status} recovery-case-${recoveryCaseLabel(row)}`}><div className="cd-select-column">{selectable ? <input type="checkbox" aria-label={`Select ${row.customer_name}`} checked={selectedRecoveryIds.has(row.id)} onChange={() => toggleRecoverySelection(row.id)} /> : <span className="cd-selection-placeholder" />}</div><div className="cd-recovery-identity"><strong>{row.customer_name}</strong><small>Invoice {row.invoice_number ?? "—"} · {formatBusinessDate(row.invoice_date)}</small><small>Net {formatMoney(row.net_invoice_amount)} · Paid {formatMoney(row.amount_paid)}</small></div><div className="cd-recovery-window"><strong>{formatPercentage(row.granted_discount_percentage)}% granted → {formatPercentage(row.earned_discount_percentage)}% earned</strong><small>{row.missed_window_working_days}-day deadline: {formatBusinessDate(row.missed_window_deadline)}</small>{check?.latestPaymentDate && <small>{Number(row.amount_paid || 0) + 0.005 < Number(row.net_invoice_amount || 0) ? "Last payment" : "Paid in full"}: {formatBusinessDate(check.latestPaymentDate)}{check.latestPaymentDate > row.missed_window_deadline ? " · after deadline" : ""}</small>}{row.next_window_working_days && <small>Next: {formatPercentage(row.next_window_percentage)}% within {row.next_window_working_days} working days</small>}</div><div className="cd-recovery-amount"><strong>{formatMoney(row.remaining_recovery)}</strong>{Number(row.recovery_required) !== Number(row.remaining_recovery) && <small>Originally required {formatMoney(row.recovery_required)}</small>}{Number(row.already_recovered) > 0 && <small>{formatMoney(row.already_recovered)} already recovered</small>}</div><div className="cd-recovery-action">{row.status === "review_required" ? <><StatusBadge status="needs_review" /><small>{row.review_message ?? "Review before posting."}</small></> : <Button disabled={row.status === "posting" || postingId === row.id} onClick={() => setSelectedRecovery(row)}>{row.status === "posting" || postingId === row.id ? "Preparing…" : "Review"}</Button>}</div></article>; })}</div><ResultPagination page={resultPage} totalItems={rows.length} onPageChange={setResultPage} /></> : <EmptyState title={running ? "Checking Tally" : resultTab === "review" ? "Nothing needs review" : "No recovery is required"} detail={running ? "The latest actions will replace this view only after the check succeeds." : resultTab === "review" ? "Every result from the latest check was decided automatically." : "The latest successful check found no expired Cash Discount to recover."} action={!running && !run ? <Button onClick={() => setEvaluationOpen(true)}>Check Cash Discounts</Button> : undefined} />}
    </Card>}
    {resultTab === "all" && allView === "previous" && previousRuleRecoveries.length > 0 && <Card className="cd-live-results"><div className="card-title"><div><h2>Earlier-rule results</h2><p className="muted-copy">Historical calculations are kept for reference; only the current check can create a new action.</p></div></div>
      {previousRuleRecoveries.length ? <div className="data-table cd-live-table"><div className="table-head"><span>Customer and invoice</span><span>Earlier check</span><span>Recovery amount</span><span>Context</span></div>{previousRuleRecoveries.map((row) => <article key={row.id} className="cd-result-row"><div><strong>{row.customer_name}</strong><small>Invoice {row.invoice_number ?? "—"} · {formatBusinessDate(row.invoice_date)}</small>{row.bill_reference && row.bill_reference !== row.invoice_number && <small>Bill reference {row.bill_reference}</small>}</div><div><strong>Checked {formatBusinessDate(row.evaluated_on)}</strong><small>{formatPercentage(row.granted_discount_percentage)}% granted → {formatPercentage(row.earned_discount_percentage)}% earned</small></div><div><strong>{formatMoney(row.remaining_recovery)}</strong><small>Earlier rule result</small></div><div><StatusBadge status="already_credited">Historical</StatusBadge><small>Compare this with the active rule before acting.</small><Link className="button button-quiet" href="/rulebook">View active rule</Link></div></article>)}</div> : <EmptyState title="No earlier-rule results" detail="Unresolved actions from a former rule will appear here without mixing with current actions." />}
    </Card>}
    <Drawer open={Boolean(selectedRecovery)} onClose={() => setSelectedRecovery(null)} title="Review recovery" description="Check the calculation and payment evidence before preparing a Debit Note." width="wide">
      {selectedRecovery && <div className={`drawer-stack cd-recovery-drawer recovery-case-${recoveryCaseLabel(selectedRecovery)}`}>
        <div className="cd-recovery-hero">
          <div className="cd-recovery-hero-value">
            <StatusBadge status={selectedRecovery.status === "review_required" ? "needs_review" : "recovery_due"}>{recoveryCaseLabel(selectedRecovery).replaceAll("_", " ")}</StatusBadge>
            <span>Debit Note amount</span>
            <strong>{formatMoney(selectedRecovery.remaining_recovery)}</strong>
          </div>
          <div className="cd-recovery-hero-meta">
            <h3>{selectedRecovery.customer_name}</h3>
            <p>Invoice {selectedRecovery.invoice_number ?? "—"}</p>
            <small>{formatBusinessDate(selectedRecovery.invoice_date)}</small>
          </div>
        </div>

        <div className="cd-recovery-metrics">
          <div><span>Invoice net</span><strong>{formatMoney(selectedRecovery.net_invoice_amount)}</strong></div>
          <div><span>Paid so far</span><strong>{formatMoney(selectedRecovery.amount_paid)}</strong></div>
          <div><span>Payment deadline</span><strong>{formatBusinessDate(selectedRecovery.missed_window_deadline)}</strong></div>
        </div>

        <section className="cd-recovery-drawer-section">
          <span className="cd-recovery-section-label">Recovery calculation</span>
          <h3>{formatPercentage(selectedRecovery.granted_discount_percentage)}% granted → {formatPercentage(selectedRecovery.earned_discount_percentage)}% earned</h3>
          <p>The customer did not meet the approved Cash Discount deadline, so the unearned discount can be recovered.</p>
        </section>

        <section className="cd-recovery-drawer-section">
          <span className="cd-recovery-section-label">Payment evidence</span>
          <div className="cd-recovery-evidence">
            <div><span>Required by</span><strong>{formatBusinessDate(selectedRecovery.missed_window_deadline)}</strong></div>
            <div><span>{Number(selectedRecovery.amount_paid || 0) + 0.005 < Number(selectedRecovery.net_invoice_amount || 0) ? "Last payment" : "Paid in full"}</span><strong>{selectedRecoveryCheck?.latestPaymentDate ? formatBusinessDate(selectedRecoveryCheck.latestPaymentDate) : "No payment yet"}</strong></div>
          </div>
        </section>

        <div className="cd-recovery-next-step">
          <CircleAlert size={16} />
          <div><strong>What happens next</strong><span>A Debit Note is created in Tally and checked. Once confirmed, you can send it to the customer on WhatsApp from Debit Notes.</span></div>
        </div>

        <div className="cd-recovery-drawer-actions">
          <Button className="button-secondary" onClick={() => setSelectedRecovery(null)}>Close</Button>
          <Button disabled={Boolean(postingId) || selectedRecovery.id.startsWith("local:") || running} onClick={() => { const recovery = selectedRecovery; setSelectedRecovery(null); void prepareDebitNote(recovery); }}>{selectedRecovery.id.startsWith("local:") || running ? "Waiting for saved results…" : postingId ? "Preparing…" : `Prepare ${formatMoney(selectedRecovery.remaining_recovery)} Debit Note`}</Button>
        </div>
      </div>}
    </Drawer>
    <Dialog open={bulkConfirmOpen} onClose={() => setBulkConfirmOpen(false)} title={`Prepare ${selectedRecoveryRows.length} Debit Notes?`} description="Review this selection before anything is queued for Tally."><div className="cd-bulk-confirm"><div className="cd-bulk-confirm-summary"><strong>{selectedRecoveryRows.length} Debit Notes</strong><span>{formatMoney(selectedRecoveryRows.reduce((total, row) => total + Number(row.remaining_recovery || 0), 0))} total recovery</span></div><div className="cd-bulk-confirm-list">{selectedRecoveryRows.slice(0, 6).map((row) => <div key={row.id}><span>{row.customer_name}</span><strong>{formatMoney(row.remaining_recovery)}</strong></div>)}{selectedRecoveryRows.length > 6 && <small>+ {selectedRecoveryRows.length - 6} more selected</small>}</div><p>Each selected recovery will be rechecked for readiness, then queued individually. Tally creation happens in the background. No WhatsApp message will be sent.</p><div className="dialog-actions"><Button className="button-secondary" onClick={() => setBulkConfirmOpen(false)}>Back</Button><Button disabled={bulkPosting} onClick={() => { setBulkConfirmOpen(false); void prepareSelectedDebitNotes(); }}>{bulkPosting ? "Preparing…" : "Confirm and prepare"}</Button></div></div></Dialog>
    <GuidedEvaluationDrawer open={evaluationOpen} onClose={() => { if (!localChecking) setEvaluationOpen(false); }} scheme="cd" activeRun={!localChecking && running ? run : null} localPhase={localPhase} onComplete={async (message, submittedRun) => { setRun(submittedRun); setNotice(message); setEvaluationOpen(false); }} onError={setError} onCashDiscountSubmit={runLocalCheck} />
  </>;
}

function DiscountPageBody({ scheme, data, refresh, setNotice, setError, customerNames }: PageProps & { scheme: "cd" | "tod" }) {
  const { company, isAdministrator } = useCompany();
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [showEvaluationQueue, setShowEvaluationQueue] = useState(false);
  // Credit Notes links here with ?view=create: open the latest ended period on "Ready to create".
  const todSearchParams = useSearchParams();
  const openReadyView = scheme === "tod" && ["create", "ready"].includes(todSearchParams?.get("view") ?? "");
  const readyViewApplied = useRef(false);
  const [latestRun, setLatestRun] = useState<EvaluationRun | null>(null);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [query, setQuery] = useState("");
  // TOD cards: "ready" | "created" | "review" | "not_qualified" for an ended period,
  // "qualified" | "close" | "review" | "no_activity" for a period in progress.
  const [statusFilter, setStatusFilter] = useState(scheme === "tod" ? (openReadyView ? "ready" : "") : "all");
  const [localTodBootstrap, setLocalTodBootstrap] = useState<LocalTodBootstrap | null>(null);
  const [localTodRows, setLocalTodRows] = useState<Proposal[]>([]);
  const [savingTod, setSavingTod] = useState(false);
  const [calculationStartedAt, setCalculationStartedAt] = useState<string | null>(null);
  const [selectedTodPeriodKey, setSelectedTodPeriodKey] = useState<string | null>(null);
  const [selectedHistoryRun, setSelectedHistoryRun] = useState<EvaluationRun | null>(null);
  const [historyTodRows, setHistoryTodRows] = useState<Proposal[] | null>(null);
  // `not_in_scheme` is an audit result from a rule version that no longer
  // covers the customer. Keep it in the durable calculation history, but do
  // not present it as a second current result beside the applicable rule.
  // "View snapshot": what one past calculation found, read-only, from that run's own results.
  function openSnapshot(run: EvaluationRun) {
    void (async () => {
      setNotice("Loading the saved calculation snapshot…");
      try {
        const token = await accessToken();
        if (!token) return;
        const response = await apiRequest<{ results: Array<{ id: string; customerId: string; customerName: string; schemeVersionId: string | null; periodStart: string | null; periodEnd: string | null; outcome: string; eligibleTonnes: string; calculatedDiscountAmount: string; completedAt: string | null; createdAt: string }> }>(token, `/api/companies/${company.id}/evaluations/runs/${run.id}/results`, { cache: "no-store" });
        setHistoryTodRows(response.results.map((result) => ({
          id: `history:${result.id}`, customer_id: result.customerId, customer_name: result.customerName, scheme_type: "tod", status: result.outcome,
          period_start: result.periodStart ?? run.period_start ?? null, period_end: result.periodEnd ?? run.period_end ?? null, eligibility_deadline: result.periodEnd ?? run.period_end ?? null,
          calculated_discount_amount: result.calculatedDiscountAmount, scheme_version_id: result.schemeVersionId ?? run.scheme_version_id ?? undefined,
          source_sales_voucher_id: null, entitlement_key: `history:${run.id}:${result.customerId}`, eligible_product_taxable_value: null,
          achieved_tier_id: Number(result.calculatedDiscountAmount) > 0 ? `history:${result.id}` : null, next_tier_tonnes: null, additional_tonnes_required: null,
          invoice_amount_due: "0", amount_paid_by_deadline: "0", discounted_settlement_target: "0", discount_percentage: null,
          eligible_tonnes: result.eligibleTonnes, shortfall_amount: "0", latest_evaluated_at: result.completedAt ?? result.createdAt,
          reason_codes: [], latestEvaluation: null, creditNotePosting: null,
        })));
        setSelectedHistoryRun(run);
        setSelectedTodPeriodKey(`${run.period_start}:${run.period_end}`);
        setStatusFilter("all");
        setQuery("");
        setShowEvaluationQueue(false);
        setNotice(`Showing the ${formatBusinessDate(run.period_start)} – ${formatBusinessDate(run.period_end)} calculation snapshot from ${formatDate(run.created_at)}.`);
      } catch (cause) { setError(userFacingError(cause, "Could not load this calculation snapshot.")); }
    })();
  }
  // Rows fetched for one period by "View results" (the page's initial list is
  // capped at 250 recent rows). They fill the gaps; the page's own (refreshed) data wins.
  const [periodRows, setPeriodRows] = useState<Proposal[]>([]);
  const allSchemeRows = useMemo(() => {
    const merged = new Map(periodRows.map((proposal) => [proposal.id, proposal]));
    for (const proposal of data.proposals) merged.set(proposal.id, proposal);
    return [...merged.values()].filter((proposal) => proposal.scheme_type === scheme);
  }, [data.proposals, periodRows, scheme]);
  const allSavedRows = allSchemeRows.filter((proposal) => proposal.scheme_type === scheme
    && (scheme !== "tod" || (proposal.status !== "not_in_scheme" && (!localTodBootstrap || proposal.scheme_version_id === localTodBootstrap.activeSchemeVersionId))));
  const savedRows = scheme === "tod" && selectedTodPeriodKey
      ? allSavedRows.filter((proposal) => `${proposal.period_start}:${proposal.period_end}` === selectedTodPeriodKey)
      : allSavedRows;
  const localKeys = new Set(localTodRows.map((proposal) => proposal.entitlement_key).filter(Boolean));
  // Periods with saved or freshly calculated results, newest first, for the period selector.
  const todPeriodOptions = scheme === "tod"
    ? [...new Set([...localTodRows, ...allSavedRows].flatMap((proposal) => periodKeyOf(proposal) ?? []))].sort().reverse()
    : [];
  const localPeriodRows = selectedTodPeriodKey ? localTodRows.filter((proposal) => periodKeyOf(proposal) === selectedTodPeriodKey) : localTodRows;
  const allRows = scheme === "tod" && selectedHistoryRun && historyTodRows
    ? historyTodRows
    : scheme === "tod" ? [...localPeriodRows, ...savedRows.filter((proposal) => !proposal.entitlement_key || !localKeys.has(proposal.entitlement_key))] : savedRows;
  useEffect(() => {
    if (!openReadyView || readyViewApplied.current) return;
    const latestReady = readyTodCreditNotes(data).map(periodKeyOf).filter((key): key is string => Boolean(key)).sort().at(-1);
    if (!latestReady) return;
    readyViewApplied.current = true;
    setSelectedTodPeriodKey(latestReady);
    setStatusFilter("ready");
  }, [data, openReadyView]);

  const preloadLocalTodBootstrap = useCallback(async (asOfDate?: string) => {
    const token = await accessToken();
    if (!token) throw new Error("Sign in again before calculating Turnover Discounts.");
    const suffix = asOfDate ? `?asOfDate=${encodeURIComponent(asOfDate)}` : "";
    const bootstrap = await apiRequest<LocalTodBootstrap>(token, `/api/companies/${company.id}/evaluations/tod/local-bootstrap${suffix}`);
    setLocalTodBootstrap(bootstrap);
    // The period shown on load is chosen from the last saved result (below),
    // not the rule's current period, which may not have been calculated yet.
    return bootstrap;
  }, [company.id]);
  // On opening the page, show the period of the most recently saved
  // calculation so the user lands on their last result.
  const lastSavedPeriodApplied = useRef<string | null>(null);
  useEffect(() => {
    // Wait for the bootstrap so rows from retired rule versions are excluded.
    if (scheme !== "tod" || openReadyView || !localTodBootstrap || lastSavedPeriodApplied.current === company.id || !allSavedRows.length) return;
    const latest = allSavedRows.reduce((best, proposal) => (proposal.latest_evaluated_at ?? "") > (best.latest_evaluated_at ?? "") ? proposal : best);
    const key = periodKeyOf(latest);
    if (!key) return;
    lastSavedPeriodApplied.current = company.id;
    setSelectedTodPeriodKey(key);
  }, [allSavedRows, company.id, localTodBootstrap, openReadyView, scheme]);
  useEffect(() => {
    if (scheme !== "tod") return;
    setLocalTodBootstrap(null);
    setLocalTodRows([]);
    void preloadLocalTodBootstrap().catch(() => {});
  }, [company.id, preloadLocalTodBootstrap, scheme]);

  const provisionalTodProposal = (row: LocalTodRow): Proposal => {
    const existing = savedRows.find((proposal) => proposal.entitlement_key === row.entitlementKey);
    const preservedPosting = existing?.creditNotePosting ?? null;
    const status = preservedPosting?.status === "created_verified" ? "already_credited" : row.status;
    return {
      id: `local:${row.customerId}:${row.periodStart}`,
      customer_id: row.customerId,
      customer_name: row.customerName,
      scheme_type: "tod",
      status,
      period_start: row.periodStart,
      period_end: row.periodEnd,
      eligibility_deadline: row.eligibilityDeadline,
      calculated_discount_amount: row.calculatedDiscountAmount,
      scheme_version_id: row.schemeVersionId,
      source_sales_voucher_id: null,
      entitlement_key: row.entitlementKey,
      eligible_product_taxable_value: row.eligibleProductTaxableValue,
      achieved_tier_id: row.achievedTierId,
      next_tier_tonnes: row.nextTierTonnes,
      additional_tonnes_required: row.additionalTonnesRequired,
      invoice_amount_due: "0.0000",
      amount_paid_by_deadline: "0.0000",
      discounted_settlement_target: "0.0000",
      discount_percentage: row.discountPercentage,
      eligible_tonnes: row.eligibleTonnes,
      shortfall_amount: "0.0000",
      latest_evaluated_at: new Date().toISOString(),
      reason_codes: row.reasonCodes,
      latestEvaluation: null,
      creditNotePosting: preservedPosting,
    };
  };

  const runLocalTodCalculation = async (asOfDate: string) => {
    setError(null);
    setSelectedHistoryRun(null);
    setHistoryTodRows(null);
    setSavingTod(true);
    setCalculationStartedAt(new Date().toISOString());
    try {
      // Rule periods can differ between customers because a prior TOD result
      // locks its period. Always refresh the lightweight bootstrap before
      // reading Tally so each group is calculated against the right period.
      const bootstrap = await preloadLocalTodBootstrap(asOfDate);
      const result = await runLocalTurnoverDiscount(bootstrap);
      if (result.rows[0]) setSelectedTodPeriodKey(`${result.rows[0].periodStart}:${result.rows[0].periodEnd}`);
      // Keep the user on the progress view until every customer is saved;
      // showing unsaved rows (with no actions) made it look finished early.
      setShowEvaluationQueue(true);
      setEvaluationOpen(false);
      setNotice(`Calculated ${result.rows.length} customers from Tally. Saving each result — progress is shown below.`);
      const token = await accessToken();
      if (!token) return;
      const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/tod/local-result`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: jsonBody({ asOfDate, evaluatedOn: bootstrap.evaluatedOn, evidence: result.evidence }),
        timeoutMs: 60_000,
      });
      setLatestRun(response.evaluationRun);
      // Saving writes one result per customer; hundreds of customers can take
      // several minutes, so keep waiting (up to 20 minutes) instead of giving
      // up while the rows still say "Saving details…".
      for (let attempt = 0; attempt <= 40; attempt += 1) {
        if (attempt) await new Promise((resolve) => window.setTimeout(resolve, 30_000));
        // An older proposal with identical values cannot confirm this run.
        const saved = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/runs/${response.evaluationRun.id}?detail=compact`, { cache: "no-store" });
        setLatestRun(saved.evaluationRun);
        if (["failed", "completed_with_issues", "cancelled"].includes(saved.evaluationRun.status)) {
          setLocalTodRows([]);
          setShowEvaluationQueue(true);
          throw new Error("This calculation did not finish. Review Calculation history before starting another check.");
        }
        if (saved.evaluationRun.status === "completed") {
          await refresh();
          setLocalTodRows([]);
          setShowEvaluationQueue(false);
          setNotice("Turnover Discount results are saved. Open any customer to view the calculation.");
          window.setTimeout(() => setNotice(null), 6000);
          return;
        }
      }
      throw new Error("The customer results are still being finalized. Open Calculation history before trying again.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const connectorNeedsUpgrade = /route not found|failed to fetch|networkerror|load failed/i.test(message);
      if (!connectorNeedsUpgrade) throw cause;
      const token = await accessToken();
      if (!token) throw cause;
      const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/tod`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: jsonBody({ batch: true, asOfDate, evaluatedOn: new Date().toISOString().slice(0, 10) }),
        timeoutMs: 60_000,
      });
      setLatestRun(response.evaluationRun);
      setShowEvaluationQueue(true);
      setEvaluationOpen(false);
      setNotice("The installed connector needs the latest update. The compatible calculation has started in the background.");
    } finally { setSavingTod(false); }
  };
  const runAllDueTodCalculations = async (asOfDates: string[]) => {
    for (const asOfDate of asOfDates) await runLocalTodCalculation(asOfDate);
  };
  const statuses = Array.from(new Set(allRows.map((proposal) => proposal.status)));
  const tonnes = (proposal: Proposal) => Number(proposal.eligible_tonnes ?? "0") || 0;
  const readyToFinalize = allRows.filter((proposal) => ["eligible", "pending_approval"].includes(proposal.status)).length;
  const reviewing = allRows.filter((proposal) => ["needs_review", "review_invalidated", "pending_approval"].includes(proposal.status)).length;
  const periodRow = allRows.find((proposal) => proposal.period_start && proposal.period_end);
  const periodKeys = new Set(allRows.flatMap((proposal) => proposal.period_start && proposal.period_end ? [`${proposal.period_start}:${proposal.period_end}`] : []));
  const periodLabel = periodKeys.size > 1 ? `${periodKeys.size} calculation periods` : periodRow?.period_start && periodRow.period_end ? `${formatBusinessDate(periodRow.period_start)} – ${formatBusinessDate(periodRow.period_end)}` : "Current rule period";
  const periodEnded = Boolean(allRows.length) && allRows.every((proposal) => proposal.period_end && new Date(`${proposal.period_end.slice(0, 10)}T23:59:59`).getTime() < Date.now());
  const lastChecked = allRows.map((proposal) => proposal.latest_evaluated_at).filter(Boolean).sort().at(-1) ?? null;
  const turnoverPeriods = (localTodBootstrap?.periods ?? []).map((period) => ({
    ...period,
    calculated: allSavedRows.some((proposal) => proposal.scheme_version_id === localTodBootstrap?.activeSchemeVersionId && proposal.period_start === period.start && proposal.period_end === period.end),
  }));
  const todTierById = new Map<string, { minimumTonnes: number; amountPerTonne: number | null; percentage: number | null; index: number; count: number }>();
  const todScaleByRule = new Map<string, TodSlabScale>();
  for (const batch of localTodBootstrap?.batches ?? []) {
    const tiers = Array.isArray(batch.rule.tiers) ? batch.rule.tiers as Array<Record<string, unknown>> : [];
    tiers.forEach((tier, index) => {
      const id = typeof tier.id === "string" ? tier.id : null;
      if (!id) return;
      todTierById.set(id, {
        minimumTonnes: Number(tier.minimumTonnes ?? 0),
        amountPerTonne: tier.amountPerTonne == null ? null : Number(tier.amountPerTonne),
        percentage: tier.percentage == null ? null : Number(tier.percentage),
        index,
        count: tiers.length,
      });
    });
    // The full slab scale per rule version, for the tonnes bar's tick marks.
    const ruleId = typeof batch.rule.id === "string" ? batch.rule.id : null;
    if (ruleId) todScaleByRule.set(ruleId, tiers.map((tier) => ({
      minimumTonnes: Number(tier.minimumTonnes ?? 0),
      label: tier.amountPerTonne != null ? `₹${formatTonnes(Number(tier.amountPerTonne))}/MT` : tier.percentage != null ? `${formatTonnes(Number(tier.percentage))}%` : "",
    })).sort((left, right) => left.minimumTonnes - right.minimumTonnes));
  }
  // Each customer belongs to exactly one card. An ended period is about issuing
  // Credit Notes; a period in progress is about watching progress.
  const todBucket = (proposal: Proposal) => {
    if (["needs_review", "review_invalidated", "pending_approval"].includes(proposal.status)) return "review";
    if (periodEnded) {
      if (proposal.creditNotePosting || ["created_verified", "already_credited"].includes(proposal.status)) return "created";
      return proposal.achieved_tier_id ? "ready" : "not_qualified";
    }
    if (proposal.achieved_tier_id) return "qualified";
    return tonnes(proposal) > 0 ? "close" : "no_activity";
  };
  const todBuckets = periodEnded ? ["ready", "created", "review", "not_qualified"] : ["qualified", "close", "review", "no_activity"];
  const todCount = (bucket: string) => allRows.filter((proposal) => todBucket(proposal) === bucket).length;
  const todAmount = (bucket: string) => allRows.filter((proposal) => todBucket(proposal) === bucket).reduce((total, proposal) => total + (Number(proposal.calculated_discount_amount) || 0), 0);
  const todBucketsKey = todBuckets.join(",");
  useEffect(() => {
    if (scheme !== "tod") return;
    const valid = todBucketsKey.split(",");
    if (!valid.includes(statusFilter)) setStatusFilter(valid[0]);
  }, [scheme, statusFilter, todBucketsKey]);
  const matchesTodFilter = (proposal: Proposal) => todBucket(proposal) === statusFilter;
  const priority = (proposal: Proposal) => {
    if (["needs_review", "review_invalidated"].includes(proposal.status)) return 0;
    if (["eligible", "pending_approval"].includes(proposal.status)) return 1;
    if (proposal.achieved_tier_id) return 2;
    if (tonnes(proposal) > 0) return 3;
    return 4;
  };
  const rows = allRows.filter((proposal) => {
    const customer = proposal.customer_name ?? customerNames.get(proposal.customer_id) ?? "";
    const matchesQuery = !query.trim() || customer.toLowerCase().includes(query.trim().toLowerCase()) || proposal.entitlement_key?.toLowerCase().includes(query.trim().toLowerCase());
    const matchesFilter = scheme === "tod" ? matchesTodFilter(proposal) : statusFilter === "all" || proposal.status === statusFilter;
    return matchesQuery && matchesFilter;
  }).sort((left, right) => (scheme === "tod" && statusFilter === "close"
    // Closest to the first tier first.
    ? (Number(left.additional_tonnes_required ?? "0") || 0) - (Number(right.additional_tonnes_required ?? "0") || 0)
    : 0) || priority(left) - priority(right) || tonnes(right) - tonnes(left) || (left.customer_name ?? customerNames.get(left.customer_id) ?? "").localeCompare(right.customer_name ?? customerNames.get(right.customer_id) ?? ""));
  const title = scheme === "cd" ? "Cash Discount" : "Turnover Discount";
  const primaryAction = (proposal: Proposal) => {
    if (proposal.scheme_type === "cd") {
      const action = cashDiscountActionFrom(proposal);
      if (action === "debit_note") return "Review Debit Note recovery";
      if (action === "collect_balance") return "Collect remaining balance";
      if (action === "send_shortfall_reminder") return "Send payment reminder";
      if (action === "credit_note") return "Create Credit Note";
      if (action === "finance_review") return "Review difference";
    }
    if (proposal.status === "near_eligibility") return "Check shortfall reminder";
    if (proposal.status === "eligible") return "Create Credit Note";
    if (["needs_review", "review_invalidated"].includes(proposal.status)) return "Update from Tally";
    if (proposal.status === "created_verified") return "View verified Credit Note";
    if (proposal.status === "failed") return "Review issue";
    return "View details";
  };
  return <><WorkspacePageHeader eyebrow="" title={title} detail="" />
    {scheme === "tod" ? <div className="tod-overview" aria-label="Turnover Discount summary"><div className="tod-overview-meta"><div className="tod-period-context"><StatusBadge status={savingTod ? "saving" : selectedHistoryRun ? "historical" : "ready"} />{todPeriodOptions.length > 1 && !selectedHistoryRun
          ? <select className="tod-period-select" aria-label="Turnover Discount period" value={selectedTodPeriodKey ?? todPeriodOptions[0]} onChange={(event) => { setSelectedTodPeriodKey(event.target.value); setQuery(""); }}>{todPeriodOptions.map((key) => { const [start, end] = key.split(":"); return <option key={key} value={key}>{formatBusinessDate(start)} – {formatBusinessDate(end)} · {periodHasEnded(end) ? "ended" : "in progress"}</option>; })}</select>
          : <strong>{periodLabel}</strong>}<span className={periodEnded ? "is-ready" : ""}><CircleAlert size={13} />{savingTod ? "Checking fresh Tally data…" : selectedHistoryRun ? "Historical calculation snapshot" : periodKeys.size > 1 ? "Includes completed and active periods" : periodEnded ? "Period ended" : periodRow?.period_end ? `Projected until ${formatBusinessDate(periodRow.period_end)}` : "No period calculated yet"}</span></div><div className="tod-overview-actions"><span>{savingTod && calculationStartedAt ? `Started ${formatDate(calculationStartedAt)}` : lastChecked ? `Calculated ${formatDate(lastChecked)}` : "Not calculated yet"}</span><Button className="button-secondary" disabled={savingTod} onClick={() => { setSelectedHistoryRun(null); setHistoryTodRows(null); setNotice(null); setEvaluationOpen(true); }}><RefreshCw size={15} />{savingTod ? "Checking Tally…" : "Calculate period"}</Button><div className="segmented tod-inline-tabs" aria-label={`${title} views`}><button className={!showEvaluationQueue ? "selected" : ""} onClick={() => { setSelectedHistoryRun(null); setHistoryTodRows(null); setNotice(null); setShowEvaluationQueue(false); }}>Customers</button><button className={showEvaluationQueue ? "selected" : ""} onClick={() => setShowEvaluationQueue(true)}>Run history</button></div></div></div>{!showEvaluationQueue && allRows.length > 0 && <div className="cd-action-cards tod-action-cards" role="tablist" aria-label="Turnover Discount customers">{todBuckets.map((bucket) => {
      const count = todCount(bucket);
      const card = {
        ready: { label: "Ready to create", value: formatMoney(todAmount("ready")), detail: `${count} customer${count === 1 ? "" : "s"}` },
        created: { label: "Credit Note created", value: String(count), detail: "send from Credit Notes" },
        not_qualified: { label: "Not qualified", value: String(count), detail: "below the first tier" },
        qualified: { label: "Qualified so far", value: formatMoney(todAmount("qualified")), detail: `${count} customer${count === 1 ? "" : "s"} · projected` },
        close: { label: "Close to next tier", value: String(count), detail: "fewest MT needed first" },
        no_activity: { label: "No purchases", value: String(count), detail: "this period" },
        review: { label: "Needs review", value: String(count), detail: count ? "your decision" : "none" },
      }[bucket as "ready"]!;
      return <button key={bucket} type="button" role="tab" aria-selected={statusFilter === bucket} className={`cd-action-card${statusFilter === bucket ? " selected" : ""}${bucket === "review" && count ? " has-attention" : ""}${!count && statusFilter !== bucket ? " is-empty" : ""}`} onClick={() => { setStatusFilter(bucket); setQuery(""); }}><span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small></button>;
    })}</div>}</div> : <><div className="summary-bar"><span><StatusBadge status="ready" />Tally information</span><span><strong>{allRows.length}</strong> results</span><span><strong>{readyToFinalize}</strong> ready to finalize</span><span><strong>{reviewing}</strong> need review</span></div><div className="segmented evaluation-view-tabs" aria-label={`${title} views`}><button className={!showEvaluationQueue ? "selected" : ""} onClick={() => setShowEvaluationQueue(false)}>Customer results</button><button className={showEvaluationQueue ? "selected" : ""} onClick={() => setShowEvaluationQueue(true)}>Calculation history</button></div></>}
    {showEvaluationQueue && <GuidedEvaluationQueue scheme={scheme} latestRun={latestRun} onError={setError} onRetry={() => setEvaluationOpen(true)} onViewResults={(run, isLatest) => {
      // The newest completed calculation is the live result: open the normal
      // Customers view, where Credit Notes can be created, not a read-only copy.
      if (scheme === "tod" && isLatest && run.period_start && run.period_end) {
        const periodStart = run.period_start;
        const periodEnd = run.period_end;
        void (async () => {
          setNotice("Loading this period’s results…");
          try {
            const token = await accessToken();
            if (!token) return;
            // Load every saved result of this period and rule version (pages of 200 keep request URLs short).
            const loaded: Proposal[] = [];
            let cursor: string | null = null;
            for (let page = 0; page < 20; page += 1) {
              const params = new URLSearchParams({ schemeType: "tod", periodStart, periodEnd, limit: "200" });
              if (run.scheme_version_id) params.set("schemeVersionId", run.scheme_version_id);
              if (cursor) params.set("cursor", cursor);
              const response: { proposals: Proposal[]; nextCursor: string | null; hasMore: boolean } = await apiRequest(token, `/api/companies/${company.id}/evaluations/proposals?${params}`, { cache: "no-store" });
              loaded.push(...response.proposals.filter((proposal) => proposal.status !== "not_in_scheme"));
              if (!response.hasMore || !response.nextCursor) break;
              cursor = response.nextCursor;
            }
            if (!loaded.length) { openSnapshot(run); return; }
            const isCurrentRule = !localTodBootstrap || !run.scheme_version_id || run.scheme_version_id === localTodBootstrap.activeSchemeVersionId;
            setSelectedTodPeriodKey(`${periodStart}:${periodEnd}`);
            setStatusFilter("all");
            setQuery("");
            setShowEvaluationQueue(false);
            if (isCurrentRule) {
              // Live view: Credit Notes can be created from here.
              setPeriodRows(loaded);
              setSelectedHistoryRun(null);
              setHistoryTodRows(null);
              setNotice(null);
            } else {
              // Calculated under an earlier rule version: read-only.
              setHistoryTodRows(loaded);
              setSelectedHistoryRun(run);
              setNotice(`${formatBusinessDate(periodStart)} – ${formatBusinessDate(periodEnd)} was calculated under an earlier rule version. Showing it read-only.`);
            }
          } catch (cause) { setError(userFacingError(cause, "Could not load this period’s results.")); }
        })();
        return;
      }
      if (scheme === "tod" && run.period_start && run.period_end) {
        openSnapshot(run);
        return;
      }
      setShowEvaluationQueue(false);
    }} onSettled={async (run) => {
      await refresh();
      setLatestRun(null);
      if (run.status === "completed") {
        setNotice("Tally calculation completed. Customer results are ready.");
        setShowEvaluationQueue(false);
      }
    }} />}
    {scheme === "tod" && isAdministrator && periodEnded && statusFilter === "ready" && !showEvaluationQueue && !selectedHistoryRun && <PostingSwitch show="off" launchControl={data.launchControl} onChanged={async (message) => { setNotice(message); await refresh(); }} onError={setError} />}
    <div hidden={showEvaluationQueue}>
    {scheme === "tod" && <TodResults scaleByRule={todScaleByRule} reference={data.reference} rows={rows} allRows={allRows} query={query} setQuery={setQuery} filter={statusFilter} setFilter={setStatusFilter} customerNames={customerNames} tierById={todTierById} historical={Boolean(selectedHistoryRun)} defaultFilter={todBuckets[0]} onChanged={refresh} postingEnabled={data.launchControl?.mode === "posting_enabled"} onOpen={(proposal) => {
      if (proposal.id.startsWith("local:")) setNotice("This current Tally result is being added to the audit history. Details will be available shortly.");
      else setSelected(proposal);
    }} />}
    <div hidden={scheme === "tod"}>
    <Card><div className="card-title"><div><p className="eyebrow">Results</p><h2>{title} history</h2><p className="muted-copy">Filter results, then open one to see the calculation and the next step.</p></div><span className="table-count">{rows.length} shown</span></div><div className="queue-toolbar"><label className="queue-search"><span>Find customer or reference</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer" /></label><div className="segmented" aria-label={`${title} status filters`}><button className={statusFilter === "all" ? "selected" : ""} onClick={() => setStatusFilter("all")}>All</button>{statuses.map((status) => <button key={status} className={statusFilter === status ? "selected" : ""} onClick={() => setStatusFilter(status)}>{staffStatusLabel(status)}</button>)}</div></div>{rows.length ? <div className="data-table proposal-table"><div className="table-head"><span>Customer</span><span>Result</span><span>Last checked</span><span>Next step</span></div>{rows.map((proposal) => <article key={proposal.id}><div><strong>{customerNames.get(proposal.customer_id) ?? "Customer record"}</strong><small>{proposal.period_start && proposal.period_end ? `${proposal.period_start} to ${proposal.period_end}` : proposal.eligibility_deadline ? `Payment deadline ${proposal.eligibility_deadline}` : "Sales invoice result"}</small></div><div><strong>{formatMoney(proposal.calculated_discount_amount)}</strong><small>{scheme === "tod" ? `${formatTonnes(proposal.eligible_tonnes)} MT eligible${proposal.additional_tonnes_required ? ` · ${formatTonnes(proposal.additional_tonnes_required)} MT to next slab` : ""}` : proposal.shortfall_amount ? `Paid ${formatMoney(proposal.amount_paid_by_deadline)} · shortfall ${formatMoney(proposal.shortfall_amount)}` : "Calculated amount"}</small></div><div><StatusBadge status={proposal.status} /><small>{proposal.latestEvaluation?.freshForApproval ? "Up to date and ready to create" : proposal.latest_evaluated_at ? `Checked ${formatDate(proposal.latest_evaluated_at)}` : "Not checked yet"}</small></div><div className="queue-next"><small>{primaryAction(proposal)}</small><Button className="button-quiet" onClick={() => setSelected(proposal)}><Eye size={15} />Open</Button></div></article>)}</div> : <EmptyState title={allRows.length ? "No results match this view" : `No ${title} results yet`} detail={allRows.length ? "Clear or change the status filters to see every result." : `Start a ${scheme === "cd" ? "Sales invoice" : "customer period"} evaluation after Tally information is updated.`} action={allRows.length ? <Button className="button-secondary" onClick={() => { setQuery(""); setStatusFilter("all"); }}>Clear filters</Button> : <Button onClick={() => setEvaluationOpen(true)}>Start evaluation</Button>} />}</Card>
    </div>
    </div>
    <GuidedEvaluationDrawer open={evaluationOpen} onClose={() => setEvaluationOpen(false)} scheme={scheme} onComplete={async (message, run) => { setLatestRun(run); setShowEvaluationQueue(true); setNotice(message); setEvaluationOpen(false); await refresh(); }} onError={setError} onTurnoverDiscountSubmit={scheme === "tod" ? runLocalTodCalculation : undefined} onTurnoverDiscountBatchSubmit={scheme === "tod" ? runAllDueTodCalculations : undefined} turnoverPeriods={scheme === "tod" ? turnoverPeriods : undefined} />
    <ProposalDrawer proposal={selected} onClose={() => setSelected(null)} onChanged={refresh} onError={setError} customerName={selected ? selected.customer_name ?? customerNames.get(selected.customer_id) : undefined} launchMode={data.launchControl?.mode} />
  </>;
}

type TodPaymentCheckRow = {
  tallyGuid: string; voucherNumber: string | null; invoiceDate: string; invoiceAmount: string; dueDays: number;
  nominalDueDate: string; dueDate: string; shiftedFor: Array<{ date: string; reason: "holiday" | "non_working_day" }>;
  paidInFullOn: string | null; daysTaken: number | null; paidTotal: string; tonnes: string; counted: boolean;
  reason: "paid_in_full_on_time" | "paid_after_due_date" | "partly_paid" | "not_paid";
};
/** One status chip per TOD row; rank orders the "Status" sort (most urgent first). */
function todRowState(proposal: Proposal): { label: string; tone: "ready" | "done" | "active" | "warn" | "track" | "idle"; rank: number; hint?: string } {
  const posting = proposal.creditNotePosting;
  if (posting?.status === "created_verified") return { label: `CN ${posting.verified_voucher_number ?? "created"}`, tone: "done", rank: 5, hint: "Credit Note created and verified in Tally" };
  if (posting && ["failed", "correction_required", "reconciliation_required"].includes(posting.status)) return { label: "CN needs review", tone: "warn", rank: 0 };
  if (posting) return { label: "Creating CN…", tone: "active", rank: 2 };
  if (["needs_review", "review_invalidated", "pending_approval"].includes(proposal.status)) return { label: "Needs review", tone: "warn", rank: 0 };
  const ended = periodHasEnded(proposal.period_end);
  if (proposal.achieved_tier_id) return ended ? { label: "Ready", tone: "ready", rank: 1, hint: "Ready for a Credit Note" } : { label: "Qualified", tone: "track", rank: 3, hint: `Credit Note after ${formatBusinessDate(proposal.period_end)}` };
  return (Number(proposal.eligible_tonnes) || 0) > 0 ? { label: ended ? "Not qualified" : "Tracking", tone: "idle", rank: 4 } : { label: "No activity", tone: "idle", rank: 6 };
}

type TodSlabScale = Array<{ minimumTonnes: number; label: string }>;

/**
 * One continuous MT scale with a tick at each slab threshold. The scale is fixed
 * per rule (0 → 15% past the top slab) so ticks line up on every row. Top-slab
 * customers show a complete bar; beyond the scale end a ▸ cap marks the overflow.
 */
function TodSlabBar({ tonnes, scale, customerName }: { tonnes: number; scale: TodSlabScale; customerName: string }) {
  const top = scale.at(-1)?.minimumTonnes ?? 0;
  if (!scale.length || top <= 0) return null;
  const max = top * 1.15;
  const position = (value: number) => `${Math.min(100, Math.max(0, (value / max) * 100))}%`;
  const reached = scale.filter((slab) => tonnes >= slab.minimumTonnes).length;
  const onTopSlab = tonnes >= top;
  const beyondScale = tonnes > max;
  return <span className={`tod-slab-bar${onTopSlab ? " is-top" : ""}`} role="img" aria-label={`${customerName}: ${formatTonnes(tonnes)} MT; ${onTopSlab ? "top slab reached" : `${reached} of ${scale.length} slabs reached`}`}>
    <span className="tod-slab-bar-fill" style={{ width: onTopSlab ? "100%" : position(tonnes) }} />
    {onTopSlab && <span className="tod-slab-bar-top" style={{ left: position(top) }} />}
    {scale.map((slab) => <span key={slab.minimumTonnes} className={`tod-slab-bar-tick${tonnes >= slab.minimumTonnes ? " is-reached" : ""}`} style={{ left: position(slab.minimumTonnes) }} title={`${slab.label} from ${formatTonnes(slab.minimumTonnes)} MT`} />)}
    {beyondScale && <span className="tod-slab-bar-cap" title={`${formatTonnes(tonnes)} MT, beyond the scale`} aria-hidden="true" />}
  </span>;
}

type GroupRule = { id: string; schemeType: "cd" | "tod"; name: string; versionNumber: number; discountPercentage: string | null; allowedWorkingDays: number | null; customerGroupIds: string[] };

function TodResults({ scaleByRule, reference, rows: filteredRows, allRows, query, setQuery, filter, setFilter, customerNames, tierById, historical, defaultFilter, onOpen, onChanged, postingEnabled }: {
  scaleByRule: Map<string, TodSlabScale>;
  reference: ReferenceData | null | undefined;
  onChanged: () => Promise<void>;
  postingEnabled: boolean;
  rows: Proposal[];
  allRows: Proposal[];
  query: string;
  setQuery: (value: string) => void;
  filter: string;
  setFilter: (value: string) => void;
  customerNames: Map<string, string>;
  tierById: Map<string, { minimumTonnes: number; amountPerTonne: number | null; percentage: number | null; index: number; count: number }>;
  historical: boolean;
  /** The first card for the selected period's stage; used by "Clear filters". */
  defaultFilter: string;
  onOpen: (proposal: Proposal) => void;
}) {
  const { company } = useCompany();
  const pageSize = 20;
  const [page, setPage] = useState(1);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Customer groups come first: pick a group, then see its customers.
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  useEffect(() => { setGroupFilter(null); }, [company.id, historical]);
  const [groupRules, setGroupRules] = useState<GroupRule[]>([]);
  // Until the rules arrive the cards show placeholders, not "No active rule".
  const [groupRulesLoaded, setGroupRulesLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setGroupRulesLoaded(false);
    void (async () => {
      const token = await accessToken(); if (!token) return;
      try {
        const response = await apiRequest<{ rules: GroupRule[] }>(token, `/api/companies/${company.id}/evaluations/rules-by-group`, { cache: "no-store" });
        if (!cancelled) setGroupRules(response.rules);
      } catch { if (!cancelled) setGroupRules([]); }
      finally { if (!cancelled) setGroupRulesLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [company.id]);
  const groupsById = new Map((reference?.masters.customerGroups ?? []).map((group) => [group.id, group]));
  const customerGroupId = new Map((reference?.masters.customers ?? []).map((customer) => [customer.id, customer.current_customer_group_id ?? null]));
  const groupOf = (proposal: Proposal) => customerGroupId.get(proposal.customer_id) ?? "none";
  // A rule covers a group when it selects that group or one of its parents.
  const rulesFor = (groupId: string) => {
    const lineage = new Set<string>();
    for (let current: string | null | undefined = groupId, guard = 0; current && guard < 20; current = groupsById.get(current)?.parent_group_id, guard += 1) lineage.add(current);
    return groupRules.filter((rule) => rule.customerGroupIds.some((id) => lineage.has(id)));
  };
  // Each card describes the selected tab: "<tab> x / y" = this tab's customers
  // out of all the group's customers in the period; MT and ₹ cover the tab's
  // customers only. Groups with nobody in the tab are not listed.
  const groupTotals = allRows.reduce((totals, proposal) => totals.set(groupOf(proposal), (totals.get(groupOf(proposal)) ?? 0) + 1), new Map<string, number>());
  const groupSummaries = [...filteredRows.reduce((groups, proposal) => {
    const id = groupOf(proposal);
    const current = groups.get(id) ?? { id, name: id === "none" ? "No customer group" : groupsById.get(id) ? labelFor(groupsById.get(id)!) : "Customer group", customers: 0, total: groupTotals.get(id) ?? 0, tonnes: 0, discount: 0 };
    current.customers += 1;
    current.tonnes += Number(proposal.eligible_tonnes ?? "0") || 0;
    current.discount += Number(proposal.calculated_discount_amount ?? "0") || 0;
    groups.set(id, current);
    return groups;
  }, new Map<string, { id: string; name: string; customers: number; total: number; tonnes: number; discount: number }>()).values()]
    .sort((left, right) => right.discount - left.discount || right.tonnes - left.tonnes || left.name.localeCompare(right.name));
  const tabCopy: Record<string, { count: string; amount: string | null }> = {
    ready: { count: "Ready", amount: "Ready to create" },
    created: { count: "Created", amount: "Credit Notes created" },
    review: { count: "Needs review", amount: "At stake" },
    not_qualified: { count: "Not qualified", amount: null },
    qualified: { count: "Qualified", amount: "Projected discount" },
    close: { count: "Close to next slab", amount: "Projected discount" },
    no_activity: { count: "No activity", amount: null },
  };
  const cardCopy = tabCopy[filter] ?? { count: "Customers", amount: "Projected discount" };
  const rows = groupFilter ? filteredRows.filter((proposal) => groupOf(proposal) === groupFilter) : filteredRows;
  // Cards only until a group is opened; a customer search jumps straight to the table.
  const showCards = !groupFilter && !query.trim() && groupSummaries.length > 0;
  const openGroup = groupFilter ? groupSummaries.find((group) => group.id === groupFilter) : null;
  const ruleLabel = (rule: GroupRule) => rule.schemeType === "cd" ? `${rule.name} · ${Number(rule.discountPercentage ?? 0)}% · ${rule.allowedWorkingDays ?? "—"} days` : rule.name;
  const readyRows = historical ? [] : allRows.filter((proposal) => proposal.status === "eligible" && !proposal.creditNotePosting && !proposal.id.startsWith("local:") && periodHasEnded(proposal.period_end));
  const bulkReady = readyRows.filter((proposal) => selectedIds.includes(proposal.id)).slice(0, 25);
  useEffect(() => { setSelectedIds([]); setConfirmOpen(false); }, [company.id, historical, filter, query, groupFilter]);
  const createReadyCreditNotes = async () => {
    if (!bulkReady.length || bulkCreating) return;
    setBulkCreating(true); setBulkMessage(null);
    try {
      const result = await verifyAndCreateCreditNotes(company.id, bulkReady.map((proposal) => proposal.id), setBulkMessage, bulkReady.filter((proposal) => proposal.latestEvaluation?.freshForApproval).map((proposal) => proposal.id));
      setBulkMessage(result.message);
      setSelectedIds([]);
      await onChanged();
    } catch (cause) { setBulkMessage(userFacingError(cause, "Could not create the selected Credit Notes.")); }
    finally { setBulkCreating(false); }
  };
  // Header click cycles: ascending → descending → no sort (original order).
  type TodSortKey = "customer" | "slab" | "tonnes" | "invoices" | "discount" | "status";
  const [sort, setSort] = useState<{ key: TodSortKey; direction: "asc" | "desc" } | null>(null);
  const cycleSort = (key: TodSortKey) => setSort((current) => current?.key !== key ? { key, direction: "asc" } : current.direction === "asc" ? { key, direction: "desc" } : null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => { setPage(1); setExpandedId(null); }, [filter, query, groupFilter, sort]);
  const nameOf = (proposal: Proposal) => proposal.customer_name ?? customerNames.get(proposal.customer_id) ?? "Customer record";
  const sortValue = (proposal: Proposal, key: TodSortKey): number | string => {
    if (key === "customer") return nameOf(proposal).toLowerCase();
    // Slabs are sequential: order by the slab's minimum tonnes; below the first slab sorts lowest.
    if (key === "slab") return proposal.achieved_tier_id ? tierById.get(proposal.achieved_tier_id)?.minimumTonnes ?? 0 : -1;
    if (key === "tonnes") return Number(proposal.eligible_tonnes) || 0;
    if (key === "invoices") return proposal.paymentSummary?.total ? proposal.paymentSummary.counted / proposal.paymentSummary.total : -1;
    if (key === "status") return todRowState(proposal).rank;
    return Number(proposal.calculated_discount_amount) || 0;
  };
  const sortedRows = !sort ? rows : [...rows].sort((left, right) => {
    const a = sortValue(left, sort.key);
    const b = sortValue(right, sort.key);
    const order = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
    return (sort.direction === "asc" ? order : -order) || nameOf(left).localeCompare(nameOf(right));
  });
  const tierList = [...tierById.values()];
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = sortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const visibleReady = visibleRows.filter((row) => readyRows.some((ready) => ready.id === row.id));
  const allVisibleSelected = visibleReady.length > 0 && visibleReady.slice(0, 25).every((row) => selectedIds.includes(row.id));
  const showSelection = !showCards && !historical && filter === "ready" && readyRows.length > 0;
  // The Invoices column appears only once some row has a 25-day payment check.
  const anyPayment = rows.some((proposal) => proposal.paymentSummary);
  // When every row has the same status (e.g. the Ready tab), the chip adds nothing.
  const firstState = rows.length ? todRowState(rows[0]).label : null;
  const uniformState = rows.length > 1 && rows.every((proposal) => todRowState(proposal).label === firstState);
  const isCloseToNext = (proposal: Proposal) => {
    const remaining = Number(proposal.additional_tonnes_required ?? "0") || 0;
    const next = Number(proposal.next_tier_tonnes ?? "0") || 0;
    return !periodHasEnded(proposal.period_end) && remaining > 0 && next > 0 && remaining <= next * 0.1;
  };
  const tableTotals = {
    discount: rows.reduce((total, proposal) => total + (Number(proposal.calculated_discount_amount) || 0), 0),
    ready: rows.filter((proposal) => readyRows.some((ready) => ready.id === proposal.id)).length,
    close: rows.filter(isCloseToNext).length,
  };
  const bulkTotal = bulkReady.reduce((total, row) => total + Number(row.calculated_discount_amount || 0), 0);
  const sortHeader = (key: TodSortKey, label: string) => {
    const direction = sort?.key === key ? sort.direction : null;
    return <button type="button" className={`tod-sort${direction ? " is-active" : ""}`} aria-label={`Sort by ${label}${direction === "asc" ? ", ascending" : direction === "desc" ? ", descending" : ""}`} title={direction === "asc" ? "Click for descending" : direction === "desc" ? "Click to clear sorting" : "Click to sort ascending"} onClick={() => cycleSort(key)}>
      {label}{direction === "asc" ? <ChevronUp size={11} aria-hidden="true" /> : direction === "desc" ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronsUpDown size={11} className="tod-sort-idle" aria-hidden="true" />}
    </button>;
  };
  // One header row: back + group summary on the left, search on the right.
  // Selection lives in the table header; the bulk action is a sticky bar.
  // Group cards sit directly on the page; the table keeps its card.
  return <Card className={`tod-results-card${showCards ? " is-plain" : ""}`}>
    <div className="tod-results-bar">
      {showCards
        ? <h2>Customer groups <span>{groupSummaries.length}</span></h2>
        : <div className="tod-table-title">
          {groupFilter && <button type="button" className="tod-group-back" onClick={() => setGroupFilter(null)} aria-label="Back to customer groups"><ChevronLeft size={16} />Groups</button>}
          <h2>{openGroup?.name ?? "Customer results"}</h2>
          <p className="tod-table-summary"><span>{rows.length} customer{rows.length === 1 ? "" : "s"}</span><span><strong>{formatMoney(tableTotals.discount)}</strong></span>{tableTotals.ready > 0 && <span>{tableTotals.ready} ready</span>}{tableTotals.close > 0 && <span className="is-close">{tableTotals.close} close to next slab</span>}</p>
        </div>}
      <label className="tod-results-search"><span className="sr-only">Find customer</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer" /></label>
    </div>
    {showCards && <div className="tod-group-strip" role="list" aria-label="Customer groups">
      {groupSummaries.map((group) => {
        const rules = group.id === "none" ? [] : rulesFor(group.id);
        const todRules = rules.filter((rule) => rule.schemeType === "tod");
        const share = group.total ? Math.round((group.customers / group.total) * 100) : 0;
        return <button type="button" role="listitem" className={`tod-group-card tod-group-card-${filter}`} key={group.id} onClick={() => setGroupFilter(group.id)} aria-label={`Open ${group.name}: ${group.customers} of ${group.total} customers ${cardCopy.count.toLowerCase()}`}>
          <span className="tod-group-card-head">
            <span className="tod-group-avatar" aria-hidden="true">{group.name.trim().charAt(0).toUpperCase() || "G"}</span>
            <span className="tod-group-title"><strong title={group.name}>{group.name}</strong><small>{group.total} customer{group.total === 1 ? "" : "s"} in period</small></span>
            <ChevronRight className="tod-group-chevron" size={18} aria-hidden="true" />
          </span>
          {cardCopy.amount
            ? <span className="tod-group-amount"><small>{cardCopy.amount}</small><strong>{formatMoney(group.discount)}</strong></span>
            : <span className="tod-group-amount"><small>MT counted</small><strong>{formatTonnes(group.tonnes)} MT</strong></span>}
          <span className="tod-group-stats">
            <span><small>{cardCopy.count}</small><strong>{group.customers}<em> / {group.total}</em></strong></span>
            {cardCopy.amount ? <span><small>MT counted</small><strong>{formatTonnes(group.tonnes)} MT</strong></span> : <span><small>Avg per customer</small><strong>{formatTonnes(group.customers ? group.tonnes / group.customers : 0)} MT</strong></span>}
          </span>
          <span className="tod-group-meter" role="presentation" title={`${share}% of the group`}><span style={{ width: `${share}%` }} /></span>
          {!groupRulesLoaded ? <span className="tod-group-rules" aria-hidden="true"><DrawerLoadingBlock className="sk sk-rule" /></span> : <span className="tod-group-rules">
            <span><em className="is-tod">TOD</em><span title={todRules.map(ruleLabel).join(", ")}>{todRules.length ? todRules.map(ruleLabel).join(", ") : <i>No active rule</i>}</span></span>
          </span>}
        </button>;
      })}
    </div>}
    <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title={`Create ${bulkReady.length} Credit Notes?`} description="Review the selected customers before queuing anything for Tally."><div className="cd-bulk-confirm"><strong>{formatMoney(bulkReady.reduce((total, row) => total + Number(row.calculated_discount_amount || 0), 0))} total</strong><div className="cd-bulk-confirm-list">{bulkReady.map((row) => <div key={row.id}><span>{row.customer_name ?? customerNames.get(row.customer_id)} · {formatBusinessDate(row.period_end)}</span><strong>{formatMoney(row.calculated_discount_amount)}</strong></div>)}</div><p>Each customer is checked against Tally first, then created. Keep Tally open — this takes about a minute per few customers. No WhatsApp is sent; send it from Credit Notes when you are ready.</p><div className="dialog-actions"><Button className="button-secondary" onClick={() => setConfirmOpen(false)}>Back</Button><Button disabled={bulkCreating || !bulkReady.length} onClick={() => { setConfirmOpen(false); void createReadyCreditNotes(); }}>Confirm and create</Button></div></div></Dialog>
    {bulkMessage && <InlineMessage tone="info">{bulkMessage}</InlineMessage>}
    {!showCards && rows.length > 0 && !anyPayment && !historical && <p className="tod-payment-note"><CircleAlert size={14} aria-hidden="true" />The 25-day payment check hasn’t run for this period yet. Run <strong>Calculate period</strong> to count only invoices paid in full on time.</p>}
    {showCards ? null : rows.length ? <>
    <div className={`data-table tod-results-table tod-rows${anyPayment ? "" : " no-payment"}`}><div className="table-head">
      <span className="tod-head-customer">{showSelection && <input type="checkbox" aria-label="Select all ready customers on this page (up to 25)" title="Select up to 25 on this page" disabled={bulkCreating || !visibleReady.length} checked={allVisibleSelected} onChange={(event) => setSelectedIds(event.target.checked ? visibleReady.map((row) => row.id).slice(0, 25) : [])} />}{sortHeader("customer", "Customer")}</span>
      <span>{sortHeader("slab", "Slab")}</span>
      <span>{sortHeader("tonnes", "MT counted")}</span>
      {anyPayment && <span>{sortHeader("invoices", "Invoices · 25-day check")}</span>}
      <span>{sortHeader("discount", "Discount")}</span>
      <span className="tod-head-status">{uniformState ? "" : sortHeader("status", "Status")}</span>
    </div>{visibleRows.map((proposal) => {
      const currentTonnes = Number(proposal.eligible_tonnes ?? "0") || 0;
      const remainingTonnes = Number(proposal.additional_tonnes_required ?? "0") || 0;
      const targetTonnes = remainingTonnes > 0 ? currentTonnes + remainingTonnes : Math.max(currentTonnes, 1);
      const progress = Math.min(100, Math.round((currentTonnes / targetTonnes) * 100));
      const customerName = nameOf(proposal);
      const tier = proposal.achieved_tier_id ? tierById.get(proposal.achieved_tier_id) : null;
      const inferredRate = currentTonnes > 0 ? Number(proposal.calculated_discount_amount) / currentTonnes : 0;
      const rateLabel = (item: { amountPerTonne: number | null; percentage: number | null } | null | undefined) => item?.amountPerTonne != null ? `₹${formatTonnes(item.amountPerTonne)}/MT` : item?.percentage != null ? `${formatTonnes(item.percentage)}%` : null;
      const tierValue = rateLabel(tier) ?? (inferredRate > 0 ? `₹${formatTonnes(inferredRate)}/MT` : "Qualified");
      const tierPosition = tier && tier.count > 1 ? tier.index / (tier.count - 1) : 0;
      const tierTone = proposal.achieved_tier_id ? (tierPosition >= 0.75 ? "top" : tierPosition >= 0.35 ? "middle" : "entry") : "none";
      const nextTier = proposal.next_tier_tonnes ? tierList.find((item) => item.minimumTonnes === Number(proposal.next_tier_tonnes)) : null;
      const nextLabel = remainingTonnes > 0 ? `${formatTonnes(remainingTonnes)} MT to ${rateLabel(nextTier) ?? "next slab"}` : currentTonnes > 0 && proposal.achieved_tier_id ? "Top slab" : null;
      const usesPercentage = tier?.percentage != null;
      const formula = !proposal.achieved_tier_id ? null : usesPercentage ? `${formatMoney(proposal.eligible_product_taxable_value)} × ${formatTonnes(tier!.percentage!)}%` : `${formatTonnes(currentTonnes)} MT × ${tierValue}`;
      const payment = proposal.paymentSummary;
      const excludedCount = payment ? payment.total - payment.counted : 0;
      const state = todRowState(proposal);
      const isReady = readyRows.some((ready) => ready.id === proposal.id);
      const savingDetails = proposal.id.startsWith("local:");
      const expanded = expandedId === proposal.id;
      const open = () => { if (!historical && !savingDetails) onOpen(proposal); };
      return <article key={proposal.id} className={`tod-row tod-tier-${tierTone}${expanded ? " is-expanded" : ""}${historical ? "" : " is-clickable"}`} onClick={open}>
        <div className="tod-row-customer">
          {!historical && <input type="checkbox" aria-label={`Select ${customerName}`} onClick={(event) => event.stopPropagation()} disabled={bulkCreating || !isReady || (!selectedIds.includes(proposal.id) && selectedIds.length >= 25)} checked={selectedIds.includes(proposal.id)} onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, proposal.id] : ids.filter((id) => id !== proposal.id))} />}
          <strong title={customerName}>{customerName}</strong>
        </div>
        <div className="tod-row-slab"><span className={`tod-tier-badge tod-tier-badge-${tierTone}`} title={tier?.minimumTonnes ? `Slab from ${formatTonnes(tier.minimumTonnes)} MT` : undefined}>{proposal.achieved_tier_id ? tierValue : currentTonnes > 0 ? "Below slab" : "No purchases"}</span></div>
        <div className="tod-row-tonnes"><strong>{formatTonnes(currentTonnes)} MT</strong>{scaleByRule.get(proposal.scheme_version_id ?? "")?.length ? <TodSlabBar tonnes={currentTonnes} scale={scaleByRule.get(proposal.scheme_version_id ?? "")!} customerName={customerName} /> : currentTonnes > 0 && <span className="tod-progress-track" role="progressbar" aria-label={`${formatTonnes(currentTonnes)} of ${formatTonnes(targetTonnes)} MT`} aria-valuemin={0} aria-valuemax={targetTonnes} aria-valuenow={currentTonnes}><span style={{ width: `${progress}%` }} /></span>}{nextLabel && <small>{isCloseToNext(proposal) && <b className="tod-close-tag">Close</b>}{nextLabel}</small>}</div>
        {anyPayment && <div className="tod-row-invoices">{payment ? <>
          <strong>{payment.counted}<em> / {payment.total}</em> counted</strong>
          {excludedCount > 0
            ? <button type="button" className="tod-row-excluded" aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); setExpandedId(expanded ? null : proposal.id); }}><ChevronRight size={12} className="tod-row-caret" />{[payment.late && `${payment.late} late`, payment.partlyPaid && `${payment.partlyPaid} part-paid`, payment.unpaid && `${payment.unpaid} unpaid`].filter(Boolean).join(" · ")} · {formatTonnes(payment.excludedTonnes)} MT out</button>
            : <small className="tod-row-allpaid">All paid on time</small>}
        </> : <small className="tod-row-muted">{savingDetails ? "Saving…" : "Not checked"}</small>}</div>}
        <div className="tod-row-amount"><strong>{formatMoney(proposal.calculated_discount_amount)}</strong>{formula && <small className="tod-row-formula">{formula}</small>}</div>
        <div className="tod-row-status">
          {!uniformState && <span className={`tod-state tod-state-${state.tone}`} title={state.hint}>{state.label}</span>}
          {historical ? <small>History</small> : isReady ? <button type="button" className="tod-row-cta" disabled={savingDetails} onClick={(event) => { event.stopPropagation(); open(); }}>Review<ChevronRight size={14} /></button> : <button type="button" className="tod-row-open" disabled={savingDetails} aria-label={`Open ${customerName}`} onClick={(event) => { event.stopPropagation(); open(); }}><ChevronRight size={16} /></button>}
        </div>
        {expanded && payment && <div className="tod-row-detail" onClick={(event) => event.stopPropagation()}>
          <p>Not counted: paid in full after the due date, or not fully paid.</p>
          <ul>{payment.excluded.map((item, index) => <li key={`${item.voucherNumber}-${index}`}>
            <strong>{item.voucherNumber ?? "Invoice"}</strong>
            <span>{formatBusinessDate(item.invoiceDate)} · due {formatBusinessDate(item.dueDate)}</span>
            <span>{item.reason === "paid_after_due_date" ? `Paid ${formatBusinessDate(item.paidInFullOn)} · ${item.daysTaken} days` : `Paid ${formatMoney(item.paidTotal)} of ${formatMoney(item.invoiceAmount)}`}</span>
            <span className="tod-row-detail-t">{formatTonnes(item.tonnes)} MT</span>
          </li>)}</ul>
        </div>}
      </article>;
    })}</div>
    {bulkReady.length > 0 && <div className="tod-bulk-bar" role="region" aria-label="Selected customers">
      <span><strong>{bulkReady.length} selected</strong> · {formatMoney(bulkTotal)}</span>
      <div><button type="button" className="tod-selection-clear" disabled={bulkCreating} onClick={() => setSelectedIds([])}>Clear</button><Button disabled={bulkCreating || !postingEnabled} title={postingEnabled ? "Each one is checked against Tally before it is created" : "Turn on Credit Note creation first"} onClick={() => setConfirmOpen(true)}>{bulkCreating ? "Working…" : `Create ${bulkReady.length} Credit Note${bulkReady.length === 1 ? "" : "s"}`}</Button></div>
    </div>}
    {pageCount > 1 && <nav className="table-pagination" aria-label="Customer result pages"><span>Page {currentPage} of {pageCount} · {rows.length} results</span><div><Button className="button-secondary" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button>{Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => <button key={number} className={number === currentPage ? "selected" : ""} aria-current={number === currentPage ? "page" : undefined} onClick={() => setPage(number)}>{number}</button>)}<Button className="button-secondary" disabled={currentPage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Next</Button></div></nav>}</> : <EmptyState title={allRows.length ? "No customers match this view" : "No Turnover Discount results yet"} detail={allRows.length ? "Choose another filter or clear the customer search." : "Start a customer-period calculation after Tally information is ready."} action={allRows.length ? <Button className="button-secondary" onClick={() => { setQuery(""); setFilter(defaultFilter); }}>Clear filters</Button> : undefined} />}
  </Card>;
}


function DrawerLoadingBlock({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`workspace-loading-block ${className}`} />;
}


function TurnoverResultDrawerLoading() {
  // Mirrors the loaded panel: compact top card (amount | calculation, status line, period + checked | Verify),
  // the slab strip, then the three links (Tally evidence, Payment check, Audit).
  return <div className="drawer-stack tod-customer-drawer tod-drawer-loading" aria-label="Loading customer result">
    <div className="tod-hero">
      <div className="tod-hero-main"><div><DrawerLoadingBlock className="sk sk-label" /><DrawerLoadingBlock className="sk sk-amount" /></div><DrawerLoadingBlock className="sk sk-formula" /></div>
      <div className="tod-hero-note"><DrawerLoadingBlock className="sk sk-status" /><DrawerLoadingBlock className="sk sk-button" /></div>
      <div className="tod-hero-foot"><div><DrawerLoadingBlock className="sk sk-period" /><DrawerLoadingBlock className="sk sk-checked" /></div><DrawerLoadingBlock className="sk sk-verify" /></div>
    </div>
    <div className="tod-loading-section"><DrawerLoadingBlock className="sk sk-label" /><div className="tod-loading-slabs">{Array.from({ length: 3 }, (_, index) => <DrawerLoadingBlock key={index} className="tod-loading-slab" />)}</div></div>
    <div className="tod-loading-destinations">{Array.from({ length: 3 }, (_, index) => <div key={index}><div><DrawerLoadingBlock className="sk sk-link" /><DrawerLoadingBlock className="sk sk-link-sub" /></div><DrawerLoadingBlock className="tod-loading-arrow" /></div>)}</div>
  </div>;
}

function ProposalDrawer({ proposal, onClose, onChanged, onError, customerName, launchMode }: { proposal: Proposal | null; onClose: () => void; onChanged: () => Promise<void>; onError: (value: string | null) => void; customerName?: string; launchMode?: "review_only" | "posting_enabled" }) {
  const { company, isAdministrator } = useCompany();
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshRun, setRefreshRun] = useState<EvaluationRun | null>(null);
  const [refreshCompleted, setRefreshCompleted] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [noteReconciliationRunId, setNoteReconciliationRunId] = useState<string | null>(null);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // Create Credit Note checks Tally first when the evidence is stale, then
  // opens the confirm dialog on its own once the check completes.
  const [createAfterRefresh, setCreateAfterRefresh] = useState(false);
  const [drawerView, setDrawerView] = useState<"summary" | "evidence" | "payments" | "audit">("summary");
  const refreshRunId = refreshRun?.id;
  const refreshRunStatus = refreshRun?.status;
  const loadDetail = useCallback(async () => {
    if (!proposal) return;
    const token = await accessToken(); if (!token) return;
    setLoading(true);
    try { setDetail(await apiRequest<ProposalDetail>(token, `/api/companies/${company.id}/evaluations/proposals/${proposal.id}`)); }
    catch (cause) { onError(userFacingError(cause, "Could not open the result details.")); }
    finally { setLoading(false); }
  }, [company.id, onError, proposal]);
  useEffect(() => { setDetail(null); setReason(""); void loadDetail(); }, [loadDetail]);
  // While Tally is creating/verifying the Credit Note, re-read the status so
  // the drawer moves from "Queued" to the verified number without a reload.
  const postingStatus = detail?.creditNotePosting?.status;
  useEffect(() => {
    if (!postingStatus || ["created_verified", "failed", "correction_required", "reconciliation_required", "cancelled"].includes(postingStatus)) return;
    const interval = window.setInterval(() => {
      void (async () => {
        const token = await accessToken(); if (!token || !proposal) return;
        try {
          const next = await apiRequest<ProposalDetail>(token, `/api/companies/${company.id}/evaluations/proposals/${proposal.id}`, { cache: "no-store" });
          setDetail(next);
          if (next.creditNotePosting?.status !== postingStatus) await onChanged();
        } catch { /* Try again on the next tick. */ }
      })();
    }, 4_000);
    return () => window.clearInterval(interval);
  }, [company.id, onChanged, postingStatus, proposal]);
  useEffect(() => { setRefreshRun(null); setRefreshCompleted(false); setRefreshMessage(null); setDocumentUrl(null); setCreateOpen(false); setCreateAfterRefresh(false); setDrawerView("summary"); }, [proposal?.id]);
  useEffect(() => {
    if (!refreshRunId || !refreshRunStatus || ["completed", "failed", "completed_with_issues"].includes(refreshRunStatus)) return;
    const poll = async () => {
      const token = await accessToken();
      if (!token) return;
      try {
        const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/runs/${refreshRunId}`);
        setRefreshRun(response.evaluationRun);
      } catch { /* Keep the queued refresh visible until the next poll succeeds. */ }
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, 4_000);
    return () => window.clearInterval(interval);
  }, [company.id, refreshRunId, refreshRunStatus]);
  useEffect(() => {
    if (refreshRunStatus !== "completed") return;
    let cancelled = false;
    void (async () => {
      await onChanged();
      await loadDetail();
      if (cancelled) return;
      setRefreshCompleted(true);
      setRefreshMessage("Live Tally information is current. You can now create the Credit Note.");
      setRefreshRun(null);
    })();
    return () => { cancelled = true; };
  }, [loadDetail, onChanged, refreshRunId, refreshRunStatus]);
  useEffect(() => {
    if (!refreshRun || !["failed", "completed_with_issues"].includes(refreshRun.status)) return;
    setCreateAfterRefresh(false);
    setRefreshMessage(userFacingDetail(refreshRun.summary?.message ?? refreshRun.error_summary, "The Tally verification needs review before a Credit Note can be created."));
  }, [refreshRun, refreshRunStatus]);
  useEffect(() => {
    if (!noteReconciliationRunId) return;
    let cancelled = false;
    const check = async () => {
      const token = await accessToken();
      if (!token || cancelled) return;
      try {
        const response = await apiRequest<{ syncRun: { status: string; error_summary?: string | null } }>(token, `/api/companies/${company.id}/sync/runs/${noteReconciliationRunId}`);
        if (cancelled || !["completed", "completed_with_errors", "failed"].includes(response.syncRun.status)) return;
        setNoteReconciliationRunId(null);
        if (response.syncRun.status === "completed") {
          setRefreshMessage("Targeted Tally verification completed. Review the Credit Note status below.");
          await onChanged();
          await loadDetail();
        } else {
          setRefreshMessage(response.syncRun.error_summary ?? "The targeted Tally verification did not complete.");
        }
      } catch { /* Continue polling while the bridge returns the scoped result. */ }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [company.id, loadDetail, noteReconciliationRunId, onChanged]);
  const postingDisabled = launchMode !== "posting_enabled";
  const canRefresh = isAdministrator;
  const canManage = isAdministrator;
  const canMessage = isAdministrator;
  async function action(kind: "refresh" | "create" | "reject" | "retry" | "request_pdf" | "shortfall" | "recover" | "resolve_tod_tier_review" | "reconcile_credit_note") {
    if (!proposal) return;
    const token = await accessToken(); if (!token) return;
    setBusy(true); onError(null);
    try {
      if (kind === "refresh") {
        const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/proposals/${proposal.id}/refresh`, { method: "POST", body: jsonBody({}) });
        setRefreshCompleted(false);
        setRefreshMessage("Refreshing live Tally evidence for this proposal. This drawer will update automatically.");
        setRefreshRun(response.evaluationRun);
        return;
      }
      else if (kind === "retry" && detail?.creditNotePosting) await apiRequest(token, `/api/companies/${company.id}/credit-notes/${detail.creditNotePosting.id}/retry`, { method: "POST", body: jsonBody({ reason }) });
      else if (kind === "request_pdf" && detail?.creditNotePosting) await apiRequest(token, `/api/companies/${company.id}/credit-notes/${detail.creditNotePosting.id}/pdf`, { method: "POST", body: jsonBody({}) });
      else if (kind === "shortfall") await apiRequest(token, `/api/companies/${company.id}/notifications/shortfall`, { method: "POST", body: jsonBody({ proposalId: proposal.id }) });
      else if (kind === "recover" && detail?.creditNotePosting) await apiRequest(token, `/api/companies/${company.id}/notifications/credit-note-recovery`, { method: "POST", body: jsonBody({ creditNotePostingId: detail.creditNotePosting.id }) });
      else if (kind === "resolve_tod_tier_review") await apiRequest(token, `/api/companies/${company.id}/evaluations/proposals/${proposal.id}/tod-tier-review`, { method: "POST", body: jsonBody({ reason }) });
      else if (kind === "reconcile_credit_note" && detail?.creditNotePosting) {
        const response = await apiRequest<{ syncRun: { id: string }; message?: string }>(token, `/api/companies/${company.id}/credit-notes/${detail.creditNotePosting.id}/reconcile`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() } });
        setNoteReconciliationRunId(response.syncRun.id);
        setRefreshMessage(response.message ?? "Targeted Tally verification started.");
        return;
      }
      else await apiRequest(token, `/api/companies/${company.id}/evaluations/proposals/${proposal.id}/review`, { method: "POST", body: jsonBody(kind === "create" ? { decision: "create" } : { decision: "reject", proposalEvaluationId: proposal.latestEvaluation?.id, reason }) });
      if (kind === "create") setCreateOpen(false);
      if (kind === "resolve_tod_tier_review") setReason("");
      await onChanged(); await loadDetail();
    } catch (cause) { onError(userFacingError(cause, "This action could not be completed.")); }
    finally { setBusy(false); }
  }
  async function openDocument() {
    if (!detail?.creditNotePosting) return;
    const token = await accessToken(); if (!token) return;
    try {
      const response = await apiRequest<{ document: { downloadUrl?: string } | null }>(token, `/api/companies/${company.id}/credit-notes/${detail.creditNotePosting.id}/document`);
      if (!response.document?.downloadUrl) throw new Error("The verified PDF is not available from the configured document service.");
      setDocumentUrl(response.document.downloadUrl);
    } catch (cause) { onError(userFacingError(cause, "Could not open the Credit Note PDF.")); }
  }
  const record = detail?.proposal ?? proposal;
  const message = detail?.notification;
  const evaluationTime = detail?.latestEvaluation?.evaluated_at ?? record?.latestEvaluation?.evaluated_at;
  const latestEvaluationAge = evaluationTime ? Date.now() - new Date(evaluationTime).getTime() : Number.POSITIVE_INFINITY;
  const freshForCreation = (refreshCompleted || Boolean(record?.latestEvaluation?.freshForApproval) || Boolean(proposal?.latestEvaluation?.freshForApproval)) && latestEvaluationAge >= 0 && latestEvaluationAge <= 5 * 24 * 60 * 60 * 1_000;
  const refreshIsActive = Boolean(refreshRun && !["completed", "failed", "completed_with_issues"].includes(refreshRun.status));
  const stillCreatable = record?.status === "eligible" && !detail?.creditNotePosting;
  useEffect(() => {
    if (!createAfterRefresh || !refreshCompleted || loading) return;
    setCreateAfterRefresh(false);
    // The fresh Tally read can change the result; only continue if it is still creatable.
    if (stillCreatable) setCreateOpen(true);
    else setRefreshMessage("The latest Tally information changed this result, so no Credit Note was started. Review the updated amount above.");
  }, [createAfterRefresh, loading, refreshCompleted, stillCreatable]);
  const startCreate = () => {
    if (freshForCreation) { setCreateOpen(true); return; }
    setCreateAfterRefresh(true);
    void action("refresh");
  };
  if (loading || !proposal || !record) return <Drawer open={Boolean(proposal)} onClose={onClose} title={customerName ?? "Customer result"}><TurnoverResultDrawerLoading /></Drawer>;
  if (record.scheme_type === "tod") {
    const formula = detail?.latestEvaluation?.formula_snapshot ?? {};
    const perMtRate = typeof formula.achievedTierRatePerMt === "string" || typeof formula.achievedTierRatePerMt === "number" ? String(formula.achievedTierRatePerMt) : null;
    const usesAmountPerMt = formula.todBenefitBasis === "amount_per_eligible_tonne" || perMtRate !== null;
    const achievedTierLabel = usesAmountPerMt ? `${perMtRate ?? "—"} ₹/MT` : `${record.discount_percentage ?? "0"}%`;
    const discountPercentage = Number(record.discount_percentage ?? "0") || 0;
    const tierTone = record.achieved_tier_id ? (discountPercentage >= 5 ? "top" : discountPercentage >= 3 ? "middle" : "entry") : "none";
    const eligibleTonnes = Number(record.eligible_tonnes ?? "0") || 0;
    const remainingTonnes = Number(record.additional_tonnes_required ?? "0") || 0;
    const periodEnded = record.period_end ? new Date(`${record.period_end.slice(0, 10)}T23:59:59`).getTime() < Date.now() : false;
    const createReady = periodEnded && record.status === "eligible" && !detail?.creditNotePosting;
    const creationAvailableOn = record.period_end ? formatBusinessDate(record.period_end) : "the end of the rule period";
    const nextStep = record.achieved_tier_id
      ? periodEnded ? "Check the latest Tally calculation, then create the Credit Note." : `Keep tracking this customer until ${formatBusinessDate(record.period_end)}. The discount is projected until then.`
      : remainingTonnes > 0 ? `${formatTonnes(remainingTonnes)} MT more is needed to reach the next discount slab.` : "No discount slab has been reached for this period.";
    const tallyEvidence = detail?.tallyEvidence;
    const evidenceVouchers = tallyEvidence?.vouchers ?? [];
    const evidenceLines = tallyEvidence?.lines ?? [];
    const blockedLines = evidenceLines.filter((line) => line.blockingReason);
    const productSummary = [...evidenceLines.reduce((products, line) => {
      if (line.blockingReason) return products;
      const current = products.get(line.productName) ?? { name: line.productName, group: line.productGroupName, tonnes: 0, value: 0 };
      current.tonnes += Number(line.eligibleTonnes || 0) * line.contributionSign;
      current.value += Number(line.eligibleTaxableValue || 0) * line.contributionSign;
      products.set(line.productName, current);
      return products;
    }, new Map<string, { name: string; group: string | null; tonnes: number; value: number }>()).values()].sort((left, right) => right.tonnes - left.tonnes);
    const ruleVersion = Number(detail?.latestEvaluation?.rule_snapshot?.versionNumber ?? 0);
    const groupPath = detail?.latestEvaluation?.customer_group_snapshot?.groupPath;
    const groupLabel = Array.isArray(groupPath)
      ? groupPath.map((group) => group && typeof group === "object" && "groupName" in group ? String(group.groupName) : "").filter(Boolean).reverse().join(" › ")
      : "Rule-covered customer group";
    const tierDropIssue = detail?.openIssues.find((issue) => issue.issue_type === "tod_tier_reduced_after_notification") ?? null;
    // One plain Credit Note status for the top card.
    const posting = detail?.creditNotePosting ?? null;
    const whatsappSent = ["sent", "delivered", "read", "whatsapp_sent"].includes(message?.status ?? "");
    const noteStatus: { label: string; tone: "muted" | "waiting" | "active" | "done" | "problem" } = !record.achieved_tier_id
      ? { label: "No Credit Note · slab not reached", tone: "muted" }
      : !periodEnded ? { label: `Credit Note after ${creationAvailableOn}`, tone: "waiting" }
      : !posting ? { label: "Credit Note not created", tone: "waiting" }
      : ["failed", "correction_required", "reconciliation_required"].includes(posting.status) ? { label: "Credit Note needs attention in Tally", tone: "problem" }
      : posting.status !== "created_verified" ? { label: "Creating Credit Note in Tally…", tone: "active" }
      : whatsappSent ? { label: `Created in Tally · No. ${posting.verified_voucher_number ?? "—"} · sent on WhatsApp`, tone: "done" }
      : { label: `Created in Tally · No. ${posting.verified_voucher_number ?? "—"} · WhatsApp not sent`, tone: "active" };
    // Present on calculations made with the 25-day payment rule; older results have none.
    const paymentChecks = Array.isArray(formula.paymentChecks) ? formula.paymentChecks as TodPaymentCheckRow[] : null;
    const countedInvoices = paymentChecks?.filter((check) => check.counted).length ?? 0;
    const missedChecks = (paymentChecks ?? []).filter((check) => !check.counted);
    const countedChecks = (paymentChecks ?? []).filter((check) => check.counted);
    const missedTonnes = missedChecks.reduce((total, check) => total + (Number(check.tonnes) || 0), 0);
    const shortDate = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    const dayGap = (from: string, to: string) => Math.round((new Date(`${to.slice(0, 10)}T00:00:00`).getTime() - new Date(`${from.slice(0, 10)}T00:00:00`).getTime()) / 86_400_000);
    // Plain words for one invoice: when it was due and how it was paid.
    const paymentWords = (check: TodPaymentCheckRow) => {
      const due = `Due ${shortDate(check.dueDate)}${check.shiftedFor.length ? ` (moved from ${shortDate(check.nominalDueDate)}, ${check.shiftedFor.map((item) => item.reason === "holiday" ? "holiday" : "Sunday").join(", ")})` : ""}`;
      const gap = check.paidInFullOn ? dayGap(check.dueDate, check.paidInFullOn) : null;
      const paid = check.paidInFullOn
        ? `Paid in full ${shortDate(check.paidInFullOn)} · ${gap! > 0 ? `${gap} day${gap === 1 ? "" : "s"} late` : gap === 0 ? "on the due date" : `${-gap!} day${gap === -1 ? "" : "s"} early`}`
        : Number(check.paidTotal) > 0 ? `Paid ${formatMoney(check.paidTotal)} · ${formatMoney(Math.max(0, Number(check.invoiceAmount) - Number(check.paidTotal)))} short` : "No payment yet";
      return { due, paid };
    };
    const verdictLabel = (check: TodPaymentCheckRow) => check.counted ? "Counted" : check.reason === "paid_after_due_date" ? "Paid late" : check.reason === "partly_paid" ? "Partly paid" : "Not paid";
    const paymentRow = (check: TodPaymentCheckRow) => {
      const words = paymentWords(check);
      return <article key={check.tallyGuid} className={check.counted ? "is-counted" : "is-excluded"}>
        <div><strong>{check.voucherNumber || "Sales invoice"}</strong><small>{formatBusinessDate(check.invoiceDate)} · {formatMoney(check.invoiceAmount)}</small></div>
        <div className="tod-payment-days"><small>{words.due}</small><small className={check.counted ? undefined : "is-problem"}>{words.paid}</small></div>
        <strong className="tod-payment-mt">{formatTonnes(check.tonnes)} MT</strong>
        <span className={`tod-payment-verdict ${check.counted ? "is-counted" : "is-excluded"}`}>{verdictLabel(check)}</span>
      </article>;
    };
    const whoFor = customerName ?? record.customer_name ?? "Customer";
    const drawerTitle = drawerView === "evidence" ? `${whoFor} · Tally evidence` : drawerView === "payments" ? `${whoFor} · Payment check` : drawerView === "audit" ? `${whoFor} · Audit` : customerName ?? record.customer_name ?? "Customer result";
    // Creating a Credit Note is a step inside the drawer (with Back), not a modal on top of it.
    return <><Drawer open={Boolean(proposal)} onClose={onClose} onBack={createOpen ? () => setCreateOpen(false) : drawerView === "summary" ? undefined : () => setDrawerView("summary")} title={createOpen ? "Create Credit Note" : drawerTitle} description=""><div className="drawer-stack tod-customer-drawer">
      {createOpen ? <CreditNoteCreationPanel customerName={customerName ?? record.customer_name ?? undefined} proposal={record} busy={busy} onBack={() => setCreateOpen(false)} onConfirm={() => void action("create")} /> : drawerView === "evidence" ? <div className="tod-drawer-subview">
        <div className="tod-subview-summary"><span>{evidenceVouchers.length} voucher{evidenceVouchers.length === 1 ? "" : "s"}</span><span>{productSummary.length} product{productSummary.length === 1 ? "" : "s"}</span><span>{formatTonnes(record.eligible_tonnes)} MT</span></div>
        <section><p className="eyebrow">Transactions</p>{evidenceVouchers.length ? <div className="tod-evidence-list">{evidenceVouchers.map((voucher) => <article key={`${voucher.tallyVoucherId}-${voucher.contributionType}`}><div><strong>{voucher.voucherNumber || voucher.voucherTypeName || "Tally voucher"}</strong><small>{formatBusinessDate(voucher.voucherDate)} · {userLabel(voucher.voucherKind)}</small></div><div><strong className={Number(voucher.tonneContribution) < 0 ? "is-negative" : ""}>{formatTonnes(voucher.tonneContribution)} MT</strong><small>{formatMoney(voucher.taxableValueContribution)}</small></div></article>)}</div> : <EmptyState title="No voucher breakdown" detail="Run the calculation again to capture transaction evidence." />}</section>
        {productSummary.length ? <section><p className="eyebrow">Products counted</p><div className="tod-evidence-list">{productSummary.map((product) => <article key={product.name}><div><strong>{product.name}</strong><small>{product.group || "Tally stock item"}</small></div><div><strong>{formatTonnes(product.tonnes)} MT</strong><small>{formatMoney(product.value)}</small></div></article>)}</div></section> : null}
        {blockedLines.length ? <InlineMessage tone="warning">{blockedLines.length} Tally item line{blockedLines.length === 1 ? " was" : "s were"} excluded because quantity or unit information needs attention.</InlineMessage> : null}
      </div> : drawerView === "payments" ? <div className="tod-drawer-subview">
        {paymentChecks?.length ? <>
          <div className="tod-payment-summary">
            <div><strong>{countedInvoices} of {paymentChecks.length}</strong><small>invoices counted</small></div>
            <div><strong>{formatTonnes(eligibleTonnes)} MT</strong><small>counted</small></div>
            <div className={missedChecks.length ? "is-problem" : undefined}><strong>{formatTonnes(missedTonnes)} MT</strong><small>not counted ({missedChecks.length})</small></div>
          </div>
          {missedChecks.length > 0 && remainingTonnes > 0 && <p className={`tod-payment-impact${missedTonnes >= remainingTonnes ? " is-problem" : ""}`}>{missedTonnes >= remainingTonnes
            ? `Paid on time, these ${missedChecks.length} invoices would have reached the next slab (${formatTonnes(remainingTonnes)} MT needed).`
            : `Even counted, these would not reach the next slab: ${formatTonnes(remainingTonnes)} MT is needed.`}</p>}
          <p className="tod-payment-rule">Counts only invoices paid in full within 25 days. A due date on a Sunday or holiday moves to the next working day.</p>
          {missedChecks.length > 0 && <section><p className="eyebrow">Not counted · {missedChecks.length}</p><div className="tod-payment-list">{missedChecks.map(paymentRow)}</div></section>}
          {countedChecks.length > 0 && <details className="tod-payment-counted" open={!missedChecks.length}>
            <summary>Counted · {countedChecks.length} invoice{countedChecks.length === 1 ? "" : "s"} · {formatTonnes(countedChecks.reduce((total, check) => total + (Number(check.tonnes) || 0), 0))} MT</summary>
            <div className="tod-payment-list">{countedChecks.map(paymentRow)}</div>
          </details>}
        </> : <EmptyState title="No payment check recorded" detail="This result was calculated before the 25-day payment rule. Run the calculation again to see it." />}
      </div> : drawerView === "audit" ? <div className="tod-drawer-subview">
        <dl className="tod-audit-grid"><div><dt>Rule</dt><dd>{ruleVersion ? `Version ${ruleVersion}` : "Active Turnover Discount rule"}</dd></div><div><dt>Effective from</dt><dd>{formatBusinessDate(typeof detail?.latestEvaluation?.rule_snapshot?.effectiveFrom === "string" ? detail.latestEvaluation.rule_snapshot.effectiveFrom : null)}</dd></div><div><dt>Customer group</dt><dd>{groupLabel || "Rule-covered customer group"}</dd></div><div><dt>Last calculated</dt><dd>{formatDate(record.latest_evaluated_at)}</dd></div></dl>
        {detail?.reviews.length ? <section><p className="eyebrow">Action history</p><div>{detail.reviews.map((review) => <div className="history-row" key={review.id}><StatusBadge status={review.status} /><span>{review.review_reason || review.invalidation_reason || "Recorded using the latest Tally information"}</span><small>{formatDate(review.reviewed_at)}</small></div>)}</div></section> : <EmptyState title="No administrator actions" detail="Decisions and review notes will appear here." />}
      </div> : <>
      {/* Compact summary: amount + how it was reached, then period and freshness. The slab itself is shown once, in the slab strip below. */}
      <div className="tod-hero">
        <div className="tod-hero-main">
          <div><small>{periodEnded ? "Discount" : "Projected discount"}</small><strong>{formatMoney(record.calculated_discount_amount)}</strong></div>
          <span>{record.achieved_tier_id
            ? usesAmountPerMt ? `${formatTonnes(eligibleTonnes)} MT × ₹${perMtRate ?? "0"}/MT` : `${formatMoney(record.eligible_product_taxable_value)} × ${record.discount_percentage ?? "0"}%`
            : `${formatTonnes(eligibleTonnes)} MT counted${remainingTonnes > 0 ? ` · ${formatTonnes(remainingTonnes)} MT to first slab` : ""}`}</span>
        </div>
        {/* Credit Note status in plain words: not created → created in Tally → sent on WhatsApp. */}
        <div className="tod-hero-note">
          <span className={`tod-note-status is-${noteStatus.tone}`}>{noteStatus.label}</span>
          {canManage && record.achieved_tier_id && !detail?.creditNotePosting && periodEnded && <Button className="tod-hero-create" disabled={busy || !createReady || refreshIsActive || createAfterRefresh || postingDisabled} title={postingDisabled ? "Credit Note creation is turned off" : freshForCreation ? undefined : "Checks Tally for the latest invoices first"} onClick={startCreate}>{createAfterRefresh ? "Checking Tally…" : "Create Credit Note"}</Button>}
        </div>
        <div className="tod-hero-foot">
          <div><small>{formatBusinessDate(record.period_start)} – {formatBusinessDate(record.period_end)} · {periodEnded ? "complete" : "in progress"}</small><small className="tod-hero-checked">Checked {formatDate(record.latest_evaluated_at)}</small></div>
          {canRefresh && <Button className="button-quiet" disabled={busy || refreshIsActive} onClick={() => void action("refresh")}><RefreshCw size={13} />{refreshIsActive ? "Verifying…" : "Verify"}</Button>}
        </div>
      </div>
      {refreshMessage && <InlineMessage tone={refreshRun?.status === "failed" || refreshRun?.status === "completed_with_issues" ? "error" : freshForCreation ? "success" : "info"}>{refreshRun?.error_summary ?? refreshMessage}</InlineMessage>}
      {tallyEvidence?.tiers.length ? <section className="tod-slab-progress"><p className="eyebrow">Discount slab</p><div className="tod-slab-track">{tallyEvidence.tiers.map((tier) => { const minimum = Number(tier.minimum_tonnes); const reached = eligibleTonnes >= minimum; const active = tier.id === record.achieved_tier_id; const label = usesAmountPerMt ? `₹${tier.discount_amount_per_tonne ?? "—"}/MT` : `${tier.discount_percentage}%`; return <div className={`${reached ? "is-reached" : ""} ${active ? "is-active" : ""}`} key={tier.id}><span>{minimum} MT</span><strong>{label}</strong></div>; })}</div></section> : null}
      <div className="tod-drawer-destinations"><button onClick={() => setDrawerView("evidence")}><span><strong>Tally evidence</strong><small>{evidenceVouchers.length} {evidenceVouchers.length === 1 ? "voucher" : "vouchers"} · {productSummary.length} {productSummary.length === 1 ? "product" : "products"}</small></span><ChevronRight size={16} /></button><button onClick={() => setDrawerView("payments")}><span><strong>Payment check</strong><small>{paymentChecks ? `${countedInvoices} of ${paymentChecks.length} invoices paid within 25 days` : "Day calculation per invoice"}</small></span><ChevronRight size={16} /></button>{isAdministrator && <button onClick={() => setDrawerView("audit")}><span><strong>Audit information</strong><small>Rule, customer group and action history</small></span><ChevronRight size={16} /></button>}</div>
      {detail?.openIssues.length ? <section><h3>Needs attention</h3>{detail.openIssues.map((issue) => <OpenIssueSummary issue={issue} key={issue.id} />)}{tierDropIssue && canManage ? <div className="drawer-actions"><label>Finance review note<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why no correction message is needed" /></label><Button className="button-secondary" disabled={busy || reason.trim().length < 3} onClick={() => void action("resolve_tod_tier_review")}>Mark reviewed — no correction sent</Button><small>Closing this review never sends a WhatsApp. It only allows a future, genuinely new tier to be evaluated normally.</small></div> : null}</section> : null}
      {detail?.creditNotePosting && <section><h3>Credit Note progress</h3><CreditNoteLifecycle posting={detail.creditNotePosting} message={message} /><div className="tod-credit-note-summary"><div><span>Status</span><strong>{staffStatusLabel(detail.creditNotePosting.status)}</strong></div><div><span>Amount</span><strong>{formatMoney(detail.creditNotePosting.verified_amount ?? detail.creditNotePosting.discount_amount)}</strong></div><div><span>Tally number</span><strong>{detail.creditNotePosting.verified_voucher_number ?? "Waiting for confirmation"}</strong></div></div>{detail.creditNotePosting.document?.available && <Button className="button-secondary" onClick={() => void openDocument()}>Open Credit Note PDF</Button>}{canManage && detail.creditNotePosting.status === "created_verified" ? <Button className="button-quiet" disabled={busy || Boolean(noteReconciliationRunId)} onClick={() => void action("reconcile_credit_note")}><RefreshCw size={14} />{noteReconciliationRunId ? "Checking Tally…" : "Verify in Tally"}</Button> : null}{canManage && ["failed", "correction_required"].includes(detail.creditNotePosting.status) ? <div className="drawer-actions"><label>Reason for checking again<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What was checked or corrected before retrying" /></label><Button disabled={busy || reason.trim().length < 3 || postingDisabled} onClick={() => void action("retry")}>{busy ? "Checking existing voucher…" : "Check existing Tally voucher again"}</Button><small>The permanent reference is reused, so this cannot create a duplicate Credit Note.</small></div> : null}</section>}
      {detail?.creditNotePosting?.status === "created_verified" && !detail.creditNotePosting.document?.available && <section><h3>Credit Note PDF</h3><p className="muted-copy">A reference PDF can be prepared from this verified Tally voucher. Templates requiring a document cannot be sent until it is ready.</p>{["pending", "exporting", "attached"].includes(detail.creditNotePosting.document?.status ?? "") && <InlineMessage tone="info">Preparing the reference PDF.</InlineMessage>}{detail.creditNotePosting.document?.failureReason && <InlineMessage tone="warning">{detail.creditNotePosting.document.failureReason}</InlineMessage>}{canManage && detail.creditNotePosting.verified_tally_guid && <Button className="button-secondary" disabled={busy} onClick={() => void action("request_pdf")}>{busy ? "Requesting…" : "Prepare PDF"}</Button>}</section>}
      {canManage && record.status === "eligible" && periodEnded && postingDisabled && <InlineMessage tone="info">Credit Note creation is off. <Link href="/turnover-discount?view=create">Turn it on in Turnover Discount → Ready to create</Link>.</InlineMessage>}
      </>}
    </div></Drawer><VerifiedCreditNoteDocument open={Boolean(documentUrl)} downloadUrl={documentUrl} posting={detail?.creditNotePosting ?? null} onClose={() => setDocumentUrl(null)} /></>;
  }
  const recommendedAction = cashDiscountActionFrom(record, detail?.latestEvaluation?.formula_snapshot);
  const recommendedActionCopy = cashDiscountActionCopy(recommendedAction);
  const canApproveCreditNote = recommendedAction === "credit_note";
  return <><Drawer open={Boolean(proposal)} onClose={onClose} title={customerName ?? "Cash Discount result"} description="Review the payment result and the next action chosen from the approved rule."><div className="drawer-stack">
    <div className="detail-status"><StatusBadge status={record.status} /><strong>{formatMoney(record.calculated_discount_amount)}</strong></div>
    <InlineMessage tone={recommendedActionCopy.tone}><strong>{recommendedActionCopy.title}.</strong> {recommendedActionCopy.detail}</InlineMessage>
    <DetailGrid rows={[...(isAdministrator ? [["Rule version", record.scheme_version_id ?? "Protected rule version"]] as Array<[string, string]> : []), ["Tally information", freshForCreation ? "Current" : `Last checked ${formatDate(record.latest_evaluated_at)}`], ["Payment deadline", record.eligibility_deadline ?? "Not recorded"], ["Recommended action", recommendedActionCopy.title], ["Eligible invoice value", formatMoney(record.eligible_product_taxable_value)], ["Paid / still due", `${formatMoney(record.amount_paid_by_deadline)} / ${formatMoney(record.shortfall_amount)}`]]} />
    <section><h3>Calculation details</h3><p className="muted-copy">Invoice due {formatMoney(record.invoice_amount_due)}; discounted payment target {formatMoney(record.discounted_settlement_target)}.</p></section>
    <section><h3>Why this result was produced</h3>{record.reason_codes.length ? <div className="reason-list">{record.reason_codes.map((code) => <span key={code}>{userLabel(code)}</span>)}</div> : <p className="muted-copy">The calculation completed without an additional reason.</p>}</section>
    <section><h3>Open issues</h3>{detail?.openIssues.length ? detail.openIssues.map((issue) => <OpenIssueSummary issue={issue} key={issue.id} />) : <p className="muted-copy">There are no open issues for this result.</p>}</section>
    <section><h3>Administrator action history</h3>{detail?.reviews.length ? detail.reviews.map((review) => <div className="history-row" key={review.id}><StatusBadge status={review.status} /><span>{review.review_reason || review.invalidation_reason || "Recorded using the latest Tally information"}</span><small>{formatDate(review.reviewed_at)}</small></div>) : <p className="muted-copy">No administrator decision has been recorded yet.</p>}</section>
    {detail?.creditNotePosting && <section><h3>Credit Note</h3><DetailGrid rows={[["Credit Note number", detail.creditNotePosting.verified_voucher_number ?? "Waiting to be confirmed"], ["Amount", formatMoney(detail.creditNotePosting.verified_amount ?? detail.creditNotePosting.discount_amount)], ["Confirmed in Tally", detail.creditNotePosting.verified_at ? "Yes" : "Not yet"], ["Confirmed on", formatDate(detail.creditNotePosting.verified_at)], ["PDF", detail.creditNotePosting.document?.status ?? "Not requested"]]} />{detail.creditNotePosting.status === "correction_required" && <InlineMessage tone="warning"><strong>Tally reconciliation required.</strong> {detail.creditNotePosting.reconciliation_reason ?? "Confirm the Tally voucher before asking Finance to correct it. No replacement is created automatically."}</InlineMessage>}{detail.creditNotePosting.failure_reason && <InlineMessage tone="error">{detail.creditNotePosting.failure_reason}</InlineMessage>}{detail.creditNotePosting.document?.failureReason && <InlineMessage tone="error">{detail.creditNotePosting.document.failureReason}</InlineMessage>}{detail.creditNotePosting.document?.available ? <Button className="button-secondary" onClick={() => void openDocument()}>Open Credit Note PDF</Button> : canRefresh && detail.creditNotePosting.verified_tally_guid ? <><p className="muted-copy">Prepare a reference PDF from the verified Tally voucher.</p><Button className="button-secondary" disabled={busy} onClick={() => void action("request_pdf")}>Prepare Credit Note PDF</Button></> : null}</section>}
    <section><h3>WhatsApp event</h3>{message?.messageId ? <p className="muted-copy"><StatusBadge status={message.status ?? "queued"} /> An approved event already exists. <Link href="/messages">Open Messages</Link> for preview and delivery history.</p> : <p className="muted-copy">{message?.blockedReason ?? "A message is not applicable at this state."}</p>}{canMessage && message?.canQueue && <Button className="button-secondary" disabled={busy} onClick={() => void action(message.eventType === "cd_shortfall" ? "shortfall" : "recover")}>{message.eventType === "cd_shortfall" ? "Queue shortfall reminder" : "Recover verified notification"}</Button>}</section>
    {canRefresh && <section className="drawer-actions"><h3>Available actions</h3>{refreshMessage && <InlineMessage tone={refreshRun?.status === "failed" || refreshRun?.status === "completed_with_issues" ? "error" : freshForCreation ? "success" : "info"}>{refreshRun?.error_summary ?? refreshMessage}</InlineMessage>}<Button className="button-secondary" disabled={busy || refreshIsActive} onClick={() => void action("refresh")}>{refreshIsActive ? "Checking latest Tally information…" : "Check latest Tally information"}</Button>{canManage && record.status === "eligible" && canApproveCreditNote && !detail?.creditNotePosting && <Button disabled={busy || refreshIsActive || createAfterRefresh || postingDisabled} title={postingDisabled ? "Turn on Credit Note creation on the Ready to create tab first" : undefined} onClick={startCreate}>{createAfterRefresh ? "Checking Tally before creating…" : "Create Credit Note"}</Button>}{canManage && record.status === "eligible" && canApproveCreditNote && !detail?.creditNotePosting && !postingDisabled && !createAfterRefresh && <p className="muted-copy">{freshForCreation ? "Uses the calculation from the last 5 days." : "Tally is checked for the latest invoices first, then you confirm the amount."}</p>}{recommendedAction === "debit_note" && <InlineMessage tone="info">Debit Note recovery requires an Administrator decision and is never posted automatically.</InlineMessage>}{canManage && <><label>Reason required to reject this result<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain why this result should not be used" /></label><Button className="button-danger" disabled={busy || !reason.trim() || !proposal.latestEvaluation} onClick={() => void action("reject")}>Reject result</Button></>}{detail?.creditNotePosting && ["failed", "correction_required"].includes(detail.creditNotePosting.status) && <Button disabled={busy || !reason.trim() || postingDisabled} onClick={() => void action("retry")}>Retry safely</Button>}{postingDisabled && canApproveCreditNote && <InlineMessage tone="warning">Credit Note creation is off for this company. Turn it on from the Turnover Discount “Ready to create” tab, then come back here.</InlineMessage>}</section>}
  </div></Drawer><CreditNoteCreationDialog open={createOpen} customerName={customerName} proposal={record} busy={busy} onClose={() => setCreateOpen(false)} onConfirm={() => void action("create")} /><VerifiedCreditNoteDocument open={Boolean(documentUrl)} downloadUrl={documentUrl} posting={detail?.creditNotePosting ?? null} onClose={() => setDocumentUrl(null)} /></>;
}

function CreditNoteCreationDialog({ open, customerName, proposal, busy, onClose, onConfirm }: { open: boolean; customerName?: string; proposal: Proposal; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return <Dialog open={open} onClose={onClose} title="Create Credit Note" description="Check the amount and period before creating this voucher in Tally.">
    <CreditNoteCreationPanel customerName={customerName} proposal={proposal} busy={busy} onBack={onClose} onConfirm={onConfirm} />
  </Dialog>;
}

function CreditNoteCreationPanel({ customerName, proposal, busy, onBack, onConfirm }: { customerName?: string; proposal: Proposal; busy: boolean; onBack: () => void; onConfirm: () => void }) {
  return <>
    <div className="credit-note-confirmation">
      <dl>
        <div><dt>Customer</dt><dd>{customerName ?? "Customer record"}</dd></div>
        <div><dt>Period</dt><dd>{proposal.period_start && proposal.period_end ? `${formatBusinessDate(proposal.period_start)} – ${formatBusinessDate(proposal.period_end)}` : "Cash Discount result"}</dd></div>
        <div><dt>Credit Note amount</dt><dd>{formatMoney(proposal.calculated_discount_amount)}</dd></div>
      </dl>
      <ol aria-label="What happens after confirmation">
        <li><span>1</span><div><strong>Create in Tally</strong><small>The request uses one permanent calculation reference.</small></div></li>
        <li><span>2</span><div><strong>Verify from Tally</strong><small>The voucher number, customer and amount are read back and checked.</small></div></li>
        <li><span>3</span><div><strong>Send on WhatsApp</strong><small>Once confirmed, send it to the customer from Credit Notes. Nothing is sent automatically.</small></div></li>
      </ol>
      <InlineMessage tone="info">Creating again for this customer, rule and period is blocked automatically.</InlineMessage>
      <div className="dialog-actions"><Button className="button-secondary" disabled={busy} onClick={onBack}>Back</Button><Button disabled={busy} onClick={onConfirm}>{busy ? "Creating…" : "Create in Tally"}</Button></div>
    </div>
  </>;
}

// Short Tally / WhatsApp status for the compact Credit Note table.
// Used by both Credit Notes and Debit Notes.
function noteRowStatus(posting: { status: string; verified_voucher_number?: string | null }, message?: { status?: string | null; blockedReason?: string | null } | null) {
  const verified = posting.status === "created_verified";
  const tally = verified
    ? { label: `No. ${posting.verified_voucher_number ?? "—"}`, tone: "done" }
    : posting.status === "correction_required" ? { label: "Needs correction", tone: "problem" }
    : posting.status === "reconciliation_required" ? { label: "Needs Tally review", tone: "problem" }
    : posting.status === "cancelled" ? { label: "Cancelled", tone: "muted" }
    : posting.status === "failed" ? { label: "Failed", tone: "problem" }
    : { label: "Creating…", tone: "active" };
  const messageStatus = message?.status ?? null;
  const whatsapp = !verified ? { label: "Waits for Tally", tone: "muted" }
    : messageStatus === "failed" || messageStatus === "suppressed" ? { label: "Not delivered", tone: "problem" }
    : messageStatus ? { label: staffStatusLabel(messageStatus), tone: ["sent", "delivered", "read", "whatsapp_sent"].includes(messageStatus) ? "done" : "active" }
    : { label: "Not sent", tone: "waiting" };
  return { tally, whatsapp };
}

function CreditNoteLifecycle({ posting, message }: { posting: Pick<CreditNotePosting, "status" | "verified_voucher_number" | "failure_reason" | "reconciliation_reason">; message?: { status?: string | null; blockedReason?: string | null } | null }) {
  const tallyFailed = ["failed", "correction_required"].includes(posting.status);
  const tallyVerified = posting.status === "created_verified";
  const messageStatus = message?.status ?? null;
  const messageFailed = messageStatus === "failed" || messageStatus === "suppressed";
  const messageComplete = Boolean(messageStatus && ["sent", "delivered", "read", "whatsapp_sent"].includes(messageStatus));
  const steps = [
    // The request itself was accepted; problems belong to the Tally step.
    { label: "Credit Note", detail: "Requested", state: "complete" },
    { label: "Tally", detail: posting.status === "correction_required" ? "Needs correction" : tallyFailed ? "Failed" : tallyVerified ? posting.verified_voucher_number ?? "Verified" : "Creating and verifying", state: tallyFailed ? "failed" : tallyVerified ? "complete" : "active" },
    { label: "WhatsApp", detail: !tallyVerified ? "Waits for Tally" : messageFailed ? "Needs attention" : messageComplete ? staffStatusLabel(messageStatus!) : messageStatus ? staffStatusLabel(messageStatus) : message?.blockedReason ?? "Ready to send", state: messageFailed ? "failed" : messageComplete ? "complete" : tallyVerified ? "active" : "pending" },
  ];
  return <div className="credit-note-flow" aria-label="Credit Note progress">{steps.map((step, index) => <div className={`credit-note-flow-step is-${step.state}`} key={step.label}><span>{step.state === "complete" ? <CheckCircle2 size={15} /> : index + 1}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></div>)}</div>;
}

function DetailGrid({ rows }: { rows: Array<[string, string]> }) { return <dl className="detail-grid">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }

function DebitNotesPage({ data, refresh, setError, setNotice }: PageProps) {
  const { company } = useCompany();
  const [filter, setFilter] = useState("all");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [debitPdf, setDebitPdf] = useState<{ url: string; number: string } | null>(null);
  const [preparingPdfId, setPreparingPdfId] = useState<string | null>(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [sendTargets, setSendTargets] = useState<WhatsAppTarget[] | null>(null);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const activeStatuses = ["queued", "sending"];
  const attentionStatuses = ["failed", "reconciliation_required"];
  const deliveredStatuses = ["sent", "delivered", "read", "whatsapp_sent"];
  const notes = data.debitNotes;
  // Per-MT Cash Discount Credit Notes share this list. The approved WhatsApp
  // template describes a debit memo, so they cannot be sent with it.
  const isCdCreditNote = (note: typeof notes[number]) => note.note_kind === "credit_note";
  const debitMessageStatus = (noteId: string) => data.messages.find((message) => message.cash_discount_debit_note_posting_id === noteId)?.status ?? "";
  const debitNotSent = (note: typeof notes[number]) => note.status === "created_verified" && !deliveredStatuses.includes(debitMessageStatus(note.id));
  const debitSent = (note: typeof notes[number]) => note.status === "created_verified" && deliveredStatuses.includes(debitMessageStatus(note.id));
  const filtered = notes.filter((note) => filter === "all"
    || (filter === "active" && activeStatuses.includes(note.status))
    || (filter === "whatsapp" && debitNotSent(note))
    || (filter === "completed" && debitSent(note))
    || (filter === "attention" && attentionStatuses.includes(note.status)));
  const activeCount = notes.filter((note) => activeStatuses.includes(note.status)).length;
  const whatsappPendingCount = notes.filter(debitNotSent).length;
  const completedCount = notes.filter(debitSent).length;
  const attentionCount = notes.filter((note) => attentionStatuses.includes(note.status)).length;
  const hasActiveWork = activeCount > 0 || data.messages.some((message) => message.cash_discount_debit_note_posting_id && ["queued", "sending"].includes(message.status));
  const messageForPosting = (postingId: string) => data.messages.find((message) => message.cash_discount_debit_note_posting_id === postingId) ?? null;
  const openNote = openNoteId ? notes.find((note) => note.id === openNoteId) ?? null : null;
  const selectableIds = filtered.filter((note) => note.status === "created_verified" && !isCdCreditNote(note)).map((note) => note.id);
  const selectableKey = selectableIds.join(",");
  useEffect(() => {
    const allowed = new Set(selectableKey ? selectableKey.split(",") : []);
    setSelectedMessageIds((current) => [...current].every((id) => allowed.has(id)) ? current : new Set([...current].filter((id) => allowed.has(id))));
  }, [selectableKey]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedMessageIds.has(id));
  const targetFor = (note: typeof notes[number]): WhatsAppTarget => {
    const message = messageForPosting(note.id);
    return {
      key: note.id, customerId: note.candidate?.customer_id ?? null, customerName: note.candidate?.customer_name ?? "Customer",
      detail: `${note.verified_voucher_number ? `Debit Note ${note.verified_voucher_number}` : "Debit Note"} · Invoice ${note.candidate?.invoice_number ?? "—"}`,
      amount: note.verified_amount ?? note.amount, lastMessage: message ? { status: message.status, recipient: message.recipient_phone_e164 } : null,
      request: { kind: "debit_note", postingId: note.id },
    };
  };
  useEffect(() => {
    if (!hasActiveWork) return;
    const interval = window.setInterval(() => { void refresh(); }, 5_000);
    return () => window.clearInterval(interval);
  }, [hasActiveWork, refresh]);
  async function retryDebitNote(postingId: string) {
    const token = await accessToken(); if (!token) return;
    setRetryingId(postingId); setError(null);
    try {
      await apiRequest(token, `/api/companies/${company.id}/debit-notes/${postingId}/retry`, { method: "POST", body: jsonBody({ reason: "Check the existing Tally voucher again after a technical read-back failure." }) });
      await refresh();
    } catch (cause) { setError(userFacingError(cause, "Could not check this Debit Note again.")); }
    finally { setRetryingId(null); }
  }
  async function reconcileDebitNote(postingId: string) {
    const token = await accessToken(); if (!token) return;
    setReconcilingId(postingId); setError(null);
    try {
      const response = await apiRequest<{ syncRun: { id: string }; message?: string }>(token, `/api/companies/${company.id}/cash-discount/debit-notes/${postingId}/reconcile`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() } });
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        const run = await apiRequest<{ syncRun: { status: string; error_summary?: string | null } }>(token, `/api/companies/${company.id}/sync/runs/${response.syncRun.id}`);
        if (run.syncRun.status === "completed") { setNotice("Checked in Tally. The Debit Note status below is up to date."); break; }
        if (["completed_with_errors", "failed"].includes(run.syncRun.status)) throw new Error(run.syncRun.error_summary ?? "The Tally check did not finish.");
      }
      await refresh();
    } catch (cause) { setError(userFacingError(cause, "Could not check this Debit Note in Tally.")); }
    finally { setReconcilingId(null); }
  }
  async function openDebitPdf(postingId: string) {
    const token = await accessToken(); if (!token) return;
    setPreparingPdfId(postingId); setError(null);
    try {
      const response = await apiRequest<{ downloadUrl: string; voucherNumber: string }>(token, `/api/companies/${company.id}/debit-notes/${postingId}/document`, { method: "POST", body: jsonBody({}) });
      setDebitPdf({ url: response.downloadUrl, number: response.voucherNumber });
    } catch (cause) { setError(userFacingError(cause, "Could not prepare the Debit Note PDF.")); }
    finally { setPreparingPdfId(null); }
  }
  const openSend = (ids: string[]) => setSendTargets(notes.filter((note) => ids.includes(note.id) && note.status === "created_verified").map(targetFor));

  return <div className="credit-notes-page">
    <WorkspacePageHeader title="Debit Notes" detail="Cash Discount recoveries created in Tally." action={<IconButton label="Refresh Debit Notes" onClick={() => void refresh()}><RefreshCw size={16} /></IconButton>} />
    <div className="credit-note-summary" aria-label="Debit Note summary"><div><strong>{notes.length}</strong><span>All Debit Notes</span></div><div><strong>{activeCount}</strong><span>Creating in Tally</span></div><div><strong>{whatsappPendingCount}</strong><span>WhatsApp not sent</span></div><div><strong>{completedCount}</strong><span>Sent</span></div><div className={attentionCount ? "has-attention" : ""}><strong>{attentionCount}</strong><span>Needs attention</span></div></div>
    <div className="credit-note-filter-bar debit-note-toolbar"><label><span className="sr-only">Filter Debit Notes</span><select aria-label="Filter Debit Notes" value={filter} onChange={(event) => { setFilter(event.target.value); setSelectedMessageIds(new Set()); }}><option value="all">All statuses</option><option value="active">Creating in Tally</option><option value="whatsapp">WhatsApp not sent</option><option value="completed">Sent</option><option value="attention">Needs attention</option></select></label><div className="note-message-toolbar-actions"><Link className="button button-quiet" href="/cash-discount">Recovery actions</Link><Button disabled={!selectedMessageIds.size} onClick={() => openSend([...selectedMessageIds])}><Send size={14} />{selectedMessageIds.size ? `Send WhatsApp (${selectedMessageIds.size})` : "Send WhatsApp"}</Button></div></div>
    <section className="credit-note-section credit-note-history debit-note-history"><div className="credit-note-section-heading"><h2>History</h2>{selectableIds.length > 0 && <label className="note-select-all"><input type="checkbox" checked={allSelected} onChange={() => setSelectedMessageIds(allSelected ? new Set() : new Set(selectableIds))} />Select all confirmed</label>}<span>{filtered.length} shown</span></div>{filtered.length ? <div className="note-table" role="table" aria-label="Debit Note history"><div className="note-table-head" role="row"><span /><span>Customer</span><span>Amount</span><span>Tally</span><span>WhatsApp</span><span /></div>{filtered.map((note) => {
      const issue = note.status === "reconciliation_required" ? note.reconciliation_reason ?? note.failure_reason ?? "The confirmed Debit Note was not found in the latest Tally check." : note.failure_reason;
      const noteMessage = messageForPosting(note.id);
      const creditKind = isCdCreditNote(note);
      const canSend = note.status === "created_verified" && !creditKind;
      const status = noteRowStatus(note, noteMessage);
      if (creditKind && note.status === "created_verified") status.whatsapp = { label: "Template needed", tone: "muted" };
      // Same compact row as Credit Notes: one line, status pills, short problem line.
      return <div className="note-table-row" role="row" key={note.id}>
        <span>{canSend ? <input type="checkbox" aria-label={`Select ${note.candidate?.customer_name ?? "Debit Note"} for WhatsApp`} checked={selectedMessageIds.has(note.id)} onChange={() => setSelectedMessageIds((current) => { const next = new Set(current); if (next.has(note.id)) next.delete(note.id); else next.add(note.id); return next; })} /> : null}</span>
        <div><strong>{note.candidate?.customer_name ?? "Customer unavailable"}</strong><small>{creditKind ? "Cash Discount Credit Note · " : ""}Invoice {note.candidate?.invoice_number ?? "—"} · {formatBusinessDate(note.candidate?.invoice_date ?? note.debit_note_date)}</small></div>
        <strong className="note-table-amount">{formatMoney(note.verified_amount ?? note.amount)}</strong>
        <div><span className={`note-pill is-${status.tally.tone}`}>{status.tally.label}</span>{issue && <small className="note-table-problem" title={issue}>{issue}</small>}</div>
        <div><span className={`note-pill is-${status.whatsapp.tone}`}>{status.whatsapp.label}</span>{noteMessage?.recipient_phone_e164 && <small>{noteMessage.recipient_phone_e164}</small>}</div>
        <div className="note-table-actions">{canSend && <Button className="button-quiet" onClick={() => openSend([note.id])}><Send size={14} />{noteMessage ? "Resend" : "Send"}</Button>}{note.status === "failed" && <Button className="button-quiet" disabled={retryingId === note.id} onClick={() => void retryDebitNote(note.id)}>{retryingId === note.id ? "Checking…" : "Retry"}</Button>}<Button className="button-quiet" onClick={() => setOpenNoteId(note.id)}>{issue ? "Fix" : "Open"}</Button></div>
      </div>;
    })}</div> : <EmptyState title={notes.length ? "No Debit Notes match this filter" : "No Debit Notes yet"} detail={notes.length ? "Choose another status." : "Cash Discount recoveries appear here after a Debit Note is prepared."} action={<Link className="button button-secondary" href="/cash-discount">Open Cash Discount</Link>} />}</section>
    <Drawer open={Boolean(openNote)} onClose={() => setOpenNoteId(null)} title={openNote?.candidate?.customer_name ?? "Debit Note"} description={openNote?.verified_voucher_number ? `Debit Note ${openNote.verified_voucher_number}` : "Debit Note"}>
      {openNote && (() => {
        const message = messageForPosting(openNote.id);
        return <div className="drawer-stack">
          <div className="detail-status"><StatusBadge status={openNote.status} /><strong>{formatMoney(openNote.verified_amount ?? openNote.amount)}</strong></div>
          {(openNote.status === "reconciliation_required" || openNote.failure_reason) && <InlineMessage tone={openNote.status === "reconciliation_required" ? "warning" : "error"}>{openNote.reconciliation_reason ?? openNote.failure_reason ?? "Check this Debit Note in Tally."}</InlineMessage>}
          <DetailGrid rows={[["Invoice", `${openNote.candidate?.invoice_number ?? "—"} · ${formatBusinessDate(openNote.candidate?.invoice_date)}`], ["Debit Note date", formatBusinessDate(openNote.debit_note_date)], ["Tally number", openNote.verified_voucher_number ?? "Waiting for Tally"], ["Confirmed in Tally", openNote.verified_at ? formatDate(openNote.verified_at) : "Not yet"], ["Last checked", openNote.last_reconciled_at ? formatDate(openNote.last_reconciled_at) : "—"], ["WhatsApp", message ? `${staffStatusLabel(message.status)}${message.recipient_phone_e164 ? ` · ${message.recipient_phone_e164}` : ""}` : "Not sent"]]} />
          <div className="inline-actions">
            {openNote.status === "created_verified" && <Button onClick={() => { setOpenNoteId(null); openSend([openNote.id]); }}><Send size={14} />{message ? "Send WhatsApp again" : "Send WhatsApp"}</Button>}
            {openNote.status === "created_verified" && <Button className="button-secondary" disabled={preparingPdfId === openNote.id} onClick={() => void openDebitPdf(openNote.id)}>{preparingPdfId === openNote.id ? "Preparing PDF…" : "View PDF"}</Button>}
            {["created_verified", "reconciliation_required"].includes(openNote.status) && <Button className="button-secondary" disabled={Boolean(reconcilingId)} onClick={() => void reconcileDebitNote(openNote.id)}><RefreshCw size={14} />{reconcilingId === openNote.id ? "Checking Tally…" : "Check in Tally"}</Button>}
            {openNote.status === "failed" && <Button className="button-secondary" disabled={retryingId === openNote.id} onClick={() => void retryDebitNote(openNote.id)}><RefreshCw size={14} />{retryingId === openNote.id ? "Checking…" : "Check again"}</Button>}
          </div>
          <p className="muted-copy">Reference {openNote.calculation_reference}</p>
        </div>;
      })()}
    </Drawer>
    <WhatsAppSendDrawer open={Boolean(sendTargets)} targets={sendTargets ?? []} onClose={() => setSendTargets(null)} onSent={async (count) => { setSelectedMessageIds(new Set()); setNotice(`${count} WhatsApp message${count === 1 ? "" : "s"} queued.`); await refresh(); }} />
    <Dialog open={Boolean(debitPdf)} onClose={() => setDebitPdf(null)} width="wide" title={`Debit Note ${debitPdf?.number ?? ""}`} description="Reference copy generated from a voucher verified in Tally. Not TallyPrime’s native printout.">
      {debitPdf && <div className="verified-document"><div className="pdf-frame"><iframe src={debitPdf.url} title={`Debit Note ${debitPdf.number} PDF`} /></div><div className="verified-document-footer"><p>This copy is for review and sharing.</p><a className="button button-secondary" href={debitPdf.url} target="_blank" rel="noreferrer">Open in a new tab</a></div></div>}
    </Dialog>
  </div>;
}

const periodHasEnded = (periodEnd: string | null | undefined) => Boolean(periodEnd && new Date(`${periodEnd.slice(0, 10)}T23:59:59`).getTime() < Date.now());

const periodKeyOf = (proposal: Proposal) => proposal.period_start && proposal.period_end ? `${proposal.period_start}:${proposal.period_end}` : null;

/** Earned Turnover Discounts whose period has ended and that have no Credit Note yet. */
function readyTodCreditNotes(data: WorkspaceData) {
  const postingProposalIds = new Set(data.creditNotes.map((posting) => posting.proposal_id));
  return data.proposals.filter((proposal) => proposal.scheme_type === "tod" && proposal.status === "eligible" && !postingProposalIds.has(proposal.id) && periodHasEnded(proposal.period_end));
}

/**
 * Credit Notes can only be created from a Tally check made in the last 15
 * minutes. Check each selected customer against Tally first (three at a time),
 * then create the ones that passed in a single batch.
 */
async function verifyAndCreateCreditNotes(companyId: string, proposalIds: string[], onProgress: (message: string) => void, freshIds: string[] = []) {
  const token = await accessToken();
  if (!token) throw new Error("Sign in again before creating Credit Notes.");
  // Results calculated in the last 5 days skip the Tally re-check; the
  // created voucher is still read back from Tally and verified.
  const verified: string[] = proposalIds.filter((id) => freshIds.includes(id));
  let failed = 0;
  let checked = 0;
  const queue = proposalIds.filter((id) => !freshIds.includes(id));
  onProgress(`Checking Tally… 0 of ${proposalIds.length}`);
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        let { evaluationRun: run } = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${companyId}/evaluations/proposals/${id}/refresh`, { method: "POST", body: jsonBody({}) });
        for (let attempt = 0; attempt < 80 && !["completed", "failed", "completed_with_issues", "cancelled"].includes(run.status); attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 3_000));
          run = (await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${companyId}/evaluations/runs/${run.id}`, { cache: "no-store" })).evaluationRun;
        }
        if (run.status === "completed") verified.push(id); else failed += 1;
      } catch { failed += 1; }
      checked += 1;
      onProgress(`Checking Tally… ${checked} of ${proposalIds.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (!verified.length) return { queued: 0, message: `None of the ${proposalIds.length} selected customers could be checked against Tally. Keep Tally open and try again.` };
  onProgress(`Creating ${verified.length} Credit Note${verified.length === 1 ? "" : "s"}…`);
  try {
    const response = await apiRequest<{ queued: number; skipped: number; message: string }>(token, `/api/companies/${companyId}/evaluations/proposals/bulk-review`, { method: "POST", body: jsonBody({ proposalIds: verified }), timeoutMs: 60_000 });
    const skipped = response.skipped + failed;
    return { queued: response.queued, message: skipped ? `${response.message} ${skipped} could not be created — open them to see why.` : response.message };
  } catch (cause) {
    return { queued: 0, message: userFacingError(cause, "The Credit Notes could not be created.") };
  }
}

/** "on" renders only when on (a small pill for the results header); "off" renders only the full banner when off; default renders either. */
function PostingSwitch({ launchControl, onChanged, onError, show = "any" }: { launchControl: LaunchControl | null; onChanged: (message: string) => Promise<void>; onError: (message: string | null) => void; show?: "any" | "on" | "off" }) {
  const { company, isAdministrator } = useCompany();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [reference, setReference] = useState("");
  const enabled = launchControl?.mode === "posting_enabled";
  if (!isAdministrator || !launchControl) return null;
  if ((show === "on" && !enabled) || (show === "off" && enabled)) return null;

  async function change(mode: "posting_enabled" | "review_only") {
    const token = await accessToken(); if (!token) return;
    setBusy(true); onError(null);
    try {
      await apiRequest(token, `/api/companies/${company.id}/launch-control`, { method: "PATCH", body: jsonBody(mode === "posting_enabled" ? { mode, reconciliationPeriodFrom: from, reconciliationPeriodTo: to, reconciliationReference: reference.trim() || "Checked by administrator" } : { mode }) });
      setOpen(false);
      await onChanged(mode === "posting_enabled" ? "Credit Note creation is on. You can now create Credit Notes in Tally." : "Credit Note creation is off. Nothing new will be created in Tally.");
    } catch (cause) { onError(userFacingError(cause, "Could not change Credit Note creation.")); }
    finally { setBusy(false); }
  }

  return <>
    {enabled && show === "on"
      ? <span className="posting-pill" title={launchControl.postingEnabledAt ? `On since ${formatBusinessDate(launchControl.postingEnabledAt)}` : undefined}><span className="posting-pill-dot" aria-hidden="true" />Credit Notes on<button type="button" disabled={busy} onClick={() => void change("review_only")}>{busy ? "…" : "Turn off"}</button></span>
      : enabled
      ? <p className="posting-switch is-on"><CheckCircle2 size={15} /><span>Credit Note creation is <strong>on</strong>{launchControl.postingEnabledAt ? ` since ${formatBusinessDate(launchControl.postingEnabledAt)}` : ""}.</span><button type="button" disabled={busy} onClick={() => void change("review_only")}>{busy ? "Turning off…" : "Turn off"}</button></p>
      : <div className="posting-switch is-off"><CircleAlert size={17} /><div><strong>Credit Note creation is off</strong><span>Results can be reviewed, but nothing is created in Tally until you turn it on.</span></div><Button onClick={() => setOpen(true)}>Turn on</Button></div>}
    <Dialog open={open} onClose={() => !busy && setOpen(false)} title="Turn on Credit Note creation" description="Record the period you checked against Tally before Credit Notes start being created.">
      <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void change("posting_enabled"); }}>
        <div className="form-grid"><label>Checked from<input type="date" required value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label><label>Checked to<input type="date" required value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label></div>
        <label>Note <small>Optional</small><input value={reference} maxLength={500} placeholder="e.g. Matched with Tally ledger on 23 Sep" onChange={(event) => setReference(event.target.value)} /></label>
        <div className="dialog-actions"><Button type="button" className="button-secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Turning on…" : "Turn on"}</Button></div>
      </form>
    </Dialog>
  </>;
}

type NoteScheme = "all" | "tod" | "cd";
type NoteView = "all" | "not_sent" | "sent" | "creating" | "attention";
/** One Credit Note row, whichever scheme created it. */
type NoteRow = {
  key: string; scheme: "tod" | "cd"; customer: string; amount: number; voucherNumber: string | null; status: string;
  noteDate: string | null; about: string | null; problem: string | null; fix: string | null;
  whatsapp: { status: string; at: string | null; recipient: string | null } | null;
  request: { kind: "credit_note" | "debit_note"; postingId: string }; proposal: Proposal | null;
  why: string | null; invoiceGuid: string | null; messages: CreditNotePanelNote["messages"];
  customerKey: string; group: string | null;
};
const CD_CATEGORY_WHY: Record<string, string> = { full_payment: "Full bill paid on time", discounted_payment: "Discounted amount paid on time", over_ninety_percent: "Paid on time, short by up to ₹10,000" };
const NOTE_SENT = ["sent", "delivered", "read", "whatsapp_sent"];
const NOTE_CREATING = ["queued", "sending", "verification_pending", "sending_to_tally"];

/** What went wrong in Tally, and what to do about it, in plain words. */
function noteProblem(status: string, reason: string | null, companyName: string) {
  if (!["failed", "correction_required", "reconciliation_required"].includes(status)) return { problem: null, fix: null };
  const text = reason ?? "Tally could not confirm this Credit Note.";
  if (/active Tally company does not match/i.test(text)) return { problem: "Previous attempt failed: a different company was active in Tally.", fix: `Check the current connection and confirm ${companyName} is open before any new attempt.` };
  if (/GST ledger/i.test(text)) return { problem: text, fix: "Remove the GST ledger from the Credit Note setup in the rule, then create it again." };
  return { problem: text, fix: status === "reconciliation_required" ? "Check the voucher in Tally, then confirm or cancel it." : "Open it to retry safely." };
}

function noteView(row: NoteRow): Exclude<NoteView, "all"> {
  if (row.problem) return "attention";
  if (NOTE_CREATING.includes(row.status)) return "creating";
  if (row.status !== "created_verified") return "attention";
  if (row.whatsapp && ["failed", "suppressed"].includes(row.whatsapp.status)) return "attention";
  return row.whatsapp && NOTE_SENT.includes(row.whatsapp.status) ? "sent" : "not_sent";
}

function CreditNotesPage({ data, customerNames, refresh, setError, setNotice }: PageProps) {
  const { company } = useCompany();
  const [scheme, setScheme] = useState<NoteScheme>("all");
  const [view, setView] = useState<NoteView>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(50);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [sendTargets, setSendTargets] = useState<WhatsAppTarget[] | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState("all");
  const [layout, setLayout] = useState<"notes" | "customers">("notes");
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [openCustomers, setOpenCustomers] = useState<Set<string>>(new Set());
  const router = useRouter();
  const readyCount = readyTodCreditNotes(data).length;
  const messageForPosting = (postingId: string) => data.messages.find((message) => message.credit_note_posting_id === postingId) ?? null;

  // Each customer's Tally group, as in Tally (from the reference masters).
  const groupOfCustomer = (customerId: string) => {
    const groupId = data.reference?.masters.customers.find((customer) => customer.id === customerId)?.current_customer_group_id;
    return groupId ? data.reference?.masters.customerGroups.find((group) => group.id === groupId)?.name ?? null : null;
  };
  // Turnover Discount and Cash Discount Credit Notes as one list.
  const rows: NoteRow[] = useMemo(() => {
    const tod = data.creditNotes.map((posting): NoteRow => {
      const proposal = data.proposals.find((item) => item.id === posting.proposal_id) ?? null;
      const message = messageForPosting(posting.id);
      const tonnes = Number(proposal?.eligible_tonnes ?? 0);
      const period = proposal?.period_start && proposal.period_end ? `${formatBusinessDate(proposal.period_start)} – ${formatBusinessDate(proposal.period_end)}` : null;
      return {
        key: `tod:${posting.id}`, scheme: "tod", customer: proposal?.customer_name ?? customerNames.get(posting.customer_id) ?? "Customer unavailable",
        amount: Number(posting.verified_amount ?? posting.discount_amount ?? 0), voucherNumber: posting.verified_voucher_number, status: posting.status,
        noteDate: posting.credit_note_date, about: [period, tonnes > 0 ? `${formatTonnes(tonnes)} MT` : null].filter(Boolean).join(" · ") || null,
        ...noteProblem(posting.status, posting.failure_reason ?? posting.reconciliation_reason ?? null, company.tally_company_name),
        whatsapp: message ? { status: message.status, at: message.read_at ?? message.delivered_at ?? message.sent_at ?? message.created_at, recipient: message.recipient_phone_e164 } : null,
        request: { kind: "credit_note", postingId: posting.id }, proposal,
        why: [period ? `Turnover Discount for ${period}` : "Turnover Discount", tonnes > 0 ? `${formatTonnes(tonnes)} MT counted` : null].filter(Boolean).join(" · "),
        invoiceGuid: null,
        customerKey: posting.customer_id,
        group: groupOfCustomer(posting.customer_id),
        messages: data.messages.filter((item) => item.credit_note_posting_id === posting.id).sort((left, right) => right.created_at.localeCompare(left.created_at))
          .map((item) => ({ status: item.status, at: item.read_at ?? item.delivered_at ?? item.sent_at ?? item.created_at, recipient: item.recipient_phone_e164, failureReason: item.failure_reason })),
      };
    });
    const cd = (data.cdCreditNotes ?? []).map((note): NoteRow => ({
      key: `cd:${note.id}`, scheme: "cd", customer: note.customerName ?? "Customer unavailable", amount: Number(note.amount ?? 0),
      voucherNumber: note.voucherNumber, status: note.status, noteDate: note.noteDate,
      about: [note.invoiceNumber ? `Inv ${note.invoiceNumber}` : null, note.invoiceDate ? formatBusinessDate(note.invoiceDate) : null, note.eligibleTonnes ? `${formatTonnes(note.eligibleTonnes)} MT × ₹${Number(note.amountPerTonne ?? 0).toLocaleString("en-IN")}/MT` : null].filter(Boolean).join(" · ") || null,
      ...noteProblem(note.status, note.failureReason, company.tally_company_name),
      whatsapp: note.whatsapp ? { status: note.whatsapp.status, at: note.whatsapp.readAt ?? note.whatsapp.deliveredAt ?? note.whatsapp.sentAt, recipient: note.whatsapp.recipient } : null,
      // Stored with Debit Notes; the server sends it with the Credit Note template.
      request: { kind: "debit_note", postingId: note.id }, proposal: null,
      why: [note.category ? CD_CATEGORY_WHY[note.category] ?? null : null, note.windowDeadline ? `deadline ${formatBusinessDate(note.windowDeadline)}` : null, note.eligibleTonnes ? `${formatTonnes(note.eligibleTonnes)} MT × ₹${Number(note.amountPerTonne ?? 0).toLocaleString("en-IN")}/MT` : null, note.invoiceNumber ? `Inv ${note.invoiceNumber}${note.invoiceDate ? ` dated ${formatBusinessDate(note.invoiceDate)}` : ""}` : null].filter(Boolean).join(" · ") || null,
      invoiceGuid: note.invoiceGuid ?? null,
      customerKey: note.customerId ?? `name:${note.customerName ?? note.id}`,
      group: note.customerGroup ?? null,
      messages: (note.whatsappHistory ?? (note.whatsapp ? [note.whatsapp] : [])).map((item) => ({ status: item.status, at: item.readAt ?? item.deliveredAt ?? item.sentAt ?? item.createdAt ?? null, recipient: item.recipient, failureReason: item.failureReason })),
    }));
    return [...tod, ...cd].sort((left, right) => (right.noteDate ?? "").localeCompare(left.noteDate ?? ""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.creditNotes, data.cdCreditNotes, data.proposals, data.messages, data.reference, customerNames, company.tally_company_name]);

  // Everything below follows the period (Credit Note date), like a Tally register.
  const periodRows = rows.filter((row) => inPeriod(period, row.noteDate));
  const schemeRows = periodRows.filter((row) => scheme === "all" || row.scheme === scheme);
  // Work left outside the period is never silently hidden.
  const openOutside = rows.filter((row) => !inPeriod(period, row.noteDate) && (scheme === "all" || row.scheme === scheme) && ["attention", "not_sent"].includes(noteView(row)));
  const q = query.trim().toLowerCase();
  const groupOptions = [...new Set(schemeRows.map((row) => row.group ?? "No group"))].sort((left, right) => left === "No group" ? 1 : right === "No group" ? -1 : left.localeCompare(right));
  const visible = schemeRows.filter((row) => (view === "all" || noteView(row) === view)
    && (groupFilter === "all" || (row.group ?? "No group") === groupFilter)
    && (!q || `${row.customer} ${row.group ?? ""} ${row.voucherNumber ?? ""} ${row.about ?? ""}`.toLowerCase().includes(q)));
  // By customer: one line per customer, unsent / failed first, then the largest amounts.
  const customers = [...visible.reduce((map, row) => {
    const entry = map.get(row.customerKey) ?? { key: row.customerKey, name: row.customer, group: row.group, rows: [] as NoteRow[] };
    entry.rows.push(row);
    return map.set(row.customerKey, entry);
  }, new Map<string, { key: string; name: string; group: string | null; rows: NoteRow[] }>()).values()].map((customer) => {
    const unsent = customer.rows.filter((row) => row.status === "created_verified" && (!row.whatsapp || !NOTE_SENT.includes(row.whatsapp.status)));
    return { ...customer, total: customer.rows.reduce((sum, row) => sum + row.amount, 0), unsent, attention: customer.rows.filter((row) => noteView(row) === "attention").length };
  }).sort((left, right) => (right.attention - left.attention) || (right.unsent.length - left.unsent.length) || (right.total - left.total));
  const visibleTotal = visible.reduce((total, row) => total + row.amount, 0);
  const schemeCards = (["all", "tod", "cd"] as const).map((key) => {
    const inScheme = periodRows.filter((row) => key === "all" || row.scheme === key);
    return { key, label: key === "all" ? "All Credit Notes" : key === "tod" ? "Turnover Discount" : "Cash Discount", count: inScheme.length, amount: inScheme.reduce((total, row) => total + row.amount, 0), attention: inScheme.filter((row) => noteView(row) === "attention").length };
  });
  const viewCount = (key: Exclude<NoteView, "all">) => schemeRows.filter((row) => noteView(row) === key).length;
  // Keep refreshing while a note is being created or any WhatsApp (Turnover or Cash Discount) is on its way.
  const hasActiveWork = rows.some((row) => NOTE_CREATING.includes(row.status) || ["queued", "sending", "retrying"].includes(row.whatsapp?.status ?? ""));
  const selectable = visible.filter((row) => row.status === "created_verified").map((row) => row.key);
  const allSelected = selectable.length > 0 && selectable.every((key) => selectedKeys.has(key));
  const selectableKey = selectable.join(",");
  useEffect(() => {
    const allowed = new Set(selectableKey ? selectableKey.split(",") : []);
    setSelectedKeys((current) => [...current].every((key) => allowed.has(key)) ? current : new Set([...current].filter((key) => allowed.has(key))));
  }, [selectableKey]);
  useEffect(() => { setShown(50); }, [scheme, view, query, groupFilter, layout, period]);
  const openSend = (keys: string[]) => setSendTargets(rows.filter((row) => keys.includes(row.key) && row.status === "created_verified").map((row) => ({
    key: row.key, customerId: row.proposal?.customer_id ?? (row.customerKey.startsWith("name:") ? null : row.customerKey), customerName: row.customer,
    detail: `${row.voucherNumber ? `Credit Note ${row.voucherNumber}` : "Credit Note"}${row.about ? ` · ${row.about}` : ""}`,
    amount: row.amount, lastMessage: row.whatsapp ? { status: row.whatsapp.status, recipient: row.whatsapp.recipient } : null,
    request: row.request,
  })));
  useEffect(() => {
    if (!hasActiveWork) return;
    const interval = window.setInterval(() => { void refresh(); }, 5_000);
    return () => window.clearInterval(interval);
  }, [hasActiveWork, refresh]);

  const renderNoteRow = (row: NoteRow) => {
        const created = row.status === "created_verified";
        const whatsappState = !created ? { label: "After Tally", tone: "muted" }
          : !row.whatsapp ? { label: "Not sent", tone: "waiting" }
          : ["failed", "suppressed"].includes(row.whatsapp.status) ? { label: "Not delivered", tone: "problem" }
          : NOTE_SENT.includes(row.whatsapp.status) ? { label: row.whatsapp.status === "read" ? "Read" : row.whatsapp.status === "delivered" ? "Delivered" : "Sent", tone: "done" }
          : { label: "Sending…", tone: "active" };
        const tallyState = created ? { label: `No. ${row.voucherNumber ?? "—"}`, tone: "done" } : row.problem ? { label: row.status === "reconciliation_required" ? "Check in Tally" : "Not created", tone: "problem" } : { label: "Creating…", tone: "active" };
        return <div className={`note-table-row${row.problem ? " has-problem" : ""}`} role="row" key={row.key}>
          <span>{created ? <input type="checkbox" aria-label={`Select ${row.customer} for WhatsApp`} checked={selectedKeys.has(row.key)} onChange={() => setSelectedKeys((current) => { const next = new Set(current); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; })} /> : null}</span>
          <div><strong>{row.customer}</strong><small>{row.group && layout === "notes" && <span className="cd-tag note-group-tag">{row.group}</span>}<span className={`note-scheme is-${row.scheme}`}>{row.scheme === "tod" ? "Turnover Discount" : "Cash Discount"}</span>{row.about ? ` ${row.about}` : ""}</small></div>
          <strong className="note-table-amount">{formatMoney(row.amount)}</strong>
          <div><span className={`note-pill is-${tallyState.tone}`}>{tallyState.label}</span><small>{created && row.noteDate ? formatBusinessDate(row.noteDate) : null}</small>{row.problem && <small className="note-table-problem">{row.problem}{row.fix ? <> <strong>{row.fix}</strong></> : null}</small>}</div>
          <div><span className={`note-pill is-${whatsappState.tone}`}>{whatsappState.label}</span>{row.whatsapp?.at && created && <small>{formatDate(row.whatsapp.at)}{row.whatsapp.recipient ? ` · ${row.whatsapp.recipient}` : ""}</small>}</div>
          <div className="note-table-actions">
            {created && <Button className="button-secondary" onClick={() => openSend([row.key])}><Send size={14} />{row.whatsapp ? "Send again" : "Send"}</Button>}
            <Button className="button-quiet" onClick={() => setDetailKey(row.key)}>{row.problem ? "Fix" : "Details"}</Button>
          </div>
        </div>;
  };
  return <div className="credit-notes-page">
    <WorkspacePageHeader eyebrow="" title="Credit Notes" detail="Turnover Discount and Cash Discount Credit Notes created in Tally." action={<IconButton label="Refresh Credit Notes" onClick={() => void refresh()}><RefreshCw size={16} /></IconButton>} />
    {/* Level 1: which notes (scheme tabs) and when (period). Level 2: narrow them. Level 3: the result. */}
    <div className="nf-head">
      <div className="nf-tabs" role="tablist" aria-label="Scheme">
        {schemeCards.filter((card) => card.key === "all" || card.count > 0).map((card) => <button key={card.key} type="button" role="tab" aria-selected={scheme === card.key} className={scheme === card.key ? "is-active" : ""} onClick={() => { setScheme(card.key); setSelectedKeys(new Set()); }}>
          {card.key === "all" ? "All Credit Notes" : card.key === "tod" ? "Turnover Discount" : "Cash Discount"}<span className="nf-count">{card.count}</span>{card.attention > 0 && <span className="nf-dot" title={`${card.attention} need attention`} />}
        </button>)}
      </div>
      <div className="nf-period"><CalendarDays size={15} aria-hidden="true" /><PeriodFilter period={period} basis="Credit Note date" onChange={(next) => { setPeriod(next); setSelectedKeys(new Set()); }} /></div>
    </div>
    <div className="nf-toolbar">
      <div className="nf-seg" role="tablist" aria-label="Status">
        {([["all", "All", schemeRows.length], ["not_sent", "Not sent", viewCount("not_sent")], ["sent", "Sent", viewCount("sent")], ["creating", "Creating", viewCount("creating")], ["attention", "Needs attention", viewCount("attention")]] as const)
          .filter(([key, , total]) => key === "all" || total > 0)
          .map(([key, label, total]) => <button key={key} type="button" role="tab" aria-selected={view === key} className={`${view === key ? "is-active" : ""}${key === "attention" && total > 0 ? " is-alert" : ""}`} onClick={() => { setView(key); setSelectedKeys(new Set()); }}>{label}<span>{total}</span></button>)}
      </div>
      <div className="nf-tools">
        <label className="nf-search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search Credit Notes</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer, CN, invoice" /></label>
        {groupOptions.length > 1 && <label className="nf-select"><span className="sr-only">Customer group</span><select value={groupFilter} onChange={(event) => { setGroupFilter(event.target.value); setSelectedKeys(new Set()); }}><option value="all">All groups</option>{groupOptions.map((group) => <option key={group} value={group}>{group} ({schemeRows.filter((row) => (row.group ?? "No group") === group).length})</option>)}</select></label>}
        <div className="nf-seg nf-icons" role="tablist" aria-label="Layout">
          <button type="button" role="tab" aria-selected={layout === "notes"} className={layout === "notes" ? "is-active" : ""} title="List" onClick={() => setLayout("notes")}><List size={15} /><span className="sr-only">List</span></button>
          <button type="button" role="tab" aria-selected={layout === "customers"} className={layout === "customers" ? "is-active" : ""} title="By customer" onClick={() => setLayout("customers")}><Users size={15} /><span className="sr-only">By customer</span></button>
        </div>
      </div>
    </div>
    <p className="nf-summary">
      <span><strong>{formatMoney(visibleTotal)}</strong> across {visible.length} Credit Note{visible.length === 1 ? "" : "s"}{layout === "customers" ? ` · ${customers.length} customer${customers.length === 1 ? "" : "s"}` : ""}{period.preset !== "all" ? ` · ${periodLabel(period).replace(/^.*\((.*)\)$/, "$1")}` : ""}</span>
      {openOutside.length > 0 && <button type="button" className="inline-link is-attention" onClick={() => setPeriod({ preset: "all", from: "", to: "" })}>{openOutside.length} open outside this period</button>}
      {readyCount > 0 && <Link href="/turnover-discount?view=create">{readyCount} Turnover Discount ready to create →</Link>}
    </p>
    <section className="credit-note-section credit-note-history">
      {!visible.length ? <EmptyState title={rows.length ? "No Credit Notes match this view" : "No Credit Notes yet"} detail={rows.length ? "Change the area, status, group or search." : "Create them from Turnover Discount or Cash Discount."} action={rows.length ? <Button className="button-secondary" onClick={() => { setScheme("all"); setView("all"); setQuery(""); setGroupFilter("all"); }}>Show all</Button> : <Link className="button button-secondary" href="/turnover-discount?view=create">Open Turnover Discount</Link>} />
        : layout === "notes" ? <div className="note-table" role="table" aria-label="Credit Notes"><div className="note-table-head" role="row"><span>{selectable.length > 0 && <input type="checkbox" aria-label="Select all created Credit Notes in view" checked={allSelected} onChange={() => setSelectedKeys(allSelected ? new Set() : new Set(selectable))} />}</span><span>Customer and reason</span><span>Amount</span><span>Tally</span><span>WhatsApp</span><span /></div>{visible.slice(0, shown).map(renderNoteRow)}</div>
        : <div className="note-customers" aria-label="Credit Notes by customer">{customers.slice(0, shown).map((customer) => {
          const open = openCustomers.has(customer.key);
          return <section key={customer.key} className={`note-customer${open ? " is-open" : ""}`}>
            <div className="note-customer-head">
              <button type="button" className="note-customer-toggle" aria-expanded={open} onClick={() => setOpenCustomers((current) => { const next = new Set(current); if (next.has(customer.key)) next.delete(customer.key); else next.add(customer.key); return next; })}>
                <ChevronRight size={15} className="note-customer-caret" />
                <span><strong>{customer.name}</strong><small>{customer.group ?? "No group"} · {customer.rows.length} Credit Note{customer.rows.length === 1 ? "" : "s"}</small></span>
              </button>
              <strong className="note-table-amount">{formatMoney(customer.total)}</strong>
              <span className={`note-pill is-${customer.attention ? "problem" : customer.unsent.length ? "waiting" : "done"}`}>{customer.attention ? `${customer.attention} need attention` : customer.unsent.length ? `${customer.unsent.length} not sent` : "All sent"}</span>
              <div className="note-table-actions">{customer.unsent.length > 0 && <Button className="button-secondary" onClick={() => openSend(customer.unsent.map((row) => row.key))}><Send size={14} />{customer.unsent.length === 1 ? "Send" : `Send all ${customer.unsent.length}`}</Button>}</div>
            </div>
            {open && <div className="note-table note-customer-notes" role="table" aria-label={`${customer.name} Credit Notes`}>{customer.rows.map(renderNoteRow)}</div>}
          </section>;
        })}</div>}
      {selectedKeys.size > 0 && <div className="tod-bulk-bar" role="region" aria-label="Selected Credit Notes">
        <span><strong>{selectedKeys.size} selected</strong> · {formatMoney(rows.filter((row) => selectedKeys.has(row.key)).reduce((total, row) => total + row.amount, 0))}</span>
        <div><button type="button" className="tod-selection-clear" onClick={() => setSelectedKeys(new Set())}>Clear</button><Button onClick={() => openSend([...selectedKeys])}><Send size={14} />Send WhatsApp</Button></div>
      </div>}
      {(layout === "notes" ? visible.length : customers.length) > shown && <div className="note-show-more"><Button className="button-secondary" onClick={() => setShown((value) => value + 50)}>Show more ({(layout === "notes" ? visible.length : customers.length) - shown} left)</Button></div>}
    </section>
    {(() => {
      const row = detailKey ? rows.find((item) => item.key === detailKey) ?? null : null;
      const note: CreditNotePanelNote | null = row ? {
        scheme: row.scheme, postingId: row.request.postingId, customer: row.customer, amount: row.amount, voucherNumber: row.voucherNumber,
        status: row.status, noteDate: row.noteDate, why: row.why, problem: row.problem, fix: row.fix, gstInclusive: row.scheme === "cd", messages: row.messages,
      } : null;
      const openCalculation = !row ? null
        : row.proposal ? () => { setDetailKey(null); setSelected(row.proposal); }
        : row.invoiceGuid ? () => { setDetailKey(null); router.push(`/cash-discount?invoice=${encodeURIComponent(row.invoiceGuid!)}`); }
        : null;
      return <CreditNotePanel note={note} companyId={company.id} onClose={() => setDetailKey(null)} onSend={() => { if (row) { setDetailKey(null); openSend([row.key]); } }}
        onOpenCalculation={openCalculation} calculationLabel={row?.scheme === "cd" ? "Open invoice check" : row?.problem ? "Open and fix" : "Open calculation"} />;
    })()}
    <WhatsAppSendDrawer open={Boolean(sendTargets)} targets={sendTargets ?? []} onClose={() => setSendTargets(null)} onSent={async (count) => { setSelectedKeys(new Set()); setNotice(`${count} WhatsApp message${count === 1 ? "" : "s"} queued.`); await refresh(); }} />
    <ProposalDrawer proposal={selected} onClose={() => setSelected(null)} onChanged={refresh} onError={setError} customerName={selected ? selected.customer_name ?? customerNames.get(selected.customer_id) : undefined} launchMode={data.launchControl?.mode} />
  </div>;
}
