export const TALLY_SYNC_KINDS = ["masters", "vouchers"] as const;
export type TallySyncKind = (typeof TALLY_SYNC_KINDS)[number];

export type TallyVoucherSyncScope = {
  dateFrom?: string;
  dateTo?: string;
  customerId?: string;
  voucherReference?: string;
  cursor?: string;
};

export type TallySyncRun = {
  id: string;
  company_id: string;
  sync_kind: TallySyncKind;
  status: "queued" | "running" | "completed" | "completed_with_errors" | "failed";
  requested_scope: Record<string, unknown>;
  cursor_from: string | null;
  cursor_to: string | null;
  records_received: number;
  records_applied: number;
  records_failed: number;
  source_fingerprint: string | null;
  error_summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

function readText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validDate(value: string | null) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
}

function daysBetween(start: string, end: string) {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

export function readIdempotencyKey(request: Request) {
  return readText(request.headers.get("idempotency-key"), 180);
}

export function parseVoucherSyncScope(body: Record<string, unknown>): { scope?: TallyVoucherSyncScope; error?: string } {
  const dateFrom = readText(body.dateFrom, 10);
  const dateTo = readText(body.dateTo, 10);
  const customerId = readText(body.customerId, 80);
  const voucherReference = readText(body.voucherReference, 200);
  const cursor = readText(body.cursor, 500);

  if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) return { error: "dateFrom and dateTo must be supplied together." };
  if (dateFrom && dateTo) {
    if (!validDate(dateFrom) || !validDate(dateTo) || daysBetween(dateFrom, dateTo) < 0) return { error: "dateFrom and dateTo must be valid ISO dates in ascending order." };
    if (daysBetween(dateFrom, dateTo) > 370) return { error: "A voucher sync can cover at most 370 days; request the next chunk separately." };
    if (cursor && (!validDate(cursor) || cursor < dateFrom || cursor > dateTo)) return { error: "cursor must be an ISO date inside the requested date range." };
  }
  if (customerId && !isUuid(customerId)) return { error: "customerId must be a UUID." };
  if (!dateFrom && !customerId && !voucherReference) {
    return { error: "Voucher sync requires a date range, customerId, or voucherReference." };
  }

  return {
    scope: {
      ...(dateFrom && dateTo ? { dateFrom, dateTo } : {}),
      ...(customerId ? { customerId } : {}),
      ...(voucherReference ? { voucherReference } : {}),
      ...(cursor ? { cursor } : {}),
    },
  };
}
