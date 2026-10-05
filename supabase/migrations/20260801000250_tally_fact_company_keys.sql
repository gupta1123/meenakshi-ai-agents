-- Required scoped keys for the Phase 1 evaluation evidence foreign keys.
--
-- `id` is already globally unique on both tables. These composite unique keys
-- make the company boundary explicit and allow downstream foreign keys to
-- prove that a referenced fact belongs to the same company.
--
-- Run after 20260801000200 and before 20260801000300.

alter table public.tally_voucher_inventory_lines
  add constraint tally_voucher_inventory_lines_id_company_key
  unique (id, company_id);

alter table public.tally_bill_allocations
  add constraint tally_bill_allocations_id_company_key
  unique (id, company_id);
