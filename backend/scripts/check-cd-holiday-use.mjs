// Read-only: did the latest per-MT CD check skip holidays? Compare each row's deadline with the calendar.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const file of [".env.local", ".env"]) { if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const db = createClient((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ""), process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data: hol } = await db.from("working_calendar_holidays").select("holiday_date").eq("working_calendar_id", "5f3a41c5-8f64-4cf4-97e1-c81439da0c28").eq("is_active", true);
const holidays = new Set(hol.map((h) => h.holiday_date));
const { data: runs } = await db.from("evaluation_runs").select("id, completed_at, summary").eq("company_id", "963aa157-7c2e-4006-8efb-35902a30ec54").eq("status", "completed").eq("summary->>cdDiscountBasis", "amount_per_tonne").order("completed_at", { ascending: false }).limit(1);
const rows = runs[0].summary.settlementResults ?? [];
const add = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const expected = (d, n) => { let c = d, k = 0; while (k < n) { c = add(c, 1); const wd = new Date(`${c}T00:00:00Z`).getUTCDay(); if (wd !== 0 && !holidays.has(c)) k++; } return c; };
let wrong = 0; const samples = [];
for (const r of rows) { const e = expected(r.invoiceDate.slice(0, 10), r.windowWorkingDays); if (e !== r.windowDeadline) { wrong++; if (samples.length < 5) samples.push({ inv: r.invoiceNumber, date: r.invoiceDate, days: r.windowWorkingDays, saved: r.windowDeadline, shouldBe: e }); } }
console.log({ lastCheck: runs[0].completed_at, frozenCalendarRevision: runs[0].summary?.calendarSnapshot?.revision ?? runs[0].summary?.calendarRevision ?? null, rows: rows.length, deadlinesWrongVsCalendarNow: wrong, holidays2025: [...holidays].filter((d) => d.startsWith("2025")).length });
console.log(samples);
