// Read-only: latest Cash Discount evaluation runs for MUIPL.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data, error } = await db.from("evaluation_runs").select("*").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54").order("created_at", { ascending: false }).limit(4);
if (error) throw error;
for (const r of data) console.log(JSON.stringify({ created: r.created_at, status: r.status, scheme_version_id: r.scheme_version_id, period: [r.period_start, r.period_end], error: r.error_summary, context: r.request_context }).slice(0, 700));
