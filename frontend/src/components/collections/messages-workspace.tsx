"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarDays, CheckCheck, ChevronRight, Eye, FileText, Layers, List, MessageSquare, Plus, RefreshCw, Search, Send, Sparkles, Trash2, Users } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingDetail, userFacingError, userLabel } from "@/lib/user-copy";
import { supabase } from "@/lib/supabase";

import { WorkspacePageHeader } from "./app-shell";
import { useCompany } from "./company-context";
import { PeriodFilter, defaultPeriod, inPeriod, periodLabel, type Period } from "./period-filter";
import type { PageProps } from "./workspace";
import type { MessageTemplate, NotificationMessage } from "./types";
import { Button, Drawer, EmptyState, InlineMessage, StatusBadge, formatDate } from "./ui";

type MessageDetail = {
  message: NotificationMessage & { delivered_at?: string | null; read_at?: string | null; scheduled_for?: string | null };
  attempts: Array<{ id: string; attempt_number: number; provider_message_id: string | null; status: string; attempted_at: string | null; completed_at: string | null; failure_reason: string | null }>;
  preview: Array<{ component: string; type: string; value: string; variable: string }>;
  // The approved MSG91 template text filled with this message's values.
  sent?: { text: string; attachment: string | null; templateName: string } | null;
};
type CatalogResponse = { configured: boolean; templates: unknown };
type Mapping = { component: string; value: string; type: "text" | "document"; filenameValue?: string };
type CatalogOption = { id: string; label: string; providerTemplateId: string; languageCode: string; namespace?: string; variables: string[]; variableTypes: Record<string, string> };
const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-message-${Date.now()}`;
const templateEvents = ["cd_shortfall", "cd_debit_note_created", "cd_credit_note_created", "tod_credit_note_created", "tod_tier_reached"] as const;

async function accessToken() {
  const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

function defaultValues(eventType: string) {
  return eventType === "cd_shortfall"
    ? ["customerName", "paidAmountDisplay", "benefitAmountDisplay", "shortfallAmountDisplay", "eligibilityDeadline"]
    : eventType === "tod_tier_reached"
      ? ["customerName", "todTierPercentage", "todPeriodDisplay", "todTonnesDisplay", "benefitAmount"]
      : eventType === "tod_credit_note_created"
      ? ["customerName", "creditNoteNumber", "creditNoteAmountDisplay", "todPeriodDisplay", "todTonnesDisplay"]
      : eventType === "cd_debit_note_created"
      ? ["customerName", "debitNoteNumber", "debitNoteDate", "debitNoteAmountDisplay", "invoiceReference"]
      : ["customerName", "creditNoteNumber", "creditNoteDate", "creditNoteAmountDisplay", "invoiceReference"];
}

function initialMappings(eventType: string, providerVariables: string[] = []): Mapping[] {
  const defaults = providerVariables.length === 4 && eventType === "cd_shortfall"
    // The approved MSG91 CD-shortfall template says: customer, received,
    // remaining amount, deadline. The template itself includes the ₹ symbols,
    // so amount values must be sent without a currency symbol.
    ? ["customerName", "paidAmount", "shortfallAmount", "eligibilityDeadline"]
    : defaultValues(eventType);
  const components = providerVariables.length > 0 ? providerVariables : defaults.map((_, index) => `body_var_${index + 1}`);
  return components.map((component, index) => ({ component, value: defaults[index] ?? defaults[0], type: "text" }));
}

function catalogOptions(payload: unknown): CatalogOption[] {
  const output: CatalogOption[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || output.length > 80 || !value) return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    if (typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    const providerTemplateId = typeof item.name === "string" ? item.name : null;
    const namespace = typeof item.namespace === "string" ? item.namespace : undefined;
    if (providerTemplateId && Array.isArray(item.languages)) {
      for (const language of item.languages) {
        if (!language || typeof language !== "object") continue;
        const row = language as Record<string, unknown>;
        if (String(row.status ?? "").toLowerCase() !== "approved") continue;
        const languageCode = typeof row.language === "string" ? row.language : "en";
        const variables = Array.isArray(row.variables) ? row.variables.filter((variable): variable is string => typeof variable === "string" && variable.trim().length > 0) : [];
        const rawTypes = row.variable_type && typeof row.variable_type === "object" ? row.variable_type as Record<string, { type?: string }> : {};
        const candidate: CatalogOption = {
          id: `${providerTemplateId}:${languageCode}`,
          label: `${providerTemplateId} (${languageCode})`,
          providerTemplateId,
          languageCode,
          namespace,
          variables,
          variableTypes: Object.fromEntries(Object.entries(rawTypes).map(([key, value]) => [key, String(value?.type ?? "text").toLowerCase()])),
        };
        if (!output.some((existing) => existing.id === candidate.id)) output.push(candidate);
      }
    }
    Object.values(item).forEach((child) => visit(child, depth + 1));
  };
  visit(payload, 0);
  return output;
}

type MessageView = "all" | "attention" | "sent" | "pending" | "not_sent";
type Scheme = "all" | "tod" | "cd";
const schemeOf = (eventType: string): Exclude<Scheme, "all"> | null => eventType.startsWith("tod_") ? "tod" : eventType.startsWith("cd_") ? "cd" : null;
const SENT_STATUSES = ["sent", "whatsapp_sent", "delivered", "read"];
const MESSAGE_TYPE_LABEL: Record<string, string> = {
  tod_tier_reached: "Turnover Discount tier update",
  tod_credit_note_created: "Turnover Discount Credit Note",
  cd_credit_note_created: "Cash Discount Credit Note",
  cd_debit_note_created: "Cash Discount Debit Note",
  cd_shortfall: "Cash Discount reminder",
};
const typeLabel = (eventType: string) => MESSAGE_TYPE_LABEL[eventType] ?? userLabel(eventType);
const rupees = (value: string | null | undefined) => value ? `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : null;
const shortDay = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** One line naming what the message was about: the document, amount and period. */
function documentLine(message: NotificationMessage) {
  const doc = message.document;
  if (!doc) return null;
  const period = doc.periodStart && doc.periodEnd ? `${shortDay(doc.periodStart)} – ${shortDay(doc.periodEnd)}` : null;
  const name = doc.number ? `${doc.kind === "debit_note" ? "Debit Note" : "Credit Note"} ${doc.number}` : message.event_type === "tod_tier_reached" ? "Projected discount" : null;
  return [name, rupees(doc.amount), doc.invoiceReference ? `Inv ${doc.invoiceReference}` : null, period].filter(Boolean).join(" · ") || null;
}

