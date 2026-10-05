// Read-only: runs the Cash Discount results queries and prints any error.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const t0 = Date.now();
const runs = await db.from("evaluation_runs").select("id, completed_at, summary").eq("company_id", company).eq("status", "completed").eq("summary->>cdDiscountBasis", "amount_per_tonne").order("completed_at", { ascending: false }).limit(1);
console.log("runs:", runs.error ?? `${runs.data?.length} row(s), ${JSON.stringify(runs.data?.[0]?.summary ?? {}).length} bytes, ${Date.now() - t0} ms`);
const c = await db.from("cash_discount_recovery_candidates").select("id, invoice_tally_guid, status, remaining_recovery, settlement_category").eq("company_id", company).eq("current_snapshot", true).eq("candidate_kind", "settlement");
console.log("candidates:", c.error ?? `${c.data.length} rows`);
const n = await db.from("cash_discount_debit_note_postings").select("id, status, invoice:debit_note_snapshot->sourceInvoice->>guid").eq("company_id", company).eq("note_kind", "credit_note").limit(5000);
console.log("notes:", n.error ?? `${n.data.length} rows`);
