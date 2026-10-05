// Read-only: do Full payment rows have Credit Note candidates or postings?
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const { data: runs } = await db.from("evaluation_runs").select("id, completed_at, summary").eq("company_id", company).eq("status", "completed").eq("summary->>cdDiscountBasis", "amount_per_tonne").order("completed_at", { ascending: false }).limit(1);
const run = runs[0]; const rows = run.summary.settlementResults ?? [];
const full = rows.filter((r) => r.category === "full_payment");
const guids = new Set(full.map((r) => r.invoiceGuid));
const { data: cands } = await db.from("cash_discount_recovery_candidates").select("id, status, invoice_tally_guid, evaluation_run_id, remaining_recovery").eq("company_id", company).in("status", ["action_required", "review_required"]);
const hit = (cands ?? []).filter((c) => guids.has(c.invoice_tally_guid));
const { data: notes } = await db.from("cash_discount_debit_note_postings").select("status, verified_voucher_number, invoice:debit_note_snapshot->sourceInvoice->>guid").eq("company_id", company).eq("note_kind", "credit_note");
const noteHit = (notes ?? []).filter((n) => guids.has(n.invoice));
console.log({ run: run.id, fullRows: full.length, fullWithCredit: full.filter((r) => Number(r.creditAmount) > 0).length, openCandidatesOnFull: hit.length, sameRun: hit.filter((c) => c.evaluation_run_id === run.id).length, notesOnFull: noteHit.length, noteStatuses: noteHit.reduce((a, n) => (a[n.status] = (a[n.status] ?? 0) + 1, a), {}) });
console.log(hit.slice(0, 5));
console.log(noteHit.slice(0, 5));
