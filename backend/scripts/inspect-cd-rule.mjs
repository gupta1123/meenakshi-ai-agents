// Read-only: prints the active Cash Discount rule and the masters needed to rewrite it.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const must = async (query) => { const { data, error } = await query; if (error) throw error; return data; };

const companies = await must(db.from("companies").select("id, code, tally_company_name"));
console.log("COMPANIES", companies);
const versions = await must(db.from("scheme_versions").select("*").eq("scheme_type", "cd").in("status", ["active", "draft"]).order("created_at"));
for (const v of versions) {
  const scheme = await must(db.from("schemes").select("name, code, status").eq("id", v.scheme_id).single());
  const groups = await must(db.from("scheme_version_customer_groups").select("customer_group_id, include_descendants").eq("scheme_version_id", v.id));
  const slabs = await db.from("scheme_version_cd_slabs").select("*").eq("scheme_version_id", v.id);
  const stocks = await db.from("scheme_version_stock_items").select("*").eq("scheme_version_id", v.id);
  const stockGroups = await db.from("scheme_version_stock_groups").select("*").eq("scheme_version_id", v.id);
  const conversions = await db.from("scheme_version_unit_conversions").select("*").eq("scheme_version_id", v.id);
  console.log("\nVERSION", JSON.stringify({ scheme, ...v, groups, slabs: slabs.data, stocks: stocks.data, stockGroups: stockGroups.data, conversions: conversions.data }, null, 1));
}
for (const c of companies) {
  const groups = await must(db.from("customer_groups").select("id, name, parent_group_id, is_available").eq("company_id", c.id).eq("is_available", true));
  console.log(`\nCUSTOMER GROUPS ${c.code}`, groups.map((g) => `${g.id} | ${g.name} | parent ${g.parent_group_id ?? "-"}`).join("\n"));
  const sg = await must(db.from("stock_groups").select("id, name").eq("company_id", c.id).eq("is_available", true));
  console.log(`STOCK GROUPS ${c.code}`, sg.map((g) => `${g.id} | ${g.name}`).join("\n"));
  const units = await must(db.from("tally_units").select("id, name").eq("company_id", c.id).eq("is_available", true));
  console.log(`UNITS ${c.code}`, units.map((u) => `${u.id} | ${u.name}`).join(", "));
}
