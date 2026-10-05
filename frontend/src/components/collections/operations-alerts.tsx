"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Eye } from "lucide-react";

import { apiRequest } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { userFacingDetail, userFacingError, userLabel } from "@/lib/user-copy";

import type { OperationsAlert } from "./types";
import { Button, Drawer, EmptyState, formatDate } from "./ui";

type OperationalDetail = {
  target: { correlationId: string | null; entityType: string | null; entityId: string | null };
  outbox: Array<{ id: string; type: string; status: string; attempts: number; maxAttempts: number; createdAt: string; completedAt: string | null; summary: string }>;
  commands: Array<{ id: string; type: string; status: string; attempts: number; maxAttempts: number; createdAt: string; completedAt: string | null; summary: string }>;
  audit: Array<{ id: string; action: string; entityType: string; entityId: string | null; createdAt: string; summary: string }>;
};

async function accessToken() {
  const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

function fallbackHref(alert: OperationsAlert) {
  if (alert.id.startsWith("tally-")) return "/tally";
  if (alert.id.includes("configuration")) return "/rulebook";
  if (alert.id.includes("message")) return "/messages";
  return "/credit-notes";
}

export function OperationalAlertList({ companyId, alerts, onError }: { companyId: string; alerts: OperationsAlert[]; onError: (message: string | null) => void }) {
  const [selected, setSelected] = useState<OperationsAlert | null>(null);
  const [detail, setDetail] = useState<OperationalDetail | null>(null);
  const [loading, setLoading] = useState(false);
  async function inspect(alert: OperationsAlert) {
    const target = alert.detailTarget;
    if (!target?.correlationId && !(target?.entityId && target.entityType)) return;
    setSelected(alert); setDetail(null); setLoading(true);
    const token = await accessToken(); if (!token) return;
    const query = target.correlationId ? `correlationId=${encodeURIComponent(target.correlationId)}` : `entityId=${encodeURIComponent(target.entityId!)}&entityType=${encodeURIComponent(target.entityType!)}`;
    try { setDetail(await apiRequest<OperationalDetail>(token, `/api/companies/${companyId}/operations/detail?${query}`)); }
    catch (cause) { onError(userFacingError(cause, "Could not load the activity details.")); }
    finally { setLoading(false); }
  }
  return <><div className="attention-list">{alerts.length ? alerts.slice(0, 5).map((alert) => { const target = alert.detailTarget; const inspectable = Boolean(target?.correlationId || (target?.entityId && target.entityType)); return <article key={alert.id}><span className={`alert-dot ${alert.severity}`} /><div><strong>{alert.title}</strong><p>{userFacingDetail(alert.message, "This item needs attention.")}</p><small>{alert.nextAction}</small></div>{inspectable ? <Button className="button-quiet" onClick={() => void inspect(alert)} aria-label={`View ${alert.title}`}><Eye size={16} /></Button> : <Link href={fallbackHref(alert)} aria-label={alert.nextAction}><ArrowRight size={16} /></Link>}</article>; }) : <EmptyState title="Nothing needs attention" detail="There are no current items needing attention for this company." />}</div><Drawer open={Boolean(selected)} onClose={() => { setSelected(null); setDetail(null); }} title={selected?.title ?? "Activity details"} description="A simple history of what happened and what needs attention.">{loading ? <p className="muted-copy">Loading activity details…</p> : detail ? <div className="drawer-stack"><OperationalRows title="Messages waiting to be completed" rows={detail.outbox} /><OperationalRows title="Tally activity" rows={detail.commands} /><OperationalRows title="Activity history" rows={detail.audit} /></div> : <p className="muted-copy">No further details are available for this item.</p>}</Drawer></>;
}

function OperationalRows({ title, rows }: { title: string; rows: Array<{ id: string; status?: string; action?: string; type?: string; summary: string; createdAt: string; attempts?: number; maxAttempts?: number }> }) {
  return <section><h3>{title}</h3>{rows.length ? <div className="timeline">{rows.map((row) => <article key={row.id}><span /><div><strong>{userLabel(row.type ?? row.action ?? "Activity")}{row.status ? ` · ${userLabel(row.status)}` : ""}</strong><p>{userFacingDetail(row.summary, "Activity recorded.")}</p><small>{row.attempts !== undefined ? `${row.attempts} of ${row.maxAttempts} tries · ` : ""}{formatDate(row.createdAt)}</small></div></article>)}</div> : <p className="muted-copy">No matching activity was found.</p>}</section>;
}