/**
 * Plain status for one message: what happened, why, and whether sending again
 * can help. "Needs attention" is only for failures someone can act on.
 */
function explain(message: NotificationMessage): { label: string; tone: "done" | "active" | "problem" | "muted"; detail: string | null; canRetry: boolean; bucket: Exclude<MessageView, "all"> } {
  const reason = message.failure_reason ?? "";
  if (message.status === "read") return { label: "Read", tone: "done", detail: message.read_at ? `Read ${formatDate(message.read_at)}` : null, canRetry: false, bucket: "sent" };
  if (message.status === "delivered") return { label: "Delivered", tone: "done", detail: message.delivered_at ? `Delivered ${formatDate(message.delivered_at)}` : null, canRetry: false, bucket: "sent" };
  if (SENT_STATUSES.includes(message.status)) return { label: "Sent", tone: "done", detail: message.read_at ? `Read ${formatDate(message.read_at)}` : message.delivered_at ? `Delivered ${formatDate(message.delivered_at)}` : null, canRetry: false, bucket: "sent" };
  if (["queued", "sending"].includes(message.status)) return { label: "Sending…", tone: "active", detail: null, canRetry: false, bucket: "pending" };
  // Automatic tier updates are switched off; an old failed one needs no action.
  if (message.event_type === "tod_tier_reached") return { label: "Not sent", tone: "muted", detail: "Automatic tier updates are off. Nothing to do.", canRetry: false, bucket: "not_sent" };
  if (message.status === "suppressed") return { label: "Not sent", tone: "muted", detail: "Stopped on purpose: the customer's consent or the result changed.", canRetry: false, bucket: "not_sent" };
  if (message.status === "cancelled") return { label: "Cancelled", tone: "muted", detail: null, canRetry: false, bucket: "not_sent" };
  const missing = reason.match(/requires the (\w+) value/);
  if (missing) return { label: "Failed", tone: "problem", detail: `The WhatsApp template needs "${userLabel(missing[1])}", which this message doesn't have. Fix the template; sending again won't help.`, canRetry: false, bucket: "attention" };
  if (/permanent/i.test(reason)) return { label: "Failed", tone: "problem", detail: `${reason.replace(/^Permanent MSG91 failure:\s*/i, "")} Sending again won't help until this is fixed.`, canRetry: false, bucket: "attention" };
  return { label: "Failed", tone: "problem", detail: reason || "WhatsApp did not accept the message. Try sending again.", canRetry: true, bucket: "attention" };
}

