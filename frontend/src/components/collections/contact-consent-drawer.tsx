"use client";

import { useEffect, useState } from "react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import type { Contact } from "./types";
import { Button, Drawer, formatDate, safePhone } from "./ui";
import { accessToken } from "./workspace";

type OptIn = { id: string; is_opted_in: boolean; source: string; recorded_at: string; revoked_at: string | null };

export function ContactConsentDrawer({ contact, onClose, onChanged, onError }: { contact: Contact | null; onClose: () => void; onChanged: (message: string) => Promise<void>; onError: (message: string | null) => void }) {
  const { company } = useCompany();
  const [optIns, setOptIns] = useState<OptIn[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!contact) { setOptIns([]); return; }
    let cancelled = false;
    void (async () => {
      const token = await accessToken(); if (!token) return;
      try { const response = await apiRequest<{ optIns: OptIn[] }>(token, `/api/companies/${company.id}/contacts/${contact.id}/opt-ins`); if (!cancelled) setOptIns(response.optIns); }
      catch (cause) { if (!cancelled) onError(userFacingError(cause, "Could not load consent history.")); }
    })();
    return () => { cancelled = true; };
  }, [company.id, contact, onError]);

  async function update(body: Record<string, unknown>, message: string) {
    if (!contact || busy) return;
    const token = await accessToken(); if (!token) return;
    setBusy(true);
    try { await apiRequest(token, `/api/companies/${company.id}/contacts`, { method: "PATCH", body: jsonBody({ contactId: contact.id, ...body }) }); await onChanged(message); }
    catch (cause) { onError(userFacingError(cause, "Could not update the customer contact.")); }
    finally { setBusy(false); }
  }

  async function recordOptIn(form: HTMLFormElement, isOptedIn: boolean) {
    if (!contact || busy) return;
    const token = await accessToken(); if (!token) return;
    const fields = new FormData(form);
    setBusy(true);
    try {
      await apiRequest(token, `/api/companies/${company.id}/contacts/${contact.id}/opt-ins`, { method: "POST", body: jsonBody({ isOptedIn, source: fields.get("source"), recordedAt: new Date().toISOString(), evidence: { note: fields.get("note") } }) });
      form.reset();
      await onChanged(isOptedIn ? "WhatsApp opt-in recorded." : "WhatsApp opt-in revoked.");
    } catch (cause) { onError(userFacingError(cause, "Could not record the consent choice.")); }
    finally { setBusy(false); }
  }

  const latest = optIns[0];
  const optedIn = Boolean(latest?.is_opted_in && !latest.revoked_at);

  return <Drawer open={Boolean(contact)} onClose={onClose} title={contact?.customer?.ledgerName ?? "Controlled contact"} description="A replacement contact is stored only in Meenakshi and is never written back to Tally.">
    {contact && <div className="drawer-stack">
      <dl className="detail-grid"><div><dt>Controlled phone</dt><dd>{safePhone(contact.phone_e164)}</dd></div><div><dt>Contact</dt><dd>{contact.contact_name || "Not recorded"}</dd></div><div><dt>Primary</dt><dd>{contact.is_primary ? "Yes" : "No"}</dd></div><div><dt>Active</dt><dd>{contact.is_active ? "Yes" : "No"}</dd></div></dl>
      <div className="inline-actions"><Button className="button-secondary" disabled={busy} onClick={() => void update({ isPrimary: !contact.is_primary }, contact.is_primary ? "Primary flag removed." : "Contact set as primary.")}>{contact.is_primary ? "Remove primary" : "Make primary"}</Button><Button className="button-secondary" disabled={busy} onClick={() => void update({ isActive: !contact.is_active }, contact.is_active ? "Contact deactivated." : "Contact activated.")}>{contact.is_active ? "Deactivate contact" : "Activate contact"}</Button></div>
      <section><h3>Append-only consent history</h3>{optIns.length ? <div className="timeline">{optIns.map((optIn) => <article key={optIn.id}><span /><div><strong>{optIn.is_opted_in && !optIn.revoked_at ? "Opted in" : "Opted out"}</strong><p>{optIn.source}</p><small>{formatDate(optIn.recorded_at)}</small></div></article>)}</div> : <p className="muted-copy">No consent record exists. A WhatsApp event cannot be queued until an opt-in is recorded.</p>}
        {optedIn
          ? <form className="form-stack compact" onSubmit={(event) => { event.preventDefault(); void recordOptIn(event.currentTarget, false); }}><label>Revocation source<input name="source" required placeholder="Customer request, compliance review, etc." /></label><label>Evidence note<textarea name="note" required /></label><Button className="button-danger" type="submit" disabled={busy}>Record opt-out</Button></form>
          : <form className="form-stack compact" onSubmit={(event) => { event.preventDefault(); void recordOptIn(event.currentTarget, true); }}><label>Opt-in source<input name="source" required placeholder="Signed consent, recorded call, etc." /></label><label>Evidence note<textarea name="note" required /></label><Button type="submit" disabled={!contact.is_active || busy}>Record opt-in</Button></form>}
      </section>
    </div>}
  </Drawer>;
}
