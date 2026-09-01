"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleHelp, ContactRound, Settings2, X } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { RulebookPage } from "./rulebook";
import styles from "./rulebook-guidance.module.css";
import type { PageProps } from "./workspace";
import type { Contact, Scheme } from "./types";
import { Button, Card, Drawer, EmptyState, SectionHeading, StatusBadge, formatDate, safePhone } from "./ui";

type OptIn = { id: string; is_opted_in: boolean; source: string; recorded_at: string; revoked_at: string | null };

async function currentToken() {
  const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

export function RulebookWorkspace(props: PageProps) {
  return <RulebookPage {...props} guidance={props.isAdministrator ? <RulebookGuidance hasMasters={Boolean(props.data.reference)} missing={[]} /> : undefined} management={props.isAdministrator ? <RulebookCompletion {...props} /> : undefined} />;
}

function RulebookGuidance({ hasMasters, missing }: { hasMasters: boolean; missing: string[] }) {
  const [open, setOpen] = useState(false);
  const setup = [
    ["1", "Review the rule currently in use", "Use the active rule for normal Cash Discount and Turnover Discount work. It cannot be edited directly."],
    ["2", "Update company information", hasMasters ? "Current Tally company information is available for a future rule." : "Update company information from Tally before creating a future rule."],
    ["3", "Create a new rule only when needed", "Choose customer groups, ledgers, products, conversions, and turnover tiers for the new rule."],
    ["4", "Check, then make the new rule active", "Meenakshi checks that all required choices are complete before using the new rule."],
  ];
  return <div className={styles.guidance}>
    <button type="button" className={styles.trigger} aria-label="Show Rulebook guidance" title="Rulebook guidance" aria-expanded={open} onClick={() => setOpen((current) => !current)}><CircleHelp size={18} /></button>
    {open && <section className={styles.popover} role="dialog" aria-label="Rulebook guidance">
      <header className={styles.header}><div><p className="eyebrow">Administrator guide</p><h2>Change a rule safely</h2></div><button type="button" className={styles.close} aria-label="Close Rulebook guidance" onClick={() => setOpen(false)}><X size={17} /></button></header>
      <p className={styles.intro}>The active rule remains in use for normal work. Create a new rule only for a real finance-policy change.</p>
      <ol className={styles.steps}>{setup.map(([number, title, detail]) => <li key={number}><span className={styles.number}>{number}</span><div><strong>{title}</strong><small>{detail}</small></div></li>)}</ol>
      {missing.length > 0 && <p className={styles.missing}>Still required before a new version can be activated: {missing.join(", ")}.</p>}
    </section>}
  </div>;
}

function RulebookCompletion({ setError, setNotice }: PageProps) {
  const { company, companyKey } = useCompany();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);

  const load = useCallback(async () => {
    const token = await currentToken(); if (!token) return;
    try {
      const [contactData, schemeData] = await Promise.all([
        apiRequest<{ contacts: Contact[] }>(token, "/api/companies/" + company.id + "/contacts"),
        apiRequest<{ schemes: Scheme[] }>(token, "/api/companies/" + company.id + "/schemes"),
      ]);
      setContacts(contactData.contacts); setSchemes(schemeData.schemes);
    } catch (cause) {
      setError(userFacingError(cause, "Could not load these Rulebook settings."));
    }
  }, [company.id, setError]);

  useEffect(() => { setContact(null); void load(); }, [companyKey, load]);
  const changed = async (message: string) => { setNotice(message); await load(); };

  async function updateScheme(scheme: Scheme, status: "paused" | "retired") {
    const token = await currentToken(); if (!token) return;
    try {
      await apiRequest(token, "/api/companies/" + company.id + "/schemes/" + scheme.id, { method: "PATCH", body: jsonBody({ status }) });
      await changed("Scheme " + status + ". Existing immutable versions remain visible.");
    } catch (cause) {
      setError(userFacingError(cause, "Could not update the rule status."));
    }
  }

  return <section className="rulebook-completion">
    <SectionHeading eyebrow="Administrator detail" title="Configuration management" detail="Manage consent, pause or retire rules, and clean up drafts before validation." />
    <div className="completion-grid completion-grid-single">
      <Card>
        <div className="card-title"><div><p className="eyebrow">Controlled contact</p><h2>Consent history</h2></div><ContactRound size={20} /></div>
        {contacts.length ? <div className="simple-list">{contacts.map((item) => <article key={item.id}>
          <div><strong>{item.customer?.ledgerName ?? "Customer record"}</strong><p>{item.contact_name || "Controlled contact"}; {safePhone(item.phone_e164)}</p></div>
          <Button className="button-quiet" onClick={() => setContact(item)}>Manage</Button>
        </article>)}</div> : <EmptyState title="No controlled contacts" detail="Add a replacement contact from the Contacts & opt-ins tab. It never writes a phone value back to Tally." />}
      </Card>
    </div>
    <Card>
      <div className="card-title"><div><p className="eyebrow">Scheme lifecycle</p><h2>Pause or retire configuration</h2><p className="muted-copy">These controls do not alter activated versions or verified Credit Notes.</p></div><Settings2 size={20} /></div>
      {schemes.length ? <div className="simple-list">{schemes.map((scheme) => <article key={scheme.id}>
        <div><strong>{scheme.name}</strong><p>{scheme.code}; {scheme.schemeType === "cd" ? "Cash Discount" : "Turnover Discount"}</p></div>
        <div className="table-actions"><StatusBadge status={scheme.status} />{scheme.status !== "retired" && <Button className="button-quiet" onClick={() => void updateScheme(scheme, scheme.status === "paused" ? "retired" : "paused")}>{scheme.status === "paused" ? "Retire" : "Pause"}</Button>}</div>
      </article>)}</div> : <EmptyState title="No schemes to manage" detail="Create a draft scheme in the Schemes and versions tab above." />}
    </Card>
    <ContactDetailDrawer contact={contact} onClose={() => setContact(null)} onChanged={changed} onError={setError} />
  </section>;
}

