"use client";

import { AlertTriangle, CheckCircle2, Pencil, Settings2 } from "lucide-react";

import type { ReferenceData, VersionDetail } from "./types";
import { Button } from "./ui";
import studio from "./rulebook-studio.module.css";

export type ActivationValidation = {
  valid: boolean;
  issues?: Array<{ code?: string; message?: string }>;
};

type Props = {
  detail: VersionDetail;
  reference: ReferenceData | null;
  validation: ActivationValidation | null;
  allowReplacementOverlap?: boolean;
  busy?: "validate" | "activate" | null;
  onEditTerms: () => void;
  onDraftSetup: () => void;
  onValidate: () => void;
  onActivate: () => void;
};

function issueMessage(issue: { code?: string; message?: string }) {
  return issue.message ?? "This change needs more information before it can be applied.";
}

function businessDate(value: string) {
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function masterName(item: { name?: string | null; ledger_name?: string | null; code?: string | null } | undefined, fallback: string) {
  return item?.name ?? item?.ledger_name ?? item?.code ?? fallback;
}

function NameList({ names, empty }: { names: string[]; empty: string }) {
  if (!names.length) return <span className={studio.factEmpty}>{empty}</span>;
  return <span className={studio.factNames}>{names.map((name, index) => <span key={`${name}-${index}`}>{name}</span>)}</span>;
}

function reviewFrequency(months: number | null) {
  if (months === 1) return "Monthly";
  if (months === 3) return "Quarterly";
  if (months === 6) return "Half-yearly";
  if (months === 12) return "Annually";
  return `Every ${months ?? 1} months`;
}

export function GuidedVersionSummary({ detail, reference, validation, allowReplacementOverlap = false, busy = null, onEditTerms, onDraftSetup, onValidate, onActivate }: Props) {
  const { version } = detail;
  const isDraft = version.status === "draft";
  const today = new Date().toISOString().slice(0, 10);
  const startsLater = version.effectiveFrom > today;
  const issues = validation?.valid === false ? validation.issues ?? [] : [];
  const replacementOverlapOnly = allowReplacementOverlap && issues.length > 0 && issues.every((issue) => issue.code === "customer_group_coverage_overlap");
  const canApply = Boolean(validation?.valid || replacementOverlapOnly);
  const period = version.effectiveTo
    ? `${businessDate(version.effectiveFrom)} – ${businessDate(version.effectiveTo)}`
    : `${isDraft ? "Starts" : "Active since"} ${businessDate(version.effectiveFrom)}`;
  const paymentTerms = detail.configuration.cdSlabs
    .map((slab) => `${slab.percentage}% within ${slab.allowedWorkingDays} working ${slab.allowedWorkingDays === 1 ? "day" : "days"}`)
    .join(" · ");
  const tierTerms = detail.configuration.tiers
    .map((tier) => `${tier.minimum_tonnes}t → ${version.todBenefitBasis === "amount_per_eligible_tonne" ? `₹${tier.discount_amount_per_tonne}/MT` : `${tier.discount_percentage}%`}`)
    .join(" · ");
  const groupById = new Map(reference?.masters.customerGroups.map((item) => [item.id, item]) ?? []);
  const stockItemById = new Map(reference?.masters.stockItems.map((item) => [item.id, item]) ?? []);
  const stockGroupById = new Map(reference?.masters.stockGroups.map((item) => [item.id, item]) ?? []);
  const customerGroupNames = detail.configuration.customerGroups.map((item) => masterName(groupById.get(item.customer_group_id), "Unavailable customer group"));
  const productNames = [
    ...detail.configuration.stockItems.map((item) => masterName(stockItemById.get(item.stock_item_id), "Unavailable product")),
    ...detail.configuration.stockGroups.map((item) => `${masterName(stockGroupById.get(item.stock_group_id), "Unavailable product group")} (group)`),
  ];

  return <section className={studio.snapshot}>
    <div className={studio.snapshotHeader}>
      <div>{isDraft && <p className="eyebrow">Draft update</p>}<h3>{period}</h3>{startsLater && <p className={studio.dateNote}>Starts {businessDate(version.effectiveFrom)}</p>}</div>
    </div>
    <div className={studio.activeSummary}>
      <dl className={studio.ruleFacts}>
        {version.schemeType === "cd" && version.cdDiscountBasis === "amount_per_tonne" ? <>
          {/* Each segment is its own card: window and rate as the heading, its groups below. */}
          <div className={studio.segmentFact}>
            <dt>Segments · {(detail.configuration.cdSegments ?? []).length}</dt>
            <dd>{(detail.configuration.cdSegments ?? []).length
              ? <span className={studio.segmentCards}>{(detail.configuration.cdSegments ?? []).map((segment, index) => <span key={segment.id ?? index} className={studio.segmentCard}>
                  <span className={studio.segmentHead}>
                    <strong>{segment.allowedWorkingDays} {segment.allowedWorkingDays === 1 ? "day" : "days"}</strong>
                    <span>₹{Number(segment.amountPerTonne).toLocaleString("en-IN")}/MT</span>
                  </span>
                  <small>{segment.label || `Segment ${index + 1}`} · {segment.customerGroupIds.length} customer group{segment.customerGroupIds.length === 1 ? "" : "s"}</small>
                  <NameList names={segment.customerGroupIds.map((id) => masterName(groupById.get(id), "Unavailable customer group"))} empty="No customer groups" />
                </span>)}</span>
              : "No segments configured"}</dd>
          </div>
          <div><dt>Eligible products</dt><dd><NameList names={productNames} empty="No products selected" /></dd></div>
          <div><dt>Deadline</dt><dd>Every day counts; moves to the next working day if it lands on a Sunday or holiday</dd></div>
        </> : version.schemeType === "cd" ? <>
          <div><dt>Payment terms</dt><dd>{paymentTerms || "No payment windows configured"}</dd></div>
          <div><dt>Customer groups</dt><dd><NameList names={customerGroupNames} empty="No customer groups selected" /></dd></div>
          <div><dt>Invoice narration</dt><dd>{version.checkNarration ? "Checked when available" : "Not checked"}</dd></div>
          <div><dt>Working days</dt><dd>Company business calendar</dd></div>
        </> : <>
          <div><dt>Review frequency</dt><dd>{reviewFrequency(version.periodMonths)} · quantities reset each period</dd></div>
          <div><dt>Calculation</dt><dd>{version.todBenefitBasis === "amount_per_eligible_tonne" ? "Highest reached ₹/MT rate × full eligible quantity" : "Highest reached percentage × full eligible sales value"}</dd></div>
          <div><dt>Discount levels</dt><dd>{tierTerms || "No levels configured"}</dd></div>
          <div><dt>Customer groups</dt><dd><NameList names={customerGroupNames} empty="No customer groups selected" /></dd></div>
          <div><dt>Eligible products</dt><dd><NameList names={productNames} empty="No products selected" /></dd></div>
        </>}
      </dl>
    </div>
    {isDraft && <div className={studio.snapshotActions}>
      <Button className="button-secondary" disabled={Boolean(busy)} onClick={onEditTerms}><Pencil size={15} />Edit terms</Button>
      <Button className="button-secondary" disabled={Boolean(busy)} onClick={onDraftSetup}><Settings2 size={15} />Edit customer groups & eligibility</Button>
      {canApply
        ? <Button disabled={Boolean(busy)} onClick={onActivate}><CheckCircle2 size={15} />{busy === "activate" ? "Applying…" : replacementOverlapOnly ? "Replace active rule" : "Apply changes"}</Button>
        : <Button disabled={Boolean(busy)} onClick={onValidate}><CheckCircle2 size={15} />{busy === "validate" ? "Checking…" : "Check changes"}</Button>}
    </div>}
    {validation?.valid && <p className="activation-ready">Everything is complete. Apply these changes when you are ready.</p>}
    {issues.length > 0 && <section className="activation-guidance" aria-live="polite">
      <div><AlertTriangle size={16} /><div><strong>{replacementOverlapOnly ? "This will replace the active rule" : "Complete before applying"}</strong></div></div>
      {replacementOverlapOnly
        ? <p>The current overlapping rule will be retired when this update is applied. Its previous results remain in history.</p>
        : <ul>{issues.map((issue, index) => <li key={`${issue.code ?? "issue"}-${index}`}>{issueMessage(issue)}</li>)}</ul>}
    </section>}
  </section>;
}
