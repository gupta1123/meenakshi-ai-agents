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
    // Pre-fill with the number last used for each customer; it stays editable.
    const fallback = Object.fromEntries(targets.map((target) => [target.key, displayPhone(target.lastMessage?.recipient)]));
    setPhones(fallback);
    void (async () => {
      const token = await accessToken(); if (!token) return;
      try {
        const { contacts } = await apiRequest<{ contacts: Contact[] }>(token, `/api/companies/${company.id}/contacts`);
        if (cancelled) return;
        const active = contacts.filter((contact) => contact.is_active).sort((left, right) => Number(right.is_primary) - Number(left.is_primary));
        setPhones((current) => Object.fromEntries(targets.map((target) => {
          const contact = active.find((item) => (target.customerId && item.customer_id === target.customerId) || item.customer?.ledgerName === target.customerName);
          return [target.key, current[target.key] || displayPhone(contact?.phone_e164)];
        })));
      } catch { /* Numbers can still be typed in. */ }
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

  const heading = title ?? (targets.length === 1 ? "Send WhatsApp" : `Send ${targets.length} WhatsApp messages`);
  return <Drawer open={open} onClose={() => { if (!sending) onClose(); }} title={heading} description="Check each number, then send. Messages go to the number shown." width="wide">
    <div className={styles.panel}>
      {templateProblem && <InlineMessage tone="warning">{templateProblem}</InlineMessage>}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      <ul className={styles.list}>{targets.map((target) => {
        const result = results[target.key];
        const phone = phones[target.key] ?? "";
        const phoneInvalid = Boolean(phone.trim()) && !normalizePhone(phone);
        return <li key={target.key} className={styles.row} data-state={result?.ok ? "sent" : result ? "failed" : "pending"}>
          <div className={styles.identity}>
            <strong>{target.customerName}</strong>
            <small>{target.detail}{target.amount !== undefined && target.amount !== null ? ` · ${formatMoney(target.amount)}` : ""}</small>
            {target.lastMessage && !result && <span className={styles.previous}><StatusBadge status={target.lastMessage.status} />{target.lastMessage.recipient ? `to ${displayPhone(target.lastMessage.recipient)}` : ""}</span>}
          </div>
          {result?.ok ? <p className={styles.outcome} data-tone="ok"><CheckCircle2 size={16} />Queued to {displayPhone(result.recipient)}</p> : <label className={styles.phone}>
            <span>WhatsApp number</span>
            <input value={phone} disabled={sending} inputMode="tel" autoComplete="off" placeholder="98765 43210" aria-invalid={phoneInvalid} onChange={(event) => setPhones((current) => ({ ...current, [target.key]: event.target.value }))} />
            {phoneInvalid && <small className={styles.hint}>Enter a 10-digit mobile number, or +country code.</small>}
          </label>}
          {result && !result.ok && <p className={styles.outcome} data-tone="error"><AlertTriangle size={15} />{result.error}</p>}
        </li>;
      })}</ul>
      <footer className={styles.footer}>
        <p>{done ? `${sentCount} message${sentCount === 1 ? "" : "s"} queued. Delivery status appears in Messages.` : status ?? (invalid.length ? `Enter a number for ${invalid.length} customer${invalid.length === 1 ? "" : "s"}.` : "Sending does not change anything in Tally.")}</p>
        <div>
          <Button className="button-secondary" disabled={sending} onClick={onClose}>{done ? "Done" : "Cancel"}</Button>
          {!done && <Button disabled={sending || !pending.length || invalid.length > 0} onClick={() => void send()}><Send size={15} />{sending ? "Sending…" : Object.keys(results).length ? `Retry ${pending.length}` : `Send ${pending.length}`}</Button>}
        </div>
      </footer>
    </div>
  </Drawer>;
}
