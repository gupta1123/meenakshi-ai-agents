// Read-only: CD Credit Notes still queued/sending, and their Tally commands.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const { data: notes, error } = await db.from("cash_discount_debit_note_postings").select("id, status, amount, idempotency_key, created_at, created_by").eq("company_id", company).eq("note_kind", "credit_note").in("status", ["queued", "sending"]).order("created_at");
if (error) throw error;
console.log("stuck postings:", notes.length, "auto-queued:", notes.filter((n) => n.idempotency_key?.startsWith("cd-cn-auto")).length);
for (const n of notes.slice(0, 5)) console.log(" ", n.status, n.amount, n.idempotency_key?.slice(0, 40), n.created_at);
const { data: cmds, error: cmdError } = await db.from("tally_commands").select("id, command_type, status, attempt_count, created_at, payload").eq("company_id", company).in("status", ["queued", "leased", "running", "sending", "pending"]).order("created_at").limit(500);
if (cmdError) { console.log("commands:", cmdError.message); } else {
  const byType = {}; for (const c of cmds) byType[`${c.command_type}:${c.status}`] = (byType[`${c.command_type}:${c.status}`] ?? 0) + 1;
  console.log("open tally commands:", JSON.stringify(byType));
}
