import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { sendManualWhatsApp, type ManualSendItem } from "@/lib/notifications/manual-send";
import { isUuid } from "@/lib/security";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

function text(value: unknown, maximum = 200) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function readItem(value: unknown): ManualSendItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const phone = text(row.phone, 40);
  if ((row.kind === "credit_note" || row.kind === "debit_note") && isUuid(row.postingId)) {
    return { kind: row.kind, postingId: String(row.postingId), phone };
  }
  if (row.kind === "cd_reminder" && isUuid(row.evaluationRunId) && text(row.customerName) && /^\d{4}-\d{2}-\d{2}$/.test(text(row.invoiceDate, 10)) && text(row.billReference)) {
    return {
      kind: "cd_reminder", evaluationRunId: String(row.evaluationRunId), customerName: text(row.customerName),
      invoiceNumber: text(row.invoiceNumber, 80), invoiceDate: text(row.invoiceDate, 10), billReference: text(row.billReference), phone,
    };
  }
  return null;
}

/**
 * Sends WhatsApp messages the administrator has explicitly chosen to send,
 * each to the number entered for it. Every item is independent: one failure
 * does not stop the rest of the batch.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const scope = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const body = (await request.json().catch(() => ({}))) as { items?: unknown };
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) return jsonWithCors(request, { error: "Choose at least one message to send." }, { status: 400 });
    if (rawItems.length > 50) return jsonWithCors(request, { error: "Send up to 50 messages at a time." }, { status: 400 });

    const results = [];
    for (const raw of rawItems) {
      const item = readItem(raw);
      const key = raw && typeof raw === "object" ? text((raw as Record<string, unknown>).key, 200) : "";
      if (!item) { results.push({ key, ok: false, error: "This message could not be read. Refresh the page and try again.", code: "invalid" }); continue; }
      results.push({ key, ...(await sendManualWhatsApp(scope, item)) });
    }
    const sent = results.filter((result) => result.ok).length;
    return jsonWithCors(request, { sent, failed: results.length - sent, results });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not send WhatsApp messages:", error);
    return jsonWithCors(request, { error: "Could not send the WhatsApp messages." }, { status: 500 });
  }
}
