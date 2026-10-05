"use client";

import { CheckCircle2, CircleAlert, Pencil, ReceiptText } from "lucide-react";
import { useState } from "react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import type { CreditNoteAccountingSettings, Master, ReferenceData, TaxPolicy } from "./types";
import { Button, Card, Drawer, EmptyState, InlineMessage, StatusBadge, formatDate, labelFor } from "./ui";
import { accessToken } from "./workspace";

type Props = {
  settings: CreditNoteAccountingSettings | null;
  reference: ReferenceData | null;
  policies: TaxPolicy[];
  onSaved: (settings: CreditNoteAccountingSettings) => Promise<void>;
  onError: (message: string | null) => void;
  onRecordPolicy: () => void;
};

type Mapping = { voucherTypeId: string | null; ledgerId: string | null };

function masterName(items: Master[], id: string | null) {
  return id ? labelFor(items.find((item) => item.id === id) ?? { id, name: "Unavailable Tally record", is_available: false }) : "Not configured";
}

function MappingSummary({ title, readyText, voucherLabel = "Credit Note type", ledgerLabel = "Discount recorded in", settings, voucherTypes, ledgers }: { title: string; readyText: string; voucherLabel?: string; ledgerLabel?: string; settings: Mapping; voucherTypes: Master[]; ledgers: Master[] }) {
  const ready = Boolean(settings.voucherTypeId && settings.ledgerId);
  return <article className={ready ? "accounting-mapping is-ready" : "accounting-mapping"}>
    <div className="accounting-mapping-title"><span>{ready ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}</span><div><strong>{title}</strong><small>{ready ? readyText : "Configure before using this posting action"}</small></div></div>
    <dl><div><dt>{voucherLabel}</dt><dd>{masterName(voucherTypes, settings.voucherTypeId)}</dd></div><div><dt>{ledgerLabel}</dt><dd>{masterName(ledgers, settings.ledgerId)}</dd></div></dl>
  </article>;
}

function formMapping(fields: FormData, voucher: string, ledger: string): Mapping {
  return { voucherTypeId: String(fields.get(voucher) || "") || null, ledgerId: String(fields.get(ledger) || "") || null };
}

function incomplete(mapping: Mapping) {
  return Boolean(mapping.voucherTypeId) !== Boolean(mapping.ledgerId);
}

export function CreditNoteSetup({ settings, reference, policies, onSaved, onError, onRecordPolicy }: Props) {
  const { company } = useCompany();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const creditNoteTypes = reference?.masters.voucherTypes.filter((item) => item.is_available && item.is_credit_note_type) ?? [];
  const ledgers = reference?.masters.ledgers.filter((item) => item.is_available && String(item.gst_applicability).toLowerCase() === "not applicable") ?? [];

  async function save(form: HTMLFormElement) {
    const fields = new FormData(form);
    const turnoverDiscount = formMapping(fields, "turnoverVoucher", "turnoverLedger");
    const invalid = [["Turnover Discount reward", turnoverDiscount]] as const;
    const broken = invalid.find(([, value]) => incomplete(value));
    if (broken) { setFormError(`${broken[0]} needs both a Tally voucher type and a ledger.`); return; }
    if (!turnoverDiscount.voucherTypeId) { setFormError("Choose the Turnover Discount Credit Note type and ledger before saving."); return; }
    const token = await accessToken(); if (!token) return;
    setBusy(true); setFormError(null); onError(null);
    try {
      const result = await apiRequest<{ settings: CreditNoteAccountingSettings }>(token, `/api/companies/${company.id}/credit-note-accounting-settings`, { method: "PUT", body: jsonBody({ turnoverDiscount }) });
      setOpen(false); await onSaved(result.settings);
    } catch (cause) { setFormError(userFacingError(cause, "Could not save Tally posting setup.")); }
    finally { setBusy(false); }
  }

  const empty = { voucherTypeId: null, ledgerId: null };
  return <div className="credit-note-setup-stack">
    <Card className="credit-note-setup-card">
      <div className="card-title"><div><p className="eyebrow">Turnover Discount posting</p><h2>Where approved Turnover Discounts are recorded</h2><p className="muted-copy">Cash Discount recoveries use the original invoice Sales ledger automatically. Only the Turnover Discount Credit Note needs setup.</p></div><div className="accounting-card-actions"><StatusBadge status={settings ? "ready" : "setup required"} /><Button className="button-secondary" disabled={!reference} onClick={() => { setFormError(null); setOpen(true); }}><Pencil size={15} />{settings ? "Edit setup" : "Configure"}</Button></div></div>
      {!reference && <InlineMessage tone="info">Update company information from Tally before configuring posting.</InlineMessage>}
      <div className="accounting-mapping-grid">
        <MappingSummary title="Turnover Discount reward" readyText="Ready for approved Credit Notes" settings={settings?.turnoverDiscount ?? empty} voucherTypes={creditNoteTypes} ledgers={ledgers} />
      </div>
      <InlineMessage tone="info">Cash Discount Debit Notes use the standard Tally Debit Note and the Sales ledger from the original invoice. They do not require separate setup here.</InlineMessage>
    </Card>

    <Card><div className="card-title"><div><p className="eyebrow">Finance approval</p><h2>Credit Note policy evidence</h2><p className="muted-copy">Record the approval supporting the current commercial Credit Note treatment.</p></div><Button className="button-secondary" onClick={onRecordPolicy}><ReceiptText size={15} />Record approval</Button></div>{policies.length ? <div className="simple-list">{policies.map((policy) => <article key={policy.id}><div><strong>Commercial Credit Note · GST unchanged</strong><p>Effective {policy.effective_from} {policy.effective_to ? `to ${policy.effective_to}` : "onwards"}</p><small>{policy.approval_reference} · {policy.approver_name_snapshot} · {formatDate(policy.approved_at)}</small></div><CheckCircle2 size={18} /></article>)}</div> : <EmptyState title="No policy approval recorded" detail="Rules can calculate discounts now. Record Finance or CA approval before posting a Credit Note to Tally." />}</Card>

    <Drawer open={open} onClose={() => setOpen(false)} title="Configure Tally posting" description="These choices are used only after Finance approves the action recommended by a calculation." width="wide">
      <form key={settings?.updatedAt ?? "new"} className="form-stack" onSubmit={(event) => { event.preventDefault(); void save(event.currentTarget); }}>
        <InlineMessage tone="info">Choose where approved Turnover Discount Credit Notes should be posted. Cash Discount recovery is automatic from the source invoice.</InlineMessage>
        <section className="accounting-form-section"><div><p className="eyebrow">Turnover Discount reward</p><h3>Credit Note after period review</h3></div><div className="form-grid"><label>Credit Note type<select name="turnoverVoucher" defaultValue={settings?.turnoverDiscount.voucherTypeId ?? ""}><option value="">Not configured</option>{creditNoteTypes.map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select></label><label>Record discount in<select name="turnoverLedger" defaultValue={settings?.turnoverDiscount.ledgerId ?? ""}><option value="">Not configured</option>{ledgers.map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select></label></div></section>
        {!ledgers.length && <InlineMessage tone="info">No suitable ledger is available in the latest Tally information. Ask Finance which ledger should be used, then update company information.</InlineMessage>}
        {formError && <InlineMessage tone="error">{formError}</InlineMessage>}
        <Button type="submit" disabled={busy || !ledgers.length}>{busy ? "Saving setup…" : "Save Tally posting setup"}</Button>
      </form>
    </Drawer>
  </div>;
}
