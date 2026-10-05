import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { queueInitialNotification } from "@/lib/notifications/event-factory";
import { normalizeStoredE164 } from "@/lib/notifications/eligibility";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readIdempotencyKey } from "@/lib/tally/contracts";

type RouteContext = { params: Promise<{ companyId: string }> };
const APEX_TEST_CUSTOMER = "Apex Rebar Projects";

export function OPTIONS(request: Request) { return optionsWithCors(request); }

/**
 * A deliberately narrow live-delivery test. The client cannot provide a
 * phone number, message content, tier, or customer; all four are resolved
 * from the persisted TOD proposal and the controlled Apex contact.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = await request.json().catch(() => ({})) as { proposalId?: unknown };
    const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : "";
    if (!isUuid(proposalId)) return jsonWithCors(request, { error: "A saved Turnover Discount customer result must be selected." }, { status: 400 });

    const supabase = createSupabaseAdminClient();
    const { data: proposal, error: proposalError } = await supabase
      .from("discount_proposals")
      .select("id, customer_id, scheme_type, status, achieved_tier_id")
      .eq("id", proposalId).eq("company_id", scope.company.id).maybeSingle();
    if (proposalError) throw proposalError;
    if (!proposal || proposal.scheme_type !== "tod" || !["tracking", "eligible"].includes(proposal.status) || !proposal.achieved_tier_id) {
      return jsonWithCors(request, { error: "This customer does not currently have a valid reached TOD tier. Run the calculation again first." }, { status: 409 });
    }
    const { data: tierReductionIssue, error: tierReductionIssueError } = await supabase
      .from("processing_issues").select("id")
      .eq("company_id", scope.company.id).eq("proposal_id", proposal.id)
      .eq("issue_type", "tod_tier_reduced_after_notification").in("status", ["open", "in_progress"])
      .limit(1).maybeSingle();
    if (tierReductionIssueError) throw tierReductionIssueError;
    if (tierReductionIssue) {
      return jsonWithCors(request, { error: "A previously messaged TOD tier was reduced after refreshed Tally data. Finance review is required before another customer message." }, { status: 409 });
    }

    const { data: customer, error: customerError } = await supabase
      .from("customers").select("id, ledger_name")
      .eq("id", proposal.customer_id).eq("company_id", scope.company.id).eq("is_available", true).maybeSingle();
    if (customerError) throw customerError;
    if (!customer || customer.ledger_name !== APEX_TEST_CUSTOMER) {
      return jsonWithCors(request, { error: "The controlled TOD WhatsApp test is available only for Apex Rebar Projects." }, { status: 409 });
    }

    const { data: contact, error: contactError } = await supabase
      .from("customer_contacts").select("phone_e164")
      .eq("company_id", scope.company.id).eq("customer_id", customer.id).eq("is_active", true)
      .order("is_primary", { ascending: false }).order("entered_at", { ascending: true }).order("id", { ascending: true }).limit(1).maybeSingle();
    if (contactError) throw contactError;
    const testRecipient = normalizeStoredE164(process.env.MEENAKSHI_MSG91_TEST_RECIPIENT_E164);
    if (!testRecipient || normalizeStoredE164(contact?.phone_e164) !== testRecipient) {
      return jsonWithCors(request, { error: "Apex must retain the configured WhatsApp test number before this controlled test can be queued." }, { status: 409 });
    }

    const queued = await queueInitialNotification({
      companyId: scope.company.id,
      proposalId: proposal.id,
      eventType: "tod_tier_reached",
      actorId: scope.userId,
    });
    return jsonWithCors(request, {
      state: "queued",
      ...queued,
      message: queued.queued ? "TOD tier-reached WhatsApp test queued for the configured Apex test number." : queued.blockedReason,
    }, { status: queued.queued ? 201 : 409 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not queue TOD WhatsApp test message:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not queue the TOD WhatsApp test message." }, { status: 500 });
  }
}
