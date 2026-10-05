"use client";

// Accounting period filter (like Tally's F2 period) shared by Credit Notes and
// Messages. Indian financial year: April to March.

export type PeriodPreset = "this_month" | "last_month" | "this_quarter" | "this_fy" | "last_fy" | "all" | "custom";
export type Period = { preset: PeriodPreset; from: string; to: string };

const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const LABELS: Record<PeriodPreset, string> = {
  this_month: "This month", last_month: "Last month", this_quarter: "This quarter",
  this_fy: "This financial year", last_fy: "Last financial year", all: "All dates", custom: "Custom range",
};

/** Date range for a preset (inclusive, YYYY-MM-DD). "all" has no bounds. */
export function presetRange(preset: PeriodPreset, today = new Date()): { from: string; to: string } {
  const year = today.getFullYear();
  const month = today.getMonth();
  const fyStart = month >= 3 ? year : year - 1;
  switch (preset) {
    case "this_month": return { from: iso(new Date(year, month, 1)), to: iso(new Date(year, month + 1, 0)) };
    case "last_month": return { from: iso(new Date(year, month - 1, 1)), to: iso(new Date(year, month, 0)) };
    case "this_quarter": { const start = Math.floor(month / 3) * 3; return { from: iso(new Date(year, start, 1)), to: iso(new Date(year, start + 3, 0)) }; }
    case "this_fy": return { from: `${fyStart}-04-01`, to: `${fyStart + 1}-03-31` };
    case "last_fy": return { from: `${fyStart - 1}-04-01`, to: `${fyStart}-03-31` };
    default: return { from: "", to: "" };
  }
}

export const defaultPeriod = (): Period => ({ preset: "this_fy", ...presetRange("this_fy") });

/** True when the date (ISO) falls in the period; items without a date always count. */
export function inPeriod(period: Period, value: string | null | undefined) {
  if (period.preset === "all" || !value) return true;
  const day = value.slice(0, 10);
  return (!period.from || day >= period.from) && (!period.to || day <= period.to);
}

export function periodLabel(period: Period) {
  if (period.preset === "all") return "All dates";
  const format = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return period.preset === "custom" ? `${period.from ? format(period.from) : "…"} – ${period.to ? format(period.to) : "…"}` : `${LABELS[period.preset]} (${format(period.from)} – ${format(period.to)})`;
}

export function PeriodFilter({ period, onChange, basis }: { period: Period; onChange: (period: Period) => void; basis: string }) {
  return <div className="period-filter" title={`Filtered by ${basis.toLowerCase()}`}>
    <label><span className="period-basis">{basis}</span>
      <select value={period.preset} onChange={(event) => { const preset = event.target.value as PeriodPreset; onChange(preset === "custom" ? { preset, from: period.from || presetRange("this_month").from, to: period.to || presetRange("this_month").to } : { preset, ...presetRange(preset) }); }}>
        {(Object.keys(LABELS) as PeriodPreset[]).map((key) => <option key={key} value={key}>{LABELS[key]}</option>)}
      </select>
    </label>
    {period.preset === "custom" && <>
      <input type="date" aria-label="From" value={period.from} max={period.to || undefined} onChange={(event) => onChange({ ...period, from: event.target.value })} />
      <span aria-hidden="true">–</span>
      <input type="date" aria-label="To" value={period.to} min={period.from || undefined} onChange={(event) => onChange({ ...period, to: event.target.value })} />
    </>}
  </div>;
}
