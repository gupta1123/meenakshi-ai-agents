import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/** How far past the year boundary receipts are read. Payment windows are days to weeks, never months. */
export const CONTINUATION_HORIZON_DAYS = 60;

export type YearContinuation = {
  company: { name: string; guid: string; booksFrom: string };
  dateFrom: string;
  dateTo: string;
};

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * The next financial year's company of the same Tally company, if there is one.
 * Receipts for this year's invoices are posted there after the year end, so a
 * check that reaches past the boundary must read them too (the connector does it).
 * Returns null when the company has no year, has no successor, or the check does
 * not reach the boundary: nothing changes for those.
 */
export function continuationWindow(successor: { name: string; guid: string; booksFrom: string }, throughDate: string): YearContinuation | null {
  if (!throughDate || throughDate < successor.booksFrom) return null;
  const horizon = addDays(successor.booksFrom, CONTINUATION_HORIZON_DAYS - 1);
  return { company: successor, dateFrom: successor.booksFrom, dateTo: throughDate < horizon ? throughDate : horizon };
}

export async function loadYearSuccessor(company: { organization_id?: string | null; tally_company_guid: string | null; tally_books_from?: string | null }, organizationId: string) {
  if (!company.tally_company_guid || !company.tally_books_from) return null;
  const { data, error } = await createSupabaseAdminClient()
    .from("companies")
    .select("tally_company_name, tally_company_guid, tally_books_from")
    .eq("organization_id", organizationId)
    .eq("tally_company_guid", company.tally_company_guid)
    .eq("is_active", true)
    .gt("tally_books_from", company.tally_books_from)
    .order("tally_books_from", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const row = data as { tally_company_name: string; tally_company_guid: string; tally_books_from: string } | null;
  return row?.tally_books_from ? { name: row.tally_company_name, guid: row.tally_company_guid, booksFrom: row.tally_books_from } : null;
}

/** Last day of the financial year that starts on booksFrom (31 March for an April start). */
export function booksYearEnd(booksFrom: string) {
  const value = new Date(`${booksFrom}T00:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() + 1);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

/** True when a voucher dated `date` can be entered in a company whose books start on booksFrom. */
export function dateInBooksYear(booksFrom: string | null | undefined, date: string) {
  if (!booksFrom) return true; // unknown period: nothing to check against
  return date >= booksFrom && date <= booksYearEnd(booksFrom);
}

/**
 * Plain reason when a voucher dated today cannot be entered in this company (its financial year
 * does not contain today), otherwise null. Posting routes call it before queuing anything.
 */
export async function postingDateProblem(companyId: string, today = new Date().toISOString().slice(0, 10)) {
  const { data, error } = await createSupabaseAdminClient().from("companies").select("tally_books_from").eq("id", companyId).maybeSingle();
  if (error) throw error;
  const booksFrom = (data as { tally_books_from: string | null } | null)?.tally_books_from;
  if (dateInBooksYear(booksFrom, today)) return null;
  return `Credit Notes are dated today (${today}), which is outside this company's financial year (${booksFrom} to ${booksYearEnd(String(booksFrom))}). Nothing was created. Credit Notes for an earlier year are created in the current year's company.`;
}
