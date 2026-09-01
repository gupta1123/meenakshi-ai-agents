"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";

import { notificationStatusLabel, staffStatusLabel, toneForStaffStatus, type StatusTone } from "@/lib/staff-status";
import { userFacingDetail } from "@/lib/user-copy";

export function StatusBadge({ status, children }: { status: string; children?: ReactNode }) {
  const tone = toneForStaffStatus(status);
  return <span className={`status-badge tone-${tone}`}><span aria-hidden="true" />{children ?? staffStatusLabel(status)}</span>;
}

export function NotificationStatusBadge({ status }: { status: string }) {
  const tone = toneForStaffStatus(status);
  return <span className={`status-badge tone-${tone}`}><span aria-hidden="true" />{notificationStatusLabel(status)}</span>;
}

export function Button({ className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`} {...props}>{children}</button>;
}

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`surface-card ${className}`}>{children}</section>;
}

export function SectionHeading({ eyebrow, title, detail, action }: { eyebrow?: string; title: string; detail?: string; action?: ReactNode }) {
  return <div className="section-heading">
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {detail && <p className="section-detail">{detail}</p>}
    </div>
    {action && <div className="section-action">{action}</div>}
  </div>;
}

export function MetricCard({ label, value, detail, tone = "neutral", icon }: { label: string; value: string | number; detail: string; tone?: StatusTone; icon: ReactNode }) {
  return <Card className={`metric-card metric-${tone}`}>
    <div className="metric-icon">{icon}</div>
    <p>{label}</p>
    <strong>{value}</strong>
    <span>{detail}</span>
  </Card>;
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><strong>{title}</strong><p>{detail}</p>{action && <div>{action}</div>}</div>;
}

export function Skeleton({ lines = 3, className = "", style }: { lines?: number; className?: string; style?: React.CSSProperties }) {
  if (lines === 1) {
    return <span className={`skeleton-block ${className}`} style={{ display: "inline-block", background: "#ece7de", borderRadius: 6, animation: "pulse 1.1s ease-in-out infinite alternate", ...style }} aria-hidden="true" />;
  }
  return <div className={`skeleton ${className}`} style={style} aria-label="Loading content">{Array.from({ length: lines }, (_, index) => <span key={index} style={{ width: `${88 - index * 13}%` }} />)}</div>;
}

export function InlineMessage({ tone = "info", children }: { tone?: "info" | "success" | "error" | "warning"; children: ReactNode }) {
  const copy = tone === "error" && typeof children === "string" ? userFacingDetail(children, "Something needs attention. Please try again.") : children;
  return <div className={`inline-message message-${tone}`} role={tone === "error" ? "alert" : "status"}>{copy}</div>;
}

export function Drawer({ open, onClose, title, description, children, width = "normal" }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; width?: "normal" | "wide" }) {
  if (!open) return null;
  return <div className="drawer-layer" role="presentation">
    <button className="drawer-backdrop" aria-label="Close panel" onClick={onClose} />
    <aside className={`drawer drawer-${width}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="drawer-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><IconButton label="Close panel" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="drawer-body">{children}</div>
    </aside>
  </div>;
}

export function Dialog({ open, onClose, title, description, children, width = "normal" }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; width?: "normal" | "wide" }) {
  if (!open) return null;
  return <div className="dialog-layer" role="presentation">
    <button className="dialog-backdrop" aria-label="Close dialog" onClick={onClose} />
    <section className={`dialog dialog-${width}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><IconButton label="Close dialog" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="dialog-body">{children}</div>
    </section>
  </div>;
}

export function formatDate(value: string | null | undefined, fallback = "Not yet") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatMoney(value: string | number | null | undefined) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount) : "Amount unavailable";
}

export function formatTonnes(value: string | number | null | undefined) {
  const tonnes = Number(value ?? 0);
  return Number.isFinite(tonnes) ? new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(tonnes) : "0";
}

export function labelFor(value: { name?: string; ledger_name?: string; code?: string; id: string }) {
  return value.name ?? value.ledger_name ?? value.code ?? value.id;
}

export function safePhone(value: string | null | undefined) {
  if (!value) return "No controlled number";
  const tail = value.replace(/\D/g, "").slice(-4);
  return tail ? `•••• ${tail}` : "Controlled number";
}
