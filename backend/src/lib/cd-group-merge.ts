import Decimal from "decimal.js";

type Json = Record<string, unknown>;
export type CdPart = {
  companyId: string;
  companyName: string;
  booksFrom: string | null;
  data: { run: Json | null; totals: Json; requiresRecheck: boolean; results: Json[]; candidates: Json[]; creditNotes: Record<string, Json> };
};

const NUMERIC = /^-?\d+(\.\d+)?$/;
const isPlain = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Adds counts and money across years; leaves anything that is not a number (dates, flags, ids) to the newest year. */
function mergeValue(values: unknown[]): unknown {
  const last = values[values.length - 1];
  if (values.every((value) => typeof value === "number")) return (values as number[]).reduce((sum, value) => sum + value, 0);
  if (values.every((value) => typeof value === "string" && NUMERIC.test(value))) {
    const decimals = Math.max(...(values as string[]).map((value) => (value.split(".")[1] ?? "").length));
    return (values as string[]).reduce((sum, value) => sum.plus(value), new Decimal(0)).toFixed(decimals);
  }
  if (values.every(isPlain)) return mergeObjects(values as Json[]);
  return last;
}

function mergeObjects(objects: Json[]): Json {
  const out: Json = {};
  for (const key of new Set(objects.flatMap((object) => Object.keys(object)))) {
    const present = objects.filter((object) => key in object).map((object) => object[key]);
    out[key] = mergeValue(present);
  }
  return out;
}

/**
 * One Cash Discount view over every year of a split company: rows from each year (each tagged with
 * the company it belongs to, so actions go to the right books), totals added up, the check period
 * widened to cover all years. Parts are oldest year first; the newest year is the primary.
 */
export function mergeCdSettlements(parts: CdPart[]) {
  if (parts.length === 1) return withCompany(parts[0]);
  const withData = parts.filter((part) => part.data.run || part.data.results.length);
  const use = withData.length ? withData : parts;
  const primary = parts[parts.length - 1];
  const totals = mergeObjects(use.map((part) => part.data.totals));
  const periods = use.map((part) => part.data.totals.invoicePeriod).filter(isPlain) as Array<{ from?: string; to?: string }>;
  if (periods.length) {
    totals.invoicePeriod = {
      from: periods.map((period) => period.from).filter(Boolean).sort()[0],
      to: periods.map((period) => period.to).filter(Boolean).sort().slice(-1)[0],
    };
  }
  if (primary.data.totals.creditNoteMatchingVersion !== undefined) totals.creditNoteMatchingVersion = primary.data.totals.creditNoteMatchingVersion;
  const tag = (part: CdPart) => ({ companyId: part.companyId, companyYear: part.booksFrom });
  return {
    run: primary.data.run ?? [...use].reverse().find((part) => part.data.run)?.data.run ?? null,
    runs: use.filter((part) => part.data.run).map((part) => ({ ...(part.data.run as Json), companyId: part.companyId, companyName: part.companyName, booksFrom: part.booksFrom })),
    totals,
    requiresRecheck: use.some((part) => part.data.requiresRecheck),
    results: use.flatMap((part) => part.data.results.map((row) => ({ ...row, ...tag(part) }))),
    candidates: use.flatMap((part) => part.data.candidates.map((row) => ({ ...row, ...tag(part) }))),
    creditNotes: Object.assign({}, ...use.map((part) => Object.fromEntries(Object.entries(part.data.creditNotes).map(([key, note]) => [key, { ...note, ...tag(part) }])))),
  };
}

function withCompany(part: CdPart) {
  const tag = { companyId: part.companyId, companyYear: part.booksFrom };
  return {
    run: part.data.run, runs: part.data.run ? [{ ...part.data.run, companyId: part.companyId, companyName: part.companyName, booksFrom: part.booksFrom }] : [],
    totals: part.data.totals, requiresRecheck: part.data.requiresRecheck,
    results: part.data.results.map((row) => ({ ...row, ...tag })), candidates: part.data.candidates.map((row) => ({ ...row, ...tag })),
    creditNotes: Object.fromEntries(Object.entries(part.data.creditNotes).map(([key, note]) => [key, { ...note, ...tag }])),
  };
}
