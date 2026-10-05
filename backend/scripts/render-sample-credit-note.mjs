// Read-only: render our PDF for one Cash Discount Credit Note and save it
// locally (the storage upload is replaced by a local file write).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { prepareDebitNoteDocument } from "../src/lib/notes/verified-note-document.mjs";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const { data: note } = await db.from("cash_discount_debit_note_postings").select("id, verified_voucher_number").eq("company_id", company).eq("note_kind", "credit_note").eq("status", "created_verified").order("created_at", { ascending: false }).limit(1).single();
const out = process.argv[2];
const local = new Proxy(db, { get(target, key) {
  if (key !== "storage") return target[key];
  return { from: () => ({ upload: async (_path, pdf) => { writeFileSync(out, pdf); return { error: null }; } }) };
} });
await prepareDebitNoteDocument(local, company, note.id);
console.log("rendered CN", note.verified_voucher_number, "->", out);
