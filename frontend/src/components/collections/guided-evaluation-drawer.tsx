"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import type { LocalTodPeriod } from "@/lib/local-tally";
import type { TodPeriodSelection } from "@/lib/tod-results";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import type { EvaluationRun } from "./types";
import { Button, Drawer, InlineMessage, StatusBadge } from "./ui";
import { accessToken } from "./workspace";

type TodPeriodOption = LocalTodPeriod & { calculated: boolean; schemeVersionId: string };
type Props = { open: boolean; onClose: () => void; scheme: "cd" | "tod"; activeRun?: EvaluationRun | null; localPhase?: "reading" | "saving" | null; onComplete: (message: string, run: EvaluationRun) => Promise<void>; onError: (message: string | null) => void; onCashDiscountSubmit?: (evaluatedOn: string) => Promise<void>; onTurnoverDiscountSubmit?: (period: TodPeriodSelection) => Promise<void>; onTurnoverDiscountBatchSubmit?: (periods: TodPeriodSelection[]) => Promise<void>; turnoverPeriods?: TodPeriodOption[] };
const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-${Date.now()}`;
const periodDate = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function GuidedEvaluationDrawer({ open, onClose, scheme, activeRun = null, localPhase = null, onComplete, onError, onCashDiscountSubmit, onTurnoverDiscountSubmit, onTurnoverDiscountBatchSubmit, turnoverPeriods = [] }: Props) {
  const { company } = useCompany();
  const today = new Date().toISOString().slice(0, 10);
  // The local Tally connector supports an evaluation-date override for
  // controlled testing. Keep this affordance out of deployed environments,
  // while still showing it when the local frontend is served from a
  // production build (`next start`).
  const allowTestDate = process.env.NEXT_PUBLIC_ENABLE_EVALUATION_DATE_OVERRIDE === "true";
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedPeriodKey, setSelectedPeriodKey] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setRun(null);
      setFormError(null);
      setBatchBusy(false);
    } else if (scheme === "tod") {
      const preferred = turnoverPeriods.find((period) => period.state === "current") ?? [...turnoverPeriods].reverse().find((period) => period.state === "completed");
      setSelectedPeriodKey((current) => turnoverPeriods.some((period) => period.key === current && period.state !== "upcoming") ? current : preferred?.key ?? "");
    }
  }, [open, scheme, turnoverPeriods]);

  async function submit(form: HTMLFormElement) {
    const fields = new FormData(form);
    setBusy(true);
    setFormError(null);
    onError(null);
    try {
      const evaluatedOn = allowTestDate ? String(fields.get("evaluatedOn") || today) : today;
      if (scheme === "cd" && onCashDiscountSubmit) {
        await onCashDiscountSubmit(evaluatedOn);
        return;
      }
      if (scheme === "tod" && onTurnoverDiscountSubmit) {
        const selected = turnoverPeriods.find((period) => period.key === String(fields.get("periodKey") || selectedPeriodKey));
        if (!selected || selected.state === "upcoming") throw new Error("Choose a completed or current calculation period.");
        await onTurnoverDiscountSubmit({ start: selected.start, end: selected.end, asOfDate: selected.state === "current" ? today : selected.end, selectedSchemeVersionId: selected.schemeVersionId });
        return;
      }
      const token = await accessToken();
      if (!token) return;
      const body = scheme === "cd"
        ? { batch: true, evaluatedOn }
        : { batch: true, asOfDate: fields.get("asOfDate"), evaluatedOn: today };
      const response = await apiRequest<{ evaluationRun: EvaluationRun }>(token, `/api/companies/${company.id}/evaluations/${scheme}`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey() }, body: jsonBody(body) });
      setRun(response.evaluationRun);
      await onComplete(scheme === "tod" ? "Calculation started for all customers covered by the active rule." : "Cash Discount check started using current Tally information.", response.evaluationRun);
    } catch (cause) {
      const message = userFacingError(cause, "Could not start the calculation.");
      setFormError(message);
      onError(message);
    } finally { setBusy(false); }
  }

  const duePeriods = turnoverPeriods.filter((period) => period.state === "completed" && !period.calculated);
  async function calculateDuePeriods() {
    if (!onTurnoverDiscountBatchSubmit || !duePeriods.length) return;
    setBatchBusy(true);
    setFormError(null);
    onError(null);
    try {
      await onTurnoverDiscountBatchSubmit(duePeriods.map((period) => ({ start: period.start, end: period.end, asOfDate: period.end, selectedSchemeVersionId: period.schemeVersionId })));
    } catch (cause) {
      const message = userFacingError(cause, "Could not calculate every due period.");
      setFormError(message);
      onError(message);
    } finally { setBatchBusy(false); }
  }

  const visibleRun = run ?? activeRun;
  const completed = !localPhase && visibleRun?.status === "completed";
  const progressing = Boolean(localPhase) || Boolean(visibleRun);

  return <Drawer open={open} onClose={onClose} title={scheme === "tod" ? "Calculate Turnover Discounts" : "Check Cash Discounts"} description="Update the saved list using current Tally data." width={scheme === "tod" ? "wide" : "normal"}>
    {progressing ? <section className={`run-progress${completed ? " is-complete" : ""}`}>
      <span className="run-icon" aria-hidden="true">{completed ? <CheckCircle2 size={22} /> : <LoaderCircle className="spin" size={22} />}</span>
      <div>
        <StatusBadge status={localPhase === "saving" ? "posting" : visibleRun?.status ?? "evaluating"} />
        <h3>{localPhase === "saving" ? "Saving verified results" : completed ? (scheme === "cd" ? "Cash Discount check completed" : "Calculation completed") : "Checking latest Tally"}</h3>
        <p>{localPhase === "saving" ? "The Tally check is complete. Actions will unlock after this snapshot is saved." : completed ? "The latest result has been saved and is ready to review." : "Your current results remain visible while this check finishes."}</p>
        {completed && <Button className="button-secondary run-progress-action" onClick={onClose}>View results</Button>}
      </div>
    </section> : <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
      {formError && <InlineMessage tone="error">{formError}</InlineMessage>}
      {scheme === "cd" ? <><InlineMessage tone="info">Uses the active rule. This refresh does not send WhatsApp.</InlineMessage>{allowTestDate && <details className="test-date-details"><summary>Test a future payment deadline <small>Local testing only</small></summary><div className="test-date-panel"><label>Check as of<input name="evaluatedOn" type="date" defaultValue={today} min={today} required /></label><p>Use a date after the invoice’s payment deadline to preview the Debit Note recovery flow. This does not change Tally or the active rule.</p></div></details>}</> : <><InlineMessage tone="info">Each period is calculated independently. Quantities never carry into another period.</InlineMessage><fieldset className="tod-period-picker"><legend>Calculation period</legend>{turnoverPeriods.map((period) => <label key={period.key} className={`tod-period-option is-${period.state}${selectedPeriodKey === period.key ? " is-selected" : ""}`}><input type="radio" name="periodKey" value={period.key} checked={selectedPeriodKey === period.key} disabled={period.state === "upcoming"} onChange={() => setSelectedPeriodKey(period.key)} /><span><strong>{periodDate(period.start)} – {periodDate(period.end)}</strong><small>{period.state === "current" ? "Current · projected result" : period.state === "upcoming" ? "Upcoming · unavailable" : period.calculated ? "Completed · calculated" : "Completed · calculation due"}</small></span></label>)}</fieldset></>}
      <Button type="submit" disabled={busy || batchBusy || (scheme === "tod" && !selectedPeriodKey)}>{busy ? "Starting calculation…" : scheme === "tod" ? "Calculate selected period" : "Check Cash Discounts now"}</Button>
      {scheme === "tod" && (duePeriods.length ? <Button type="button" className="button-secondary" disabled={busy || batchBusy} onClick={() => void calculateDuePeriods()}>{batchBusy ? "Calculating due periods…" : `Calculate all due periods (${duePeriods.length})`}</Button> : <p className="tod-period-complete">All completed periods already have a saved calculation.</p>)}
    </form>}
  </Drawer>;
}
