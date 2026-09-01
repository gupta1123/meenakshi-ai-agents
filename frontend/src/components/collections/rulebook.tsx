"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BadgePercent, BookOpen, CalendarDays, CalendarPlus, ContactRound, Layers3, Pencil, Plus, RotateCcw, Search, Settings2, Trash2, UserPlus } from "lucide-react";

import { ApiError, apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { WorkspacePageHeader } from "./app-shell";
import type { Calendar, Contact, ReferenceData, Scheme, SchemeDetail, Version, VersionDetail } from "./types";
import { Button, Card, Dialog, Drawer, EmptyState, IconButton, InlineMessage, Skeleton, StatusBadge, formatDate, labelFor, safePhone } from "./ui";
import type { PageProps } from "./workspace";
import { GuidedDraftSetupDrawer } from "./guided-draft-setup";
import { GuidedVersionSummary, type ActivationValidation } from "./guided-version-summary";
import { RuleEditor } from "./rule-editor";
import { accessToken } from "./workspace";
import studio from "./rulebook-studio.module.css";

type RulebookData = { schemes: Scheme[]; calendars: Calendar[]; contacts: Contact[] };
type RulebookSelection = { schemeId?: string | null; versionId?: string | null };
type MasterSyncRun = { id: string; status: string; error_summary: string | null };
const blankData: RulebookData = { schemes: [], calendars: [], contacts: [] };
const liveSyncKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-live-${Date.now()}`;
const CACHE_TTL_MS = 30_000;
type CacheEntry<V> = { value: Promise<V>; expiresAt: number };

function activationValidationFromError(cause: unknown): ActivationValidation | null {
  if (!(cause instanceof ApiError) || cause.status !== 409 || !cause.body || typeof cause.body !== "object") return null;
  const body = cause.body as Record<string, unknown>;
  const rawValidation = body.validation;
  if (!rawValidation || typeof rawValidation !== "object") {
    if (typeof body.error !== "string") return null;
    return { valid: false, issues: [{ message: body.error }] };
  }
  const validation = rawValidation as Record<string, unknown>;
  if (typeof validation.valid !== "boolean") return null;
  const issues = Array.isArray(validation.issues)
    ? validation.issues.flatMap((item) => item && typeof item === "object"
      ? [{ code: typeof (item as Record<string, unknown>).code === "string" ? (item as Record<string, unknown>).code as string : undefined, message: typeof (item as Record<string, unknown>).message === "string" ? (item as Record<string, unknown>).message as string : undefined }]
      : [])
    : undefined;
  return { valid: validation.valid, issues };
}

export function RulebookPage({ data: initialData, isAdministrator, setError, setNotice, guidance, management }: PageProps & { guidance?: ReactNode; management?: ReactNode }) {
  const { company, companyKey } = useCompany();
  const [tab, setTab] = useState<"schemes" | "calendar" | "contacts" | "management">("schemes");
  const [rulebook, setRulebook] = useState<RulebookData>(blankData);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SchemeDetail | null>(null);
  const [version, setVersion] = useState<VersionDetail | null>(null);
  const [activationValidation, setActivationValidation] = useState<ActivationValidation | null>(null);
  const selectedSchemeId = useRef<string | null>(null);
  const selectedVersionId = useRef<string | null>(null);
  const schemeDetailCache = useRef(new Map<string, CacheEntry<SchemeDetail>>());
  const versionDetailCache = useRef(new Map<string, CacheEntry<VersionDetail>>());
  const loadedTabs = useRef(new Set<string>());
  const [ruleSearch, setRuleSearch] = useState("");
  const [ruleEditorMode, setRuleEditorModeState] = useState<"new" | "complete" | "update" | null>(null);
  const [draftSetupOpen, setDraftSetupOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [liveReference, setLiveReference] = useState<ReferenceData | null>(initialData.reference);
  const [refreshingReference, setRefreshingReference] = useState(false);
  const [tabLoading, setTabLoading] = useState(false);
  const [selectingScheme, setSelectingScheme] = useState(false);
  const [versionActionBusy, setVersionActionBusy] = useState<"validate" | "activate" | null>(null);
  const liveSyncAbort = useRef<AbortController | null>(null);
  const prefetchThrottled = useRef(new Set<string>());
  const data = { ...initialData, reference: liveReference };

  const getSchemeDetail = useCallback((token: string, schemeId: string, force = false) => {
    const key = `${company.id}:${schemeId}`;
    if (!force) {
      const hit = schemeDetailCache.current.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      if (hit) schemeDetailCache.current.delete(key);
    } else schemeDetailCache.current.delete(key);
    const request = apiRequest<SchemeDetail>(token, `/api/companies/${company.id}/schemes/${schemeId}`);
    schemeDetailCache.current.set(key, { value: request, expiresAt: Date.now() + CACHE_TTL_MS });
    request.catch(() => schemeDetailCache.current.delete(key));
    if (schemeDetailCache.current.size > 100) {
      const now = Date.now();
      for (const [k, v] of schemeDetailCache.current) if (v.expiresAt <= now) schemeDetailCache.current.delete(k);
    }
    return request;
  }, [company.id]);

  const getVersionDetail = useCallback((token: string, versionId: string, force = false) => {
    const key = `${company.id}:${versionId}`;
    if (!force) {
      const hit = versionDetailCache.current.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      if (hit) versionDetailCache.current.delete(key);
    } else versionDetailCache.current.delete(key);
    const request = apiRequest<VersionDetail>(token, `/api/companies/${company.id}/scheme-versions/${versionId}`);
    versionDetailCache.current.set(key, { value: request, expiresAt: Date.now() + CACHE_TTL_MS });
    request.catch(() => versionDetailCache.current.delete(key));
    if (versionDetailCache.current.size > 100) {
      const now = Date.now();
      for (const [k, v] of versionDetailCache.current) if (v.expiresAt <= now) versionDetailCache.current.delete(k);
    }
    return request;
  }, [company.id]);

  const prefetchScheme = useCallback(async (scheme: Scheme) => {
    if (prefetchThrottled.current.has(scheme.id)) return;
    prefetchThrottled.current.add(scheme.id);
    window.setTimeout(() => prefetchThrottled.current.delete(scheme.id), 1500);
    const token = await accessToken();
    if (!token) return;
    try {
      const detail = await getSchemeDetail(token, scheme.id);
      const preferred = detail.versions.find((item) => item.status === "draft") ?? detail.versions.find((item) => item.status === "active") ?? detail.versions[0];
      if (preferred) await getVersionDetail(token, preferred.id);
    } catch { /* prefetch is best-effort */ }
  }, [getSchemeDetail, getVersionDetail]);

  useEffect(() => {
    setLiveReference(initialData.reference);
    return () => { liveSyncAbort.current?.abort(); };
  }, [companyKey, initialData.reference]);

  const loadSavedReference = useCallback(async () => {
    if (liveReference) return liveReference;
    const token = await accessToken();
    if (!token) return null;
    const reference = await apiRequest<ReferenceData>(token, `/api/companies/${company.id}/rulebook/reference-data`);
    setLiveReference(reference);
    return reference;
  }, [company.id, liveReference]);

  const readLiveTallyReference = useCallback(async () => {
    const token = await accessToken();
    if (!token) throw new Error("Your session is unavailable.");
    liveSyncAbort.current?.abort();
    const abort = new AbortController();
    liveSyncAbort.current = abort;
    setRefreshingReference(true);
    setError(null);
    try {
      const requested = await apiRequest<{ syncRun: MasterSyncRun }>(token, `/api/companies/${company.id}/sync/masters`, {
        method: "POST",
        headers: { "Idempotency-Key": liveSyncKey() },
        signal: abort.signal,
      });
      let run = requested.syncRun;
      const deadline = Date.now() + 90_000;
      let delay = 1_000;
      while ((run.status === "queued" || run.status === "running") && !abort.signal.aborted) {
        if (Date.now() >= deadline) throw new Error("Tally took too long to return the latest information.");
        await new Promise<void>((resolve, reject) => {
          const t = window.setTimeout(resolve, delay);
          abort.signal.addEventListener("abort", () => { window.clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
        });
        if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
        delay = Math.min(5_000, Math.floor(delay * 1.5 + Math.random() * 300));
        run = (await apiRequest<{ syncRun: MasterSyncRun }>(token, `/api/companies/${company.id}/sync/runs/${run.id}`, { signal: abort.signal })).syncRun;
      }
      if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (run.status !== "completed") throw new Error(run.error_summary || "Tally could not return the latest information.");
      const reference = await apiRequest<ReferenceData>(token, `/api/companies/${company.id}/rulebook/reference-data`, { signal: abort.signal });
      if (reference.masterSync?.status !== "current") setError("Tally sync completed but data is still stale. Please refresh again.");
      setLiveReference(reference);
      return reference;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return null;
      throw cause;
    } finally {
      if (liveSyncAbort.current === abort) liveSyncAbort.current = null;
      setRefreshingReference(false);
    }
  }, [company.id, setError]);

  const load = useCallback(async (preferred?: RulebookSelection) => {
    const token = await accessToken(); if (!token) return;
    setLoading(true);
    try {
      const hasPreferred = Boolean(preferred?.schemeId || preferred?.versionId);
      const [schemes, savedRef] = await Promise.all([
        apiRequest<{ schemes: Scheme[] }>(token, `/api/companies/${company.id}/schemes`),
        loadSavedReference().catch(() => null),
      ]);
      setRulebook((current) => ({ ...current, schemes: schemes.schemes }));
      loadedTabs.current.add("schemes");
      if (savedRef && !liveReference) setLiveReference(savedRef);
      const schemeId = preferred?.schemeId ?? selectedSchemeId.current;
      const defaultScheme = (schemeId ? schemes.schemes.find((scheme) => scheme.id === schemeId) : null) ?? schemes.schemes.find((scheme) => scheme.status === "active") ?? schemes.schemes[0] ?? null;
      if (defaultScheme) {
        const detail = await getSchemeDetail(token, defaultScheme.id, hasPreferred);
        setSelected(detail);
        selectedSchemeId.current = detail.scheme.id;
        const versionId = preferred?.versionId ?? selectedVersionId.current;
        const defaultVersion = (versionId ? detail.versions.find((item) => item.id === versionId) : null) ?? detail.versions.find((item) => item.status === "draft") ?? detail.versions.find((item) => item.status === "active") ?? detail.versions[0] ?? null;
        if (defaultVersion) { selectedVersionId.current = defaultVersion.id; setVersion(await getVersionDetail(token, defaultVersion.id, hasPreferred)); }
        else { selectedVersionId.current = null; setVersion(null); }
      } else {
        setSelected(null);
        setVersion(null);
        selectedSchemeId.current = null;
        selectedVersionId.current = null;
      }
    } catch (cause) { setError(userFacingError(cause, "Could not load Rulebook.")); }
    finally { setLoading(false); }
  }, [company.id, getSchemeDetail, getVersionDetail, loadSavedReference, liveReference, setError]);
  useEffect(() => { setSelected(null); setVersion(null); setRuleSearch(""); selectedSchemeId.current = null; selectedVersionId.current = null; schemeDetailCache.current.clear(); versionDetailCache.current.clear(); loadedTabs.current = new Set(); void load(); }, [companyKey, load]);

  const loadTab = useCallback(async (nextTab: typeof tab, force = false) => {
    if (nextTab === "schemes" || nextTab === "management" || (!force && loadedTabs.current.has(nextTab))) return;
    const token = await accessToken();
    if (!token) return;
    setTabLoading(true);
    try {
      if (nextTab === "calendar") {
        const response = await apiRequest<{ calendars: Calendar[] }>(token, `/api/companies/${company.id}/calendars`);
        setRulebook((current) => ({ ...current, calendars: response.calendars }));
      } else if (nextTab === "contacts") {
        const response = await apiRequest<{ contacts: Contact[] }>(token, `/api/companies/${company.id}/contacts`);
        setRulebook((current) => ({ ...current, contacts: response.contacts }));
      }
      loadedTabs.current.add(nextTab);
    } catch (cause) {
      setError(userFacingError(cause, "Could not load this Rulebook section."));
    } finally {
      setTabLoading(false);
    }
  }, [company.id, setError]);

  function selectTab(nextTab: typeof tab) {
    setTab(nextTab);
    void loadTab(nextTab);
  }

  const refreshOpenVersion = useCallback(async () => {
    if (!version) return;
    const token = await accessToken();
    if (!token) return;
    setVersion(await getVersionDetail(token, version.version.id, true));
  }, [getVersionDetail, version?.version.id]);

  const DraftSetupDrawer = useCallback(({ open, onClose, detail, reference, onError }: { open: boolean; onClose: () => void; detail: VersionDetail | null; reference: ReferenceData | null; onSaved: (message: string) => Promise<void>; onError: (message: string | null) => void }) => <GuidedDraftSetupDrawer open={open} onClose={onClose} detail={detail} reference={reference} refreshingReference={refreshingReference} onRefreshReference={async () => { try { await readLiveTallyReference(); } catch (cause) { onError(userFacingError(cause, "Could not read the latest customers and products from Tally.")); } }} onError={onError} onSaved={async (message) => { setActivationValidation(null); setNotice(message); await refreshOpenVersion(); }} />, [readLiveTallyReference, refreshOpenVersion, refreshingReference, setNotice]);
  const VersionSummary = useCallback(({ detail, onEditTerms, onDraftSetup, onValidate, onActivate }: { detail: VersionDetail; onEditTerms: () => void; onDraftSetup: () => void; onValidate: () => void; onActivate: () => void }) => <GuidedVersionSummary detail={detail} validation={activationValidation} onEditTerms={onEditTerms} onDraftSetup={onDraftSetup} onValidate={onValidate} onActivate={onActivate} />, [activationValidation]);

  async function selectScheme(scheme: Scheme) {
    if (selectingScheme) return;
    const token = await accessToken(); if (!token) return;
    setSelectingScheme(true);
    try { setActivationValidation(null); selectedSchemeId.current = scheme.id; selectedVersionId.current = null; const detail = await getSchemeDetail(token, scheme.id); setSelected(detail); const preferredVersion = detail.versions.find((item) => item.status === "draft") ?? detail.versions.find((item) => item.status === "active") ?? detail.versions[0] ?? null; if (preferredVersion) { selectedVersionId.current = preferredVersion.id; setVersion(await getVersionDetail(token, preferredVersion.id)); } else { setVersion(null); setRuleEditorModeState("complete"); } } catch (cause) { setError(userFacingError(cause, "Could not load this rule.")); } finally { setSelectingScheme(false); }
  }
  async function setRuleEditorMode(mode: "new" | "complete" | "update" | null) {
    if (mode !== "update") { setRuleEditorModeState(mode); return; }
    const targetVersion = selected?.versions.find((item) => item.status === "draft") ?? selected?.versions.find((item) => item.status === "active");
    if (!targetVersion) { setError("Complete the first rule before preparing an update."); return; }
    if (version?.version.id !== targetVersion.id) {
      const token = await accessToken(); if (!token) return;
      try {
        selectedVersionId.current = targetVersion.id;
        setVersion(await getVersionDetail(token, targetVersion.id));
      } catch (cause) { setError(userFacingError(cause, "Could not load the current rule.")); return; }
    }
    setRuleEditorModeState("update");
  }
  async function runVersionAction(action: "validate" | "activate") {
    if (!version || versionActionBusy) return;
    const token = await accessToken();
    if (!token) return;
    setVersionActionBusy(action);
    setError(null);
    try {
      const response = await apiRequest<{ validation?: ActivationValidation }>(token, `/api/companies/${company.id}/scheme-versions/${version.version.id}/${action}`, { method: "POST", headers: { "Idempotency-Key": globalThis.crypto?.randomUUID?.() ?? `meenakshi-${Date.now()}` } });
      if (action === "validate") {
        const validation = response.validation ?? null;
        setActivationValidation(validation);
        setNotice(validation?.valid ? "This pending update passed the rule check." : "The rule check found items to complete before applying this update.");
        return;
      }
      setActivationValidation({ valid: true });
      setNotice("Your changes are now active.");
      await load();
    } catch (cause) {
      const validation = activationValidationFromError(cause);
      if (validation) {
        setActivationValidation(validation);
        setNotice("Activation is protected until the listed items are complete.");
        return;
      }
      // surface DB 23505/409 detail instead of generic
      if (cause instanceof ApiError && cause.body && typeof cause.body === "object" && typeof (cause.body as Record<string, unknown>).error === "string") {
        setError(String((cause.body as Record<string, unknown>).error));
        return;
      }
      setError(userFacingError(cause, "This Rulebook action could not be completed."));
    } finally {
      setVersionActionBusy(null);
    }
  }

  const primaryAction = tab === "schemes" ? <Button onClick={() => setRuleEditorMode("new")}><Plus size={16} />New rule</Button> : tab === "calendar" ? (rulebook.calendars.length ? null : <IconButton label="Set up business calendar" onClick={() => setCalendarOpen(true)}><CalendarPlus size={17} /></IconButton>) : tab === "contacts" ? <IconButton label="Add customer contact" onClick={() => void loadSavedReference().then(() => setContactOpen(true)).catch((cause) => setError(userFacingError(cause, "Could not load customers from Tally.")))}><UserPlus size={17} /></IconButton> : null;
  const ruleQuery = ruleSearch.trim().toLowerCase();
  const visibleSchemes = useMemo(() => rulebook.schemes.filter((scheme) => !ruleQuery || `${scheme.name} ${scheme.description ?? ""}`.toLowerCase().includes(ruleQuery)), [rulebook.schemes, ruleQuery]);
  const activeVersion = selected?.versions.find((item) => item.status === "active") ?? null;
  const draftCount = selected?.versions.filter((item) => item.status === "draft").length ?? 0;
  if (!isAdministrator) return <><WorkspacePageHeader eyebrow="Restricted" title="Rulebook" detail="Rulebook administration is available only to Administrators." /><EmptyState title="Administrator access required" detail="Finance Approvers can continue reviewing proposals, Credit Notes, Messages, and Tally readiness." /></>;
  return <><WorkspacePageHeader eyebrow="Administrator workspace" title="Rulebook" detail="Each policy has one current rule. Edit it safely, review the changes, then apply them." action={<>{guidance}{primaryAction}</>} />
    <div className="rulebook-tabs" role="tablist">{[["schemes", "Rules", BookOpen], ["calendar", "Calendar", CalendarDays], ["contacts", "Contacts & consent", ContactRound], ["management", "Administration", Settings2]].map(([value, label, Icon]) => { const TabIcon = Icon as typeof BookOpen; return <button key={String(value)} role="tab" aria-selected={tab === value} className={tab === value ? "selected" : ""} onClick={() => selectTab(value as typeof tab)}><TabIcon size={16} />{String(label)}</button>; })}</div>
    {loading ? <Skeleton lines={6} /> : tabLoading ? <Skeleton lines={4} /> : tab === "schemes" ? <div className={studio.studio}>
      <div className={studio.layout}>
        <aside className={studio.rail} aria-label="Discount rules"><div className={studio.railHeader}><strong>Your rules</strong><span>{rulebook.schemes.length}</span></div>{rulebook.schemes.length > 5 && <label className={studio.search}><Search size={16} /><input value={ruleSearch} onChange={(event) => setRuleSearch(event.target.value)} placeholder="Find a rule" /></label>}<div className={studio.ruleList}>{visibleSchemes.length ? visibleSchemes.map((scheme) => { const cached = schemeDetailCache.current.has(scheme.id); return <button key={scheme.id} className={studio.ruleItem} data-selected={selected?.scheme.id === scheme.id} data-type={scheme.schemeType} onMouseEnter={() => { if (!cached) void prefetchScheme(scheme); }} onFocus={() => { if (!cached) void prefetchScheme(scheme); }} onClick={() => void selectScheme(scheme)}><span className={studio.ruleIcon}>{scheme.schemeType === "cd" ? <BadgePercent size={18} /> : <Layers3 size={18} />}</span><span className={studio.ruleCopy}><strong>{scheme.name}</strong><small>{scheme.schemeType === "cd" ? "Cash Discount" : "Turnover Discount"}</small></span><span className={studio.ruleMeta}><StatusBadge status={scheme.status} /></span></button>; }) : <p className={studio.railEmpty}>No rules match this search.</p>}</div></aside>
        <section className={studio.canvas}>{selected ? <>
          <header className={studio.hero}>
            <div className={studio.heroIdentity}>
              <span className={studio.typeLabel}>{selected.scheme.schemeType === "cd" ? <BadgePercent size={13} /> : <Layers3 size={13} />}{selected.scheme.schemeType === "cd" ? "Cash Discount policy" : "Turnover Discount policy"}</span>
              <h2>{selected.scheme.name}</h2>
              <p className={studio.heroDescription}>{selected.scheme.description || "Used to calculate customer discount eligibility."}</p>
              <div className={studio.currentStrip}><StatusBadge status={selected.scheme.status} />{activeVersion ? <span><strong>Current:</strong> {activeVersion.effectiveFrom} {activeVersion.effectiveTo ? `— ${activeVersion.effectiveTo}` : "onwards"}</span> : <span>Setup is not active yet</span>}{draftCount > 0 && <span className={studio.workingCopy}>Pending update</span>}</div>
            </div>
            <div className={studio.heroActions}>{activeVersion && <Button onClick={() => setRuleEditorMode("update")}><Pencil size={14} />{draftCount ? "Continue editing" : "Edit rule"}</Button>}</div>
          </header>
          <div className={studio.body}>
            {!selected.versions.length && <EmptyState title="Rule setup is incomplete" detail="Complete the business terms before using this rule." />}
            {version && <VersionSummary detail={version} onEditTerms={() => void setRuleEditorMode("update")} onDraftSetup={() => setDraftSetupOpen(true)} onValidate={() => void runVersionAction("validate")} onActivate={() => void runVersionAction("activate")} />}
            {selected.versions.filter((item) => item.status !== "draft").length > 1 && <details className={studio.history}>
              <summary>Change history <span>{selected.versions.filter((item) => item.status !== "draft").length} saved states</span></summary>
              <div>{selected.versions.filter((item) => item.status !== "draft").map((item) => <article key={item.id}><span>{item.status === "active" ? "Current" : "Past"}</span><strong>{item.effectiveFrom} {item.effectiveTo ? `— ${item.effectiveTo}` : "onwards"}</strong></article>)}</div>
            </details>}
          </div>
        </> : <div className={studio.emptyCanvas}><div><span><BookOpen size={21} /></span><h3>Choose a rule to inspect</h3><p>Review its current terms, prepare an update, or continue a pending update.</p></div></div>}</section>
      </div>
    </div> : tab === "calendar" ? <CalendarList calendars={rulebook.calendars} onChanged={async (message) => { setNotice(message); await load(); }} onError={setError} /> : tab === "contacts" ? <ContactsList contacts={rulebook.contacts} /> : management}
    <RuleEditor open={ruleEditorMode !== null} scheme={ruleEditorMode === "new" ? null : selected?.scheme ?? null} source={ruleEditorMode === "update" ? version : null} reference={data.reference} onClose={() => setRuleEditorMode(null)} onSaved={async (created) => { const wasUpdate = ruleEditorMode === "update"; setRuleEditorMode(null); setNotice(wasUpdate ? "Rule terms saved. Next: update customer groups and eligibility." : "Rule created. Next: choose customers and eligibility."); await load(created); setDraftSetupOpen(true); }} onError={setError} /><DraftSetupDrawer open={draftSetupOpen} onClose={() => setDraftSetupOpen(false)} detail={version} reference={data.reference} onSaved={async (message) => { setNotice(message); await load({ schemeId: selected?.scheme.id, versionId: version?.version.id }); }} onError={setError} /><CalendarDrawer open={calendarOpen} onClose={() => setCalendarOpen(false)} onSaved={async () => { setCalendarOpen(false); setNotice("Business calendar created."); await load(); }} onError={setError} /><ContactDrawer open={contactOpen} onClose={() => setContactOpen(false)} reference={data.reference} onSaved={async () => { setContactOpen(false); setNotice("Controlled customer contact added."); await load(); }} onError={setError} />
  </>;
}

const weekdayNames: Record<number, string> = { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday" };

function calendarDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function CalendarList({ calendars, onChanged, onError }: { calendars: Calendar[]; onChanged: (message: string) => Promise<void>; onError: (message: string | null) => void }) {
  const { company } = useCompany();
  const [busyHolidayId, setBusyHolidayId] = useState<string | null>(null);
  const [holidayEditor, setHolidayEditor] = useState<{ calendar: Calendar; holiday?: Calendar["holidays"][number] } | null>(null);

  async function saveHoliday(form: HTMLFormElement) {
    if (!holidayEditor) return;
    const token = await accessToken(); if (!token) return;
    const fields = new FormData(form);
    const holiday = holidayEditor.holiday;
    setBusyHolidayId(holiday?.id ?? "new");
    try {
      await apiRequest(token, `/api/companies/${company.id}/calendars/${holidayEditor.calendar.id}/holidays`, holiday
        ? { method: "PATCH", body: jsonBody({ holidayId: holiday.id, holidayDate: fields.get("date"), name: fields.get("name") }) }
        : { method: "POST", body: jsonBody({ holidayDate: fields.get("date"), name: fields.get("name"), isActive: true }) });
      setHolidayEditor(null);
      await onChanged(holiday ? "Holiday updated." : "Holiday added to the business calendar.");
    } catch (cause) { onError(userFacingError(cause, holiday ? "Could not edit this holiday." : "Could not add this holiday.")); }
    finally { setBusyHolidayId(null); }
  }

  async function setHoliday(calendar: Calendar, holidayId: string, isActive: boolean) {
    const token = await accessToken(); if (!token) return;
    setBusyHolidayId(holidayId);
    try {
      await apiRequest(token, `/api/companies/${company.id}/calendars/${calendar.id}/holidays`, { method: "PATCH", body: jsonBody({ holidayId, isActive }) });
      await onChanged(isActive ? "Holiday restored." : "Holiday removed from discount calculations.");
    } catch (cause) { onError(userFacingError(cause, "Could not update this holiday.")); }
    finally { setBusyHolidayId(null); }
  }

  if (!calendars.length) return <Card><EmptyState title="Business calendar not set up" detail="Create the common calendar used by every connected Tally company." /></Card>;
  return <><div className="calendar-stack">{calendars.map((calendar) => {
    const holidays = [...calendar.holidays].sort((left, right) => left.holiday_date.localeCompare(right.holiday_date));
    const activeCount = holidays.filter((holiday) => holiday.is_active).length;
    return <Card className="calendar-card" key={calendar.id}>
      <div className="card-title"><div><p className="eyebrow">Business calendar</p><h2>{calendar.name}</h2><p className="muted-copy">Used automatically for every connected Tally company.</p></div><div className="table-actions"><StatusBadge status={calendar.isActive ? "ready" : "suppressed"} /><Button className="button-secondary" onClick={() => setHolidayEditor({ calendar })}><Plus size={16} />Add holiday</Button></div></div>
      <section className="calendar-weekly"><div><h3>Weekly non-working days</h3><p>These weekdays are excluded from working-day calculations.</p></div><div className="weekday-summary">{calendar.nonWorkingWeekdays.length ? calendar.nonWorkingWeekdays.map((day) => <span key={day}>{weekdayNames[day] ?? `Day ${day}`}</span>) : <span>No weekly day excluded</span>}</div></section>
      <section className="calendar-holidays"><div className="calendar-section-heading"><div><h3>Holidays</h3><p>{activeCount} day{activeCount === 1 ? "" : "s"} currently excluded from working-day calculations.</p></div></div>
        {holidays.length ? <div className="simple-list calendar-holiday-list">{holidays.map((holiday) => <article key={holiday.id} className={holiday.is_active ? "" : "is-inactive"}><div><strong>{holiday.name}</strong><p>{calendarDate(holiday.holiday_date)}</p>{!holiday.is_active && <small>Removed from calculations</small>}</div><div className="table-actions"><IconButton label={`Edit ${holiday.name}`} onClick={() => setHolidayEditor({ calendar, holiday })}><Pencil size={16} /></IconButton>{holiday.is_active ? <IconButton label={`Remove ${holiday.name}`} disabled={busyHolidayId === holiday.id} onClick={() => void setHoliday(calendar, holiday.id, false)}><Trash2 size={16} /></IconButton> : <IconButton label={`Restore ${holiday.name}`} disabled={busyHolidayId === holiday.id} onClick={() => void setHoliday(calendar, holiday.id, true)}><RotateCcw size={16} /></IconButton>}</div></article>)}</div> : <EmptyState title="No holidays added" detail="Use Add holiday to record the first one." />}
      </section>
    </Card>;
  })}</div><Dialog open={Boolean(holidayEditor)} onClose={() => setHolidayEditor(null)} title={holidayEditor?.holiday ? "Edit holiday" : "Add holiday"} description={holidayEditor?.holiday ? "Update the holiday name or date used in working-day calculations." : "Add a non-working holiday to the common Meenakshi calendar."}><form key={holidayEditor?.holiday?.id ?? "new"} className="form-stack" onSubmit={(event) => { event.preventDefault(); void saveHoliday(event.currentTarget); }}><label>Holiday name<input name="name" required defaultValue={holidayEditor?.holiday?.name ?? ""} placeholder="e.g. Pongal" /></label><label>Holiday date<input name="date" type="date" required defaultValue={holidayEditor?.holiday?.holiday_date ?? ""} /></label><Button type="submit" disabled={Boolean(busyHolidayId)}>{holidayEditor?.holiday ? "Save changes" : "Add holiday"}</Button></form></Dialog></>;
}
function ContactsList({ contacts }: { contacts: Contact[] }) { return <Card>{contacts.length ? <div className="simple-list">{contacts.map((contact) => <article key={contact.id}><div><strong>{contact.customer?.ledgerName ?? "Customer record"}</strong><p>{contact.contact_name || "Controlled contact"} · {safePhone(contact.phone_e164)}</p><small>{contact.is_primary ? "Primary" : "Secondary"} · {contact.is_active ? "Active" : "Inactive"}</small></div><StatusBadge status={contact.is_active ? "ready" : "suppressed"} /></article>)}</div> : <EmptyState title="No controlled contacts" detail="Add consent-aware contacts after a master synchronization provides the customer list." />}</Card>; }

function CreateSchemeDrawer({ open, onClose, onSaved, onError }: { open: boolean; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string | null) => void }) { const { company } = useCompany(); async function submit(form: HTMLFormElement) { const token = await accessToken(); if (!token) return; const fields = new FormData(form); try { await apiRequest(token, `/api/companies/${company.id}/schemes`, { method: "POST", body: jsonBody({ schemeType: fields.get("type"), code: fields.get("code"), name: fields.get("name"), description: fields.get("description") || null }) }); await onSaved(); } catch (cause) { onError(userFacingError(cause, "Could not create this rule.")); } } return <Drawer open={open} onClose={onClose} title="Create a new rule" description="Use this only for a new finance rule. It does not change the rule currently in use. Review the new rule before making it active."><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}><label>Rule type<select name="type" defaultValue="cd"><option value="cd">Cash Discount</option><option value="tod">Turnover Discount</option></select></label><label>Reference code<input name="code" required placeholder="CD_STANDARD" pattern="[A-Za-z][A-Za-z0-9_-]+" /></label><label>Rule name<input name="name" required placeholder="Cash Discount FY 2026" /></label><label>Description<textarea name="description" placeholder="Optional description" /></label><Button type="submit">Create new rule</Button></form></Drawer>; }

function CreateVersionDrawer({ open, onClose, scheme, reference, onSaved, onError }: { open: boolean; onClose: () => void; scheme: Scheme | null; reference: ReferenceData | null; onSaved: () => Promise<void>; onError: (message: string | null) => void }) { const { company } = useCompany(); async function submit(form: HTMLFormElement) { if (!scheme) return; const token = await accessToken(); if (!token) return; const fields = new FormData(form); const shared = { effectiveFrom: fields.get("effectiveFrom"), effectiveTo: fields.get("effectiveTo") || null, creditNoteVoucherTypeId: fields.get("voucherType"), discountLedgerId: fields.get("ledger"), roundingMethod: fields.get("roundingMethod"), roundingScale: Number(fields.get("roundingScale")), requiresApproval: true }; const schemeFields = scheme.schemeType === "cd" ? { discountPercentage: fields.get("percentage"), allowedWorkingDays: Number(fields.get("days")) } : { periodMonths: Number(fields.get("periodMonths")), periodAnchorDate: fields.get("anchor") }; try { await apiRequest(token, `/api/companies/${company.id}/schemes/${scheme.id}/versions`, { method: "POST", body: jsonBody({ ...shared, ...schemeFields }) }); await onSaved(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not create draft version."); } } return <Drawer open={open && Boolean(scheme)} onClose={onClose} title="Create draft version" description="The common Meenakshi business calendar is applied automatically." width="wide">{scheme && <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}><div className="form-grid"><label>Effective from<input name="effectiveFrom" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label><label>Effective to<input name="effectiveTo" type="date" /></label><label>Credit Note voucher type<select name="voucherType" required><option value="">Select current master</option>{reference?.masters.voucherTypes.filter((item) => item.is_available && item.is_credit_note_type).map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select></label><label>Discount ledger<select name="ledger" required><option value="">Select current master</option>{reference?.masters.ledgers.filter((item) => item.is_available && String(item.gst_applicability).toLowerCase() === "not applicable").map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select></label><label>Rounding<select name="roundingMethod" defaultValue="half_up"><option value="half_up">Half up</option><option value="half_even">Half even</option><option value="truncate">Truncate</option></select></label><label>Rounding scale<input name="roundingScale" type="number" min="0" max="4" defaultValue="2" required /></label>{scheme.schemeType === "cd" ? <><label>Discount percentage<input name="percentage" required inputMode="decimal" /></label><label>Working days<input name="days" type="number" min="0" max="366" defaultValue="4" required /></label></> : <><label>Period months<input name="periodMonths" type="number" min="1" max="36" defaultValue="1" required /></label><label>Period anchor<input name="anchor" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label></>}</div>{!reference && <InlineMessage tone="info">Master synchronization must be current before a version can be created.</InlineMessage>}<Button type="submit" disabled={!reference}>Create draft version</Button></form>}</Drawer>; }

function DraftSetupDrawer({ open, onClose, detail, reference, onSaved, onError }: { open: boolean; onClose: () => void; detail: VersionDetail | null; reference: ReferenceData | null; onSaved: (message: string) => Promise<void>; onError: (message: string | null) => void }) { const { company } = useCompany(); async function save(path: string, body: Record<string, unknown>, message: string) { if (!detail) return; const token = await accessToken(); if (!token) return; try { await apiRequest(token, `/api/companies/${company.id}/scheme-versions/${detail.version.id}/${path}`, { method: "POST", body: jsonBody(body) }); await onSaved(message); } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not update draft configuration."); } } if (!detail) return null; const tod = detail.version.schemeType === "tod"; return <Drawer open={open} onClose={onClose} title={`Draft setup · version ${detail.version.versionNumber}`} description="Edit only the current draft. Activation validation remains separate."><div className="drawer-stack"><section><h3>Customer group coverage</h3><form className="inline-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void save("groups", { customerGroupId: form.get("group") }, "Customer group added to draft."); }}><select name="group" required><option value="">Select customer group</option>{reference?.masters.customerGroups.filter((item) => item.is_available).map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select><Button type="submit">Add</Button></form></section>{tod && <><section><h3>Eligible stock</h3><form className="inline-form" onSubmit={(event) => { event.preventDefault(); const raw = String(new FormData(event.currentTarget).get("stock") || "").split(":"); void save("stocks", { kind: raw[0], id: raw[1] }, "Stock eligibility added to draft."); }}><select name="stock" required><option value="">Select stock target</option>{reference?.masters.stockItems.filter((item) => item.is_available).map((item) => <option key={item.id} value={`stockItem:${item.id}`}>Item · {labelFor(item)}</option>)}{reference?.masters.stockGroups.filter((item) => item.is_available).map((item) => <option key={item.id} value={`stockGroup:${item.id}`}>Group · {labelFor(item)}</option>)}</select><Button type="submit">Add</Button></form></section><section><h3>Unit conversion</h3><form className="form-stack compact" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void save("conversions", { sourceUomId: form.get("uom"), tonnesPerSourceUnit: form.get("factor"), isBuiltin: form.get("builtin") === "true" }, "UOM conversion saved to draft."); }}><select name="uom" required><option value="">Select UOM</option>{reference?.masters.units.filter((item) => item.is_available).map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select><input name="factor" required placeholder="Tonnes per source unit" /><select name="builtin"><option value="true">Built-in MT/MTS/KG</option><option value="false">Client-approved conversion</option></select><Button type="submit">Save conversion</Button></form></section><section><h3>Quantity tier</h3><form className="inline-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void save("tiers", { minimumTonnes: form.get("tonnes"), discountPercentage: form.get("percentage") }, "TOD tier saved to draft."); }}><input name="tonnes" required placeholder="Minimum tonnes" /><input name="percentage" required placeholder="Discount %" /><Button type="submit">Save tier</Button></form></section></>}<p className="muted-copy">Current setup: {detail.configuration.customerGroups.length} groups · {detail.configuration.stockItems.length + detail.configuration.stockGroups.length} stock targets · {detail.configuration.conversions.length} conversions · {detail.configuration.tiers.length} tiers.</p></div></Drawer>; }

function CalendarDrawer({ open, onClose, onSaved, onError }: { open: boolean; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string | null) => void }) { const { company } = useCompany(); async function submit(form: HTMLFormElement) { const token = await accessToken(); if (!token) return; const fields = new FormData(form); const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((day) => fields.get(`day-${day}`)); try { await apiRequest(token, `/api/companies/${company.id}/calendars`, { method: "POST", body: jsonBody({ name: fields.get("name"), nonWorkingWeekdays: weekdays }) }); await onSaved(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not create the business calendar."); } } return <Drawer open={open} onClose={onClose} title="Set up business calendar" description="This calendar will be used automatically for every connected Tally company."><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}><label>Name<input name="name" required defaultValue="Meenakshi business calendar" /></label><fieldset className="weekday-fields"><legend>Non-working weekdays</legend>{[[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[7,"Sun"]].map(([day, label]) => <label key={String(day)}><input type="checkbox" name={`day-${day}`} defaultChecked={day === 7} />{String(label)}</label>)}</fieldset><Button type="submit">Create business calendar</Button></form></Drawer>; }

function PolicyDrawer({ open, onClose, onSaved, onError }: { open: boolean; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string | null) => void }) { const { company } = useCompany(); async function submit(form: HTMLFormElement) { const token = await accessToken(); if (!token) return; const fields = new FormData(form); try { await apiRequest(token, `/api/companies/${company.id}/credit-note-tax-policies`, { method: "POST", body: jsonBody({ gstTreatment: "commercial_no_gst", effectiveFrom: fields.get("from"), effectiveTo: fields.get("to") || null, approvalReference: fields.get("reference"), approverName: fields.get("approver"), approvedAt: new Date().toISOString(), notes: fields.get("notes") || null }) }); await onSaved(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not record policy evidence."); } } return <Drawer open={open} onClose={onClose} title="Record tax policy evidence" description="This records approved commercial no-GST treatment; it does not approve an individual Credit Note."><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}><label>Effective from<input type="date" name="from" required /></label><label>Effective to<input type="date" name="to" /></label><label>Approval reference<input name="reference" required /></label><label>Approver name<input name="approver" required /></label><label>Notes<textarea name="notes" /></label><Button type="submit">Record policy evidence</Button></form></Drawer>; }

function ContactDrawer({ open, onClose, reference, onSaved, onError }: { open: boolean; onClose: () => void; reference: ReferenceData | null; onSaved: () => Promise<void>; onError: (message: string | null) => void }) { const { company } = useCompany(); async function submit(form: HTMLFormElement) { const token = await accessToken(); if (!token) return; const fields = new FormData(form); try { await apiRequest(token, `/api/companies/${company.id}/contacts`, { method: "POST", body: jsonBody({ customerId: fields.get("customer"), phoneE164: fields.get("phone"), contactName: fields.get("name") || null, isPrimary: true }) }); await onSaved(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not add controlled contact."); } } return <Drawer open={open} onClose={onClose} title="Add controlled contact" description="A phone number is stored in the existing controlled contact workflow; consent is managed separately."><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}><label>Customer<select name="customer" required><option value="">Select synced customer</option>{reference?.masters.customers.filter((item) => item.is_available).map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select></label><label>Contact name<input name="name" /></label><label>Phone in E.164 format<input name="phone" required placeholder="+919876543210" /></label><Button type="submit" disabled={!reference}>Add controlled contact</Button></form></Drawer>; }
