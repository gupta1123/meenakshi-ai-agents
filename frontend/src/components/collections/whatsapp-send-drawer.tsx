"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Send } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import type { Contact } from "./types";
import { Button, Drawer, InlineMessage, StatusBadge, formatMoney } from "./ui";
import { accessToken } from "./workspace";
import styles from "./whatsapp-send.module.css";
// Same visual language as the Credit Note panel (hero card, hairline sections, bordered lists).
import panel from "./cd-invoice-panel.module.css";

type CreditOrDebitRequest = { kind: "credit_note" | "debit_note"; postingId: string };
type ReminderRequest = { kind: "cd_reminder"; evaluationRunId: string; customerName: string; invoiceNumber: string; invoiceDate: string; billReference: string };

export type WhatsAppTarget = {
  key: string;
  customerId?: string | null;
  customerName: string;
  detail: string;
  amount?: string | number | null;
  lastMessage?: { status: string; recipient: string | null } | null;
  request: CreditOrDebitRequest | ReminderRequest;
};

type SendResult = { key: string; ok: boolean; error?: string; code?: string; recipient?: string };

/** Mirrors the backend: a bare 10-digit number is Indian. */
export function normalizePhone(value: string) {
  const raw = value.trim().replace(/[\s().-]/g, "");
  if (!raw) return null;
  const international = raw.startsWith("+") || raw.startsWith("00");
  let digits = raw.replace(/^\+|^00/, "");
  if (!/^\d+$/.test(digits)) return null;
  if (!international) {
    if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    if (digits.length === 10) digits = `91${digits}`;
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

function displayPhone(value: string | null | undefined) {
  if (!value) return "";
  return value.startsWith("+91") && value.length === 13 ? `${value.slice(3, 8)} ${value.slice(8)}` : value;
}

export function WhatsAppSendDrawer({ open, title, targets, onClose, onSent, onInvoiceNotSynced }: {
  open: boolean;
  title?: string;
  targets: WhatsAppTarget[];
  onClose: () => void;
  onSent: (sentCount: number) => void | Promise<void>;
  /** Called once when a reminder's invoice is not in Meenakshi yet; resolve true after it has been copied from Tally. */
  onInvoiceNotSynced?: () => Promise<boolean>;
}) {
  const { company } = useCompany();
  const [phones, setPhones] = useState<Record<string, string>>({});
  // Every known number per customer: Tally ledger mobiles, saved contacts, the last one used.
  const [choices, setChoices] = useState<Record<string, Array<{ phone: string; source: string; shared?: number }>>>({});
  const [typing, setTyping] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, SendResult>>({});
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const targetSignature = targets.map((target) => target.key).join("|");

  useEffect(() => {
    if (!open) return;
    const targets = targetsRef.current;
    setResults({}); setError(null); setStatus(null);
    let cancelled = false;
    setTyping(new Set()); setChoices({});
    const fallback = Object.fromEntries(targets.map((target) => [target.key, normalizePhone(target.lastMessage?.recipient ?? "") ?? ""]));
    setPhones(fallback);
    void (async () => {
      const token = await accessToken(); if (!token) return;
      const [contactResult, tallyResult] = await Promise.all([
        apiRequest<{ contacts: Contact[] }>(token, `/api/companies/${company.id}/contacts`).catch(() => ({ contacts: [] as Contact[] })),
        apiRequest<{ customers: Array<{ id: string; name: string; numbers: string[] }>; sharedBy?: Record<string, number> }>(token, `/api/companies/${company.id}/customers/whatsapp-numbers`).catch(() => ({ customers: [], sharedBy: {} as Record<string, number> })),
      ]);
      if (cancelled) return;
      const active = contactResult.contacts.filter((contact) => contact.is_active).sort((left, right) => Number(right.is_primary) - Number(left.is_primary));
      const next: Record<string, Array<{ phone: string; source: string; shared?: number }>> = {};
      const sharedBy = tallyResult.sharedBy ?? {};
      for (const target of targets) {
        const list: Array<{ phone: string; source: string; shared?: number }> = [];
        const add = (value: string | null | undefined, source: string) => { const phone = normalizePhone(value ?? ""); if (phone && !list.some((item) => item.phone === phone)) list.push({ phone, source, shared: sharedBy[phone.replace(/\D/g, "").slice(-10)] }); };
        const sameCustomer = (id?: string | null, name?: string | null) => Boolean((target.customerId && id === target.customerId) || (name && name === target.customerName));
        for (const contact of active) if (sameCustomer(contact.customer_id, contact.customer?.ledgerName)) add(contact.phone_e164, contact.is_primary ? "Saved · main" : "Saved");
        add(target.lastMessage?.recipient, "Last used");
        for (const customer of tallyResult.customers) if (sameCustomer(customer.id, customer.name)) for (const number of customer.numbers) add(number, "From Tally");
        next[target.key] = list;
      }
      setChoices(next);
      // Pick the first known number that belongs to this customer alone; a number
      // shared by many customers (usually the salesperson's) is never picked for you.
      setPhones((current) => Object.fromEntries(targets.map((target) => [target.key, current[target.key] || next[target.key]?.find((item) => (item.shared ?? 1) <= 1)?.phone || ""])));
    })();
    return () => { cancelled = true; };
  }, [company.id, open, targetSignature]);

  const pending = targets.filter((target) => !results[target.key]?.ok);
  const invalid = pending.filter((target) => !normalizePhone(phones[target.key] ?? ""));
  const sentCount = targets.filter((target) => results[target.key]?.ok).length;
  const done = targets.length > 0 && pending.length === 0;
  const templateProblem = useMemo(() => Object.values(results).find((result) => result.code === "template_missing" || result.code === "template_problem")?.error ?? null, [results]);

  async function post(items: WhatsAppTarget[]) {
    const token = await accessToken();
    if (!token) throw new Error("Sign in again before sending.");
    const response = await apiRequest<{ results: SendResult[] }>(token, `/api/companies/${company.id}/notifications/send`, {
      method: "POST", timeoutMs: 60_000,
      body: jsonBody({ items: items.map((target) => ({ key: target.key, ...target.request, phone: phones[target.key] ?? "" })) }),
    });
    return response.results;
  }

  async function send() {
    if (sending || !pending.length || invalid.length) return;
    setSending(true); setError(null); setStatus(`Sending ${pending.length} message${pending.length === 1 ? "" : "s"}…`);
    try {
      let batch = await post(pending);
      const notSynced = batch.filter((result) => result.code === "invoice_not_synced");
      if (notSynced.length && onInvoiceNotSynced) {
        setStatus("Copying the invoice from Tally first. This takes a few seconds…");
        if (await onInvoiceNotSynced()) {
          setStatus("Sending…");
          const retried = await post(pending.filter((target) => notSynced.some((result) => result.key === target.key)));
          batch = batch.map((result) => retried.find((item) => item.key === result.key) ?? result);
        }
      }
      const next = { ...results, ...Object.fromEntries(batch.map((result) => [result.key, result])) };
      setResults(next);
      const ok = batch.filter((result) => result.ok).length;
      setStatus(null);
      if (ok) await onSent(ok);
    } catch (cause) {
      setStatus(null);
      setError(userFacingError(cause, "The messages could not be sent. Try again."));
    } finally { setSending(false); }
  }

  const single = targets.length === 1;
  const heading = title ?? (single ? "Send on WhatsApp" : `Send ${targets.length} WhatsApp messages`);
  const selectNumber = (key: string, phone: string) => { setTyping((current) => { const next = new Set(current); next.delete(key); return next; }); setPhones((current) => ({ ...current, [key]: phone })); };
  const typeNumber = (key: string) => { setTyping((current) => new Set(current).add(key)); setPhones((current) => ({ ...current, [key]: "" })); };
  const sourceLine = (choice: { source: string; shared?: number }) => <><span className={styles.source}>{choice.source}</span>{(choice.shared ?? 1) > 1 && <span className={styles.shared}>also on {choice.shared} customers</span>}</>;

  return <Drawer open={open} onClose={() => { if (!sending) onClose(); }} title={heading} description={single ? targets[0]?.customerName : undefined} width="wide">
    <div className={`${panel.panel} ${styles.sendPanel}`}>
      {templateProblem && <InlineMessage tone="warning">{templateProblem}</InlineMessage>}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {targets.map((target) => {
        const result = results[target.key];
        const phone = phones[target.key] ?? "";
        const phoneInvalid = Boolean(phone.trim()) && !normalizePhone(phone);
        const list = choices[target.key] ?? [];
        const typingHere = typing.has(target.key) || !list.length;
        const [docTitle, ...docRest] = target.detail.split(" · ");
        const hasAmount = target.amount !== undefined && target.amount !== null;
        return <div key={target.key} className={styles.block} data-state={result?.ok ? "sent" : result ? "failed" : "pending"}>
          {/* What is being sent: the same hero card as the Credit Note panel. */}
          <header className={panel.hero}>
            <div className={panel.heroTop}>
              <span className={styles.heroTitle}>{!single && <small>{target.customerName}</small>}<strong>{docTitle}</strong></span>
              {hasAmount && <span className={panel.heroAmount}><strong>{formatMoney(target.amount!)}</strong></span>}
            </div>
            {docRest.length > 0 && <p className={panel.heroContext}>{docRest.join(" · ")}</p>}
            {result?.ok && <p className={styles.sentLine}><CheckCircle2 size={14} />Sent to {displayPhone(result.recipient)}</p>}
          </header>

          {!result?.ok && <section className={panel.section} aria-label={`Number for ${target.customerName}`}>
            <div className={panel.sectionHeading}><h3>Send to</h3><span>{list.length ? `${list.length} known number${list.length === 1 ? "" : "s"}` : "No number on record"}</span></div>
            <ul className={`${panel.payments} ${styles.numbers}`} role="radiogroup">
              {list.map((choice) => {
                const selected = !typing.has(target.key) && normalizePhone(phone) === choice.phone;
                return <li key={choice.phone} data-selected={selected}>
                  <label>
                    <input type="radio" name={`to-${target.key}`} checked={selected} disabled={sending} onChange={() => selectNumber(target.key, choice.phone)} />
                    <span><strong>{displayPhone(choice.phone)}</strong><small>{choice.source}</small></span>
                    {(choice.shared ?? 1) > 1 && <em className={styles.shared}>Shared by {choice.shared} customers</em>}
                  </label>
                </li>;
              })}
              <li data-selected={typingHere}>
                <label>
                  <input type="radio" name={`to-${target.key}`} checked={typingHere} disabled={sending} onChange={() => typeNumber(target.key)} />
                  <span><strong>{list.length ? "Another number" : "Enter a number"}</strong><small>Any mobile, with +country code if outside India</small></span>
                </label>
                {typingHere && <input className={styles.numberInput} value={phone} disabled={sending} inputMode="tel" autoComplete="off" autoFocus={typing.has(target.key)} placeholder="98765 43210" aria-label={`WhatsApp number for ${target.customerName}`} aria-invalid={phoneInvalid} onChange={(event) => setPhones((current) => ({ ...current, [target.key]: event.target.value }))} />}
              </li>
            </ul>
            {phoneInvalid && <p className={panel.error}>Enter a 10-digit mobile number, or +country code.</p>}
          </section>}
          {result && !result.ok && <p className={panel.error}>{result.error}</p>}
        </div>;
      })}
    </div>
    <footer className={styles.actions}>
      <span>{done ? `${sentCount} sent · delivery shows in Messages` : status ?? (invalid.length ? `Choose a number${single ? "" : ` for ${invalid.length} customer${invalid.length === 1 ? "" : "s"}`}` : targets.every((target) => "postingId" in target.request) ? "PDF attached" : "")}</span>
      <div>
        <Button className="button-secondary" disabled={sending} onClick={onClose}>{done ? "Done" : "Cancel"}</Button>
        {!done && <Button disabled={sending || !pending.length || invalid.length > 0} onClick={() => void send()}><Send size={15} />{sending ? "Sending…" : Object.keys(results).length ? `Retry ${pending.length}` : single ? "Send WhatsApp" : `Send ${pending.length} messages`}</Button>}
      </div>
    </footer>
  </Drawer>;
}
