// Customer ledgers with every contact field from Tally -> CSV (opens in Excel / Google Sheets).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const [xmlPath, outPath] = process.argv.slice(2);
const decode = (v) => v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#4;/g, "").trim();
const xml = readFileSync(xmlPath, "utf8");
const ledgers = new Map();
for (const [, rawName, body] of xml.matchAll(/<LEDGER NAME="([^"]*)"[^>]*>([\s\S]*?)<\/LEDGER>/g)) {
  const one = (tag) => decode((body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "i")) ?? [])[1] ?? "");
  const address = [...body.matchAll(/<ADDRESS(?:\s[^>]*)?>([^<]*)<\/ADDRESS>/gi)].map((m) => decode(m[1])).filter(Boolean).join(", ");
  ledgers.set(decode(rawName), { mobile: one("LEDGERMOBILE"), phone: one("LEDGERPHONE"), contact: one("LEDGERCONTACT"), fax: one("LEDGERFAX"), email: one("EMAIL"), emailCc: one("EMAILCC"), address, gstin: one("PARTYGSTIN"), state: one("LEDSTATENAME"), parent: one("PARENT") });
}
const { data: customers, error } = await db.from("customers").select("ledger_name, current_customer_group_id").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54").limit(5000);
if (error) throw error;
const { data: groups } = await db.from("customer_groups").select("id, name").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54");
const groupName = new Map((groups ?? []).map((g) => [g.id, g.name]));
const tenDigits = (text) => [...String(text).matchAll(/(?:\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})/g)].map((m) => m[1].replace(/\D/g, ""));
const customerGroup = new Map(customers.map((c) => [c.ledger_name, groupName.get(c.current_customer_group_id) ?? null]));
const rows = [...ledgers.entries()].map(([ledgerName, l]) => {
  const c = { ledger_name: ledgerName };
  const mobiles = [...new Set([...tenDigits(l.mobile ?? ""), ...tenDigits(l.phone ?? "")])];
  const inAddress = tenDigits(l.address ?? "").filter((n) => !mobiles.includes(n));
  const type = customerGroup.has(ledgerName) ? "Customer" : /sundry creditors/i.test(l.parent ?? "") ? "Supplier" : "Other";
  return { name: c.ledger_name, type, group: customerGroup.get(ledgerName) ?? l.parent ?? "", mobiles, rawMobile: l.mobile ?? "", phone: l.phone ?? "", contact: l.contact ?? "", fax: l.fax ?? "", email: l.email ?? "", emailCc: l.emailCc ?? "", inAddress, gstin: l.gstin ?? "", state: l.state ?? "", found: true };
});
const shared = new Map();
for (const r of rows) for (const n of r.mobiles) shared.set(n, (shared.get(n) ?? 0) + 1);
const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const header = ["Ledger", "Type", "Group", "Mobile (Tally)", "Other number (Tally phone)", "Numbers in address", "Mobile shared by (customers)", "Own number?", "Contact person", "Email", "Email CC", "Fax", "GSTIN", "State"];
const lines = [header.map(csv).join(",")];
const typeOrder = { Customer: 0, Supplier: 1, Other: 2 };
for (const r of rows.sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || a.group.localeCompare(b.group) || a.name.localeCompare(b.name))) {
  const sharedBy = r.mobiles.length ? Math.max(...r.mobiles.map((n) => shared.get(n) ?? 1)) : "";
  const own = r.mobiles.some((n) => (shared.get(n) ?? 1) === 1) || r.inAddress.length ? "Yes" : r.mobiles.length ? "No (shared)" : "No number";
  lines.push([r.name, r.type, r.group, r.mobiles[0] ?? "", r.mobiles.slice(1).join(" / ") || (r.phone && !r.mobiles.length ? r.phone : ""), r.inAddress.join(" / "), sharedBy, own, r.contact, r.email, r.emailCc, r.fax, r.gstin, r.state].map(csv).join(","));
}
writeFileSync(outPath, "\ufeff" + lines.join("\r\n"));
const count = (f) => rows.filter(f).length;
console.log({ ledgers: rows.length, customers: count((r) => r.type === "Customer"), suppliers: count((r) => r.type === "Supplier"), other: count((r) => r.type === "Other"), customersNotInTally: customers.filter((c) => !ledgers.has(c.ledger_name)).length, withMobile: count((r) => r.mobiles.length), ownNumber: count((r) => r.mobiles.some((n) => shared.get(n) === 1)), numbersInAddress: count((r) => r.inAddress.length), withEmail: count((r) => r.email), withContactPerson: count((r) => r.contact), distinctMobiles: shared.size });
