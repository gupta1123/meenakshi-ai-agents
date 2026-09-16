"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowRight, BellRing, CheckCircle2, CircleAlert, ClipboardCheck, Eye, FileCheck2, RefreshCw, Send, Square } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { staffStatusLabel } from "@/lib/staff-status";
import { userFacingDetail, userFacingError, userLabel } from "@/lib/user-copy";
import { supabase } from "@/lib/supabase";
import { runLocalCashDiscount, runLocalTurnoverDiscount, type LocalCdBootstrap, type LocalCdInvoiceCheck, type LocalCdRow, type LocalTodBootstrap, type LocalTodRow } from "@/lib/local-tally";

import { AppShell, WorkspacePageHeader } from "./app-shell";
import { useCompany } from "./company-context";
import { RulebookWorkspace } from "./rulebook-workspace";
import { TallyReadiness, workspaceCanCalculateLive } from "./tally-readiness";
import { useWorkspaceSession, type WorkspaceData } from "./workspace-session";
import { MessagesWorkspace } from "./messages-workspace";
import { GuidedEvaluationQueue } from "./guided-evaluation-queue";
import { GuidedEvaluationDrawer } from "./guided-evaluation-drawer";
import { VerifiedCreditNoteDocument } from "./verified-credit-note-document";
import type { CashDiscountDebitNoteHistory, CashDiscountInvoiceCheck, CashDiscountLiveResult, CashDiscountRecovery, CollectionsPage, CreditNotePosting, EvaluationRun, LaunchControl, MessageTemplate, NotificationHealth, NotificationMessage, OperationsHealth, Proposal, ProposalDetail, ReferenceData, TallyHealth, Voucher } from "./types";
import { Button, Card, Dialog, Drawer, EmptyState, IconButton, InlineMessage, MetricCard, SectionHeading, Skeleton, StatusBadge, formatDate, formatMoney, formatTonnes, labelFor, safePhone } from "./ui";

