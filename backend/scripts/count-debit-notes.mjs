// Read-only: Cash Discount Debit Notes (old recovery model) by status.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data } = await db.from("cash_discount_debit_note_postings").select("status, created_at").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54").eq("note_kind", "debit_note");
console.log({ debitNotes: data.length, byStatus: data.reduce((a, n) => (a[n.status] = (a[n.status] ?? 0) + 1, a), {}), latest: data.map((n) => n.created_at).sort().at(-1) ?? null });