/** Attempts of the same message (same document and number) shown as one row. */
function groupAttempts(messages: NotificationMessage[]) {
  const groups = new Map<string, NotificationMessage[]>();
  for (const message of messages) {
    const subject = message.credit_note_posting_id ?? message.cash_discount_debit_note_posting_id ?? message.proposal_id ?? message.business_event_key ?? message.id;
    const key = `${message.event_type}:${subject}:${message.recipient_phone_e164 ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }
  return [...groups.values()].map((attempts) => {
    const sorted = [...attempts].sort((left, right) => right.created_at.localeCompare(left.created_at));
    return { latest: sorted[0], attempts: sorted.length };
  }).sort((left, right) => right.latest.created_at.localeCompare(left.latest.created_at));
}

export function MessagesWorkspace({ data, isAdministrator, refresh, setError, setNotice }: PageProps) {
  const { company } = useCompany();
  const [selected, setSelected] = useState<NotificationMessage | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resend, setResend] = useState<NotificationMessage | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [sendingAgainId, setSendingAgainId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MessageView>("all");
  const [scheme, setScheme] = useState<Scheme>("all");
  const [eventFilter, setEventFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [layout, setLayout] = useState<"messages" | "customers">("messages");
  const [openCustomers, setOpenCustomers] = useState<Set<string>>(new Set());
  const events = Array.from(new Set(data.messages.filter((message) => scheme === "all" || schemeOf(message.event_type) === scheme).map((message) => message.event_type)));
  // One row per message; counts are per message, not per attempt.
  const everyRow = groupAttempts(data.messages).map((row) => ({ ...row, state: explain(row.latest) }));
  // Everything below follows the period (sent date; queued messages use their queued date).
  const sentOn = (message: NotificationMessage) => message.sent_at ?? message.created_at;
  const allRows = everyRow.filter((row) => inPeriod(period, sentOn(row.latest)));
  const attentionOutside = everyRow.filter((row) => !inPeriod(period, sentOn(row.latest)) && row.state.bucket === "attention").length;
  // Same shape as the Cash Discount and Turnover Discount pages: pick the area, then filter.
  const schemeCards = (["all", "tod", "cd"] as const).map((key) => {
    const inScheme = allRows.filter((row) => key === "all" || schemeOf(row.latest.event_type) === key);
    return { key, label: key === "all" ? "All messages" : key === "tod" ? "Turnover Discount" : "Cash Discount", total: inScheme.length, sent: inScheme.filter((row) => row.state.bucket === "sent").length, attention: inScheme.filter((row) => row.state.bucket === "attention").length };
  });
  const rows = allRows.filter((row) => scheme === "all" || schemeOf(row.latest.event_type) === scheme);
  const count = (bucket: Exclude<MessageView, "all">) => rows.filter((row) => row.state.bucket === bucket).length;
  const groupOf = (message: NotificationMessage) => message.customer_group ?? "No group";
  const groupOptions = [...new Set(rows.map((row) => groupOf(row.latest)))].sort((left, right) => left === "No group" ? 1 : right === "No group" ? -1 : left.localeCompare(right));
  const visibleRows = rows.filter(({ latest: message, state }) => {
    const searchable = `${message.customer_name ?? ""} ${message.customer_group ?? ""} ${message.recipient_phone_e164 ?? ""} ${typeLabel(message.event_type)} ${documentLine(message) ?? ""} ${state.label}`.toLowerCase();
    return (view === "all" || state.bucket === view) && (eventFilter === "all" || message.event_type === eventFilter) && (groupFilter === "all" || groupOf(message) === groupFilter) && (!query.trim() || searchable.includes(query.trim().toLowerCase()));
  });
  // By customer: everything sent to one customer together; customers needing attention first.
  const customers = [...visibleRows.reduce((map, row) => {
    const key = row.latest.customer_id ?? `name:${row.latest.customer_name ?? row.latest.recipient_phone_e164 ?? row.latest.id}`;
    const entry = map.get(key) ?? { key, name: row.latest.customer_name || "Customer", group: row.latest.customer_group ?? null, rows: [] as typeof visibleRows };
    entry.rows.push(row);
    return map.set(key, entry);
  }, new Map<string, { key: string; name: string; group: string | null; rows: typeof visibleRows }>()).values()].map((customer) => ({
    ...customer,
    sent: customer.rows.filter((row) => row.state.bucket === "sent").length,
    attention: customer.rows.filter((row) => row.state.bucket === "attention").length,
    last: customer.rows.reduce((latest, row) => (row.latest.sent_at ?? row.latest.created_at) > latest ? (row.latest.sent_at ?? row.latest.created_at) : latest, ""),
  })).sort((left, right) => (right.attention - left.attention) || right.last.localeCompare(left.last));
  const clearFilters = () => { setQuery(""); setView("all"); setEventFilter("all"); setGroupFilter("all"); };
  const pickScheme = (key: Scheme) => { setScheme(key); setEventFilter("all"); };

  async function openMessage(message: NotificationMessage) {
    setSelected(message); setDetail(null); setDetailLoading(true);
    const token = await accessToken();
    if (!token) return;
    try { setDetail(await apiRequest<MessageDetail>(token, `/api/companies/${company.id}/notifications/${message.id}`)); }
    catch (cause) { setError(userFacingError(cause, "Could not load the message details.")); }
    finally { setDetailLoading(false); }
  }

  async function doResend(form: HTMLFormElement) {
    if (!resend) return;
    const token = await accessToken(); if (!token) return;
    try {
      const fields = new FormData(form);
      await apiRequest(token, `/api/companies/${company.id}/notifications/${resend.id}/resend`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: jsonBody({ reason: fields.get("reason") }) });
      setResend(null); setNotice("The message is ready to be sent again to the same customer."); await refresh();
    } catch (cause) { setError(userFacingError(cause, "Could not resend the message.")); }
  }

  // Credit and Debit Note messages are sent again as a fresh message to the
  // same number; reminders keep the audited resend flow.
  async function sendAgain(message: NotificationMessage) {
    const kind = message.cash_discount_debit_note_posting_id ? "debit_note" : message.credit_note_posting_id ? "credit_note" : null;
    const postingId = message.cash_discount_debit_note_posting_id ?? message.credit_note_posting_id;
    if (!kind || !postingId) { setResend(message); return; }
    const token = await accessToken(); if (!token) return;
    setSendingAgainId(message.id); setError(null);
    try {
      const response = await apiRequest<{ results: Array<{ ok: boolean; error?: string }> }>(token, `/api/companies/${company.id}/notifications/send`, { method: "POST", body: jsonBody({ items: [{ kind, postingId, phone: message.recipient_phone_e164 }] }) });
      const result = response.results[0];
      if (!result?.ok) throw new Error(result?.error ?? "The message could not be sent again.");
      setNotice(`WhatsApp queued again to ${message.recipient_phone_e164}.`); await refresh();
    } catch (cause) { setError(userFacingError(cause, "Could not send the message again.")); }
    finally { setSendingAgainId(null); }
  }

  const renderMessageRow = ({ latest: message, attempts, state }: (typeof visibleRows)[number]) => {
        const doc = documentLine(message);
        const canSendAgain = state.canRetry && Boolean(message.credit_note_posting_id || message.cash_discount_debit_note_posting_id || message.event_type === "cd_shortfall");
        return <article key={message.id} data-tone={state.tone}>
          <div><strong>{message.customer_name || "Customer"}</strong><small>{message.customer_group && layout === "messages" && <span className="cd-tag note-group-tag">{message.customer_group}</span>}{message.recipient_phone_e164 || "Number unavailable"}</small></div>
          <div><strong>{typeLabel(message.event_type)}</strong>{doc && <small>{doc}</small>}</div>
          <div className="message-state"><span className={`message-state-label is-${state.tone}`}>{state.label}</span>{state.detail && <small title={message.failure_reason ?? undefined}>{state.detail}</small>}</div>
          <div><small>{formatDate(message.sent_at ?? message.created_at)}</small>{attempts > 1 && <small className="message-attempts">{attempts} attempts</small>}</div>
          <div className="table-actions"><Button className="button-quiet" onClick={() => void openMessage(message)}><Eye size={14} />View</Button>{canSendAgain && <Button className="button-quiet" disabled={sendingAgainId === message.id} onClick={() => void sendAgain(message)}><Send size={14} />{sendingAgainId === message.id ? "Sending…" : "Send again"}</Button>}</div>
        </article>;
  };
  return <div className="messages-page">
    <WorkspacePageHeader eyebrow="Delivery history" title="Messages" detail="WhatsApp delivery status and audit history." />
    {data.messages.some((message) => message.event_type === "cd_shortfall" && ["queued", "sending"].includes(message.status)) && <InlineMessage tone="info">A <strong>Cash Discount reminder</strong> is ready for a customer who has given consent. It is only a WhatsApp reminder and does not create a Credit Note.</InlineMessage>}
    {/* Same header as Credit Notes: scheme tabs + period, then status and tools, then the result. */}
    <div className="nf-head">
      <div className="nf-tabs" role="tablist" aria-label="Message areas">
        {schemeCards.filter((card) => card.key === "all" || card.total > 0).map((card) => <button key={card.key} type="button" role="tab" aria-selected={scheme === card.key} className={scheme === card.key ? "is-active" : ""} onClick={() => pickScheme(card.key)}>
          {card.label}<span className="nf-count">{card.total}</span>{card.attention > 0 && <span className="nf-dot" title={`${card.attention} need attention`} />}
        </button>)}
      </div>
      <div className="nf-period"><CalendarDays size={15} aria-hidden="true" /><PeriodFilter period={period} basis="Sent date" onChange={setPeriod} /></div>
    </div>
    <div className="nf-toolbar">
      <div className="nf-seg" role="tablist" aria-label="Status">
        {([["all", "All", rows.length], ["attention", "Needs attention", count("attention")], ["sent", "Sent", count("sent")], ["pending", "Sending", count("pending")], ["not_sent", "Not sent", count("not_sent")]] as const)
          .filter(([key, , total]) => key === "all" || key === "attention" || key === "sent" || total > 0)
          .map(([key, label, total]) => <button key={key} type="button" role="tab" aria-selected={view === key} className={`${view === key ? "is-active" : ""}${key === "attention" && total > 0 ? " is-alert" : ""}`} onClick={() => setView(key)}>{label}<span>{total}</span></button>)}
      </div>
      <div className="nf-tools">
        <label className="nf-search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search messages</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer, number, CN" /></label>
        {events.length > 1 && <label className="nf-select"><span className="sr-only">Message type</span><select value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}><option value="all">All types</option>{events.map((event) => <option key={event} value={event}>{typeLabel(event)}</option>)}</select></label>}
        {groupOptions.length > 1 && <label className="nf-select"><span className="sr-only">Customer group</span><select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}><option value="all">All groups</option>{groupOptions.map((group) => <option key={group} value={group}>{group} ({rows.filter((row) => groupOf(row.latest) === group).length})</option>)}</select></label>}
        <div className="nf-seg nf-icons" role="tablist" aria-label="Layout">
          <button type="button" role="tab" aria-selected={layout === "messages"} className={layout === "messages" ? "is-active" : ""} title="List" onClick={() => setLayout("messages")}><List size={15} /><span className="sr-only">List</span></button>
          <button type="button" role="tab" aria-selected={layout === "customers"} className={layout === "customers" ? "is-active" : ""} title="By customer" onClick={() => setLayout("customers")}><Users size={15} /><span className="sr-only">By customer</span></button>
        </div>
      </div>
    </div>
    <p className="nf-summary">
      <span><strong>{visibleRows.length}</strong> message{visibleRows.length === 1 ? "" : "s"}{layout === "customers" ? ` · ${customers.length} customer${customers.length === 1 ? "" : "s"}` : ""}{period.preset !== "all" ? ` · ${periodLabel(period).replace(/^.*\((.*)\)$/, "$1")}` : ""}</span>
      {attentionOutside > 0 && <button type="button" className="inline-link is-attention" onClick={() => setPeriod({ preset: "all", from: "", to: "" })}>{attentionOutside} need attention outside this period</button>}
      {(query || view !== "all" || eventFilter !== "all" || groupFilter !== "all") && <button type="button" className="inline-link" onClick={clearFilters}>Clear filters</button>}
    </p>
    <section className="messages-history">
      {!visibleRows.length ? <EmptyState title={data.messages.length ? view === "attention" ? "Nothing needs attention" : "No messages match this view" : "No messages yet"} detail={data.messages.length ? view === "attention" ? "Every message was sent, or stopped on purpose." : "Clear or change the filters to see all messages." : "Send Credit Notes on WhatsApp from the Credit Notes page. Every message appears here with its delivery status."} action={data.messages.length && view !== "attention" ? <Button className="button-secondary" onClick={clearFilters}>Clear filters</Button> : undefined} />
        : layout === "messages" ? <div className="data-table messages-table"><div className="table-head"><span>Customer</span><span>Message</span><span>Status</span><span>When</span><span /></div>{visibleRows.map(renderMessageRow)}</div>
        : <div className="note-customers" aria-label="Messages by customer">{customers.map((customer) => {
          const open = openCustomers.has(customer.key);
          return <section key={customer.key} className={`note-customer${open ? " is-open" : ""}`}>
            <div className="note-customer-head message-customer-head">
              <button type="button" className="note-customer-toggle" aria-expanded={open} onClick={() => setOpenCustomers((current) => { const next = new Set(current); if (next.has(customer.key)) next.delete(customer.key); else next.add(customer.key); return next; })}>
                <ChevronRight size={15} className="note-customer-caret" />
                <span><strong>{customer.name}</strong><small>{customer.group ?? "No group"} · {customer.rows.length} message{customer.rows.length === 1 ? "" : "s"}</small></span>
              </button>
              <span className={`message-state-label is-${customer.attention ? "problem" : customer.sent === customer.rows.length ? "done" : "muted"}`}>{customer.attention ? `${customer.attention} need attention` : `${customer.sent} of ${customer.rows.length} sent`}</span>
              <small>{customer.last ? `Last ${formatDate(customer.last)}` : ""}</small>
            </div>
            {open && <div className="data-table messages-table note-customer-notes">{customer.rows.map(renderMessageRow)}</div>}
          </section>;
        })}</div>}
    </section>
    <MessageDetailDrawer message={selected} detail={detail} loading={detailLoading} onClose={() => { setSelected(null); setDetail(null); }} />
    <Drawer open={Boolean(resend)} onClose={() => setResend(null)} title="Send message again" description="The current template and consent will be checked before anything is queued."><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void doResend(event.currentTarget); }}><label>Reason for sending again<textarea name="reason" required maxLength={500} placeholder="Why this message should be sent again" /></label><Button type="submit">Check and send again</Button></form></Drawer>
    {isAdministrator && <TemplateManager open={templatesOpen} onClose={() => setTemplatesOpen(false)} templates={data.templates} onSaved={async (message) => { setNotice(message); await refresh(); }} onError={setError} />}
  </div>;
}

function MessageLoadingBlock({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`workspace-loading-block ${className}`} />;
}

function MessageDetailLoading() {
  return <div className="drawer-stack message-detail-loading" aria-label="Loading message details">
    <div className="message-detail-loading-grid">{Array.from({ length: 4 }, (_, index) => <div key={index}><MessageLoadingBlock className="message-detail-loading-label" /><MessageLoadingBlock className="message-detail-loading-value" /></div>)}</div>
    <section><MessageLoadingBlock className="message-detail-loading-label" /><div className="message-detail-loading-bubble"><MessageLoadingBlock className="message-detail-loading-line" /><MessageLoadingBlock className="message-detail-loading-copy" /><MessageLoadingBlock className="message-detail-loading-copy short" /><MessageLoadingBlock className="message-detail-loading-copy" /></div></section>
    <section><MessageLoadingBlock className="message-detail-loading-heading" /><div className="message-detail-loading-timeline">{Array.from({ length: 2 }, (_, index) => <div key={index}><MessageLoadingBlock className="message-detail-loading-dot" /><div><MessageLoadingBlock className="message-detail-loading-line" /><MessageLoadingBlock className="message-detail-loading-copy short" /></div></div>)}</div></section>
  </div>;
}

function WhatsAppMessagePreview({ eventType, preview, sent, at }: { eventType: string; preview: MessageDetail["preview"]; sent?: MessageDetail["sent"]; at: string | null }) {
  if (sent?.text) {
    return <div className="whatsapp-preview"><div className="whatsapp-preview-bar"><span>WhatsApp</span><small>Template {sent.templateName}</small></div><div className="whatsapp-chat"><div className="whatsapp-bubble">{sent.attachment && <p className="whatsapp-attachment">📄 {sent.attachment}</p>}<p style={{ whiteSpace: "pre-line" }}>{sent.text}</p><time>{formatDate(at)}</time></div></div></div>;
  }
  const values = new Map(preview.map((item) => [item.variable, item.value]));
  const value = (key: string, fallback = "—") => values.get(key) || fallback;
  const money = (displayKey: string, rawKey: string) => {
    const display = value(displayKey, "");
    if (display) return display.startsWith("₹") ? display : `₹${display}`;
    const raw = value(rawKey);
    return raw === "—" || raw.startsWith("₹") ? raw : `₹${raw}`;
  };
  const businessDate = (key: string) => {
    const raw = value(key);
    if (raw === "—") return raw;
    const parsed = new Date(`${raw.slice(0, 10)}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleDateString(undefined, { dateStyle: "medium" });
  };
  const lines = eventType === "cd_shortfall"
    ? [<><strong>{value("customerName", "Customer")}</strong>, your Cash Discount payment is almost complete.</>, <>Amount received: <strong>{money("paidAmountDisplay", "paidAmount")}</strong></>, <>Amount remaining: <strong>{money("shortfallAmountDisplay", "shortfallAmount")}</strong></>, <>Pay by <strong>{businessDate("eligibilityDeadline")}</strong> to qualify.</>]
    : eventType === "tod_tier_reached"
      ? [<>Hello <strong>{value("customerName", "Customer")}</strong>,</>, <>You reached the <strong>{value("todTierPercentage")}% Turnover Discount slab</strong>.</>, <>Period: {value("todPeriodDisplay")}</>, <>Eligible quantity: {value("todTonnesDisplay")} tonnes</>, <>Projected benefit: <strong>₹{value("benefitAmount")}</strong></>]
      : [<>Hello <strong>{value("customerName", "Customer")}</strong>,</>, <>Your Credit Note <strong>{value("creditNoteNumber")}</strong> for <strong>{value("creditNoteAmountDisplay")}</strong> is ready.</>, preview.some((item) => item.type === "document") ? <>The verified Credit Note is attached.</> : <>Your Credit Note details are shown above.</>];
  return <div className="whatsapp-preview"><div className="whatsapp-preview-bar"><span>WhatsApp</span><small>Content preview</small></div><div className="whatsapp-chat"><div className="whatsapp-bubble">{lines.map((line, index) => <p key={index}>{line}</p>)}<time>{formatDate(at)}</time></div></div></div>;
}

