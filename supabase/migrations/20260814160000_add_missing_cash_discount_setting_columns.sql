-- Add the Cash Discount setting columns without updating immutable rule rows.
-- PostgreSQL applies these defaults to existing rows as part of ADD COLUMN,
-- so no rule-version mutation trigger is invoked.
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

comment on column public.scheme_versions.cd_invoice_treatment is
  'How Cash Discount is handled on the invoice: granted after qualification or already deducted upfront.';

comment on column public.scheme_versions.cd_narration_mode is
  'How invoice narration affects Cash Discount: informational, required, or disabled.';

notify pgrst, 'reload schema';
