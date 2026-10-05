"use client";

// Financial-year dashboard: quarters x measures, customer groups, trend and
// open items. Cash Discount is "earned" by invoice date; Credit Notes are
// "issued" by their Tally date; Turnover Discount belongs to its rule period.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiRequest } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import { EmptyState, Skeleton, formatDate, formatMoney, formatTonnes } from "./ui";
import { accessToken } from "./workspace";

type CashRow = [string, string, string, number, number, number, boolean];
type Dashboard = {
  fy: number; from: string; to: string;
  checks: { cashDiscountAt: string | null; turnoverDiscountAt: string | null };
  notEligibleTracked?: boolean;
  customers: Record<string, { name: string | null; group: string | null }>;
  cash: CashRow[];
  notEligible: Array<[string, string, number, number]>;
  notes: Array<{ s: "tod" | "cd"; d: string; ed: string; c: string; a: number; st: string; w: "sent" | "failed" | "none"; e: boolean }>;
  tod: Array<{ ps: string; pe: string; c: string; q: boolean; mt: number; a: number; cr: boolean }>;
};
type Quarter = "q1" | "q2" | "q3" | "q4";
type Column = Quarter | "fy";
const QUARTERS: Array<{ key: Quarter; label: string; months: string }> = [
  { key: "q1", label: "Q1", months: "Apr–Jun" }, { key: "q2", label: "Q2", months: "Jul–Sep" },
  { key: "q3", label: "Q3", months: "Oct–Dec" }, { key: "q4", label: "Q4", months: "Jan–Mar" },
];
const quarterOf = (date: string): Quarter => { const month = Number(date.slice(5, 7)); return month >= 4 && month <= 6 ? "q1" : month >= 7 && month <= 9 ? "q2" : month >= 10 ? "q3" : "q4"; };
const currentFy = () => { const today = new Date(); return today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1; };
const fyLabel = (fy: number) => `FY ${fy}–${String(fy + 1).slice(2)}`;
const pct = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "—";
// One money style on the dashboard: crore / lakh, and whole rupees below a lakh.
const lakh = (value: number) => value >= 1e7 ? `₹${(value / 1e7).toFixed(2)} Cr` : value >= 1e5 ? `₹${(value / 1e5).toFixed(2)} L` : `₹${Math.round(value).toLocaleString("en-IN")}`;

/** Every measure for one set of rows (a quarter or the year, after group/scheme filters). */
function measure(data: Dashboard, inColumn: (date: string) => boolean, keep: (customerId: string) => boolean, scheme: "all" | "tod" | "cd", today: string) {
  const useTod = scheme !== "cd";
  const useCd = scheme !== "tod";
  const tod = useTod ? data.tod.filter((row) => inColumn(row.ps) && keep(row.c)) : [];
  const cash = useCd ? data.cash.filter((row) => inColumn(row[0]) && keep(row[1])) : [];
  const notEligible = useCd ? data.notEligible.filter((row) => inColumn(`${row[0]}-01`) && keep(row[1])) : [];
  const ofScheme = data.notes.filter((note) => (scheme === "all" || note.s === scheme) && keep(note.c));
  // Issued = by Tally date (accounting). Credited = by when the discount was earned.
  const notes = ofScheme.filter((note) => inColumn(note.d));
  const created = notes.filter((note) => note.st === "created_verified");
  const credited = ofScheme.filter((note) => note.st === "created_verified" && inColumn(note.ed || note.d));
  const cat = (name: string) => cash.filter((row) => row[2] === name);
  const qualifiedTod = tod.filter((row) => row.q);
  const notEligibleCount = notEligible.reduce((sum, row) => sum + row[2], 0);
  const cdChecked = cash.length + notEligibleCount;
  const cdOnTime = cat("full_payment").length + cat("discounted_payment").length;
  const cdEarned = cash.filter((row) => ["full_payment", "discounted_payment"].includes(row[2])).reduce((sum, row) => sum + row[5], 0);
  const cdPending = cash.filter((row) => ["full_payment", "discounted_payment", "over_ninety_percent"].includes(row[2]) && !row[6] && row[5] > 0).reduce((sum, row) => sum + row[5], 0);
  const todPending = qualifiedTod.filter((row) => !row.cr && row.pe < today).reduce((sum, row) => sum + row.a, 0);
  return {
    todCustomers: tod.length, todQualified: qualifiedTod.length, todMt: tod.reduce((sum, row) => sum + row.mt, 0), todEarned: qualifiedTod.reduce((sum, row) => sum + row.a, 0),
    todInProgress: tod.some((row) => row.pe >= today),
    cdChecked, cdMt: cash.reduce((sum, row) => sum + row[3], 0) + notEligible.reduce((sum, row) => sum + row[3], 0),
    cdFull: cat("full_payment").length, cdDiscounted: cat("discounted_payment").length, cdShort: cat("over_ninety_percent").length, cdNotEligible: notEligibleCount + cat("not_eligible").length,
    cdOnTime, cdEarned, cdReview: cat("over_ninety_percent").reduce((sum, row) => sum + row[5], 0),
    pending: cdPending + todPending, cdPending, todPending,
    issuedCount: created.length, issued: created.reduce((sum, note) => sum + note.a, 0),
    creditedCount: credited.length, credited: credited.reduce((sum, note) => sum + note.a, 0),
    issuedTod: created.filter((note) => note.s === "tod").reduce((sum, note) => sum + note.a, 0),
    issuedCd: created.filter((note) => note.s === "cd").reduce((sum, note) => sum + note.a, 0),
    sent: created.filter((note) => note.w === "sent").length, notSent: created.filter((note) => note.w === "none").length, failed: created.filter((note) => note.w === "failed").length,
    einvoicePending: created.filter((note) => !note.e).length,
    notCreated: notes.filter((note) => note.st !== "created_verified").length,
    customers: new Set([...tod.map((row) => row.c), ...cash.map((row) => row[1]), ...notEligible.map((row) => row[1]), ...notes.map((note) => note.c)]).size,
  };
}

