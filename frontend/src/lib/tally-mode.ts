"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { setServerCheckContext, setServerModeLookup } from "@/lib/local-tally";

export type TallyMode = { mode: "pc" | "server" | "unknown"; connectorOnline: boolean | null; lastSeenAt: string | null };
const PC: TallyMode = { mode: "pc", connectorOnline: null, lastSeenAt: null };

/**
 * Tells the page whether this company's Tally connector is a PC connector or a
 * server. Each new calculation rechecks routing; lookup failures block work.
 */
export function useTallyMode(companyId: string, getToken: () => Promise<string | null>): TallyMode {
  const [state, setState] = useState<TallyMode>(PC);
  useEffect(() => {
    let cancelled = false;
    setServerCheckContext(null);
    setState(PC);
    const lookup = async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("Sign in again before checking Tally.");
        const answer = await apiRequest<TallyMode>(token, `/api/companies/${companyId}/check-jobs/mode`, { timeoutMs: 8_000 });
        if (cancelled) throw new Error("The company changed. Reopen the check.");
        if (answer.mode !== "server" && answer.mode !== "pc") throw new Error("Could not confirm where Tally checks run.");
        setServerCheckContext(answer.mode === "server" ? { companyId, getToken } : null);
        setState(answer.mode === "server" ? answer : PC);
      } catch (error) {
        setState({ ...PC, mode: "unknown" });
        throw error;
      }
    };
    setServerModeLookup(lookup);
    void lookup().catch(() => {});
    return () => { cancelled = true; setServerCheckContext(null); };
    // getToken is a stable module function in the callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);
  return state;
}
