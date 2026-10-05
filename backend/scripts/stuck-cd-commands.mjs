// Read-only: outbox rows and Tally commands behind stuck CD Credit Notes.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const { data: notes } = await db.from("cash_discount_debit_note_postings").select("id").eq("company_id", company).eq("note_kind", "credit_note").in("status", ["queued", "sending"]);
const ids = notes.map((n) => n.id);
const outbox = await db.from("integration_outbox").select("id, status").in("aggregate_id", ids);
const count = (rows, key) => JSON.stringify((rows ?? []).reduce((a, r) => (a[r[key]] = (a[r[key]] ?? 0) + 1, a), {}));
console.log("outbox:", outbox.error?.message ?? count(outbox.data, "status"));
const cmds = await db.from("tally_commands").select("id, command_type, status, source_outbox_id").in("source_outbox_id", (outbox.data ?? []).map((o) => o.id));
console.log("commands:", cmds.error?.message ?? count(cmds.data, "status"), cmds.data?.[0]?.command_type ?? "");
