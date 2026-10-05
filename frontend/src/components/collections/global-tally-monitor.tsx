"use client";

import Link from "next/link";
import { Activity, ArrowUpRight, Database, FileClock, RefreshCw, Router, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiRequest } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { userFacingDetail, userFacingError, userLabel } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { useTallyHealth } from "./tally-readiness";
import type { OperationsHealth, TallyHealth } from "./types";
import { Button, Dialog, EmptyState, formatDate, Skeleton, StatusBadge } from "./ui";

type ActivityItem = { id: string; kind: "sync" | "command"; label: string; status: string; startedAt: string; completedAt: string | null; attempts: number | null; maxAttempts: number | null; summary: string };
type ActivityResponse = { activity: ActivityItem[] };

async function tokenForMonitor() {
  const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

function syncLabel(sync: TallyHealth["sync"] extends infer Value ? Value extends { masters: infer Master } ? Master : never : never) {
  return sync.status === "current" ? "Up to date" : userLabel(sync.status);
}

function bridgeStatusMeta(status: string) {
  const label = userLabel(status);
  if (["ready", "current"].includes(status)) return { label, tone: "ready", Icon: Wifi };
  if (["awaiting_pairing", "required", "checking"].includes(status)) return { label, tone: "attention", Icon: Wifi };
  return { label, tone: "error", Icon: WifiOff };
}

export function GlobalTallyMonitor({ tallyStatus }: { tallyStatus: string }) {
  const { company, companyKey, isAdministrator } = useCompany();
  const [open, setOpen] = useState(false);
  // The workspace session owns the always-on health poll. Only load the
  // detailed health record when this status dialog is actually opened.
  const { health, reload: reloadHealth } = useTallyHealth({ enabled: open });
  const [operations, setOperations] = useState<OperationsHealth | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = await tokenForMonitor();
    if (!token) {
      inFlight.current = false;
      return;
    }
    setLoading(true); setError(null);
    try {
      const base = `/api/companies/${company.id}`;
      const [nextOperations, nextActivity] = await Promise.all([
        apiRequest<OperationsHealth>(token, `${base}/operations/health`),
        apiRequest<ActivityResponse>(token, `${base}/tally-activity`),
      ]);
      setOperations(nextOperations); setActivity(nextActivity.activity);
    } catch (cause) {
      setError(userFacingError(cause, "Could not load the Tally connection status."));
    } finally { setLoading(false); inFlight.current = false; }
  }, [company.id]);

  useEffect(() => { if (!open) return; void load(); const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000); return () => window.clearInterval(timer); }, [load, open]);
  useEffect(() => { setOpen(false); setOperations(null); setActivity([]); }, [companyKey]);

  const refresh = useCallback(async () => {
    await Promise.all([reloadHealth(), load()]);
  }, [load, reloadHealth]);

  const bridgeStatus = health?.status ?? tallyStatus;
  const bridgeMeta = bridgeStatusMeta(bridgeStatus);
  const expectedCompany = health?.binding?.expectedCompanyName ?? company.tally_company_name;
  const observedCompany = health?.binding?.observedCompanyName;
  const matchingCompany = Boolean(observedCompany && observedCompany === expectedCompany && health?.status !== "company_mismatch");
  const outboxDepth = operations?.outbox.backlog ?? 0;
  const pdfExportNeedsSetup = activity.some((item) => item.label === "Export verified PDF" && item.summary === "Native PDF export is not configured for this bridge yet.");
  return <>
    <button className={`topbar-readiness topbar-readiness-icon ${bridgeMeta.tone}`} type="button" onClick={() => setOpen(true)} aria-label={`${bridgeMeta.label}. Open Tally status`} data-tooltip={`${bridgeMeta.label}. Open Tally status`}><bridgeMeta.Icon size={17} /></button>
    <Dialog open={open} onClose={() => setOpen(false)} width="wide" title="Tally status" description="See the connection, the company currently open, and any work that needs attention.">
      {loading && !health ? <Skeleton lines={6} /> : <div className="bridge-monitor">
        {error && <div className="monitor-error" role="alert">{error}</div>}
        <div className="bridge-monitor-grid">
          <section><span className="monitor-icon"><Router size={17} /></span><small>Tally connection</small><StatusBadge status={bridgeStatus} /><strong>{health?.connector?.lastHeartbeatAt ? `Checked ${formatDate(health.connector.lastHeartbeatAt)}` : "Not checked yet"}</strong></section>
          <section><span className="monitor-icon"><Wifi size={17} /></span><small>Active Tally company</small><strong>{observedCompany ?? "Waiting for Tally"}</strong><p>{matchingCompany ? "Matches the authorized company" : `Expected: ${expectedCompany}`}</p></section>
          <section><span className="monitor-icon"><Activity size={17} /></span><small>Work in progress</small><strong>{outboxDepth} pending</strong><p>{operations?.bridgeCommands.deadLetter ?? 0} item(s) need attention</p></section>
          <section><span className="monitor-icon"><Database size={17} /></span><small>Tally data</small><strong>Company lists: {health?.sync ? syncLabel(health.sync.masters) : "Checking"}</strong><p>Sales records: {health?.sync ? syncLabel(health.sync.vouchers) : "Checking"}</p></section>
        </div>
        <section className="bridge-activity"><div className="card-title"><div><p className="eyebrow">Recent Tally activity</p><h3>Recent updates</h3></div><Button className="button-quiet" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} />Refresh</Button></div>
          {activity.length ? <div className="bridge-activity-list">{activity.map((item) => <article key={`${item.kind}-${item.id}`}><span className="activity-kind">{item.kind === "sync" ? <Database size={15} /> : <FileClock size={15} />}</span><div><strong>{userLabel(item.label)}</strong><p>{userFacingDetail(item.summary, "Tally activity was recorded.")}</p><small>Started {formatDate(item.startedAt)}{item.attempts !== null ? ` · try ${item.attempts} of ${item.maxAttempts}` : ""}</small></div><StatusBadge status={item.status} /></article>)}</div> : <EmptyState title="No Tally activity yet" detail="Connection checks and Tally data updates will appear here." />}
        </section>
        {pdfExportNeedsSetup && <div className="monitor-pdf-note"><FileClock size={16} /><div><strong>Credit Note PDFs are not ready yet</strong><p>Finish the Tally connection setup before opening verified Credit Note PDFs.</p></div></div>}
        <div className="bridge-monitor-footer"><p>{isAdministrator ? "Use Tally Connection to connect Tally or update company and sales information." : "Finance can view the Tally status here. Only Administrators can change Tally settings."}</p>{isAdministrator && <Link className="button button-secondary" href="/tally" onClick={() => setOpen(false)}>Open Tally Connection <ArrowUpRight size={15} /></Link>}</div>
      </div>}
    </Dialog>
  </>;
}
