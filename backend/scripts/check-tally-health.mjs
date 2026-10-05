// Read-only: what get_tally_health says about master data for the company.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const { data: members } = await db.from("organization_memberships").select("profile_id, role").eq("role", "administrator").limit(1);
const userId = members?.[0]?.profile_id;
const { data, error } = await db.rpc("get_tally_health", { p_company_id: company, p_user_id: userId });
if (error) { console.log(error); process.exit(); }
console.log(JSON.stringify({ status: data.status, ready: data.ready, sync: data.sync }, null, 1).slice(0, 2500));
