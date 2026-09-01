import { requireRequestUser } from "@/lib/api/request-auth";
import { MEENAKSHI_FEATURE, type MeenakshiRole } from "@/lib/constants";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export class MeenakshiAccessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type OrganizationRow = { id: string; code: string; name: string; timezone: string; is_active: boolean };
type MembershipRow = { organization_id: string; profile_id: string; role: MeenakshiRole };
type CompanyRow = { id: string; organization_id: string; code: string; tally_company_guid: string; tally_company_name: string; is_active: boolean };
type CompanyAccessRow = CompanyRow & {
  organization: OrganizationRow & {
    memberships: Array<{ role: MeenakshiRole }>;
    features: Array<{ feature: string; is_enabled: boolean }>;
  };
};

export type MeenakshiAccessScope = {
  userId: string;
  organization: OrganizationRow;
  roles: MeenakshiRole[];
};

const ACCESS_CACHE_TTL_MS = 15_000;
const organizationAccessCache = new Map<string, { expiresAt: number; request: Promise<MeenakshiAccessScope> }>();
const companyAccessCache = new Map<string, { expiresAt: number; request: Promise<MeenakshiAccessScope & { company: CompanyRow }> }>();

function pruneAccessCaches() {
  const now = Date.now();
  for (const cache of [organizationAccessCache, companyAccessCache]) {
    if (cache.size <= 500) continue;
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now || cache.size > 400) cache.delete(key);
    }
  }
}

function assertAllowedRole(scope: MeenakshiAccessScope, allowedRoles?: readonly MeenakshiRole[]) {
  if (allowedRoles && !scope.roles.some((role) => allowedRoles.includes(role))) {
    throw new MeenakshiAccessError("The required organization role is missing", 403);
  }
}

async function loadCompanyAccessScope(userId: string, companyId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select(`
      id, organization_id, code, tally_company_guid, tally_company_name, is_active,
      organization:organizations!inner(
        id, code, name, timezone, is_active,
        memberships:organization_memberships(role),
        features:organization_features(feature, is_enabled)
      )
    `)
    .eq("id", companyId)
    .eq("organization.organization_memberships.profile_id", userId)
    .eq("organization.organization_features.feature", MEENAKSHI_FEATURE)
    .maybeSingle();
  if (error) throw error;

  const row = data as unknown as CompanyAccessRow | null;
  if (!row || !row.is_active) throw new MeenakshiAccessError("Company is unavailable", 404);
  if (!row.organization.is_active) throw new MeenakshiAccessError("Organization is unavailable", 404);
  const roles = [...new Set(row.organization.memberships.map((membership) => membership.role))];
  if (roles.length === 0) throw new MeenakshiAccessError("Organization access is required", 403);
  if (!row.organization.features.some((feature) => feature.is_enabled)) {
    throw new MeenakshiAccessError("Meenakshi discounts are not enabled", 403);
  }

  return {
    userId,
    organization: row.organization,
    roles,
    company: row,
  };
}

async function loadOrganizationAccess(userId: string, organizationId: string): Promise<MeenakshiAccessScope> {
  const cacheKey = `${userId}:${organizationId}`;
  const cached = organizationAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.request;

  const request = (async () => {
    const supabase = createSupabaseAdminClient();
    const [{ data: organization, error: organizationError }, { data: memberships, error: membershipError }, { data: feature, error: featureError }] = await Promise.all([
      supabase.from("organizations").select("id, code, name, timezone, is_active").eq("id", organizationId).maybeSingle(),
      supabase.from("organization_memberships").select("organization_id, profile_id, role").eq("organization_id", organizationId).eq("profile_id", userId),
      supabase.from("organization_features").select("is_enabled").eq("organization_id", organizationId).eq("feature", MEENAKSHI_FEATURE).maybeSingle(),
    ]);
    if (organizationError || membershipError || featureError) {
      throw new Error(organizationError?.message ?? membershipError?.message ?? featureError?.message ?? "Could not check access.");
    }
    const org = organization as OrganizationRow | null;
    if (!org || !org.is_active) throw new MeenakshiAccessError("Organization is unavailable", 404);
    const roles = ((memberships ?? []) as unknown as MembershipRow[]).map((membership) => membership.role);
    if (roles.length === 0) throw new MeenakshiAccessError("Organization access is required", 403);
    if (!feature?.is_enabled) throw new MeenakshiAccessError("Meenakshi discounts are not enabled", 403);
    return { userId, organization: org, roles };
  })();
  organizationAccessCache.set(cacheKey, { expiresAt: Date.now() + ACCESS_CACHE_TTL_MS, request });
  pruneAccessCaches();
  try {
    return await request;
  } catch (error) {
    organizationAccessCache.delete(cacheKey);
    throw error;
  }
}

export async function requireMeenakshiOrganizationAccess(
  request: Request,
  organizationId: string,
  allowedRoles?: readonly MeenakshiRole[]
): Promise<MeenakshiAccessScope> {
  const user = await requireRequestUser(request);
  if (!user) throw new MeenakshiAccessError("Unauthorized", 401);
  const scope = await loadOrganizationAccess(user.id, organizationId);
  assertAllowedRole(scope, allowedRoles);
  return scope;
}

export async function requireMeenakshiCompanyAccess(request: Request, companyId: string, allowedRoles?: readonly MeenakshiRole[]) {
  const user = await requireRequestUser(request);
  if (!user) throw new MeenakshiAccessError("Unauthorized", 401);
  const cacheKey = `${user.id}:${companyId}`;
  const cached = companyAccessCache.get(cacheKey);
  const requestForScope = cached && cached.expiresAt > Date.now() ? cached.request : (async () => {
    return loadCompanyAccessScope(user.id, companyId);
  })();
  if (!cached || cached.expiresAt <= Date.now()) {
    companyAccessCache.set(cacheKey, { expiresAt: Date.now() + ACCESS_CACHE_TTL_MS, request: requestForScope });
    pruneAccessCaches();
  }
  try {
    const scope = await requestForScope;
    assertAllowedRole(scope, allowedRoles);
    return scope;
  } catch (error) {
    companyAccessCache.delete(cacheKey);
    throw error;
  }
}
