// Read-only: sample notification messages (status, failure reasons, payload keys).
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data } = await db.from("notification_messages").select("status, event_type, failure_reason, delivered_at, read_at, business_event_key, payload, proposal_id, credit_note_posting_id").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54").order("created_at", { ascending: false }).limit(60);
const byReason = {};
for (const m of data) { const k = `${m.status} | ${m.event_type} | ${m.failure_reason ?? "-"}`; byReason[k] = (byReason[k] ?? 0) + 1; }
console.log(byReason);
const pick = (s) => data.find((m) => m.status === s);
for (const s of ["sent"]) { const m = pick(s); if (m) console.log(`\n== ${s}`, JSON.stringify({ key: m.business_event_key, delivered: m.delivered_at, read: m.read_at, payloadKeys: Object.keys(m.payload ?? {}), payload: JSON.stringify(m.payload).slice(0, 500) })); }
