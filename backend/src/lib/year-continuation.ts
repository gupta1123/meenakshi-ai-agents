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
