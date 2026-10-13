"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, UsersRound } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { Button, Drawer, Skeleton } from "./ui";
import { accessToken } from "./workspace";
import styles from "./team-contacts.module.css";

export type TeamContact = { id: string; name: string; role_label: string | null; phone_e164: string; is_active: boolean };

export function displayTeamPhone(value: string) {
  return value.startsWith("+91") && value.length === 13 ? `+91 ${value.slice(3, 8)} ${value.slice(8)}` : value;
}

/** Meenakshi marketing / sales people who can be copied on customer WhatsApp messages. */
export function TeamContactsPanel({ onNotice, onError }: { onNotice: (message: string) => void; onError: (message: string | null) => void }) {
  const { company } = useCompany();
  const [members, setMembers] = useState<TeamContact[] | null>(null);
  const [editing, setEditing] = useState<TeamContact | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const token = await accessToken(); if (!token) return;
    try {
      const response = await apiRequest<{ teamContacts: TeamContact[] }>(token, `/api/companies/${company.id}/team-contacts`);
      setMembers(response.teamContacts);
    } catch (cause) { onError(userFacingError(cause, "Could not load the team list.")); setMembers([]); }
  }, [company.id, onError]);
  useEffect(() => { void load(); }, [load]);

  async function save(form: HTMLFormElement) {
    const token = await accessToken(); if (!token) return;
    const fields = new FormData(form);
    const body = { name: String(fields.get("name") ?? ""), roleLabel: String(fields.get("roleLabel") ?? ""), phone: String(fields.get("phone") ?? "") };
    setSaving(true); onError(null);
    try {
      if (editing === "new") await apiRequest(token, `/api/companies/${company.id}/team-contacts`, { method: "POST", body: jsonBody(body) });
      else if (editing) await apiRequest(token, `/api/companies/${company.id}/team-contacts/${editing.id}`, { method: "PATCH", body: jsonBody(body) });
      onNotice(editing === "new" ? "Team member added." : "Team member updated.");
      setEditing(null); await load();
    } catch (cause) { onError(userFacingError(cause, "Could not save the team member.")); } finally { setSaving(false); }
  }

  async function toggle(member: TeamContact) {
    const token = await accessToken(); if (!token) return;
    try {
      await apiRequest(token, `/api/companies/${company.id}/team-contacts/${member.id}`, { method: "PATCH", body: jsonBody({ isActive: !member.is_active }) });
      onNotice(member.is_active ? `${member.name} will no longer appear when sending.` : `${member.name} is back on the list.`);
      await load();
    } catch (cause) { onError(userFacingError(cause, "Could not update the team member.")); }
  }

  const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");
  return <section aria-label="Team contacts" className={styles.card}>
    <div className={styles.head}>
      <div><span className={styles.eyebrow}>Internal team</span><h2>Team contacts</h2><p>Meenakshi marketing and sales people. When you send a WhatsApp message, tick any of them to send them a copy too.</p></div>
      <Button onClick={() => setEditing("new")}><Plus size={16} />Add team member</Button>
    </div>
    {members === null ? <div className={styles.skeleton}><Skeleton lines={4} /></div> : !members.length
      ? <div className={styles.empty}><span><UsersRound size={20} /></span><h3>No team members yet</h3><p>Add the people who should get a copy of customer WhatsApp messages.</p><Button onClick={() => setEditing("new")}><Plus size={16} />Add team member</Button></div>
      : <ul className={styles.list}>
        {members.map((member) => <li key={member.id} className={styles.row} data-off={!member.is_active}>
          <span className={styles.avatar} aria-hidden="true">{initials(member.name)}</span>
          <div className={styles.who}><strong>{member.name}</strong><span>{member.role_label && <span>{member.role_label}</span>}<span className={styles.phone}>{displayTeamPhone(member.phone_e164)}</span>{!member.is_active && <span className={styles.off}>Off</span>}</span></div>
          <div className={styles.actions}><Button className="button-quiet" onClick={() => setEditing(member)}><Pencil size={14} />Edit</Button><Button className="button-quiet" onClick={() => void toggle(member)}>{member.is_active ? "Turn off" : "Turn on"}</Button></div>
        </li>)}
      </ul>}
    <Drawer open={editing !== null} onClose={() => { if (!saving) setEditing(null); }} title={editing === "new" ? "Add team member" : "Edit team member"} description="They receive a copy of the WhatsApp messages you choose to copy them on.">
      <form key={editing === "new" ? "new" : editing?.id ?? "none"} className="form-stack" onSubmit={(event) => { event.preventDefault(); void save(event.currentTarget); }}>
        <label>Name<input name="name" required maxLength={120} defaultValue={editing && editing !== "new" ? editing.name : ""} autoComplete="off" /></label>
        <label>Role (optional)<input name="roleLabel" maxLength={80} placeholder="Sales manager" defaultValue={editing && editing !== "new" ? editing.role_label ?? "" : ""} autoComplete="off" /></label>
        <label>WhatsApp number<input name="phone" required inputMode="tel" placeholder="98765 43210" defaultValue={editing && editing !== "new" ? editing.phone_e164 : ""} autoComplete="off" /></label>
        <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </form>
    </Drawer>
  </section>;
}
