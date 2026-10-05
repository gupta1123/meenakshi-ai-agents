-- One-time: fill the single company holiday calendar for 2025, 2027, 2028 and 2029
-- (2026 is already there). Tamil Nadu public holidays, same list as 2026.
--
-- Fixed-date holidays are exact. Festivals that follow the lunar calendar
-- (Thai Poosam, Telugu New Year, Ramzan, Mahaveer Jayanthi, Bakrid, Muharram,
-- Milad-un-Nabi, Krishna Jayanthi, Vinayakar Chathurthi, Ayutha Pooja,
-- Vijaya Dasami, Deepavali) are the expected dates for 2027-2029; check them
-- against the Tamil Nadu Government holiday list when it is published each
-- December and correct any date on the Holidays page.
--
-- Safe to run more than once: a date already in the calendar is left as is.

insert into public.working_calendar_holidays (working_calendar_id, holiday_date, name)
select '5f3a41c5-8f64-4cf4-97e1-c81439da0c28'::uuid, holiday.day::date, holiday.name
from (values
  -- 2025 (Tamil Nadu Government list)
  ('2025-01-01', 'New Year''s Day'),
  ('2025-01-14', 'Pongal'),
  ('2025-01-15', 'Thiruvalluvar Day'),
  ('2025-01-16', 'Uzhavar Thirunal'),
  ('2025-01-26', 'Republic Day'),
  ('2025-02-11', 'Thai Poosam'),
  ('2025-03-30', 'Telugu New Year''s Day'),
  ('2025-03-31', 'Ramzan (Idu''l Fitr)'),
  ('2025-04-10', 'Mahaveer Jayanthi'),
  ('2025-04-14', 'Tamil New Year''s Day / Dr. B. R. Ambedkar''s Birthday'),
  ('2025-04-18', 'Good Friday'),
  ('2025-05-01', 'May Day'),
  ('2025-06-07', 'Bakrid (Idul Azha)'),
  ('2025-07-06', 'Muharram'),
  ('2025-08-15', 'Independence Day'),
  ('2025-08-16', 'Krishna Jayanthi'),
  ('2025-08-27', 'Vinayakar Chathurthi'),
  ('2025-09-05', 'Milad-un-Nabi'),
  ('2025-10-01', 'Ayutha Pooja'),
  ('2025-10-02', 'Gandhi Jayanthi / Vijaya Dasami'),
  ('2025-10-20', 'Deepavali'),
  ('2025-12-25', 'Christmas'),

  -- 2027 (lunar festival dates expected; verify)
  ('2027-01-01', 'New Year''s Day'),
  ('2027-01-15', 'Pongal'),
  ('2027-01-16', 'Thiruvalluvar Day'),
  ('2027-01-17', 'Uzhavar Thirunal'),
  ('2027-01-22', 'Thai Poosam'),
  ('2027-01-26', 'Republic Day'),
  ('2027-03-10', 'Ramzan (Idu''l Fitr)'),
  ('2027-03-26', 'Good Friday'),
  ('2027-04-07', 'Telugu New Year''s Day'),
  ('2027-04-14', 'Tamil New Year''s Day / Dr. B. R. Ambedkar''s Birthday'),
  ('2027-04-18', 'Mahaveer Jayanthi'),
  ('2027-05-01', 'May Day'),
  ('2027-05-17', 'Bakrid (Idul Azha)'),
  ('2027-06-16', 'Muharram'),
  ('2027-08-15', 'Independence Day / Milad-un-Nabi'),
  ('2027-08-25', 'Krishna Jayanthi'),
  ('2027-09-04', 'Vinayakar Chathurthi'),
  ('2027-10-02', 'Gandhi Jayanthi'),
  ('2027-10-08', 'Ayutha Pooja'),
  ('2027-10-09', 'Vijaya Dasami'),
  ('2027-10-29', 'Deepavali'),
  ('2027-12-25', 'Christmas'),

  -- 2028 (lunar festival dates expected; verify)
  ('2028-01-01', 'New Year''s Day'),
  ('2028-01-15', 'Pongal'),
  ('2028-01-16', 'Thiruvalluvar Day'),
  ('2028-01-17', 'Uzhavar Thirunal'),
  ('2028-01-26', 'Republic Day'),
  ('2028-02-10', 'Thai Poosam'),
  ('2028-02-27', 'Ramzan (Idu''l Fitr)'),
  ('2028-03-27', 'Telugu New Year''s Day'),
  ('2028-04-07', 'Mahaveer Jayanthi'),
  ('2028-04-14', 'Tamil New Year''s Day / Dr. B. R. Ambedkar''s Birthday / Good Friday'),
  ('2028-05-01', 'May Day'),
  ('2028-05-05', 'Bakrid (Idul Azha)'),
  ('2028-06-04', 'Muharram'),
  ('2028-08-03', 'Milad-un-Nabi'),
  ('2028-08-13', 'Krishna Jayanthi'),
  ('2028-08-15', 'Independence Day'),
  ('2028-08-23', 'Vinayakar Chathurthi'),
  ('2028-09-26', 'Ayutha Pooja'),
  ('2028-09-27', 'Vijaya Dasami'),
  ('2028-10-02', 'Gandhi Jayanthi'),
  ('2028-10-17', 'Deepavali'),
  ('2028-12-25', 'Christmas'),

  -- 2029 (lunar festival dates expected; verify)
  ('2029-01-01', 'New Year''s Day'),
  ('2029-01-14', 'Pongal'),
  ('2029-01-15', 'Thiruvalluvar Day'),
  ('2029-01-16', 'Uzhavar Thirunal'),
  ('2029-01-26', 'Republic Day'),
  ('2029-01-30', 'Thai Poosam'),
  ('2029-02-14', 'Ramzan (Idu''l Fitr)'),
  ('2029-03-16', 'Telugu New Year''s Day'),
  ('2029-03-30', 'Good Friday'),
  ('2029-04-14', 'Tamil New Year''s Day / Dr. B. R. Ambedkar''s Birthday'),
  ('2029-04-24', 'Bakrid (Idul Azha)'),
  ('2029-04-25', 'Mahaveer Jayanthi'),
  ('2029-05-01', 'May Day'),
  ('2029-05-24', 'Muharram'),
  ('2029-07-24', 'Milad-un-Nabi'),
  ('2029-08-15', 'Independence Day'),
  ('2029-09-01', 'Krishna Jayanthi'),
  ('2029-09-12', 'Vinayakar Chathurthi'),
  ('2029-10-02', 'Gandhi Jayanthi'),
  ('2029-10-16', 'Ayutha Pooja'),
  ('2029-10-17', 'Vijaya Dasami'),
  ('2029-11-05', 'Deepavali'),
  ('2029-12-25', 'Christmas')
) as holiday(day, name)
on conflict (working_calendar_id, holiday_date) do nothing;

-- A neutral name: this one calendar covers every year.
update public.working_calendars
set name = 'Company holidays'
where id = '5f3a41c5-8f64-4cf4-97e1-c81439da0c28' and name = 'FY26 local CD calendar';

-- Check: holidays per year.
select extract(year from holiday_date)::int as year, count(*) as holidays
from public.working_calendar_holidays
where working_calendar_id = '5f3a41c5-8f64-4cf4-97e1-c81439da0c28' and is_active
group by 1 order by 1;
