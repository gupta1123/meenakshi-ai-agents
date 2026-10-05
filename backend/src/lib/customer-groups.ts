import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Supabase = ReturnType<typeof createSupabaseAdminClient>;
export type CustomerGroupInfo = { customerId: string; ledgerName: string | null; groupName: string | null };

/**
 * Each customer's Tally group (its current customer group), for the group
 * column and filter on Credit Notes and Messages. Looks customers up by id
 * or by Tally ledger GUID, in batches.
 */
export async function customerGroupsFor(supabase: Supabase, companyId: string, by: { ids?: string[]; ledgerGuids?: string[] }) {
  const byId = new Map<string, CustomerGroupInfo>();
  const byGuid = new Map<string, CustomerGroupInfo>();
  const rows: Array<{ id: string; tally_ledger_guid: string | null; ledger_name: string | null; current_customer_group_id: string | null }> = [];
  const fetch = async (column: "id" | "tally_ledger_guid", values: string[]) => {
    const unique = [...new Set(values.filter(Boolean))];
    for (let index = 0; index < unique.length; index += 200) {
      const { data, error } = await supabase.from("customers").select("id, tally_ledger_guid, ledger_name, current_customer_group_id")
        .eq("company_id", companyId).in(column, unique.slice(index, index + 200));
      if (error) throw error;
      rows.push(...(data ?? []));
    }
  };
  await fetch("id", by.ids ?? []);
  await fetch("tally_ledger_guid", by.ledgerGuids ?? []);
  const groupIds = [...new Set(rows.map((row) => row.current_customer_group_id).filter((id): id is string => Boolean(id)))];
  const groupNames = new Map<string, string>();
  for (let index = 0; index < groupIds.length; index += 200) {
    const { data, error } = await supabase.from("customer_groups").select("id, name").in("id", groupIds.slice(index, index + 200));
    if (error) throw error;
    for (const group of data ?? []) groupNames.set(group.id, group.name);
  }
  for (const row of rows) {
    const info = { customerId: row.id, ledgerName: row.ledger_name, groupName: row.current_customer_group_id ? groupNames.get(row.current_customer_group_id) ?? null : null };
    byId.set(row.id, info);
    if (row.tally_ledger_guid) byGuid.set(row.tally_ledger_guid, info);
  }
  return { byId, byGuid };
}
