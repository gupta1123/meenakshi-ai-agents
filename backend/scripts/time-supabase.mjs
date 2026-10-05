// Read-only: how long one Supabase round trip takes from this machine.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, "");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
console.log("host:", new URL(url).host);
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
async function time(label, fn) { const t = performance.now(); await fn(); console.log(label.padEnd(34), Math.round(performance.now() - t), "ms"); }
for (let i = 0; i < 3; i++) await time("tiny select (companies by id)", () => db.from("companies").select("id").eq("id", company).maybeSingle());
await time("customer_groups (all)", () => db.from("customer_groups").select("id, name, parent_group_id, is_available").eq("company_id", company));
await time("master sync readiness query", () => db.from("tally_sync_runs").select("id, status, completed_at").eq("company_id", company).eq("sync_kind", "masters").eq("status", "completed").order("completed_at", { ascending: false }).limit(1));
await time("auth admin (getUser-like)", () => fetch(`${url}/auth/v1/health`));
