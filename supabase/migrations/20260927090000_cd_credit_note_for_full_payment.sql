-- Per-MT Cash Discount: a bill paid in full on time also earns the discount.
-- The customer did not deduct it, so a Credit Note for the discount is created
-- manually and leaves a credit on the ledger. Allow full_payment candidates.
alter table public.cash_discount_recovery_candidates
  drop constraint if exists cash_discount_recovery_candidates_kind_check;
alter table public.cash_discount_recovery_candidates
  add constraint cash_discount_recovery_candidates_kind_check check (
    (candidate_kind = 'recovery' and settlement_category is null)
    or (candidate_kind = 'settlement' and settlement_category in ('full_payment', 'discounted_payment', 'over_ninety_percent')
        and discount_amount is not null and discount_amount > 0)
  );