const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-${Date.now()}`;
const formatBusinessDate = (value: string | null | undefined, fallback = "Not set") => {
  if (!value) return fallback;
  const dateOnly = value.slice(0, 10);
  const date = new Date(`${dateOnly}T00:00:00`);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleDateString(undefined, { dateStyle: "medium" });
};
const emptyData: WorkspaceData = { proposals: [], creditNotes: [], messages: [], messageHealth: null, operations: null, launchControl: null, reference: null, templates: [], overview: null };
void MessagesPage;
void LegacyWorkspace;
void EvaluationQueue;
void EvaluationDrawer;

export async function accessToken() {
  const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

export function WorkspaceEntry({ page, email, signOut }: { page: CollectionsPage; email: string; signOut: () => Promise<void> }) {
  const { health, reloadTally } = useWorkspaceSession();
  const tallyStatus = health?.status ?? "required";
  if (page === "tally") {
    return <AppShell email={email} onSignOut={signOut} tallyStatus={tallyStatus}><TallyReadiness health={health} onRefresh={reloadTally} /></AppShell>;
  }
  const requiresCurrentTallyEvidence = page === "turnover-discount";
  const calculationReady = workspaceCanCalculateLive(health);
  if (requiresCurrentTallyEvidence && !calculationReady) {
    return <AppShell email={email} onSignOut={signOut} tallyStatus={tallyStatus}><ReadinessGate health={health} /></AppShell>;
  }
  return <Workspace page={page} email={email} signOut={signOut} tallyHealth={health} />;
}

function ReadinessGate({ health }: { health: TallyHealth | null }) {
  const { company } = useCompany();
  const companyMismatch = health?.status === "company_mismatch";
  return (
    <div className="workspace-content">
      <WorkspacePageHeader
        eyebrow="Tally connection"
        title={companyMismatch ? "Tally company needs switching" : "Tally not connected"}
        detail={companyMismatch ? `Switch Tally Prime to ${company.tally_company_name}; Meenakshi will continue automatically.` : "Keep Tally Prime and the Meenakshi Tally Connector open to use live discount checks."}
      />
      {companyMismatch && <TallyCompanyMismatchNotice health={health} expectedCompanyName={company.tally_company_name} />}
    </div>
  );
}

function Workspace({ page, email, signOut, tallyHealth }: { page: CollectionsPage; email: string; signOut: () => Promise<void>; tallyHealth: TallyHealth | null }) {
  const { company, companyKey, isAdministrator } = useCompany();
  const { data, loading, error, refresh, setError } = useWorkspaceSession();
  const [notice, setNotice] = useState<string | null>(null);
  const customerNames = useMemo(() => new Map(data.reference?.masters.customers.map((customer) => [customer.id, labelFor(customer)]) ?? []), [data.reference]);
  const pageProps = { data, refresh, setNotice, setError, customerNames, isAdministrator };
  const hasLoadedWorkspace = Boolean(data.overview || data.operations || data.launchControl || data.reference || data.proposals.length || data.creditNotes.length || data.messages.length);
  const tallyEvidenceCurrent = page === "rulebook"
    ? Boolean(tallyHealth?.ready && tallyHealth.sync?.masters.status === "current")
    : workspaceCanCalculateLive(tallyHealth);
  const companyMismatch = tallyHealth?.status === "company_mismatch";

  return <AppShell email={email} onSignOut={signOut} tallyStatus={tallyHealth?.status ?? (loading ? "required" : "bridge_stale")}>
    <div className="workspace-content" key={companyKey}>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : notice ? <InlineMessage tone="success">{notice}</InlineMessage> : null}
      {loading && !hasLoadedWorkspace ? <Skeleton lines={7} /> : companyMismatch ? <TallyCompanyMismatchNotice health={tallyHealth} expectedCompanyName={company.tally_company_name} /> : <>{!tallyEvidenceCurrent && <WorkspaceAvailabilityNotice page={page} />}{page === "control-centre" ? <OverviewPage {...pageProps} /> : page === "cash-discount" || page === "turnover-discount" ? <DiscountPage scheme={page === "cash-discount" ? "cd" : "tod"} {...pageProps} /> : page === "credit-notes" ? <CreditNotesPage {...pageProps} /> : page === "messages" ? <MessagesWorkspace {...pageProps} /> : <RulebookWorkspace {...pageProps} />}</>}
    </div>
  </AppShell>;
}

function TallyCompanyMismatchNotice({ health, expectedCompanyName }: { health: TallyHealth | null; expectedCompanyName: string }) {
  const activeCompanyName = health?.binding?.observedCompanyName || "another company";
  return <InlineMessage tone="warning"><strong>Company context locked.</strong> Tally Prime is open to <strong>{activeCompanyName}</strong>. Switch it to <strong>{expectedCompanyName}</strong>; Meenakshi will update automatically and no data or actions are shown until the companies match.</InlineMessage>;
}

function WorkspaceAvailabilityNotice({ page }: { page: CollectionsPage }) {
  const copy = page === "rulebook"
    ? <>Rulebook records are available. <Link href="/tally">Update company information from Tally</Link> before creating or turning on a rule that uses the latest groups, ledgers, items, or document types.</>
    : page === "messages"
      ? <>Message templates, customer consent, and delivery history are available. Messages can be sent only for approved Credit Notes.</>
    : page === "credit-notes"
        ? <>Credit Note history is available. New calculations and Credit Notes need the latest information from Tally.</>
        : <>Saved workspace information is available. <Link href="/tally">Update company and sales information from Tally</Link> before checking a new Cash Discount or Turnover Discount result.</>;
  return <InlineMessage tone="info"><strong>Tally information needs an update.</strong> {copy}</InlineMessage>;
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

function LegacyWorkspace({ page, email, signOut, tallyHealth }: { page: CollectionsPage; email: string; signOut: () => Promise<void>; tallyHealth: TallyHealth | null }) {
  const { company, companyKey, isAdministrator } = useCompany();
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const token = await accessToken();
    if (!token) return;
    setLoading(true); setError(null);
    const base = `/api/companies/${company.id}`;
    try {
      const shared = await Promise.all([
        apiRequest<{ proposals: Proposal[] }>(token, `${base}/evaluations/proposals`),
        apiRequest<{ creditNotePostings: CreditNotePosting[] }>(token, `${base}/credit-notes`),
        apiRequest<{ messages: NotificationMessage[] }>(token, `${base}/notifications`),
        apiRequest<NotificationHealth>(token, `${base}/notifications/health`),
        apiRequest<OperationsHealth>(token, `${base}/operations/health`),
        apiRequest<{ launchControl: LaunchControl }>(token, `${base}/launch-control`),
      ]);
      const reference = await apiRequest<ReferenceData>(token, `${base}/rulebook/reference-data`).catch(() => null);
      const templates = isAdministrator ? await apiRequest<{ templates: MessageTemplate[] }>(token, `${base}/message-templates`).catch(() => ({ templates: [] })) : { templates: [] };
      setData({ proposals: shared[0].proposals, creditNotes: shared[1].creditNotePostings, messages: shared[2].messages, messageHealth: shared[3], operations: shared[4], launchControl: shared[5].launchControl, reference, templates: templates.templates, overview: null });
    } catch (cause) { setError(userFacingError(cause, "Could not load this company workspace.")); }
    finally { setLoading(false); }
  }, [company.id, isAdministrator]);

  useEffect(() => { setData(emptyData); void refresh(); }, [companyKey, refresh]);
  const customerNames = useMemo(() => new Map(data.reference?.masters.customers.map((customer) => [customer.id, labelFor(customer)]) ?? []), [data.reference]);
  const pageProps = { data, refresh, setNotice, setError, customerNames, isAdministrator };

  return <AppShell email={email} onSignOut={signOut} tallyStatus={tallyHealth?.status ?? (loading ? "required" : "bridge_stale")}>
    <div className="workspace-content" key={companyKey}>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : notice ? <InlineMessage tone="success">{notice}</InlineMessage> : null}
      {loading ? <Skeleton lines={7} /> : page === "control-centre" ? <OverviewPage {...pageProps} /> : page === "cash-discount" || page === "turnover-discount" ? <DiscountPage scheme={page === "cash-discount" ? "cd" : "tod"} {...pageProps} /> : page === "credit-notes" ? <CreditNotesPage {...pageProps} /> : page === "messages" ? <MessagesWorkspace {...pageProps} /> : <RulebookWorkspace {...pageProps} />}
    </div>
  </AppShell>;
}

export type PageProps = { data: WorkspaceData; refresh: () => Promise<void>; setNotice: (value: string | null) => void; setError: (value: string |null) => void; customerNames: Map<string, string>; isAdministrator: boolean };

function OverviewPage({ data, isAdministrator, refresh }: PageProps) {
  const overview = data.overview;
  const recoveryActions = overview?.recoveries.actionCount ?? 0;
  const recoveryReviews = overview?.recoveries.reviewCount ?? 0;
  const recoveryAmount = overview?.recoveries.amount ?? 0;
  const todReviewCount = overview?.turnoverDiscount.reviewCount ?? 0;
  const messagesNeedingAction = (overview?.messages.retrying ?? 0) + (overview?.messages.terminalFailures ?? 0) + (overview?.messages.queued ?? 0);
  const tallyNeedsAttention = Boolean(overview && !overview.tally.ready);
  const actionCount = recoveryActions + recoveryReviews + (todReviewCount > 0 ? 1 : 0) + (messagesNeedingAction > 0 ? 1 : 0) + (tallyNeedsAttention ? 1 : 0);
  const activity = overview?.activity ?? [];

  return <>
    <WorkspacePageHeader eyebrow="Control Centre" title="Overview" action={<IconButton label="Refresh workspace" onClick={() => void refresh()}><RefreshCw size={16} /></IconButton>} />
    {!isAdministrator && <InlineMessage tone="info"><strong>Finance workspace:</strong> Manage discounts, approvals, and WhatsApp notifications. Rules and system configurations are Administrator-controlled.</InlineMessage>}
    <div className="readiness-strip">
      <StatusBadge status={overview?.tally.status ?? "required"} />
      <span>Tally {overview?.tally.ready ? "Connected" : "Attention"}</span>
      {overview?.tally.heartbeatAt && <span>Synced {formatDate(overview.tally.heartbeatAt)}</span>}
      <span className={actionCount ? "actions-badge active" : "actions-badge"}>
        {actionCount === 0 ? "✨ All clear" : `${actionCount} open action${actionCount === 1 ? "" : "s"}`}
      </span>
    </div>

    <div className="metric-grid">
      <MetricCard
        label="Debit Notes to prepare"
        value={recoveryActions}
        detail={recoveryAmount > 0 ? `${formatMoney(recoveryAmount)} pending recovery` : "No pending recoveries"}
        tone={recoveryActions ? "danger" : "good"}
        icon={<FileCheck2 size={19} />}
      />
      <MetricCard
        label="Turnover Discount"
        value={todReviewCount}
        detail={
          (overview?.turnoverDiscount.projectedAmount ?? 0) > 0
            ? `${formatMoney(overview?.turnoverDiscount.projectedAmount ?? 0)} projected`
            : overview?.turnoverDiscount.resultCount
              ? `${overview.turnoverDiscount.resultCount} customer results`
              : "No active calculations"
        }
        tone={todReviewCount ? "attention" : "good"}
        icon={<ClipboardCheck size={19} />}
      />
      <MetricCard
        label="TOD Credit Notes"
        value={overview?.creditNotes.total ?? 0}
        detail={(overview?.creditNotes.awaiting ?? 0) > 0 ? `${overview?.creditNotes.awaiting} awaiting completion` : "All credit notes processed"}
        tone={overview?.creditNotes.awaiting ? "attention" : "good"}
        icon={<Activity size={19} />}
      />
      <MetricCard
        label="Messages needing action"
        value={messagesNeedingAction}
        detail={messagesNeedingAction > 0 ? `${overview?.messages.terminalFailures ?? 0} failed · ${overview?.messages.retrying ?? 0} retrying` : "All messages delivered"}
        tone={messagesNeedingAction ? "attention" : "good"}
        icon={<BellRing size={19} />}
      />
    </div>

    <div className="overview-grid">
      <Card>
        <div className="card-title">
          <h2>Needs Attention</h2>
          <span className="muted-copy">{actionCount ? `${actionCount} open` : "All clear"}</span>
        </div>
        <div className="attention-list">
          {recoveryActions > 0 ? <article><span className="alert-dot critical" /><div><strong>Prepare {recoveryActions} Debit Note{recoveryActions === 1 ? "" : "s"}</strong><p>{formatMoney(recoveryAmount)} recovery required from expired discounts.</p><small>Review affected invoices in Cash Discount.</small></div><Link href="/cash-discount" aria-label="Open Cash Discount"><ArrowRight size={16} /></Link></article> : null}
          {recoveryReviews > 0 ? <article><span className="alert-dot warning" /><div><strong>Review {recoveryReviews} Cash Discount result{recoveryReviews === 1 ? "" : "s"}</strong><p>Decision needed prior to Debit Note preparation.</p><small>Inspect in Cash Discount.</small></div><Link href="/cash-discount" aria-label="Review Cash Discount results"><ArrowRight size={16} /></Link></article> : null}
          {todReviewCount > 0 ? <article><span className="alert-dot warning" /><div><strong>Review {todReviewCount} Turnover Discount result{todReviewCount === 1 ? "" : "s"}</strong><p>Qualified customer results ready for Credit Note creation.</p><small>Inspect in Turnover Discount.</small></div><Link href="/turnover-discount" aria-label="Open Turnover Discount"><ArrowRight size={16} /></Link></article> : null}
          {messagesNeedingAction > 0 ? <article><span className="alert-dot info" /><div><strong>Check {messagesNeedingAction} customer message{messagesNeedingAction === 1 ? "" : "s"}</strong><p>WhatsApp delivery queued or retrying.</p><small>Review in Messages.</small></div><Link href="/messages" aria-label="Open Messages"><ArrowRight size={16} /></Link></article> : null}
          {tallyNeedsAttention ? <article><span className="alert-dot critical" /><div><strong>Tally connection needs attention</strong><p>Bridge handshake required.</p><small>Open Tally connection.</small></div><Link href="/tally" aria-label="Open Tally connection"><ArrowRight size={16} /></Link></article> : null}
          {actionCount === 0 ? (
            <div className="all-clear-box">
              <CheckCircle2 size={20} />
              <div>
                <strong>Everything up to date</strong>
                <p>No open items require Finance attention.</p>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <div className="card-title">
          <h2>Recent Updates</h2>
        </div>
        <div className="timeline">
          {activity.length ? (
            activity.map((item) => (
              <article key={item.id}>
                <span />
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                  <small>{formatDate(item.at)}</small>
                </div>
              </article>
            ))
          ) : (
            <div className="quiet-empty-state">No recent activity recorded</div>
          )}
        </div>
      </Card>
    </div>
  </>;
}

function DiscountPage(props: PageProps & { scheme: "cd" | "tod" }) {
  return props.scheme === "cd" ? <CashDiscountRecoveryPage {...props} /> : <DiscountPageBody {...props} />;
}

function CashDiscountRecoveryPage({ data, setNotice, setError }: PageProps & { scheme: "cd" | "tod" }) {
  const { company, companyKey } = useCompany();
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [recoveries, setRecoveries] = useState<CashDiscountRecovery[]>([]);
  const [previousRuleRecoveries, setPreviousRuleRecoveries] = useState<CashDiscountRecovery[]>([]);
  const [debitNoteHistory, setDebitNoteHistory] = useState<CashDiscountDebitNoteHistory[]>([]);
  const [localInvoiceChecks, setLocalInvoiceChecks] = useState<LocalCdInvoiceCheck[] | null>(null);
  const [resultTab, setResultTab] = useState<"eligible" | "reminders" | "recoveries" | "reconciliation" | "previous" | "history">("eligible");
  const [filter, setFilter] = useState<"all" | "action_required" | "review_required">("all");
  const [query, setQuery] = useState("");
  const [stopping, setStopping] = useState(false);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [queuingReminderKey, setQueuingReminderKey] = useState<string | null>(null);
  const [queuedReminderKeys, setQueuedReminderKeys] = useState<Set<string>>(() => new Set());
  const [reminderMessageStatuses, setReminderMessageStatuses] = useState<Record<string, string>>({});
  const [voucherSyncRunId, setVoucherSyncRunId] = useState<string | null>(null);
  const [syncingCurrentInvoices, setSyncingCurrentInvoices] = useState(false);
  const [debitNoteReconciliationRunId, setDebitNoteReconciliationRunId] = useState<string | null>(null);
  const [reconcilingDebitNoteId, setReconcilingDebitNoteId] = useState<string | null>(null);
  const [localBootstrap, setLocalBootstrap] = useState<LocalCdBootstrap | null>(null);
  const [localChecking, setLocalChecking] = useState(false);
  const postingKeys = useRef(new Map<string, string>());

  const loadRecoveries = useCallback(async () => {
    const token = await accessToken();
    if (!token) return [];
    // These actions can be replaced by the just-finished local Tally check.
    // Never allow an HTTP cache to put an earlier snapshot back on screen
    // after the user refreshes the page.
    const response = await apiRequest<{ recoveries: CashDiscountRecovery[]; previousRuleRecoveries?: CashDiscountRecovery[]; history: CashDiscountDebitNoteHistory[] }>(token, `/api/companies/${company.id}/cash-discount/recoveries`, { cache: "no-store" });
    setRecoveries(response.recoveries);
    setPreviousRuleRecoveries(response.previousRuleRecoveries ?? []);
    setDebitNoteHistory(response.history ?? []);
    return response.recoveries;
  }, [company.id]);
  const loadLatest = useCallback(async () => {
    const token = await accessToken();
    if (!token) return;
    try {
      const response = await apiRequest<{ evaluationRuns: EvaluationRun[] }>(token, `/api/companies/${company.id}/evaluations/runs?schemeType=cd&limit=1&fresh=1`, { cache: "no-store" });
      setRun(response.evaluationRuns[0] ?? null);
      await loadRecoveries();
    } catch (cause) { setError(userFacingError(cause, "Could not load the latest Cash Discount recovery check.")); }
  }, [company.id, loadRecoveries, setError]);
  useEffect(() => { setRun(null); setRecoveries([]); setPreviousRuleRecoveries([]); setDebitNoteHistory([]); setLocalInvoiceChecks(null); setResultTab("eligible"); void loadLatest(); }, [companyKey, loadLatest]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await accessToken();
      if (!token) return;
      try {
        const response = await apiRequest<{ reminders: Array<{ customerName: string; invoiceNumber: string | null; invoiceDate: string; status: string }> }>(token, `/api/companies/${company.id}/notifications/cd-reminder-test`);
        if (cancelled) return;
        setReminderMessageStatuses(Object.fromEntries(response.reminders.map((item) => [`${item.customerName}:${item.invoiceNumber}:${item.invoiceDate}`, item.status])));
      } catch { /* Delivery status is supplementary; do not block the Cash Discount result if it is unavailable. */ }
    })();
    return () => { cancelled = true; };
  }, [company.id, companyKey]);
  const preloadLocalBootstrap = useCallback(async (evaluatedOn?: string) => {
    const token = await accessToken();
    if (!token) throw new Error("Sign in again before checking Cash Discounts.");
    const suffix = evaluatedOn ? `?evaluatedOn=${encodeURIComponent(evaluatedOn)}` : "";
    const bootstrap = await apiRequest<LocalCdBootstrap>(token, `/api/companies/${company.id}/evaluations/cd/local-bootstrap${suffix}`);
    setLocalBootstrap(bootstrap);
    return bootstrap;
  }, [company.id]);
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
    const timer = window.setInterval(() => { void update(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [company.id, loadRecoveries, run, running, setError]);

  const rows = recoveries.filter((row) => (filter === "all" || row.status === filter || (filter === "action_required" && row.status === "posting"))
    && (!query.trim() || `${row.customer_name} ${row.invoice_number ?? ""} ${row.bill_reference}`.toLowerCase().includes(query.trim().toLowerCase())));
  const actionCount = recoveries.filter((row) => ["action_required", "posting"].includes(row.status)).length;
  const reviewCount = recoveries.filter((row) => row.status === "review_required").length;
  const reconciliationPostings = debitNoteHistory.filter((posting) => posting.status === "reconciliation_required");
  const recoveryTotal = recoveries.filter((row) => row.status !== "review_required").reduce((total, row) => total + Number(row.remaining_recovery || 0), 0);
  const openReminders = run?.summary?.openReminderCandidates ?? [];
  const openReminderReady = openReminders.filter((row) => row.status === "ready").length;
  const invoiceChecks: CashDiscountInvoiceCheck[] = localInvoiceChecks ?? run?.summary?.results ?? [];
  const eligibleInvoices = invoiceChecks.filter((row) => row.status === "retained");
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
      setNotice(`Debit Note queued for ${row.customer_name}.`); await loadRecoveries();
    } catch (cause) {
      const latest = await loadRecoveries().catch(() => []);
      if (latest.some((candidate) => candidate.id === row.id && candidate.status === "posting")) {
        setNotice(`Debit Note preparation started for ${row.customer_name}.`);
      } else {
        setError(userFacingError(cause, "Could not prepare this Debit Note. Wait a moment, then try again."));
      }
    }
    finally { setPostingId(null); }
  };
  const reconcileDebitNote = async (posting: CashDiscountDebitNoteHistory) => {
    if (reconcilingDebitNoteId) return;
    setReconcilingDebitNoteId(posting.id); setError(null);
    try {
      const token = await accessToken();
      if (!token) return;
      const response = await apiRequest<{ syncRun: { id: string }; message?: string }>(token,
        `/api/companies/${company.id}/cash-discount/debit-notes/${posting.id}/reconcile`, {
          method: "POST", headers: { "Idempotency-Key": idempotencyKey() },
        });
      setDebitNoteReconciliationRunId(response.syncRun.id);
      setNotice(response.message ?? "Targeted Debit Note Tally check started.");
    } catch (cause) {
      setError(userFacingError(cause, "Could not start the targeted Debit Note Tally check."));
      setReconcilingDebitNoteId(null);
    }
  };
  const queueWhatsAppTestReminder = async (row: typeof openReminders[number]) => {
    if (!run || queuingReminderKey) return;
    const reminderKey = `${row.customerName}:${row.invoiceNumber}:${row.invoiceDate}`;
    setQueuingReminderKey(reminderKey); setError(null);
    try {
      const token = await accessToken();
      if (!token) return;
      const response = await apiRequest<{ state: "queued"; messageId?: string | null; message?: string | null }>(token,
        `/api/companies/${company.id}/notifications/cd-reminder-test`, {
          method: "POST", headers: { "Idempotency-Key": idempotencyKey() },
          body: jsonBody({ evaluationRunId: run.id, customerName: row.customerName, invoiceNumber: row.invoiceNumber, invoiceDate: row.invoiceDate, billReference: row.billReference }),
          timeoutMs: 45_000,
        });
      setNotice(response.message ?? "WhatsApp test reminder queued.");
      if (response.messageId) {
        setQueuedReminderKeys((current) => new Set(current).add(reminderKey));
        setReminderMessageStatuses((current) => ({ ...current, [reminderKey]: "queued" }));
      }
    } catch (cause) {
      setError(userFacingError(cause, "Could not queue this WhatsApp test reminder."));
    } finally {
      setQueuingReminderKey(null);
    }
  };
  const syncCurrentCashDiscountInvoices = async () => {
    if (!run || syncingCurrentInvoices) return;
    if (!run.period_start || !run.period_end) {
      setError("Run Check Cash Discounts first, then synchronize its current invoice range.");
      return;
    }
    setSyncingCurrentInvoices(true); setError(null);
    try {
      const token = await accessToken();
      if (!token) return;
      const response = await apiRequest<{ syncRun: { id: string } }>(token, `/api/companies/${company.id}/sync/vouchers`, {
        method: "POST", headers: { "Idempotency-Key": idempotencyKey() },
        body: jsonBody({ dateFrom: run.period_start, dateTo: run.period_end }),
      });
      setVoucherSyncRunId(response.syncRun.id);
      setNotice("Synchronizing the current Cash Discount invoices from Tally…");
    } catch (cause) {
      setSyncingCurrentInvoices(false);
      setError(userFacingError(cause, "Could not start the Cash Discount invoice sync."));
    }
  };
  useEffect(() => {
    if (!voucherSyncRunId) return;
    let cancelled = false;
    const check = async () => {
      const token = await accessToken();
      if (!token || cancelled) return;
      try {
        const response = await apiRequest<{ syncRun: { status: string; error_summary?: string | null } }>(token, `/api/companies/${company.id}/sync/runs/${voucherSyncRunId}`);
        if (cancelled || !["completed", "completed_with_errors", "failed"].includes(response.syncRun.status)) return;
        setVoucherSyncRunId(null); setSyncingCurrentInvoices(false);
        if (response.syncRun.status === "completed") setNotice("Cash Discount invoices are synchronized. You can now queue the Apex WhatsApp test once.");
        else setError(response.syncRun.error_summary ?? "The invoice synchronization did not complete. Check Tally connection and try again.");
      } catch { /* keep polling while the connector returns the sync result */ }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [company.id, voucherSyncRunId, setError, setNotice]);
  useEffect(() => {
    if (!debitNoteReconciliationRunId) return;
    let cancelled = false;
    const check = async () => {
      const token = await accessToken();
      if (!token || cancelled) return;
      try {
        const response = await apiRequest<{ syncRun: { status: string; error_summary?: string | null } }>(token, `/api/companies/${company.id}/sync/runs/${debitNoteReconciliationRunId}`);
        if (cancelled || !["completed", "completed_with_errors", "failed"].includes(response.syncRun.status)) return;
        setDebitNoteReconciliationRunId(null); setReconcilingDebitNoteId(null);
        await loadRecoveries();
        if (response.syncRun.status === "completed") setNotice("Targeted Debit Note Tally check completed. Review Debit Note history or Tally review.");
        else setError(response.syncRun.error_summary ?? "The targeted Debit Note Tally check did not complete.");
      } catch { /* Continue polling while the bridge returns the scoped result. */ }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [company.id, debitNoteReconciliationRunId, loadRecoveries, setError, setNotice]);
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
    setLocalChecking(true); setError(null);
    setLocalInvoiceChecks(null);
    let result: Awaited<ReturnType<typeof runLocalCashDiscount>>;
    try {
      // A voucher can be added in Tally while this page is open. Never reuse
      // the preloaded snapshot for a user-triggered check: it would omit that
      // newer voucher even though the check reports as completed.
      const bootstrap = await preloadLocalBootstrap(evaluatedOn);
      result = await runLocalCashDiscount(bootstrap);
    } catch (cause) {
      setLocalChecking(false);
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
    setRecoveries(result.rows.map((row) => provisionalRecovery(row, evaluatedOn)));
    setLocalInvoiceChecks(Array.isArray(result.results) ? result.results : []);
    setEvaluationOpen(false);
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
      setNotice(`Cash Discount result saved. ${result.totals.actionRequired} Debit Note action${result.totals.actionRequired === 1 ? "" : "s"} found.`);
    } catch (cause) {
      setError(userFacingError(cause, "The live result is visible, but it could not be saved yet. Run the check again before posting."));
    } finally {
      setLocalChecking(false);
    }
  };
  const activity = running ? run?.status === "queued" ? "Waiting to begin" : run?.status === "evaluating" ? "Calculating recoveries" : "Reading invoices, receipts, and Debit Notes" : run?.completed_at ? `Checked ${formatDate(run.completed_at)}` : "No completed check yet";

  return <>
    <WorkspacePageHeader eyebrow="Cash Discount" title="Cash Discount recovery" detail="Review open reminders and expired discounts." action={running ? <Button className="button-secondary" disabled={stopping} onClick={() => void stopRun()}><Square size={15} />{stopping ? "Stopping…" : "Stop check"}</Button> : <Button className="button-secondary" onClick={() => setEvaluationOpen(true)}><RefreshCw size={15} />Check latest Tally</Button>} />
    {running && <InlineMessage tone="info"><strong>Checking current Tally.</strong> The current list stays visible until the update is saved.</InlineMessage>}
    {run?.status === "failed" && <InlineMessage tone="error">{userFacingDetail(run.summary?.message ?? run.error_summary, "The check did not finish. Your previous recovery actions were not changed.")}</InlineMessage>}
    {run?.status === "cancelled" && <InlineMessage tone="warning">This check was stopped. Previous recovery actions were kept.</InlineMessage>}
    <div className="cd-live-overview cd-recovery-overview"><div className="cd-run-state"><StatusBadge status={running && run ? run.status : "ready"} /><span>{activity}</span></div><div><strong>{run?.summary?.invoicesChecked ?? 0}</strong><span>Invoices checked</span></div><div><strong>{openReminderReady}</strong><span>Open reminders to review</span></div><div className="is-danger"><strong>{actionCount}</strong><span>Debit Notes to prepare</span></div><div className="is-danger"><strong>{formatMoney(recoveryTotal)}</strong><span>Amount to recover</span></div><div className="is-warning"><strong>{reviewCount}</strong><span>Needs review</span></div></div>
    <div className="segmented evaluation-view-tabs" aria-label="Cash Discount result views"><button className={resultTab === "eligible" ? "selected" : ""} onClick={() => setResultTab("eligible")}>Eligible invoices {eligibleInvoices.length}</button><button className={resultTab === "reminders" ? "selected" : ""} onClick={() => setResultTab("reminders")}>Open reminders {openReminders.length}</button><button className={resultTab === "recoveries" ? "selected" : ""} onClick={() => setResultTab("recoveries")}>Recovery actions {recoveries.length}</button><button className={resultTab === "reconciliation" ? "selected" : ""} onClick={() => setResultTab("reconciliation")}>Tally review {reconciliationPostings.length}</button><button className={resultTab === "previous" ? "selected" : ""} onClick={() => setResultTab("previous")}>Previous rule {previousRuleRecoveries.length}</button><button className={resultTab === "history" ? "selected" : ""} onClick={() => setResultTab("history")}>Debit Note history {debitNoteHistory.length}</button></div>
    {resultTab === "eligible" && <Card className="cd-live-results"><div className="card-title"><div><h2>Eligible Cash Discounts</h2></div></div>
      {eligibleInvoices.length ? <div className="data-table cd-live-table"><div className="table-head"><span>Customer and invoice</span><span>Payment received</span><span>Cash Discount</span><span>Verified from Tally</span></div>{eligibleInvoices.map((row) => <article key={row.invoiceGuid} className="cd-result-row is-retained"><div><strong>{row.customerName}</strong><small>Invoice {row.invoiceNumber ?? "—"} · {formatBusinessDate(row.invoiceDate)}</small></div><div><strong>{formatMoney(row.amountPaid)} of {formatMoney(row.invoiceAmount)}</strong><small>{row.paymentCount === 1 ? "1 receipt" : `${row.paymentCount} receipts`} · no amount outstanding</small></div><div><StatusBadge status="retained" /><small>{row.earnedDiscountPercentage}% of {row.discountPercentage}% earned</small></div><div><strong>{formatBusinessDate(row.latestPaymentDate, "Payment date unavailable")}</strong><small>Payment deadline {formatBusinessDate(row.eligibilityDeadline)}</small></div></article>)}</div> : <EmptyState title={running ? "Checking Tally" : "No eligible Cash Discounts"} detail={running ? "Eligible invoices will appear when the current check finishes." : run ? "The latest check found no invoice paid in full within its Cash Discount window." : "Run Check Cash Discounts to see invoices that retain their discount."} action={!running && !run ? <Button onClick={() => setEvaluationOpen(true)}>Check Cash Discounts</Button> : undefined} />}
    </Card>}
    {resultTab === "reminders" && <Card className="cd-live-results"><div className="card-title"><div><h2>Open invoice reminders</h2><p className="muted-copy">Test delivery: Apex Rebar Projects only.</p></div></div>
      <div className="data-table cd-live-table cd-recovery-table"><div className="table-head"><span>Customer and invoice</span><span>Payment status</span><span>Deadline</span><span>WhatsApp test</span></div>{openReminders.map((row) => { const reminderKey = `${row.customerName}:${row.invoiceNumber}:${row.invoiceDate}`; const messageStatus = reminderMessageStatuses[reminderKey]; const queued = queuedReminderKeys.has(reminderKey) || ["queued", "sending", "sent", "delivered", "read"].includes(messageStatus); const sentLabel = messageStatus === "sent" ? "WhatsApp sent" : messageStatus === "delivered" ? "WhatsApp delivered" : messageStatus === "read" ? "WhatsApp read" : "WhatsApp queued"; return <article key={`${row.billReference}:${row.invoiceDate}`} className={`cd-result-row is-${row.status}`}><div><strong>{row.customerName}</strong><small>Invoice {row.invoiceNumber ?? "—"} · {formatBusinessDate(row.invoiceDate)}</small></div><div><strong>Paid {formatMoney(row.amountPaid)}</strong><small>{formatMoney(row.shortfallAmount)} still to settle</small></div><div><strong>{formatBusinessDate(row.eligibilityDeadline)}</strong><small>Cash Discount payment deadline</small></div><div>{row.status === "ready" ? <Button className="button-secondary" disabled={Boolean(queuingReminderKey) || queued} onClick={() => void queueWhatsAppTestReminder(row)}>{queued ? sentLabel : queuingReminderKey === reminderKey ? "Preparing…" : "Queue test WhatsApp"}</Button> : <><StatusBadge status="needs_review" /><small>{row.reviewMessage ?? "Review before messaging."}</small></>}</div></article>; })}</div>
      {!openReminders.length && <EmptyState title={running ? "Checking Tally" : "No open invoice reminders"} detail={running ? "Open invoices will appear when the current check finishes." : "The latest check found no unpaid invoices still inside a Cash Discount payment window."} />}
    </Card>}
    {resultTab === "recoveries" && <Card className="cd-live-results"><div className="card-title"><div><h2>Recovery actions</h2><p className="muted-copy">Expired discounts only.</p></div></div>
      <div className="queue-toolbar"><label className="queue-search"><span>Find customer or invoice</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer or invoice" /></label><div className="segmented"><button className={filter === "action_required" ? "selected" : ""} onClick={() => setFilter("action_required")}>Actions {actionCount}</button><button className={filter === "review_required" ? "selected" : ""} onClick={() => setFilter("review_required")}>Review {reviewCount}</button><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All {recoveries.length}</button></div></div>
      {rows.length ? <div className="data-table cd-live-table cd-recovery-table"><div className="table-head"><span>Customer and invoice</span><span>Missed window</span><span>Recovery amount</span><span>Action</span></div>{rows.map((row) => <article key={row.id} className={`cd-result-row is-${row.status}`}><div><strong>{row.customer_name}</strong><small>Invoice {row.invoice_number ?? "—"} · {formatBusinessDate(row.invoice_date)}</small><small>Net {formatMoney(row.net_invoice_amount)} · Paid {formatMoney(row.amount_paid)}</small></div><div><strong>{row.granted_discount_percentage}% granted → {row.earned_discount_percentage}% earned</strong><small>{row.missed_window_working_days}-day window ended {formatBusinessDate(row.missed_window_deadline)}</small>{row.next_window_working_days && <small>Next: {row.next_window_percentage}% within {row.next_window_working_days} working days</small>}</div><div><strong>{formatMoney(row.remaining_recovery)}</strong><small>Required {formatMoney(row.recovery_required)}</small><small>Existing Debit Notes {formatMoney(row.already_recovered)}</small></div><div>{row.status === "review_required" ? <><StatusBadge status="needs_review" /><small>{row.review_message ?? "Review before posting."}</small></> : <Button disabled={row.status === "posting" || postingId === row.id} onClick={() => void prepareDebitNote(row)}>{row.status === "posting" || postingId === row.id ? "Preparing…" : "Prepare Debit Note"}</Button>}</div></article>)}</div> : <EmptyState title={running ? "Checking Tally" : "No recovery is required"} detail={running ? "The latest actions will replace this view only after the check succeeds." : "The latest successful check found no expired Cash Discount to recover."} action={!running && !run ? <Button onClick={() => setEvaluationOpen(true)}>Check Cash Discounts</Button> : undefined} />}
    </Card>}
    {resultTab === "reconciliation" && <Card className="cd-live-results"><div className="card-title"><div><h2>Tally reconciliation</h2><p className="muted-copy">These Debit Notes no longer match the latest Tally status. No replacement is created automatically.</p></div></div>
      {reconciliationPostings.length ? <div className="data-table cd-live-table cd-recovery-table"><div className="table-head"><span>Customer and invoice</span><span>Recorded Debit Note</span><span>Amount</span><span>Required action</span></div>{reconciliationPostings.map((posting) => <article key={posting.id} className="cd-result-row is-review_required"><div><strong>{posting.candidate?.customer_name ?? "Customer record"}</strong><small>Invoice {posting.candidate?.invoice_number ?? "—"} · {formatBusinessDate(posting.candidate?.invoice_date)}</small></div><div><strong>{posting.verified_voucher_number ? `Debit Note ${posting.verified_voucher_number}` : "Tally voucher"}</strong><small>Last checked {formatDate(posting.last_reconciled_at)}</small></div><div><strong>{formatMoney(posting.verified_amount ?? posting.amount)}</strong><small>{posting.calculation_reference}</small></div><div><StatusBadge status="needs_review" /><small>{posting.reconciliation_reason ?? "Confirm the voucher in Tally before recording any correction."}</small><small>Finance must decide the correction; a new Debit Note is blocked.</small></div></article>)}</div> : <EmptyState title="No Tally reconciliation needed" detail="Every recorded Debit Note agrees with the latest Tally snapshot." />}
    </Card>}
    {resultTab === "previous" && <Card className="cd-live-results"><div className="card-title"><div><h2>Previous rule recoveries</h2><p className="muted-copy">These were found under an earlier Cash Discount rule. Review them against the current rule before posting anything.</p></div></div>
      {previousRuleRecoveries.length ? <div className="data-table cd-live-table cd-recovery-table"><div className="table-head"><span>Customer and invoice</span><span>Earlier check</span><span>Recovery amount</span><span>Next step</span></div>{previousRuleRecoveries.map((row) => <article key={row.id} className="cd-result-row is-review_required"><div><strong>{row.customer_name}</strong><small>Invoice {row.invoice_number ?? "—"} · {formatBusinessDate(row.invoice_date)}</small><small>{row.bill_reference}</small></div><div><strong>Checked {formatBusinessDate(row.evaluated_on)}</strong><small>{row.granted_discount_percentage}% granted → {row.earned_discount_percentage}% earned</small></div><div><strong>{formatMoney(row.remaining_recovery)}</strong><small>Earlier rule result</small></div><div><StatusBadge status="needs_review" /><small>Read-only historical result. Run a current Tally check before deciding on a Debit Note.</small></div></article>)}</div> : <EmptyState title="No previous rule recoveries" detail="Unresolved actions from a former rule will appear here for review instead of disappearing." />}
    </Card>}
    {resultTab === "history" && <Card className="cd-live-results"><div className="card-title"><div><h2>Debit Note history</h2><p className="muted-copy">Recorded Tally Debit Notes stay here after the recovery action is complete.</p></div></div>
      {debitNoteHistory.length ? <div className="data-table cd-live-table cd-recovery-table"><div className="table-head"><span>Customer and invoice</span><span>Debit Note</span><span>Amount</span><span>Status</span></div>{debitNoteHistory.map((posting) => <article key={posting.id} className={`cd-result-row is-${posting.status}`}><div><strong>{posting.candidate?.customer_name ?? "Customer record"}</strong><small>Invoice {posting.candidate?.invoice_number ?? "—"} · {formatBusinessDate(posting.candidate?.invoice_date)}</small><small>{posting.calculation_reference}</small></div><div><strong>{posting.verified_voucher_number ? `Debit Note ${posting.verified_voucher_number}` : "Awaiting Tally confirmation"}</strong><small>{posting.verified_at ? `Verified ${formatDate(posting.verified_at)}` : `Created ${formatDate(posting.created_at)}`}</small></div><div><strong>{formatMoney(posting.verified_amount ?? posting.amount)}</strong><small>Recovery required {formatMoney(posting.candidate?.recovery_required ?? posting.amount)}</small></div><div><StatusBadge status={posting.status} /><small>{posting.reconciliation_reason ?? posting.failure_reason ?? (posting.status === "created_verified" ? "Verified against Tally." : "No further action is available here.")}</small>{posting.status === "created_verified" ? <Button className="button-quiet" disabled={Boolean(reconcilingDebitNoteId)} onClick={() => void reconcileDebitNote(posting)}><RefreshCw size={14} />{reconcilingDebitNoteId === posting.id ? "Checking Tally…" : "Verify in Tally"}</Button> : null}</div></article>)}</div> : <EmptyState title="No Debit Note history" detail="Verified and in-progress Debit Notes will remain visible here." />}
    </Card>}
    <GuidedEvaluationDrawer open={evaluationOpen} onClose={() => setEvaluationOpen(false)} scheme="cd" activeRun={running ? run : null} onComplete={async (message, submittedRun) => { setRun(submittedRun); setNotice(message); setEvaluationOpen(false); }} onError={setError} onCashDiscountSubmit={runLocalCheck} />
  </>;
}

function CashDiscountPage({ data, setNotice, setError }: PageProps & { scheme: "cd" | "tod" }) {
  const { company, companyKey } = useCompany();
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [filter, setFilter] = useState<"all" | CashDiscountLiveResult["status"]>("all");
  const [query, setQuery] = useState("");
  const [stopping, setStopping] = useState(false);
  const inFlight = useRef(false);
  const loadLatest = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = await accessToken();
    if (!token) { inFlight.current = false; return; }
    try {
      const response = await apiRequest<{ evaluationRuns: EvaluationRun[] }>(token, `/api/companies/${company.id}/evaluations/runs?schemeType=cd&limit=1`);
      setRun(response.evaluationRuns[0] ?? null);
    } catch (cause) { setError(userFacingError(cause, "Could not load the latest Cash Discount check.")); }
    finally { inFlight.current = false; }
  }, [company.id, setError]);
  useEffect(() => { setRun(null); void loadLatest(); }, [companyKey, loadLatest]);
  useEffect(() => {
    if (!run || ["completed", "completed_with_issues", "failed", "cancelled"].includes(run.status)) return;
    let polling = false;
    const loadCurrent = async () => {
      if (polling || document.visibilityState !== "visible") return;
      polling = true;
      const token = await accessToken();
      try {
        if (!token) return;
        const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/runs/${run.id}`);
        setRun(response.evaluationRun);
      } catch (cause) { setError(userFacingError(cause, "Could not update the Cash Discount check.")); }
      finally { polling = false; }
    };
    const interval = window.setInterval(() => { void loadCurrent(); }, 3_000);
    return () => window.clearInterval(interval);
  }, [company.id, run, setError]);
  const currentStatuses = new Set<CashDiscountLiveResult["status"]>(["retained", "payment_due", "recovery_due", "tracking"]);
  // This retired view is kept only for compatibility with the former
  // single-list CD experience. The active CD screen renders the new, smaller
  // invoice-check shape above.
  const results = ((run?.summary?.results ?? []) as unknown as CashDiscountLiveResult[]).filter((row) => currentStatuses.has(row.status));
  const rows = results.filter((row) => (filter === "all" || row.status === filter) && (!query.trim() || `${row.customerName} ${row.invoiceNumber ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())));
  const statusCount = (status: CashDiscountLiveResult["status"]) => results.filter((row) => row.status === status).length;
  const actionLabel = (row: CashDiscountLiveResult) => row.recommendedAction === "debit_note" ? "Create Debit Note" : row.recommendedAction === "send_reminder" ? "Send payment reminder" : row.recommendedAction === "wait" ? "Monitor payment" : "No action required";
  const resultDetail = (row: CashDiscountLiveResult) => row.status === "retained"
    ? `Paid in full within ${row.retainedSlab?.workingDays ?? row.applicableSlab.workingDays} working days`
    : row.status === "payment_due"
      ? `${formatMoney(row.outstandingAmount)} due by ${formatBusinessDate(row.applicableSlab.deadline)}`
      : row.status === "recovery_due"
        ? `Payment deadline passed on ${formatBusinessDate(row.applicableSlab.deadline)}`
        : `Payment due by ${formatBusinessDate(row.applicableSlab.deadline)}`;
  const actionDetail = (row: CashDiscountLiveResult) => row.status === "retained"
    ? `${formatMoney(row.discountAtRisk)} Cash Discount is safely retained.`
    : row.status === "payment_due"
      ? `Collect ${formatMoney(row.outstandingAmount)} so the customer keeps the discount.`
      : row.status === "recovery_due"
        ? `Recover ${formatMoney(row.debitNoteAmount)} of Cash Discount.`
        : row.amountPaid === "0.0000"
          ? `${formatMoney(row.discountAtRisk)} Cash Discount remains at risk.`
          : `${formatMoney(row.outstandingAmount)} remains unpaid; ${formatMoney(row.discountAtRisk)} is at risk.`;
  const paymentPercent = (row: CashDiscountLiveResult) => {
    const invoiceAmount = Number(row.invoiceAmount);
    if (!Number.isFinite(invoiceAmount) || invoiceAmount <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((Number(row.amountPaid) / invoiceAmount) * 100)));
  };
  const running = Boolean(run && !["completed", "completed_with_issues", "failed", "cancelled"].includes(run.status));
  const stopRun = async () => {
    if (!run || !running || stopping) return;
    setStopping(true); setError(null);
    try {
      const token = await accessToken();
      if (!token) return;
      const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/runs/${run.id}/cancel`, { method: "POST" });
      setRun(response.evaluationRun);
      setNotice("Cash Discount check stopped.");
    } catch (cause) { setError(userFacingError(cause, "Could not stop this Cash Discount check.")); }
    finally { setStopping(false); }
  };
  const activityDetail = !running
    ? run?.completed_at ? `Checked ${formatDate(run.completed_at)}` : "No completed check yet"
    : run?.status === "queued" ? "Waiting to begin"
    : run?.status === "refreshing_tally" ? "Reading invoices and receipts"
    : run?.status === "evaluating" ? "Applying Cash Discount rules"
    : "Cash Discount check in progress";
  return <>
    <WorkspacePageHeader eyebrow="Cash Discount" title="Cash Discount" detail="Confirm whether customers kept the Cash Discount already included in their invoices." action={running ? <Button className="button-secondary" disabled={stopping} onClick={() => void stopRun()}><Square size={15} />{stopping ? "Stopping…" : "Stop check"}</Button> : <IconButton label="Check Cash Discounts" onClick={() => setEvaluationOpen(true)}><ClipboardCheck size={17} /></IconButton>} />
    {running && <InlineMessage tone="info"><strong>Reading current invoices and receipts from Tally.</strong> This page will update automatically when the check finishes.</InlineMessage>}
    {run?.status === "failed" && <InlineMessage tone="error">{userFacingDetail(run.summary?.message ?? run.error_summary, "The Cash Discount check did not finish. Keep Tally open and try again.")}</InlineMessage>}
    {run?.status === "cancelled" && <InlineMessage tone="warning">This Cash Discount check was stopped. No results were changed.</InlineMessage>}
    <div className="cd-live-overview">
      <div className="cd-run-state"><StatusBadge status={running && run ? run.status : data.operations?.tally.ready ? "ready" : "required"} /><span>{activityDetail}</span></div>
      <div><strong>{run?.summary?.invoicesChecked ?? 0}</strong><span>Invoices checked</span></div>
      <div className="is-success"><strong>{run?.summary?.retained ?? 0}</strong><span>Discount retained</span></div>
      <div className="is-warning"><strong>{run?.summary?.paymentDue ?? 0}</strong><span>Reminders to send</span></div>
      <div><strong>{run?.summary?.tracking ?? 0}</strong><span>Payments to monitor</span></div>
      <div className="is-danger"><strong>{run?.summary?.recoveryDue ?? 0}</strong><span>Debit Notes · {formatMoney(run?.summary?.debitNoteAmount ?? 0)}</span></div>
    </div>
    <Card className="cd-live-results">
      <div className="card-title"><div><h2>Invoice payment checks</h2><p className="muted-copy">Each invoice already includes Cash Discount. Review whether it is retained, still at risk, or must be recovered.</p></div><span className="table-count">{rows.length} shown</span></div>
      <div className="queue-toolbar"><label className="queue-search"><span>Find customer or invoice</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer or invoice" /></label><div className="segmented" aria-label="Cash Discount result filters"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All {results.length}</button><button className={filter === "payment_due" ? "selected" : ""} onClick={() => setFilter("payment_due")}>Reminders {statusCount("payment_due")}</button><button className={filter === "recovery_due" ? "selected" : ""} onClick={() => setFilter("recovery_due")}>Debit Notes {statusCount("recovery_due")}</button><button className={filter === "tracking" ? "selected" : ""} onClick={() => setFilter("tracking")}>Monitoring {statusCount("tracking")}</button><button className={filter === "retained" ? "selected" : ""} onClick={() => setFilter("retained")}>Closed {statusCount("retained")}</button></div></div>
      {rows.length ? <div className="data-table cd-live-table"><div className="table-head"><span>Customer and invoice</span><span>Payment progress</span><span>Decision</span><span>Next action</span></div>{rows.map((row) => {
        const progress = paymentPercent(row);
        return <article key={row.invoiceGuid} className={`cd-result-row is-${row.status}`}><div><strong>{row.customerName}</strong><small>Invoice {row.invoiceNumber ?? "—"} · {formatBusinessDate(row.invoiceDate)}</small></div><div className="cd-payment-progress"><div><strong>{formatMoney(row.amountPaid)} of {formatMoney(row.invoiceAmount)}</strong><span>{progress}%</span></div><span className="cd-progress-track" aria-label={`${progress}% paid`}><span style={{ width: `${progress}%` }} /></span><small>{formatMoney(row.outstandingAmount)} balance · {row.paymentCount === 0 ? "No receipts" : row.paymentCount === 1 ? "1 receipt" : `${row.paymentCount} receipts`}</small></div><div><StatusBadge status={row.status} /><small>{resultDetail(row)}</small><small className="cd-risk-copy">Cash Discount: {formatMoney(row.discountAtRisk)}</small></div><div><strong>{actionLabel(row)}</strong><small>{actionDetail(row)}</small></div></article>;
      })}</div> : <EmptyState title={running ? "Checking Tally" : results.length ? "No results match this view" : "No Cash Discount check yet"} detail={running ? "Current results will appear here automatically." : results.length ? "Choose All or change your search." : "Run a live check to review invoice payments and identify reminders or Debit Notes."} action={!running && !results.length ? <Button onClick={() => setEvaluationOpen(true)}>Check Cash Discounts</Button> : undefined} />}
    </Card>
    <GuidedEvaluationDrawer open={evaluationOpen} onClose={() => setEvaluationOpen(false)} scheme="cd" activeRun={running ? run : null} onComplete={async (message, submittedRun) => { setRun(submittedRun); setNotice(message); setEvaluationOpen(false); }} onError={setError} />
  </>;
}

