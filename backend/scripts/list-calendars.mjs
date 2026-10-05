// Read-only: every working calendar in the organization, with holiday counts per year and which rules use it.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data: cals } = await db.from("working_calendars").select("id, name, is_active, created_at").eq("organization_id", "257a170a-1d02-4e21-aa33-93efff94fb10").order("created_at");
for (const cal of cals) {
  const { data: hol } = await db.from("working_calendar_holidays").select("holiday_date, is_active").eq("working_calendar_id", cal.id);
  const { data: users } = await db.from("scheme_versions").select("scheme_type, version_number, status").or(`working_calendar_id.eq.${cal.id},tod_review_calendar_id.eq.${cal.id}`);
  const years = hol.reduce((a, h) => (a[h.holiday_date.slice(0, 4)] = (a[h.holiday_date.slice(0, 4)] ?? 0) + 1, a), {});
  console.log(cal.name, cal.is_active ? "" : "(inactive)", cal.created_at.slice(0, 10), "holidays by year:", years, "used by:", users.map((u) => `${u.scheme_type} v${u.version_number} ${u.status}`).join(", ") || "none");
}
