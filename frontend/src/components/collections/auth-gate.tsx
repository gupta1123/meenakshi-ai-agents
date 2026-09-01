"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Building2, LockKeyhole, ShieldCheck } from "lucide-react";
import type { Session } from "@supabase/supabase-js";

import { ApiError, apiRequest } from "@/lib/api";
import { frontendConfigurationError, supabase } from "@/lib/supabase";
import { userFacingError } from "@/lib/user-copy";

import { CompanyProvider } from "./company-context";
import type { Bootstrap, Company, Organization } from "./types";
import { Button, Card, InlineMessage } from "./ui";
import { WorkspaceLoadingShell } from "./workspace-loading-shell";

export function AuthGate({ children }: { children: (props: { email: string; signOut: () => Promise<void> }) => ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(frontendConfigurationError);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");

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
      setSelectedCompanyId("");
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
  useEffect(() => {
    if (!availableCompanies.length) { setSelectedCompanyId(""); return; }
    const savedCompany = window.sessionStorage.getItem("meenakshi.activeCompanyId");
    if (availableCompanies.some((item) => item.company.id === savedCompany)) { setSelectedCompanyId(savedCompany ?? ""); return; }
    if (availableCompanies.length === 1) setSelectedCompanyId(availableCompanies[0].company.id);
  }, [availableCompanies]);

  function openCompany(companyId: string) {
    window.sessionStorage.setItem("meenakshi.activeCompanyId", companyId);
    setSelectedCompanyId(companyId);
  }

  if (frontendConfigurationError) return <main className="access-page"><Card><p className="eyebrow">App setup</p><h1>Meenakshi is not ready yet</h1><p className="section-detail">Ask your administrator to complete the application setup.</p></Card></main>;
  if (loading || (token && !bootstrap && !error)) return <WorkspaceLoadingShell />;
  if (!token) return <main className="sign-in-page">
    <section className="sign-in-intro"><div className="login-brand"><ShieldCheck size={24} />Meenakshi Collections</div><p className="eyebrow">Collections workspace</p><h1>Clear discount decisions with Tally.</h1><p>Review Cash Discount and Turnover Discount activity in one place.</p><div className="login-reassurance"><span>Authorized access only</span><span>Latest Tally information</span><span>Clear activity history</span></div></section>
    <Card className="sign-in-card"><div className="sign-in-title"><span><LockKeyhole size={18} /></span><div><p className="eyebrow">Welcome back</p><h2>Sign in</h2></div></div><form onSubmit={signIn} className="form-stack"><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" /></label><Button type="submit">Continue securely</Button></form>{error && <InlineMessage tone="error">{error}</InlineMessage>}</Card>
  </main>;
  if (!bootstrap) return <main className="access-page"><Card><p className="eyebrow">Access</p><h1>Checking Collections access</h1><p className="section-detail">{error ?? "We could not load your authorized companies yet. Refresh access or sign in again."}</p><div className="access-actions"><Button className="button-secondary" onClick={() => window.location.reload()}>Refresh access</Button><Button onClick={() => void signOut()}>Sign out</Button></div></Card></main>;
  if (!availableCompanies.length) return <main className="access-page"><Card><p className="eyebrow">Access setup needed</p><h1>No Collections company has been assigned</h1><p className="section-detail">Your sign-in succeeded, but no enabled, authorized Tally company was returned for Collections. An Administrator must register and bind the intended Tally company before it can be selected here.</p><div className="access-actions"><Button className="button-secondary" onClick={() => window.location.reload()}>Refresh access</Button><Button onClick={() => void signOut()}>Sign out</Button></div></Card></main>;
  if (!selectedCompanyId) return <CompanyChooser companies={availableCompanies} onOpen={openCompany} onSignOut={signOut} />;

  return <CompanyProvider bootstrap={bootstrap} initialCompanyId={selectedCompanyId}>{children({ email, signOut })}</CompanyProvider>;
}

function CompanyChooser({ companies, onOpen, onSignOut }: { companies: Array<{ company: Company; organization: Organization }>; onOpen: (companyId: string) => void; onSignOut: () => Promise<void> }) {
  return <main className="company-chooser-page"><section className="company-chooser"><div className="chooser-heading"><span><Building2 size={21} /></span><div><p className="eyebrow">Collections workspace</p><h1>Choose a company</h1><p>Open one of the Tally companies already authorized and registered for Meenakshi Collections.</p></div></div><div className="company-choice-list">{companies.map(({ company, organization }) => <button key={company.id} onClick={() => onOpen(company.id)}><span><strong>{company.tally_company_name}</strong><small>{organization.name} · {company.code}</small></span><ArrowRight size={18} /></button>)}</div><button className="text-button" onClick={() => void onSignOut()}>Sign out</button></section></main>;
}
