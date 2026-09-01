begin;

with tamil_nadu_holidays(holiday_date, name) as (
  values
    ('2026-01-01'::date, 'New Year''s Day'),
    ('2026-01-15'::date, 'Pongal'),
    ('2026-01-16'::date, 'Thiruvalluvar Day'),
    ('2026-01-17'::date, 'Uzhavar Thirunal'),
    ('2026-01-26'::date, 'Republic Day'),
    ('2026-02-01'::date, 'Thai Poosam'),
    ('2026-03-19'::date, 'Telugu New Year''s Day'),
    ('2026-03-21'::date, 'Ramzan (Idu''l Fitr)'),
    ('2026-03-31'::date, 'Mahaveer Jayanthi'),
    ('2026-04-03'::date, 'Good Friday'),
    ('2026-04-14'::date, 'Tamil New Year''s Day / Dr. B. R. Ambedkar''s Birthday'),
    ('2026-04-23'::date, 'Tamil Nadu Legislative Assembly Election'),
    ('2026-05-01'::date, 'May Day'),
    ('2026-05-28'::date, 'Bakrid (Idul Azha)'),
    ('2026-06-26'::date, 'Muharram'),
    ('2026-08-15'::date, 'Independence Day'),
    ('2026-08-26'::date, 'Milad-un-Nabi'),
    ('2026-09-04'::date, 'Krishna Jayanthi'),
    ('2026-09-14'::date, 'Vinayakar Chathurthi'),
    ('2026-10-02'::date, 'Gandhi Jayanthi'),
    ('2026-10-19'::date, 'Ayutha Pooja'),
    ('2026-10-20'::date, 'Vijaya Dasami'),
    ('2026-11-08'::date, 'Deepavali'),
    ('2026-12-25'::date, 'Christmas')
)
insert into public.working_calendar_holidays (
  working_calendar_id,
  holiday_date,
  name,
  is_active
)
select
  calendar.id,
  holiday.holiday_date,
  holiday.name,
  true
from public.working_calendars calendar
cross join tamil_nadu_holidays holiday
where calendar.is_active
on conflict (working_calendar_id, holiday_date) do update
set name = excluded.name,
    is_active = true,
    updated_at = now();

comment on table public.working_calendar_holidays is
  'Meenakshi business holidays. The 2026 seed follows Tamil Nadu G.O.(Ms.) No.708 dated 11 November 2025 plus the 23 April 2026 Assembly election holiday; bank-only annual closing is excluded.';

commit;
