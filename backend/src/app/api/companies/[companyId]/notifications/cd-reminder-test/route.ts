import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { queueInitialNotification } from "@/lib/notifications/event-factory";
import { normalizeStoredE164 } from "@/lib/notifications/eligibility";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readIdempotencyKey } from "@/lib/tally/contracts";

type RouteContext = { params: Promise<{ companyId: string }> };
type Reminder = {
  customerName: string; invoiceNumber: string | null; invoiceDate: string; billReference: string;
  amountPaid: string; shortfallAmount: string; eligibilityDeadline: string; status: string; reasonCode: string;
};

function text(value: unknown, maximum = 200) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function reminderFromRun(value: unknown, input: { customerName: string; invoiceNumber: string; invoiceDate: string; billReference: string }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rows = (value as { openReminderCandidates?: unknown }).openReminderCandidates;
  if (!Array.isArray(rows)) return null;
  return rows.find((row): row is Reminder => Boolean(row) && typeof row === "object" && !Array.isArray(row)
    && (row as Record<string, unknown>).status === "ready"
    && text((row as Record<string, unknown>).customerName) === input.customerName
    && text((row as Record<string, unknown>).invoiceNumber) === input.invoiceNumber
    && text((row as Record<string, unknown>).invoiceDate, 10) === input.invoiceDate
    && text((row as Record<string, unknown>).billReference) === input.billReference) ?? null;
}

/**
 * This is intentionally a test-recipient-only bridge for live CD reminders.
 * It never accepts a telephone number or free-form message body from the UI.
 */
