-- Run after applying the complete Phase 1–4 migration chain, in timestamp order, for example:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/meenakshi_schema_smoke.sql
-- The test rolls back every fixture row.

begin;

do $$
declare
  v_org uuid := gen_random_uuid();
  v_company uuid := gen_random_uuid();
  v_parent_group uuid := gen_random_uuid();
  v_child_group uuid := gen_random_uuid();
  v_customer uuid := gen_random_uuid();
  v_calendar uuid := gen_random_uuid();
  v_unit uuid := gen_random_uuid();
  v_stock_group uuid := gen_random_uuid();
  v_stock_item uuid := gen_random_uuid();
  v_discount_ledger uuid := gen_random_uuid();
  v_credit_note_type uuid := gen_random_uuid();
  v_cd_scheme uuid := gen_random_uuid();
  v_cd_version uuid := gen_random_uuid();
  v_overlapping_cd_scheme uuid := gen_random_uuid();
  v_overlapping_cd_version uuid := gen_random_uuid();
  v_tod_scheme uuid := gen_random_uuid();
  v_tod_version uuid := gen_random_uuid();
  v_evaluation_run uuid;
  v_repeat_evaluation_run uuid;
  v_tod_period_lock uuid;
  v_sales_voucher uuid := gen_random_uuid();
  v_credit_note_voucher uuid := gen_random_uuid();
  v_cd_proposal uuid := gen_random_uuid();
  v_cd_evaluation uuid := gen_random_uuid();
  v_tod_proposal uuid := gen_random_uuid();
  v_posting uuid := gen_random_uuid();
  v_contact uuid := gen_random_uuid();
  v_template uuid := gen_random_uuid();
  v_connector uuid := gen_random_uuid();
  v_outbox uuid := gen_random_uuid();
  v_command uuid := gen_random_uuid();
  v_deadline date;
  v_claimed_count integer;