function MessageDetailDrawer({ message, detail, loading, onClose }: { message: NotificationMessage | null; detail: MessageDetail | null; loading: boolean; onClose: () => void }) {
  return <Drawer open={Boolean(message)} onClose={onClose} title={message ? userLabel(message.event_type) : "Message"}>{loading || !message ? <MessageDetailLoading /> : <div className="drawer-stack message-detail-drawer"><dl className="message-detail-summary"><div><dt>Recipient</dt><dd>{message.recipient_phone_e164 || "Number unavailable"}</dd></div><div><dt>Status</dt><dd><StatusBadge status={message.status} /></dd></div><div><dt>Attempts</dt><dd>{message.attempt_count} of {message.max_attempts}</dd></div><div><dt>Consent</dt><dd>{message.opt_in_snapshot && Object.keys(message.opt_in_snapshot).length ? "Recorded" : "Not available"}</dd></div></dl>{message.failure_reason && <InlineMessage tone="error">{userFacingDetail(message.failure_reason, "This message needs attention.")}</InlineMessage>}<section><p className="eyebrow">Message preview</p><WhatsAppMessagePreview eventType={message.event_type} preview={detail?.preview ?? []} sent={detail?.sent} at={message.sent_at ?? message.created_at} /></section><section><p className="eyebrow">Sending history</p>{detail?.attempts.length ? <div className="timeline">{detail.attempts.map((attempt) => <article key={attempt.id}><span /><div><strong>Try {attempt.attempt_number} · {userLabel(attempt.status)}</strong>{attempt.failure_reason && <p>This attempt needs attention.</p>}<small>{formatDate(attempt.completed_at ?? attempt.attempted_at)}</small></div></article>)}</div> : <p className="muted-copy">No sending attempt recorded.</p>}</section></div>}</Drawer>;
}