function ContactDetailDrawer({ contact, onClose, onChanged, onError }: { contact: Contact | null; onClose: () => void; onChanged: (message: string) => Promise<void>; onError: (message: string | null) => void }) {
  const { company } = useCompany();
  const [optIns, setOptIns] = useState<OptIn[]>([]);
  useEffect(() => {
    if (!contact) { setOptIns([]); return; }
    void (async () => {
      const token = await currentToken(); if (!token) return;
      try { const response = await apiRequest<{ optIns: OptIn[] }>(token, "/api/companies/" + company.id + "/contacts/" + contact.id + "/opt-ins"); setOptIns(response.optIns); }
      catch (cause) { onError(userFacingError(cause, "Could not load consent history.")); }
    })();
  }, [company.id, contact, onError]);
  async function update(body: Record<string, unknown>, message: string) {
    if (!contact) return;
    const token = await currentToken(); if (!token) return;
    try { await apiRequest(token, "/api/companies/" + company.id + "/contacts", { method: "PATCH", body: jsonBody({ contactId: contact.id, ...body }) }); await onChanged(message); }
    catch (cause) { onError(userFacingError(cause, "Could not update the customer contact.")); }
  }
  async function recordOptIn(form: HTMLFormElement, isOptedIn: boolean) {
    if (!contact) return;
    const token = await currentToken(); if (!token) return;
    const fields = new FormData(form);
    try {
      await apiRequest(token, "/api/companies/" + company.id + "/contacts/" + contact.id + "/opt-ins", { method: "POST", body: jsonBody({ isOptedIn, source: fields.get("source"), recordedAt: new Date().toISOString(), evidence: { note: fields.get("note") } }) });
      await onChanged(isOptedIn ? "WhatsApp opt-in recorded." : "WhatsApp opt-in revoked.");
    } catch (cause) { onError(userFacingError(cause, "Could not record the consent choice.")); }
  }
  return <Drawer open={Boolean(contact)} onClose={onClose} title={contact?.customer?.ledgerName ?? "Controlled contact"} description="A replacement contact is stored only in Meenakshi and is never written back to Tally.">
    {contact && <div className="drawer-stack">
      <dl className="detail-grid"><div><dt>Controlled phone</dt><dd>{safePhone(contact.phone_e164)}</dd></div><div><dt>Contact</dt><dd>{contact.contact_name || "Not recorded"}</dd></div><div><dt>Primary</dt><dd>{contact.is_primary ? "Yes" : "No"}</dd></div><div><dt>Active</dt><dd>{contact.is_active ? "Yes" : "No"}</dd></div></dl>
      <div className="inline-actions"><Button className="button-secondary" onClick={() => void update({ isPrimary: !contact.is_primary }, contact.is_primary ? "Primary flag removed." : "Contact set as primary.")}>{contact.is_primary ? "Remove primary" : "Make primary"}</Button><Button className="button-secondary" onClick={() => void update({ isActive: !contact.is_active }, contact.is_active ? "Contact deactivated." : "Contact activated.")}>{contact.is_active ? "Deactivate contact" : "Activate contact"}</Button></div>
      <section><h3>Append-only consent history</h3>{optIns.length ? <div className="timeline">{optIns.map((optIn) => <article key={optIn.id}><span /><div><strong>{optIn.is_opted_in && !optIn.revoked_at ? "Opted in" : "Opted out"}</strong><p>{optIn.source}</p><small>{formatDate(optIn.recorded_at)}</small></div></article>)}</div> : <p className="muted-copy">No consent record exists. A WhatsApp event cannot be queued until an opt-in is recorded.</p>}
        <form className="form-stack compact" onSubmit={(event) => { event.preventDefault(); void recordOptIn(event.currentTarget, true); }}><label>Opt-in source<input name="source" required placeholder="Signed consent, recorded call, etc." /></label><label>Evidence note<textarea name="note" required /></label><Button type="submit" disabled={!contact.is_active}>Record opt-in</Button></form>
        <form className="form-stack compact" onSubmit={(event) => { event.preventDefault(); void recordOptIn(event.currentTarget, false); }}><label>Revocation source<input name="source" required placeholder="Customer request, compliance review, etc." /></label><label>Evidence note<textarea name="note" required /></label><Button className="button-danger" type="submit">Record opt-out</Button></form>
      </section>
    </div>}
  </Drawer>;
}
