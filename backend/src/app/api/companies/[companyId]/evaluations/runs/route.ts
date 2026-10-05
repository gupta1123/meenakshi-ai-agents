import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { MeenakshiAccessError, requireMeenakshiCompanyAccess } from "@/lib/authorization";
import { isUuid } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { collapseEvaluationRuns } from "@/lib/evaluation/run-batches";

type RouteContext = { params: Promise<{ companyId: string }> };
type SchemeType = "cd" | "tod";

function schemeTypeFromRequestContext(value: unknown): SchemeType | null {
  if (!value || typeof value !== "object") return null;
  const schemeType = (value as Record<string, unknown>).schemeType;
  return schemeType === "cd" || schemeType === "tod" ? schemeType : null;
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }

const RUNS_CACHE_TTL_MS = 5_000;
const runsCache = new Map<string, { expiresAt: number; data: unknown }>();

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    if (!isUuid(companyId)) return jsonWithCors(request, { error: "Invalid company id." }, { status: 400 });

    const { company } = await requireMeenakshiCompanyAccess(request, companyId, ["administrator", "finance_approver"]);
    const searchParams = new URL(request.url).searchParams;
    const requestedScheme = searchParams.get("schemeType");
    if (requestedScheme && requestedScheme !== "cd" && requestedScheme !== "tod") {
      return jsonWithCors(request, { error: "schemeType must be cd or tod." }, { status: 400 });
    }

    const requestedLimit = Number(searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 100;
    const compact = searchParams.get("detail") === "compact";
    const fresh = searchParams.get("fresh") === "1";
    const cacheKey = `${company.id}:${requestedScheme ?? "all"}:${limit}:${compact}`;
    const cached = runsCache.get(cacheKey);
    if (!fresh && cached && cached.expiresAt > Date.now()) {
      return jsonWithCors(request, cached.data, { headers: { "Cache-Control": "private, max-age=5, stale-while-revalidate=10", "X-Cache": "HIT" } });
    }
    const supabase = createSupabaseAdminClient();
    const columns = "id, scheme_version_id, evaluation_date, period_start, period_end, status, error_summary, request_context, started_at, completed_at, created_at, updated_at, attempts, max_attempts, idempotency_key";
    // A TOD calculation stores one child run per customer (hundreds), keyed
    // "<calculationId>:<uuid>". Limiting raw rows therefore showed only the
    // latest one or two calculations. Load calculations first, then the
    // children of TOD calculations with only the fields the totals need.
    const childKey = "________-____-____-____-____________:________-____-____-____-____________";
    let runsQuery = supabase
      .from("evaluation_runs")
      .select(`${columns}, summary`)
      .eq("company_id", company.id)
      .not("idempotency_key", "like", childKey)
      .order("created_at", { ascending: false });
    if (requestedScheme) runsQuery = runsQuery.eq("request_context->>schemeType", requestedScheme);
    const { data: rootRuns, error } = await runsQuery.limit(limit);
    if (error) throw error;
    type RunRow = NonNullable<typeof rootRuns>[number];
    const runs: RunRow[] = [...(rootRuns ?? [])];
    const todRoots = (rootRuns ?? []).filter((run) => schemeTypeFromRequestContext(run.request_context) === "tod");
    await Promise.all(todRoots.map(async (root) => {
      for (let from = 0; ; from += 1000) {
        const { data: children, error: childError } = await supabase.from("evaluation_runs")
          .select(`${columns}, calculatedDiscountAmount:summary->calculatedDiscountAmount`)
          .eq("company_id", company.id).like("idempotency_key", `${root.id}:%`)
          .order("id").range(from, from + 999);
        if (childError) throw childError;
        for (const child of children ?? []) {
          const { calculatedDiscountAmount, ...rest } = child as typeof child & { calculatedDiscountAmount?: unknown };
          runs.push({ ...rest, summary: { calculatedDiscountAmount } } as RunRow);
        }
        if ((children ?? []).length < 1000) break;
      }
    }));

    const versionIds = requestedScheme
      ? []
      : [...new Set((runs ?? [])
          .filter((run) => !schemeTypeFromRequestContext(run.request_context))
          .map((run) => run.scheme_version_id)
          .filter((id): id is string => Boolean(id)))];
    const { data: versions, error: versionsError } = versionIds.length
      ? await supabase.from("scheme_versions").select("id, scheme_type").eq("company_id", company.id).in("id", versionIds)
      : { data: [], error: null };
    if (versionsError) throw versionsError;

    const schemeByVersion = new Map((versions ?? []).map((version) => [version.id, version.scheme_type as SchemeType]));
    const schemeType = requestedScheme as SchemeType | null;
    const evaluationRuns = collapseEvaluationRuns((runs ?? [])
      .map((run) => {
        const summary = run.summary && typeof run.summary === "object" ? run.summary as Record<string, unknown> : {};
        const liveSummary = compact
          ? Object.fromEntries(["liveOnly", "invoicesChecked", "actionRequired", "reviewRequired", "recoveryAmount", "alreadyRecovered"].filter((key) => key in summary).map((key) => [key, summary[key]]))
          : summary;
        return {
          ...run,
          summary: {
            message: typeof summary.message === "string" ? summary.message : null,
            outcome: typeof summary.outcome === "string" ? summary.outcome : null,
            calculatedDiscountAmount: typeof summary.calculatedDiscountAmount === "string" || typeof summary.calculatedDiscountAmount === "number" ? summary.calculatedDiscountAmount : null,
            ...(run.request_context && (run.request_context as Record<string, unknown>).schemeType === "cd" && summary.liveOnly === true ? liveSummary : {}),
          },
          scheme_type: schemeType ?? schemeTypeFromRequestContext(run.request_context) ?? (run.scheme_version_id ? schemeByVersion.get(run.scheme_version_id) : null),
        };
      })
      .filter((run) => !schemeType || run.scheme_type === schemeType));

    const payload = { evaluationRuns };
    runsCache.set(cacheKey, { expiresAt: Date.now() + RUNS_CACHE_TTL_MS, data: payload });
    if (runsCache.size > 500) {
      const now = Date.now();
      for (const [k, v] of runsCache) if (v.expiresAt <= now || runsCache.size > 400) runsCache.delete(k);
    }
    return jsonWithCors(request, payload, { headers: { "Cache-Control": fresh ? "no-store" : "private, max-age=5, stale-while-revalidate=10", "X-Cache": "MISS" } });
  } catch (error) {
    if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    console.error("Could not list evaluation runs:", error);
    return jsonWithCors(request, { error: "Could not list evaluation runs." }, { status: 500 });
  }
}
