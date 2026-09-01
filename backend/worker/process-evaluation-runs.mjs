import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const WORKER_NAME = process.env.MEENAKSHI_EVALUATION_WORKER_NAME || `meenakshi-evaluator-${process.pid}`;
const POLL_INTERVAL_MS = Math.max(1_000, Number(process.env.MEENAKSHI_EVALUATION_POLL_INTERVAL_MS ?? 2_000));
const BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.MEENAKSHI_EVALUATION_BATCH_SIZE ?? 10)));
const LEASE_SECONDS = Math.max(30, Number(process.env.MEENAKSHI_EVALUATION_LEASE_SECONDS ?? 120));
const RUN_ONCE = process.env.MEENAKSHI_EVALUATION_RUN_ONCE === "true";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const parts = [error.message, error.details, error.hint, error.code]
      .filter((part) => typeof part === "string" && part.trim().length > 0);
    if (parts.length > 0) return parts.join(" | ");
  }
  return String(error ?? "Evaluation worker failed.");
}

async function claim() {
  const { data, error } = await supabase.rpc("claim_meenakshi_evaluation_runs", {
    p_worker_id: WORKER_NAME,
    p_limit: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw error;
  return data ?? [];
}

async function processOne(run) {
  // The domain implementation stays in TypeScript beside the API. Dynamic
  // import lets this small Node worker use the same source under Node 24.
  const { processEvaluationRun, failEvaluationRun } = await import("../src/lib/evaluation/run-service.ts");
  try {
    const state = await processEvaluationRun(run);
    console.info("Meenakshi evaluation run processed", { evaluationRunId: run.id, state });
  } catch (error) {
    console.error("Meenakshi evaluation run failed", { evaluationRunId: run.id, error: errorText(error) });
    try { await failEvaluationRun(run, error); } catch (failure) { console.error("Could not release failed evaluation run", failure); }
  }
}

function hasCompletedLocalTodEvidence(run) {
  return run?.request_context?.schemeType === "tod"
    && run?.summary?.liveTodEvidence?.mode === "live_tod_aggregate";
}

async function main() {
  do {
    try {
      const runs = await claim();
      // Locally calculated TOD children are independent database persistence
      // jobs. Process them concurrently so a 40-customer audit does not wait
      // through 40 serial worker cycles. Jobs that still require Tally remain
      // serial to avoid flooding the connector command channel.
      const localTodRuns = runs.filter(hasCompletedLocalTodEvidence);
      const connectorRuns = runs.filter((run) => !hasCompletedLocalTodEvidence(run));
      if (localTodRuns.length) await Promise.all(localTodRuns.map(processOne));
      for (const run of connectorRuns) await processOne(run);
      if (RUN_ONCE) break;
      await sleep(runs.length ? 100 : POLL_INTERVAL_MS);
    } catch (error) {
      if (RUN_ONCE) throw error;
      console.error("Meenakshi evaluation worker cycle failed; retrying:", errorText(error));
      await sleep(POLL_INTERVAL_MS);
    }
  } while (true);
}

main().catch((error) => { console.error("Meenakshi evaluation worker stopped:", error); process.exitCode = 1; });
