"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Archive, BadgePercent, BookOpen, CalendarDays, ContactRound, Layers3, Pause, Pencil, Plus, Search, Settings2, Trash2, UserPlus } from "lucide-react";

import { ApiError, apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { WorkspacePageHeader } from "./app-shell";
import type { Calendar, Contact, ReferenceData, Scheme, SchemeDetail, Version, VersionDetail } from "./types";
import { Button, Card, Dialog, Drawer, EmptyState, Skeleton, StatusBadge, labelFor, safePhone } from "./ui";
import type { PageProps } from "./workspace";
import { ContactConsentDrawer } from "./contact-consent-drawer";
import { GuidedDraftSetupDrawer } from "./guided-draft-setup";
import { HolidayCalendar } from "./holiday-calendar";
import { GuidedVersionSummary, type ActivationValidation } from "./guided-version-summary";
import { RuleEditor } from "./rule-editor";
import { RulebookGuidance } from "./rulebook-guidance";
import { accessToken } from "./workspace";
import studio from "./rulebook-studio.module.css";

type RulebookData = { schemes: Scheme[]; calendars: Calendar[]; contacts: Contact[] };
type RulebookSelection = { schemeId?: string | null; versionId?: string | null };
type RulebookOverview = { schemes: Scheme[]; selected: SchemeDetail | null; versionDetail: VersionDetail | null };
type MasterSyncRun = { id: string; status: string; error_summary: string | null };
const blankData: RulebookData = { schemes: [], calendars: [], contacts: [] };
const liveSyncKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-live-${Date.now()}`;
const CACHE_TTL_MS = 30_000;
type CacheEntry<V> = { value: Promise<V>; expiresAt: number };

const TABS = [
  { id: "schemes", label: "Rules", icon: BookOpen },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "contacts", label: "Contacts & consent", icon: ContactRound },
  { id: "management", label: "Rule status", icon: Settings2 },
] as const;
type RulebookTab = (typeof TABS)[number]["id"];
// Hidden for now: "Contacts & consent". WhatsApp is sent manually to the number
// entered at send time, which records its own opt-in. Remove from this list to restore.
const HIDDEN_TABS: ReadonlySet<RulebookTab> = new Set(["contacts"]);
const VISIBLE_TABS = TABS.filter((item) => !HIDDEN_TABS.has(item.id));

function schemeTypeName(scheme: Scheme) {
  return scheme.schemeType === "cd" ? "Cash Discount" : "Turnover Discount";
}

function shortDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function coversDate(version: Version, date: string) {
  return version.effectiveFrom <= date && (!version.effectiveTo || version.effectiveTo >= date);
}

function operationalStatus(scheme: Scheme, versions?: Version[]) {
  if (scheme.status !== "active") return scheme.status;
  // A rule past its end date is still shown as active: its dates show the period.
  if (!versions) return scheme.operationalStatus === "expired" ? "active" : scheme.operationalStatus ?? scheme.status;
  const applied = versions.filter((item) => item.status === "active");
  const today = new Date().toISOString().slice(0, 10);
  if (applied.some((item) => coversDate(item, today))) return "active";
  if (applied.some((item) => item.effectiveFrom > today)) return "scheduled";
  return applied.length ? "active" : "setup_incomplete";
}

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

export function RulebookPage({ data: initialData, isAdministrator, setError, setNotice }: PageProps) {
  const { company, companyKey } = useCompany();
  const [tab, setTab] = useState<RulebookTab>("schemes");
  const [rulebook, setRulebook] = useState<RulebookData>(blankData);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<SchemeDetail | null>(null);
  const [version, setVersion] = useState<VersionDetail | null>(null);
  const [activationValidation, setActivationValidation] = useState<ActivationValidation | null>(null);
  const selectedSchemeId = useRef<string | null>(null);
  const selectedVersionId = useRef<string | null>(null);
  const schemeDetailCache = useRef(new Map<string, CacheEntry<SchemeDetail>>());
  const versionDetailCache = useRef(new Map<string, CacheEntry<VersionDetail>>());
  const loadedTabs = useRef(new Set<string>());
  const tabRefs = useRef<Partial<Record<RulebookTab, HTMLButtonElement | null>>>({});
  const [ruleSearch, setRuleSearch] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [ruleEditorMode, setRuleEditorModeState] = useState<"new" | "complete" | "update" | null>(null);
  const [draftSetupOpen, setDraftSetupOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [consentContactId, setConsentContactId] = useState<string | null>(null);
  const [liveReference, setLiveReference] = useState<ReferenceData | null>(initialData.reference);
  const liveReferenceRef = useRef<ReferenceData | null>(initialData.reference);
  const [refreshingReference, setRefreshingReference] = useState(false);
  const [tabLoading, setTabLoading] = useState(false);
  const [selectingScheme, setSelectingScheme] = useState(false);
  const [versionActionBusy, setVersionActionBusy] = useState<"validate" | "activate" | null>(null);
  const liveSyncAbort = useRef<AbortController | null>(null);
  const prefetchThrottled = useRef(new Set<string>());

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
    const cached = schemeDetailCache.current.get(`${company.id}:${scheme.id}`);
    if ((cached && cached.expiresAt > Date.now()) || prefetchThrottled.current.has(scheme.id)) return;
    prefetchThrottled.current.add(scheme.id);
    window.setTimeout(() => prefetchThrottled.current.delete(scheme.id), 1500);
    const token = await accessToken();
    if (!token) return;
    try {
      const detail = await getSchemeDetail(token, scheme.id);
      const preferred = detail.versions.find((item) => item.status === "draft") ?? detail.versions.find((item) => item.status === "active") ?? detail.versions[0];
      if (preferred) await getVersionDetail(token, preferred.id);
    } catch { /* prefetch is best-effort */ }
  }, [company.id, getSchemeDetail, getVersionDetail]);

  useEffect(() => {
    setLiveReference(initialData.reference);
    liveReferenceRef.current = initialData.reference;
    return () => { liveSyncAbort.current?.abort(); };
  }, [companyKey, initialData.reference]);

  const loadSavedReference = useCallback(async () => {
    if (liveReferenceRef.current) return liveReferenceRef.current;
    const token = await accessToken();
    if (!token) return null;
    const reference = await apiRequest<ReferenceData>(token, `/api/companies/${company.id}/rulebook/reference-data`);
    liveReferenceRef.current = reference;
    setLiveReference(reference);
    return reference;
  }, [company.id]);

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
      liveReferenceRef.current = reference;
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
      const query = new URLSearchParams();
      if (preferred?.schemeId) query.set("schemeId", preferred.schemeId);
      if (preferred?.versionId) query.set("versionId", preferred.versionId);
      const queryString = query.toString();
      const referenceRequest = loadSavedReference().catch(() => null);
      const overview = await apiRequest<RulebookOverview>(token, `/api/companies/${company.id}/rulebook/overview${queryString ? `?${queryString}` : ""}`);
      setRulebook((current) => ({ ...current, schemes: overview.schemes }));
      loadedTabs.current.add("schemes");
      void referenceRequest.then((savedRef) => {
        if (savedRef && !liveReferenceRef.current) {
          liveReferenceRef.current = savedRef;
          setLiveReference(savedRef);
        }
      });
      if (overview.selected) {
        setSelected(overview.selected);
        selectedSchemeId.current = overview.selected.scheme.id;
        schemeDetailCache.current.set(`${company.id}:${overview.selected.scheme.id}`, { value: Promise.resolve(overview.selected), expiresAt: Date.now() + CACHE_TTL_MS });
        if (overview.versionDetail) {
          setVersion(overview.versionDetail);
          selectedVersionId.current = overview.versionDetail.version.id;
          versionDetailCache.current.set(`${company.id}:${overview.versionDetail.version.id}`, { value: Promise.resolve(overview.versionDetail), expiresAt: Date.now() + CACHE_TTL_MS });
        } else { selectedVersionId.current = null; setVersion(null); }
      } else {
        setSelected(null);
        setVersion(null);
        selectedSchemeId.current = null;
        selectedVersionId.current = null;
      }
    } catch (cause) { setError(userFacingError(cause, "Could not load Rulebook.")); }
    finally { setLoading(false); setLoaded(true); }
  }, [company.id, loadSavedReference, setError]);
  useEffect(() => { setLoaded(false); setSelected(null); setVersion(null); setRuleSearch(""); setConsentContactId(null); setRulebook(blankData); selectedSchemeId.current = null; selectedVersionId.current = null; schemeDetailCache.current.clear(); versionDetailCache.current.clear(); loadedTabs.current = new Set(); void load(); }, [companyKey, load]);

  const loadTab = useCallback(async (nextTab: RulebookTab, force = false) => {
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

  function selectTab(nextTab: RulebookTab) {
    setTab(nextTab);
    void loadTab(nextTab);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = VISIBLE_TABS.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    const nextTab = VISIBLE_TABS[next].id;
    selectTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  const openVersionId = version?.version.id ?? null;
  const refreshOpenVersion = useCallback(async () => {
    if (!openVersionId) return;
    const token = await accessToken();
    if (!token) return;
    setVersion(await getVersionDetail(token, openVersionId, true));
  }, [getVersionDetail, openVersionId]);

  async function selectScheme(scheme: Scheme) {
    if (selectingScheme || selected?.scheme.id === scheme.id) return;
    const token = await accessToken(); if (!token) return;
    setSelectingScheme(true);
    setNotice(null);
    setError(null);
    setSelected(null);
    setVersion(null);
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
        const validationIssues = validation?.issues ?? [];
        const replaceableOverlap = selected !== null
          && selected.versions.some((item) => item.status === "active")
          && validationIssues.length > 0
          && validationIssues.every((issue) => issue.code === "customer_group_coverage_overlap")
          && rulebook.schemes.filter((item) => item.schemeType === selected.scheme.schemeType && item.status === "active").length === 1;
        setNotice(validation?.valid ? "This pending update passed the rule check." : replaceableOverlap ? "This update can replace the current active rule." : "The rule check found items to complete before applying this update.");
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

  function openAddContact() {
    void loadSavedReference().then(() => setContactOpen(true)).catch((cause) => setError(userFacingError(cause, "Could not load customers from Tally.")));
  }

  const ruleQuery = ruleSearch.trim().toLowerCase();
  const retiredCount = rulebook.schemes.filter((scheme) => scheme.status === "retired").length;
  const visibleSchemes = useMemo(() => rulebook.schemes.filter((scheme) => (showRetired || scheme.status !== "retired") && (!ruleQuery || `${scheme.name} ${scheme.code} ${scheme.description ?? ""}`.toLowerCase().includes(ruleQuery))), [rulebook.schemes, ruleQuery, showRetired]);
  const missingForActivation = useMemo(() => activationValidation?.valid === false ? (activationValidation.issues ?? []).map((issue) => issue.message ?? "More information is needed before this update can be applied.") : [], [activationValidation]);
  if (!isAdministrator) return <><WorkspacePageHeader eyebrow="Restricted" title="Rulebook" detail="Rulebook administration is available only to Administrators." /><EmptyState title="Administrator access required" detail="Finance Approvers can continue reviewing proposals, Credit Notes, Messages, and Tally readiness." /></>;

  const activeVersion = selected?.versions.find((item) => item.status === "active") ?? null;
  const draftVersion = selected?.versions.find((item) => item.status === "draft") ?? null;
  const selectedOperationalStatus = selected ? operationalStatus(selected.scheme, selected.versions) : null;
  const consentContact = consentContactId ? rulebook.contacts.find((item) => item.id === consentContactId) ?? null : null;
  const tabCounts: Partial<Record<RulebookTab, number>> = { schemes: loaded ? rulebook.schemes.length : undefined, contacts: loadedTabs.current.has("contacts") ? rulebook.contacts.length : undefined };

  // One active rule per type: once both Cash Discount and Turnover Discount are
  // active, a new rule has nothing to add. Change them with "Edit rule" instead.
  const bothTypesActive = (["cd", "tod"] as const).every((type) => rulebook.schemes.some((scheme) => scheme.schemeType === type && scheme.status === "active"));
  const primaryAction = tab === "schemes" ? bothTypesActive ? null : <Button onClick={() => void setRuleEditorMode("new")}><Plus size={16} />New rule</Button>
    : tab === "contacts" ? <Button onClick={openAddContact}><UserPlus size={16} />Add contact</Button>
    : null;

  const heroAction = !selected ? null
    : activeVersion ? <Button onClick={() => void setRuleEditorMode("update")}><Pencil size={14} />{draftVersion ? "Continue editing" : "Edit rule"}</Button>
    : draftVersion ? <Button onClick={() => void setRuleEditorMode("update")}><Pencil size={14} />Continue setup</Button>
    : <Button onClick={() => void setRuleEditorMode("complete")}><Pencil size={14} />Complete setup</Button>;

  const rulesPanel = <div className={studio.studio}>
    <div className={studio.layout}>
      <aside className={studio.rail} aria-label="Discount rules">
        <div className={studio.railHeader}><strong>Your rules</strong>{rulebook.schemes.length > 0 && <span>{rulebook.schemes.length}</span>}</div>
        {rulebook.schemes.length > 5 && <label className={studio.search}><Search size={16} /><input value={ruleSearch} onChange={(event) => setRuleSearch(event.target.value)} placeholder="Find a rule" aria-label="Find a rule" /></label>}
        <div className={studio.ruleList}>
          {visibleSchemes.map((scheme) => <button key={scheme.id} type="button" className={studio.ruleItem} aria-current={selected?.scheme.id === scheme.id ? "true" : undefined} data-selected={selected?.scheme.id === scheme.id} data-type={scheme.schemeType} onMouseEnter={() => void prefetchScheme(scheme)} onFocus={() => void prefetchScheme(scheme)} onClick={() => void selectScheme(scheme)}>
            <span className={studio.ruleIcon}>{scheme.schemeType === "cd" ? <BadgePercent size={18} /> : <Layers3 size={18} />}</span>
            <span className={studio.ruleCopy}><strong>{scheme.name}</strong><small>{schemeTypeName(scheme)}</small></span>
            <span className={studio.ruleMeta}><StatusBadge status={operationalStatus(scheme)} /></span>
          </button>)}
          {!rulebook.schemes.length && <div className={studio.railEmpty}><p>No rules yet.</p><Button className="button-secondary" onClick={() => void setRuleEditorMode("new")}><Plus size={15} />Create first rule</Button></div>}
          {rulebook.schemes.length > 0 && !visibleSchemes.length && <p className={studio.railEmpty}>{ruleQuery ? <>No rules match “{ruleSearch.trim()}”.</> : "Only retired rules."}</p>}
          {retiredCount > 0 && <button type="button" className={studio.retiredToggle} onClick={() => setShowRetired((value) => !value)}>{showRetired ? "Hide retired rules" : `Show retired (${retiredCount})`}</button>}
        </div>
      </aside>
      <section className={studio.canvas} aria-live="polite">{selectingScheme ? <div className={studio.body}><Skeleton lines={6} /></div> : selected ? <>
        <header className={studio.hero}>
          <div className={studio.heroIdentity}>
            <span className={studio.typeLabel} data-type={selected.scheme.schemeType}>{selected.scheme.schemeType === "cd" ? <BadgePercent size={14} /> : <Layers3 size={14} />}{schemeTypeName(selected.scheme)}<span className={studio.codeChip}>{selected.scheme.code}</span></span>
            <h2>{selected.scheme.name}</h2>
            {selected.scheme.description && <p className={studio.heroDescription}>{selected.scheme.description}</p>}
            <div className={studio.currentStrip}>
              <StatusBadge status={selectedOperationalStatus ?? selected.scheme.status} />
              {activeVersion && selectedOperationalStatus === "active" && <span>In use since {shortDate(activeVersion.effectiveFrom)}{activeVersion.effectiveTo ? ` · until ${shortDate(activeVersion.effectiveTo)}` : ""}</span>}
              {selectedOperationalStatus === "scheduled" && activeVersion && <span>Starts {shortDate(activeVersion.effectiveFrom)}</span>}
              {draftVersion && <span className={studio.workingCopy}>Draft update</span>}
            </div>
          </div>
          <div className={studio.heroActions}>{heroAction}</div>
        </header>
        <div className={studio.body}>
          {!selected.versions.length && <EmptyState title="Rule setup is incomplete" detail="Complete the business terms before using this rule." action={<Button onClick={() => void setRuleEditorMode("complete")}><Pencil size={14} />Complete setup</Button>} />}
          {version && <GuidedVersionSummary detail={version} reference={liveReference} validation={activationValidation} allowReplacementOverlap={Boolean(activeVersion) && rulebook.schemes.filter((item) => item.schemeType === selected?.scheme.schemeType && item.status === "active").length === 1} busy={versionActionBusy} onEditTerms={() => void setRuleEditorMode("update")} onDraftSetup={() => setDraftSetupOpen(true)} onValidate={() => void runVersionAction("validate")} onActivate={() => void runVersionAction("activate")} />}
        </div>
      </> : <div className={studio.emptyCanvas}><div><span><BookOpen size={21} /></span><h3>{rulebook.schemes.length ? "Choose a rule to inspect" : "Create your first rule"}</h3><p>{rulebook.schemes.length ? "Review its current terms, prepare an update, or continue a pending update." : "Set up a Cash Discount or Turnover Discount rule. It stays a draft until you check and apply it."}</p>{!rulebook.schemes.length && <Button onClick={() => void setRuleEditorMode("new")}><Plus size={16} />New rule</Button>}</div></div>}</section>
    </div>
  </div>;

  const panel = tab === "schemes" ? rulesPanel
    : tabLoading && !loadedTabs.current.has(tab) ? <Skeleton lines={4} />
    : tab === "calendar" ? <HolidayCalendar calendars={rulebook.calendars} onSetUp={() => setCalendarOpen(true)} onChanged={async (message) => { setNotice(message); await loadTab("calendar", true); }} onError={setError} />
    : tab === "contacts" ? <ContactsList contacts={rulebook.contacts} onAdd={openAddContact} onManage={(contact) => setConsentContactId(contact.id)} />
    : <RuleLifecycleList schemes={rulebook.schemes} onChanged={async (message) => { setNotice(message); await load({ schemeId: selectedSchemeId.current, versionId: selectedVersionId.current }); }} onError={setError} />;

  return <><WorkspacePageHeader title="Rulebook" action={<><RulebookGuidance hasMasters={Boolean(liveReference)} missing={missingForActivation} />{primaryAction}</>} />
    <div className={studio.tabs} role="tablist" aria-label="Rulebook sections">{VISIBLE_TABS.map(({ id, label, icon: TabIcon }, index) => <button key={id} ref={(node) => { tabRefs.current[id] = node; }} id={`rulebook-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`rulebook-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={studio.tab} onClick={() => selectTab(id)} onKeyDown={(event) => onTabKeyDown(event, index)}><TabIcon size={16} />{label}{tabCounts[id] !== undefined && <span className={studio.tabCount}>{tabCounts[id]}</span>}</button>)}</div>
    <div className={studio.panel} role="tabpanel" id={`rulebook-panel-${tab}`} aria-labelledby={`rulebook-tab-${tab}`}>{loading && !loaded ? <Skeleton lines={6} /> : panel}</div>
    <RuleEditor open={ruleEditorMode !== null} scheme={ruleEditorMode === "new" ? null : selected?.scheme ?? null} source={ruleEditorMode === "update" ? version : null} reference={liveReference} onClose={() => setRuleEditorMode(null)} onSaved={async (created) => { const wasUpdate = ruleEditorMode === "update"; setRuleEditorMode(null); setActivationValidation(null); setNotice(wasUpdate && created.applied ? "Rule changes saved and applied." : "Rule created. Complete its eligibility, then apply it."); await load(created); }} onError={setError} />
    <GuidedDraftSetupDrawer open={draftSetupOpen} onClose={() => setDraftSetupOpen(false)} detail={version} reference={liveReference} refreshingReference={refreshingReference} onRefreshReference={async () => { try { await readLiveTallyReference(); } catch (cause) { setError(userFacingError(cause, "Could not read the latest customers and products from Tally.")); } }} onError={setError} onSaved={async (message) => { setActivationValidation(null); setNotice(message); await refreshOpenVersion(); }} />
    <CalendarDrawer open={calendarOpen} onClose={() => setCalendarOpen(false)} onSaved={async () => { setCalendarOpen(false); setNotice("Business calendar created."); await loadTab("calendar", true); }} onError={setError} />
    <ContactDrawer open={contactOpen} onClose={() => setContactOpen(false)} reference={liveReference} onSaved={async () => { setContactOpen(false); setNotice("Controlled customer contact added."); await loadTab("contacts", true); }} onError={setError} />
    <ContactConsentDrawer contact={consentContact} onClose={() => setConsentContactId(null)} onChanged={async (message) => { setNotice(message); await loadTab("contacts", true); }} onError={setError} />
  </>;
}

function ContactsList({ contacts, onAdd, onManage }: { contacts: Contact[]; onAdd: () => void; onManage: (contact: Contact) => void }) {
  if (!contacts.length) return <Card><EmptyState title="No controlled contacts" detail="Add a consent-aware contact for a customer synced from Tally. Phone numbers are never written back to Tally." action={<Button onClick={onAdd}><UserPlus size={16} />Add contact</Button>} /></Card>;
  return <Card>
    <div className="card-title"><div><p className="eyebrow">Controlled contacts</p><h2>Contacts & consent</h2><p className="muted-copy">Record a WhatsApp opt-in before any message can be queued for a customer.</p></div><ContactRound size={20} /></div>
    <div className="simple-list">{contacts.map((contact) => <article key={contact.id} className={contact.is_active ? "" : "is-inactive"}>
      <div><strong>{contact.customer?.ledgerName ?? "Customer record"}</strong><p>{contact.contact_name || "Controlled contact"} · {safePhone(contact.phone_e164)}</p><small>{contact.is_primary ? "Primary" : "Secondary"} · {contact.is_active ? "Active" : "Inactive"}{contact.has_whatsapp_consent !== undefined ? ` · ${contact.has_whatsapp_consent ? "WhatsApp opt-in recorded" : "No WhatsApp opt-in"}` : ""}</small></div>
      <div className="table-actions"><StatusBadge status={contact.is_active ? "ready" : "suppressed"} /><Button className="button-quiet" onClick={() => onManage(contact)}>Manage</Button></div>
    </article>)}</div>
  </Card>;
}

function RuleLifecycleList({ schemes, onChanged, onError }: { schemes: Scheme[]; onChanged: (message: string) => Promise<void>; onError: (message: string | null) => void }) {
  const { company } = useCompany();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<Scheme | null>(null);
  const [deleting, setDeleting] = useState<Scheme | null>(null);
  const ordered = useMemo(() => [...schemes].sort((left, right) => Number(left.status === "retired") - Number(right.status === "retired")), [schemes]);

  // Only a rule that was never used (still a draft) can be deleted; the server refuses the rest.
  async function deleteScheme(scheme: Scheme) {
    const token = await accessToken(); if (!token) return;
    setBusyId(scheme.id);
    try {
      await apiRequest(token, `/api/companies/${company.id}/schemes/${scheme.id}`, { method: "DELETE" });
      setDeleting(null);
      await onChanged(`${scheme.name} deleted.`);
    } catch (cause) {
      setDeleting(null);
      onError(userFacingError(cause, "Could not delete this rule."));
    } finally { setBusyId(null); }
  }

  async function updateScheme(scheme: Scheme, status: "paused" | "retired") {
    const token = await accessToken(); if (!token) return;
    setBusyId(scheme.id);
    try {
      await apiRequest(token, `/api/companies/${company.id}/schemes/${scheme.id}`, { method: "PATCH", body: jsonBody({ status }) });
      setRetiring(null);
      await onChanged(status === "paused" ? `${scheme.name} paused. Existing versions remain visible.` : `${scheme.name} retired. Existing versions remain visible.`);
    } catch (cause) {
      onError(userFacingError(cause, "Could not update the rule status."));
    } finally { setBusyId(null); }
  }

  return <><Card>
    <div className="card-title"><div><p className="eyebrow">Rule status</p><h2>Pause or retire rules</h2><p className="muted-copy">Pausing stops a rule from being used for new work. Retiring is permanent. Neither changes activated versions or verified Credit Notes. A rule that was never used (still a draft) can be deleted.</p></div><Settings2 size={20} /></div>
    {ordered.length ? <div className="simple-list">{ordered.map((scheme) => <article key={scheme.id} className={scheme.status === "retired" ? "is-inactive" : ""}>
      <div><strong>{scheme.name}</strong><p>{scheme.code} · {schemeTypeName(scheme)}</p></div>
      <div className="table-actions"><StatusBadge status={scheme.status} />
        {scheme.status === "draft" ? <Button className="button-quiet" disabled={busyId === scheme.id} onClick={() => setDeleting(scheme)}><Trash2 size={14} />Delete</Button>
          : scheme.status === "paused" ? <Button className="button-quiet" disabled={busyId === scheme.id} onClick={() => setRetiring(scheme)}><Archive size={14} />Retire</Button>
          : scheme.status !== "retired" && <Button className="button-quiet" disabled={busyId === scheme.id} onClick={() => void updateScheme(scheme, "paused")}><Pause size={14} />Pause</Button>}
      </div>
    </article>)}</div> : <EmptyState title="No rules to manage" detail="Create a rule from the Rules tab first." />}
  </Card>
  <Dialog open={Boolean(deleting)} onClose={() => setDeleting(null)} title="Delete this rule?" description={deleting ? `${deleting.name} was never used, so it will be removed completely with its settings. This cannot be undone.` : undefined}>
    <div className="inline-actions"><Button className="button-secondary" onClick={() => setDeleting(null)}>Keep rule</Button><Button className="button-danger" disabled={!deleting || busyId === deleting.id} onClick={() => { if (deleting) void deleteScheme(deleting); }}><Trash2 size={14} />Delete rule</Button></div>
  </Dialog>
  <Dialog open={Boolean(retiring)} onClose={() => setRetiring(null)} title="Retire this rule?" description={retiring ? `${retiring.name} will be retired permanently and can no longer be used. Its activated versions and verified Credit Notes stay unchanged.` : undefined}>
    <div className="inline-actions"><Button className="button-secondary" onClick={() => setRetiring(null)}>Keep paused</Button><Button className="button-danger" disabled={!retiring || busyId === retiring.id} onClick={() => { if (retiring) void updateScheme(retiring, "retired"); }}><Archive size={14} />Retire rule</Button></div>
  </Dialog></>;
}

function CalendarDrawer({ open, onClose, onSaved, onError }: { open: boolean; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string | null) => void }) { const { company } = useCompany(); async function submit(form: HTMLFormElement) { const token = await accessToken(); if (!token) return; const fields = new FormData(form); const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((day) => fields.get(`day-${day}`)); try { await apiRequest(token, `/api/companies/${company.id}/calendars`, { method: "POST", body: jsonBody({ name: fields.get("name"), nonWorkingWeekdays: weekdays }) }); await onSaved(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not create the business calendar."); } } return <Drawer open={open} onClose={onClose} title="Set up business calendar" description="This calendar will be used automatically for every connected Tally company."><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}><label>Name<input name="name" required defaultValue="Meenakshi business calendar" /></label><fieldset className="weekday-fields"><legend>Non-working weekdays</legend>{[[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[7,"Sun"]].map(([day, label]) => <label key={String(day)}><input type="checkbox" name={`day-${day}`} defaultChecked={day === 7} />{String(label)}</label>)}</fieldset><Button type="submit">Create business calendar</Button></form></Drawer>; }

function ContactDrawer({ open, onClose, reference, onSaved, onError }: { open: boolean; onClose: () => void; reference: ReferenceData | null; onSaved: () => Promise<void>; onError: (message: string | null) => void }) { const { company } = useCompany(); async function submit(form: HTMLFormElement) { const token = await accessToken(); if (!token) return; const fields = new FormData(form); try { await apiRequest(token, `/api/companies/${company.id}/contacts`, { method: "POST", body: jsonBody({ customerId: fields.get("customer"), phoneE164: fields.get("phone"), contactName: fields.get("name") || null, isPrimary: true }) }); await onSaved(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not add controlled contact."); } } return <Drawer open={open} onClose={onClose} title="Add controlled contact" description="A phone number is stored in the existing controlled contact workflow; consent is managed separately."><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}><label>Customer<select name="customer" required><option value="">Select synced customer</option>{reference?.masters.customers.filter((item) => item.is_available).map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select></label><label>Contact name<input name="name" /></label><label>Phone in E.164 format<input name="phone" required placeholder="+919876543210" pattern="\+[1-9][0-9]{7,14}" title="Start with + and the country code, e.g. +919876543210" /></label><Button type="submit" disabled={!reference}>Add controlled contact</Button></form></Drawer>; }
