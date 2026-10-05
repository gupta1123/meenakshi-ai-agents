// Read-only: which working calendar the active CD rule uses, and its holidays / weekly offs.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const company = "963aa157-7c2e-4006-8efb-35902a30ec54";
const { data: rules } = await db.from("scheme_versions").select("id, version_number, status, effective_from, effective_to, working_calendar_id").eq("company_id", company).eq("scheme_type", "cd").eq("status", "active");
console.log("active CD rule:", rules);
const { data: cals, error: calError } = await db.from("working_calendars").select("*").eq("id", rules[0].working_calendar_id); if (calError) console.log(calError);
console.log("company calendars:", cals);
for (const cal of cals ?? []) {
  const [{ data: wd }, { data: hol }] = await Promise.all([
    db.from("working_calendar_non_working_weekdays").select("iso_weekday").eq("working_calendar_id", cal.id),
    db.from("working_calendar_holidays").select("holiday_date, name, is_active").eq("working_calendar_id", cal.id).order("holiday_date"),
  ]);
  console.log(`\n${cal.name ?? cal.label ?? ""} (${cal.id}) used by CD: ${rules?.some((r) => r.working_calendar_id === cal.id)}`);
  console.log(" weekly off (ISO, 7=Sun):", wd?.map((r) => r.iso_weekday));
  console.log(" holidays:", hol?.map((h) => `${h.holiday_date} ${h.name}${h.is_active ? "" : " (inactive)"}`));
}
