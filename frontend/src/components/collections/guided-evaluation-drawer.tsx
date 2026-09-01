"use client";

import { useEffect, useState } from "react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import type { EvaluationRun } from "./types";
import { Button, Drawer, InlineMessage, StatusBadge } from "./ui";
import { accessToken } from "./workspace";

type Props = { open: boolean; onClose: () => void; scheme: "cd" | "tod"; activeRun?: EvaluationRun | null; onComplete: (message: string, run: EvaluationRun) => Promise<void>; onError: (message: string | null) => void; onCashDiscountSubmit?: (evaluatedOn: string) => Promise<void>; onTurnoverDiscountSubmit?: (asOfDate: string) => Promise<void> };
const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `meenakshi-${Date.now()}`;

export function GuidedEvaluationDrawer({ open, onClose, scheme, activeRun = null, onComplete, onError, onCashDiscountSubmit, onTurnoverDiscountSubmit }: Props) {
  const { company } = useCompany();
  const today = new Date().toISOString().slice(0, 10);
  // The local Tally connector supports an evaluation-date override for
  // controlled testing. Keep this affordance out of deployed environments,
  // while still showing it when the local frontend is served from a
  // production build (`next start`).
  const allowTestDate = process.env.NODE_ENV === "development"
    || /localhost|127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_API_BASE_URL ?? "");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  useEffect(() => { if (!open) setRun(null); }, [open]);

  async function submit(form: HTMLFormElement) {
    const fields = new FormData(form);
    setBusy(true);
    onError(null);
    try {
      const evaluatedOn = allowTestDate ? String(fields.get("evaluatedOn") || today) : today;
      if (scheme === "cd" && onCashDiscountSubmit) {
        await onCashDiscountSubmit(evaluatedOn);
        return;
      }
      if (scheme === "tod" && onTurnoverDiscountSubmit) {
        await onTurnoverDiscountSubmit(String(fields.get("asOfDate") || today));
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
      onError(userFacingError(cause, "Could not start the calculation."));
    } finally { setBusy(false); }
  }

  return <Drawer open={open} onClose={onClose} title={scheme === "tod" ? "Calculate Turnover Discounts" : "Check Cash Discounts"} description="Update the saved list using current Tally data." width="wide">
    {run || activeRun ? <section className="run-progress"><div><StatusBadge status={(run ?? activeRun)?.status ?? "queued"} /><h3>Checking latest Tally</h3><p>The current list stays visible until the update is saved.</p></div></section> : <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
      {scheme === "cd" ? <><InlineMessage tone="info">Uses the active rule. This refresh does not send WhatsApp.</InlineMessage>{allowTestDate && <details className="test-date-details"><summary>Test a future payment deadline <small>Local testing only</small></summary><div className="test-date-panel"><label>Check as of<input name="evaluatedOn" type="date" defaultValue={today} min={today} required /></label><p>Use a date after the invoice’s payment deadline to preview the Debit Note recovery flow. This does not change Tally or the active rule.</p></div></details>}</> : <><InlineMessage tone="info">Uses the active rule. A new tier can queue its approved WhatsApp template once when contact settings allow it.</InlineMessage><details><summary>Change calculation period</summary><label>Use the rule period containing<input name="asOfDate" type="date" defaultValue={today} required /><small>The active rule sets the calculation period.</small></label></details></>}
      <Button type="submit" disabled={busy}>{busy ? "Starting calculation…" : scheme === "tod" ? "Calculate all eligible customers" : "Check Cash Discounts now"}</Button>
    </form>}
  </Drawer>;
}
