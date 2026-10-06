// Status/history reads need totals, not the saved per-invoice evidence arrays.
const fields = ['message', 'outcome', 'calculatedDiscountAmount', 'liveOnly', 'invoicesChecked', 'actionRequired', 'reviewRequired', 'recoveryAmount', 'alreadyRecovered'] as const;
export type RunSummaryRow = {
  id: string; status: string; created_at: string; scheme_version_id: string | null;
  request_context: Record<string, unknown> | null; summary: unknown;
  [key: string]: unknown;
};
export const compactSummaryColumns = fields.map(field => `compact_${field}:summary->${field}`).join(',');

export function restoreCompactSummary<T extends object>(row: T): T & { summary: Record<string, unknown> } {
  const result = { ...row } as T & { summary: Record<string, unknown> } & Record<string, unknown>;
  result.summary = {};
  for (const field of fields) {
    const key = `compact_${field}`;
    if (result[key] != null) result.summary[field] = result[key];
    delete result[key];
  }
  return result;
}
