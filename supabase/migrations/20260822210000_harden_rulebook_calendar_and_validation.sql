-- Harden rulebook: block calendar de-activation while active versions exist.
-- NOT APPLIED YET: intentionally left unapplied per developer request.
-- After review: supabase db push

-- Prevent de-activating a working calendar that is still referenced by an active/draft rule version.
create or replace function public.prevent_working_calendar_deactivation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_active = true and new.is_active = false then
    if exists (
      select 1 from public.scheme_versions v
      where v.working_calendar_id = old.id
        and v.status in ('draft','validated','active')
    ) then
      raise exception 'Cannot de-activate calendar "%" while it is still used by an active or draft rule version. Retire or migrate the rule first.', old.name
        using errcode = '45000';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists working_calendars_prevent_deactivation on public.working_calendars;
create trigger working_calendars_prevent_deactivation
  before update of is_active on public.working_calendars
  for each row execute function public.prevent_working_calendar_deactivation();

comment on function public.prevent_working_calendar_deactivation() is 'Blocks is_active=false while any draft/validated/active scheme_version still references the calendar (strand protection).';
