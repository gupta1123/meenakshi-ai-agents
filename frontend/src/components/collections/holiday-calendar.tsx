"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AlertTriangle, CalendarCheck, CalendarDays, CalendarPlus, CalendarX, Info, PartyPopper, Pencil, Plus, RotateCcw, Sparkles, Trash2, X } from "lucide-react";

import { apiRequest, jsonBody } from "@/lib/api";
import { userFacingError } from "@/lib/user-copy";

import { useCompany } from "./company-context";
import type { Calendar } from "./types";
import { Button, IconButton, StatusBadge } from "./ui";
import { accessToken } from "./workspace";
import s from "./holiday-calendar.module.css";

type Holiday = Calendar["holidays"][number];
type HolidayState = "past" | "upcoming" | "next" | "today" | "removed";
type Editor = { calendar: Calendar; holiday?: Holiday; year: number };

const WEEKDAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]] as const;
const WEEKDAY_NAMES: Record<number, string> = { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday" };
const FIXED_HOLIDAYS = [
  { name: "New Year's Day", monthDay: "01-01" },
  { name: "Republic Day", monthDay: "01-26" },
  { name: "May Day", monthDay: "05-01" },
  { name: "Independence Day", monthDay: "08-15" },
  { name: "Gandhi Jayanti", monthDay: "10-02" },
  { name: "Christmas", monthDay: "12-25" },
];
const PANEL_EXIT_MS = 200;

function pad(value: number) { return String(value).padStart(2, "0"); }
function localToday() { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
function parseDay(value: string) { return new Date(`${value.slice(0, 10)}T00:00:00`); }
function isValidDay(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDay(value).getTime()); }
function isoWeekday(value: string) { return parseDay(value).getDay() || 7; }
function daysBetween(from: string, to: string) { return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000); }
function relativeLabel(days: number) {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 0) return days <= 60 ? `In ${days} days` : `In about ${Math.round(days / 30)} months`;
  return -days <= 60 ? `${-days} days ago` : "Passed";
}
function longDate(value: string) { return parseDay(value).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); }
function mediumDate(value: string) { return parseDay(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }

function DateTile({ value, size = "normal" }: { value: string; size?: "normal" | "large" }) {
  const date = parseDay(value);
  return <span className={s.dateTile} data-size={size} aria-hidden="true">
    <span>{date.toLocaleDateString("en-IN", { month: "short" })}</span>
    <strong>{date.getDate()}</strong>
    <small>{date.toLocaleDateString("en-IN", { weekday: "short" })}</small>
  </span>;
}

export function HolidayCalendar({ calendars, onSetUp, onChanged, onError }: { calendars: Calendar[]; onSetUp: () => void; onChanged: (message: string) => Promise<void>; onError: (message: string | null) => void }) {
  const { company } = useCompany();
  const today = localToday();
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [busyHolidayId, setBusyHolidayId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  async function saveHoliday(target: Editor, values: { name: string; date: string }) {
    const token = await accessToken(); if (!token) throw new Error("Your session is unavailable.");
    await apiRequest(token, `/api/companies/${company.id}/calendars/${target.calendar.id}/holidays`, target.holiday
      ? { method: "PATCH", body: jsonBody({ holidayId: target.holiday.id, holidayDate: values.date, name: values.name }) }
      : { method: "POST", body: jsonBody({ holidayDate: values.date, name: values.name, isActive: true }) });
    setYear(Number(values.date.slice(0, 4)));
    await onChanged(target.holiday ? `${values.name} updated.` : `${values.name} added to the business calendar.`);
  }

  async function setHolidayActive(calendar: Calendar, holiday: Holiday, isActive: boolean) {
    const token = await accessToken(); if (!token) return false;
    setBusyHolidayId(holiday.id);
    try {
      await apiRequest(token, `/api/companies/${company.id}/calendars/${calendar.id}/holidays`, { method: "PATCH", body: jsonBody({ holidayId: holiday.id, isActive }) });
      await onChanged(isActive ? `${holiday.name} restored.` : `${holiday.name} removed from discount calculations.`);
      return true;
    } catch (cause) { onError(userFacingError(cause, "Could not update this holiday.")); return false; }
    finally { setBusyHolidayId(null); }
  }

  if (!calendars.length) return <div className={s.setupEmpty}>
    <span className={s.emptyIcon}><CalendarDays size={24} /></span>
    <h3>Business calendar not set up</h3>
    <p>Create the common calendar used by every connected Tally company. Working-day discount windows skip its weekly off days and holidays.</p>
    <Button onClick={onSetUp}><CalendarPlus size={16} />Set up calendar</Button>
  </div>;

  return <div className={s.stack}>
    {calendars.map((calendar) => <CalendarCard key={calendar.id} calendar={calendar} today={today} year={year} onYear={setYear} busyHolidayId={busyHolidayId} onAdd={() => setEditor({ calendar, year })} onEdit={(holiday) => setEditor({ calendar, holiday, year })} onToggle={(holiday, isActive) => void setHolidayActive(calendar, holiday, isActive)} />)}
    {editor && <HolidayPanel key={editor.holiday?.id ?? `new-${editor.calendar.id}`} editor={editor} today={today} onClosed={() => setEditor(null)} onSave={(values) => saveHoliday(editor, values)} onToggle={(isActive) => editor.holiday ? setHolidayActive(editor.calendar, editor.holiday, isActive) : Promise.resolve(false)} />}
  </div>;
}

function CalendarCard({ calendar, today, year, onYear, busyHolidayId, onAdd, onEdit, onToggle }: { calendar: Calendar; today: string; year: number; onYear: (year: number) => void; busyHolidayId: string | null; onAdd: () => void; onEdit: (holiday: Holiday) => void; onToggle: (holiday: Holiday, isActive: boolean) => void }) {
  const weeklyOff = useMemo(() => new Set(calendar.nonWorkingWeekdays), [calendar.nonWorkingWeekdays]);
  const sorted = useMemo(() => [...calendar.holidays].sort((left, right) => left.holiday_date.localeCompare(right.holiday_date)), [calendar.holidays]);
  const next = sorted.find((holiday) => holiday.is_active && holiday.holiday_date >= today) ?? null;
  const years = useMemo(() => [...new Set([year, Number(today.slice(0, 4)), ...sorted.map((holiday) => Number(holiday.holiday_date.slice(0, 4)))])].sort((left, right) => left - right), [sorted, today, year]);
  const inYear = useMemo(() => sorted.filter((holiday) => holiday.holiday_date.startsWith(String(year))), [sorted, year]);
  const activeInYear = inYear.filter((holiday) => holiday.is_active);
  const extraDays = activeInYear.filter((holiday) => !weeklyOff.has(isoWeekday(holiday.holiday_date))).length;
  const months = useMemo(() => {
    const groups = new Map<string, Holiday[]>();
    for (const holiday of inYear) { const key = holiday.holiday_date.slice(0, 7); groups.set(key, [...(groups.get(key) ?? []), holiday]); }
    return [...groups.entries()];
  }, [inYear]);

  function stateFor(holiday: Holiday): HolidayState {
    if (!holiday.is_active) return "removed";
    if (holiday.holiday_date === today) return "today";
    if (holiday.id === next?.id) return "next";
    return holiday.holiday_date < today ? "past" : "upcoming";
  }

  return <section className={s.calendar} aria-label={calendar.name}>
    <header className={s.header}>
      <span className={s.headerIcon}><CalendarDays size={21} /></span>
      <div className={s.headerCopy}><p className="eyebrow">Business calendar</p><h2>{calendar.name}</h2><p>Used automatically for every connected Tally company.</p></div>
      <div className={s.headerActions}><StatusBadge status={calendar.isActive ? "ready" : "suppressed"} /><Button onClick={onAdd}><Plus size={16} />Add holiday</Button></div>
    </header>

    <div className={s.stats}>
      <div className={s.stat}><span>Holidays in {year}</span><strong>{activeInYear.length}</strong><small>{extraDays === activeInYear.length ? "All fall on working days" : `${extraDays} fall on working days`}</small></div>
      <div className={s.stat} data-tone={next ? "green" : undefined}><span>Next holiday</span>{next ? <><strong className={s.statName}>{next.name}</strong><small>{mediumDate(next.holiday_date)} · {relativeLabel(daysBetween(today, next.holiday_date))}</small></> : <><strong className={s.statName}>None scheduled</strong><small>Add upcoming holidays to keep windows accurate</small></>}</div>
      <div className={s.stat}><span>Weekly off</span><div className={s.week} aria-label={`Weekly off: ${calendar.nonWorkingWeekdays.map((day) => WEEKDAY_NAMES[day]).join(", ") || "none"}`}>{WEEKDAYS.map(([day, label]) => <span key={day} data-off={weeklyOff.has(day)} title={`${WEEKDAY_NAMES[day]}${weeklyOff.has(day) ? " · non-working" : ""}`}>{label.slice(0, 2)}</span>)}</div></div>
    </div>

    <div className={s.body}>
      <div className={s.listHeader}>
        <div><h3>Holidays</h3><p>Excluded from working-day calculations for discounts.</p></div>
        {years.length > 1 && <div className={s.years} role="group" aria-label="Choose year">{years.map((item) => <button key={item} type="button" aria-pressed={item === year} onClick={() => onYear(item)}>{item}</button>)}</div>}
      </div>

      {months.length ? months.map(([month, holidays]) => <section key={month} className={s.month}>
        <h4>{parseDay(`${month}-01`).toLocaleDateString("en-IN", { month: "long" })}<span>{holidays.length}</span></h4>
        <ul className={s.list}>{holidays.map((holiday) => {
          const state = stateFor(holiday);
          const offDay = weeklyOff.has(isoWeekday(holiday.holiday_date));
          return <li key={holiday.id} className={s.row} data-state={state}>
            <DateTile value={holiday.holiday_date} />
            <div className={s.rowCopy}>
              <strong>{holiday.name}</strong>
              <p>{state === "removed" ? "Not counted in calculations" : relativeLabel(daysBetween(today, holiday.holiday_date))}</p>
              {(state === "next" || state === "today" || (offDay && state !== "removed")) && <div className={s.tags}>
                {state === "today" && <span data-tone="green">Today</span>}
                {state === "next" && <span data-tone="green">Next up</span>}
                {offDay && <span data-tone="amber" title="Already a weekly off day, so it does not change working-day counts">Weekly off</span>}
              </div>}
            </div>
            <div className={s.rowActions}>
              <IconButton label={`Edit ${holiday.name}`} onClick={() => onEdit(holiday)}><Pencil size={15} /></IconButton>
              {holiday.is_active
                ? <IconButton label={`Remove ${holiday.name}`} disabled={busyHolidayId === holiday.id} onClick={() => onToggle(holiday, false)}><Trash2 size={15} /></IconButton>
                : <IconButton label={`Restore ${holiday.name}`} disabled={busyHolidayId === holiday.id} onClick={() => onToggle(holiday, true)}><RotateCcw size={15} /></IconButton>}
            </div>
          </li>;
        })}</ul>
      </section>) : <div className={s.empty}>
        <span className={s.emptyIcon}><PartyPopper size={22} /></span>
        <h3>No holidays in {year}</h3>
        <p>Add the festivals and public holidays your business closes for.</p>
        <Button className="button-secondary" onClick={onAdd}><Plus size={15} />Add holiday</Button>
      </div>}
    </div>
  </section>;
}

function HolidayPanel({ editor, today, onClosed, onSave, onToggle }: { editor: Editor; today: string; onClosed: () => void; onSave: (values: { name: string; date: string }) => Promise<void>; onToggle: (isActive: boolean) => Promise<boolean> }) {
  const { calendar, holiday } = editor;
  const editing = Boolean(holiday);
  const [name, setName] = useState(holiday?.name ?? "");
  const [date, setDate] = useState(holiday?.holiday_date ?? "");
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState<"save" | "toggle" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const titleId = "holiday-panel-title";

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    nameRef.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus?.(); };
  }, []);

  function close() {
    if (closing) return;
    setClosing(true);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(onClosed, reduced ? 0 : PANEL_EXIT_MS);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.stopPropagation(); close(); return; }
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const validDate = isValidDay(date);
  const trimmedName = name.trim();
  const duplicate = validDate ? calendar.holidays.find((item) => item.holiday_date === date && item.id !== holiday?.id && item.is_active) : undefined;
  const offDay = validDate && calendar.nonWorkingWeekdays.includes(isoWeekday(date));
  const inPast = validDate && date < today;
  const unchanged = editing && trimmedName === holiday?.name && date === holiday?.holiday_date;
  const canSave = Boolean(trimmedName) && validDate && !duplicate && !unchanged && !busy;
  const suggestionYear = validDate ? Number(date.slice(0, 4)) : editor.year;
  const suggestions = editing ? [] : FIXED_HOLIDAYS
    .map((item) => ({ name: item.name, date: `${suggestionYear}-${item.monthDay}` }))
    .filter((item) => !calendar.holidays.some((existing) => existing.is_active && existing.holiday_date === item.date));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setBusy("save"); setError(null);
    try { await onSave({ name: trimmedName, date }); close(); }
    catch (cause) { setError(userFacingError(cause, editing ? "Could not save this holiday." : "Could not add this holiday.")); }
    finally { setBusy(null); }
  }

  async function toggle() {
    if (!holiday || busy) return;
    setBusy("toggle"); setError(null);
    const done = await onToggle(!holiday.is_active);
    setBusy(null);
    if (done) close();
  }

  return <div className={s.layer} data-closing={closing} onKeyDown={onKeyDown}>
    <button type="button" className={s.backdrop} aria-label="Close panel" tabIndex={-1} onClick={close} />
    <aside ref={panelRef} className={s.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className={s.panelHeader}>
        <span className={s.panelIcon}>{editing ? <Pencil size={19} /> : <CalendarPlus size={20} />}</span>
        <div><h2 id={titleId}>{editing ? "Edit holiday" : "Add a holiday"}</h2><p>{editing ? "Changes apply to working-day calculations from now on." : `Added to ${calendar.name} for every connected Tally company.`}</p></div>
        <button type="button" className={s.close} aria-label="Close panel" onClick={close}><X size={18} /></button>
      </header>

      <form id="holiday-form" className={s.panelBody} onSubmit={(event) => void submit(event)}>
        <div className={s.preview} data-empty={!validDate}>
          {validDate ? <DateTile value={date} size="large" /> : <span className={s.previewPlaceholder}><CalendarDays size={24} /></span>}
          <div className={s.previewCopy}>
            <strong>{trimmedName || "Holiday name"}</strong>
            <span>{validDate ? longDate(date) : "Pick a date to preview"}</span>
            {validDate && <small data-past={inPast}>{relativeLabel(daysBetween(today, date))}</small>}
          </div>
        </div>

        <label className={s.field}><span>Holiday name</span><input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="e.g. Pongal" autoComplete="off" /></label>
        <label className={s.field}><span>Date</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>

        {suggestions.length > 0 && <div className={s.suggestions}>
          <span><Sparkles size={13} />Quick add for {suggestionYear}</span>
          <div>{suggestions.map((item) => <button key={item.date} type="button" data-selected={date === item.date && name === item.name} onClick={() => { setName(item.name); setDate(item.date); }}>{item.name}<small>{mediumDate(item.date)}</small></button>)}</div>
        </div>}

        {duplicate && <p className={s.notice} data-tone="rose"><CalendarX size={16} /><span><strong>{duplicate.name}</strong> is already on this date. Choose another date or edit that holiday instead.</span></p>}
        {!duplicate && offDay && <p className={s.notice} data-tone="amber"><AlertTriangle size={16} /><span>This is already a weekly off day ({WEEKDAY_NAMES[isoWeekday(date)]}), so it will not change working-day counts.</span></p>}
        {!duplicate && inPast && <p className={s.notice} data-tone="blue"><Info size={16} /><span>This date has already passed. It only affects calculations that are run again.</span></p>}
        {editing && !holiday?.is_active && <p className={s.notice} data-tone="blue"><Info size={16} /><span>This holiday is currently removed from calculations. Restore it to count it again.</span></p>}
        {error && <p className={s.notice} data-tone="rose" role="alert"><AlertTriangle size={16} /><span>{error}</span></p>}
      </form>

      <footer className={s.panelFooter}>
        {editing && holiday && <button type="button" className={s.toggleLink} data-tone={holiday.is_active ? "rose" : "green"} disabled={Boolean(busy)} onClick={() => void toggle()}>{holiday.is_active ? <><Trash2 size={15} />Remove</> : <><RotateCcw size={15} />Restore</>}</button>}
        <span className={s.footerSpacer} />
        <Button type="button" className="button-secondary" onClick={close}>Cancel</Button>
        <Button type="submit" form="holiday-form" disabled={!canSave}><CalendarCheck size={16} />{busy === "save" ? "Saving…" : editing ? "Save changes" : "Add holiday"}</Button>
      </footer>
    </aside>
  </div>;
}