function getSampleVariableValue(varName: string): string {
  switch (varName) {
    case "customerName": return "Meenakshi Steels Ltd";
    case "companyName": return "Meenakshi";
    case "paidAmount": return "1,50,000.00";
    case "paidAmountDisplay": return "₹1,50,000.00";
    case "benefitAmountDisplay": return "₹7,500.00";
    case "benefitAmount": return "7,500.00";
    case "shortfallAmount": return "25,000.00";
    case "shortfallAmountDisplay": return "₹25,000.00";
    case "eligibilityDeadline": return "15 Aug 2026";
    case "creditNoteNumber": return "CN/2026-27/0142";
    case "creditNoteDate": return "08 Aug 2026";
    case "creditNoteAmountDisplay": return "₹12,450.00";
    case "creditNoteAmount": return "12,450.00";
    case "debitNoteNumber": return "DN/2026-27/0031";
    case "debitNoteDate": return "12 Aug 2026";
    case "debitNoteAmount": return "4,200.00";
    case "debitNoteAmountDisplay": return "₹4,200.00";
    case "documentUrl": return "Credit Note PDF";
    case "invoiceReference": return "INV/2026/8841";
    case "todPeriodDisplay": return "01 Jul 2026 - 31 Jul 2026";
    case "todTonnesDisplay": return "150.50";
    case "todTierPercentage": return "3";
    default: return `[${varName}]`;
  }
}

function getAvailableVariables(eventType: string): string[] {
  if (eventType === "cd_shortfall") {
    return ["customerName", "paidAmount", "paidAmountDisplay", "benefitAmountDisplay", "shortfallAmount", "shortfallAmountDisplay", "eligibilityDeadline"];
  }
  if (eventType === "tod_credit_note_created") {
    return ["customerName", "companyName", "creditNoteNumber", "creditNoteDate", "creditNoteAmount", "creditNoteAmountDisplay", "todPeriodDisplay", "todTonnesDisplay", "documentUrl", "documentName"];
  }
  if (eventType === "tod_tier_reached") {
    return ["customerName", "todTierPercentage", "todPeriodDisplay", "todTonnesDisplay", "benefitAmount"];
  }
  if (eventType === "cd_debit_note_created") {
    return ["customerName", "companyName", "debitNoteNumber", "debitNoteDate", "debitNoteAmount", "debitNoteAmountDisplay", "invoiceReference", "documentUrl", "documentName"];
  }
  return ["customerName", "companyName", "creditNoteNumber", "creditNoteDate", "creditNoteAmount", "creditNoteAmountDisplay", "invoiceReference", "documentUrl", "documentName"];
}

