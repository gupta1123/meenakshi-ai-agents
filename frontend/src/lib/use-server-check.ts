"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import { pickServerCheck, readServerCheck, stopServerCheck, type ServerCheck, type ServerCheckState } from "@/lib/server-checks";

/** Observe durable work independently of the page that submitted it. Unmounting
 * only detaches this observer; Stop is the only action that cancels a job. */
export function useServerCheck(companyId: string, kind: "cd" | "tod", enabled: boolean, getToken: () => Promise<string | null>, onSettled: (state: ServerCheckState) => void | Promise<void>) {
  const [state, setState] = useState<ServerCheckState | null>(null);
  const [looking, setLooking] = useState(enabled);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callback = useRef(onSettled);
  callback.current = onSettled;
  const current = useRef<string | null>(null);
  useEffect(() => {
    let disposed = false, busy = false;
    const seen = new Set<string>();
    current.current = null;
    setState(null); setStopping(false); setError(null); setLooking(enabled);
    if (!enabled) return;
    const poll = async () => {
      if (busy || disposed) return;
      busy = true;
      try {
        const token = await getToken();
        if (!token) throw new Error("Sign in again to follow the server check.");
        let id = current.current;
        if (!id) {
          const { jobs } = await apiRequest<{ jobs: ServerCheck[] }>(token, `/api/companies/${companyId}/check-jobs`, { cache: "no-store", timeoutMs: 10_000 });
          if (disposed) return;
          id = pickServerCheck(jobs, kind, seen)?.id ?? null;
        }
        if (!id) { setState(null); return; }
        const next = await readServerCheck(token, companyId, id);
        if (disposed) return;
        setError(null);
        if (next.phase) { current.current = id; setState(next); }
        else {
          current.current = null; seen.add(id); setState(null); setStopping(false);
          await callback.current(next);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Could not follow the server check.");
      } finally { busy = false; if (!disposed) setLooking(false); }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [companyId, enabled, getToken, kind]);
  const stop = useCallback(async () => {
    const id = current.current;
    if (!id || stopping) return;
    setStopping(true); setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Sign in again before stopping this check.");
      await stopServerCheck(token, companyId, id);
    } catch (cause) { setStopping(false); setError(cause instanceof Error ? cause.message : "Could not stop the check."); }
  }, [companyId, getToken, stopping]);
  return { state, looking, stopping, error, stop };
}
