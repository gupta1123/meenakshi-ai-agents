// Read-only: sample rows per category from the latest per-MT Cash Discount check.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const { data: runs } = await db.from("evaluation_runs").select("completed_at, period_start, period_end, summary").eq("company_id", company).eq("status", "completed").eq("summary->>cdDiscountBasis", "amount_per_tonne").order("completed_at", { ascending: false }).limit(1);
const run = runs[0]; const rows = run.summary.settlementResults ?? [];
const { data: notes } = await db.from("cash_discount_debit_note_postings").select("status, verified_voucher_number, invoice:debit_note_snapshot->sourceInvoice->>guid").eq("company_id", company).eq("note_kind", "credit_note");
const noteBy = new Map(); for (const n of notes) if (!noteBy.has(n.invoice)) noteBy.set(n.invoice, n);
const pick = (r) => ({ customer: r.customerName, inv: r.invoiceNumber, date: r.invoiceDate, window: `${r.windowWorkingDays}d due ${r.windowDeadline}`, bill: r.invoiceAmount, mt: r.eligibleTonnes, rate: r.amountPerTonne, discount: r.discountAmount, target: r.discountedTarget, paid: r.paidByDeadline, pct: (Number(r.paidByDeadline) / Number(r.invoiceAmount) * 100).toFixed(2), credit: r.creditAmount, lastPay: r.latestPaymentDate, payments: r.paymentCount, cn: noteBy.get(r.invoiceGuid)?.verified_voucher_number ?? noteBy.get(r.invoiceGuid)?.status ?? null, review: r.reviewMessage });
const out = { completed: run.completed_at, period: [run.period_start, run.period_end], counts: rows.reduce((a, r) => (a[r.category] = (a[r.category] ?? 0) + 1, a), {}) };
for (const cat of ["full_payment", "discounted_payment", "over_ninety_percent", "awaiting_payment", "needs_review", "not_eligible"]) out[cat] = rows.filter((r) => r.category === cat).slice(0, 50).map(pick);
writeFileSync("../../cd-sample.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.counts), out.period, out.completed);
for (const cat of ["full_payment", "discounted_payment", "over_ninety_percent", "not_eligible"]) { console.log(`\n== ${cat}`); for (const r of out[cat].slice(0, 4)) console.log(JSON.stringify(r)); }