begin
  insert into public.organizations (id, code, name)
  values (v_org, 'MEENAKSHI-TEST', 'Meenakshi test');

  insert into public.companies (id, organization_id, tally_company_guid, tally_company_name, code)
  values (v_company, v_org, 'company-guid', 'Meenakshi Tally', 'MEENAKSHI');

  insert into public.company_credit_note_tax_policies (
    company_id, gst_treatment, effective_from, approval_reference,
    approver_name_snapshot, approved_at
  ) values (
    v_company, 'commercial_no_gst', date '2026-08-01', 'FIN-TEST-1',
    'Finance test approver', now()
  );

  insert into public.customer_groups (id, company_id, tally_group_guid, name)
  values
    (v_parent_group, v_company, 'group-parent', 'Eligible parent'),
    (v_child_group, v_company, 'group-child', 'Eligible child');
  update public.customer_groups
  set parent_group_id = v_parent_group
  where id = v_child_group;

  insert into public.customers (id, company_id, tally_ledger_guid, ledger_name, current_customer_group_id)
  values (v_customer, v_company, 'customer-guid', 'Customer ledger', v_child_group);

  insert into public.tally_units (id, company_id, code, name)
  values (v_unit, v_company, 'KG', 'Kilogram');
  insert into public.stock_groups (id, company_id, tally_group_guid, name)
  values (v_stock_group, v_company, 'steel-guid', 'Steel');
  insert into public.stock_items (id, company_id, tally_stock_item_guid, name, current_stock_group_id, default_uom_id)
  values (v_stock_item, v_company, 'item-guid', 'Steel coil', v_stock_group, v_unit);

  insert into public.tally_ledgers (id, company_id, tally_ledger_guid, name, gst_applicability)
  values (v_discount_ledger, v_company, 'discount-ledger-guid', 'Cash Discount Allowed', 'Not Applicable');
  insert into public.tally_voucher_types (id, company_id, tally_voucher_type_guid, name, is_credit_note_type)
  values (v_credit_note_type, v_company, 'credit-note-type-guid', 'Credit Note', true);

  insert into public.working_calendars (id, company_id, name)
  values (v_calendar, v_company, 'Meenakshi working calendar');
  insert into public.working_calendar_non_working_weekdays (working_calendar_id, iso_weekday)
  values (v_calendar, 7);
  insert into public.working_calendar_holidays (working_calendar_id, holiday_date, name)
  values (v_calendar, date '2026-08-10', 'Test holiday');

  select public.working_day_deadline(v_calendar, date '2026-08-07', 4) into v_deadline;
  if v_deadline <> date '2026-08-13' then
    raise exception 'Expected four-working-day deadline on 2026-08-13, got %', v_deadline;
  end if;

  insert into public.schemes (id, company_id, scheme_type, code, name, status)
  values (v_cd_scheme, v_company, 'cd', 'CD-1', 'CD rule', 'active');
  insert into public.scheme_versions (
    id, company_id, scheme_id, scheme_type, version_number, effective_from,
    discount_percentage, calculation_base, rounding_method, rounding_scale,
    credit_note_voucher_type_id, discount_ledger_id, working_calendar_id,
    allowed_working_days, near_eligibility_percent
  ) values (
    v_cd_version, v_company, v_cd_scheme, 'cd', 1, date '2026-08-01',
    1, 'eligible_product_taxable_value', 'half_up', 2,
    v_credit_note_type, v_discount_ledger, v_calendar, 4, 80
  );
  insert into public.scheme_version_customer_groups (scheme_version_id, company_id, customer_group_id)
  values (v_cd_version, v_company, v_parent_group);
  update public.scheme_versions set status = 'active' where id = v_cd_version;

  if not exists (
    select 1 from public.scheme_version_group_coverage
    where scheme_version_id = v_cd_version and customer_group_id = v_child_group
  ) then
    raise exception 'Nested Tally customer group was not included in rule coverage';
  end if;

  begin
    update public.scheme_versions set rounding_scale = 0 where id = v_cd_version;
    raise exception 'Expected active rule version immutability failure';
  exception when others then
    if position('immutable' in sqlerrm) = 0 then raise; end if;
  end;

  insert into public.schemes (id, company_id, scheme_type, code, name, status)
  values (v_overlapping_cd_scheme, v_company, 'cd', 'CD-2', 'Overlapping CD rule', 'active');
  insert into public.scheme_versions (
    id, company_id, scheme_id, scheme_type, version_number, effective_from,
    discount_percentage, calculation_base, rounding_method, rounding_scale,
    credit_note_voucher_type_id, discount_ledger_id, working_calendar_id,
    allowed_working_days, near_eligibility_percent
  ) values (
    v_overlapping_cd_version, v_company, v_overlapping_cd_scheme, 'cd', 1, date '2026-08-01',
    1, 'eligible_product_taxable_value', 'half_up', 2,
    v_credit_note_type, v_discount_ledger, v_calendar, 4, 80
  );
  insert into public.scheme_version_customer_groups (scheme_version_id, company_id, customer_group_id)
  values (v_overlapping_cd_version, v_company, v_child_group);
  begin
    update public.scheme_versions set status = 'active' where id = v_overlapping_cd_version;
    raise exception 'Expected overlapping active CD rule rejection';
  exception when others then
    if position('cannot overlap' in sqlerrm) = 0 then raise; end if;
  end;

  insert into public.tally_vouchers (
    id, company_id, tally_guid, voucher_number, voucher_kind, voucher_date, party_customer_id,
    taxable_product_value, gross_amount
  ) values (
    v_sales_voucher, v_company, 'sale-guid', 'S-1', 'sales', date '2026-08-07', v_customer,
    200000, 200000
  );

  insert into public.discount_proposals (
    id, company_id, customer_id, scheme_version_id, scheme_type, source_sales_voucher_id,
    entitlement_key, source_fingerprint, last_live_refresh_at, invoice_amount_due,
    discounted_settlement_target, calculated_discount_amount
  ) values (
    v_cd_proposal, v_company, v_customer, v_cd_version, 'cd', v_sales_voucher,
    'cd:test:1', 'live:1', now(), 200000, 198000, 2000
  );
  begin
    insert into public.discount_proposals (
      company_id, customer_id, scheme_version_id, scheme_type, source_sales_voucher_id,
      entitlement_key, source_fingerprint, last_live_refresh_at
    ) values (
      v_company, v_customer, v_cd_version, 'cd', v_sales_voucher,
      'cd:test:2', 'live:2', now()
    );
    raise exception 'Expected duplicate CD entitlement rejection';
  exception when unique_violation then null;
  end;

  insert into public.proposal_evaluations (
    id, company_id, proposal_id, evaluation_number, outcome_status, source_fingerprint,
    rule_snapshot, customer_group_snapshot, formula_snapshot, calculated_discount_amount, posted_discount_amount
  ) values (
    v_cd_evaluation, v_company, v_cd_proposal, 1, 'eligible', 'live:1',
    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2000, 2000
  );
  begin
    update public.proposal_evaluations set formula_snapshot = '{"changed":true}'::jsonb where id = v_cd_evaluation;
    raise exception 'Expected immutable evaluation rejection';
  exception when others then
    if position('append-only' in sqlerrm) = 0 then raise; end if;
  end;

  insert into public.proposal_reviews (
    proposal_id, proposal_evaluation_id, status, source_fingerprint, reviewed_by, reviewed_at
  ) values (v_cd_proposal, v_cd_evaluation, 'approved', 'live:1', gen_random_uuid(), now());

  insert into public.credit_note_postings (
    id, proposal_id, proposal_evaluation_id, company_id, customer_id, status,
    idempotency_key, credit_note_date, discount_amount, calculation_reference,
    credit_note_voucher_type_id, discount_ledger_id,
    bill_allocation_type, credit_note_snapshot
  ) values (
    v_posting, v_cd_proposal, v_cd_evaluation, v_company, v_customer, 'queued',
    'credit:test:1', current_date, 2000, 'CD-TEST-1', v_credit_note_type, v_discount_ledger,
    'new_ref', '{}'::jsonb
  );

  insert into public.tally_vouchers (
    id, company_id, tally_guid, voucher_number, voucher_kind, voucher_type_id, voucher_date, party_customer_id,
    status, taxable_product_value, gross_amount
  ) values (
    v_credit_note_voucher, v_company, 'credit-guid', 'CN-1', 'credit_note', v_credit_note_type, current_date, v_customer,
    'posted', 0, 2000
  );
  update public.credit_note_postings set status = 'sending' where id = v_posting;
  update public.credit_note_postings set status = 'verification_pending' where id = v_posting;
  update public.credit_note_postings
  set status = 'created_verified', tally_credit_note_voucher_id = v_credit_note_voucher,
      verified_tally_guid = 'credit-guid', verified_voucher_number = 'CN-1', verified_amount = 2000,
      verified_at = now(), verification_snapshot = '{}'::jsonb,
      verified_company_matches = true, verified_party_matches = true,
      verified_voucher_type_matches = true, verified_discount_ledger_id = v_discount_ledger,
      verified_bill_allocation_type = 'new_ref', verified_no_inventory_lines = true,
      verified_no_unexpected_gst = true, verified_calculation_reference = 'CD-TEST-1',
      verified_ledger_entries_hash = repeat('a', 64)
  where id = v_posting;

  insert into public.customer_contacts (id, company_id, customer_id, phone_e164, source, is_primary)
  values (v_contact, v_company, v_customer, '+919999999999', 'controlled_manual_update', true);
  insert into public.whatsapp_opt_ins (company_id, customer_contact_id, is_opted_in, source, recorded_at)
  values (v_company, v_contact, true, 'customer consent', now());
  insert into public.whatsapp_templates (id, organization_id, event_type, provider_template_id, name)
  values (v_template, v_org, 'cd_credit_note_created', 'msg91-template-1', 'CD Credit Note');
  insert into public.notification_messages (
    company_id, proposal_id, credit_note_posting_id, customer_contact_id, whatsapp_template_id,
    event_type, business_event_key, recipient_phone_e164, payload, opt_in_snapshot
  ) values (
    v_company, v_cd_proposal, v_posting, v_contact, v_template,
    'cd_credit_note_created', 'message:test:1', '+919999999999', '{}'::jsonb, '{}'::jsonb
  );

  insert into public.schemes (id, company_id, scheme_type, code, name, status)
  values (v_tod_scheme, v_company, 'tod', 'TOD-1', 'TOD rule', 'active');
  insert into public.scheme_versions (
    id, company_id, scheme_id, scheme_type, version_number, effective_from,
    calculation_base, rounding_method, rounding_scale, credit_note_voucher_type_id,
    discount_ledger_id, period_months, period_anchor_date, tod_review_calendar_id
  ) values (
    v_tod_version, v_company, v_tod_scheme, 'tod', 1, date '2026-08-01',
    'eligible_product_taxable_value', 'half_up', 2, v_credit_note_type,
    v_discount_ledger, 1, date '2026-08-01', v_calendar
  );
  insert into public.scheme_version_customer_groups (scheme_version_id, company_id, customer_group_id)
  values (v_tod_version, v_company, v_parent_group);
  insert into public.scheme_version_stock_items (scheme_version_id, company_id, stock_item_id)
  values (v_tod_version, v_company, v_stock_item);
  insert into public.scheme_version_unit_conversions (
    scheme_version_id, company_id, source_uom_id, tonnes_per_source_unit, is_builtin
  ) values (v_tod_version, v_company, v_unit, 0.001, true);
  insert into public.scheme_version_tiers (scheme_version_id, minimum_tonnes, discount_percentage)
  values (v_tod_version, 100, 1);
  update public.scheme_versions set status = 'active' where id = v_tod_version;

  select id into v_evaluation_run
  from public.create_meenakshi_evaluation_run(
    v_org,
    v_company,
    gen_random_uuid(),
    jsonb_build_object('schemeType', 'tod', 'customerId', v_customer, 'asOfDate', '2026-08-15'),
    'evaluation:test:1'
  );
  select id into v_repeat_evaluation_run
  from public.create_meenakshi_evaluation_run(
    v_org,
    v_company,
    gen_random_uuid(),
    jsonb_build_object('schemeType', 'tod', 'customerId', v_customer, 'asOfDate', '2026-08-15'),
    'evaluation:test:1'
  );
  if v_evaluation_run <> v_repeat_evaluation_run then
    raise exception 'Expected duplicate evaluation request to reuse the first run';
  end if;

  select id into v_tod_period_lock
  from public.lock_meenakshi_tod_customer_period(
    v_company, v_customer, v_tod_scheme, v_tod_version,
    date '2026-08-01', date '2026-08-31', v_evaluation_run
  );
  begin
    update public.tod_customer_period_rule_locks
    set period_end = date '2026-09-01'
    where id = v_tod_period_lock;
    raise exception 'Expected immutable TOD customer-period rule lock rejection';
  exception when others then
    if position('immutable' in sqlerrm) = 0 then raise; end if;
  end;

  insert into public.discount_proposals (
    id, company_id, customer_id, scheme_version_id, scheme_type, period_start, period_end,
    entitlement_key, source_fingerprint, last_live_refresh_at
  ) values (
    v_tod_proposal, v_company, v_customer, v_tod_version, 'tod', date '2026-08-01', date '2026-08-31',
    'tod:test:1', 'live:tod:1', now()
  );
  begin
    insert into public.discount_proposals (
      company_id, customer_id, scheme_version_id, scheme_type, period_start, period_end,
      entitlement_key, source_fingerprint, last_live_refresh_at
    ) values (
      v_company, v_customer, v_tod_version, 'tod', date '2026-08-01', date '2026-08-31',
      'tod:test:2', 'live:tod:2', now()
    );
    raise exception 'Expected duplicate TOD entitlement rejection';
  exception when unique_violation then null;
  end;

  if not (select relrowsecurity from pg_class where oid = 'public.discount_proposals'::regclass) then
    raise exception 'RLS is not enabled for discount proposals';
  end if;

  insert into public.tally_connectors (
    id, organization_id, installation_key, display_name, machine_fingerprint,
    control_token_hash, status, paired_at
  ) values (
    v_connector, v_org, 'test-installation', 'Test Tally Bridge', 'test-machine',
    repeat('b', 64), 'paired', now()
  );
  insert into public.tally_connector_company_bindings (
    organization_id, company_id, connector_id, expected_tally_company_guid,
    expected_tally_company_name
  ) values (
    v_org, v_company, v_connector, 'company-guid', 'Meenakshi Tally'
  );
  insert into public.integration_outbox (
    id, organization_id, company_id, correlation_id, event_key, idempotency_key,
    event_type, aggregate_type, aggregate_id, payload
  ) values (
    v_outbox, v_org, v_company, gen_random_uuid(), 'refresh:test:1', 'refresh:test:1',
    'tally_targeted_refresh', 'discount_proposal', v_cd_proposal, '{}'::jsonb
  );
  select count(*) into v_claimed_count
  from public.claim_tally_integration_outbox('schema-smoke', 1, 60);
  if v_claimed_count <> 1 then
    raise exception 'Expected filtered Tally outbox worker claim to return one row';
  end if;
  if (select status from public.integration_outbox where id = v_outbox) <> 'processing' then
    raise exception 'Expected filtered Tally outbox claim to lease the event';
  end if;

  insert into public.tally_commands (
    id, organization_id, company_id, connector_id, command_type,
    business_idempotency_key, correlation_id, expected_tally_company_guid,
    expected_tally_company_name, payload
  ) values (
    v_command, v_org, v_company, v_connector, 'sync_meenakshi_masters',
    'sync:test:1', gen_random_uuid(), 'company-guid', 'Meenakshi Tally', '{}'::jsonb
  );
  select count(*) into v_claimed_count
  from public.claim_tally_commands(v_connector, 'schema-smoke-bridge', 1, 90);
  if v_claimed_count <> 1 then
    raise exception 'Expected paired bridge command claim to return one row';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.tally_connectors'::regclass) then
    raise exception 'RLS is not enabled for tally_connectors';
  end if;
end;
$$;

rollback;
