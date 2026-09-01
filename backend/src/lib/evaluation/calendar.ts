import type { IsoDate, WorkingCalendar, WorkingDayBreakdown } from "./contracts";

function dateAtUtc(value: IsoDate): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ISO date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`Invalid ISO date: ${value}`);
  return date;
}

function toIsoDate(value: Date): IsoDate {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoWeekday(value: Date): number {
  return value.getUTCDay() || 7;
}

export function workingDayBreakdown(calendar: WorkingCalendar, startDate: IsoDate, allowedWorkingDays: number): WorkingDayBreakdown[] {
  if (!Number.isInteger(allowedWorkingDays) || allowedWorkingDays < 0) throw new Error("allowedWorkingDays must be a non-negative integer.");
  const holidays = new Set(calendar.activeHolidayDates);
  const nonWorking = new Set(calendar.nonWorkingIsoWeekdays);
  const start = dateAtUtc(startDate);
  const rows: WorkingDayBreakdown[] = [];
  let counted = 0;
  let cursor = start;

  for (let guard = 0; guard < 3_000; guard += 1) {
    const businessDate = toIsoDate(cursor);
    const dayZero = guard === 0;
    const holiday = holidays.has(businessDate);
    const weeklyHoliday = nonWorking.has(isoWeekday(cursor));
    const isWorkingDay = !dayZero && !holiday && !weeklyHoliday;
    if (isWorkingDay) counted += 1;
    const isDeadline = counted === allowedWorkingDays;
    rows.push({
      businessDate,
      isWorkingDay,
      countedWorkingDay: counted,
      exclusionReason: dayZero ? "invoice_day_zero" : holiday ? "holiday" : weeklyHoliday ? "weekly_holiday" : null,
      isDeadline,
    });
    if (isDeadline) return rows;
    cursor = addDays(cursor, 1);
  }
  throw new Error("Could not find a working-day deadline within the configured calendar horizon.");
}

export function firstWorkingDayAfter(calendar: WorkingCalendar, date: IsoDate): IsoDate {
  const holidays = new Set(calendar.activeHolidayDates);
  const nonWorking = new Set(calendar.nonWorkingIsoWeekdays);
  let cursor = addDays(dateAtUtc(date), 1);
  for (let guard = 0; guard < 3_000; guard += 1) {
    const candidate = toIsoDate(cursor);
    if (!holidays.has(candidate) && !nonWorking.has(isoWeekday(cursor))) return candidate;
    cursor = addDays(cursor, 1);
  }
  throw new Error("Could not find a working day after the TOD period close.");
}

export function addCalendarMonths(startDate: IsoDate, months: number): IsoDate {
  if (!Number.isInteger(months) || months < 1) throw new Error("months must be a positive integer.");
  const start = dateAtUtc(startDate);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate()));
  return toIsoDate(next);
}

export function previousCalendarDay(date: IsoDate): IsoDate {
  return toIsoDate(addDays(dateAtUtc(date), -1));
}
