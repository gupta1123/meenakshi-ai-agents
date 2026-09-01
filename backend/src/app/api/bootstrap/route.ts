import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { MEENAKSHI_FEATURE, type MeenakshiRole } from "@/lib/constants";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function OPTIONS(request: Request) { return optionsWithCors(request); }

export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const supabase = createSupabaseAdminClient();
    const { data: memberships, error: membershipError } = await supabase.from("organization_memberships").select("organization_id, role").eq("profile_id", user.id);
    if (membershipError) throw membershipError;
    const membershipRows = (memberships ?? []) as Array<{ organization_id: string; role: MeenakshiRole }>;
    const organizationIds = [...new Set(membershipRows.map((membership) => membership.organization_id))];
    if (!organizationIds.length) return jsonWithCors(request, { organizations: [] });

    const [{ data: organizations, error: organizationError }, { data: features, error: featureError }, { data: companies, error: companyError }] = await Promise.all([
      supabase.from("organizations").select("id, code, name, timezone").in("id", organizationIds).eq("is_active", true),
      supabase.from("organization_features").select("organization_id").in("organization_id", organizationIds).eq("feature", MEENAKSHI_FEATURE).eq("is_enabled", true),
      supabase.from("companies").select("id, organization_id, code, tally_company_guid, tally_company_name, timezone").in("organization_id", organizationIds).eq("is_active", true).order("code"),
    ]);
    if (organizationError || featureError || companyError) throw organizationError ?? featureError ?? companyError;

    const enabled = new Set(((features ?? []) as Array<{ organization_id: string }>).map((row) => row.organization_id));
    const rolesByOrganization = new Map<string, MeenakshiRole[]>();
    membershipRows.forEach((membership) => rolesByOrganization.set(membership.organization_id, [...(rolesByOrganization.get(membership.organization_id) ?? []), membership.role]));
    const companiesByOrganization = new Map<string, unknown[]>();
    (companies ?? []).forEach((company) => {
      const organizationId = (company as { organization_id: string }).organization_id;
      companiesByOrganization.set(organizationId, [...(companiesByOrganization.get(organizationId) ?? []), company]);
    });
    return jsonWithCors(request, {
      organizations: (organizations ?? []).filter((organization) => enabled.has((organization as { id: string }).id)).map((organization) => {
        const id = (organization as { id: string }).id;
        return { ...organization, roles: rolesByOrganization.get(id) ?? [], companies: companiesByOrganization.get(id) ?? [] };
      }),
    });
  } catch (error) {
    console.error("Error in GET /api/bootstrap:", error);
    return jsonWithCors(request, { error: "Could not load Meenakshi access." }, { status: 500 });
  }
}
