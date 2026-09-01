import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readBoolean, readDate, readOptionalText, readRequiredText, readRequiredUuid, requireRulebookCompanyAdmin, RulebookRequestError, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string; calendarId: string }> };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

async function requireCalendar(organizationId: string, calendarId: string) {
  readRequiredUuid(calendarId, "calendarId");
  const { data, error } = await createSupabaseAdminClient().from("working_calendars").select("id, organization_id, name, revision").eq("id", calendarId).eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Working calendar was not found.");
  return data as { id: string; organization_id: string; name: string; revision: number };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId, calendarId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    await requireCalendar(scope.organization.id, calendarId);
    const { data, error } = await createSupabaseAdminClient().from("working_calendar_holidays").select("id, holiday_date, name, is_active, created_by, created_at, updated_at").eq("working_calendar_id", calendarId).order("holiday_date");
    if (error) throw error;
    return jsonWithCors(request, { holidays: data ?? [] });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load calendar holidays");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId, calendarId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    await requireCalendar(scope.organization.id, calendarId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const holidayDate = readDate(body.holidayDate, "holidayDate");
    const name = readRequiredText(body.name, "name", 160);
    const isActive = body.isActive === undefined ? true : readBoolean(body.isActive, "isActive");
    const { data, error } = await createSupabaseAdminClient().from("working_calendar_holidays")
      .insert({ working_calendar_id: calendarId, holiday_date: holidayDate, name, is_active: isActive, created_by: scope.userId })
      .select("id, holiday_date, name, is_active, created_by, created_at, updated_at")
      .single();
    if (error) {
      if (error.code === "23505") return jsonWithCors(request, { error: "A holiday already exists on that date for this calendar." }, { status: 409 });
      throw error;
    }
    await appendRulebookAudit({ scope, action: "working_calendar_holiday_created", entityType: "working_calendar_holiday", entityId: (data as { id: string }).id, newValue: { calendarId, holidayDate, name, isActive } });
    return jsonWithCors(request, { holiday: data }, { status: 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "create calendar holiday");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { companyId, calendarId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    await requireCalendar(scope.organization.id, calendarId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const holidayId = readRequiredUuid(body.holidayId, "holidayId");
    const update: Record<string, unknown> = {};
    if (body.holidayDate !== undefined) update.holiday_date = readDate(body.holidayDate, "holidayDate");
    if (body.name !== undefined) {
      const name = readOptionalText(body.name, 160);
      if (!name) throw new RulebookRequestError("name cannot be blank.");
      update.name = name;
    }
    if (body.isActive !== undefined) update.is_active = readBoolean(body.isActive, "isActive");
    if (!Object.keys(update).length) return jsonWithCors(request, { error: "Provide holidayDate, name, or isActive." }, { status: 400 });
    const { data, error } = await createSupabaseAdminClient().from("working_calendar_holidays").update(update).eq("id", holidayId).eq("working_calendar_id", calendarId).select("id, holiday_date, name, is_active, created_by, created_at, updated_at").single();
    if (error) {
      if (error.code === "23505") return jsonWithCors(request, { error: "A holiday already exists on that date for this calendar." }, { status: 409 });
      throw error;
    }
    await appendRulebookAudit({ scope, action: "working_calendar_holiday_updated", entityType: "working_calendar_holiday", entityId: holidayId, newValue: { calendarId, ...update } });
    return jsonWithCors(request, { holiday: data });
  } catch (error) {
    return rulebookErrorResponse(request, error, "update calendar holiday");
  }
}