function DiscountPageBody({ scheme, data, refresh, setNotice, setError, customerNames }: PageProps & { scheme: "cd" | "tod" }) {
  const { company } = useCompany();
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [showEvaluationQueue, setShowEvaluationQueue] = useState(false);
  const [latestRun, setLatestRun] = useState<EvaluationRun | null>(null);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState(scheme === "tod" ? "tier" : "all");
  const [localTodBootstrap, setLocalTodBootstrap] = useState<LocalTodBootstrap | null>(null);
  const [localTodRows, setLocalTodRows] = useState<Proposal[]>([]);
  const savedRows = data.proposals.filter((proposal) => proposal.scheme_type === scheme);
  const localKeys = new Set(localTodRows.map((proposal) => proposal.entitlement_key).filter(Boolean));
  const allRows = scheme === "tod" ? [...localTodRows, ...savedRows.filter((proposal) => !proposal.entitlement_key || !localKeys.has(proposal.entitlement_key))] : savedRows;

  const preloadLocalTodBootstrap = useCallback(async (asOfDate?: string) => {
    const token = await accessToken();
    if (!token) throw new Error("Sign in again before calculating Turnover Discounts.");
    const suffix = asOfDate ? `?asOfDate=${encodeURIComponent(asOfDate)}` : "";
    const bootstrap = await apiRequest<LocalTodBootstrap>(token, `/api/companies/${company.id}/evaluations/tod/local-bootstrap${suffix}`);
    setLocalTodBootstrap(bootstrap);
    return bootstrap;
  }, [company.id]);
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
    try {
      // Rule periods can differ between customers because a prior TOD result
      // locks its period. Always refresh the lightweight bootstrap before
      // reading Tally so each group is calculated against the right period.
      const bootstrap = await preloadLocalTodBootstrap(asOfDate);
      const result = await runLocalTurnoverDiscount(bootstrap);
      setLocalTodRows(result.rows.map(provisionalTodProposal));
      setShowEvaluationQueue(false);
      setEvaluationOpen(false);
      setNotice("Current Tally results are ready. Saving the verified result in the background.");
      const token = await accessToken();
      if (!token) return;
      const entitlementKeys = new Set(result.rows.map((row) => row.entitlementKey));
      void apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/tod/local-result`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: jsonBody({ asOfDate, evaluatedOn: bootstrap.evaluatedOn, evidence: result.evidence }),
        timeoutMs: 60_000,
      }).then((response) => {
        setLatestRun(response.evaluationRun);
        setNotice("Turnover Discount results are ready and the audit record is being finalized.");
        // The server creates one durable result per customer. Replace the
        // temporary local rows as soon as every corresponding saved record
        // is available, so every customer name and drawer is usable.
        void (async () => {
          for (let attempt = 0; attempt < 12; attempt += 1) {
            if (attempt) await new Promise((resolve) => window.setTimeout(resolve, 2_000));
            const saved = await apiRequest<{ proposals: Proposal[] }>(token, `/api/companies/${company.id}/evaluations/proposals?schemeType=tod&limit=500`);
            const savedKeys = new Set(saved.proposals.map((proposal) => proposal.entitlement_key).filter((key): key is string => Boolean(key)));
            if ([...entitlementKeys].every((key) => savedKeys.has(key))) {
              setLocalTodRows([]);
              await refresh();
              setNotice("Turnover Discount results are saved. Open any customer to view the calculation.");
              return;
            }
          }
          await refresh();
          setNotice("The latest Tally result is still being saved. Use History to check it, then refresh this page.");
        })().catch((cause) => setError(userFacingError(cause, "The latest Tally result was calculated but the saved record could not be checked.")));
      }).catch((cause) => setError(userFacingError(cause, "The live result is visible, but it could not be saved yet. Run the calculation again before creating Credit Notes.")));
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
      });
      setLatestRun(response.evaluationRun);
      setShowEvaluationQueue(true);
      setEvaluationOpen(false);
      setNotice("The installed connector needs the latest update. The compatible calculation has started in the background.");
    }
  };
  const statuses = Array.from(new Set(allRows.map((proposal) => proposal.status)));
  const tonnes = (proposal: Proposal) => Number(proposal.eligible_tonnes ?? "0") || 0;
  const withActivity = allRows.filter((proposal) => tonnes(proposal) > 0).length;
  const tiersReached = allRows.filter((proposal) => tonnes(proposal) > 0 && Boolean(proposal.achieved_tier_id)).length;
  const noActivity = allRows.length - withActivity;
  const buildingTowardTier = allRows.filter((proposal) => tonnes(proposal) > 0 && !proposal.achieved_tier_id).length;
  const readyToFinalize = allRows.filter((proposal) => ["eligible", "pending_approval"].includes(proposal.status)).length;
  const reviewing = allRows.filter((proposal) => ["needs_review", "review_invalidated", "pending_approval"].includes(proposal.status)).length;
  const estimatedDiscount = allRows.reduce((total, proposal) => total + (Number(proposal.calculated_discount_amount) || 0), 0);
  const periodRow = allRows.find((proposal) => proposal.period_start && proposal.period_end);
  const periodLabel = periodRow?.period_start && periodRow.period_end ? `${formatBusinessDate(periodRow.period_start)} – ${formatBusinessDate(periodRow.period_end)}` : "Current rule period";
  const periodEnded = periodRow?.period_end ? new Date(`${periodRow.period_end.slice(0, 10)}T23:59:59`).getTime() < Date.now() : false;
  const lastChecked = allRows.map((proposal) => proposal.latest_evaluated_at).filter(Boolean).sort().at(-1) ?? null;
  const matchesTodFilter = (proposal: Proposal) => {
    if (statusFilter === "tier") return Boolean(proposal.achieved_tier_id);
    if (statusFilter === "building") return tonnes(proposal) > 0 && !proposal.achieved_tier_id;
    if (statusFilter === "review") return ["needs_review", "review_invalidated", "pending_approval"].includes(proposal.status);
    if (statusFilter === "no_activity") return tonnes(proposal) === 0;
    return true;
  };
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
  }).sort((left, right) => priority(left) - priority(right) || tonnes(right) - tonnes(left) || (left.customer_name ?? customerNames.get(left.customer_id) ?? "").localeCompare(right.customer_name ?? customerNames.get(right.customer_id) ?? ""));
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
  return <><WorkspacePageHeader eyebrow={scheme === "cd" ? "Cash Discount" : "Turnover Discount"} title={title} detail={scheme === "cd" ? "Latest Tally result for this invoice." : "Latest Tally calculation for this period."} action={<IconButton label={`Start ${title} evaluation`} onClick={() => setEvaluationOpen(true)}><ClipboardCheck size={17} /></IconButton>} />
    {scheme === "tod" ? <div className="tod-overview" aria-label="Turnover Discount summary"><div className="tod-overview-meta"><div className="tod-period-context"><StatusBadge status="ready" /><strong>{periodLabel}</strong><span className={periodEnded ? "is-ready" : ""}><CircleAlert size={13} />{periodEnded ? "Ready to create Credit Notes" : `Projected until ${formatBusinessDate(periodRow?.period_end)}`}</span></div><div className="tod-overview-actions"><span>{lastChecked ? `Calculated ${formatDate(lastChecked)}` : "Not calculated yet"}</span><Button className="button-secondary" onClick={() => setEvaluationOpen(true)}><RefreshCw size={15} />Check latest Tally</Button><div className="segmented tod-inline-tabs" aria-label={`${title} views`}><button className={!showEvaluationQueue ? "selected" : ""} onClick={() => setShowEvaluationQueue(false)}>Customers</button><button className={showEvaluationQueue ? "selected" : ""} onClick={() => setShowEvaluationQueue(true)}>History</button></div></div></div><div className="tod-summary-grid"><div className="tod-primary-metric"><strong>{tiersReached}</strong><span>Qualified</span></div><div className="tod-primary-metric"><strong>{formatMoney(estimatedDiscount)}</strong><span>Projected discounts</span></div><div><strong>{buildingTowardTier}</strong><span>Not yet qualified</span></div><div><strong>{reviewing}</strong><span>Need attention</span></div></div></div> : <><div className="summary-bar"><span><StatusBadge status="ready" />Tally information</span><span><strong>{allRows.length}</strong> results</span><span><strong>{readyToFinalize}</strong> ready to finalize</span><span><strong>{reviewing}</strong> need review</span></div><div className="segmented evaluation-view-tabs" aria-label={`${title} views`}><button className={!showEvaluationQueue ? "selected" : ""} onClick={() => setShowEvaluationQueue(false)}>Customer results</button><button className={showEvaluationQueue ? "selected" : ""} onClick={() => setShowEvaluationQueue(true)}>Calculation history</button></div></>}
    {showEvaluationQueue && <GuidedEvaluationQueue scheme={scheme} latestRun={latestRun} onError={setError} onRetry={() => setEvaluationOpen(true)} onViewResults={() => setShowEvaluationQueue(false)} onSettled={async (run) => {
      await refresh();
      setLatestRun(null);
      if (run.status === "completed") {
        setNotice("Tally calculation completed. Customer results are ready.");
        setShowEvaluationQueue(false);
      }
    }} />}
    <div hidden={showEvaluationQueue}>
    {scheme === "tod" && <TodResults rows={rows} allRows={allRows} query={query} setQuery={setQuery} filter={statusFilter} setFilter={setStatusFilter} customerNames={customerNames} buildingTowardTier={buildingTowardTier} tiersReached={tiersReached} noActivity={noActivity} reviewing={reviewing} periodEnded={periodEnded} onOpen={(proposal) => {
      if (proposal.id.startsWith("local:")) setNotice("This current Tally result is being added to the audit history. Details will be available shortly.");
      else setSelected(proposal);
    }} />}
    <div hidden={scheme === "tod"}>
    <Card><div className="card-title"><div><p className="eyebrow">Results</p><h2>{title} history</h2><p className="muted-copy">Filter results, then open one to see the calculation and the next step.</p></div><span className="table-count">{rows.length} shown</span></div><div className="queue-toolbar"><label className="queue-search"><span>Find customer or reference</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer" /></label><div className="segmented" aria-label={`${title} status filters`}><button className={statusFilter === "all" ? "selected" : ""} onClick={() => setStatusFilter("all")}>All</button>{statuses.map((status) => <button key={status} className={statusFilter === status ? "selected" : ""} onClick={() => setStatusFilter(status)}>{staffStatusLabel(status)}</button>)}</div></div>{rows.length ? <div className="data-table proposal-table"><div className="table-head"><span>Customer</span><span>Result</span><span>Last checked</span><span>Next step</span></div>{rows.map((proposal) => <article key={proposal.id}><div><strong>{customerNames.get(proposal.customer_id) ?? "Customer record"}</strong><small>{proposal.period_start && proposal.period_end ? `${proposal.period_start} to ${proposal.period_end}` : proposal.eligibility_deadline ? `Payment deadline ${proposal.eligibility_deadline}` : "Sales invoice result"}</small></div><div><strong>{formatMoney(proposal.calculated_discount_amount)}</strong><small>{scheme === "tod" ? `${formatTonnes(proposal.eligible_tonnes)} eligible tonnes${proposal.additional_tonnes_required ? ` · ${formatTonnes(proposal.additional_tonnes_required)} to next tier` : ""}` : proposal.shortfall_amount ? `Paid ${formatMoney(proposal.amount_paid_by_deadline)} · shortfall ${formatMoney(proposal.shortfall_amount)}` : "Calculated amount"}</small></div><div><StatusBadge status={proposal.status} /><small>{proposal.latestEvaluation?.freshForApproval ? "Up to date and ready to create" : proposal.latest_evaluated_at ? `Checked ${formatDate(proposal.latest_evaluated_at)}` : "Not checked yet"}</small></div><div className="queue-next"><small>{primaryAction(proposal)}</small><Button className="button-quiet" onClick={() => setSelected(proposal)}><Eye size={15} />Open</Button></div></article>)}</div> : <EmptyState title={allRows.length ? "No results match this view" : `No ${title} results yet`} detail={allRows.length ? "Clear or change the status filters to see every result." : `Start a ${scheme === "cd" ? "Sales invoice" : "customer period"} evaluation after Tally information is updated.`} action={allRows.length ? <Button className="button-secondary" onClick={() => { setQuery(""); setStatusFilter("all"); }}>Clear filters</Button> : <Button onClick={() => setEvaluationOpen(true)}>Start evaluation</Button>} />}</Card>
    </div>
    </div>
    <GuidedEvaluationDrawer open={evaluationOpen} onClose={() => setEvaluationOpen(false)} scheme={scheme} onComplete={async (message, run) => { setLatestRun(run); setShowEvaluationQueue(true); setNotice(message); setEvaluationOpen(false); await refresh(); }} onError={setError} onTurnoverDiscountSubmit={scheme === "tod" ? runLocalTodCalculation : undefined} />
    <ProposalDrawer proposal={selected} onClose={() => setSelected(null)} onChanged={refresh} onError={setError} customerName={selected ? customerNames.get(selected.customer_id) : undefined} launchMode={data.launchControl?.mode} />
  </>;
}

function TodResults({ rows, allRows, query, setQuery, filter, setFilter, customerNames, buildingTowardTier, tiersReached, noActivity, reviewing, periodEnded, onOpen }: {
  rows: Proposal[];
  allRows: Proposal[];
  query: string;
  setQuery: (value: string) => void;
  filter: string;
  setFilter: (value: string) => void;
  customerNames: Map<string, string>;
  buildingTowardTier: number;
  tiersReached: number;
  noActivity: number;
  reviewing: number;
  periodEnded: boolean;
  onOpen: (proposal: Proposal) => void;
}) {
  return <Card className="tod-results-card">
    <div className="card-title tod-results-heading"><div><h2>Customer results</h2></div></div>
    <div className="queue-toolbar tod-toolbar"><label className="queue-search"><span>Find customer</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer" /></label><div className="segmented" aria-label="Turnover Discount result filters"><button className={filter === "tier" ? "selected" : ""} onClick={() => setFilter("tier")}>Qualified {tiersReached}</button><button className={filter === "building" ? "selected" : ""} onClick={() => setFilter("building")}>Not yet qualified {buildingTowardTier}</button>{reviewing > 0 && <button className={filter === "review" ? "selected" : ""} onClick={() => setFilter("review")}>Needs attention {reviewing}</button>}<button className={filter === "no_activity" ? "selected" : ""} onClick={() => setFilter("no_activity")}>No purchases {noActivity}</button><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All {allRows.length}</button></div></div>
    {rows.length ? <div className="data-table tod-results-table"><div className="table-head"><span>Customer</span><span>Turnover progress</span><span>Projected benefit</span><span>Next milestone</span></div>{rows.map((proposal) => {
      const currentTonnes = Number(proposal.eligible_tonnes ?? "0") || 0;
      const remainingTonnes = Number(proposal.additional_tonnes_required ?? "0") || 0;
      const targetTonnes = remainingTonnes > 0 ? currentTonnes + remainingTonnes : Math.max(currentTonnes, 1);
      const progress = Math.min(100, Math.round((currentTonnes / targetTonnes) * 100));
      const customerName = proposal.customer_name ?? customerNames.get(proposal.customer_id) ?? "Customer record";
      const needsAttention = ["needs_review", "review_invalidated", "pending_approval"].includes(proposal.status);
      const tierPercentage = Number(proposal.discount_percentage ?? "0") || 0;
      const tierTone = proposal.achieved_tier_id ? (tierPercentage >= 5 ? "top" : tierPercentage >= 3 ? "middle" : "entry") : "none";
      const milestoneCopy = proposal.achieved_tier_id && !periodEnded
        ? `Credit Note after ${formatBusinessDate(proposal.period_end)}`
        : remainingTonnes > 0 ? `${remainingTonnes} tonnes to the next slab` : currentTonnes > 0 ? "Highest slab reached" : "Waiting for qualifying sales";
      const savingDetails = proposal.id.startsWith("local:");
      return <article key={proposal.id} className={`${currentTonnes > 0 ? "has-turnover" : "no-turnover"} tod-tier-${tierTone}`}>
        <div><strong>{customerName}</strong><span className={`tod-tier-badge tod-tier-badge-${tierTone}`}>{proposal.achieved_tier_id ? "Slab reached" : currentTonnes > 0 ? "Below first slab" : "No purchases"}</span>{needsAttention && <small>Needs attention</small>}</div>
        <div className="tod-progress-cell"><strong>{formatTonnes(proposal.eligible_tonnes)} tonnes counted</strong><div className="tod-progress-track" role="progressbar" aria-label={`${customerName} progress to next slab`} aria-valuemin={0} aria-valuemax={targetTonnes} aria-valuenow={currentTonnes}><span style={{ width: `${progress}%` }} /></div></div>
        <div><strong>{formatMoney(proposal.calculated_discount_amount)}</strong></div>
        <div className="tod-milestone"><strong>{milestoneCopy}</strong>{needsAttention && <span className="tod-attention-state"><CircleAlert size={13} />Review required</span>}<Button className="button-quiet tod-row-action" disabled={savingDetails} title={savingDetails ? "The saved customer calculation is being prepared." : undefined} onClick={() => onOpen(proposal)}>{savingDetails ? "Saving details…" : <><Eye size={15} />View customer</>}</Button></div>
      </article>;
    })}</div> : <EmptyState title={allRows.length ? "No customers match this view" : "No Turnover Discount results yet"} detail={allRows.length ? "Choose another filter or clear the customer search." : "Start a customer-period calculation after Tally information is ready."} action={allRows.length ? <Button className="button-secondary" onClick={() => { setQuery(""); setFilter("tier"); }}>Clear filters</Button> : undefined} />}
  </Card>;
}

function EvaluationDrawer({ open, onClose, scheme, reference, onComplete, onError }: { open: boolean; onClose: () => void; scheme: "cd" | "tod"; reference: ReferenceData | null; onComplete: (message: string, run: EvaluationRun) => Promise<void>; onError: (message: string | null) => void }) {
  const { company } = useCompany();
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState(new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const loadVouchers = useCallback(async () => { const token = await accessToken(); if (!token) return; try { const data = await apiRequest<{ vouchers: Voucher[] }>(token, `/api/companies/${company.id}/vouchers?dateFrom=${from}&dateTo=${to}&voucherKind=sales`); setVouchers(data.vouchers); } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not load Sales vouchers."); } }, [company.id, from, onError, to]);
  useEffect(() => { if (!open || scheme !== "cd") return; void loadVouchers(); }, [loadVouchers, open, scheme]);
  async function submit(form: HTMLFormElement) { const token = await accessToken(); if (!token) return; const fields = new FormData(form); setBusy(true); onError(null); try { const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/${scheme}`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: jsonBody(scheme === "cd" ? { salesVoucherId: fields.get("salesVoucherId"), evaluatedOn: fields.get("evaluatedOn") } : { customerId: fields.get("customerId"), asOfDate: fields.get("asOfDate"), evaluatedOn: fields.get("asOfDate") }) }); setRun(response.evaluationRun); await onComplete("Evaluation started. It is waiting for the evaluator worker and fresh Tally evidence; this does not create a Credit Note.", response.evaluationRun); } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not start evaluation."); } finally { setBusy(false); } }
  return <Drawer open={open} onClose={onClose} title={`Start ${scheme === "cd" ? "Cash Discount" : "Turnover Discount"} evaluation`} description="The server fetches fresh evidence; no calculated amount is sent from this form." width="wide">{run ? <EvaluationRunProgress run={run} /> : <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>{scheme === "cd" ? <><div className="date-search"><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><Button type="button" className="button-secondary" onClick={() => void loadVouchers()}>Find vouchers</Button></div><label>Synced Sales voucher<select name="salesVoucherId" required><option value="">Select a Sales voucher</option>{vouchers.map((voucher) => <option value={voucher.id} key={voucher.id}>{voucher.voucher_number} · {voucher.voucher_date} · {formatMoney(voucher.gross_amount)}</option>)}</select></label><label>Evaluation date<input type="date" name="evaluatedOn" defaultValue={to} required /></label></> : <><label>Synced customer<select name="customerId" required><option value="">Select a customer</option>{reference?.masters.customers.filter((customer) => customer.is_available).map((customer) => <option value={customer.id} key={customer.id}>{labelFor(customer)}</option>)}</select></label>{!reference && <InlineMessage tone="info">Customer choices appear after master data is available. An Administrator can refresh master synchronization from Tally Connection.</InlineMessage>}<label>As-of date<input name="asOfDate" type="date" defaultValue={to} required /></label></>}<Button type="submit" disabled={busy || (scheme === "tod" && !reference)}>Run evaluation</Button></form>}</Drawer>;
}

