"use client";

import { usePathname } from "next/navigation";

import styles from "./workspace-loading-shell.module.css";

type LoadingPage = "overview" | "discount" | "tod" | "credit-notes" | "messages" | "rulebook" | "tally";

function Block({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`workspace-loading-block ${className}`} />;
}

function pageForPath(pathname: string): LoadingPage {
  if (pathname === "/tally") return "tally";
  if (pathname === "/turnover-discount") return "tod";
  if (pathname === "/cash-discount") return "discount";
  if (pathname === "/credit-notes" || pathname === "/debit-notes") return "credit-notes";
  if (pathname === "/messages") return "messages";
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

/** One TOD group card's shape: header, amount, two stats, share bar, TOD/CD rule lines. */
function TodGroupCardSkeleton() {
  return <div className="tod-group-card tod-group-card-skeleton" aria-hidden="true">
    <span className="tod-group-card-head"><Block className="sk sk-avatar" /><span className="tod-group-title"><Block className="sk sk-link" /><Block className="sk sk-link-sub" /></span><span /></span>
    <span className="tod-group-amount"><Block className="sk sk-label" /><Block className="sk sk-amount" /></span>
    <span className="tod-group-stats"><span><Block className="sk sk-label" /><Block className="sk sk-link-sub" /></span><span><Block className="sk sk-label" /><Block className="sk sk-link-sub" /></span></span>
    <Block className="sk sk-meter" />
    <span className="tod-group-rules"><Block className="sk sk-rule" /><Block className="sk sk-rule short" /></span>
  </div>;
}

/** Turnover Discount loading: the summary card (status line + 4 tabs) and the group cards. Used at app start and on the page. */
export function TodPageSkeleton() {
  return <div className="tod-page-skeleton" aria-label="Loading Turnover Discount" role="status">
    <div className="tod-page-skeleton-summary">
      <div className="tod-page-skeleton-bar"><Block className="sk sk-status" /><Block className="sk sk-verify" /></div>
      <div className="tod-page-skeleton-tabs">{Array.from({ length: 4 }, (_, index) => <div key={index}><Block className="sk sk-label" /><Block className="sk sk-amount" /><Block className="sk sk-link-sub" /></div>)}</div>
    </div>
    <Block className="sk sk-heading" />
    <div className="tod-group-strip">{Array.from({ length: 6 }, (_, index) => <TodGroupCardSkeleton key={index} />)}</div>
  </div>;
}

function DiscountLoading() {
  return <><PageHeading action /><div className="workspace-loading-readiness"><Block className="loading-chip" /><Rows count={3} /></div><div className="workspace-loading-panel"><div className="workspace-loading-panel-header"><Block className="loading-panel-title" /><Block className="loading-action small" /></div><Rows count={5} /></div></>;
}

export function MessagesLoadingContent() {
  return <div className="messages-loading" aria-label="Loading Messages">
    <div className="messages-loading-summary">{Array.from({ length: 4 }, (_, index) => <div key={index}><Block className="loading-message-label" /><Block className="loading-message-value" /></div>)}</div>
    <div className="messages-loading-filters"><Block className="loading-message-search" /><Block className="loading-message-select" /><Block className="loading-message-type" /></div>
    <div className="messages-loading-table">
      <div className="messages-loading-table-head">{Array.from({ length: 5 }, (_, index) => <Block key={index} className="loading-message-column" />)}</div>
      {Array.from({ length: 4 }, (_, index) => <div className="messages-loading-row" key={index}><div><Block className="loading-message-main" /><Block className="loading-message-meta" /></div><div><Block className="loading-message-context" /><Block className="loading-message-context-meta" /></div><Block className="loading-message-status" /><Block className="loading-message-activity" /><Block className="loading-message-action" /></div>)}
    </div>
  </div>;
}

export function CreditNotesLoadingContent() {
  return <div className="credit-notes-loading" aria-label="Loading Credit Notes">
    <div className="credit-notes-loading-summary">{Array.from({ length: 5 }, (_, index) => <div key={index}><Block className="loading-credit-value" /><Block className="loading-credit-label" /></div>)}</div>
    <Block className="loading-credit-filter" />
    <div className="credit-notes-loading-section"><Block className="loading-credit-heading" /><div className="credit-notes-loading-row"><div><Block className="loading-credit-customer" /><Block className="loading-credit-period" /></div><Block className="loading-credit-amount" /><Block className="loading-credit-action" /></div></div>
  </div>;
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
  const content = page === "tally" ? <TallyLoading /> : page === "tod" ? <TodPageSkeleton /> : page === "discount" ? <DiscountLoading /> : page === "credit-notes" ? <CreditNotesLoadingContent /> : page === "messages" ? <MessagesLoadingContent /> : page === "rulebook" ? <RulebookLoading /> : <OverviewLoading />;

  return <div className={`collections-shell workspace-loading-shell ${styles.shell}`} aria-busy="true" aria-label="Loading workspace">
    <aside className="collections-sidebar workspace-loading-sidebar">
      <div className="workspace-loading-wordmark"><Block className="loading-brand-mark" /><div><Block className="loading-brand-line" /><Block className="loading-brand-line short" /></div></div>
      <div className="workspace-loading-nav">{Array.from({ length: 6 }, (_, index) => <div key={index}><Block className="loading-nav-icon" /><div><Block className="loading-nav-label" /><Block className="loading-nav-detail" /></div></div>)}</div>
      <div className="workspace-loading-user"><Block className="loading-avatar" /><div><Block className="loading-nav-label" /><Block className="loading-nav-detail" /></div></div>
    </aside>
    <main className="collections-main">
      <header className="workspace-topbar workspace-loading-topbar">{page === "tod" ? <><Block className="loading-tod-title" /><div className="loading-credit-topbar-tools"><Block className="loading-credit-company" /><Block className="loading-topbar-status" /></div></> : page === "credit-notes" || page === "messages" ? <><div className="loading-credit-page-title"><Block className="loading-credit-title" /><Block className="loading-credit-subtitle" /></div><div className="loading-credit-topbar-tools"><Block className="loading-credit-company" />{page === "messages" && <Block className="loading-message-test" />}<Block className="loading-credit-icon" /><Block className="loading-topbar-status" /></div></> : <><div><Block className="loading-topbar-label" /><Block className="loading-topbar-company" /></div><Block className="loading-topbar-status" /></>}</header>
      <section className={`workspace-content workspace-loading-content workspace-loading-${page}`}>{content}</section>
    </main>
  </div>;
}