export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const testRecipient = normalizeStoredE164(process.env.MEENAKSHI_MSG91_TEST_RECIPIENT_E164);
    if (!testRecipient) return jsonWithCors(request, { reminders: [] });
    const supabase = createSupabaseAdminClient();
    const { data: contacts, error: contactsError } = await supabase
      .from("customer_contacts").select("id, customer_id").eq("company_id", scope.company.id).eq("phone_e164", testRecipient).eq("is_active", true);
    if (contactsError) throw contactsError;
    const contactIds = (contacts ?? []).map((contact) => contact.id);
    if (!contactIds.length) return jsonWithCors(request, { reminders: [] });
    const { data: messages, error: messagesError } = await supabase
      .from("notification_messages").select("proposal_id, status, created_at")
      .eq("company_id", scope.company.id).eq("event_type", "cd_shortfall").in("customer_contact_id", contactIds)
      .order("created_at", { ascending: false });
    if (messagesError) throw messagesError;
    const proposalIds = [...new Set((messages ?? []).map((message) => message.proposal_id))];
    if (!proposalIds.length) return jsonWithCors(request, { reminders: [] });
    const { data: proposals, error: proposalsError } = await supabase
      .from("discount_proposals").select("id, customer_id, source_sales_voucher_id")
      .eq("company_id", scope.company.id).in("id", proposalIds);
    if (proposalsError) throw proposalsError;
    const voucherIds = [...new Set((proposals ?? []).map((proposal) => proposal.source_sales_voucher_id).filter((id): id is string => Boolean(id)))];
    if (!voucherIds.length) return jsonWithCors(request, { reminders: [] });
    const { data: vouchers, error: vouchersError } = await supabase
      .from("tally_vouchers").select("id, voucher_number, voucher_date, party_customer_id")
      .eq("company_id", scope.company.id).in("id", voucherIds);
    if (vouchersError) throw vouchersError;
    const customerIds = [...new Set((proposals ?? []).map((proposal) => proposal.customer_id))];
    const { data: customers, error: customersError } = await supabase
      .from("customers").select("id, ledger_name").eq("company_id", scope.company.id).in("id", customerIds);
    if (customersError) throw customersError;
    const proposalById = new Map((proposals ?? []).map((proposal) => [proposal.id, proposal]));
    const voucherById = new Map((vouchers ?? []).map((voucher) => [voucher.id, voucher]));
    const customerById = new Map((customers ?? []).map((customer) => [customer.id, customer]));
    const reminders = (messages ?? []).flatMap((message) => {
      const proposal = proposalById.get(message.proposal_id);
      const voucher = proposal?.source_sales_voucher_id ? voucherById.get(proposal.source_sales_voucher_id) : null;
      const customer = proposal ? customerById.get(proposal.customer_id) : null;
      return proposal && voucher && customer ? [{ customerName: customer.ledger_name, invoiceNumber: voucher.voucher_number, invoiceDate: voucher.voucher_date, status: message.status }] : [];
    });
    return jsonWithCors(request, { reminders });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load Cash Discount WhatsApp test reminder status:", error);
    return jsonWithCors(request, { error: "Could not load Cash Discount WhatsApp test reminder status." }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const key = readIdempotencyKey(request);
    if (!key) return jsonWithCors(request, { error: "Idempotency-Key header is required." }, { status: 400 });
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const evaluationRunId = text(body.evaluationRunId, 80);
    const identity = {
      customerName: text(body.customerName), invoiceNumber: text(body.invoiceNumber, 80),
      invoiceDate: text(body.invoiceDate, 10), billReference: text(body.billReference),
    };
    if (!isUuid(evaluationRunId) || !identity.customerName || !identity.invoiceNumber || !/^\d{4}-\d{2}-\d{2}$/.test(identity.invoiceDate) || !identity.billReference) {
      return jsonWithCors(request, { error: "A current Cash Discount reminder must be selected." }, { status: 400 });
    }
    const supabase = createSupabaseAdminClient();
    const { data: run, error: runError } = await supabase
      .from("evaluation_runs")
      .select("id, scheme_version_id, source_fingerprint, summary")
      .eq("id", evaluationRunId).eq("company_id", scope.company.id).maybeSingle();
    if (runError) throw runError;
    const reminder = reminderFromRun(run?.summary, identity);
    const today = new Date().toISOString().slice(0, 10);
    if (!run || !run.scheme_version_id || !reminder || reminder.eligibilityDeadline < today) {
      return jsonWithCors(request, { error: "This reminder is no longer a current, ready Cash Discount reminder. Run the check again." }, { status: 409 });
    }

    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id, current_customer_group_id")
      .eq("company_id", scope.company.id).eq("ledger_name", reminder.customerName).eq("is_available", true).maybeSingle();
    if (customerError) throw customerError;
    if (!customer) return jsonWithCors(request, { error: "The selected customer is no longer available in Tally." }, { status: 409 });
    const { data: contact, error: contactError } = await supabase
      .from("customer_contacts")
      .select("id, phone_e164")
      .eq("company_id", scope.company.id).eq("customer_id", customer.id).eq("is_active", true)
      .order("is_primary", { ascending: false }).order("entered_at", { ascending: true }).order("id", { ascending: true }).limit(1).maybeSingle();
    if (contactError) throw contactError;
    const testRecipient = normalizeStoredE164(process.env.MEENAKSHI_MSG91_TEST_RECIPIENT_E164);
    if (!testRecipient || normalizeStoredE164(contact?.phone_e164) !== testRecipient) {
      return jsonWithCors(request, { error: "This test flow can queue only the configured WhatsApp test recipient." }, { status: 409 });
    }

    const { data: voucher, error: voucherError } = await supabase
      .from("tally_vouchers")
      .select("id, gross_amount")
      .eq("company_id", scope.company.id).eq("party_customer_id", customer.id)
      .eq("voucher_kind", "sales").eq("voucher_number", reminder.invoiceNumber).eq("voucher_date", reminder.invoiceDate)
      .maybeSingle();
    if (voucherError) throw voucherError;
    if (!voucher) {
      return jsonWithCors(request, { error: "Current Cash Discount invoices have not been synchronized yet. Use “Sync current Cash Discount invoices” first." }, { status: 409 });
    }

    const { data: existing, error: existingError } = await supabase
      .from("discount_proposals")
      .select("id")
      .eq("company_id", scope.company.id).eq("customer_id", customer.id).eq("source_sales_voucher_id", voucher.id)
      .eq("scheme_version_id", run.scheme_version_id).eq("scheme_type", "cd").maybeSingle();
    if (existingError) throw existingError;
    let proposalId = existing?.id ?? null;
    if (!proposalId) {
      const { data: inserted, error: insertError } = await supabase.from("discount_proposals").insert({
        company_id: scope.company.id, customer_id: customer.id, scheme_version_id: run.scheme_version_id,
        scheme_type: "cd", source_sales_voucher_id: voucher.id,
        entitlement_key: `live-cd-reminder:${run.scheme_version_id}:${voucher.id}`,
        status: "unpaid", source_fingerprint: run.source_fingerprint || `live-cd:${run.id}`,
        last_live_refresh_at: new Date().toISOString(), customer_group_id_used: customer.current_customer_group_id,
        eligibility_deadline: reminder.eligibilityDeadline, invoice_amount_due: reminder.shortfallAmount,
        amount_paid_by_deadline: reminder.amountPaid, discounted_settlement_target: reminder.shortfallAmount,
        shortfall_amount: reminder.shortfallAmount, calculated_discount_amount: 0,
        reason_codes: [reminder.reasonCode], latest_evaluated_at: new Date().toISOString(), last_manual_change_by: scope.userId,
      }).select("id").single();
      if (insertError) throw insertError;
      proposalId = inserted.id;
    }
    const queued = await queueInitialNotification({ companyId: scope.company.id, proposalId, eventType: "cd_shortfall", actorId: scope.userId });
    return jsonWithCors(request, { state: "queued", ...queued, message: queued.queued ? "WhatsApp test reminder queued for the configured test number." : queued.blockedReason }, { status: queued.queued ? 201 : 409 });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not queue Cash Discount WhatsApp test reminder:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not queue the Cash Discount WhatsApp test reminder." }, { status: 500 });
  }
}
