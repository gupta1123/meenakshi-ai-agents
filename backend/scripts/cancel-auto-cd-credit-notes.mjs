// Stops Cash Discount Credit Notes that were queued automatically (before
// auto-creation was removed) and whose Tally job has not been picked up.
// Their invoices go back to "ready" so staff can create them manually.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const reason = "Stopped: Cash Discount Credit Notes are created manually. Create it again from the Cash Discount page if needed.";
const must = (result) => { if (result.error) throw result.error; return result.data; };

const postings = must(await db.from("cash_discount_debit_note_postings").select("id, candidate_id, idempotency_key")
  .eq("company_id", company).eq("note_kind", "credit_note").in("status", ["queued", "sending"]).like("idempotency_key", "cd-cn-auto:%"));
let stopped = 0, skipped = 0;
for (const posting of postings) {
  const outbox = must(await db.from("integration_outbox").select("id").eq("aggregate_id", posting.id));
  const commands = outbox.length ? must(await db.from("tally_commands").select("id, status").in("source_outbox_id", outbox.map((o) => o.id))) : [];
  if (commands.some((c) => c.status !== "queued")) { skipped += 1; continue; } // already picked up: leave it
  for (const c of commands) must(await db.from("tally_commands").update({ status: "dead_letter", failure_reason: reason }).eq("id", c.id).eq("status", "queued").select("id"));
  must(await db.from("cash_discount_debit_note_postings").update({ status: "cancelled", failure_reason: reason }).eq("id", posting.id).select("id"));
  must(await db.from("cash_discount_recovery_candidates").update({ status: "action_required" }).eq("id", posting.candidate_id).eq("status", "posting").select("id"));
  stopped += 1;
}
console.log(`auto-queued found: ${postings.length}, stopped: ${stopped}, left alone (already picked up by the connector): ${skipped}`);
