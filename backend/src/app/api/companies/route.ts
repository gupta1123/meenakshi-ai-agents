import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendMeenakshiAuditEvent } from "@/lib/audit";
import { MeenakshiAccessError, requireMeenakshiOrganizationAccess } from "@/lib/authorization";
import { isUuid, readText } from "@/lib/security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const COMPANY_CODE = /^[A-Z][A-Z0-9_-]{1,79}$/;

function errorResponse(request: Request, error: unknown) {
  if (error instanceof MeenakshiAccessError) return jsonWithCors(request, { error: error.message }, { status: error.status });
  console.error("Could not register Meenakshi Tally company:", error);
  return jsonWithCors(request, { error: "Could not register Tally company." }, { status: 500 });
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }

// An administrator registers an approved Tally company only after a local,
// read-only bridge probe has supplied its exact name and GUID.  We create a
// separate company record rather than changing a prior company's accounting
// identity or connector history.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = readText(body.organizationId, 80);
    const code = readText(body.code, 80)?.toUpperCase();
    const tallyCompanyGuid = readText(body.tallyCompanyGuid, 500);
    const tallyCompanyName = readText(body.tallyCompanyName, 500);
    const timezone = readText(body.timezone, 100) ?? "Asia/Kolkata";
    if (!isUuid(organizationId) || !code || !COMPANY_CODE.test(code) || !tallyCompanyGuid || !tallyCompanyName) {
      return jsonWithCors(request, { error: "organizationId, an uppercase code, tallyCompanyGuid, and tallyCompanyName are required." }, { status: 400 });
    }

    const scope = await requireMeenakshiOrganizationAccess(request, organizationId, ["administrator"]);
    const { data, error } = await createSupabaseAdminClient()
      .from("companies")
      .insert({
        organization_id: organizationId,
        code,
        tally_company_guid: tallyCompanyGuid,
        tally_company_name: tallyCompanyName,
        timezone,
        is_active: true,
      })
      .select("id, organization_id, code, tally_company_guid, tally_company_name, timezone, is_active, created_at")
      .single();
    if (error) {
      if (error.code === "23505") {
        return jsonWithCors(request, { error: "That Tally company GUID or company code is already registered for this organization." }, { status: 409 });
      }
      throw error;
    }

    const company = data as {
      id: string; organization_id: string; code: string; tally_company_guid: string; tally_company_name: string; timezone: string; is_active: boolean; created_at: string;
    };
    await appendMeenakshiAuditEvent({
      organizationId,
      companyId: company.id,
      actorType: "user",
      actorId: scope.userId,
      action: "tally_company_registered",
      entityType: "company",
      entityId: company.id,
      newValue: {
        code: company.code,
        tallyCompanyGuid: company.tally_company_guid,
        tallyCompanyName: company.tally_company_name,
        timezone: company.timezone,
      },
    });
    return jsonWithCors(request, {
      company: {
        id: company.id,
        organizationId: company.organization_id,
        code: company.code,
        tallyCompanyGuid: company.tally_company_guid,
        tallyCompanyName: company.tally_company_name,
        timezone: company.timezone,
        isActive: company.is_active,
        createdAt: company.created_at,
      },
    }, { status: 201 });
  } catch (error) {
    return errorResponse(request, error);
  }
}
