// Read-only: MUIPL Cash Discount rules and the latest Cash Discount runs.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const { data: versions } = await db.from("scheme_versions").select("id, scheme_id, version_number, status, effective_from, effective_to, cd_discount_basis, updated_at").eq("company_id", company).eq("scheme_type", "cd").order("updated_at", { ascending: false }).limit(6);
console.log("CD VERSIONS"); for (const v of versions) console.log(" ", v.version_number, v.status, v.effective_from, "→", v.effective_to ?? "open", v.cd_discount_basis, v.id.slice(0, 8), "updated", v.updated_at);
const { data: runs } = await db.from("evaluation_runs").select("id, created_at, completed_at, status, scheme_version_id, period_start, period_end, error_summary, summary, request_context").eq("company_id", company).eq("request_context->>schemeType", "cd").order("created_at", { ascending: false }).limit(3);
console.log("CD RUNS"); for (const r of runs ?? []) { const s = r.summary ?? {}; console.log(" ", r.created_at, r.status, "rule", r.scheme_version_id?.slice(0, 8), r.period_start, "→", r.period_end, "error:", r.error_summary, "totals:", JSON.stringify(s.totals ?? { invoicesChecked: s.invoicesChecked, results: Array.isArray(s.results) ? s.results.length : undefined }).slice(0, 300)); }
