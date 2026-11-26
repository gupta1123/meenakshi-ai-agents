-- Step A2: remember the financial year (books-from) the connector actually saw,
-- next to the GUID and name it already records on a company binding. Additive
-- and nullable; nothing reads it until the connector reports it.
begin;

alter table public.tally_connector_company_bindings
  add column if not exists observed_tally_books_from date;

comment on column public.tally_connector_company_bindings.observed_tally_books_from is
  'Books-from date of the Tally company the connector last matched or saw for this binding.';

commit;
