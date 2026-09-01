import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { appendRulebookAudit, readInteger, readRequiredText, requireRulebookCompanyAdmin, rulebookErrorResponse } from "@/lib/rulebook/shared";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ companyId: string }> };
type CalendarRow = { id: string; organization_id: string; name: string; is_active: boolean; revision: number; created_by: string | null; created_at: string; updated_at: string };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

function calendarResponse(calendar: CalendarRow, weekdays: number[], holidays: unknown[]) {
  return {
    id: calendar.id,
    organizationId: calendar.organization_id,
    name: calendar.name,
    isActive: calendar.is_active,
    revision: calendar.revision,
    createdBy: calendar.created_by,
    createdAt: calendar.created_at,
    updatedAt: calendar.updated_at,
    nonWorkingWeekdays: weekdays,
    holidays,
  };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const supabase = createSupabaseAdminClient();
    const { data: calendarData, error: calendarError } = await supabase
      .from("working_calendars")
      .select("id, organization_id, name, is_active, revision, created_by, created_at, updated_at")
      .eq("organization_id", scope.organization.id)
      .order("created_at")
      .limit(1);
    if (calendarError) throw calendarError;
    const calendars = (calendarData ?? []) as unknown as CalendarRow[];
    const ids = calendars.map((calendar) => calendar.id);
    if (!ids.length) return jsonWithCors(request, { calendars: [] });
    const [{ data: weekdayData, error: weekdayError }, { data: holidayData, error: holidayError }] = await Promise.all([
      supabase.from("working_calendar_non_working_weekdays").select("working_calendar_id, iso_weekday").in("working_calendar_id", ids).order("iso_weekday"),
      supabase.from("working_calendar_holidays").select("id, working_calendar_id, holiday_date, name, is_active, created_by, created_at, updated_at").in("working_calendar_id", ids).order("holiday_date"),
    ]);
    if (weekdayError || holidayError) throw weekdayError ?? holidayError;
    return jsonWithCors(request, {
      calendars: calendars.map((calendar) => calendarResponse(
        calendar,
        (weekdayData ?? []).filter((weekday) => (weekday as { working_calendar_id: string }).working_calendar_id === calendar.id).map((weekday) => (weekday as { iso_weekday: number }).iso_weekday),
        (holidayData ?? []).filter((holiday) => (holiday as { working_calendar_id: string }).working_calendar_id === calendar.id)
      )),
    });
  } catch (error) {
    return rulebookErrorResponse(request, error, "load working calendars");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const scope = await requireRulebookCompanyAdmin(request, companyId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = readRequiredText(body.name, "name", 160);
    if (!Array.isArray(body.nonWorkingWeekdays) || body.nonWorkingWeekdays.length === 0) {
      return jsonWithCors(request, { error: "nonWorkingWeekdays must contain at least one ISO weekday." }, { status: 400 });
    }
    const weekdays = [...new Set(body.nonWorkingWeekdays.map((value) => readInteger(value, "nonWorkingWeekdays", 1, 7)))].sort((a, b) => a - b);
    const supabase = createSupabaseAdminClient();
    const { data: existing, error: existingError } = await supabase
      .from("working_calendars")
      .select("id")
      .eq("organization_id", scope.organization.id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) return jsonWithCors(request, { error: "The Meenakshi business calendar already exists." }, { status: 409 });
    const { data, error } = await supabase
      .from("working_calendars")
      .insert({ organization_id: scope.organization.id, name, is_active: true, created_by: scope.userId })
      .select("id, organization_id, name, is_active, revision, created_by, created_at, updated_at")
      .single();
    if (error) {
      if (error.code === "23505") return jsonWithCors(request, { error: "The Meenakshi business calendar already exists." }, { status: 409 });
      throw error;
    }
    const calendar = data as unknown as CalendarRow;
    const { error: weekdayError } = await supabase
      .from("working_calendar_non_working_weekdays")
      .insert(weekdays.map((iso_weekday) => ({ working_calendar_id: calendar.id, iso_weekday })));
    if (weekdayError) throw weekdayError;
    await appendRulebookAudit({ scope, action: "working_calendar_created", entityType: "working_calendar", entityId: calendar.id, newValue: { name, nonWorkingWeekdays: weekdays } });
    const { data: refreshed, error: refreshError } = await supabase
      .from("working_calendars")
      .select("id, organization_id, name, is_active, revision, created_by, created_at, updated_at")
      .eq("id", calendar.id)
      .single();
    if (refreshError) throw refreshError;
    return jsonWithCors(request, { calendar: calendarResponse(refreshed as unknown as CalendarRow, weekdays, []) }, { status: 201 });
  } catch (error) {
    return rulebookErrorResponse(request, error, "create working calendar");
  }
}
