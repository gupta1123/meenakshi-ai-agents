import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

/** The latest WhatsApp status of each Cash Discount reminder, keyed by invoice. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const supabase = createSupabaseAdminClient();
    const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const { data: messages, error: messagesError } = await supabase
      .from("notification_messages").select("proposal_id, status, recipient_phone_e164, created_at")
      .eq("company_id", scope.company.id).eq("event_type", "cd_shortfall").gte("created_at", since)
      .order("created_at", { ascending: false }).limit(500);
    if (messagesError) throw messagesError;
    const latestByProposal = new Map<string, { status: string; recipient: string; sentAt: string }>();
    for (const message of messages ?? []) {
      if (message.proposal_id && !latestByProposal.has(message.proposal_id)) {
        latestByProposal.set(message.proposal_id, { status: message.status, recipient: message.recipient_phone_e164, sentAt: message.created_at });
      }
    }
    const proposalIds = [...latestByProposal.keys()];
    if (!proposalIds.length) return jsonWithCors(request, { reminders: [] });
    const { data: proposals, error: proposalsError } = await supabase
      .from("discount_proposals").select("id, customer_id, source_sales_voucher_id")
      .eq("company_id", scope.company.id).in("id", proposalIds);
    if (proposalsError) throw proposalsError;
    const voucherIds = [...new Set((proposals ?? []).map((proposal) => proposal.source_sales_voucher_id).filter((id): id is string => Boolean(id)))];
    const customerIds = [...new Set((proposals ?? []).map((proposal) => proposal.customer_id))];
    const [{ data: vouchers, error: vouchersError }, { data: customers, error: customersError }] = await Promise.all([
      voucherIds.length ? supabase.from("tally_vouchers").select("id, voucher_number, voucher_date").eq("company_id", scope.company.id).in("id", voucherIds) : Promise.resolve({ data: [], error: null }),
      customerIds.length ? supabase.from("customers").select("id, ledger_name").eq("company_id", scope.company.id).in("id", customerIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (vouchersError) throw vouchersError;
    if (customersError) throw customersError;
    const voucherById = new Map((vouchers ?? []).map((voucher) => [voucher.id, voucher]));
    const customerById = new Map((customers ?? []).map((customer) => [customer.id, customer]));
    const reminders = (proposals ?? []).flatMap((proposal) => {
      const voucher = proposal.source_sales_voucher_id ? voucherById.get(proposal.source_sales_voucher_id) : null;
      const customer = customerById.get(proposal.customer_id);
      const message = latestByProposal.get(proposal.id);
      return voucher && customer && message ? [{ customerName: customer.ledger_name, invoiceNumber: voucher.voucher_number, invoiceDate: voucher.voucher_date, ...message }] : [];
    });
    return jsonWithCors(request, { reminders });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load Cash Discount reminder status:", error);
    return jsonWithCors(request, { error: "Could not load Cash Discount reminder status." }, { status: 500 });
  }
}