function TemplateWhatsAppPreview({ eventType, mappings, providerTemplateId }: { eventType: string; mappings: Mapping[]; providerTemplateId?: string }) {
  const getVal = (idx: number, fallback: string) => {
    const varName = mappings[idx]?.value || fallback;
    return getSampleVariableValue(varName);
  };

  return (
    <div className="whatsapp-preview-bubble">
      <div className="whatsapp-preview-header">
        <MessageSquare size={12} /> Illustrative preview · confirm wording in MSG91
      </div>
      {providerTemplateId === "share_credit_memo" ? (
        <p><strong>PDF attachment</strong><br />Dear <span className="whatsapp-var-highlight">{getSampleVariableValue(mappings.find((row) => row.component === "body_1")?.value ?? "customerName")}</span>,<br /><br />Your credit memo <span className="whatsapp-var-highlight">{getSampleVariableValue(mappings.find((row) => row.component === "body_2")?.value ?? "creditNoteNumber")}</span> dated <span className="whatsapp-var-highlight">{getSampleVariableValue(mappings.find((row) => row.component === "body_3")?.value ?? "creditNoteDate")}</span> has been generated.<br /><br />Credit Amount: ₹<span className="whatsapp-var-highlight">{getSampleVariableValue(mappings.find((row) => row.component === "body_4")?.value ?? "creditNoteAmount")}</span><br /><br />Please find the credit memo PDF attached above.<br /><br />Thank you,<br />The <span className="whatsapp-var-highlight">{getSampleVariableValue(mappings.find((row) => row.component === "body_5")?.value ?? "companyName")}</span> Team</p>
      ) : eventType === "cd_shortfall" ? (
        mappings.length === 4 ? (
          <p>
            Meenakshi: Hello <span className="whatsapp-var-highlight">{getVal(0, "customerName")}</span>. We received ₹<span className="whatsapp-var-highlight">{getVal(1, "paidAmount")}</span>. The remaining amount to qualify for the cash discount is ₹<span className="whatsapp-var-highlight">{getVal(2, "shortfallAmount")}</span>. Please complete payment by <span className="whatsapp-var-highlight">{getVal(3, "eligibilityDeadline")}</span>. Thank you.
          </p>
        ) : (
          <p>
            Dear <span className="whatsapp-var-highlight">{getVal(0, "customerName")}</span>, payment of <span className="whatsapp-var-highlight">{getVal(1, "paidAmountDisplay")}</span> was received. To earn your Cash Discount of <span className="whatsapp-var-highlight">{getVal(2, "benefitAmountDisplay")}</span>, please settle the shortfall of <span className="whatsapp-var-highlight">{getVal(3, "shortfallAmountDisplay")}</span> by <span className="whatsapp-var-highlight">{getVal(4, "eligibilityDeadline")}</span>.
          </p>
        )
      ) : eventType === "tod_tier_reached" ? (
        <p>
          Meenakshi: Hello <span className="whatsapp-var-highlight">{getVal(0, "customerName")}</span>. You have reached the <span className="whatsapp-var-highlight">{getVal(1, "todTierPercentage")}%</span> Turnover Discount tier for the period <span className="whatsapp-var-highlight">{getVal(2, "todPeriodDisplay")}</span>. Your eligible turnover is <span className="whatsapp-var-highlight">{getVal(3, "todTonnesDisplay")} MT</span> and your projected discount is ₹<span className="whatsapp-var-highlight">{getVal(4, "benefitAmount")}</span>. This will be processed as per the scheme terms. Thank you.
        </p>
      ) : eventType === "cd_debit_note_created" ? (
        <p>
          Dear <span className="whatsapp-var-highlight">{getVal(0, "customerName")}</span>, Debit Note <span className="whatsapp-var-highlight">{getVal(1, "debitNoteNumber")}</span> dated <span className="whatsapp-var-highlight">{getVal(2, "debitNoteDate")}</span> for <span className="whatsapp-var-highlight">{getVal(3, "debitNoteAmountDisplay")}</span> has been raised against invoice <span className="whatsapp-var-highlight">{getVal(4, "invoiceReference")}</span> because the Cash Discount payment deadline was missed.
        </p>
      ) : eventType === "tod_credit_note_created" ? (
        <p>
          Dear <span className="whatsapp-var-highlight">{getVal(0, "customerName")}</span>, your Turnover Discount Credit Note <span className="whatsapp-var-highlight">{getVal(1, "creditNoteNumber")}</span> for <span className="whatsapp-var-highlight">{getVal(2, "creditNoteAmountDisplay")}</span> (Period: <span className="whatsapp-var-highlight">{getVal(3, "todPeriodDisplay")}</span>, Tonnage: <span className="whatsapp-var-highlight">{getVal(4, "todTonnesDisplay")} MT</span>) has been created.
        </p>
      ) : (
        <p>
          Dear <span className="whatsapp-var-highlight">{getVal(0, "customerName")}</span>, Credit Note <span className="whatsapp-var-highlight">{getVal(1, "creditNoteNumber")}</span> dated <span className="whatsapp-var-highlight">{getVal(2, "creditNoteDate")}</span> for <span className="whatsapp-var-highlight">{getVal(3, "creditNoteAmountDisplay")}</span> against invoice <span className="whatsapp-var-highlight">{getVal(4, "invoiceReference")}</span> has been verified and posted in Tally.
        </p>
      )}
      <div className="whatsapp-preview-footer">
        <span>14:30</span>
        <CheckCheck size={13} color="#53bdeb" />
      </div>
    </div>
  );
}

