"use client";

// Sidebar Tally status in plain words: connected, and whether the app has
// Tally's latest customers, groups and products (see backend auto-sync.ts).
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { apiRequest } from "@/lib/api";

import { useCompany } from "./company-context";
import { accessToken } from "./workspace";

type SyncStatus = { state: "up_to_date" | "syncing" | "changes_pending" | "never_synced"; lastSyncedAt: string | null };

function ago(value: string | null) {
  if (!value) return "";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function TallySyncPill({ tallyStatus }: { tallyStatus: string }) {
  const { company, companyKey, isAdministrator } = useCompany();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const connected = tallyStatus.includes("ready");

  const load = useCallback(async () => {
    const token = await accessToken(); if (!token) return;
    try { setStatus(await apiRequest<SyncStatus>(token, `/api/companies/${company.id}/tally/sync-status`, { cache: "no-store" })); } catch { /* keep the last known status */ }
  }, [company.id]);
  useEffect(() => {
    setStatus(null);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load, companyKey]);

  async function syncNow() {
    const token = await accessToken(); if (!token) return;
    setRequesting(true);
    try {
      await apiRequest(token, `/api/companies/${company.id}/sync/masters`, { method: "POST", headers: { "Idempotency-Key": globalThis.crypto.randomUUID() } });
      setStatus((current) => current ? { ...current, state: "syncing" } : current);
      window.setTimeout(() => void load(), 15_000);
    } catch { /* the Tally page shows details */ } finally { setRequesting(false); }
  }

  const view = !connected
    ? { tone: "bad", title: tallyStatus.includes("mismatch") ? "Other company open in Tally" : "Tally not connected", sub: "Open Tally and the connector" }
    : !status ? { tone: "ok", title: "Tally connected", sub: "" }
    : status.state === "syncing" ? { tone: "busy", title: "Updating from Tally…", sub: status.lastSyncedAt ? `last synced ${ago(status.lastSyncedAt)}` : "" }
    : status.state === "changes_pending" ? { tone: "warn", title: "Tally has changes", sub: "updating shortly" }
    : status.state === "never_synced" ? { tone: "warn", title: "Not synced yet", sub: "sync once to start" }
    : { tone: "ok", title: "Up to date", sub: `synced ${ago(status.lastSyncedAt)}` };
  const canSync = connected && isAdministrator && status && status.state !== "syncing";

  return <div className="tally-sync-pill" data-tone={view.tone}>
    <Link href="/tally" prefetch={false} title="Tally connection and sync">
      <span className="tally-sync-dot" aria-hidden="true" />
      <span className="tally-sync-text"><strong>{view.title}</strong>{view.sub && <small>{view.sub}</small>}</span>
    </Link>
    {canSync && <button type="button" className="tally-sync-now" disabled={requesting} onClick={() => void syncNow()} title="Sync customers, groups and products from Tally now" aria-label="Sync now"><RefreshCw size={13} className={requesting ? "spin" : undefined} /></button>}
  </div>;
}
