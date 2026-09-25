"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import type { Session } from "@supabase/supabase-js";

import { ApiError, apiRequest } from "@/lib/api";
import { frontendConfigurationError, supabase } from "@/lib/supabase";
import { userFacingError } from "@/lib/user-copy";

import { CompanyProvider } from "./company-context";
import { TallyCompanySelectionProvider } from "./tally-company-selection";
import type { Bootstrap } from "./types";
import { Button, Card, InlineMessage } from "./ui";
import { WorkspaceLoadingShell } from "./workspace-loading-shell";

type ActiveCompanyResponse = {
  status: "ready" | "no_authorized_companies" | "tally_not_connected" | "company_not_open" | "company_mismatch" | "active_company_not_registered" | "ambiguous_active_companies" | "company_not_authorized" | "connection_check_failed";
  company: { id: string } | null;
  activeTallyCompany?: { name: string; guid: string } | null;
};

export function AuthGate({ children }: { children: (props: { email: string; signOut: () => Promise<void> }) => ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(frontendConfigurationError);
  const [companySelection, setCompanySelection] = useState({ companyId: "", isManual: false });
  const [activeCompanyRefresh, setActiveCompanyRefresh] = useState(0);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    const authClient = supabase;
    let active = true;
    let requestId = 0;
    let bootstrappedUserId: string | null = null;
    let loadingUserId: string | null = null;

    function clearAccess() {
      bootstrappedUserId = null;
      loadingUserId = null;
      setToken(null);
      setEmail("");
      setBootstrap(null);
      setCompanySelection({ companyId: "", isManual: false });
      setError(null);
      setLoading(false);
    }

    async function loadAccess(session: Session | null, allowRefresh: boolean) {
      const currentRequestId = ++requestId;
      if (!session) {
        if (active) clearAccess();
        return;
      }

      if (bootstrappedUserId === session.user.id || loadingUserId === session.user.id) {
        if (active) {
          setToken(session.access_token);
          setEmail(session.user.email ?? "");
        }
        return;
      }

      if (active) {
        loadingUserId = session.user.id;
        setToken(session.access_token);
        setEmail(session.user.email ?? "");
        setError(null);
        setLoading(true);
      }

      try {
        const data = await apiRequest<Bootstrap>(session.access_token, "/api/bootstrap");
        if (active && currentRequestId === requestId) {
          bootstrappedUserId = session.user.id;
          setBootstrap(data);
        }
      } catch (cause: unknown) {
        if (cause instanceof ApiError && cause.status === 401 && allowRefresh) {
          const { data, error: refreshError } = await authClient.auth.refreshSession();
          if (!active || currentRequestId !== requestId) return;
          if (!refreshError && data.session) {
            loadingUserId = null;
            await loadAccess(data.session, false);
            return;
          }
          await authClient.auth.signOut({ scope: "local" });
          if (active && currentRequestId === requestId) clearAccess();
          return;
        }
        if (active && currentRequestId === requestId) {
          setBootstrap(null);
          setError(userFacingError(cause, "Could not verify your access."));
        }
      } finally {
        if (active && currentRequestId === requestId) {
          loadingUserId = null;
          setLoading(false);
        }
      }
    }

    const { data: listener } = authClient.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED" && session) {
        setToken(session.access_token);
        setEmail(session.user.email ?? "");
        return;
      }
      void loadAccess(session, true);
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) setError(signInError.message);
  }

  async function signOut() { await supabase?.auth.signOut(); }

  const availableCompanies = useMemo(() => bootstrap?.organizations.flatMap((organization) => organization.companies.map((company) => ({ company, organization }))) ?? [], [bootstrap]);
  const selectCompany = useCallback((companyId: string) => {
    window.sessionStorage.setItem("meenakshi.activeCompanyId", companyId);
    setCompanySelection({ companyId, isManual: true });
    setActiveCompanyRefresh((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!token || !bootstrap) {
      setCompanySelection({ companyId: "", isManual: false });
      return;
    }
    let active = true;
    const storedCompanyId = window.sessionStorage.getItem("meenakshi.activeCompanyId") ?? "";
    const storedCompanyIsAuthorised = availableCompanies.some((item) => item.company.id === storedCompanyId);
    const targetCompanyId = companySelection.companyId
      || (storedCompanyIsAuthorised ? storedCompanyId : "")
      || availableCompanies[0]?.company.id
      || "";
    if (!targetCompanyId) return;
    if (!companySelection.companyId) {
      setCompanySelection({ companyId: targetCompanyId, isManual: storedCompanyIsAuthorised });
    }
    const resolveActiveCompany = async () => {
      try {
        const response = await apiRequest<ActiveCompanyResponse>(token, `/api/active-company?companyId=${encodeURIComponent(targetCompanyId)}`);
        if (!active) return;
        const isAuthorisedCompany = response.status === "ready"
          && Boolean(response.company && availableCompanies.some((item) => item.company.id === response.company?.id));
        if (isAuthorisedCompany) {
          const activeCompanyId = response.company!.id;
          window.sessionStorage.setItem("meenakshi.activeCompanyId", activeCompanyId);
          setCompanySelection((current) => current.companyId === activeCompanyId ? current : { companyId: activeCompanyId, isManual: current.isManual });
        }
      } catch {
        // Keep the last usable selection while the next heartbeat check retries.
      }
    };
    void resolveActiveCompany();
    const timer = window.setInterval(() => { void resolveActiveCompany(); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [activeCompanyRefresh, availableCompanies, bootstrap, companySelection.companyId, token]);

  if (frontendConfigurationError) return <main className="access-page"><Card><p className="eyebrow">App setup</p><h1>Meenakshi is not ready yet</h1><p className="section-detail">Ask your administrator to complete the application setup.</p></Card></main>;
  if (loading || (token && !bootstrap && !error)) return <WorkspaceLoadingShell />;
  if (!token) return <main className="sign-in-page">
    <section className="sign-in-intro"><div className="login-brand"><ShieldCheck size={24} />Meenakshi Collections</div><p className="eyebrow">Collections workspace</p><h1>Clear discount decisions with Tally.</h1><p>Review Cash Discount and Turnover Discount activity in one place.</p><div className="login-reassurance"><span>Authorized access only</span><span>Latest Tally information</span><span>Clear activity history</span></div></section>
    <Card className="sign-in-card"><div className="sign-in-title"><span><LockKeyhole size={18} /></span><div><p className="eyebrow">Welcome back</p><h2>Sign in</h2></div></div><form onSubmit={signIn} className="form-stack"><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" /></label><Button type="submit">Continue securely</Button></form>{error && <InlineMessage tone="error">{error}</InlineMessage>}</Card>
  </main>;
  if (!bootstrap) return <main className="access-page"><Card><p className="eyebrow">Access</p><h1>Checking Collections access</h1><p className="section-detail">{error ?? "We could not load your authorized companies yet. Refresh access or sign in again."}</p><div className="access-actions"><Button className="button-secondary" onClick={() => window.location.reload()}>Refresh access</Button><Button onClick={() => void signOut()}>Sign out</Button></div></Card></main>;
  if (!availableCompanies.length) return <main className="access-page"><Card><p className="eyebrow">Access setup needed</p><h1>No Collections company has been assigned</h1><p className="section-detail">Your sign-in succeeded, but no enabled, authorized Tally company was returned for Collections. An Administrator must register and bind the intended Tally company before it can be selected here.</p><div className="access-actions"><Button className="button-secondary" onClick={() => window.location.reload()}>Refresh access</Button><Button onClick={() => void signOut()}>Sign out</Button></div></Card></main>;
  // Kalika keeps the picker in the workspace chrome. The selected company is
  // still checked against Tally before data or actions are displayed, but a
  // mismatch must not replace the workspace with a second picker.
  const workspaceCompanyId = companySelection.companyId || availableCompanies[0].company.id;

  return <CompanyProvider key={workspaceCompanyId} bootstrap={bootstrap} initialCompanyId={workspaceCompanyId}><TallyCompanySelectionProvider selectedCompanyId={workspaceCompanyId} selectCompany={selectCompany}>{children({ email, signOut })}</TallyCompanySelectionProvider></CompanyProvider>;
}
