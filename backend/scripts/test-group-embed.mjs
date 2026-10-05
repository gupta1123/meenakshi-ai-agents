// Read-only: checks the customers → customer_groups lookup used when saving results.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const r = await db.from("customers").select("ledger_name, tally_ledger_guid, customer_groups(name)").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54").not("current_customer_group_id", "is", null).limit(3);
console.log(r.error?.message ?? JSON.stringify(r.data));
