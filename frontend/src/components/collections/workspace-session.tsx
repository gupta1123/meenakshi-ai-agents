"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { apiRequest } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { useTallyHealth } from "./tally-readiness";
import type { CreditNotePosting, LaunchControl, MessageTemplate, NotificationHealth, NotificationMessage, OperationsHealth, OverviewSummary, Proposal, ReferenceData, TallyHealth } from "./types";

export type WorkspaceData = {
  proposals: Proposal[];
  creditNotes: CreditNotePosting[];
  messages: NotificationMessage[];
  messageHealth: NotificationHealth | null;
  operations: OperationsHealth | null;
  launchControl: LaunchControl | null;
  reference: ReferenceData | null;
  templates: MessageTemplate[];
  overview: OverviewSummary | null;
};

const emptyData: WorkspaceData = { proposals: [], creditNotes: [], messages: [], messageHealth: null, operations: null, launchControl: null, reference: null, templates: [], overview: null };
const workspaceRequestCache = new Map<string, { expiresAt: number; request: Promise<WorkspaceData> }>();

type WorkspaceSessionValue = {
  email: string;
  signOut: () => Promise<void>;
  health: TallyHealth | null;
  data: WorkspaceData;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  reloadTally: () => Promise<void>;
  setError: (message: string | null) => void;
};

const WorkspaceSessionContext = createContext<WorkspaceSessionValue | null>(null);

async function accessToken() {
  const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

export function WorkspaceSessionProvider({ email, signOut, children }: { email: string; signOut: () => Promise<void>; children: ReactNode }) {
  const { company, companyKey, isAdministrator } = useCompany();
  const pathname = usePathname();
  // Every workflow, including Cash Discount, needs the live Tally status for
  // the company picker and connection badge to reflect the active company.
  const { health, reload: reloadTally } = useTallyHealth();
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (useCache: boolean) => {
    const token = await accessToken();
    if (!token) return;

    setLoading(true);
    setError(null);
    const base = `/api/companies/${company.id}`;
    const cacheKey = `${company.id}:${pathname}:${isAdministrator}`;
    try {
      if (!useCache) workspaceRequestCache.delete(cacheKey);
      const cached = workspaceRequestCache.get(cacheKey);
      const request = cached && cached.expiresAt > Date.now() ? cached.request : (async () => {
        if (pathname === "/") return { ...emptyData, overview: await apiRequest<OverviewSummary>(token, `${base}/overview`) };
        if (pathname === "/tally" || pathname === "/cash-discount") return { ...emptyData };
        if (pathname === "/turnover-discount") {
          const [proposalData, launchData, reference] = await Promise.all([
            apiRequest<{ proposals: Proposal[] }>(token, `${base}/evaluations/proposals?schemeType=tod`),
            apiRequest<{ launchControl: LaunchControl }>(token, `${base}/launch-control`),
            apiRequest<ReferenceData>(token, `${base}/rulebook/reference-data`).catch(() => null),
          ]);
          return { ...emptyData, proposals: proposalData.proposals, launchControl: launchData.launchControl, reference };
        }
        if (pathname === "/credit-notes") {
          const [proposalData, creditNoteData, messageData, launchData, reference] = await Promise.all([
            apiRequest<{ proposals: Proposal[] }>(token, `${base}/evaluations/proposals?schemeType=tod`),
            apiRequest<{ creditNotePostings: CreditNotePosting[] }>(token, `${base}/credit-notes`),
            apiRequest<{ messages: NotificationMessage[] }>(token, `${base}/notifications`),
            apiRequest<{ launchControl: LaunchControl }>(token, `${base}/launch-control`),
            apiRequest<ReferenceData>(token, `${base}/rulebook/reference-data`).catch(() => null),
          ]);
          return { ...emptyData, proposals: proposalData.proposals, creditNotes: creditNoteData.creditNotePostings, messages: messageData.messages, launchControl: launchData.launchControl, reference };
        }
        if (pathname === "/messages") {
          const [messageData, messageHealth, templates] = await Promise.all([
            apiRequest<{ messages: NotificationMessage[] }>(token, `${base}/notifications`),
            apiRequest<NotificationHealth>(token, `${base}/notifications/health`),
            isAdministrator ? apiRequest<{ templates: MessageTemplate[] }>(token, `${base}/message-templates`).catch(() => ({ templates: [] })) : Promise.resolve({ templates: [] }),
          ]);
          return { ...emptyData, messages: messageData.messages, messageHealth, templates: templates.templates };
        }
        if (pathname === "/rulebook") return { ...emptyData };
        return { ...emptyData };
      })();
      workspaceRequestCache.set(cacheKey, { expiresAt: Date.now() + 5_000, request });
      setData(await request);
    } catch (cause) {
      workspaceRequestCache.delete(cacheKey);
      setError(userFacingError(cause, "Could not load this company workspace."));
    } finally {
      setLoading(false);
    }
  }, [company.id, isAdministrator, pathname]);

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    setData(emptyData);
    void load(true);
  }, [companyKey, load]);

  const value = useMemo(() => ({ email, signOut, health, data, loading, error, refresh, reloadTally, setError }), [data, email, error, health, loading, refresh, reloadTally, signOut]);
  return <WorkspaceSessionContext.Provider value={value}>{children}</WorkspaceSessionContext.Provider>;
}

export function useWorkspaceSession() {
  const context = useContext(WorkspaceSessionContext);
  if (!context) throw new Error("useWorkspaceSession must be used inside WorkspaceSessionProvider.");
  return context;
}
