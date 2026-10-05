import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { getMasterSyncReadiness, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

// This endpoint deliberately exposes selected fields only. Raw Tally payloads
// remain server-side evidence and are not returned to the Rulebook browser UI.
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const isAdministrator = scope.roles.includes("administrator");
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const requestedLimit = Number(url.searchParams.get("limit") ?? 500);
    const limit = Number.isFinite(requestedLimit) ? Math.min(1000, Math.max(50, Math.floor(requestedLimit))) : 500;
    const supabase = createSupabaseAdminClient();
    // Helper to apply q filter (ilike) and limit; keeps 7 masters bounded (was unbounded → 5k+ rows each)
    const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
    const customerGroupsQuery = supabase.from("customer_groups").select("id, tally_group_guid, tally_master_id, tally_alter_id, name, parent_group_id, is_available, last_seen_at").eq("company_id", companyId).order("name").limit(limit);
    const customersQuery = supabase.from("customers").select("id, tally_ledger_guid, tally_master_id, tally_alter_id, ledger_name, current_customer_group_id, tax_identifier, is_available, last_seen_at").eq("company_id", companyId).order("ledger_name").limit(limit);
    const stockGroupsQuery = supabase.from("stock_groups").select("id, tally_group_guid, tally_master_id, tally_alter_id, name, parent_stock_group_id, is_available, last_seen_at").eq("company_id", companyId).order("name").limit(limit);
    const stockItemsQuery = supabase.from("stock_items").select("id, tally_stock_item_guid, tally_master_id, tally_alter_id, name, current_stock_group_id, default_uom_id, is_available, last_seen_at").eq("company_id", companyId).order("name").limit(limit);
    const unitsQuery = supabase.from("tally_units").select("id, code, name, tally_guid, tally_master_id, tally_alter_id, is_available, last_seen_at").eq("company_id", companyId).order("code").limit(limit);
    const voucherTypesQuery = supabase.from("tally_voucher_types").select("id, tally_voucher_type_guid, tally_master_id, tally_alter_id, name, is_credit_note_type, is_available, last_seen_at").eq("company_id", companyId).order("name").limit(limit);
    // The rule editor only allows available, GST-not-applicable discount
    // ledgers. Applying that filter before the bounded list prevents valid
    // ledgers near the end of a large Tally chart from being silently cut off.
    const ledgersQuery = supabase.from("tally_ledgers").select("id, tally_ledger_guid, tally_master_id, tally_alter_id, name, parent_group_name, gst_applicability, is_available, last_seen_at").eq("company_id", companyId).eq("is_available", true).ilike("gst_applicability", "not applicable").order("name").limit(limit);
    if (like) {
      customerGroupsQuery.ilike("name", like);
      customersQuery.ilike("ledger_name", like);
      stockGroupsQuery.ilike("name", like);
      stockItemsQuery.ilike("name", like);
      unitsQuery.ilike("name", like);
      voucherTypesQuery.ilike("name", like);
      ledgersQuery.ilike("name", like);
    }
    const [readiness, customerGroups, customers, stockGroups, stockItems, units, voucherTypes, ledgers] = await Promise.all([
      getMasterSyncReadiness(companyId),
      customerGroupsQuery,
      customersQuery,
      stockGroupsQuery,
      stockItemsQuery,
      unitsQuery,
      voucherTypesQuery,
      ledgersQuery,
    ]);
    const errors = [customerGroups.error, customers.error, stockGroups.error, stockItems.error, units.error, voucherTypes.error, ledgers.error].filter(Boolean);
    if (errors.length) throw errors[0];

    const customerRows = (customers.data ?? []).map((customer) => {
      return {
        ...customer,
        tallyContact: {
          // phone is intentionally not bulk-exposed; use /contacts with per-customer consent
          phone: null,
          contactName: null,
        },
      };
    });

    return jsonWithCors(request, {
      masterSync: readiness,
      masters: {
        customerGroups: customerGroups.data ?? [],
        customers: customerRows,
        stockGroups: stockGroups.data ?? [],
        stockItems: stockItems.data ?? [],
        units: units.data ?? [],
        voucherTypes: voucherTypes.data ?? [],
        ledgers: ledgers.data ?? [],
      },
    }, { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=60" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    return rulebookErrorResponse(request, error, "load Rulebook reference data");
  }
}
