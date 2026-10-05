-- Follow-up for Cash Discount rule settings referenced by the application.
-- Apply manually after 20260812000000_cd_narration_and_recovery_policy.sql.

alter table public.scheme_versions
  add column if not exists cd_invoice_treatment text,
  add column if not exists cd_narration_mode text;

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

update public.scheme_versions
set
  cd_invoice_treatment = coalesce(cd_invoice_treatment, 'after_qualification'),
  cd_narration_mode = coalesce(
    cd_narration_mode,
    case when cd_check_narration = false then 'disabled' else 'informational' end
  ),
  updated_at = now()
where scheme_type = 'cd'
  and (cd_invoice_treatment is null or cd_narration_mode is null);

comment on column public.scheme_versions.cd_invoice_treatment is
  'How Cash Discount is handled on the invoice: granted after qualification or already deducted upfront.';

comment on column public.scheme_versions.cd_narration_mode is
  'How invoice narration affects Cash Discount: advisory, required, or ignored.';
