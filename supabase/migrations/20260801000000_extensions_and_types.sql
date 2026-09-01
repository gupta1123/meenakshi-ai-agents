-- Meenakshi v1 foundation: tenancy, roles, shared types, and safe helpers.
-- This is an initial migration and is intentionally designed for a clean database.

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

create type public.feature_key as enum ('meenakshi_discounts');
create type public.organization_role as enum ('administrator', 'finance_approver');
create type public.scheme_type as enum ('cd', 'tod');
create type public.scheme_status as enum ('draft', 'active', 'paused', 'expired', 'retired');
create type public.scheme_version_status as enum ('draft', 'validated', 'active', 'retired');
create type public.rounding_method as enum ('half_up', 'half_even', 'truncate');
create type public.gst_treatment as enum ('commercial_no_gst');
create type public.tally_voucher_kind as enum ('sales', 'receipt', 'sales_return', 'debit_note', 'credit_note', 'other');
create type public.tally_voucher_status as enum ('posted', 'cancelled', 'optional', 'reversed');
create type public.bill_allocation_type as enum ('agst_ref', 'new_ref', 'on_account', 'advance', 'other');
create type public.sync_kind as enum ('masters', 'vouchers', 'references', 'targeted_refresh', 'reconciliation');
create type public.sync_status as enum ('queued', 'running', 'completed', 'completed_with_errors', 'failed');
create type public.evaluation_run_status as enum ('queued', 'refreshing_tally', 'evaluating', 'completed', 'completed_with_issues', 'failed', 'cancelled');
create type public.proposal_status as enum (
  'tracking', 'near_eligibility', 'partially_paid', 'unpaid', 'eligible',
  'needs_review', 'deadline_expired', 'not_in_scheme', 'pending_approval',
  'review_invalidated', 'sending_to_tally', 'created_verified',
  'whatsapp_pending', 'whatsapp_sent', 'failed', 'already_credited'
);
create type public.review_status as enum ('pending', 'approved', 'rejected', 'invalidated');
create type public.issue_status as enum ('open', 'in_progress', 'resolved', 'dismissed');
create type public.credit_note_posting_status as enum (
  'pending_approval', 'queued', 'sending', 'verification_pending',
  'created_verified', 'correction_required', 'failed', 'cancel_requested', 'cancelled'
);
create type public.command_status as enum ('queued', 'sending', 'accepted', 'verified', 'failed', 'dead_letter');
create type public.notification_status as enum ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'suppressed', 'cancelled');
create type public.outbox_status as enum ('pending', 'processing', 'completed', 'failed', 'dead_letter');
create type public.audit_actor_type as enum ('user', 'system', 'tally_connector', 'msg91');

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  timezone text not null default 'Asia/Kolkata',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_features (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  feature public.feature_key not null,
  is_enabled boolean not null default false,
  enabled_at timestamptz,
  enabled_by uuid,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, feature)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  phone_e164 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role public.organization_role not null,
  granted_at timestamptz not null default now(),
  granted_by uuid,
  primary key (organization_id, profile_id, role)
);

create index organization_memberships_profile_idx
  on public.organization_memberships (profile_id, organization_id);

create trigger organizations_set_updated_at before update on public.organizations
  for each row execute function public.set_updated_at();
create trigger organization_features_set_updated_at before update on public.organization_features
  for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

comment on table public.organization_features is
  'Feature gates. Meenakshi discounts remain isolated from every other organization.';
