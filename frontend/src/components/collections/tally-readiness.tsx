"use client";

import { Building2, Cable, CheckCircle2, CircleAlert, RefreshCw, ServerCog, ShieldCheck, Unplug, Wifi } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiBaseUrl, apiRequest, jsonBody } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { userFacingDetail, userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { WorkspacePageHeader } from "./app-shell";
import type { TallyHealth } from "./types";
import { Button, Card, InlineMessage, Skeleton, StatusBadge, formatDate } from "./ui";

type Connector = { id: string; displayName: string; status: string };
type SetupCredential = { connector: { id: string; installationKey: string }; controlToken: string; tallyUrl: string };
type SyncRun = {
  id: string;
  sync_kind: "masters" | "vouchers";
  status: string;
  records_applied: number | null;
  records_failed: number | null;
  error_summary: string | null;
  started_at: string | null;
};
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

const sameMachineTallyUrl = "http://localhost:9000";
const requestKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-${Date.now()}`;
const inProgress = (status: string) => status === "queued" || status === "running";

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

function syncProgressCopy(run: SyncRun) {
  if (run.status === "queued") return "Preparing your Tally data update.";
  if (run.status === "running") return "Meenakshi is updating the selected Tally information.";
  if (run.status === "completed") return "Tally data is up to date.";
  return userFacingDetail(run.error_summary, "The update could not finish. Keep Tally Prime open and try again.");
}

async function token() {
  const response = supabase ? await supabase.auth.getSession() : { data: { session: null } };
  return response.data.session?.access_token ?? null;
}

export function workspaceIsReady(health: TallyHealth | null) {
  return Boolean(health?.ready && health.sync?.masters.status === "current" && health.sync?.vouchers.status === "current");
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

function ConnectionPipelineStepper({ targetMode, bridgeConnected, tallyReachable, companyLoaded }: { targetMode: TallyTargetMode; bridgeConnected: boolean; tallyReachable: boolean; companyLoaded: boolean }) {
  const step1Complete = true;
  const step2Complete = bridgeConnected && tallyReachable;
  const step3Complete = companyLoaded;

  return (
    <div className="tally-pipeline-stepper" aria-label="Connection Progress">
      <div className={`pipeline-step ${step1Complete ? "is-complete" : "is-active"}`}>
        <div className="step-node"><Wifi size={14} /></div>
        <div className="step-label">
          <span>STEP 1</span>
          <strong>{targetMode === "same_machine" ? "Same Machine" : "LAN Host"}</strong>
        </div>
      </div>
      <div className={`pipeline-connector ${step2Complete ? "is-complete" : ""}`} />
      <div className={`pipeline-step ${step2Complete ? "is-complete" : bridgeConnected ? "is-active" : ""}`}>
        <div className="step-node"><Cable size={14} /></div>
        <div className="step-label">
          <span>STEP 2</span>
          <strong>Connector Agent</strong>
        </div>
      </div>
      <div className={`pipeline-connector ${step3Complete ? "is-complete" : ""}`} />
      <div className={`pipeline-step ${step3Complete ? "is-complete" : step2Complete ? "is-active" : ""}`}>
        <div className="step-node"><Building2 size={14} /></div>
        <div className="step-label">
          <span>STEP 3</span>
          <strong>Tally Company</strong>
        </div>
      </div>
    </div>
  );
}

function ConnectionStatusCard({ icon, label, value, detail, ready, attention = false }: { icon: ReactNode; label: string; value: string; detail: string; ready: boolean; attention?: boolean }) {
  return (
    <article className={`tally-status-card ${ready ? "is-ready" : attention ? "is-attention" : ""}`}>
      <div className="tally-status-card-header">
        <div className="tally-status-card-icon">{icon}</div>
        <span className={`status-indicator-dot ${ready ? "ready" : attention ? "attention" : "offline"}`} />
      </div>
      <div>
        <p className="status-node-label">{label}</p>
        <strong className="status-node-value">{value}</strong>
        <span className="status-node-detail">{detail}</span>
      </div>
    </article>
  );
}

export function TallyReadiness({ health: initialHealth, onRefresh }: { health?: TallyHealth | null; onRefresh?: () => Promise<void> }) {
  const { company, organization, companyKey, isAdministrator, availableCompanies } = useCompany();
  const health = initialHealth ?? null;
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectorSnapshot, setConnectorSnapshot] = useState<ConnectorCompanySnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [syncRun, setSyncRun] = useState<SyncRun | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [targetMode, setTargetMode] = useState<TallyTargetMode>("same_machine");
  const [tallyUrlInput, setTallyUrlInput] = useState(sameMachineTallyUrl);
  const [selectedCompanyGuid, setSelectedCompanyGuid] = useState<string | null>(null);
  const [companyCodeInput, setCompanyCodeInput] = useState("");
  const [registeringCompany, setRegisteringCompany] = useState(false);
  const refreshInFlight = useRef(false);

  const selectedConnector = useMemo(
    () => connectors.find((item) => item.id === health?.connector?.id) ?? connectors[0] ?? null,
    [connectors, health?.connector?.id]
  );
  const connectorId = health?.connector?.id ?? selectedConnector?.id ?? null;
  const snapshotConnector = connectorSnapshot?.connector ?? null;
  const tallyCompanies = connectorSnapshot?.companies ?? [];
  const activeTallyCompany = connectorSnapshot?.activeCompany ?? tallyCompanies.find((item) => item.isActive) ?? null;
  const selectedTallyCompany = tallyCompanies.find((item) => item.guid === selectedCompanyGuid) ?? activeTallyCompany;
  const selectedCompanyAlreadyRegistered = Boolean(selectedTallyCompany && availableCompanies.some((item) => item.company.tally_company_guid.toLowerCase() === selectedTallyCompany.guid.toLowerCase()));
  const bridgeConnected = Boolean(snapshotConnector?.bridgeConnected);
  const tallyReachable = Boolean(snapshotConnector?.tallyReachable);
  const companyLoaded = Boolean(snapshotConnector?.companyLoaded && activeTallyCompany);
  const connectorVerified = Boolean(bridgeConnected && tallyReachable && companyLoaded && health?.ready);
  const workspaceReady = connectorVerified && workspaceIsReady(health);
  const needsDataSync = health?.sync?.masters.status !== "current" || health?.sync?.vouchers.status !== "current";
  const hasMismatch = health?.status === "company_mismatch";
  const connectionStatus = connectorVerified ? "current" : snapshotConnector?.heartbeatStale ? "bridge_stale" : snapshotConnector?.status ?? health?.status ?? "not_bound";
  const resolvedTallyUrl = targetMode === "same_machine" ? sameMachineTallyUrl : tallyUrlInput;
  const feedback = actionError
    ? { tone: "error" as const, message: actionError }
    : snapshotError
      ? { tone: "warning" as const, message: snapshotError }
      : notice
        ? { tone: "success" as const, message: notice }
        : null;

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

  useEffect(() => {
    setSyncRun(null);
    setNotice(null);
    setActionError(null);
    setSelectedCompanyGuid(null);
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
    if (bridgeConnected) setLaunching(false);
  }, [bridgeConnected]);
  useEffect(() => {
    if (!snapshotConnector?.tallyUrl || bridgeConnected) return;
    setTargetMode(targetModeFor(snapshotConnector.tallyUrl));
    setTallyUrlInput(snapshotConnector.tallyUrl);
  }, [bridgeConnected, snapshotConnector?.tallyUrl]);
  useEffect(() => {
    if (!activeTallyCompany) {
      setSelectedCompanyGuid(null);
      return;
    }
    setSelectedCompanyGuid((current) => tallyCompanies.some((item) => item.guid === current) ? current : activeTallyCompany.guid);
  }, [activeTallyCompany, tallyCompanies]);
  useEffect(() => {
    setCompanyCodeInput(selectedTallyCompany ? suggestedCompanyCode(selectedTallyCompany.name) : "");
  }, [selectedTallyCompany?.guid, selectedTallyCompany?.name]);
  useEffect(() => {
    if (!syncRun || !inProgress(syncRun.status)) return;
    let cancelled = false;
    const check = async () => {
      const accessToken = await token();
      if (!accessToken) return;
      try {
        const result = await apiRequest<{ syncRun: SyncRun }>(accessToken, `/api/companies/${company.id}/sync/runs/${syncRun.id}`);
        if (cancelled) return;
        setSyncRun(result.syncRun);
        if (result.syncRun.status === "completed") {
          setNotice("Tally data is up to date.");
          await refresh();
        }
      } catch {
        setActionError("Could not check the update progress. Refresh to try again.");
      }
    };
    void check();
    const interval = window.setInterval(() => { void check(); }, 4_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [company.id, refresh, syncRun]);

  const connectionTitle = launching
    ? "Checking the Tally connection"
    : connectorVerified
      ? "Tally Prime connected"
      : hasMismatch
        ? "Open the expected Tally company"
        : bridgeConnected && !tallyReachable
          ? "Tally Prime is not reachable"
          : bridgeConnected && !companyLoaded
            ? "Waiting for an active Tally company"
            : "Connect Tally Prime";
  const connectionDescription = launching
    ? "Meenakshi will confirm the connection after it reaches Tally and finds the company currently open."
    : connectorVerified
      ? "Tally Prime and the company currently open are confirmed. Meenakshi is ready to update your data."
      : hasMismatch
        ? `Open ${company.tally_company_name} in Tally Prime, then refresh this page.`
        : bridgeConnected && !tallyReachable
          ? "Keep Tally Prime open and make sure it is available from this computer."
          : bridgeConnected && !companyLoaded
            ? "Open a company in Tally Prime, then refresh the connection."
            : "Choose where Tally is running, then open Meenakshi Tally Connector.";

  async function connect() {
    const activeConnectorId = connectorId;
    if (!activeConnectorId) {
      setActionError("Meenakshi Tally Connector has not been set up for this workspace yet.");
      return;
    }
    const accessToken = await token();
    if (!accessToken) return;
    setActionError(null);
    setNotice(null);
    try {
      const tallyUrl = normalizeTallyUrl(resolvedTallyUrl);
      setLaunching(true);
      const credential = await apiRequest<SetupCredential>(accessToken, `/api/connectors/${activeConnectorId}/rotate-credential`, {
        method: "POST",
        body: jsonBody({ tallyUrl }),
      });
      setNotice("Opening the Meenakshi Tally Connector. Keep Tally Prime open while it checks the active company.");
      window.location.assign(bridgeLaunchUrl(credential));
    } catch (cause) {
      setLaunching(false);
      setActionError(userFacingError(cause, "Could not open Meenakshi Tally Connector."));
    }
  }

  async function syncTallyData(requestedKind?: "masters" | "vouchers") {
    const accessToken = await token();
    if (!accessToken) return;
    const kind = requestedKind ?? (health?.sync?.masters.status === "current" ? "vouchers" : "masters");
    const body = kind === "vouchers" ? jsonBody({ dateFrom: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10), dateTo: new Date().toISOString().slice(0, 10) }) : undefined;
    setActionError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{ syncRun: SyncRun }>(accessToken, `/api/companies/${company.id}/sync/${kind}`, {
        method: "POST",
        headers: { "Idempotency-Key": requestKey() },
        body,
      });
      setSyncRun(result.syncRun);
      setNotice(kind === "masters" ? "Updating company lists and settings from Tally." : "Updating recent sales records from Tally.");
    } catch (cause) {
      setActionError(userFacingError(cause, "Could not start the Tally data update."));
    }
  }

  async function registerSelectedTallyCompany() {
    if (!connectorId || !selectedTallyCompany) {
      setActionError("Select an active Tally company first.");
      return;
    }
    if (!selectedTallyCompany.isActive) {
      setActionError(`Open ${selectedTallyCompany.name} in Tally Prime before registering it.`);
      return;
    }
    if (selectedCompanyAlreadyRegistered) {
      setNotice("This Tally company is already registered. Refresh the workspace to select it.");
      return;
    }
    const code = companyCodeInput.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{1,79}$/.test(code)) {
      setActionError("Enter a company code of at least two letters or numbers, starting with a letter.");
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
      window.sessionStorage.setItem("meenakshi.activeCompanyId", result.company.id);
      setNotice(`${selectedTallyCompany.name} is registered separately and ready for a read-only master sync. Opening it now.`);
      window.setTimeout(() => window.location.reload(), 750);
    } catch (cause) {
      setActionError(userFacingError(cause, "Could not register and bind this Tally company."));
    } finally {
      setRegisteringCompany(false);
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
      setNotice("Tally has been disconnected from Meenakshi.");
      await Promise.all([loadConnectors(), onRefresh?.()]);
    } catch (cause) {
      setActionError(userFacingError(cause, "Could not disconnect Tally."));
    } finally {
      setDisconnecting(false);
    }
  }

function TallyReadinessSkeleton() {
  return (
    <div className="workspace-content">
      <WorkspacePageHeader
        eyebrow="Tally connection"
        title="Connect Tally Prime"
        detail="Check that Tally is connected and see the company currently open."
      />
      <div className="tally-connection-workspace">
        <Card className="tally-unified-card">
          <div className="tally-card-header-bar">
            <div className="header-info">
              <Skeleton lines={1} style={{ width: 36, height: 36, borderRadius: 10 }} />
              <div>
                <Skeleton lines={1} style={{ width: 160, height: 16, marginBottom: 6 }} />
                <Skeleton lines={1} style={{ width: 240, height: 11 }} />
              </div>
            </div>
            <Skeleton lines={1} style={{ width: 85, height: 22, borderRadius: 99 }} />
          </div>

          <div className="tally-location-segmented">
            <Skeleton lines={1} style={{ width: 60, height: 12 }} />
            <div style={{ display: "flex", gap: 6 }}>
              <Skeleton lines={1} style={{ width: 140, height: 28, borderRadius: 7 }} />
              <Skeleton lines={1} style={{ width: 100, height: 28, borderRadius: 7 }} />
            </div>
          </div>

          <div className="tally-status-grid">
            <div className="tally-status-card">
              <Skeleton lines={1} style={{ width: 32, height: 32, borderRadius: 8, marginBottom: 8 }} />
              <Skeleton lines={1} style={{ width: 100, height: 14, marginBottom: 4 }} />
              <Skeleton lines={1} style={{ width: 130, height: 11 }} />
            </div>
            <div className="tally-status-card">
              <Skeleton lines={1} style={{ width: 32, height: 32, borderRadius: 8, marginBottom: 8 }} />
              <Skeleton lines={1} style={{ width: 100, height: 14, marginBottom: 4 }} />
              <Skeleton lines={1} style={{ width: 130, height: 11 }} />
            </div>
            <div className="tally-status-card">
              <Skeleton lines={1} style={{ width: 32, height: 32, borderRadius: 8, marginBottom: 8 }} />
              <Skeleton lines={1} style={{ width: 100, height: 14, marginBottom: 4 }} />
              <Skeleton lines={1} style={{ width: 130, height: 11 }} />
            </div>
          </div>

          <div className="tally-connection-actions">
            <Skeleton lines={1} style={{ width: 120, height: 36, borderRadius: 8 }} />
            <Skeleton lines={1} style={{ width: 100, height: 36, borderRadius: 8 }} />
          </div>
        </Card>
      </div>
    </div>
  );
}

  if (!health) return <TallyReadinessSkeleton />;

  return (
    <div className="workspace-content">
      <WorkspacePageHeader
        eyebrow="Tally connection"
        title="Connect Tally Prime"
        detail="Check that Tally is connected and see the company currently open."
      />
      <div className="tally-connection-workspace">
        {feedback && <InlineMessage tone={feedback.tone}>{feedback.message}</InlineMessage>}

        <Card className={`tally-unified-card ${connectorVerified ? "is-ready" : ""}`}>
          <div className="tally-card-header-bar">
            <div className="header-info">
              <div className="header-icon">
                <Cable size={18} />
              </div>
              <div>
                <h2>{connectionTitle}</h2>
                <p>{connectionDescription}</p>
              </div>
            </div>
            <StatusBadge status={connectionStatus} />
          </div>

          {isAdministrator && !bridgeConnected && (
            <div className="tally-location-segmented">
              <span className="segmented-label">Tally runs on:</span>
              <div className="segmented-buttons">
                <button
                  type="button"
                  className={targetMode === "same_machine" ? "active" : ""}
                  onClick={() => {
                    setTargetMode("same_machine");
                    setTallyUrlInput(sameMachineTallyUrl);
                  }}
                >
                  <Wifi size={13} /> This computer
                </button>
                <button
                  type="button"
                  className={targetMode === "lan_server" ? "active" : ""}
                  onClick={() => setTargetMode("lan_server")}
                >
                  <ServerCog size={13} /> Another computer
                </button>
              </div>
              {targetMode === "lan_server" && (
                <input
                  className="compact-url-input"
                  value={tallyUrlInput}
                  onChange={(event) => setTallyUrlInput(event.target.value)}
                  placeholder="http://192.168.1.20:9000"
                />
              )}
            </div>
          )}

          <div className="tally-status-grid">
            <ConnectionStatusCard
              icon={<Cable size={16} />}
              label="1. Meenakshi connection"
              value={bridgeConnected ? "Connected" : launching ? "Pairing..." : "Waiting"}
              detail={bridgeConnected ? "Recently checked" : "Open Meenakshi Tally Connector"}
              ready={bridgeConnected}
              attention={launching || Boolean(snapshotConnector?.heartbeatStale)}
            />
            <ConnectionStatusCard
              icon={<Wifi size={16} />}
              label="2. Tally Prime"
              value={tallyReachable ? "Available" : "Not available"}
              detail={tallyReachable ? "Tally Prime is responding" : "Open Tally Prime, then try again"}
              ready={tallyReachable}
              attention={bridgeConnected && !tallyReachable}
            />
            <ConnectionStatusCard
              icon={<Building2 size={16} />}
              label="3. Active Company"
              value={companyLoaded ? activeTallyCompany?.name ?? "Loaded" : "Not Detected"}
              detail={companyLoaded ? "Confirmed in Tally Prime" : "Open a company in Tally Prime"}
              ready={companyLoaded && Boolean(health?.ready)}
              attention={bridgeConnected && tallyReachable && !companyLoaded}
            />
          </div>

          {snapshotConnector?.lastError && (
            <p className="tally-bridge-error">
              <CircleAlert size={14} />
              {userFacingDetail(snapshotConnector.lastError, "The Tally connection needs attention. Refresh to try again.")}
            </p>
          )}

          <div className="tally-connection-actions">
            {isAdministrator && !bridgeConnected && (
              <Button type="button" disabled={launching} onClick={() => void connect()}>
                <Cable size={15} />
                {launching ? "Checking..." : "Connect Tally"}
              </Button>
            )}
            {isAdministrator && connectorVerified && needsDataSync && (
              <Button type="button" disabled={Boolean(syncRun && inProgress(syncRun.status))} onClick={() => void syncTallyData()}>
                {syncRun && inProgress(syncRun.status) ? "Updating..." : "Update Tally data"}
              </Button>
            )}
            {isAdministrator && connectorVerified && (
              <Button type="button" className="button-secondary" disabled={Boolean(syncRun && inProgress(syncRun.status))} onClick={() => void syncTallyData("masters")}>
                {syncRun?.sync_kind === "masters" && inProgress(syncRun.status) ? "Updating masters..." : "Refresh Tally masters"}
              </Button>
            )}
            <Button type="button" className="button-secondary" disabled={disconnecting} onClick={() => void refresh()}>
              <RefreshCw size={14} />
              {bridgeConnected ? "Recheck connection" : "Refresh"}
            </Button>
            {isAdministrator && bridgeConnected && (
              <Button type="button" className="button-danger" disabled={disconnecting} onClick={() => void disconnect()}>
                <Unplug size={15} />
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </Button>
            )}
          </div>
          {!isAdministrator && !connectorVerified && (
            <p className="tally-admin-note">An Administrator can set up the Tally connection from this page.</p>
          )}
        </Card>

        {bridgeConnected && tallyReachable && (
          <Card className="tally-company-panel">
            <div className="tally-company-panel-heading">
              <div>
                <p className="eyebrow">Detected companies</p>
                <h2>{tallyCompanies.length} {tallyCompanies.length === 1 ? "company" : "companies"} available in Tally</h2>
              </div>
              {activeTallyCompany && <StatusBadge status="current">Active: {activeTallyCompany.name}</StatusBadge>}
            </div>
            {tallyCompanies.length > 0 ? (
              <>
                <div className="tally-company-grid">
                  {tallyCompanies.map((tallyCompany) => (
                    <button
                      key={tallyCompany.guid}
                      type="button"
                      className={`tally-company-option ${tallyCompany.guid === selectedTallyCompany?.guid ? "is-selected" : ""} ${tallyCompany.isActive ? "is-active" : ""}`}
                      onClick={() => setSelectedCompanyGuid(tallyCompany.guid)}
                      aria-pressed={tallyCompany.guid === selectedTallyCompany?.guid}
                    >
                      <Building2 size={16} />
                      <span>
                        <strong>{tallyCompany.name}</strong>
                        <small>{tallyCompany.isActive ? "Active in Tally Prime" : "Available in Tally Prime"}</small>
                      </span>
                      {tallyCompany.isActive && <CheckCircle2 size={16} />}
                    </button>
                  ))}
                </div>
                {selectedTallyCompany && !selectedTallyCompany.isActive && (
                  <p className="tally-company-selection-note">
                    <CircleAlert size={14} />
                    {selectedTallyCompany.name} is available, but Tally Prime currently has {activeTallyCompany?.name ?? "another company"} open. Switch the active company inside Tally Prime to use it.
                  </p>
                )}
                {isAdministrator && selectedTallyCompany?.isActive && !selectedCompanyAlreadyRegistered && (
                  <div className="tally-connection-actions">
                    <label className="tally-company-code-field">
                      <span>Separate company code</span>
                      <input value={companyCodeInput} onChange={(event) => setCompanyCodeInput(event.target.value)} maxLength={80} aria-label="Separate company code" />
                    </label>
                    <Button type="button" disabled={registeringCompany} onClick={() => void registerSelectedTallyCompany()}>
                      <Building2 size={15} />
                      {registeringCompany ? "Registering..." : "Register as a separate company"}
                    </Button>
                  </div>
                )}
                {selectedTallyCompany && selectedCompanyAlreadyRegistered && selectedTallyCompany.guid.toLowerCase() !== company.tally_company_guid.toLowerCase() && (
                  <p className="tally-company-selection-note"><CheckCircle2 size={14} />{selectedTallyCompany.name} is already registered separately. Refresh the workspace to select it.</p>
                )}
              </>
            ) : (
              <p className="tally-company-empty">Meenakshi can reach Tally Prime, but no company is currently open.</p>
            )}
          </Card>
        )}

        {syncRun && (
          <Card className="tally-sync-status">
            <div>
              <p className="eyebrow">Updating Tally data</p>
              <strong>{syncRun.sync_kind === "masters" ? "Company lists and settings" : "Recent sales records"}</strong>
              <p>{syncProgressCopy(syncRun)}</p>
            </div>
            <StatusBadge status={syncRun.status} />
            <small>
              Started {formatDate(syncRun.started_at)} · {syncRun.records_applied ?? 0} applied · {syncRun.records_failed ?? 0} failed
            </small>
          </Card>
        )}

        <div className="tally-compact-footer-note">
          <ShieldCheck size={14} />
          <span>Meenakshi checks Tally from this computer. Your connection details stay private.</span>
        </div>
      </div>
    </div>
  );
}
