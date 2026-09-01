"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, CheckCheck, CheckCircle2, CircleAlert, Eye, FileText, Layers, MessageSquare, Plus, RefreshCw, Send, Sparkles, Trash2 } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError, userLabel } from "@/lib/user-copy";
import { supabase } from "@/lib/supabase";

import { WorkspacePageHeader } from "./app-shell";
import { useCompany } from "./company-context";
import type { PageProps } from "./workspace";
import type { MessageTemplate, NotificationMessage } from "./types";
import { Button, Card, Drawer, EmptyState, IconButton, InlineMessage, MetricCard, SectionHeading, StatusBadge, formatDate, safePhone } from "./ui";

type MessageDetail = {
  message: NotificationMessage & { delivered_at?: string | null; read_at?: string | null; scheduled_for?: string | null };
  attempts: Array<{ id: string; attempt_number: number; provider_message_id: string | null; status: string; attempted_at: string | null; completed_at: string | null; failure_reason: string | null }>;
};
type MessagePreview = { preview: Array<{ component: string; type: string; value: string; variable: string }> };
type CatalogResponse = { configured: boolean; templates: unknown };
type Mapping = { component: string; value: string; type: "text" | "document"; filenameValue?: string };
type CatalogOption = { id: string; label: string; providerTemplateId: string; languageCode: string; namespace?: string; variables: string[] };
type ControlledTest = { id: number; sentAt: string; providerMessageId: string | null };

