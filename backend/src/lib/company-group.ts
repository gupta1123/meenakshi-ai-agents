import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * A Tally company that was split per financial year is several Meenakshi companies that share one
 * Tally ID (and organization). To the people using the app they are ONE company: the group.
 * The newest year is the group's primary (what is shown first and where new work starts).
 */
export type GroupMember = { id: string; name: string; guid: string; booksFrom: string | null };

type Row = { id: string; tally_company_name: string; tally_company_guid: string | null; tally_books_from: string | null };

export function groupOf(rows: Row[], companyId: string): GroupMember[] {
  const mine = rows.find((row) => row.id === companyId);
  if (!mine?.tally_company_guid) return mine ? [toMember(mine)] : [];
  return rows
    .filter((row) => row.tally_company_guid === mine.tally_company_guid)
    .map(toMember)
    .sort((a, b) => String(a.booksFrom ?? "").localeCompare(String(b.booksFrom ?? "")));
}

/** A split starts on booksFrom. Later splits own periods starting on or after their opening date. */
export function periodBookMatches(members: GroupMember[], companyId: string, periodStart: unknown) {
  if (typeof periodStart !== "string" || members.some(member => !member.booksFrom)) return true;
  const owner = members.filter(member => member.booksFrom! <= periodStart).at(-1);
  return !owner || owner.id === companyId;
}

function toMember(row: Row): GroupMember {
  return { id: row.id, name: row.tally_company_name, guid: row.tally_company_guid ?? "", booksFrom: row.tally_books_from };
}

/** Every active company of the same Tally company in the same organization, oldest year first. */
export async function loadCompanyGroup(companyId: string, organizationId: string): Promise<GroupMember[]> {
  const db = createSupabaseAdminClient();
  const { data: self, error } = await db.from("companies").select("tally_company_guid").eq("id", companyId).eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  const guid = (self as { tally_company_guid: string | null } | null)?.tally_company_guid;
  if (!guid) return [];
  const { data, error: groupError } = await db.from("companies")
    .select("id, tally_company_name, tally_company_guid, tally_books_from")
    .eq("organization_id", organizationId).eq("tally_company_guid", guid).eq("is_active", true)
    .order("tally_books_from", { ascending: true });
  if (groupError) throw groupError;
  return ((data ?? []) as Row[]).map(toMember);
}

/** The ids a list screen should read for this company: its own year plus every sibling year. */
export async function groupCompanyIds(companyId: string, organizationId: string): Promise<string[]> {
  const members = await loadCompanyGroup(companyId, organizationId);
  return members.length ? members.map((member) => member.id) : [companyId];
}

/**
 * For the sign-in bootstrap: tag each company with its group so the dropdown can show the group
 * once. The newest year of a group carries `year_members`; older years are marked `year_of`.
 */
export function tagYearGroups<T extends { id: string; tally_company_guid: string | null; tally_books_from: string | null; tally_company_name: string }>(companies: T[]) {
  const byGuid = new Map<string, T[]>();
  for (const company of companies) {
    if (!company.tally_company_guid) continue;
    const list = byGuid.get(company.tally_company_guid) ?? [];
    list.push(company);
    byGuid.set(company.tally_company_guid, list);
  }
  return companies.map((company) => {
    const list = company.tally_company_guid ? byGuid.get(company.tally_company_guid) ?? [] : [];
    if (list.length < 2) return company;
    const ordered = [...list].sort((a, b) => String(a.tally_books_from ?? "").localeCompare(String(b.tally_books_from ?? "")));
    const primary = ordered[ordered.length - 1];
    if (primary.id !== company.id) return { ...company, year_of: primary.id };
    return { ...company, year_members: ordered.map((item) => ({ id: item.id, name: item.tally_company_name, books_from: item.tally_books_from })) };
  });
}
