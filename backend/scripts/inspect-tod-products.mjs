import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const { data: v } = await db.from("scheme_versions").select("id, version_number, effective_from").eq("company_id", company).eq("scheme_type", "tod").eq("status", "active");
for (const x of v ?? []) {
  const items = (await db.from("scheme_version_stock_items").select("stock_item_id").eq("scheme_version_id", x.id)).data ?? [];
  const groups = (await db.from("scheme_version_stock_groups").select("stock_group_id").eq("scheme_version_id", x.id)).data ?? [];
  const conv = (await db.from("scheme_version_unit_conversions").select("*").eq("scheme_version_id", x.id)).data ?? [];
  const names = (await db.from("stock_groups").select("id,name").in("id", groups.map((g) => g.stock_group_id))).data ?? [];
  console.log(JSON.stringify({ ...x, items: items.length, groups: names.map((g) => g.name), conv: conv.map((c) => ({ uom: c.source_uom_id, t: c.tonnes_per_source_unit })) }));
}
const cg = (await db.from("customer_groups").select("id,name").eq("company_id", company).eq("parent_group_id", "4fadc16d-0134-4a1f-96d0-dc0f0bb64596")).data;
console.log("SIBLING GROUPS", cg.map((g) => g.name).join(", "));
