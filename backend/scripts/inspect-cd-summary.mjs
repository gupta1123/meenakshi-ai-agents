// Read-only: size breakdown of the latest per-MT Cash Discount run summary.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data } = await db.from("evaluation_runs").select("summary").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54").eq("status", "completed").eq("summary->>cdDiscountBasis", "amount_per_tonne").order("completed_at", { ascending: false }).limit(1);
const s = data[0].summary; const rows = s.settlementResults ?? [];
console.log("results:", rows.length, "categories:", JSON.stringify(rows.reduce((a, r) => (a[r.category] = (a[r.category] ?? 0) + 1, a), {})));
const sizes = {}; for (const r of rows) for (const [k, v] of Object.entries(r)) sizes[k] = (sizes[k] ?? 0) + JSON.stringify(v ?? null).length;
console.log(Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}: ${(v / 1e6).toFixed(2)} MB`).join(" | "));