const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-message-${Date.now()}`;
const templateEvents = ["cd_shortfall", "cd_credit_note_created", "tod_tier_reached", "tod_credit_note_created"] as const;

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
        const candidate: CatalogOption = {
          id: `${providerTemplateId}:${languageCode}`,
          label: `${providerTemplateId} (${languageCode})`,
          providerTemplateId,
          languageCode,
          namespace,
          variables,
        };
        if (!output.some((existing) => existing.id === candidate.id)) output.push(candidate);
      }
    }
    Object.values(item).forEach((child) => visit(child, depth + 1));
  };
  visit(payload, 0);
  return output;
}

export function MessagesWorkspace({ data, isAdministrator, refresh, setError, setNotice }: PageProps) {
  const { company } = useCompany();
  const [selected, setSelected] = useState<NotificationMessage | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [preview, setPreview] = useState<MessagePreview["preview"] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resend, setResend] = useState<NotificationMessage | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [testConfirmOpen, setTestConfirmOpen] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [controlledTests, setControlledTests] = useState<ControlledTest[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [eventFilter, setEventFilter] = useState("all");
  const metric = (statuses: string[]) => data.messages.filter((message) => statuses.includes(message.status)).length;
  const statuses = Array.from(new Set(data.messages.map((message) => message.status)));
  const events = Array.from(new Set(data.messages.map((message) => message.event_type)));
  const visibleMessages = data.messages.filter((message) => {
    const searchable = `${message.event_type} ${message.resend_reason ?? ""} ${message.status}`.toLowerCase();
    return (statusFilter === "all" || message.status === statusFilter) && (eventFilter === "all" || message.event_type === eventFilter) && (!query.trim() || searchable.includes(query.trim().toLowerCase()));
  });

  useEffect(() => {
    if (!isAdministrator) { setControlledTests([]); return; }
    void (async () => {
      const token = await accessToken(); if (!token) return;
      try { const result = await apiRequest<{ tests: ControlledTest[] }>(token, `/api/companies/${company.id}/notifications/test`); setControlledTests(result.tests); }
      catch { setControlledTests([]); }
    })();
  }, [company.id, isAdministrator]);

  async function openMessage(message: NotificationMessage) {
    setSelected(message); setDetail(null); setPreview(null); setDetailLoading(true);
    const token = await accessToken();
    if (!token) return;
    try { setDetail(await apiRequest<MessageDetail>(token, `/api/companies/${company.id}/notifications/${message.id}`)); }
    catch (cause) { setError(userFacingError(cause, "Could not load the message details.")); }
    finally { setDetailLoading(false); }
  }

  async function loadPreview() {
    if (!selected) return;
    const token = await accessToken(); if (!token) return;
    try { const response = await apiRequest<MessagePreview>(token, `/api/companies/${company.id}/notifications/previews`, { method: "POST", body: jsonBody({ notificationMessageId: selected.id }) }); setPreview(response.preview); }
    catch (cause) { setError(userFacingError(cause, "Could not show the message preview.")); }
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

  async function sendControlledTest() {
    const token = await accessToken(); if (!token) return;
    setTestSending(true);
    try {
      await apiRequest(token, `/api/companies/${company.id}/notifications/test`, { method: "POST", body: jsonBody({ confirm: true, ...(controlledTests.length === 1 ? { retest: "currency_format_correction" } : {}) }) });
      const history = await apiRequest<{ tests: ControlledTest[] }>(token, `/api/companies/${company.id}/notifications/test`);
      setControlledTests(history.tests);
      setTestConfirmOpen(false);
      setNotice(controlledTests.length === 1 ? "Correction retest accepted. Check your configured test number now; Meenakshi recorded the formatting retest." : "Controlled WhatsApp test accepted. Check your configured test number now; Meenakshi recorded the test audit.");
    } catch (cause) {
      setError(userFacingError(cause, "The controlled WhatsApp test could not be sent."));
    } finally { setTestSending(false); }
  }

  return <>
    <WorkspacePageHeader eyebrow="Delivery history" title="Messages" detail="View customer WhatsApp messages that have the required consent and approved content." action={isAdministrator ? <div className="table-actions"><Button className="button-secondary" onClick={() => setTestConfirmOpen(true)} disabled={controlledTests.length >= 2}><Send size={15} />{controlledTests.length === 1 ? "Send correction retest" : "Send controlled test"}</Button><IconButton label="Manage approved templates" onClick={() => setTemplatesOpen(true)}><FileText size={17} /></IconButton></div> : undefined} />
    {controlledTests.length > 0 && <InlineMessage tone="success">Controlled WhatsApp test sent {formatDate(controlledTests[0].sentAt)} to the configured test number. Delivery request recorded.</InlineMessage>}
    {data.messages.some((message) => message.event_type === "cd_shortfall" && ["queued", "sending"].includes(message.status)) && <InlineMessage tone="info">A <strong>Cash Discount reminder</strong> is ready for a customer who has given consent. It is only a WhatsApp reminder and does not create a Credit Note.</InlineMessage>}
    <div className="metric-grid message-metrics"><MetricCard label="Waiting to send" value={metric(["queued", "sending"])} detail="Ready to be sent" tone="info" icon={<Send size={19} />} /><MetricCard label="Trying again" value={data.messageHealth?.retrying ?? 0} detail="Meenakshi is trying again" tone="attention" icon={<RefreshCw size={19} />} /><MetricCard label="Delivered" value={metric(["sent", "delivered", "read", "whatsapp_sent"])} detail="Delivery confirmed" tone="good" icon={<CheckCircle2 size={19} />} /><MetricCard label="Needs attention" value={data.messageHealth?.terminalFailures ?? 0} detail="Review why the message was not sent" tone={data.messageHealth?.terminalFailures ? "danger" : "neutral"} icon={<CircleAlert size={19} />} /></div>
    <Card><div className="card-title"><div><p className="eyebrow">Messages</p><h2>Find a message</h2><p className="muted-copy">Cash Discount reminders are separate from Credit Notes, so you can see why each message was sent.</p></div><span className="table-count">{visibleMessages.length} shown</span></div><div className="queue-toolbar"><label className="queue-search"><span>Find message or status</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages" /></label><div className="filter-stack"><div className="segmented" aria-label="Message status filters"><button className={statusFilter === "all" ? "selected" : ""} onClick={() => setStatusFilter("all")}>All statuses</button>{statuses.map((status) => <button key={status} className={statusFilter === status ? "selected" : ""} onClick={() => setStatusFilter(status)}>{userLabel(status)}</button>)}</div><div className="segmented" aria-label="Message filters"><button className={eventFilter === "all" ? "selected" : ""} onClick={() => setEventFilter("all")}>All messages</button>{events.map((event) => <button key={event} className={eventFilter === event ? "selected" : ""} onClick={() => setEventFilter(event)}>{userLabel(event)}</button>)}</div></div></div>{visibleMessages.length ? <div className="data-table messages-table"><div className="table-head"><span>Message</span><span>Related item</span><span>Status</span><span>Consent</span><span>Created</span><span>Action</span></div>{visibleMessages.map((message) => { const source = message.credit_note_posting_id ? "Credit Note" : message.proposal_id ? message.event_type === "cd_shortfall" ? "Cash Discount" : "Discount result" : "Collections"; return <article key={message.id}><div><strong>{userLabel(message.event_type)}</strong><small>{message.resend_of_notification_id ? "Sent again" : "First message"} · {safePhone(message.recipient_phone_e164)}</small></div><small>{source}</small><StatusBadge status={message.status} /><small>{message.opt_in_snapshot ? "Consent recorded" : "Consent needed"}</small><small>{formatDate(message.created_at)}</small><div className="table-actions"><Button className="button-quiet" onClick={() => void openMessage(message)}><Eye size={15} />View</Button>{["sent", "delivered", "read", "failed"].includes(message.status) && <Button className="button-quiet" onClick={() => setResend(message)}>Resend</Button>}{message.status === "suppressed" && <small className="action-help">Add consent or an approved template first</small>}</div></article>; })}</div> : <EmptyState title={data.messages.length ? "No messages match this view" : "No messages yet"} detail={data.messages.length ? "Clear or change the filters to see all messages." : "Messages are sent only when customer consent and approved content are available."} action={data.messages.length ? <Button className="button-secondary" onClick={() => { setQuery(""); setStatusFilter("all"); setEventFilter("all"); }}>Clear filters</Button> : undefined} />}</Card>
    <MessageDetailDrawer message={selected} detail={detail} preview={preview} loading={detailLoading} onClose={() => { setSelected(null); setDetail(null); setPreview(null); }} onPreview={() => void loadPreview()} />
    <Drawer open={testConfirmOpen} onClose={() => !testSending && setTestConfirmOpen(false)} title={controlledTests.length === 1 ? "Send one correction retest" : "Send one controlled WhatsApp test"} description={controlledTests.length === 1 ? "This one permitted correction retest verifies the ₹ formatting. It sends only to the configured test number and cannot send to customers." : "This sends the active CD-shortfall template to the configured test number only. It cannot send to customers."}><div className="drawer-stack"><InlineMessage tone="warning">Use this only when you are ready to receive the real WhatsApp test now.</InlineMessage><dl className="detail-grid"><div><dt>Customer label</dt><dd>Apex Rebar Projects (test)</dd></div><div><dt>Template</dt><dd>Active CD shortfall</dd></div><div><dt>Recipient</dt><dd>Configured test number only</dd></div></dl><div className="drawer-actions"><Button onClick={() => void sendControlledTest()} disabled={testSending}>{testSending ? "Sending…" : controlledTests.length === 1 ? "Send correction retest" : "Send one test now"}</Button></div></div></Drawer>
    <Drawer open={Boolean(resend)} onClose={() => setResend(null)} title="Send message again" description="The same customer and approved message content will be used."><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void doResend(event.currentTarget); }}><label>Reason for sending again<textarea name="reason" required maxLength={500} placeholder="Why this message should be sent again" /></label><Button type="submit">Send again</Button></form></Drawer>
    {isAdministrator && <TemplateManager open={templatesOpen} onClose={() => setTemplatesOpen(false)} templates={data.templates} onSaved={async (message) => { setNotice(message); await refresh(); }} onError={setError} />}
  </>;
}

function MessageDetailDrawer({ message, detail, preview, loading, onClose, onPreview }: { message: NotificationMessage | null; detail: MessageDetail | null; preview: MessagePreview["preview"] | null; loading: boolean; onClose: () => void; onPreview: () => void }) {
  return <Drawer open={Boolean(message)} onClose={onClose} title="Message details" description="See the message, delivery status, and customer consent.">{loading || !message ? <p className="muted-copy">Loading message history…</p> : <div className="drawer-stack"><dl className="detail-grid"><div><dt>Message</dt><dd>{userLabel(message.event_type)}</dd></div><div><dt>Recipient</dt><dd>{safePhone(message.recipient_phone_e164)}</dd></div><div><dt>Status</dt><dd><StatusBadge status={message.status} /></dd></div><div><dt>Sending attempts</dt><dd>{message.attempt_count} of {message.max_attempts}</dd></div><div><dt>Consent</dt><dd>{message.opt_in_snapshot ? "Consent recorded" : "Not available"}</dd></div></dl>{message.failure_reason && <InlineMessage tone="error">{message.failure_reason}</InlineMessage>}<section><div className="card-title"><div><p className="eyebrow">Message preview</p><h3>Approved WhatsApp message</h3></div><Button className="button-secondary" onClick={onPreview}>Show preview</Button></div>{preview ? <div className="preview-components">{preview.map((item) => <div key={item.component}><strong>{item.component}</strong><span>{item.value}</span></div>)}</div> : <p className="muted-copy">Show the approved message that will be sent to the customer.</p>}</section><section><h3>Sending history</h3>{detail?.attempts.length ? <div className="timeline">{detail.attempts.map((attempt) => <article key={attempt.id}><span /><div><strong>Try {attempt.attempt_number}: {userLabel(attempt.status)}</strong><p>{attempt.failure_reason ? "This attempt needs attention." : "Delivery status recorded."}</p><small>{formatDate(attempt.completed_at ?? attempt.attempted_at)}</small></div></article>)}</div> : <p className="muted-copy">No sending attempt has been recorded yet.</p>}</section></div>}</Drawer>;
}

function getSampleVariableValue(varName: string): string {
  switch (varName) {
    case "customerName": return "Meenakshi Steels Ltd";
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
    return ["customerName", "creditNoteNumber", "creditNoteAmountDisplay", "todPeriodDisplay", "todTonnesDisplay"];
  }
  if (eventType === "tod_tier_reached") {
    return ["customerName", "todTierPercentage", "todPeriodDisplay", "todTonnesDisplay", "benefitAmount"];
  }
  return ["customerName", "creditNoteNumber", "creditNoteDate", "creditNoteAmountDisplay", "invoiceReference"];
}

function TemplateWhatsAppPreview({ eventType, mappings }: { eventType: string; mappings: Mapping[] }) {
  const getVal = (idx: number, fallback: string) => {
    const varName = mappings[idx]?.value || fallback;
    return getSampleVariableValue(varName);
  };

  return (
    <div className="whatsapp-preview-bubble">
      <div className="whatsapp-preview-header">
        <MessageSquare size={12} /> Approved WhatsApp Message
      </div>
      {eventType === "cd_shortfall" ? (
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
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [mappings, setMappings] = useState<Mapping[]>(initialMappings("cd_shortfall"));
  const options = useMemo(() => catalogOptions(catalog?.templates), [catalog]);

  function selectCatalogTemplate(optionId: string) {
    const option = options.find((candidate) => candidate.id === optionId);
    if (!option) return;
    const providerIdInput = document.querySelector<HTMLInputElement>("#provider-template-id");
    if (providerIdInput) providerIdInput.value = option.providerTemplateId;
    const nameInput = document.querySelector<HTMLInputElement>("#internal-template-name");
    if (nameInput) nameInput.value = option.providerTemplateId;
    const languageInput = document.querySelector<HTMLInputElement>("#template-language-code");
    if (languageInput) languageInput.value = option.languageCode;
    const namespaceInput = document.querySelector<HTMLInputElement>("#template-namespace");
    if (namespaceInput) namespaceInput.value = option.namespace ?? "";
    setMappings(initialMappings(eventType, option.variables));
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
                        <StatusBadge status={tpl.is_active ? "ready" : "retired"} />
                        <Button type="button" className="button-quiet" onClick={() => void setActive(tpl, !tpl.is_active)}>
                          {tpl.is_active ? "Retire" : "Activate"}
                        </Button>
                      </div>
                    </div>

                    {/* Visual WhatsApp Preview */}
                    <TemplateWhatsAppPreview eventType={tpl.event_type} mappings={tpl.component_schema?.components?.map((mapping) => ({ ...mapping, type: mapping.type ?? "text" })) ?? initialMappings(tpl.event_type)} />
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
                  <input id="provider-template-id" name="providerTemplateId" required maxLength={160} placeholder="e.g. cd_shortfall_v1" />
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
                <TemplateWhatsAppPreview eventType={eventType} mappings={mappings} />
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