function TemplateManager({ open, onClose, templates, onSaved, onError }: { open: boolean; onClose: () => void; templates: MessageTemplate[]; onSaved: (message: string) => Promise<void>; onError: (message: string | null) => void }) {
  const { company } = useCompany();
  const [activeTab, setActiveTab] = useState<"list" | "create">("list");
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [eventType, setEventType] = useState<string>("cd_shortfall");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [mappings, setMappings] = useState<Mapping[]>(initialMappings("cd_shortfall"));
  const options = useMemo(() => catalogOptions(catalog?.templates), [catalog]);

  useEffect(() => {
    if (open && !catalog && !catalogLoading) void openCatalog();
    // Only refresh on opening; the explicit Refresh button handles later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function selectCatalogTemplate(optionId: string) {
    const option = options.find((candidate) => candidate.id === optionId);
    if (!option) return;
    setSelectedProviderId(option.providerTemplateId);
    const providerIdInput = document.querySelector<HTMLInputElement>("#provider-template-id");
    if (providerIdInput) providerIdInput.value = option.providerTemplateId;
    const nameInput = document.querySelector<HTMLInputElement>("#internal-template-name");
    if (nameInput) nameInput.value = option.providerTemplateId;
    const languageInput = document.querySelector<HTMLInputElement>("#template-language-code");
    if (languageInput) languageInput.value = option.languageCode;
    const namespaceInput = document.querySelector<HTMLInputElement>("#template-namespace");
    if (namespaceInput) namespaceInput.value = option.namespace ?? "";
    const defaults = option.providerTemplateId === "share_credit_memo" && ["tod_credit_note_created", "cd_credit_note_created"].includes(eventType)
      ? ["customerName", "creditNoteNumber", "creditNoteDate", "creditNoteAmount", "companyName"]
      : initialMappings(eventType, option.variables).map((mapping) => mapping.value);
    let textIndex = 0;
    setMappings(option.variables.map((component) => {
      if (option.variableTypes[component] === "document") return { component, value: "documentUrl", type: "document" as const, filenameValue: "documentName" };
      const value = defaults[textIndex] ?? "customerName";
      textIndex += 1;
      return { component, value, type: "text" as const };
    }));
  }

  const activeCount = useMemo(() => templates.filter((t) => t.is_active).length, [templates]);

  const visibleTemplates = useMemo(() => {
    if (eventFilter === "all") return templates;
    return templates.filter((t) => t.event_type === eventFilter);
  }, [templates, eventFilter]);

  async function openCatalog() {
    const token = await accessToken(); if (!token) return;
    setCatalogLoading(true);
    try { setCatalog(await apiRequest<CatalogResponse>(token, `/api/companies/${company.id}/message-templates?providerCatalog=true`)); }
    catch (cause) { onError(userFacingError(cause, "Could not load the approved WhatsApp templates.")); }
    finally { setCatalogLoading(false); }
  }

  async function submit(form: HTMLFormElement) {
    const token = await accessToken(); if (!token) return;
    const fields = new FormData(form);
    try {
      await apiRequest(token, `/api/companies/${company.id}/message-templates`, { method: "POST", body: jsonBody({ eventType, providerTemplateId: fields.get("providerTemplateId"), name: fields.get("name"), languageCode: fields.get("languageCode"), templateNamespace: fields.get("templateNamespace"), isActive: fields.get("isActive") === "on", componentSchema: { components: mappings } }) });
      await onSaved("Approved WhatsApp template saved.");
      setActiveTab("list");
    } catch (cause) {
      const message = userFacingError(cause, "Could not save the approved WhatsApp template.");
      if (message.includes("already exists")) {
        await onSaved("This approved WhatsApp template already exists. It was left unchanged.");
        setActiveTab("list");
        return;
      }
      onError(message);
    }
  }

  async function setActive(template: MessageTemplate, active: boolean) {
    const token = await accessToken(); if (!token) return;
    try { await apiRequest(token, `/api/companies/${company.id}/message-templates/${template.id}`, { method: "PATCH", body: jsonBody({ isActive: active }) }); await onSaved(active ? "Template activated." : "Template retired."); }
    catch (cause) { onError(userFacingError(cause, "The approved WhatsApp template could not be changed.")); }
  }

  function addVariableChip(varName: string) {
    if (mappings.some((m) => m.value === varName)) return;
    setMappings((prev) => [
      ...prev,
      { component: `body_var_${prev.length + 1}`, value: varName, type: "text" },
    ]);
  }

  return (
    <Drawer open={open} onClose={onClose} title="Approved WhatsApp templates" description="Choose the approved WhatsApp content used for each customer message." width="wide">
      <div className="template-manager-container">
        {/* Navigation Tabs */}
        <nav className="template-manager-tabs" aria-label="Template manager navigation">
          <button type="button" className={activeTab === "list" ? "active" : ""} onClick={() => setActiveTab("list")}>
            <Layers size={15} /> Active Mappings ({activeCount})
          </button>
          <button type="button" className={activeTab === "create" ? "active" : ""} onClick={() => setActiveTab("create")}>
            <Plus size={15} /> Add template
          </button>
        </nav>

        {activeTab === "list" && (
          <div className="drawer-stack">
            {/* Catalog Banner */}
            <div className="catalog-banner">
              <div className="catalog-banner-info">
                <div className="catalog-banner-icon">
                  <Sparkles size={18} />
                </div>
                <div className="catalog-banner-text">
                  <strong>Approved WhatsApp templates</strong>
                  <span>
                    {catalog?.configured
                      ? `${options.length || "Catalog"} approved template entries ready`
                      : catalog
                        ? "WhatsApp sending is not set up yet"
                        : "Load the latest approved templates from WhatsApp"}
                  </span>
                </div>
              </div>
              <Button type="button" className="button-secondary" onClick={() => void openCatalog()} disabled={catalogLoading}>
                <RefreshCw size={14} className={catalogLoading ? "animate-spin" : ""} />
                {catalogLoading ? "Loading…" : catalog ? "Refresh templates" : "Load templates"}
              </Button>
            </div>

            {/* Event Filter Pills */}
            {templates.length > 0 && (
              <div className="segmented" aria-label="Filter templates by event">
                <button type="button" className={eventFilter === "all" ? "selected" : ""} onClick={() => setEventFilter("all")}>
                  All Events ({templates.length})
                </button>
                {templateEvents.map((evt) => {
                  const count = templates.filter((t) => t.event_type === evt).length;
                  return (
                    <button key={evt} type="button" className={eventFilter === evt ? "selected" : ""} onClick={() => setEventFilter(evt)}>
                      {evt.replaceAll("_", " ")} ({count})
                    </button>
                  );
                })}
              </div>
            )}

            {/* Template Cards Grid */}
            <div className="template-card-grid">
              {visibleTemplates.length ? (
                visibleTemplates.map((tpl) => (
                  <article key={tpl.id} className="template-card">
                    <div className="template-card-header">
                      <div>
                        <h4>{tpl.name}</h4>
                        <div className="template-card-meta">
                          <span className="eyebrow">{tpl.event_type.replaceAll("_", " ")}</span>
                          <span>•</span>
                          <span>Lang: <strong>{tpl.language_code}</strong></span>
                          <span>•</span>
                          <span>ID: <code>{tpl.provider_template_id}</code></span>
                        </div>
                      </div>
                      <div className="table-actions">
                        {tpl.is_active && catalog && !options.some((option) => option.providerTemplateId === tpl.provider_template_id && option.languageCode === tpl.language_code)
                          ? <span className="status-badge tone-attention">{catalog.configured ? "Not approved in MSG91" : "MSG91 not configured"}</span>
                          : tpl.is_active && catalog
                            ? <span className="status-badge tone-good">Approved in MSG91</span>
                            : <StatusBadge status={tpl.is_active ? "active" : "retired"} />}
                        <Button type="button" className="button-quiet" onClick={() => void setActive(tpl, !tpl.is_active)}>
                          {tpl.is_active ? "Retire" : "Activate"}
                        </Button>
                      </div>
                    </div>

                    {tpl.is_active && catalog && !options.some((option) => option.providerTemplateId === tpl.provider_template_id && option.languageCode === tpl.language_code)
                      ? <InlineMessage tone="warning">{catalog.configured ? "This mapping is active locally, but MSG91 has not approved its template." : "MSG91 sending is not configured."} WhatsApp messages cannot be sent with it.</InlineMessage>
                      : null}

                    {/* Visual WhatsApp Preview */}
                    <TemplateWhatsAppPreview eventType={tpl.event_type} providerTemplateId={tpl.provider_template_id} mappings={tpl.component_schema?.components?.map((mapping) => ({ ...mapping, type: mapping.type ?? "text" })) ?? initialMappings(tpl.event_type)} />
                  </article>
                ))
              ) : (
                <EmptyState
                  title={templates.length ? "No templates match this filter" : "No approved templates yet"}
                  detail={templates.length ? "Choose another filter to see other messages." : "Add an approved WhatsApp template to start."}
                  action={
                    !templates.length ? (
                      <Button type="button" onClick={() => setActiveTab("create")}>
                        <Plus size={15} /> Add first template
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </div>
          </div>
        )}

        {activeTab === "create" && (
          <form className="builder-layout" onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget); }}>
            <div className="drawer-stack">
              <label>
                Business Event
                <select value={eventType} onChange={(e) => { setEventType(e.target.value); setMappings(initialMappings(e.target.value)); }}>
                  {templateEvents.map((val) => (
                    <option key={val} value={val}>{val.replaceAll("_", " ")}</option>
                  ))}
                </select>
              </label>

              {catalog?.configured && options.length > 0 && (
                <label>
                  Choose an approved WhatsApp template
                  <select onChange={(e) => selectCatalogTemplate(e.target.value)}>
                    <option value="">Select an approved WhatsApp template</option>
                    {options.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                  </select>
                </label>
              )}

              <div className="form-grid">
                <label>
                  WhatsApp template ID
                  <input id="provider-template-id" name="providerTemplateId" required maxLength={160} placeholder="e.g. cd_shortfall_v1" onChange={(e) => setSelectedProviderId(e.target.value)} />
                </label>
                <label>
                  Display name
                  <input id="internal-template-name" name="name" required maxLength={160} placeholder="e.g. CD Shortfall Reminder v1" />
                </label>
              </div>

              <label>
                Language
                <input id="template-language-code" name="languageCode" defaultValue="en" required maxLength={32} />
              </label>
              <input id="template-namespace" name="templateNamespace" type="hidden" />

              {/* Variable Quick-Add Chips */}
              <div className="variable-chip-section">
                <span>Details to include</span>
                <div className="variable-chip-group">
                  {getAvailableVariables(eventType).map((v) => (
                    <button key={v} type="button" className="variable-chip" onClick={() => addVariableChip(v)}>
                      <Plus size={12} /> {v}
                    </button>
                  ))}
                </div>
              </div>

              {/* Variable Mapping Table */}
              <fieldset className="mapping-fields">
                <legend>Message details</legend>
                {mappings.map((m, index) => (
                  <div key={m.component + index} className="mapping-table-row">
                    <input
                      value={m.component}
                      aria-label="Message detail position"
                      onChange={(e) => {
                        const val = e.target.value;
                        setMappings((rows) => rows.map((r, i) => (i === index ? { ...r, component: val } : r)));
                      }}
                    />
                    <div className="mapping-arrow"><ArrowRight size={14} /></div>
                    <select
                      value={m.value}
                      aria-label="Message detail"
                      onChange={(e) => {
                        const val = e.target.value;
                        setMappings((rows) => rows.map((r, i) => (i === index ? { ...r, value: val } : r)));
                      }}
                    >
                      {getAvailableVariables(eventType).map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                    <select aria-label="Message detail type" value={m.type} onChange={(e) => setMappings((rows) => rows.map((r, i) => i === index ? { ...r, type: e.target.value as "text" | "document", value: e.target.value === "document" ? "documentUrl" : r.value, filenameValue: e.target.value === "document" ? "documentName" : undefined } : r))}>
                      <option value="text">Text</option>
                      <option value="document">PDF</option>
                    </select>
                    <Button type="button" className="button-quiet" onClick={() => setMappings((rows) => rows.filter((_, i) => i !== index))}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button type="button" className="button-secondary" onClick={() => setMappings((rows) => [...rows, { component: `body_var_${rows.length + 1}`, value: getAvailableVariables(eventType)[0], type: "text" }])}>
                  <Plus size={14} /> Add detail
                </Button>
              </fieldset>

              {/* Live Preview Card */}
              <section>
                <p className="eyebrow">Live WhatsApp Preview</p>
                <TemplateWhatsAppPreview eventType={eventType} providerTemplateId={selectedProviderId} mappings={mappings} />
              </section>

              <label className="switch-field">
                <input name="isActive" type="checkbox" defaultChecked /> Activate immediately after save
              </label>

              <div className="drawer-actions">
                <Button type="submit">Save approved template</Button>
              </div>
            </div>
          </form>
        )}
      </div>
    </Drawer>
  );
}
