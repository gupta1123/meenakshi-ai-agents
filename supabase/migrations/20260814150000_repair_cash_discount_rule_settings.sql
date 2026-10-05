-- Repair Cash Discount rule settings when later CD migrations were applied
-- without the rule-setting columns introduced by the prepared schema update.
-- Apply this migration manually.

alter table public.scheme_versions
  add column if not exists cd_invoice_treatment text default 'deducted_upfront',
  add column if not exists cd_narration_mode text default 'informational';

alter table public.scheme_versions
  alter column cd_invoice_treatment set default 'deducted_upfront',
  alter column cd_narration_mode set default 'informational';

alter table public.scheme_versions
  drop constraint if exists scheme_versions_cd_invoice_treatment_check,
  drop constraint if exists scheme_versions_cd_narration_mode_check;

alter table public.scheme_versions
  add constraint scheme_versions_cd_invoice_treatment_check check (
    cd_invoice_treatment is null
    or cd_invoice_treatment in ('after_qualification', 'deducted_upfront')
  ),
  add constraint scheme_versions_cd_narration_mode_check check (
    cd_narration_mode is null
    or cd_narration_mode in ('informational', 'required', 'disabled')
  );

-- These are newly introduced schema fields, not business edits to an active
-- rule. Suspend only the immutability guard for this one-time backfill.
alter table public.scheme_versions
  disable trigger scheme_versions_immutable;

update public.scheme_versions
set
  cd_invoice_treatment = coalesce(cd_invoice_treatment, 'deducted_upfront'),
  cd_narration_mode = coalesce(
    cd_narration_mode,
    case
      when coalesce(cd_check_narration, true) then 'informational'
      else 'disabled'
    end
  )
where scheme_type = 'cd'
  and (
    cd_invoice_treatment is null
    or cd_narration_mode is null
  );

alter table public.scheme_versions
  enable trigger scheme_versions_immutable;

comment on column public.scheme_versions.cd_invoice_treatment is
  'How Cash Discount is handled on the invoice: granted after qualification or already deducted upfront.';

comment on column public.scheme_versions.cd_narration_mode is
  'How invoice narration affects Cash Discount: informational, required, or disabled.';

notify pgrst, 'reload schema';
