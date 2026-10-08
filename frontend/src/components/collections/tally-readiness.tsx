"use client";

import { Building2, Cable, CheckCircle2, ChevronDown, CircleAlert, LoaderCircle, Monitor, PlugZap, RefreshCw, ServerCog, ShieldCheck, Unplug } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiBaseUrl, apiRequest, jsonBody } from "@/lib/api";
import { detectLocalTallyConnector } from "@/lib/local-tally";
import { selectReconnectConnector } from "@/lib/connector-selection";
import { supabase } from "@/lib/supabase";
import { userFacingDetail, userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { WorkspacePageHeader } from "./app-shell";
import type { TallyHealth } from "./types";
import { Button, InlineMessage, Skeleton } from "./ui";
import s from "./tally-connection.module.css";

type Connector = { id: string; displayName: string; machineFingerprint: string; status: string };
type SetupCredential = { connector: Connector & { installationKey: string }; controlToken: string; tallyUrl: string };
type DetectedTallyCompany = { name: string; guid: string; isActive: boolean };
type RegisteredCompany = { id: string; code: string; tallyCompanyGuid: string; tallyCompanyName: string };
type ConnectorCompanySnapshot = {
  connector: {
    id: string;
    displayName: string;
    status: string;
    tallyUrl: string;
    bridgeConnected: boolean;
    tallyReachable: boolean;
    companyLoaded: boolean;
    heartbeatStale: boolean;
    lastHeartbeatAt: string | null;
    lastTestedAt: string | null;
    lastCompanyName: string | null;
    lastError: string | null;
  };
  companies: DetectedTallyCompany[];
  activeCompany: DetectedTallyCompany | null;
};
type TallyTargetMode = "same_machine" | "lan_server";
type Tone = "ready" | "working" | "attention" | "idle";
type StepState = "done" | "current" | "problem" | "todo";

const sameMachineTallyUrl = "http://localhost:9000";

function suggestedCompanyCode(name: string) {
  const value = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (value || "TALLY_COMPANY").slice(0, 80);
}

function bridgeLaunchUrl(credential: SetupCredential) {
  const query = new URLSearchParams({
    apiBase: apiBaseUrl,
    connectorId: credential.connector.id,
    installationKey: credential.connector.installationKey,
    controlToken: credential.controlToken,
    tallyUrl: credential.tallyUrl,
    frontendOrigin: window.location.origin,
  });
  return `meenakshi-tally://connect?${query.toString()}`;
}

function targetModeFor(tallyUrl: string): TallyTargetMode {
  try {
    const hostname = new URL(tallyUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" ? "same_machine" : "lan_server";
  } catch {
    return "lan_server";
  }
}

function normalizeTallyUrl(value: string) {
  const candidate = value.trim() || sameMachineTallyUrl;
  const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Tally server URL must use http or https.");
  return url.toString().replace(/\/$/, "");
}

function sinceLabel(value: string | null | undefined) {
  if (!value) return "Never";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "Unknown";
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

async function token() {
  const response = supabase ? await supabase.auth.getSession() : { data: { session: null } };
  return response.data.session?.access_token ?? null;
}

// A Tally sync counts as current for 30 days (same as the backend). Judged
// from its completion date, not the health check's own shorter "stale" flag.
export const TALLY_SYNC_CURRENT_DAYS = 30;
export function syncIsCurrent(entry: { status?: string; completedAt?: string | null } | null | undefined) {
  if (!entry?.completedAt || !["current", "stale", "completed"].includes(entry.status ?? "")) return false;
  return Date.now() - new Date(entry.completedAt).getTime() <= TALLY_SYNC_CURRENT_DAYS * 24 * 60 * 60 * 1_000;
}

export function workspaceIsReady(health: TallyHealth | null) {
  return Boolean(health?.ready && syncIsCurrent(health.sync?.masters) && syncIsCurrent(health.sync?.vouchers));
}

export function workspaceCanCalculateLive(health: TallyHealth | null) {
  return Boolean(health?.ready);
}

export function useTallyHealth(options: { enabled?: boolean } = {}) {
  const { company, companyKey } = useCompany();
  const enabled = options.enabled ?? true;
  const [health, setHealth] = useState<TallyHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const accessToken = await token();
    if (!accessToken) {
      inFlight.current = false;
      return;
    }
    setLoading(true);
    try {
      setHealth(await apiRequest<TallyHealth>(accessToken, `/api/companies/${company.id}/tally-health`));
      setError(null);
    } catch (cause) {
      setError(userFacingError(cause, "Could not check the Tally connection."));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [company.id]);
  useEffect(() => {
    if (!enabled) return;
    setHealth(null);
    void load();
    const poll = () => { if (document.visibilityState === "visible") void load(); };
    const interval = window.setInterval(poll, 15_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [companyKey, enabled, load]);
  return { health, error, loading, reload: load };
}

const PAGE_HEADER = <WorkspacePageHeader eyebrow="Tally connection" title="Tally Prime" detail="Meenakshi reads your customers, products and sales from Tally Prime." />;

function TallyReadinessSkeleton() {
  return <div className="workspace-content">
    {PAGE_HEADER}
    <div className={s.page}>
      <section className={s.hero} data-tone="idle">
        <div className={s.heroMain}>
          <Skeleton lines={1} style={{ width: 52, height: 52, borderRadius: 16 }} />
          <div className={s.heroCopy}>
            <Skeleton lines={1} style={{ width: 220, height: 20, marginBottom: 8 }} />
            <Skeleton lines={1} style={{ width: 320, maxWidth: "100%", height: 12 }} />
          </div>
        </div>
        <div className={s.steps}>{[0, 1, 2].map((item) => <Skeleton key={item} lines={1} style={{ width: "100%", height: 44, borderRadius: 12 }} />)}</div>
      </section>
    </div>
  </div>;
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CheckCircle2 size={18} />;
  if (state === "problem") return <CircleAlert size={18} />;
  if (state === "current") return <LoaderCircle size={18} className={s.spin} />;
  return <span className={s.stepDot} />;
}

function Step({ state, label, detail }: { state: StepState; label: string; detail: string }) {
  return <li className={s.step} data-state={state}>
    <span className={s.stepIcon} aria-hidden="true"><StepIcon state={state} /></span>
    <span className={s.stepCopy}><strong>{label}</strong><small>{detail}</small></span>
    <span className="sr-only">{state === "done" ? "Done" : state === "problem" ? "Needs attention" : state === "current" ? "In progress" : "Not started"}</span>
  </li>;
}

export function TallyReadiness({ health: initialHealth, onRefresh }: { health?: TallyHealth | null; onRefresh?: () => Promise<void> }) {
  const { company, organization, companyKey, isAdministrator, availableCompanies } = useCompany();
  const health = initialHealth ?? null;
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
  const [localConnectorId, setLocalConnectorId] = useState<string | null>(null);
  const reconnectStorageKey = `meenakshi:connector:${organization.id}`;
  const [connectorSnapshot, setConnectorSnapshot] = useState<ConnectorCompanySnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
 const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [addingComputer, setAddingComputer] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [targetMode, setTargetMode] = useState<TallyTargetMode>("same_machine");
  const [tallyUrlInput, setTallyUrlInput] = useState(sameMachineTallyUrl);
  const [companyCodeInput, setCompanyCodeInput] = useState("");
  const [registeringCompany, setRegisteringCompany] = useState(false);
  const [assigningCompany, setAssigningCompany] = useState(false);
  const refreshInFlight = useRef(false);
  const launchInFlight = useRef(false);

  const selectedConnector = useMemo(
    () => selectReconnectConnector(connectors, localConnectorId, selectedConnectorId, health?.connector?.id ?? null),
    [connectors, health?.connector?.id, localConnectorId, selectedConnectorId]
  );
  const connectorId = selectedConnector?.id ?? null;
  // A delayed poll for an older session must not describe the chosen computer.
  const currentSnapshot = connectorSnapshot?.connector.id === connectorId ? connectorSnapshot : null;
  const snapshotConnector = currentSnapshot?.connector ?? null;
  const tallyCompanies = currentSnapshot?.companies ?? [];
  const activeTallyCompany = currentSnapshot?.activeCompany ?? tallyCompanies.find((item) => item.isActive) ?? null;
  // Tally Prime is the only place where the active company can change.
  // The browser only reflects its live selection; it never picks another
  // detected company on the user's behalf.
  const selectedTallyCompany = activeTallyCompany;
  const selectedCompanyAlreadyRegistered = Boolean(selectedTallyCompany && availableCompanies.some((item) => item.company.tally_company_guid.toLowerCase() === selectedTallyCompany.guid.toLowerCase()));
  const selectedConnectorCanTakeCompany = Boolean(
    connectorId
    && connectorId !== health?.connector?.id
    && selectedTallyCompany?.guid.toLowerCase() === company.tally_company_guid.toLowerCase()
  );
  const bridgeConnected = Boolean(snapshotConnector?.bridgeConnected);
  const tallyReachable = Boolean(snapshotConnector?.tallyReachable);
  const companyLoaded = Boolean(snapshotConnector?.companyLoaded && activeTallyCompany);
  const connectorVerified = Boolean(bridgeConnected && tallyReachable && companyLoaded && health?.ready && health.connector?.id === connectorId);
 const hasMismatch = health?.connector?.id === connectorId && health?.status === "company_mismatch";
  const heartbeatStale = Boolean(snapshotConnector?.heartbeatStale);
 const resolvedTallyUrl = targetMode === "same_machine" ? sameMachineTallyUrl : tallyUrlInput;
  const feedback = actionError
    ? { tone: "error" as const, message: actionError }
    : snapshotError
      ? { tone: "warning" as const, message: snapshotError }
      : notice
        ? { tone: "success" as const, message: notice }
        : null;

  useEffect(() => {
    try { setSelectedConnectorId(window.localStorage.getItem(reconnectStorageKey)); }
    catch { setSelectedConnectorId(null); }
    setConfirmDisconnect(false);
  }, [companyKey, reconnectStorageKey]);
  useEffect(() => {
    if (!isAdministrator) return;
    let cancelled = false;
    const probe = async () => {
      const id = await detectLocalTallyConnector();
      if (!cancelled) {
        setLocalConnectorId(id);
        if (id) {
          try { window.localStorage.setItem(reconnectStorageKey, id); } catch { /* Storage may be disabled. */ }
        }
      }
    };
    void probe();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void probe(); }, 15_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [isAdministrator, reconnectStorageKey]);

  const loadConnectors = useCallback(async () => {
    if (!isAdministrator) return;
    const accessToken = await token();
    if (!accessToken) return;
    try {
      const data = await apiRequest<{ connectors: Connector[] }>(accessToken, `/api/connectors?organizationId=${organization.id}`);
      setConnectors(data.connectors);
    } catch (cause) {
      setActionError(userFacingError(cause, "Could not load the Tally connection."));
    }
  }, [isAdministrator, organization.id]);

  const loadConnectorSnapshot = useCallback(async () => {
    if (!connectorId) {
      setConnectorSnapshot(null);
      return;
    }
    const accessToken = await token();
    if (!accessToken) return;
    try {
      const snapshot = await apiRequest<ConnectorCompanySnapshot>(accessToken, `/api/connectors/${connectorId}/tally-companies`);
      setConnectorSnapshot(snapshot);
      setSnapshotError(null);
    } catch (cause) {
      setConnectorSnapshot(null);
      setSnapshotError(userFacingError(cause, "Could not confirm the Tally connection."));
    }
  }, [connectorId]);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      await Promise.all([loadConnectorSnapshot(), onRefresh?.()]);
    } finally {
      refreshInFlight.current = false;
    }
  }, [loadConnectorSnapshot, onRefresh]);

  async function recheck() {
    setRechecking(true);
    setActionError(null);
    try { await refresh(); } finally { setRechecking(false); }
  }

  useEffect(() => {
   setNotice(null);
    setActionError(null);
    setTargetMode("same_machine");
    setTallyUrlInput(sameMachineTallyUrl);
    void loadConnectors();
  }, [companyKey, loadConnectors]);
  useEffect(() => { void loadConnectorSnapshot(); }, [loadConnectorSnapshot]);
  useEffect(() => {
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void loadConnectorSnapshot(); }, 15_000);
    return () => window.clearInterval(interval);
  }, [loadConnectorSnapshot]);
  useEffect(() => {
    if (!launching) return;
    const timeout = window.setTimeout(() => setLaunching(false), 60_000);
    return () => window.clearTimeout(timeout);
  }, [launching]);
  useEffect(() => {
    if (!addingComputer) return;
    const timeout = window.setTimeout(() => setAddingComputer(false), 60_000);
    return () => window.clearTimeout(timeout);
  }, [addingComputer]);
  useEffect(() => {
    if (bridgeConnected) setLaunching(false);
  }, [bridgeConnected]);
  useEffect(() => {
    if (addingComputer && bridgeConnected) setAddingComputer(false);
  }, [addingComputer, bridgeConnected]);
  useEffect(() => {
    if (!snapshotConnector?.tallyUrl || bridgeConnected) return;
    setTargetMode(targetModeFor(snapshotConnector.tallyUrl));
    setTallyUrlInput(snapshotConnector.tallyUrl);
  }, [bridgeConnected, snapshotConnector?.tallyUrl]);
  useEffect(() => {
    setCompanyCodeInput(selectedTallyCompany ? suggestedCompanyCode(selectedTallyCompany.name) : "");
  }, [selectedTallyCompany?.guid, selectedTallyCompany?.name]);

  async function connect() {
    if (launchInFlight.current || launching || addingComputer) return;
    launchInFlight.current = true;
    setActionError(null);
    setNotice(null);
    try {
      // Probe again at click time: the desktop connector may have opened since
      // the last page poll. Reuse its ID even when another company session is bound.
      const detectedId = await detectLocalTallyConnector();
      const activeConnectorId = selectReconnectConnector(connectors, detectedId, selectedConnectorId, health?.connector?.id ?? null)?.id;
      if (!activeConnectorId) {
        if (!connectors.some((item) => item.status !== "revoked")) {
          launchInFlight.current = false;
          await addComputer();
          return;
        }
        setActionError("Open Meenakshi Tally Connector on this computer, then click Reconnect. No new computer has been created.");
        return;
      }
      const accessToken = await token();
      if (!accessToken) return;
      const tallyUrl = normalizeTallyUrl(resolvedTallyUrl);
      setLaunching(true);
      const credential = await apiRequest<SetupCredential>(accessToken, `/api/connectors/${activeConnectorId}/rotate-credential`, {
        method: "POST",
        body: jsonBody({ tallyUrl }),
      });
      setLocalConnectorId(null);
      setSelectedConnectorId(activeConnectorId);
      setConnectorSnapshot(null);
      try { window.localStorage.setItem(reconnectStorageKey, activeConnectorId); } catch { /* Optional hint, not a credential. */ }
      setNotice("Opening Meenakshi Tally Connector. If your browser asks, allow it to open.");
      window.location.assign(bridgeLaunchUrl(credential));
    } catch (cause) {
      setLaunching(false);
      setActionError(userFacingError(cause, "Could not open Meenakshi Tally Connector."));
    } finally {
      launchInFlight.current = false;
    }
  }

  async function addComputer() {
    if (launchInFlight.current || launching || addingComputer) return;
    launchInFlight.current = true;
    setActionError(null);
    setNotice(null);
    try {
      const detectedId = await detectLocalTallyConnector();
      if (connectors.some((item) => item.id === detectedId && item.status !== "revoked")) {
        launchInFlight.current = false;
        await connect();
        return;
      }
      const accessToken = await token();
      if (!accessToken) return;
      setAddingComputer(true);
      const displayName = `Tally computer ${connectors.length + 1}`;
      const credential = await apiRequest<SetupCredential>(accessToken, "/api/connectors", {
        method: "POST",
        body: jsonBody({ organizationId: organization.id, displayName }),
      });
      setConnectors((current) => [credential.connector, ...current.filter((item) => item.id !== credential.connector.id)]);
      setSelectedConnectorId(credential.connector.id);
      setLocalConnectorId(null);
      try { window.localStorage.setItem(reconnectStorageKey, credential.connector.id); } catch { /* Optional hint. */ }
      setConnectorSnapshot(null);
      setNotice("Opening Meenakshi Tally Connector on this computer. If your browser asks, allow it to open.");
      window.location.assign(bridgeLaunchUrl(credential));
    } catch (cause) {
      setActionError(userFacingError(cause, "Could not add the Tally computer."));
      setAddingComputer(false);
    } finally {
      launchInFlight.current = false;
    }
  }

  async function registerSelectedTallyCompany() {
    if (!connectorId || !selectedTallyCompany) {
      setActionError("Open a company in Tally Prime first.");
      return;
    }
    if (!selectedTallyCompany.isActive) {
      setActionError(`Open ${selectedTallyCompany.name} in Tally Prime before adding it.`);
      return;
    }
    if (selectedCompanyAlreadyRegistered) {
      setNotice("This Tally company is already added. Refresh the page to switch to it.");
      return;
    }
    const code = companyCodeInput.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{1,79}$/.test(code)) {
      setActionError("Enter a short code of at least two letters or numbers, starting with a letter.");
      return;
    }
    const accessToken = await token();
    if (!accessToken) return;
    setRegisteringCompany(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{ company: RegisteredCompany }>(accessToken, "/api/companies", {
        method: "POST",
        body: jsonBody({
          organizationId: organization.id,
          code,
          tallyCompanyGuid: selectedTallyCompany.guid,
          tallyCompanyName: selectedTallyCompany.name,
        }),
      });
      await apiRequest(accessToken, `/api/connectors/${connectorId}/bindings`, {
        method: "POST",
        body: jsonBody({ companyId: result.company.id }),
      });
      setNotice(`${selectedTallyCompany.name} is added. Opening it now…`);
      window.setTimeout(() => window.location.reload(), 750);
    } catch (cause) {
      setActionError(userFacingError(cause, "Could not add this Tally company."));
    } finally {
      setRegisteringCompany(false);
    }
  }

  async function assignCompanyToSelectedComputer() {
    if (!connectorId || !selectedConnectorCanTakeCompany) return;
    const accessToken = await token();
    if (!accessToken) return;
    setAssigningCompany(true);
    setActionError(null);
    setNotice(null);
    try {
      await apiRequest(accessToken, `/api/connectors/${connectorId}/bindings`, {
        method: "POST",
        body: jsonBody({ companyId: company.id }),
      });
      setNotice(`${company.tally_company_name} now uses ${selectedConnector?.displayName ?? "this computer"}.`);
      window.setTimeout(() => window.location.reload(), 750);
    } catch (cause) {
      setActionError(userFacingError(cause, "Could not switch the company to this computer."));
    } finally {
      setAssigningCompany(false);
    }
  }

  async function disconnect() {
    if (!connectorId) return;
    const accessToken = await token();
    if (!accessToken) return;
    setDisconnecting(true);
    setActionError(null);
    setNotice(null);
    try {
      await apiRequest(accessToken, `/api/connectors/${connectorId}/disconnect`, { method: "POST" });
      setConnectorSnapshot(null);
      setConfirmDisconnect(false);
      setNotice("Tally has been disconnected from Meenakshi.");
      await Promise.all([loadConnectors(), onRefresh?.()]);
    } catch (cause) {
      setActionError(userFacingError(cause, "Could not disconnect Tally."));
    } finally {
      setDisconnecting(false);
    }
  }

  if (!health) return <TallyReadinessSkeleton />;

  // One headline, one sentence, one next action.
  const waitingForConnector = launching || addingComputer;
  const connectLabel = connectorId ? "Reconnect" : "Connect this computer";
  const recheckButton = (primary = false) => <Button type="button" className={primary ? "" : "button-secondary"} disabled={rechecking} onClick={() => void recheck()}><RefreshCw size={15} className={rechecking ? s.spin : undefined} />{rechecking ? "Checking…" : "Check again"}</Button>;

  let tone: Tone;
  let title: string;
  let description: string;
  let primary: ReactNode = null;
  let primaryIsRecheck = false;
  if (waitingForConnector) {
    tone = "working";
    title = "Waiting for the connector";
    description = "Meenakshi Tally Connector is opening. Keep Tally Prime open — this page updates on its own once it connects.";
  } else if (connectorVerified) {
    tone = "ready";
    title = "Connected";
    description = `${company.tally_company_name} is connected to Meenakshi.`;
  } else if (bridgeConnected && tallyReachable && selectedConnectorCanTakeCompany) {
    tone = "attention";
    title = "Use this computer for this company?";
    description = `${company.tally_company_name} is open here, but it is saved to another computer. Switch it to this one to continue.`;
    primary = isAdministrator ? <Button type="button" disabled={assigningCompany} onClick={() => void assignCompanyToSelectedComputer()}><Monitor size={15} />{assigningCompany ? "Switching…" : "Use this computer"}</Button> : null;
  } else if (hasMismatch) {
    tone = "attention";
    title = `Open ${company.tally_company_name} in Tally`;
    description = `A different company is open in Tally Prime. Open ${company.tally_company_name}, then check again.`;
    primary = recheckButton(true); primaryIsRecheck = true;
  } else if (bridgeConnected && !tallyReachable) {
    tone = "attention";
    title = "Tally Prime isn't responding";
    description = "Open Tally Prime on the computer running it, then check again.";
    primary = recheckButton(true); primaryIsRecheck = true;
  } else if (bridgeConnected && !companyLoaded) {
    tone = "attention";
    title = "Open a company in Tally Prime";
    description = `Open ${company.tally_company_name} in Tally Prime, then check again.`;
    primary = recheckButton(true); primaryIsRecheck = true;
  } else if (heartbeatStale) {
    tone = "attention";
    title = "The connector stopped responding";
    description = "Make sure the computer running Tally is on and Meenakshi Tally Connector is open.";
    primary = isAdministrator ? <Button type="button" onClick={() => void connect()}><PlugZap size={15} />Reconnect</Button> : recheckButton(true);
  } else {
    tone = "idle";
    title = "Connect Tally Prime";
    description = isAdministrator ? "Follow the three steps below. It takes about a minute." : "An Administrator needs to connect Tally Prime from this page.";
    primary = isAdministrator ? <Button type="button" onClick={() => void connect()}><PlugZap size={15} />{connectLabel}</Button> : null;
  }

  const stepConnector: StepState = bridgeConnected ? "done" : heartbeatStale ? "problem" : waitingForConnector ? "current" : "todo";
  const stepTally: StepState = tallyReachable ? "done" : bridgeConnected ? "problem" : "todo";
  const stepCompany: StepState = companyLoaded && health.ready ? "done" : hasMismatch || (tallyReachable && !companyLoaded) ? "problem" : "todo";
  const heroIcon = tone === "ready" ? <CheckCircle2 size={26} /> : tone === "working" ? <LoaderCircle size={26} className={s.spin} /> : tone === "attention" ? <CircleAlert size={26} /> : <Cable size={24} />;
  const unregisteredActive = isAdministrator && bridgeConnected && tallyReachable && selectedTallyCompany?.isActive && !selectedCompanyAlreadyRegistered;
  const lastError = !connectorVerified && snapshotConnector?.lastError ? userFacingDetail(snapshotConnector.lastError, "The Tally connection needs attention. Check again to retry.") : null;

  return (
    <div className="workspace-content">
      {PAGE_HEADER}
      <div className={s.page}>
        {feedback && <InlineMessage tone={feedback.tone}>{feedback.message}</InlineMessage>}

        <section className={s.hero} data-tone={tone} aria-live="polite">
          <div className={s.heroMain}>
            <span className={s.heroIcon}>{heroIcon}</span>
            <div className={s.heroCopy}>
              <h2>{title}</h2>
              <p>{description}</p>
              {lastError && <p className={s.heroError}><CircleAlert size={14} />{lastError}</p>}
            </div>
            <div className={s.heroActions}>
              {primary}
              {(tone === "ready" || (primary && !primaryIsRecheck)) && <button type="button" className={s.textAction} disabled={rechecking} onClick={() => void recheck()}>{rechecking ? "Checking…" : "Check again"}</button>}
              {!primary && tone !== "ready" && recheckButton()}
            </div>
          </div>
          {tone !== "ready" && <ol className={s.steps} aria-label="Connection progress">
            <Step state={stepConnector} label="Connector" detail={bridgeConnected ? "Running" : waitingForConnector ? "Opening…" : heartbeatStale ? "Not responding" : "Not connected"} />
            <Step state={stepTally} label="Tally Prime" detail={tallyReachable ? "Responding" : bridgeConnected ? "Not responding" : "Waiting"} />
            <Step state={stepCompany} label="Company" detail={companyLoaded && activeTallyCompany ? activeTallyCompany.name : hasMismatch ? "Different company open" : "Not open"} />
          </ol>}
        </section>

        {isAdministrator && !bridgeConnected && !waitingForConnector && <section className={s.card}>
          <header className={s.cardHeader}><h3>Before you connect</h3></header>
          <ol className={s.guide}>
            <li><span>1</span><div><strong>Open Tally Prime</strong><p>Open <b>{company.tally_company_name}</b> and leave Tally running.</p></div></li>
            <li><span>2</span><div>
              <strong>Where is Tally running?</strong>
              <div className={s.choice} role="radiogroup" aria-label="Where Tally runs">
                <button type="button" role="radio" aria-checked={targetMode === "same_machine"} onClick={() => { setTargetMode("same_machine"); setTallyUrlInput(sameMachineTallyUrl); }}><Monitor size={16} /><span><b>This computer</b><small>Most common</small></span></button>
                <button type="button" role="radio" aria-checked={targetMode === "lan_server"} onClick={() => setTargetMode("lan_server")}><ServerCog size={16} /><span><b>Another computer</b><small>On your office network</small></span></button>
              </div>
              {targetMode === "lan_server" && <label className={s.urlField}><span>Tally address</span><input value={tallyUrlInput} onChange={(event) => setTallyUrlInput(event.target.value)} placeholder="http://192.168.1.20:9000" inputMode="url" autoComplete="off" /><small>Usually that computer’s network address followed by :9000.</small></label>}
            </div></li>
            <li><span>3</span><div><strong>Click “{connectLabel}”</strong><p>Your browser will ask to open Meenakshi Tally Connector — choose <b>Open</b>.</p></div></li>
          </ol>
        </section>}

        {unregisteredActive && selectedTallyCompany && selectedTallyCompany.guid.toLowerCase() !== company.tally_company_guid.toLowerCase() && <section className={s.callout}>
          <Building2 size={18} />
          <div>
            <strong>{selectedTallyCompany.name} is open in Tally but not added to Meenakshi</strong>
            <p>Add it to manage its discounts separately, or open {company.tally_company_name} in Tally instead.</p>
            <div className={s.calloutForm}>
              <label><span>Short code</span><input value={companyCodeInput} onChange={(event) => setCompanyCodeInput(event.target.value.toUpperCase())} maxLength={80} /></label>
              <Button type="button" disabled={registeringCompany} onClick={() => void registerSelectedTallyCompany()}>{registeringCompany ? "Adding…" : "Add company"}</Button>
            </div>
          </div>
        </section>}

        {isAdministrator && (connectors.length > 0 || tallyCompanies.length > 0) && <details className={s.advanced}>
          <summary><span>Advanced</span><small>Computers, companies in Tally, disconnect</small><ChevronDown size={16} /></summary>
          <div className={s.advancedBody}>
            <dl className={s.facts}>
              <div><dt>Computer</dt><dd>{selectedConnector?.displayName ?? "None"}{connectorId && connectorId === localConnectorId ? <em>This computer</em> : null}</dd></div>
              <div><dt>Tally address</dt><dd>{snapshotConnector?.tallyUrl ?? resolvedTallyUrl}</dd></div>
              <div><dt>Last contact</dt><dd>{sinceLabel(snapshotConnector?.lastHeartbeatAt)}</dd></div>
            </dl>

            {tallyCompanies.length > 0 && <div className={s.companies}>
              <span>Companies in Tally Prime</span>
              <ul>{tallyCompanies.map((item) => <li key={item.guid} data-active={item.isActive}><Building2 size={14} />{item.name}{item.isActive && <em>Open</em>}</li>)}</ul>
            </div>}

            <div className={s.advancedActions}>
              <Button type="button" className="button-secondary" disabled={addingComputer || launching} onClick={() => void addComputer()}><ServerCog size={15} />{addingComputer ? "Opening connector…" : "Set up another computer"}</Button>
              {bridgeConnected && (confirmDisconnect
                ? <span className={s.confirm}><span>Disconnect Tally from Meenakshi?</span><Button type="button" className="button-danger" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? "Disconnecting…" : "Disconnect"}</Button><Button type="button" className="button-quiet" onClick={() => setConfirmDisconnect(false)}>Cancel</Button></span>
                : <Button type="button" className="button-quiet" onClick={() => setConfirmDisconnect(true)}><Unplug size={15} />Disconnect</Button>)}
            </div>
          </div>
        </details>}

        <p className={s.footnote}><ShieldCheck size={14} />Meenakshi checks Tally from this computer. Your connection details stay private.</p>
      </div>
    </div>
  );
}
