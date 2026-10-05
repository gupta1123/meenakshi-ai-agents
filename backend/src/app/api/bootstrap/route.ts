import { createHash } from "node:crypto";

import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { MEENAKSHI_FEATURE, type MeenakshiRole } from "@/lib/constants";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

// 10s in-memory cache — bootstrap is hit on every navigation/auth-gate poll.
const BOOTSTRAP_CACHE_TTL_MS = 10_000;
const bootstrapCache = new Map<string, { expiresAt: number; data: unknown }>();
// Token-level cache + in-flight dedup — saves the 250ms auth.getUser hop on HIT
const tokenBootstrapCache = new Map<string, { expiresAt: number; data: unknown }>();
const bootstrapInflight = new Map<string, Promise<unknown>>();

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request) {
  try {
    const rawToken = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const tokenKey = rawToken ? createHash("sha256").update(rawToken).digest("base64url") : null;

    if (tokenKey) {
      const tokCached = tokenBootstrapCache.get(tokenKey);
      if (tokCached && tokCached.expiresAt > Date.now()) {
        return jsonWithCors(request, tokCached.data, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "HIT" } });
      }
      const infl = bootstrapInflight.get(tokenKey);
      if (infl) {
        const data = await infl;
        return jsonWithCors(request, data, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "HIT-DEDUPE" } });
      }
    }

    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const cached = bootstrapCache.get(user.id);
    if (cached && cached.expiresAt > Date.now()) {
      if (tokenKey) tokenBootstrapCache.set(tokenKey, { expiresAt: Date.now() + BOOTSTRAP_CACHE_TTL_MS, data: cached.data });
      return jsonWithCors(request, cached.data, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "HIT" } });
    }

    // Coalesce concurrent MISS
    let work: Promise<unknown> | null = null;
    if (tokenKey) {
      work = bootstrapInflight.get(tokenKey) ?? null;
      if (!work) {
        work = (async () => {
          const supabase = createSupabaseAdminClient();
          const { data: memberships, error: membershipError } = await supabase.from("organization_memberships").select("organization_id, role").eq("profile_id", user.id);
          if (membershipError) throw membershipError;
          const membershipRows = (memberships ?? []) as Array<{ organization_id: string; role: MeenakshiRole }>;
          const organizationIds = [...new Set(membershipRows.map((m) => m.organization_id))];
          if (!organizationIds.length) return { organizations: [] };
          const [{ data: organizations, error: organizationError }, { data: features, error: featureError }, { data: companies, error: companyError }] = await Promise.all([
            supabase.from("organizations").select("id, code, name, timezone").in("id", organizationIds).eq("is_active", true),
            supabase.from("organization_features").select("organization_id").in("organization_id", organizationIds).eq("feature", MEENAKSHI_FEATURE).eq("is_enabled", true),
            supabase.from("companies").select("id, organization_id, code, tally_company_guid, tally_company_name, timezone").in("organization_id", organizationIds).eq("is_active", true).order("code"),
          ]);
          if (organizationError || featureError || companyError) throw organizationError ?? featureError ?? companyError;
          const enabled = new Set(((features ?? []) as Array<{ organization_id: string }>).map((r) => r.organization_id));
          const rolesByOrganization = new Map<string, MeenakshiRole[]>();
          for (const m of membershipRows) { const a = rolesByOrganization.get(m.organization_id); if (a) a.push(m.role); else rolesByOrganization.set(m.organization_id, [m.role]); }
          const companiesByOrganization = new Map<string, unknown[]>();
          for (const c of (companies ?? []) as Array<{ organization_id: string }>) { const a = companiesByOrganization.get(c.organization_id); if (a) a.push(c); else companiesByOrganization.set(c.organization_id, [c as unknown]); }
          const payload = { organizations: (organizations ?? []).filter((o) => enabled.has((o as { id: string }).id)).map((o) => { const id = (o as { id: string }).id; return { ...o, roles: rolesByOrganization.get(id) ?? [], companies: companiesByOrganization.get(id) ?? [] }; }) };
          bootstrapCache.set(user.id, { expiresAt: Date.now() + BOOTSTRAP_CACHE_TTL_MS, data: payload });
          if (tokenKey) {
            tokenBootstrapCache.set(tokenKey, { expiresAt: Date.now() + BOOTSTRAP_CACHE_TTL_MS, data: payload });
            if (tokenBootstrapCache.size > 500) { const now = Date.now(); for (const [k, v] of tokenBootstrapCache) if (v.expiresAt <= now || tokenBootstrapCache.size > 400) tokenBootstrapCache.delete(k); }
          }
          if (bootstrapCache.size > 500) { const now = Date.now(); for (const [k, v] of bootstrapCache) if (v.expiresAt <= now || bootstrapCache.size > 400) bootstrapCache.delete(k); }
          return payload;
        })();
        bootstrapInflight.set(tokenKey, work);
      }
      try {
        const payload = await work;
        return jsonWithCors(request, payload, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "MISS" } });
      } finally {
        bootstrapInflight.delete(tokenKey);
      }
    }

    // Fallback for cookie auth (no tokenKey)
    const supabase = createSupabaseAdminClient();
    const { data: memberships, error: membershipError } = await supabase.from("organization_memberships").select("organization_id, role").eq("profile_id", user.id);
    if (membershipError) throw membershipError;
    const membershipRows = (memberships ?? []) as Array<{ organization_id: string; role: MeenakshiRole }>;
    const organizationIds = [...new Set(membershipRows.map((m) => m.organization_id))];
    if (!organizationIds.length) return jsonWithCors(request, { organizations: [] });
    const [{ data: organizations, error: organizationError }, { data: features, error: featureError }, { data: companies, error: companyError }] = await Promise.all([
      supabase.from("organizations").select("id, code, name, timezone").in("id", organizationIds).eq("is_active", true),
      supabase.from("organization_features").select("organization_id").in("organization_id", organizationIds).eq("feature", MEENAKSHI_FEATURE).eq("is_enabled", true),
      supabase.from("companies").select("id, organization_id, code, tally_company_guid, tally_company_name, timezone").in("organization_id", organizationIds).eq("is_active", true).order("code"),
    ]);
    if (organizationError || featureError || companyError) throw organizationError ?? featureError ?? companyError;
    const enabled = new Set(((features ?? []) as Array<{ organization_id: string }>).map((r) => r.organization_id));
    const rolesByOrganization = new Map<string, MeenakshiRole[]>();
    for (const m of membershipRows) { const a = rolesByOrganization.get(m.organization_id); if (a) a.push(m.role); else rolesByOrganization.set(m.organization_id, [m.role]); }
    const companiesByOrganization = new Map<string, unknown[]>();
    for (const c of (companies ?? []) as Array<{ organization_id: string }>) { const a = companiesByOrganization.get(c.organization_id); if (a) a.push(c); else companiesByOrganization.set(c.organization_id, [c as unknown]); }
    const payload = { organizations: (organizations ?? []).filter((o) => enabled.has((o as { id: string }).id)).map((o) => { const id = (o as { id: string }).id; return { ...o, roles: rolesByOrganization.get(id) ?? [], companies: companiesByOrganization.get(id) ?? [] }; }) };
    bootstrapCache.set(user.id, { expiresAt: Date.now() + BOOTSTRAP_CACHE_TTL_MS, data: payload });
    return jsonWithCors(request, payload, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=20", "X-Cache": "MISS" } });
  } catch (error) {
    console.error("Error in GET /api/bootstrap:", error);
    return jsonWithCors(request, { error: "Could not load Meenakshi access." }, { status: 500 });
  }
}