export function FinanceDashboard() {
  const { company, companyKey } = useCompany();
  const [fy, setFy] = useState(currentFy);
  const [column, setColumn] = useState<Column>("fy");
  const [group, setGroup] = useState("all");
  const [scheme, setScheme] = useState<"all" | "tod" | "cd">("all");
  // Overview tiles first; a tile opens the detailed view at its section.
  const [mode, setMode] = useState<"overview" | "details">("overview");
  const openDetails = (section: string) => { setMode("details"); window.setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setData(null); setError(null);
    void (async () => {
      try {
        const token = await accessToken(); if (!token) return;
        const result = await apiRequest<Dashboard>(token, `/api/companies/${company.id}/dashboard?fy=${fy}`, { cache: "no-store", timeoutMs: 60_000 });
        if (active) setData(result);
      } catch (cause) { if (active) setError(userFacingError(cause, "Could not load the dashboard.")); }
    })();
    return () => { active = false; };
  }, [company.id, companyKey, fy]);

  const today = new Date().toISOString().slice(0, 10);
  const groupOf = (customerId: string) => data?.customers[customerId]?.group ?? "No group";
  const groups = useMemo(() => data ? [...new Set([...data.tod.map((row) => row.c), ...data.cash.map((row) => row[1]), ...data.notes.map((note) => note.c), ...data.notEligible.map((row) => row[1])].map((id) => data.customers[id]?.group ?? "No group"))].sort((left, right) => left === "No group" ? 1 : right === "No group" ? -1 : left.localeCompare(right)) : [], [data]);
  if (error) return <EmptyState title="Dashboard unavailable" detail={error} />;
  if (!data) return <div className="fd"><Skeleton lines={8} /></div>;

  const inGroup = (customerId: string) => group === "all" || groupOf(customerId) === group;
  const columns: Column[] = ["q1", "q2", "q3", "q4", "fy"];
  const inColumnFor = (key: Column) => (date: string) => Boolean(date) && date >= data.from && date <= data.to && (key === "fy" || quarterOf(date) === key);
  const byColumn = Object.fromEntries(columns.map((key) => [key, measure(data, inColumnFor(key), inGroup, scheme, today)])) as Record<Column, ReturnType<typeof measure>>;
  const selected = byColumn[column];
  const showTod = scheme !== "cd";
  const showCd = scheme !== "tod";
  const quarterEnded = (key: Column) => key === "fy" ? `${data.fy + 1}-03-31` < today : (() => { const index = ["q1", "q2", "q3", "q4"].indexOf(key); const endMonth = [6, 9, 12, 3][index]; const year = index === 3 ? data.fy + 1 : data.fy; return `${year}-${String(endMonth).padStart(2, "0")}-31` < today; })();
  // "Paid on time" needs the not-eligible invoices; older checks did not keep them per quarter.
  const onTime = (m: ReturnType<typeof measure>) => data.notEligibleTracked === false ? "—" : pct(m.cdOnTime, m.cdChecked);
  const rowsSpec: Array<{ section?: string; label: string; value: (m: ReturnType<typeof measure>) => string; strong?: boolean; show: boolean }> = [
    { section: "Turnover Discount", label: "Customers qualified", value: (m) => m.todQualified ? String(m.todQualified) : "—", show: showTod },
    { label: "Earned", value: (m) => m.todEarned ? lakh(m.todEarned) : "—", strong: true, show: showTod },
    { section: "Cash Discount", label: "Invoices checked", value: (m) => m.cdChecked ? m.cdChecked.toLocaleString("en-IN") : "—", show: showCd },
    { label: "Paid on time", value: onTime, show: showCd },
    { label: "Earned", value: (m) => m.cdEarned ? lakh(m.cdEarned) : "—", strong: true, show: showCd },
    { section: "Credit Notes", label: "Credited", value: (m) => m.credited ? lakh(m.credited) : "—", strong: true, show: true },
    { label: "To create", value: (m) => m.pending ? lakh(m.pending) : "—", show: true },
  ];

  // Groups for the selected column.
  const groupRows = groups.map((name) => ({ name, m: measure(data, inColumnFor(column), (customerId) => groupOf(customerId) === name && inGroup(customerId), scheme, today) }))
    .filter((row) => row.m.customers > 0).sort((left, right) => (right.m.credited + right.m.pending) - (left.m.credited + left.m.pending));
  const gstLastDate = `${data.fy + 1}-11-30`;

  return <div className="fd">
    {/* Level 1: year, quarter, group, scheme. */}
    <div className="nf-head">
      <div className="nf-tabs" role="tablist" aria-label="Quarter">
        <button type="button" role="tab" aria-selected={column === "fy"} className={column === "fy" ? "is-active" : ""} onClick={() => setColumn("fy")}>Full year</button>
        {QUARTERS.map((quarter) => <button key={quarter.key} type="button" role="tab" aria-selected={column === quarter.key} className={column === quarter.key ? "is-active" : ""} onClick={() => setColumn(quarter.key)}>{quarter.label} <span className="fd-months">{quarter.months}</span></button>)}
      </div>
      <div className="fd-controls">
        <label className="nf-select"><span className="sr-only">Financial year</span><select value={fy} onChange={(event) => setFy(Number(event.target.value))}>{[currentFy() + 0, currentFy() - 1, currentFy() - 2].map((year) => <option key={year} value={year}>{fyLabel(year)}</option>)}</select></label>
      </div>
    </div>
    <div className="nf-toolbar">
      <div className="nf-seg" role="tablist" aria-label="Scheme">
        {([["all", "All schemes"], ["tod", "Turnover Discount"], ["cd", "Cash Discount"]] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={scheme === key} className={scheme === key ? "is-active" : ""} onClick={() => setScheme(key)}>{label}</button>)}
      </div>
      <div className="nf-tools">
        {groups.length > 1 && <label className="nf-select"><span className="sr-only">Customer group</span><select value={group} onChange={(event) => setGroup(event.target.value)}><option value="all">All groups</option>{groups.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
      </div>
    </div>

    {mode === "overview" ? (() => {
      const creditedShare = selected.credited + selected.pending ? Math.round((selected.credited / (selected.credited + selected.pending)) * 100) : 0;
      const sentShare = selected.issuedCount ? Math.round((selected.sent / selected.issuedCount) * 100) : 0;
      const todMax = Math.max(1, ...QUARTERS.map((q) => byColumn[q.key].todEarned));
      const cdMax = Math.max(1, ...QUARTERS.map((q) => byColumn[q.key].cdEarned));
      const topGroups = groupRows.slice(0, 5);
      const groupMax = Math.max(1, ...topGroups.map((row) => row.m.credited + row.m.pending));
      const open = [
        selected.pending > 0 && `${lakh(selected.pending)} to create`,
        showCd && selected.cdShort > 0 && `${selected.cdShort} short payments to review`,
        selected.notSent > 0 && `${selected.notSent} WhatsApp not sent`,
        selected.failed > 0 && `${selected.failed} WhatsApp failed`,
        selected.einvoicePending > 0 && `${selected.einvoicePending} e-Invoice pending`,
        selected.notCreated > 0 && `${selected.notCreated} failed in Tally`,
      ].filter(Boolean) as string[];
      const miniBars = (values: number[], max: number, tone: string) => <span className="fd-mini">{QUARTERS.map((q, index) => <span key={q.key} className={column === q.key ? "is-selected" : ""} title={`${q.label}: ${lakh(values[index])}`}><i className={tone} style={{ height: `${Math.max(3, (values[index] / max) * 100)}%` }} /><small>{q.label}</small></span>)}</span>;
      return <div className="fd-tiles">
        <button type="button" className="fd-tile" onClick={() => openDetails("fd-quarters")}>
          <span className="fd-tile-title">Credited vs to create</span>
          <span className="fd-tile-row"><span className="fd-ring" style={{ ["--p" as string]: creditedShare }}><strong>{creditedShare}%</strong></span>
            <span className="fd-tile-facts"><span><i className="is-credited" />Credited <strong>{lakh(selected.credited)}</strong></span><span><i className="is-pending" />To create <strong>{lakh(selected.pending)}</strong></span></span></span>
        </button>
        {showTod && <button type="button" className="fd-tile" onClick={() => openDetails("fd-quarters")}>
          <span className="fd-tile-title">Turnover Discount</span>
          <strong className="fd-tile-value">{lakh(selected.todEarned)}</strong>
          <span className="fd-tile-sub">{selected.todQualified} customers qualified</span>
          {miniBars(QUARTERS.map((q) => byColumn[q.key].todEarned), todMax, "is-tod")}
        </button>}
        {showCd && <button type="button" className="fd-tile" onClick={() => openDetails("fd-quarters")}>
          <span className="fd-tile-title">Cash Discount</span>
          <strong className="fd-tile-value">{lakh(selected.cdEarned)}</strong>
          <span className="fd-tile-sub">{selected.cdChecked.toLocaleString("en-IN")} invoices · paid on time {onTime(selected)}</span>
          {miniBars(QUARTERS.map((q) => byColumn[q.key].cdEarned), cdMax, "is-cd")}
        </button>}
        <button type="button" className="fd-tile" onClick={() => openDetails("fd-open")}>
          <span className="fd-tile-title">WhatsApp</span>
          <span className="fd-tile-row"><span className="fd-ring is-blue" style={{ ["--p" as string]: sentShare }}><strong>{selected.issuedCount ? `${sentShare}%` : "—"}</strong></span>
            <span className="fd-tile-facts"><span>Sent <strong>{selected.sent}</strong></span><span>Not sent <strong>{selected.notSent}</strong></span>{selected.failed > 0 && <span className="is-alert">Failed <strong>{selected.failed}</strong></span>}</span></span>
        </button>
        <button type="button" className="fd-tile fd-tile-wide" onClick={() => openDetails("fd-groups")}>
          <span className="fd-tile-title">Top groups</span>
          {topGroups.length ? <span className="fd-hbars">{topGroups.map((row) => { const total = row.m.credited + row.m.pending; return <span key={row.name}><span className="fd-hbar-name">{row.name}</span><span className="fd-hbar-track"><i className="is-credited" style={{ width: `${(row.m.credited / groupMax) * 100}%` }} /><i className="is-pending" style={{ width: `${(row.m.pending / groupMax) * 100}%` }} /></span><strong>{lakh(total)}</strong></span>; })}</span> : <span className="fd-tile-sub">No activity</span>}
        </button>
        <button type="button" className={`fd-tile${open.length ? " is-open" : ""}`} onClick={() => openDetails("fd-open")}>
          <span className="fd-tile-title">Open</span>
          <strong className="fd-tile-value">{open.length || "✓"}</strong>
          <span className="fd-tile-sub">{open.length ? open.slice(0, 3).join(" · ") : "Nothing open"}</span>
        </button>
      </div>;
    })() : <>
    <button type="button" className="fd-back" onClick={() => setMode("overview")}>← Overview</button>

    {/* Level 2: the headline for the selection. */}
    <div className="fd-kpis">
      <div><span>Credited</span><strong>{lakh(selected.credited)}</strong><small>{selected.creditedCount} Credit Notes</small></div>
      <div><span>To create</span><strong>{lakh(selected.pending)}</strong>{showTod && showCd && <small>Turnover {lakh(selected.todPending)} · Cash {lakh(selected.cdPending)}</small>}</div>
      {showCd && <div><span>Paid on time</span><strong>{onTime(selected)}</strong><small>Cash Discount</small></div>}
    </div>

    <div className="fd-grid">
      {/* Level 3a: the quarter grid. */}
      <section className="fd-card fd-quarters" aria-labelledby="fd-quarters">
        <header><h2 id="fd-quarters">{fyLabel(data.fy)}</h2>{group !== "all" && <span>{group}</span>}</header>
        <table>
          <thead><tr><th />{columns.map((key) => <th key={key} className={column === key ? "is-selected" : ""}>{key === "fy" ? "Year" : QUARTERS.find((q) => q.key === key)!.label}{key !== "fy" && !quarterEnded(key) ? <small>running</small> : null}</th>)}</tr></thead>
          <tbody>{rowsSpec.filter((row) => row.show).flatMap((row, index) => [
            ...(row.section ? [<tr key={`section-${index}`} className="fd-section"><th colSpan={columns.length + 1}>{row.section}</th></tr>] : []),
            <tr key={`row-${index}`} className={row.strong ? "is-strong" : ""}><th>{row.label}</th>{columns.map((key) => <td key={key} className={column === key ? "is-selected" : ""}>{row.value(byColumn[key])}</td>)}</tr>,
          ])}</tbody>
        </table>
      </section>

      <aside className="fd-card fd-open" aria-labelledby="fd-open">
        <header><h2 id="fd-open">Open</h2></header>
        {(() => {
          const items = [
            { show: selected.pending > 0, href: showTod && !showCd ? "/turnover-discount" : "/cash-discount", label: "To create", value: lakh(selected.pending), tone: "" },
            { show: showCd && selected.cdShort > 0, href: "/cash-discount", label: "Short payments to review", value: String(selected.cdShort), tone: "" },
            { show: selected.notSent > 0, href: "/credit-notes", label: "WhatsApp not sent", value: String(selected.notSent), tone: "is-warn" },
            { show: selected.failed > 0, href: "/messages", label: "WhatsApp failed", value: String(selected.failed), tone: "is-alert" },
            { show: selected.einvoicePending > 0, href: "/credit-notes", label: "e-Invoice pending", value: String(selected.einvoicePending), tone: "is-warn" },
            { show: selected.notCreated > 0, href: "/credit-notes", label: "Failed in Tally", value: String(selected.notCreated), tone: "is-alert" },
          ].filter((item) => item.show);
          return items.length ? <ul>{items.map((item) => <li key={item.label}><Link href={item.href}><span>{item.label}</span><strong className={item.tone}>{item.value}</strong></Link></li>)}</ul> : <p className="fd-clear">Nothing open.</p>;
        })()}
        <p className="fd-deadline">GST deadline · <strong>{formatDate(`${gstLastDate}T00:00:00`).split(",")[0]}</strong></p>
      </aside>
    </div>

    <div>
      {/* Level 3c: customer groups. */}
      <section className="fd-card fd-groups" aria-labelledby="fd-groups">
        <header><h2 id="fd-groups">Groups</h2><span>{column === "fy" ? fyLabel(data.fy) : QUARTERS.find((q) => q.key === column)!.label}</span></header>
        {groupRows.length ? <div className="fd-scroll"><table>
          <thead><tr><th>Group</th>{showTod && <th>Turnover earned</th>}{showCd && <th>Cash earned</th>}<th>Credited</th><th>To create</th>{showCd && <th>Paid on time</th>}</tr></thead>
          <tbody>
            {groupRows.map(({ name, m }) => <tr key={name} className={group === name ? "is-selected" : ""} onClick={() => setGroup(group === name ? "all" : name)}>
              <th>{name}</th>{showTod && <td>{m.todEarned ? lakh(m.todEarned) : "—"}</td>}{showCd && <td>{m.cdEarned ? lakh(m.cdEarned) : "—"}</td>}
              <td className="is-strong">{m.credited ? lakh(m.credited) : "—"}</td><td>{m.pending ? lakh(m.pending) : "—"}</td>
              {showCd && <td>{onTime(m)}</td>}
            </tr>)}
          </tbody>
        </table></div> : <p className="fd-note">No activity for this selection.</p>}
      </section>


    </div>
    </>}
  </div>;
}
