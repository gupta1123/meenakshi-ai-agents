import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireMeenakshiCompanyAccess, MeenakshiAccessError } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
export function OPTIONS(request: Request) { return optionsWithCors(request); }

const HEALTH_TTL_MS = 10_000;
const notifHealthCache = new Map<string, { expiresAt: number; data: unknown }>();

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });
    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const cached = notifHealthCache.get(company.id);
    if (cached && cached.expiresAt > Date.now()) {
      return jsonWithCors(request, cached.data, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "HIT" } });
    }
    const supabase = createSupabaseAdminClient();
    const { data: rpcData, error: rpcError } = await supabase.rpc("get_notification_health", { p_company_id: company.id });
    const isMissingRpc = rpcError && (String((rpcError as { code?: string }).code) === "42883" || String(rpcError.message ?? "").includes("get_notification_health"));
    if (!isMissingRpc && rpcData) {
      const payload = rpcData as { counts: Record<string, number>; retrying: number; terminalFailures: number; sampledMessages: number };
      // ensure all 8 statuses present (RPC returns only existing keys)
      const fullCounts = Object.fromEntries(["queued", "sending", "sent", "delivered", "read", "failed", "suppressed", "cancelled"].map((s) => [s, (payload.counts as Record<string, number>)[s] ?? 0])) as Record<string, number>;
      const out = { counts: fullCounts, retrying: payload.retrying, terminalFailures: payload.terminalFailures, sampledMessages: payload.sampledMessages };
      notifHealthCache.set(company.id, { expiresAt: Date.now() + HEALTH_TTL_MS, data: out });
      return jsonWithCors(request, out, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "MISS" } });
    }
    if (rpcError && !isMissingRpc) console.warn("get_notification_health RPC failed, falling back:", rpcError);
    const { data, error } = await supabase.from("notification_messages")
      .select("status, attempt_count, max_attempts, provider_metadata")
      .eq("company_id", company.id).limit(1_000);
    if (error) throw error;
    const messages = data ?? [];
    const counts = Object.fromEntries(["queued", "sending", "sent", "delivered", "read", "failed", "suppressed", "cancelled"].map((status) => [status, 0])) as Record<string, number>;
    let retrying = 0;
    let terminalFailures = 0;
    for (const message of messages as Array<{ status: string; attempt_count: number; max_attempts: number; provider_metadata: Record<string, unknown> | null }>) {
      counts[message.status] = (counts[message.status] ?? 0) + 1;
      if (message.status === "failed" && message.attempt_count < message.max_attempts && message.provider_metadata?.terminal !== true) retrying += 1;
      if (message.status === "failed" && (message.attempt_count >= message.max_attempts || message.provider_metadata?.terminal === true)) terminalFailures += 1;
    }
    const fallback = { counts, retrying, terminalFailures, sampledMessages: messages.length };
    notifHealthCache.set(company.id, { expiresAt: Date.now() + HEALTH_TTL_MS, data: fallback });
    return jsonWithCors(request, fallback, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": isMissingRpc ? "FALLBACK-MISSING-RPC" : "FALLBACK" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not load notification health:", error);
    return jsonWithCors(request, { error: "Could not load notification health." }, { status: 500 });
  }
}
