"use client";

import { useEffect, useState } from "react";
import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";
import { Button, InlineMessage } from "./ui";
import s from "./tally-connection.module.css";

type ModeAnswer = { mode: "pc" | "server"; message?: string | null };

/**
 * Administrators choose where this company's Tally checks run: on a staff PC
 * (the browser talks to the connector on that PC) or on the Tally server (checks
 * queue in the cloud and the server's connector runs them one at a time).
 */
export function TallyModeSetting({ companyId, getToken }: { companyId: string; getToken: () => Promise<string | null> }) {
  const [mode, setMode] = useState<ModeAnswer | null>(null);
  const [confirming, setConfirming] = useState<"pc" | "server" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getToken(); if (!token) return;
      const answer = await apiRequest<ModeAnswer>(token, `/api/companies/${companyId}/check-jobs/mode`, { timeoutMs: 8_000 }).catch(() => null);
      if (!cancelled) setMode(answer ?? { mode: "pc" });
    })();
    return () => { cancelled = true; };
  }, [companyId, getToken]);

  const change = async (next: "pc" | "server") => {
    setSaving(true); setError(null);
    try {
      const token = await getToken(); if (!token) return;
      await apiRequest(token, `/api/companies/${companyId}/check-jobs/mode`, { method: "PUT", body: jsonBody({ mode: next }), timeoutMs: 15_000 });
      // Open pages pick the mode up when they load, so reload this one.
      window.location.reload();
    } catch (cause) {
      setError(userFacingError(cause, "Could not change where Tally checks run."));
      setSaving(false); setConfirming(null);
    }
  };

  if (!mode) return null;
  const other = mode.mode === "pc" ? "server" : "pc";
  return (
    <div className={s.companies}>
      <span>Where Tally checks run</span>
      <p>
        {mode.mode === "server"
          ? "On the Tally server. Anyone can calculate from any computer; checks wait in line and run one at a time."
          : "On this company's Tally PC. Calculations work only from the computer that has the connector and Tally open."}
      </p>
      {mode.mode === "server" && mode.message && <InlineMessage tone="warning">{mode.message}</InlineMessage>}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {confirming
        ? <span className={s.confirm}>
          <span>{confirming === "server" ? "Run checks on the Tally server? The connector there must be set to server mode." : "Run checks on the PC again?"}</span>
          <Button type="button" className="button-primary" disabled={saving} onClick={() => void change(confirming)}>{saving ? "Switching…" : "Switch"}</Button>
          <Button type="button" className="button-quiet" disabled={saving} onClick={() => setConfirming(null)}>Cancel</Button>
        </span>
        : <Button type="button" className="button-secondary" onClick={() => setConfirming(other)}>{other === "server" ? "Use the Tally server" : "Use the PC instead"}</Button>}
    </div>
  );
}