function EvaluationRunProgress({ run }: { run: EvaluationRun }) { const { company } = useCompany(); const [current, setCurrent] = useState(run); useEffect(() => { if (["completed", "failed"].includes(current.status)) return; const interval = window.setInterval(() => { void (async () => { const token = await accessToken(); if (!token) return; try { const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/runs/${current.id}`); setCurrent(response.evaluationRun); } catch { /* keep the last safe state visible */ } })(); }, 4_000); return () => window.clearInterval(interval); }, [company.id, current.id, current.status]); return <div className="run-progress"><CircleDashedIcon /><div><StatusBadge status={current.status} /><h3>{current.status === "completed" ? "Evaluation completed" : "Live evidence is being processed"}</h3><p>{current.error_summary ?? "This run updates only after the bridge returns its scoped Tally result."}</p><small>Started {formatDate(current.created_at)}</small></div></div>; }
function CircleDashedIcon() { return <span className="run-icon"><RefreshCw size={22} /></span>; }

function EvaluationQueue({ scheme, latestRun, onError }: { scheme: "cd" | "tod"; latestRun: EvaluationRun | null; onError: (message: string | null) => void }) {
  const { company, companyKey } = useCompany();
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const token = await accessToken();
    if (!token) return;
    try {
      const response = await apiRequest<{ evaluationRuns: EvaluationRun[] }>(token, `/api/companies/${company.id}/evaluations/runs?schemeType=${scheme}&limit=100&detail=compact`);
      setRuns(response.evaluationRuns);
      onError(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not load the evaluation queue.");
    } finally {
      setLoading(false);
    }
  }, [company.id, onError, scheme]);
  useEffect(() => {
    setRuns(latestRun ? [{ ...latestRun, scheme_type: scheme }] : []);
    setLoading(true);
    void load();
  }, [companyKey, latestRun, load, scheme]);
  const queueRuns = runs.filter((run) => run.status !== "completed");
  const hasLiveRun = queueRuns.some((run) => !["failed", "completed"].includes(run.status));
  useEffect(() => {
    if (!hasLiveRun) return;
    const interval = window.setInterval(() => { void load(); }, 4_000);
    return () => window.clearInterval(interval);
  }, [hasLiveRun, load]);
  const title = scheme === "cd" ? "Cash Discount" : "Turnover Discount";
  return <Card><div className="card-title"><div><p className="eyebrow">Durable background work</p><h2>{title} evaluation queue</h2><p className="muted-copy">This shows jobs that are still processing or need attention. A completed job moves to the Results queue; it does not create a Credit Note by itself.</p></div><Button className="button-secondary" onClick={() => void load()}><RefreshCw size={15} />Refresh queue</Button></div>{loading && !runs.length ? <Skeleton lines={3} /> : queueRuns.length ? <div className="data-table evaluation-run-table"><div className="table-head"><span>Started</span><span>Period</span><span>State</span><span>What happens next</span></div>{queueRuns.map((run) => <article key={run.id}><div><strong>{formatDate(run.created_at)}</strong><small>Evaluation date {run.evaluation_date ?? "not recorded"}</small></div><div><strong>{run.period_start && run.period_end ? `${run.period_start} to ${run.period_end}` : "Tally source selected"}</strong><small>{run.attempts != null ? `Attempt ${run.attempts}${run.max_attempts ? ` of ${run.max_attempts}` : ""}` : "Durable background job"}</small></div><div><StatusBadge status={run.status} /><small>{run.error_summary ?? (run.status === "failed" ? "Open the safe failure detail in Operations." : "Waiting for the evaluator worker and scoped Tally evidence.")}</small></div><div><small>{run.status === "failed" ? "Review the safe failure, then create a new evaluation when corrected." : "Keep the evaluator worker and local Tally bridge running."}</small></div></article>)}</div> : <EmptyState title="No evaluation is waiting" detail="Completed evaluations appear in the Results queue. Start a new evaluation only when you need to assess another synced Sales voucher or customer period." />}</Card>;
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
  useEffect(() => { setRefreshRun(null); setRefreshCompleted(false); setRefreshMessage(null); setDocumentUrl(null); setCreateOpen(false); }, [proposal?.id]);
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
  async function action(kind: "refresh" | "create" | "reject" | "retry" | "request_pdf" | "shortfall" | "recover" | "tod_tier_test" | "resolve_tod_tier_review" | "reconcile_credit_note") {
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
      else if (kind === "tod_tier_test") await apiRequest(token, `/api/companies/${company.id}/notifications/tod-tier-test`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: jsonBody({ proposalId: proposal.id }) });
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
  const freshForCreation = refreshCompleted || Boolean(record?.latestEvaluation?.freshForApproval);
  const refreshIsActive = Boolean(refreshRun && !["completed", "failed", "completed_with_issues"].includes(refreshRun.status));
  if (loading || !proposal || !record) return <Drawer open={Boolean(proposal)} onClose={onClose} title={customerName ?? "Result details"} description="See the calculation, Credit Note, Tally, and WhatsApp history."><Skeleton lines={8} /></Drawer>;
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
      : remainingTonnes > 0 ? `${remainingTonnes} more tonnes are needed to reach the next discount slab.` : "No discount slab has been reached for this period.";
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
      ? groupPath.map((group) => group && typeof group === "object" && "groupName" in group ? String(group.groupName) : "").filter(Boolean).join(" › ")
      : "Rule-covered customer group";
    const saleVouchers = evidenceVouchers.filter((voucher) => voucher.voucherKind === "sales");
    const adjustmentTonnes = Math.abs(evidenceVouchers.filter((voucher) => voucher.voucherKind !== "sales").reduce((total, voucher) => total + Number(voucher.tonneContribution || 0), 0));
    const averageTonnes = saleVouchers.length ? eligibleTonnes / saleVouchers.length : 0;
    const lastVoucherDate = evidenceVouchers.map((voucher) => voucher.voucherDate).filter((date): date is string => Boolean(date)).sort().at(-1) ?? null;
    const periodStartTime = record.period_start ? new Date(`${record.period_start.slice(0, 10)}T00:00:00`).getTime() : 0;
    const periodEndTime = record.period_end ? new Date(`${record.period_end.slice(0, 10)}T23:59:59`).getTime() : 0;
    const elapsedRatio = periodStartTime && periodEndTime > periodStartTime ? Math.min(1, Math.max(0, (Date.now() - periodStartTime) / (periodEndTime - periodStartTime))) : 0;
    const forecastTonnes = !periodEnded && elapsedRatio > 0.03 ? eligibleTonnes / elapsedRatio : eligibleTonnes;
    const nextTier = tallyEvidence?.tiers.find((tier) => Number(tier.minimum_tonnes) > eligibleTonnes) ?? null;
    const likelyNextTier = nextTier ? forecastTonnes >= Number(nextTier.minimum_tonnes) : false;
    const nextTierLabel = nextTier ? usesAmountPerMt ? `₹${nextTier.discount_amount_per_tonne ?? "—"}/MT` : `${nextTier.discount_percentage}%` : null;
    const insightHeadline = nextTier
      ? likelyNextTier ? `On pace to reach the ${nextTierLabel} slab.` : `${remainingTonnes} tonnes remain to reach the ${nextTierLabel} slab.`
      : record.achieved_tier_id ? "The highest configured slab has been reached." : "No discount slab has been reached yet.";
    const isApexTestCustomer = customerName === "Apex Rebar Projects";
    const tierMessage = message?.eventType === "tod_tier_reached" ? message : null;
    const tierDropIssue = detail?.openIssues.find((issue) => issue.issue_type === "tod_tier_reduced_after_notification") ?? null;
    const tierMessageLabel = tierMessage?.status === "sent"
      ? "Sent to MSG91"
      : tierMessage?.status === "delivered"
        ? "Delivered"
        : tierMessage?.status === "read"
          ? "Read"
          : tierMessage?.status === "failed"
            ? "Delivery failed"
            : tierMessage?.status
              ? `WhatsApp ${tierMessage.status}`
        : detail?.notification.canQueue
          ? "Ready for the next new tier"
          : "WhatsApp not configured";
    const tierMessageDescription = tierMessage?.status === "sent"
      ? "MSG91 accepted the request. Delivery confirmation is pending."
      : tierMessage?.status === "delivered"
        ? "MSG91 confirmed delivery to the handset."
        : tierMessage?.status === "read"
          ? "MSG91 confirmed the message was read."
          : tierMessage?.status === "failed"
            ? "MSG91 reported a delivery failure. A replacement is not sent automatically."
      : tierMessage?.status
        ? "This tier event is already recorded, so another message for the same tier is blocked."
        : isApexTestCustomer
          ? "A newly saved tier result queues the approved template automatically. This Apex-only button is a controlled fallback for an already saved result with no message."
          : detail?.notification.blockedReason ?? "Opening an existing result never sends WhatsApp. A fresh calculation queues one message only when this customer reaches a new tier.";
    return <><Drawer open={Boolean(proposal)} onClose={onClose} title={customerName ?? "Customer result"} description="Review the customer's turnover, discount slab, and next step."><div className="drawer-stack tod-customer-drawer">
      <div className={`tod-drawer-hero tod-tier-${tierTone}`}><div><span className={`tod-tier-badge tod-tier-badge-${tierTone}`}>{record.achieved_tier_id ? `${achievedTierLabel} slab reached` : "Not yet qualified"}</span><p>Projected discount</p><strong>{formatMoney(record.calculated_discount_amount)}</strong></div><div className="tod-drawer-hero-meta"><span className="tod-drawer-state">{periodEnded ? "Period complete" : "Period in progress"}</span><small>Checked {formatDate(record.latest_evaluated_at)}</small>{canRefresh && <Button className="button-quiet" disabled={busy || refreshIsActive} onClick={() => void action("refresh")}><RefreshCw size={14} />{refreshIsActive ? "Checking Tally…" : "Check latest Tally"}</Button>}</div></div>
      {refreshMessage && <InlineMessage tone={refreshRun?.status === "failed" || refreshRun?.status === "completed_with_issues" ? "error" : freshForCreation ? "success" : "info"}>{refreshRun?.error_summary ?? refreshMessage}</InlineMessage>}
      <div className="tod-drawer-metrics"><div><span>Eligible quantity</span><strong>{formatTonnes(record.eligible_tonnes)} tonnes</strong></div><div><span>Eligible sales value</span><strong>{formatMoney(record.eligible_product_taxable_value)}</strong></div><div><span>Tally vouchers used</span><strong>{evidenceVouchers.length}</strong></div><div><span>Rule period</span><strong>{formatBusinessDate(record.period_start)} – {formatBusinessDate(record.period_end)}</strong></div></div>
      <section className="tod-customer-insight"><p className="eyebrow">Customer insight</p><h3>{insightHeadline}</h3><p>{saleVouchers.length ? `${saleVouchers.length} sales voucher${saleVouchers.length === 1 ? "" : "s"} average ${averageTonnes.toLocaleString(undefined, { maximumFractionDigits: 1 })} tonnes each` : "No contributing Sales voucher was found"}{lastVoucherDate ? ` · latest purchase ${formatBusinessDate(lastVoucherDate)}` : ""}{adjustmentTonnes ? ` · ${adjustmentTonnes.toLocaleString(undefined, { maximumFractionDigits: 2 })} tonnes adjusted` : ""}.</p>{!periodEnded && elapsedRatio > 0.03 && <small>Current pace indicates approximately {forecastTonnes.toLocaleString(undefined, { maximumFractionDigits: 0 })} tonnes by period end. This is an estimate, not an earned discount.</small>}</section>
      {tallyEvidence?.tiers.length ? <section className="tod-slab-progress"><div><p className="eyebrow">Discount slabs</p><h3>{record.achieved_tier_id ? `${eligibleTonnes} tonnes reached the ${achievedTierLabel} slab` : `${remainingTonnes} tonnes needed for the first slab`}</h3></div><div className="tod-slab-track">{tallyEvidence.tiers.map((tier) => { const minimum = Number(tier.minimum_tonnes); const reached = eligibleTonnes >= minimum; const active = tier.id === record.achieved_tier_id; const label = usesAmountPerMt ? `₹${tier.discount_amount_per_tonne ?? "—"}/MT` : `${tier.discount_percentage}%`; return <div className={`${reached ? "is-reached" : ""} ${active ? "is-active" : ""}`} key={tier.id}><span>{minimum}t</span><strong>{label}</strong></div>; })}</div></section> : null}
      <section className="tod-calculation-summary"><p className="eyebrow">Calculation</p><h3>{usesAmountPerMt ? `${formatTonnes(eligibleTonnes)} tonnes × ₹${perMtRate ?? "0"}/MT = ${formatMoney(record.calculated_discount_amount)}` : `${formatMoney(record.eligible_product_taxable_value)} × ${record.discount_percentage ?? "0"}% = ${formatMoney(record.calculated_discount_amount)}`}</h3><p>{usesAmountPerMt ? "The highest achieved slab rate is applied to the full eligible quantity. Returns and linked adjustments reduce that quantity." : "Eligible tonnes determine the slab. The discount is applied to eligible product value before GST; returns and linked adjustments reduce the result."}</p></section>
      {isAdministrator && record.achieved_tier_id && <section className="tod-next-step"><div><p className="eyebrow">WhatsApp tier update</p><h3>{tierMessageLabel}</h3><p>{tierMessageDescription}</p></div>{isApexTestCustomer ? <Button disabled={busy || Boolean(tierMessage?.status)} onClick={() => void action("tod_tier_test")}>{tierMessage?.status ? tierMessageLabel : "Queue missing TOD test WhatsApp"}</Button> : <small className="tod-message-safety">Test delivery is limited to Apex Rebar Projects. This customer cannot be sent from this test workspace.</small>}</section>}
      <section className={`tod-next-step ${record.achieved_tier_id ? "has-credit-note-step" : ""}`}><div><p className="eyebrow">Credit Note</p><h3>{detail?.creditNotePosting ? "Credit Note created" : record.achieved_tier_id ? periodEnded ? "Ready to create Credit Note" : `Available after ${creationAvailableOn}` : "Customer has not qualified yet"}</h3><p>{detail?.creditNotePosting ? "Track Tally verification and WhatsApp delivery below." : record.achieved_tier_id && !periodEnded ? `This customer has qualified so far, but ${formatMoney(record.calculated_discount_amount)} is not final. Sales and returns continue to change it until the period closes.` : nextStep}</p></div>{!record.achieved_tier_id && remainingTonnes > 0 && <strong>{formatTonnes(remainingTonnes)}<small>tonnes to next slab</small></strong>}{canManage && record.achieved_tier_id && !detail?.creditNotePosting && <div className="tod-credit-note-action"><Button disabled={busy || !createReady || !freshForCreation || postingDisabled} title={!periodEnded ? `Available after ${creationAvailableOn}` : !freshForCreation ? "Check latest Tally before creating" : postingDisabled ? "Enable Credit Note posting in Administration" : undefined} onClick={() => setCreateOpen(true)}>{periodEnded ? "Create Credit Note" : `Create after ${creationAvailableOn}`}</Button>{!periodEnded && <small>One final Credit Note will cover this complete period and prevent duplicate discounting.</small>}{periodEnded && !freshForCreation && <small>Check latest Tally to unlock creation.</small>}</div>}</section>
      <details className="tod-evidence-details" open><summary><span>Tally transactions</span><small>{evidenceVouchers.length} voucher{evidenceVouchers.length === 1 ? "" : "s"} used</small></summary>{evidenceVouchers.length ? <div className="tod-evidence-list">{evidenceVouchers.map((voucher) => <article key={`${voucher.tallyVoucherId}-${voucher.contributionType}`}><div><strong>{voucher.voucherNumber || voucher.voucherTypeName || "Tally voucher"}</strong><small>{formatBusinessDate(voucher.voucherDate)} · {userLabel(voucher.voucherKind)}</small></div><div><strong className={Number(voucher.tonneContribution) < 0 ? "is-negative" : ""}>{formatTonnes(voucher.tonneContribution)} tonnes</strong><small>{formatMoney(voucher.taxableValueContribution)}</small></div></article>)}</div> : <EmptyState title="No voucher breakdown available" detail="Run the calculation again to capture transaction-level evidence." />}</details>
      {productSummary.length ? <details className="tod-evidence-details"><summary><span>Products counted</span><small>{productSummary.length} product{productSummary.length === 1 ? "" : "s"}</small></summary><div className="tod-evidence-list">{productSummary.map((product) => <article key={product.name}><div><strong>{product.name}</strong><small>{product.group || "Tally stock item"}</small></div><div><strong>{formatTonnes(product.tonnes)} tonnes</strong><small>{formatMoney(product.value)}</small></div></article>)}</div></details> : null}
      {blockedLines.length ? <InlineMessage tone="warning">{blockedLines.length} Tally item line{blockedLines.length === 1 ? " was" : "s were"} excluded because quantity or unit information needs attention.</InlineMessage> : null}
      {detail?.openIssues.length ? <section><h3>Needs attention</h3>{detail.openIssues.map((issue) => <OpenIssueSummary issue={issue} key={issue.id} />)}{tierDropIssue && canManage ? <div className="drawer-actions"><label>Finance review note<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why no correction message is needed" /></label><Button className="button-secondary" disabled={busy || reason.trim().length < 3} onClick={() => void action("resolve_tod_tier_review")}>Mark reviewed — no correction sent</Button><small>Closing this review never sends a WhatsApp. It only allows a future, genuinely new tier to be evaluated normally.</small></div> : null}</section> : null}
      {detail?.creditNotePosting && <section><h3>Credit Note progress</h3><CreditNoteLifecycle posting={detail.creditNotePosting} message={message} /><div className="tod-credit-note-summary"><div><span>Status</span><strong>{staffStatusLabel(detail.creditNotePosting.status)}</strong></div><div><span>Amount</span><strong>{formatMoney(detail.creditNotePosting.verified_amount ?? detail.creditNotePosting.discount_amount)}</strong></div><div><span>Tally number</span><strong>{detail.creditNotePosting.verified_voucher_number ?? "Waiting for confirmation"}</strong></div></div>{detail.creditNotePosting.document?.available && <Button className="button-secondary" onClick={() => void openDocument()}>Open Credit Note PDF</Button>}{canManage && detail.creditNotePosting.status === "created_verified" ? <Button className="button-quiet" disabled={busy || Boolean(noteReconciliationRunId)} onClick={() => void action("reconcile_credit_note")}><RefreshCw size={14} />{noteReconciliationRunId ? "Checking Tally…" : "Verify in Tally"}</Button> : null}</section>}
      {detail?.reviews.length ? <details className="tod-audit-details"><summary>Administrator action history</summary><div>{detail.reviews.map((review) => <div className="history-row" key={review.id}><StatusBadge status={review.status} /><span>{review.review_reason || review.invalidation_reason || "Recorded using the latest Tally information"}</span><small>{formatDate(review.reviewed_at)}</small></div>)}</div></details> : null}
      {isAdministrator && <details className="tod-audit-details"><summary>Audit information</summary><dl><div><dt>Rule</dt><dd>{ruleVersion ? `Version ${ruleVersion}` : "Active Turnover Discount rule"}</dd></div><div><dt>Rule effective from</dt><dd>{formatBusinessDate(typeof detail?.latestEvaluation?.rule_snapshot?.effectiveFrom === "string" ? detail.latestEvaluation.rule_snapshot.effectiveFrom : null)}</dd></div><div><dt>Customer group</dt><dd>{groupLabel || "Rule-covered customer group"}</dd></div><div><dt>Last calculated</dt><dd>{formatDate(record.latest_evaluated_at)}</dd></div></dl></details>}
      {canManage && record.status === "eligible" && periodEnded && postingDisabled && <InlineMessage tone="info">Credit Note creation is currently switched off in Administration settings.</InlineMessage>}
    </div></Drawer><CreditNoteCreationDialog open={createOpen} customerName={customerName} proposal={record} busy={busy} onClose={() => setCreateOpen(false)} onConfirm={() => void action("create")} /><VerifiedCreditNoteDocument open={Boolean(documentUrl)} downloadUrl={documentUrl} posting={detail?.creditNotePosting ?? null} onClose={() => setDocumentUrl(null)} /></>;
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
    {detail?.creditNotePosting && <section><h3>Credit Note</h3><DetailGrid rows={[["Credit Note number", detail.creditNotePosting.verified_voucher_number ?? "Waiting to be confirmed"], ["Amount", formatMoney(detail.creditNotePosting.verified_amount ?? detail.creditNotePosting.discount_amount)], ["Confirmed in Tally", detail.creditNotePosting.verified_at ? "Yes" : "Not yet"], ["Confirmed on", formatDate(detail.creditNotePosting.verified_at)], ["PDF", detail.creditNotePosting.document?.status ?? "Not requested"]]} />{detail.creditNotePosting.status === "correction_required" && <InlineMessage tone="warning"><strong>Tally reconciliation required.</strong> {detail.creditNotePosting.reconciliation_reason ?? "Confirm the Tally voucher before asking Finance to correct it. No replacement is created automatically."}</InlineMessage>}{detail.creditNotePosting.failure_reason && <InlineMessage tone="error">{detail.creditNotePosting.failure_reason}</InlineMessage>}{detail.creditNotePosting.document?.failureReason && <InlineMessage tone="error">{detail.creditNotePosting.document.failureReason}</InlineMessage>}{detail.creditNotePosting.document?.available ? <Button className="button-secondary" onClick={() => void openDocument()}>Open Credit Note PDF</Button> : canRefresh && detail.creditNotePosting.verified_tally_guid ? <><p className="muted-copy">Ask Meenakshi Tally Connector to collect the confirmed Credit Note PDF from Tally.</p><Button className="button-secondary" disabled={busy} onClick={() => void action("request_pdf")}>Get Credit Note PDF</Button></> : null}</section>}
    <section><h3>WhatsApp event</h3>{message?.messageId ? <p className="muted-copy"><StatusBadge status={message.status ?? "queued"} /> An approved event already exists. <Link href="/messages">Open Messages</Link> for preview and delivery history.</p> : <p className="muted-copy">{message?.blockedReason ?? "A message is not applicable at this state."}</p>}{canMessage && message?.canQueue && <Button className="button-secondary" disabled={busy} onClick={() => void action(message.eventType === "cd_shortfall" ? "shortfall" : "recover")}>{message.eventType === "cd_shortfall" ? "Queue shortfall reminder" : "Recover verified notification"}</Button>}</section>
    {canRefresh && <section className="drawer-actions"><h3>Available actions</h3>{refreshMessage && <InlineMessage tone={refreshRun?.status === "failed" || refreshRun?.status === "completed_with_issues" ? "error" : freshForCreation ? "success" : "info"}>{refreshRun?.error_summary ?? refreshMessage}</InlineMessage>}<Button className="button-secondary" disabled={busy || refreshIsActive} onClick={() => void action("refresh")}>{refreshIsActive ? "Checking latest Tally information…" : "Check latest Tally information"}</Button>{canManage && record.status === "eligible" && canApproveCreditNote && !detail?.creditNotePosting && <Button disabled={busy || !freshForCreation || postingDisabled} onClick={() => setCreateOpen(true)}>Create Credit Note</Button>}{canManage && record.status === "eligible" && canApproveCreditNote && !freshForCreation && <p className="muted-copy">Creation becomes available after the latest Tally information is checked.</p>}{recommendedAction === "debit_note" && <InlineMessage tone="info">Debit Note recovery requires an Administrator decision and is never posted automatically.</InlineMessage>}{canManage && <><label>Reason required to reject this result<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain why this result should not be used" /></label><Button className="button-danger" disabled={busy || !reason.trim() || !proposal.latestEvaluation} onClick={() => void action("reject")}>Reject result</Button></>}{detail?.creditNotePosting && ["failed", "correction_required"].includes(detail.creditNotePosting.status) && <Button disabled={busy || !reason.trim() || postingDisabled} onClick={() => void action("retry")}>Retry safely</Button>}{postingDisabled && canApproveCreditNote && <p className="muted-copy">Credit Note creation is available only after the Administrator enables posting for the confirmed period.</p>}</section>}
  </div></Drawer><CreditNoteCreationDialog open={createOpen} customerName={customerName} proposal={record} busy={busy} onClose={() => setCreateOpen(false)} onConfirm={() => void action("create")} /><VerifiedCreditNoteDocument open={Boolean(documentUrl)} downloadUrl={documentUrl} posting={detail?.creditNotePosting ?? null} onClose={() => setDocumentUrl(null)} /></>;
}

function CreditNoteCreationDialog({ open, customerName, proposal, busy, onClose, onConfirm }: { open: boolean; customerName?: string; proposal: Proposal; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return <Dialog open={open} onClose={onClose} title="Create Credit Note" description="Check the amount and period. Meenakshi will handle Tally verification and WhatsApp automatically.">
    <div className="credit-note-confirmation">
      <dl>
        <div><dt>Customer</dt><dd>{customerName ?? "Customer record"}</dd></div>
        <div><dt>Period</dt><dd>{proposal.period_start && proposal.period_end ? `${formatBusinessDate(proposal.period_start)} – ${formatBusinessDate(proposal.period_end)}` : "Cash Discount result"}</dd></div>
        <div><dt>Credit Note amount</dt><dd>{formatMoney(proposal.calculated_discount_amount)}</dd></div>
      </dl>
      <ol aria-label="What happens after confirmation">
        <li><span>1</span><div><strong>Create in Tally</strong><small>The request uses one permanent calculation reference.</small></div></li>
        <li><span>2</span><div><strong>Verify from Tally</strong><small>The voucher number, customer and amount are read back and checked.</small></div></li>
        <li><span>3</span><div><strong>Send WhatsApp</strong><small>After verification, the approved message is queued automatically.</small></div></li>
      </ol>
      <InlineMessage tone="info">Creating again for this customer, rule and period is blocked automatically.</InlineMessage>
      <div className="dialog-actions"><Button className="button-secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={onConfirm}>{busy ? "Creating…" : "Create in Tally"}</Button></div>
    </div>
  </Dialog>;
}

function CreditNoteLifecycle({ posting, message }: { posting: Pick<CreditNotePosting, "status" | "verified_voucher_number" | "failure_reason" | "reconciliation_reason">; message?: { status?: string | null; blockedReason?: string | null } | null }) {
  const tallyFailed = ["failed", "correction_required"].includes(posting.status);
  const tallyVerified = posting.status === "created_verified";
  const messageStatus = message?.status ?? null;
  const messageFailed = messageStatus === "failed" || messageStatus === "suppressed";
  const messageComplete = Boolean(messageStatus && ["sent", "delivered", "read", "whatsapp_sent"].includes(messageStatus));
  const steps = [
    { label: "Credit Note", detail: "Creation requested", state: "complete" },
    { label: "Tally", detail: posting.status === "correction_required" ? "Reconciliation required" : tallyFailed ? "Needs attention" : tallyVerified ? posting.verified_voucher_number ?? "Verified" : "Creating and verifying", state: tallyFailed ? "failed" : tallyVerified ? "complete" : "active" },
    { label: "WhatsApp", detail: !tallyVerified ? "Waits for Tally" : messageFailed ? "Needs attention" : messageComplete ? staffStatusLabel(messageStatus!) : messageStatus ? staffStatusLabel(messageStatus) : message?.blockedReason ?? "Preparing message", state: messageFailed ? "failed" : messageComplete ? "complete" : tallyVerified ? "active" : "pending" },
  ];
  return <div className="credit-note-flow" aria-label="Credit Note progress">{steps.map((step, index) => <div className={`credit-note-flow-step is-${step.state}`} key={step.label}><span>{step.state === "complete" ? <CheckCircle2 size={15} /> : index + 1}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></div>)}</div>;
}

function DetailGrid({ rows }: { rows: Array<[string, string]> }) { return <dl className="detail-grid">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }

function CreditNotesPage({ data, customerNames, refresh, setError }: PageProps) {
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Proposal | null>(null);
  const messageForPosting = (postingId: string) => data.messages.find((message) => message.credit_note_posting_id === postingId) ?? null;
  const postingProposalIds = new Set(data.creditNotes.map((posting) => posting.proposal_id));
  const readyProposals = data.proposals.filter((proposal) => proposal.scheme_type === "tod" && proposal.status === "eligible" && !postingProposalIds.has(proposal.id) && Boolean(proposal.period_end && new Date(`${proposal.period_end.slice(0, 10)}T23:59:59`).getTime() < Date.now()));
  const tallyActiveStatuses = ["queued", "sending", "verification_pending", "sending_to_tally"];
  const failedStatuses = ["failed", "correction_required"];
  const deliveredStatuses = ["sent", "delivered", "read", "whatsapp_sent"];
  const reconciliationCount = data.creditNotes.filter((posting) => posting.status === "correction_required").length;
  const tallyActiveCount = data.creditNotes.filter((posting) => tallyActiveStatuses.includes(posting.status)).length;
  const whatsappPendingCount = data.creditNotes.filter((posting) => posting.status === "created_verified" && !deliveredStatuses.includes(messageForPosting(posting.id)?.status ?? "")).length;
  const completedCount = data.creditNotes.filter((posting) => posting.status === "created_verified" && deliveredStatuses.includes(messageForPosting(posting.id)?.status ?? "")).length;
  const needsAttentionCount = data.creditNotes.filter((posting) => failedStatuses.includes(posting.status) || ["failed", "suppressed"].includes(messageForPosting(posting.id)?.status ?? "")).length;
  const filtered = data.creditNotes.filter((posting) => {
    const message = messageForPosting(posting.id);
    if (filter === "all") return true;
    if (filter === "tally") return tallyActiveStatuses.includes(posting.status);
    if (filter === "whatsapp") return posting.status === "created_verified" && !deliveredStatuses.includes(message?.status ?? "");
    if (filter === "completed") return posting.status === "created_verified" && deliveredStatuses.includes(message?.status ?? "");
    if (filter === "reconciliation") return posting.status === "correction_required";
    if (filter === "attention") return failedStatuses.includes(posting.status) || ["failed", "suppressed"].includes(message?.status ?? "");
    return false;
  });
  const filters = [["all", "All"], ["ready", "Ready to create"], ["tally", "In Tally"], ["whatsapp", "WhatsApp"], ["completed", "Completed"], ["reconciliation", `Tally review ${reconciliationCount}`], ["attention", "Needs attention"]];
  const hasActiveWork = tallyActiveCount > 0 || data.messages.some((message) => ["queued", "sending", "retrying"].includes(message.status));
  useEffect(() => {
    if (!hasActiveWork) return;
    const interval = window.setInterval(() => { void refresh(); }, 5_000);
    return () => window.clearInterval(interval);
  }, [hasActiveWork, refresh]);

  return <>
    <WorkspacePageHeader eyebrow="Administration" title="Credit Notes" detail="Create eligible discounts and follow each one through Tally verification and WhatsApp delivery." action={<IconButton label="Refresh Credit Notes" onClick={() => void refresh()}><RefreshCw size={16} /></IconButton>} />
    <div className="credit-note-summary" aria-label="Credit Note summary"><div><strong>{readyProposals.length}</strong><span>Ready to create</span></div><div><strong>{tallyActiveCount}</strong><span>Creating in Tally</span></div><div><strong>{whatsappPendingCount}</strong><span>WhatsApp pending</span></div><div><strong>{completedCount}</strong><span>Completed</span></div><div className={needsAttentionCount ? "has-attention" : ""}><strong>{needsAttentionCount}</strong><span>Needs attention</span></div></div>
    <div className="segmented" role="tablist" aria-label="Credit Note state">{filters.map(([value, label]) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {(filter === "all" || filter === "ready") && readyProposals.length ? <Card><div className="card-title"><div><p className="eyebrow">Action needed</p><h2>Ready to create</h2><p className="muted-copy">These TOD periods are complete and eligible. Open one to check current Tally information and create its Credit Note.</p></div><span className="table-count">{readyProposals.length}</span></div><div className="ready-credit-note-list">{readyProposals.map((proposal) => <article key={proposal.id}><div><strong>{customerNames.get(proposal.customer_id) ?? "Customer record"}</strong><small>{formatBusinessDate(proposal.period_start)} – {formatBusinessDate(proposal.period_end)}</small></div><strong>{formatMoney(proposal.calculated_discount_amount)}</strong><Button onClick={() => setSelected(proposal)}>Create Credit Note</Button></article>)}</div></Card> : null}
    {filter !== "ready" && <Card>{filtered.length ? <div className="credit-note-tracker">{filtered.map((posting) => { const proposal = data.proposals.find((item) => item.id === posting.proposal_id) ?? null; const message = messageForPosting(posting.id); return <article key={posting.id}><div className="credit-note-tracker-heading"><div><strong>{customerNames.get(posting.customer_id) ?? "Customer record"}</strong><small>{proposal?.period_start && proposal.period_end ? `${formatBusinessDate(proposal.period_start)} – ${formatBusinessDate(proposal.period_end)}` : proposal?.scheme_type === "cd" ? "Cash Discount Sales invoice" : `Created ${formatBusinessDate(posting.credit_note_date)}`}</small></div><div><strong>{formatMoney(posting.discount_amount)}</strong><small>{posting.verified_voucher_number ?? "Tally number pending"}</small></div><Button className="button-quiet" onClick={() => proposal && setSelected(proposal)} disabled={!proposal}><Eye size={15} />Open</Button></div><CreditNoteLifecycle posting={posting} message={message} />{posting.status === "correction_required" && <InlineMessage tone="warning"><strong>Tally reconciliation required.</strong> {posting.reconciliation_reason ?? "Confirm the Tally voucher before any correction. No replacement is created automatically."}</InlineMessage>}{posting.failure_reason && <InlineMessage tone="error">{posting.failure_reason}</InlineMessage>}</article>; })}</div> : <EmptyState title={data.creditNotes.length ? "No Credit Notes match this view" : "No Credit Notes created yet"} detail={data.creditNotes.length ? "Choose All to see the complete history." : readyProposals.length ? "Open a ready discount above to create its Credit Note." : "Eligible completed TOD periods will appear here automatically."} />}</Card>}
    <ProposalDrawer proposal={selected} onClose={() => setSelected(null)} onChanged={refresh} onError={setError} customerName={selected ? customerNames.get(selected.customer_id) : undefined} launchMode={data.launchControl?.mode} />
  </>;
}

function MessagesPage({ data, isAdministrator, refresh, setError, setNotice }: PageProps) { const { company } = useCompany(); const [selected, setSelected] = useState<NotificationMessage | null>(null); const [resend, setResend] = useState<NotificationMessage | null>(null); const [templatesOpen, setTemplatesOpen] = useState(false); const metric = (statuses: string[]) => data.messages.filter((message) => statuses.includes(message.status)).length; async function doResend(form: HTMLFormElement) { if (!resend) return; const token = await accessToken(); if (!token) return; try { const fields = new FormData(form); await apiRequest(token, `/api/companies/${company.id}/notifications/${resend.id}/resend`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: jsonBody({ reason: fields.get("reason") }) }); setResend(null); setNotice("Audited resend queued."); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not queue resend."); } } return <><SectionHeading eyebrow="Delivery history" title="Messages" detail="Approved WhatsApp delivery history with consent-aware, audited actions." action={isAdministrator ? <Button className="button-secondary" onClick={() => setTemplatesOpen(true)}>Approved templates</Button> : undefined} /><div className="metric-grid message-metrics"><MetricCard label="Queued" value={metric(["queued"])} detail="Waiting for delivery" tone="info" icon={<Send size={19} />} /><MetricCard label="Retrying" value={data.messageHealth?.retrying ?? 0} detail="Safe retries in progress" tone="attention" icon={<RefreshCw size={19} />} /><MetricCard label="Sent / delivered" value={metric(["sent", "delivered", "read", "whatsapp_sent"])} detail="Safe delivery result recorded" tone="good" icon={<CheckCircle2 size={19} />} /><MetricCard label="Terminal failure" value={data.messageHealth?.terminalFailures ?? 0} detail="Review before a resend" tone={data.messageHealth?.terminalFailures ? "danger" : "neutral"} icon={<CircleAlert size={19} />} /></div><Card>{data.messages.length ? <div className="data-table messages-table"><div className="table-head"><span>Business context</span><span>Delivery status</span><span>Consent</span><span>Time</span><span /></div>{data.messages.map((message) => <article key={message.id}><div><strong>{message.event_type.replaceAll("_", " ")}</strong><small>{safePhone(message.recipient_phone_e164)} · {message.resend_of_notification_id ? "Audited resend" : "Original delivery"}</small></div><StatusBadge status={message.status} /><small>{message.opt_in_snapshot ? "Opt-in snapshot recorded" : "Consent state unavailable"}</small><small>{formatDate(message.sent_at ?? message.created_at)}</small><div className="table-actions"><Button className="button-quiet" onClick={() => setSelected(message)}><Eye size={15} />View</Button>{["failed", "suppressed"].includes(message.status) && <Button className="button-quiet" onClick={() => setResend(message)}>Resend</Button>}</div></article>)}</div> : <EmptyState title="No delivery history" detail="Approved templates create auditable delivery events when their business trigger occurs." />}</Card><MessageDetailDrawer message={selected} onClose={() => setSelected(null)} /><Drawer open={Boolean(resend)} onClose={() => setResend(null)} title="Audited resend" description="The approved recipient and frozen business context cannot be changed."><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void doResend(event.currentTarget); }}><label>Reason for resend<textarea name="reason" required maxLength={500} placeholder="Why this verified message should be sent again" /></label><Button type="submit">Queue audited resend</Button></form></Drawer><Drawer open={templatesOpen} onClose={() => setTemplatesOpen(false)} title="Approved templates" description="Administrator-only template administration is separated from delivery history.">{data.templates.length ? <div className="template-list">{data.templates.map((template) => <article key={template.id}><div><strong>{template.name}</strong><p>{template.event_type.replaceAll("_", " ")} · {template.language_code}</p></div><StatusBadge status={template.is_active ? "ready" : "suppressed"} /></article>)}</div> : <EmptyState title="No approved templates loaded" detail="Create approved template mappings through the existing administrator workflow." />}</Drawer></>; }

function MessageDetailDrawer({ message, onClose }: { message: NotificationMessage | null; onClose: () => void }) { return <Drawer open={Boolean(message)} onClose={onClose} title="Delivery detail" description="Safe delivery history; no raw provider payload is shown.">{message && <div className="drawer-stack"><DetailGrid rows={[["Event", message.event_type.replaceAll("_", " ")], ["Recipient", safePhone(message.recipient_phone_e164)], ["Status", message.status.replaceAll("_", " ")], ["Consent", message.opt_in_snapshot ? "Opt-in snapshot recorded" : "Not available"], ["Attempts", `${message.attempt_count} of ${message.max_attempts}`], ["Sent", formatDate(message.sent_at)]]} />{message.failure_reason && <InlineMessage tone="error">{message.failure_reason}</InlineMessage>}<p className="muted-copy">Provider payloads and arbitrary message composition are intentionally unavailable.</p></div>}</Drawer>; }
