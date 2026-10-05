import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };

const VOUCHER_KINDS = new Set(["sales", "receipt", "sales_return", "debit_note", "credit_note", "other"]);

function isIsoDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function daysBetween(from: string, to: string) {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }

// A safe operational lookup used by Postman and the future evaluation UI.
// Raw Tally payload/XML and bill allocations remain server-only evidence.
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });

    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const url = new URL(request.url);
    const dateFrom = readText(url.searchParams.get("dateFrom"), 10);
    const dateTo = readText(url.searchParams.get("dateTo"), 10);
    const voucherNumber = readText(url.searchParams.get("voucherNumber"), 200);
    const voucherKind = readText(url.searchParams.get("voucherKind"), 30)?.toLowerCase() ?? null;
    const customerId = readText(url.searchParams.get("customerId"), 80);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 50;

    if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
      return jsonWithCors(request, { error: "dateFrom and dateTo must be supplied together." }, { status: 400 });
    }
    if (dateFrom && dateTo && (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || daysBetween(dateFrom, dateTo) < 0 || daysBetween(dateFrom, dateTo) > 370)) {
      return jsonWithCors(request, { error: "Date range must use ascending ISO dates and cover at most 370 days." }, { status: 400 });
    }
    if (!dateFrom && !voucherNumber) {
      return jsonWithCors(request, { error: "Supply a date range or an exact voucherNumber." }, { status: 400 });
    }
    if (voucherKind && !VOUCHER_KINDS.has(voucherKind)) {
      return jsonWithCors(request, { error: "voucherKind is not supported." }, { status: 400 });
    }
    if (customerId && !isUuid(customerId)) return jsonWithCors(request, { error: "customerId must be a UUID." }, { status: 400 });

    let query = createSupabaseAdminClient()
      .from("tally_vouchers")
      .select("id, tally_guid, tally_master_id, tally_alter_id, voucher_number, voucher_kind, voucher_date, party_customer_id, linked_sales_voucher_id, status, taxable_product_value, gross_amount, created_at, updated_at")
      .eq("company_id", company.id)
      .order("voucher_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (dateFrom && dateTo) query = query.gte("voucher_date", dateFrom).lte("voucher_date", dateTo);
    if (voucherNumber) query = query.eq("voucher_number", voucherNumber);
    if (voucherKind) query = query.eq("voucher_kind", voucherKind);
    if (customerId) query = query.eq("party_customer_id", customerId);

    const { data, error } = await query;
    if (error) throw error;
    return jsonWithCors(request, { vouchers: data ?? [] });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list synced Tally vouchers:", error);
    return jsonWithCors(request, { error: "Could not list synced Tally vouchers." }, { status: 500 });
  }
}
