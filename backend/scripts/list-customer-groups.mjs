// Read-only: customer-group tree for MUIPL, with customer counts.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const groups = (await db.from("customer_groups").select("id,name,parent_group_id,is_available,last_seen_at").eq("company_id", company)).data;
const customers = (await db.from("customers").select("current_customer_group_id").eq("company_id", company).eq("is_available", true).limit(10000)).data;
const count = new Map(); for (const c of customers) count.set(c.current_customer_group_id, (count.get(c.current_customer_group_id) ?? 0) + 1);
const kids = new Map(); for (const g of groups) { const k = g.parent_group_id ?? "root"; kids.set(k, [...(kids.get(k) ?? []), g]); }
const byId = new Map(groups.map((g) => [g.id, g]));
const print = (g, depth) => { console.log(`${"  ".repeat(depth)}${g.name}${g.is_available ? "" : " [unavailable]"} (${count.get(g.id) ?? 0} customers)`); for (const c of (kids.get(g.id) ?? []).sort((a, b) => a.name.localeCompare(b.name))) print(c, depth + 1); };
const roots = groups.filter((g) => !g.parent_group_id || !byId.has(g.parent_group_id));
const sundry = groups.find((g) => /sundry debtors/i.test(g.name));
console.log(`groups: ${groups.length}, customers: ${customers.length}, last synced: ${groups.map((g) => g.last_seen_at).sort().at(-1)}`);
print(sundry ?? roots[0], 0);
