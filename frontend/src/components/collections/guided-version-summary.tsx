"use client";

import { AlertTriangle, CheckCircle2, Pencil, Settings2 } from "lucide-react";

import type { VersionDetail } from "./types";
import { Button, StatusBadge } from "./ui";
import studio from "./rulebook-studio.module.css";

export type ActivationValidation = {
  valid: boolean;
  issues?: Array<{ code?: string; message?: string }>;
};

type Props = {
  detail: VersionDetail;
  validation: ActivationValidation | null;
  onEditTerms: () => void;
  onDraftSetup: () => void;
  onValidate: () => void;
  onActivate: () => void;
};

function issueMessage(issue: { code?: string; message?: string }) {
  return issue.message ?? "This change needs more information before it can be applied.";
}

export function GuidedVersionSummary({ detail, validation, onEditTerms, onDraftSetup, onValidate, onActivate }: Props) {
  const { version } = detail;
  const isDraft = version.status === "draft";
  const issues = validation?.valid === false ? validation.issues ?? [] : [];
  const productCount = detail.configuration.stockItems.length + detail.configuration.stockGroups.length;
  const period = `${version.effectiveFrom}${version.effectiveTo ? ` — ${version.effectiveTo}` : " onwards"}`;
  const facts = version.schemeType === "cd"
    ? `${detail.configuration.cdSlabs.length} payment windows · ${detail.configuration.customerGroups.length} customer groups`
    : `${detail.configuration.tiers.map((tier) => `${tier.minimum_tonnes}t → ${tier.discount_percentage}%`).join(" · ") || "No discount tiers"} · ${detail.configuration.customerGroups.length} groups · ${productCount} products · ${detail.configuration.conversions.length} conversions`;

  return <section className={studio.snapshot}>
    <div className={studio.snapshotHeader}>
      <div><p className="eyebrow">{isDraft ? "Pending update" : "Current rule"}</p><h3>{period}</h3></div>
      {isDraft ? <span className="status-badge status-draft">Pending update</span> : <StatusBadge status={version.status} />}
    </div>
    <div className={studio.activeSummary}>
      <span>{version.schemeType === "tod" ? `${isDraft ? "Review" : "Reviewed"} every ${version.periodMonths ?? 1} month${version.periodMonths === 1 ? "" : "s"}` : "Payment rule"}</span>
      <strong>{facts}</strong>
    </div>
    {isDraft && <div className={studio.snapshotActions}>
      <Button className="button-secondary" onClick={onEditTerms}><Pencil size={15} />Edit terms</Button>
      <Button className="button-secondary" onClick={onDraftSetup}><Settings2 size={15} />Edit customer groups & eligibility</Button>
      {validation?.valid
        ? <Button onClick={onActivate}><CheckCircle2 size={15} />Apply changes</Button>
        : <Button onClick={onValidate}>Check changes</Button>}
    </div>}
    {validation?.valid && <p className="activation-ready">Everything is complete. Apply these changes when you are ready.</p>}
    {issues.length > 0 && <section className="activation-guidance" aria-live="polite">
      <div><AlertTriangle size={16} /><div><strong>Complete before applying</strong></div></div>
      <ul>{issues.map((issue, index) => <li key={`${issue.code ?? "issue"}-${index}`}>{issueMessage(issue)}</li>)}</ul>
    </section>}
  </section>;
}
