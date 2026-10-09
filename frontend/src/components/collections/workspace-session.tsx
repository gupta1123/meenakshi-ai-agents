"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { apiRequest } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { userFacingError } from "@/lib/user-copy";
import { tallyConnectionStatus } from "@/lib/tally-status";

import { useCompany } from "./company-context";
import { useTallyHealth } from "./tally-readiness";
import type { CashDiscountCreditNote, CashDiscountDebitNoteHistory, Contact, CreditNotePosting, LaunchControl, MessageTemplate, NotificationHealth, NotificationMessage, OperationsHealth, OverviewSummary, Proposal, ReferenceData, TallyHealth } from "./types";

export type WorkspaceData = {
  proposals: Proposal[];
  creditNotes: CreditNotePosting[];
  cdCreditNotes: CashDiscountCreditNote[];
  debitNotes: CashDiscountDebitNoteHistory[];
  messages: NotificationMessage[];
  contacts: Contact[];
  messageHealth: NotificationHealth | null;
  operations: OperationsHealth | null;
  launchControl: LaunchControl | null;
  reference: ReferenceData | null;
  templates: MessageTemplate[];
  overview: OverviewSummary | null;
};

const emptyData: WorkspaceData = { proposals: [], creditNotes: [], cdCreditNotes: [], debitNotes: [], messages: [], contacts: [], messageHealth: null, operations: null, launchControl: null, reference: null, templates: [], overview: null };
const workspaceRequestCache = new Map<string, { expiresAt: number; request: Promise<WorkspaceData> }>();

type WorkspaceSessionValue = {
  email: string;
  signOut: () => Promise<void>;
  health: TallyHealth | null;
  tallyStatus: string;
  tallyError: string | null;
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
  const { health: lastHealth, error: tallyError, reload: reloadTally } = useTallyHealth();
  // Keep unknown connectivity separate from both ready and confirmed offline.
  // Do not authorize live actions from a previous ready response after a read fails.
  const health = tallyError ? null : lastHealth;
  const tallyStatus = tallyConnectionStatus(health, tallyError);
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);

  const load = useCallback(async (useCache: boolean) => {
    const sequence = ++loadSequence.current;
    const token = await accessToken();
    if (!token) return;

    setLoading(true);
    setError(null);
    const base = `/api/companies/${company.id}`;
    // Shared across pages: same company + role, not per-pathname (fixes repeat reference-data/launch-control/contacts)
    const cacheKey = `${company.id}:${isAdministrator}:${pathname}`;
    try {
      if (!useCache) workspaceRequestCache.delete(cacheKey);
      const cached = workspaceRequestCache.get(cacheKey);
      const request = cached && cached.expiresAt > Date.now() ? cached.request : (async () => {
        if (pathname === "/") return { ...emptyData, overview: await apiRequest<OverviewSummary>(token, `${base}/overview`) };
        if (pathname === "/tally" || pathname === "/cash-discount") return { ...emptyData };
        if (pathname === "/turnover-discount") {
          const [proposalData, launchData, reference] = await Promise.all([
            apiRequest<{ proposals: Proposal[] }>(token, `${base}/evaluations/proposals?schemeType=tod&activeOnly=true`),
            apiRequest<{ launchControl: LaunchControl }>(token, `${base}/launch-control`),
            apiRequest<ReferenceData>(token, `${base}/rulebook/reference-data`).catch(() => null),
          ]);
          return { ...emptyData, proposals: proposalData.proposals, launchControl: launchData.launchControl, reference };
        }
        if (pathname === "/credit-notes") {
          const [proposalData, creditNoteData, messageData, contactData, launchData, reference, cdCreditNoteData] = await Promise.all([
            apiRequest<{ proposals: Proposal[] }>(token, `${base}/evaluations/proposals?schemeType=tod`),
            apiRequest<{ creditNotePostings: CreditNotePosting[] }>(token, `${base}/credit-notes`),
            apiRequest<{ messages: NotificationMessage[] }>(token, `${base}/notifications?for=credit_notes`),
            apiRequest<{ contacts: Contact[] }>(token, `${base}/contacts`).catch(() => ({ contacts: [] })),
            apiRequest<{ launchControl: LaunchControl }>(token, `${base}/launch-control`),
            apiRequest<ReferenceData>(token, `${base}/rulebook/reference-data`).catch(() => null),
            apiRequest<{ creditNotes: CashDiscountCreditNote[] }>(token, `${base}/cash-discount/credit-notes`).catch(() => ({ creditNotes: [] })),
          ]);
          return { ...emptyData, cdCreditNotes: cdCreditNoteData.creditNotes ?? [], proposals: proposalData.proposals, creditNotes: creditNoteData.creditNotePostings, messages: messageData.messages, contacts: contactData.contacts, launchControl: launchData.launchControl, reference };
        }
        if (pathname === "/debit-notes") {
          const [response, messageData, contactData] = await Promise.all([
            apiRequest<{ history: CashDiscountDebitNoteHistory[] }>(token, `${base}/cash-discount/recoveries`, { cache: "no-store" }),
            apiRequest<{ messages: NotificationMessage[] }>(token, `${base}/notifications?for=debit_notes`),
            apiRequest<{ contacts: Contact[] }>(token, `${base}/contacts`).catch(() => ({ contacts: [] })),
          ]);
          return { ...emptyData, debitNotes: response.history ?? [], messages: messageData.messages, contacts: contactData.contacts };
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
      const nextData = await request;
      if (sequence === loadSequence.current) setData(nextData);
    } catch (cause) {
      workspaceRequestCache.delete(cacheKey);
      if (sequence === loadSequence.current) setError(userFacingError(cause, "Could not load this company workspace."));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [company.id, isAdministrator, pathname]);

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    setData(emptyData);
    void load(true);
  }, [companyKey, load]);

  const value = useMemo(() => ({ email, signOut, health, tallyStatus, tallyError, data, loading, error, refresh, reloadTally, setError }), [data, email, error, health, tallyStatus, tallyError, loading, refresh, reloadTally, signOut]);
  return <WorkspaceSessionContext.Provider value={value}>{children}</WorkspaceSessionContext.Provider>;
}

export function useWorkspaceSession() {
  const context = useContext(WorkspaceSessionContext);
  if (!context) throw new Error("useWorkspaceSession must be used inside WorkspaceSessionProvider.");
  return context;
}
