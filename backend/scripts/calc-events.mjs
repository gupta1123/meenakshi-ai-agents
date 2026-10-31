// Prints the latest Calculate activity (CD / TOD) so a failure can be read in plain words.
// Usage: node scripts/calc-events.mjs [count]   (reads SUPABASE_URL and SUPABASE_SECRET_KEY from .env.local)
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]));
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const count = Number(process.argv[2]) || 20;
const { data, error } = await supabase.from("calculation_events").select("*").order("started_at", { ascending: false }).limit(count);
if (error) { console.error(error.message); process.exit(1); }
const ist = (v) => v ? new Date(v).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true }) : "-";
for (const e of data) {
  console.log(`${ist(e.started_at)} IST | ${e.scheme.toUpperCase()} | ${e.status.toUpperCase()} | connector ${e.connector_version ?? "?"}${e.failing_step ? ` | failed at ${e.failing_step}: ${e.failure_reason ?? ""}` : ""}`);
  if (Object.keys(e.step_timings ?? {}).length) console.log(`    timings(ms): ${JSON.stringify(e.step_timings)}`);
  if (e.last_progress) console.log(`    last progress: ${JSON.stringify(e.last_progress)}`);
}
if (!data.length) console.log("No calculation activity recorded yet.");
