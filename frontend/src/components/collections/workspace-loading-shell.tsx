"use client";

import { usePathname } from "next/navigation";

import styles from "./workspace-loading-shell.module.css";

type LoadingPage = "overview" | "discount" | "history" | "rulebook" | "tally";

function Block({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`workspace-loading-block ${className}`} />;
}

function pageForPath(pathname: string): LoadingPage {
  if (pathname === "/tally") return "tally";
  if (pathname === "/cash-discount" || pathname === "/turnover-discount") return "discount";
  if (pathname === "/credit-notes" || pathname === "/messages") return "history";
  if (pathname === "/rulebook") return "rulebook";
  return "overview";
}

function PageHeading({ action = false }: { action?: boolean }) {
  return <div className="workspace-loading-heading"><div><Block className="loading-eyebrow" /><Block className="loading-title" /><Block className="loading-detail" /></div>{action && <Block className="loading-action" />}</div>;
}

function Rows({ count = 4 }: { count?: number }) {
  return <div className="workspace-loading-rows">{Array.from({ length: count }, (_, index) => <div key={index}><Block className="loading-row-main" /><Block className="loading-row-meta" /><Block className="loading-row-status" /></div>)}</div>;
}

function OverviewLoading() {
  return <><PageHeading action /><div className="workspace-loading-metrics">{Array.from({ length: 4 }, (_, index) => <div key={index}><Block className="loading-metric-icon" /><Block className="loading-metric-label" /><Block className="loading-metric-value" /><Block className="loading-metric-detail" /></div>)}</div><div className="workspace-loading-panel-grid"><div className="workspace-loading-panel"><Block className="loading-panel-title" /><Rows count={3} /></div><div className="workspace-loading-panel"><Block className="loading-panel-title" /><Rows count={3} /></div></div></>;
}

function DiscountLoading() {
  return <><PageHeading action /><div className="workspace-loading-readiness"><Block className="loading-chip" /><Rows count={3} /></div><div className="workspace-loading-panel"><div className="workspace-loading-panel-header"><Block className="loading-panel-title" /><Block className="loading-action small" /></div><Rows count={5} /></div></>;
}

function HistoryLoading() {
  return <><PageHeading action /><div className="workspace-loading-summary"><Block className="loading-chip" /><Block className="loading-summary-copy" /><Block className="loading-summary-copy short" /></div><div className="workspace-loading-panel"><div className="workspace-loading-panel-header"><Block className="loading-panel-title" /><Block className="loading-action small" /></div><Rows count={6} /></div></>;
}

function RulebookLoading() {
  return <><PageHeading /><div className="workspace-loading-tabs">{Array.from({ length: 5 }, (_, index) => <Block key={index} className="loading-tab" />)}</div><div className="workspace-loading-panel-grid rulebook"><div className="workspace-loading-panel tall"><Block className="loading-panel-title" /><Rows count={5} /></div><div className="workspace-loading-panel tall"><Block className="loading-panel-title" /><Rows count={5} /></div></div></>;
}

function TallyLoading() {
  return (
    <div className="workspace-loading-tally">
      <div className="workspace-loading-heading">
        <div>
          <Block className="loading-eyebrow" />
          <Block className="loading-title" />
          <Block className="loading-detail" />
        </div>
      </div>
      <div className="tally-unified-card workspace-loading-card">
        <div className="tally-card-header-bar">
          <div className="header-info">
            <Block className="loading-tally-icon small" />
            <div>
              <Block className="loading-panel-title" />
              <Block className="loading-detail" />
            </div>
          </div>
          <Block className="loading-chip" />
        </div>
        <div className="tally-location-segmented">
          <Block className="loading-chip" />
          <Block className="loading-chip" />
        </div>
        <div className="tally-status-grid">
          <div className="tally-status-card">
            <Block className="loading-metric-icon" />
            <Block className="loading-row-main" />
            <Block className="loading-row-meta" />
          </div>
          <div className="tally-status-card">
            <Block className="loading-metric-icon" />
            <Block className="loading-row-main" />
            <Block className="loading-row-meta" />
          </div>
          <div className="tally-status-card">
            <Block className="loading-metric-icon" />
            <Block className="loading-row-main" />
            <Block className="loading-row-meta" />
          </div>
        </div>
        <div className="tally-connection-actions">
          <Block className="loading-action" />
          <Block className="loading-action muted" />
        </div>
      </div>
    </div>
  );
}

export function WorkspaceLoadingShell() {
  const page = pageForPath(usePathname() ?? "/");
  const content = page === "tally" ? <TallyLoading /> : page === "discount" ? <DiscountLoading /> : page === "history" ? <HistoryLoading /> : page === "rulebook" ? <RulebookLoading /> : <OverviewLoading />;

  return <div className={`collections-shell workspace-loading-shell ${styles.shell}`} aria-busy="true" aria-label="Loading workspace">
    <aside className="collections-sidebar workspace-loading-sidebar">
      <div className="workspace-loading-wordmark"><Block className="loading-brand-mark" /><div><Block className="loading-brand-line" /><Block className="loading-brand-line short" /></div></div>
      <div className="workspace-loading-nav">{Array.from({ length: 6 }, (_, index) => <div key={index}><Block className="loading-nav-icon" /><div><Block className="loading-nav-label" /><Block className="loading-nav-detail" /></div></div>)}</div>
      <div className="workspace-loading-user"><Block className="loading-avatar" /><div><Block className="loading-nav-label" /><Block className="loading-nav-detail" /></div></div>
    </aside>
    <main className="collections-main">
      <header className="workspace-topbar workspace-loading-topbar"><div><Block className="loading-topbar-label" /><Block className="loading-topbar-company" /></div><Block className="loading-topbar-status" /></header>
      <section className={`workspace-content workspace-loading-content workspace-loading-${page}`}>{content}</section>
    </main>
  </div>;
}
