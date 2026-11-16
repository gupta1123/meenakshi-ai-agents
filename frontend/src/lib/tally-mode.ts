"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { setServerCheckContext, setServerModeLookup } from "@/lib/local-tally";

export type TallyMode = { mode: "pc" | "server"; connectorOnline: boolean | null; lastSeenAt: string | null };
const PC: TallyMode = { mode: "pc", connectorOnline: null, lastSeenAt: null };

/**
 * Tells the page whether this company's Tally connector is a PC connector or a
 * server, and switches the shared check runner accordingly. Any problem
 * answers "pc", so a failed lookup never changes how a PC company works.
 */
export function useTallyMode(companyId: string, getToken: () => Promise<string | null>): TallyMode {
  const [state, setState] = useState<TallyMode>(PC);
  useEffect(() => {
    let cancelled = false;
    setServerCheckContext(null);
    setState(PC);
    const lookup = (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const answer = await apiRequest<TallyMode>(token, `/api/companies/${companyId}/check-jobs/mode`, { timeoutMs: 8_000 });
        if (cancelled) return;
        if (answer.mode === "server") setServerCheckContext({ companyId, getToken });
        setState(answer.mode === "server" ? answer : PC);
      } catch { /* stay in PC mode */ }
    })();
    setServerModeLookup(lookup);
    return () => { cancelled = true; setServerCheckContext(null); };
    // getToken is a stable module function in the callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);
  return state;
}
