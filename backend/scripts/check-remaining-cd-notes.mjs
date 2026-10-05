// Read-only: state of auto-queued CD Credit Notes not stopped.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data } = await db.from("cash_discount_debit_note_postings").select("status, verified_voucher_number, failure_reason").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54").eq("note_kind", "credit_note").like("idempotency_key", "cd-cn-auto:%").neq("status", "cancelled");
const by = {}; for (const r of data) by[r.status] = (by[r.status] ?? 0) + 1;
console.log(JSON.stringify(by)); for (const r of data.filter((r) => r.status !== "created_verified")) console.log(" ", r.status, (r.failure_reason ?? "").slice(0, 100));
console.log("created:", data.filter((r) => r.verified_voucher_number).map((r) => r.verified_voucher_number).join(", "));
