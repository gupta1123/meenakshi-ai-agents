"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, BookOpen, Building2, ChevronDown, CircleGauge, FileCheck2, Layers2, LogOut, Menu, ReceiptIndianRupee } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { StatusBadge } from "./ui";
import { useCompany } from "./company-context";
import { GlobalTallyMonitor } from "./global-tally-monitor";
import { useTallyCompanySelection } from "./tally-company-selection";
import headerStyles from "./app-shell-header.module.css";

const navigation = [
  { href: "/", label: "Overview", description: "What needs attention", icon: CircleGauge },
  { href: "/cash-discount", label: "Cash Discount", description: "Check a Sales invoice", icon: ReceiptIndianRupee },
  { href: "/turnover-discount", label: "Turnover Discount", description: "Check a customer period", icon: Layers2 },
  { href: "/credit-notes", label: "Credit Notes", description: "Posting and verification history", icon: FileCheck2 },
  { href: "/messages", label: "Messages", description: "WhatsApp delivery history", icon: Bell },
  { href: "/rulebook", label: "Rulebook", description: "Administrator settings", icon: BookOpen, administratorOnly: true },
];

type WorkspacePageHeaderContent = { eyebrow?: string; title: string; detail?: string; action?: ReactNode };

const WorkspacePageHeaderContext = createContext<((header: WorkspacePageHeaderContent | null) => void) | null>(null);

export function WorkspacePageHeader({ eyebrow, title, detail, action }: WorkspacePageHeaderContent) {
  const setHeader = useContext(WorkspacePageHeaderContext);
  useEffect(() => {
    if (!setHeader) return;
    setHeader({ eyebrow, title, detail, action });
    return () => setHeader(null);
  }, [action, detail, eyebrow, setHeader, title]);
  return null;
}

export function AppShell({ children, email, tallyStatus, onSignOut }: { children: ReactNode; email: string; tallyStatus: string; onSignOut: () => Promise<void> }) {
  const pathname = usePathname();
  const activePathname = pathname ?? "";
  const { company, organization, isAdministrator, availableCompanies } = useCompany();
  const { selectCompany } = useTallyCompanySelection();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pageHeader, setPageHeader] = useState<WorkspacePageHeaderContent | null>(null);
  const updatePageHeader = useCallback((header: WorkspacePageHeaderContent | null) => setPageHeader(header), []);
  const initials = email.split("@")[0]?.slice(0, 2).toUpperCase() || "MC";

  return <WorkspacePageHeaderContext.Provider value={updatePageHeader}><div className="collections-shell">
    <aside className="collections-sidebar">
      <Link href="/" prefetch={false} className="wordmark" aria-label="Meenakshi Collections overview">
        <div className="brand-logo">
          <Layers2 size={15} strokeWidth={2.5} />
        </div>
        <div className="brand-text">
          <span className="brand-title">Meenakshi</span>
        </div>
      </Link>
      <nav className="primary-nav" aria-label="Primary navigation">
        <p className="nav-section-title">Workspaces</p>
        {navigation.filter((item) => !item.administratorOnly || isAdministrator).map((item) => {
          const Icon = item.icon;
          const active = item.href === "/" ? activePathname === "/" : activePathname.startsWith(item.href);
          return (
            <Link href={item.href} prefetch={false} key={item.href} className={`nav-link ${active ? "active" : ""}`}>
              {active && <span className="active-pill" aria-hidden="true" />}
              <Icon size={15} className="nav-icon" />
              <span className="nav-label">{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-bottom">
        <Link href="/tally" prefetch={false} className="sidebar-tally-pill" title="View Tally connection status">
          <span className={`tally-dot ${tallyStatus.includes("ready") ? "ready" : "stale"}`} />
          <span className="tally-label">Tally: {tallyStatus.replaceAll("bridge_stale", "connection needs attention").replaceAll("not_bound", "not connected").replaceAll("awaiting_pairing", "connecting").replaceAll("_", " ")}</span>
          <span className="tally-arrow">→</span>
        </Link>
        <button className="user-menu-trigger" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen}>
          <span className="avatar">{initials}</span>
          <span className="user-name">{email || "Signed in"}</span>
          <ChevronDown size={12} className={`user-chevron ${menuOpen ? "open" : ""}`} />
        </button>
        {menuOpen && (
          <div className="user-popover">
            <div className="popover-header">
              <span className="eyebrow">Organization</span>
              <p>{organization.name}</p>
            </div>
            <button onClick={() => void onSignOut()}>
              <LogOut size={13} /> Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
    <main className="collections-main">
      <header className={`workspace-topbar ${headerStyles.topbar} ${pageHeader ? "has-page-header" : ""}`}>
        <button className="mobile-wordmark" aria-label="Navigation"><Menu size={20} /></button>
        {pageHeader && <div className={`workspace-page-header ${headerStyles.pageHeader}`}><div>{pageHeader.eyebrow && <p className="eyebrow">{pageHeader.eyebrow}</p>}<h1>{pageHeader.title}</h1>{pageHeader.detail && <p>{pageHeader.detail}</p>}</div></div>}
        <div className={`workspace-topbar-tools ${headerStyles.tools}`}>
        <div className="company-select-compact"><Building2 size={14} aria-hidden="true" /><select aria-label="Choose company to work with" onChange={(event) => selectCompany(event.target.value)} title="Choose company to work with" value={company.id}>{availableCompanies.map(({ company: option }) => <option key={option.id} value={option.id}>{option.tally_company_name}</option>)}</select></div>
        {pageHeader?.action}<GlobalTallyMonitor tallyStatus={tallyStatus} /></div>
      </header>
      {children}
    </main>
    <nav className="mobile-nav" aria-label="Mobile navigation">{navigation.filter((item) => !item.administratorOnly || isAdministrator).slice(0, 6).map((item) => { const Icon = item.icon; const active = item.href === "/" ? activePathname === "/" : activePathname.startsWith(item.href); return <Link href={item.href} prefetch={false} key={item.href} className={active ? "active" : ""}><Icon size={18} /><span>{item.label}</span></Link>; })}</nav>
  </div></WorkspacePageHeaderContext.Provider>;
}
