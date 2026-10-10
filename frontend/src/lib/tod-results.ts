export type TodPeriodSelection = { start: string; end: string; asOfDate: string; selectedSchemeVersionId: string };
export type TodPeriodReadState = { scope: string; status: "loading" | "loaded" | "error" };

// A newly selected company/period is loading even before its effect starts.
// An empty result is valid only after that exact scope has finished loading.
export function todPeriodReadStatus(scope: string, read: TodPeriodReadState | null) {
  return read?.scope === scope ? read.status : "loading";
}
type ResultPage<T> = { proposals: T[]; hasMore: boolean; nextCursor: string | null };

// Both Customers and View results use this exact, company-scoped period read.
// No activeOnly/includeArchived flags: immutable older rules remain visible,
// but results hidden by a results-only reset remain hidden.
export async function loadTodPeriodResults<T extends { id: string }>(
  requestPage: (params: URLSearchParams) => Promise<ResultPage<T>>,
  start: string, end: string, schemeVersionId?: string,
): Promise<T[]> {
  const rows = new Map<string, T>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 1_000; page += 1) {
    const params = new URLSearchParams({ schemeType: "tod", periodStart: start, periodEnd: end, limit: "200" });
    if (schemeVersionId) params.set("schemeVersionId", schemeVersionId);
    if (cursor) params.set("cursor", cursor);
    const response = await requestPage(params);
    for (const row of response.proposals) rows.set(row.id, row);
    if (!response.hasMore) return [...rows.values()];
    if (!response.nextCursor || cursors.has(response.nextCursor)) throw new Error("Could not load all customer results. Please refresh this period.");
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error("This period has too many results to load safely.");
}

export function assertSelectedTodPeriod(selection: Pick<TodPeriodSelection, "start" | "end">, periods: Array<{ periodStart: string; periodEnd: string }>) {
  if (!periods.length || periods.some((period) => period.periodStart !== selection.start || period.periodEnd !== selection.end)) {
    throw new Error("The calculation does not match the selected period. Reload the periods and calculate again.");
  }
}
