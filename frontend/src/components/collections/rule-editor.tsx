"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import type { ReferenceData, Scheme, VersionDetail } from "./types";
import { Button, Drawer, IconButton } from "./ui";
import { accessToken } from "./workspace";
import studio from "./rulebook-studio.module.css";

type CreatedRule = { schemeId: string; versionId: string };
type CashDiscountSlab = { days: number; percentage: string };
type Props = {
  open: boolean;
  scheme: Scheme | null;
  source: VersionDetail | null;
  reference: ReferenceData | null;
  onClose: () => void;
  onSaved: (created: CreatedRule) => Promise<void>;
  onError: (message: string | null) => void;
};

const today = () => new Date().toISOString().slice(0, 10);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
function addMonths(date: string, months: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  return isoDate(parsed);
}
function previousDay(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return isoDate(parsed);
}
function nextDay(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return isoDate(parsed);
}
function nextTodPeriodStart(source: VersionDetail) {
  const months = source.version.periodMonths ?? 1;
  let candidate = source.version.periodAnchorDate ?? source.version.effectiveFrom;
  const minimum = today();
  while (candidate <= minimum || candidate <= source.version.effectiveFrom) candidate = addMonths(candidate, months);
  return candidate;
}
const defaultSlabs: CashDiscountSlab[] = [
  { days: 7, percentage: "1.5" },
  { days: 15, percentage: "1" },
];

function normalizedSlabs(source: VersionDetail | null): CashDiscountSlab[] {
  const savedSlabs = source?.configuration.cdSlabs;
  if (!savedSlabs?.length) return defaultSlabs.map((slab) => ({ ...slab }));

  return savedSlabs.map((slab) => ({
    days: Number.isFinite(Number(slab.allowedWorkingDays)) ? Number(slab.allowedWorkingDays) : 0,
    percentage: slab.percentage == null ? "" : String(slab.percentage),
  }));
}

