import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readBoolean, readOptionalText, readRequiredUuid, requireRulebookCompanyAdmin, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; calendarId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

async function findCalendar(organizationId: string, calendarId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("working_calendars")
    .select("id, organization_id, name, is_active, revision, created_by, created_at, updated_at")
    .eq("id", calendarId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new RulebookRequestError("Working calendar was not found.", 404);
  return data as { id: string; organization_id: string; name: string; is_active: boolean; revision: number; created_by: string | null; created_at: string; updated_at: string };
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { companyId, calendarId } = await context.params;
    readRequiredUuid(calendarId, "calendarId");
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const existing = await findCalendar(scope.organization.id, calendarId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = readOptionalText(body.name, 160);
      if (!name) throw new RulebookRequestError("name cannot be blank.");
      update.name = name;
    }
    if (body.isActive !== undefined) update.is_active = readBoolean(body.isActive, "isActive");
    if (!Object.keys(update).length) return jsonWithCors(request, { error: "Provide name or isActive." }, { status: 400 });
    const { data, error } = await createSupabaseAdminClient()
      .from("working_calendars")
      .update(update)
      .eq("id", existing.id)
      .eq("organization_id", scope.organization.id)
      .select("id, organization_id, name, is_active, revision, created_by, created_at, updated_at")
      .single();
    if (error) throw error;
    await appendRulebookAudit({
      scope,
      action: "working_calendar_updated",
      entityType: "working_calendar",
      entityId: existing.id,
      previousValue: { name: existing.name, isActive: existing.is_active, revision: existing.revision },
      newValue: { name: (data as { name: string }).name, isActive: (data as { is_active: boolean }).is_active, revision: (data as { revision: number }).revision },
    });
    return jsonWithCors(request, { calendar: data });
  } catch (error) {
    return rulebookErrorResponse(request, error, "update working calendar");
  }
}