export function RuleEditor({ open, scheme, source, reference, onClose, onSaved, onError }: Props) {
  const { company } = useCompany();
  const updating = Boolean(scheme && source);
  const editingDraft = source?.version.status === "draft";
  const preparingUpdate = source?.version.status === "active";
  const [ruleType, setRuleType] = useState<"cd" | "tod">("cd");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [slabs, setSlabs] = useState<CashDiscountSlab[]>(() => defaultSlabs.map((slab) => ({ ...slab })));
  const [checkNarration, setCheckNarration] = useState(true);
  const [periodMonths, setPeriodMonths] = useState("1");
  const [periodAnchorDate, setPeriodAnchorDate] = useState(today());
  const [todBenefitBasis, setTodBenefitBasis] = useState<"percentage_of_eligible_value" | "amount_per_eligible_tonne">("percentage_of_eligible_value");
  const [busy, setBusy] = useState(false);

  const sourceVersionId = source?.version.id ?? null;

  useEffect(() => {
    if (!open) return;

    const type = scheme?.schemeType ?? "cd";
    const months = source?.version.periodMonths ?? 1;
    const nextStart = source && preparingUpdate && type === "tod" ? nextTodPeriodStart(source) : null;
    const updateStart = source && preparingUpdate && type === "cd"
      ? source.version.effectiveTo ? nextDay(source.version.effectiveTo) : today()
      : null;
    setRuleType(type);
    setEffectiveFrom(nextStart ?? updateStart ?? source?.version.effectiveFrom ?? today());
    setEffectiveTo(nextStart ? previousDay(addMonths(nextStart, months)) : editingDraft ? source?.version.effectiveTo ?? "" : "");
    setSlabs(normalizedSlabs(source));
    setCheckNarration(source?.version.checkNarration ?? true);
    setPeriodMonths(String(months));
    setPeriodAnchorDate(nextStart ?? source?.version.periodAnchorDate ?? today());
    setTodBenefitBasis(source?.version.todBenefitBasis ?? "percentage_of_eligible_value");
  }, [open, sourceVersionId, scheme?.id, editingDraft, preparingUpdate]);

  function updateSlab(index: number, patch: Partial<CashDiscountSlab>) {
    setSlabs((current) => current.map((slab, slabIndex) => slabIndex === index ? { ...slab, ...patch } : slab));
  }

  async function submit(form: HTMLFormElement) {
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (ruleType === "cd" && (!slabs.length || slabs.some((slab) => !slab.percentage || slab.days < 0))) {
      onError("Add at least one valid payment window.");
      return;
    }

    const token = await accessToken();
    if (!token) return;
    const fields = new FormData(form);
    setBusy(true);
    onError(null);
    try {
      const common = {
        effectiveFrom,
        effectiveTo: effectiveTo || null,
        copyFromVersionId: preparingUpdate ? source?.version.id : undefined,
      };
      const businessTerms = ruleType === "cd"
        ? {
            slabs: [...slabs]
              .sort((left, right) => left.days - right.days)
              .map((slab) => ({ allowedWorkingDays: slab.days, percentage: slab.percentage })),
            checkNarration,
          }
        : { periodMonths: Number(periodMonths), periodAnchorDate, todBenefitBasis };

      if (!scheme) {
        const result = await apiRequest<{ scheme: Scheme; version: { id: string } }>(token, `/api/companies/${company.id}/schemes`, {
          method: "POST",
          headers: { "Idempotency-Key": globalThis.crypto.randomUUID() },
          body: jsonBody({
            schemeType: ruleType,
            code: fields.get("code"),
            name: fields.get("name"),
            description: fields.get("description") || null,
            initialRule: {
              ...common,
              copyFromVersionId: undefined,
              ...businessTerms,
              creditNoteVoucherTypeId: ruleType === "tod" ? fields.get("voucherType") : null,
              discountLedgerId: ruleType === "tod" ? fields.get("ledger") : null,
            },
          }),
        });
        await onSaved({ schemeId: result.scheme.id, versionId: result.version.id });
        return;
      }

      const result = editingDraft && source
        ? await apiRequest<{ version: { id: string } }>(token, `/api/companies/${company.id}/scheme-versions/${source.version.id}`, {
            method: "PATCH",
            body: jsonBody({ ...common, copyFromVersionId: undefined, ...businessTerms }),
          })
        : await apiRequest<{ version: { id: string } }>(token, `/api/companies/${company.id}/schemes/${scheme.id}/versions`, {
            method: "POST",
            body: jsonBody({ ...common, ...businessTerms }),
          });
      await onSaved({ schemeId: scheme.id, versionId: result.version.id });
    } catch (cause) {
      const prefix = updating
        ? editingDraft ? "Could not save these changes." : "Could not start editing this rule."
        : "Could not create this rule. Nothing was saved.";
      onError(userFacingError(cause, prefix));
    } finally {
      setBusy(false);
    }
  }

  const selectedType = scheme?.schemeType ?? ruleType;
  const selectedGroupIds = new Set(source?.configuration.customerGroups.map((group) => group.customer_group_id) ?? []);
  const selectedGroupNames = reference?.masters.customerGroups
    .filter((group) => selectedGroupIds.has(group.id))
    .map((group) => group.name ?? group.ledger_name ?? group.code ?? "Unnamed group") ?? [];
  const groupSummary = selectedGroupNames.length
    ? selectedGroupNames.join(", ")
    : selectedGroupIds.size
      ? `${selectedGroupIds.size} customer ${selectedGroupIds.size === 1 ? "group" : "groups"}`
      : updating
        ? "No customer groups selected"
        : "Choose after saving the rule";

  return <Drawer
    open={open}
    onClose={onClose}
    title={scheme ? "Edit rule" : "Create discount rule"}
    description={scheme ? "Save your changes, confirm eligibility, then apply them when ready." : "Set the terms first. You will choose eligible customers and products next."}
    width="wide"
  >
    <form className="form-stack rule-editor-form" noValidate onSubmit={(event) => {
      event.preventDefault();
      void submit(event.currentTarget);
    }}>
      <div className={studio.editorJourney} aria-label="Rule setup steps">
        <div className={studio.editorStep} data-active="true"><span>1</span><div><strong>Terms</strong><small>Dates and discounts</small></div></div>
        <div className={studio.editorStep}><span>2</span><div><strong>Eligibility</strong><small>Customers and products</small></div></div>
        <div className={studio.editorStep}><span>3</span><div><strong>Review</strong><small>Check and apply</small></div></div>
      </div>
      {!scheme && <>
        <div className="rule-type-choice" role="radiogroup" aria-label="Discount type">
          <label className={selectedType === "cd" ? "selected" : ""}>
            <input type="radio" checked={selectedType === "cd"} onChange={() => setRuleType("cd")} />
            <strong>Cash Discount</strong>
            <span>Check invoice payment deadlines.</span>
          </label>
          <label className={selectedType === "tod" ? "selected" : ""}>
            <input type="radio" checked={selectedType === "tod"} onChange={() => setRuleType("tod")} />
            <strong>Turnover Discount</strong>
            <span>Check quantity achieved during a period.</span>
          </label>
        </div>
        <div className="form-grid">
          <label>Rule name<input name="name" required placeholder={selectedType === "cd" ? "Standard Cash Discount" : "Annual Turnover Discount"} /></label>
          <label>Rule reference<input name="code" required pattern="[A-Za-z][A-Za-z0-9_-]*" placeholder={selectedType === "cd" ? "CD_STANDARD" : "TOD_ANNUAL"} title="Start with a letter. Use letters, numbers, underscores, or hyphens only." /></label>
          <label>Team note <small>(optional)</small><input name="description" placeholder="Short internal note" /></label>
          {selectedType === "tod" && <>
            <label>Credit Note voucher type<select name="voucherType" required disabled={!reference}><option value="">{reference ? "Select current master" : "Sync Tally masters first"}</option>{reference?.masters.voucherTypes.filter((item) => item.is_available && item.is_credit_note_type).map((item) => <option key={item.id} value={item.id}>{item.name ?? item.ledger_name ?? item.code ?? "Credit Note"}</option>)}</select></label>
            <label>Discount ledger<select name="ledger" required disabled={!reference}><option value="">{reference ? "Select current master" : "Sync Tally masters first"}</option>{reference?.masters.ledgers.filter((item) => item.is_available && String(item.gst_applicability).toLowerCase() === "not applicable").map((item) => <option key={item.id} value={item.id}>{item.name ?? item.ledger_name ?? item.code ?? "Discount ledger"}</option>)}</select></label>
          </>}
        </div>
        {!reference && <p className="muted-copy">Update company information from Tally before creating a rule. TOD rules require a live Credit Note type and GST-exempt discount ledger; CD recovery uses Tally Debit Notes from the source invoice.</p>}
      </>}

      <section className="rule-editor-section rule-editor-period">
        <h3>Active period</h3>
        <p className="muted-copy">{preparingUpdate || editingDraft ? "The current rule stays in use until you apply these changes." : "Only transactions inside this date range are evaluated by this rule."}</p>
        <div className="form-grid">
          <label>Starts<input type="date" required value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>
          <label>Ends <small>(optional)</small><input type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></label>
        </div>
      </section>

      {selectedType === "cd" ? <>
        <section className="rule-editor-section rule-editor-windows">
          <div className="rule-editor-section-heading">
            <div><h3>Payment windows</h3><p>Earlier matching windows take priority.</p></div>
            <Button type="button" className="button-secondary rule-editor-add" onClick={() => setSlabs((current) => [
              ...current,
              { days: (current.at(-1)?.days ?? 0) + 7, percentage: "" },
            ])}><Plus size={15} />Add window</Button>
          </div>
          <div className="cd-slab-editor">
            {slabs.map((slab, index) => <div className="cd-slab-row" key={index}>
              <span className="cd-slab-index">{index + 1}</span>
              <label>Pay within<div className="input-with-suffix"><input type="number" min="0" max="366" required value={slab.days} onChange={(event) => updateSlab(index, { days: Number(event.target.value) })} /><span>days</span></div></label>
              <label>Discount<div className="input-with-suffix"><input inputMode="decimal" required value={slab.percentage} onChange={(event) => updateSlab(index, { percentage: event.target.value })} /><span>%</span></div></label>
              <IconButton label={`Remove payment window ${index + 1}`} disabled={slabs.length === 1} onClick={() => setSlabs((current) => current.filter((_, slabIndex) => slabIndex !== index))}><Trash2 size={16} /></IconButton>
            </div>)}
          </div>
        </section>

        <section className="rule-editor-section rule-editor-scope">
          <h3>Applies to</h3>
          <dl className="rule-editor-scope-list">
            <div><dt>Customer groups</dt><dd>{groupSummary}</dd></div>
            <div><dt>Working days</dt><dd>Meenakshi business calendar</dd></div>
          </dl>
          <label className="switch-field rule-editor-switch"><input type="checkbox" checked={checkNarration} onChange={(event) => setCheckNarration(event.target.checked)} /><span><strong>Check invoice narration</strong><small>Use Cash Discount terms written on the invoice when available.</small></span></label>
          <p className="rule-editor-scope-note">Customer groups are selected in the next step.</p>
        </section>
      </> : <section className="rule-editor-section">
        <h3>Turnover period</h3>
        <div className="form-grid">
          <label>Review every<div className="input-with-suffix"><input type="number" min="1" max="36" required value={periodMonths} onChange={(event) => setPeriodMonths(event.target.value)} /><span>months</span></div></label>
          <label>First period starts<input type="date" required value={periodAnchorDate} onChange={(event) => setPeriodAnchorDate(event.target.value)} /></label>
        </div>
        <fieldset className={studio.benefitChoice}><legend>Benefit calculation</legend><label className={todBenefitBasis === "amount_per_eligible_tonne" ? studio.benefitOptionSelected : studio.benefitOption}><input type="radio" name="todBenefitBasis" checked={todBenefitBasis === "amount_per_eligible_tonne"} disabled={editingDraft && source.configuration.tiers.length > 0} onChange={() => setTodBenefitBasis("amount_per_eligible_tonne")} /><span><strong>Fixed amount per MT</strong><small>Apply the reached slab rate to the full eligible quantity.</small></span></label><label className={todBenefitBasis === "percentage_of_eligible_value" ? studio.benefitOptionSelected : studio.benefitOption}><input type="radio" name="todBenefitBasis" checked={todBenefitBasis === "percentage_of_eligible_value"} disabled={editingDraft && source.configuration.tiers.length > 0} onChange={() => setTodBenefitBasis("percentage_of_eligible_value")} /><span><strong>Percentage of eligible sales value</strong><small>Apply the reached percentage to eligible sales value before GST.</small></span></label>{editingDraft && source.configuration.tiers.length > 0 && <small className={studio.benefitHint}>Remove the saved levels before changing this calculation method.</small>}</fieldset>
      </section>}

      <div className={studio.editorFooter}>
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : scheme ? "Save and continue" : "Create rule and continue"}</Button>
      </div>
    </form>
  </Drawer>;
}
