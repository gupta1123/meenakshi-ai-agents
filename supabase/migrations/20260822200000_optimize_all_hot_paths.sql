-- Single comprehensive optimization for all hot API paths.
-- NOT APPLIED YET: intentionally left unapplied per developer request.
-- After review: supabase db push / supabase migration up
-- Covers: /overview (10→1 RTT), /operations/health (20 counts→1 RPC),
-- /notifications/health (1000 fetch→GROUP BY), /proposals/detail (10→1 RPC),
-- plus covering indexes + pagination support for unbounded reads.

-- ============================================================
-- 0) COVERING INDEXES (all IF NOT EXISTS, safe to re-run)
-- ============================================================

-- overview / tod
create index if not exists discount_proposals_company_tod_recent_idx
  on public.discount_proposals (company_id, updated_at desc)
  where scheme_type = 'tod';

create index if not exists discount_proposals_company_tod_latest_evaluated_idx
  on public.discount_proposals (company_id, latest_evaluated_at desc)
  where scheme_type = 'tod' and latest_evaluated_at is not null;

create index if not exists discount_proposals_company_scheme_status_idx
  on public.discount_proposals (company_id, scheme_type, status, updated_at desc);

-- credit notes
create index if not exists credit_note_postings_company_idx
  on public.credit_note_postings (company_id);

create index if not exists credit_note_postings_company_awaiting_idx
  on public.credit_note_postings (company_id)
  where status <> 'created_verified';

create index if not exists credit_note_postings_proposal_idx
  on public.credit_note_postings (company_id, proposal_id);

-- notifications (company-scoped, replaces unscoped queue_idx)
create index if not exists notification_messages_company_status_created_idx
  on public.notification_messages (company_id, status, created_at desc);

create index if not exists notification_messages_company_queued_idx
  on public.notification_messages (company_id)
  where status = 'queued';

create index if not exists notification_messages_company_failed_idx
  on public.notification_messages (company_id, attempt_count, max_attempts)
  where status = 'failed';

create index if not exists notification_messages_company_proposal_event_idx
  on public.notification_messages (company_id, proposal_id, event_type, created_at desc);

-- recovery
create index if not exists cash_discount_recovery_candidates_company_snapshot_remaining_idx
  on public.cash_discount_recovery_candidates (company_id, remaining_recovery desc)
  where current_snapshot and status in ('action_required','review_required','posting');

-- tally binding + sync
create index if not exists tally_connector_company_bindings_company_active_idx
  on public.tally_connector_company_bindings (company_id)
  where is_active;

create index if not exists tally_sync_runs_company_kind_created_idx
  on public.tally_sync_runs (company_id, sync_kind, created_at desc);

-- evaluation runs lookup
create index if not exists evaluation_runs_company_created_idx
  on public.evaluation_runs (company_id, created_at desc);

create index if not exists proposal_evaluations_company_proposal_idx
  on public.proposal_evaluations (company_id, proposal_id, evaluation_number desc);

-- reference-data masters (company + availability)
create index if not exists customers_company_available_name_idx
  on public.customers (company_id, is_available, ledger_name)
  where is_available;

create index if not exists customer_groups_company_available_name_idx
  on public.customer_groups (company_id, is_available, name)
  where is_available;

-- ============================================================
-- 1) GET_COMPANY_OVERVIEW (overview 10→1 RTT)
-- ============================================================
create or replace function public.get_company_overview(p_company_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_binding record;
  v_connector record;
  v_heartbeat_at timestamptz;
  v_heartbeat_stale boolean;
  v_company_matches boolean;
  v_tally_status text;
  v_result jsonb;
begin
  select connector_id, expected_tally_company_guid, expected_tally_company_name,
         observed_tally_company_guid, observed_tally_company_name
    into v_binding
  from public.tally_connector_company_bindings
  where company_id = p_company_id and is_active
  limit 1;

  if v_binding.connector_id is not null then
    select id, status, last_heartbeat_at into v_connector
    from public.tally_connectors where id = v_binding.connector_id;
  end if;

  v_heartbeat_at := v_connector.last_heartbeat_at;
  v_heartbeat_stale := v_heartbeat_at is null or (extract(epoch from (now() - v_heartbeat_at)) * 1000) > 90000;
  v_company_matches :=
    v_binding.expected_tally_company_guid is not null
    and v_binding.observed_tally_company_guid is not null
    and v_binding.observed_tally_company_name is not null
    and lower(btrim(v_binding.expected_tally_company_guid)) = lower(btrim(v_binding.observed_tally_company_guid))
    and lower(btrim(v_binding.expected_tally_company_name)) = lower(btrim(v_binding.observed_tally_company_name));

  v_tally_status := case
    when v_binding.connector_id is null then 'not_bound'
    when v_connector.id is null or v_connector.status <> 'paired' then 'awaiting_pairing'
    when v_heartbeat_stale then 'bridge_stale'
    when v_company_matches then 'ready'
    else 'company_mismatch'
  end;

  with
  tod_proposals as (
    select id, customer_id, status, calculated_discount_amount, latest_evaluated_at, updated_at
    from public.discount_proposals
    where company_id = p_company_id and scheme_type = 'tod'
    order by updated_at desc limit 250
  ),
  tod_activity_raw as (
    select * from tod_proposals where latest_evaluated_at is not null order by updated_at desc limit 4
  ),
  recovery_agg as (
    select count(*) filter (where status in ('action_required','posting')) as action_count,
           count(*) filter (where status = 'review_required') as review_count,
           coalesce(sum(remaining_recovery) filter (where status in ('action_required','posting')), 0) as amount
    from public.cash_discount_recovery_candidates
    where company_id = p_company_id and current_snapshot and status in ('action_required','review_required','posting')
  ),
  credit_agg as (
    select (select count(*) from public.credit_note_postings where company_id = p_company_id) as total,
           (select count(*) from public.credit_note_postings where company_id = p_company_id and status <> 'created_verified') as awaiting
  ),
  msg_queued as (select count(*) as queued from public.notification_messages where company_id = p_company_id and status = 'queued'),
  msg_failed_agg as (
    select count(*) filter (where attempt_count < max_attempts and coalesce((provider_metadata->>'terminal')::boolean,false)=false) as retrying,
           count(*) filter (where attempt_count >= max_attempts or coalesce((provider_metadata->>'terminal')::boolean,false)=true) as terminal_failures
    from public.notification_messages where company_id = p_company_id and status = 'failed'
  ),
  msg_recent as (
    select id, event_type, status, sent_at, created_at from public.notification_messages
    where company_id = p_company_id order by created_at desc limit 3
  ),
  tod_stats as (
    select count(*) as result_count,
           count(*) filter (where status in ('eligible','needs_review','review_invalidated','pending_approval')) as review_count,
           coalesce(sum(calculated_discount_amount),0) as projected_amount
    from tod_proposals
  )
  select jsonb_build_object(
    'generatedAt', to_jsonb(now()),
    'tally', jsonb_build_object('status', v_tally_status, 'ready', v_tally_status='ready', 'heartbeatAt', to_jsonb(v_heartbeat_at)),
    'recoveries', (select jsonb_build_object('actionCount', action_count, 'reviewCount', review_count, 'amount', amount::float8) from recovery_agg),
    'turnoverDiscount', (select jsonb_build_object('reviewCount', review_count, 'resultCount', result_count, 'projectedAmount', projected_amount::float8) from tod_stats),
    'creditNotes', (select jsonb_build_object('total', total, 'awaiting', awaiting) from credit_agg),
    'messages', jsonb_build_object('queued', (select queued from msg_queued), 'retrying', coalesce((select retrying from msg_failed_agg),0), 'terminalFailures', coalesce((select terminal_failures from msg_failed_agg),0)),
    'activity', (
      with proposal_activity as (
        select p.id, 'Turnover Discount result updated' as title, coalesce(c.ledger_name,'Customer result') as detail, p.latest_evaluated_at as at
        from tod_activity_raw p left join public.customers c on c.id=p.customer_id and c.company_id=p_company_id
      ),
      message_activity as (
        select m.id, 'WhatsApp message '||replace(m.status,'_',' ') as title, replace(m.event_type,'_',' ') as detail, coalesce(m.sent_at,m.created_at) as at from msg_recent m
      ),
      combined as (select * from proposal_activity union all select * from message_activity)
      select coalesce(jsonb_agg(to_jsonb(combined) order by combined.at desc),'[]'::jsonb) from (select * from combined order by at desc nulls last limit 6) combined
    )
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_company_overview(uuid) from public, anon, authenticated;
grant execute on function public.get_company_overview(uuid) to service_role;

-- ============================================================
-- 2) GET_OPERATIONS_HEALTH_COUNTS (20 counts + 1000 fetch → 1 RPC)
-- ============================================================
create or replace function public.get_operations_health_counts(p_company_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare v_result jsonb;
begin
  with
  outbox_counts as (
    select jsonb_object_agg(status, cnt) as j from (
      select status, count(*) as cnt from public.integration_outbox where company_id=p_company_id group by status
    ) s
  ),
  cmd_counts as (
    select jsonb_object_agg(status, cnt) as j from (
      select status, count(*) as cnt from public.tally_commands where company_id=p_company_id group by status
    ) s
  ),
  msg_counts as (
    select jsonb_object_agg(status, cnt) as j from (
      select status, count(*) as cnt from public.notification_messages where company_id=p_company_id group by status
    ) s
  ),
  msg_failed as (
    select count(*) filter (where attempt_count < max_attempts and coalesce((provider_metadata->>'terminal')::boolean,false)=false) as retrying,
           count(*) filter (where attempt_count >= max_attempts or coalesce((provider_metadata->>'terminal')::boolean,false)=true) as terminal
    from public.notification_messages where company_id=p_company_id and status='failed'
  ),
  proposal_cnt as (select count(*) as cnt from public.discount_proposals where company_id=p_company_id and status in ('needs_review','review_invalidated'))
  select jsonb_build_object(
    'outboxCounts', coalesce((select j from outbox_counts),'{}'::jsonb),
    'commandCounts', coalesce((select j from cmd_counts),'{}'::jsonb),
    'messageCounts', coalesce((select j from msg_counts),'{}'::jsonb),
    'retrying', coalesce((select retrying from msg_failed),0),
    'terminalFailures', coalesce((select terminal from msg_failed),0),
    'proposalCount', (select cnt from proposal_cnt)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_operations_health_counts(uuid) from public, anon, authenticated;
grant execute on function public.get_operations_health_counts(uuid) to service_role;

-- ============================================================
-- 3) GET_NOTIFICATION_HEALTH (1000 fetch → GROUP BY)
-- ============================================================
create or replace function public.get_notification_health(p_company_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with counts as (
    select jsonb_object_agg(status, cnt) as j from (
      select status, count(*) as cnt from public.notification_messages where company_id=p_company_id group by status
    ) s
  ),
  failed as (
    select count(*) filter (where attempt_count < max_attempts and coalesce((provider_metadata->>'terminal')::boolean,false)=false) as retrying,
           count(*) filter (where attempt_count >= max_attempts or coalesce((provider_metadata->>'terminal')::boolean,false)=true) as terminal
    from public.notification_messages where company_id=p_company_id and status='failed'
  )
  select jsonb_build_object(
    'counts', coalesce((select j from counts),'{}'::jsonb),
    'retrying', coalesce((select retrying from failed),0),
    'terminalFailures', coalesce((select terminal from failed),0),
    'sampledMessages', (select count(*) from public.notification_messages where company_id=p_company_id)
  );
$$;
revoke all on function public.get_notification_health(uuid) from public, anon, authenticated;
grant execute on function public.get_notification_health(uuid) to service_role;

-- ============================================================
-- 4) GET_PROPOSAL_DETAIL (4 waterfalls 10 RTT → 1 RPC)
-- ============================================================
create or replace function public.get_proposal_detail(p_proposal_id uuid, p_company_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_proposal jsonb;
  v_evaluation jsonb;
  v_evaluation_id uuid;
  v_posting jsonb;
  v_posting_id uuid;
  v_document jsonb;
  v_issues jsonb;
  v_reviews jsonb;
  v_tiers jsonb;
  v_vouchers jsonb;
  v_lines jsonb;
  v_tally_lines jsonb;
  v_notification jsonb;
  v_result jsonb;
  v_event_type text;
  v_existing_id uuid;
  v_existing_status text;
  v_contact_id uuid;
  v_opt_in uuid;
  v_template uuid;
  v_org_id uuid;
begin
  select to_jsonb(p) into v_proposal from public.discount_proposals p where p.id=p_proposal_id and p.company_id=p_company_id;
  if v_proposal is null then return jsonb_build_object('error','not_found'); end if;

  select to_jsonb(e) into v_evaluation from public.proposal_evaluations e
    where e.proposal_id=p_proposal_id and e.company_id=p_company_id order by e.evaluation_number desc limit 1;
  v_evaluation_id := (v_evaluation->>'id')::uuid;

  select to_jsonb(x) into v_posting from public.credit_note_postings x where x.proposal_id=p_proposal_id and x.company_id=p_company_id;
  v_posting_id := (v_posting->>'id')::uuid;

  if v_posting_id is not null then
    select to_jsonb(d) into v_document from public.credit_note_documents d where d.credit_note_posting_id=v_posting_id;
  end if;

  select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at), '[]'::jsonb) into v_issues
    from public.processing_issues i where i.proposal_id=p_proposal_id and i.company_id=p_company_id and i.status in ('open','in_progress');

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb) into v_reviews
    from public.proposal_reviews r where r.proposal_id=p_proposal_id;

  if (v_proposal->>'scheme_type')='tod' and (v_proposal->>'scheme_version_id') is not null then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.minimum_tonnes), '[]'::jsonb) into v_tiers
      from public.scheme_version_tiers t where t.scheme_version_id=(v_proposal->>'scheme_version_id')::uuid;
  else
    v_tiers := '[]'::jsonb;
  end if;

  if v_evaluation_id is not null then
    select coalesce(jsonb_agg(to_jsonb(sv) order by sv.created_at), '[]'::jsonb) into v_vouchers
      from public.proposal_source_vouchers sv where sv.proposal_evaluation_id=v_evaluation_id;
    select coalesce(jsonb_agg(to_jsonb(sl) order by sl.created_at), '[]'::jsonb) into v_lines
      from public.proposal_source_inventory_lines sl where sl.proposal_evaluation_id=v_evaluation_id;
    -- batch tally lines in same RPC (avoids IN query from Node)
    select coalesce(jsonb_agg(to_jsonb(tl)), '[]'::jsonb) into v_tally_lines
      from public.tally_voucher_inventory_lines tl
      where tl.company_id=p_company_id and tl.id in (select (x->>'tally_voucher_inventory_line_id')::uuid from jsonb_array_elements(coalesce(v_lines,'[]'::jsonb)) x);
  else
    v_vouchers := '[]'::jsonb; v_lines := '[]'::jsonb; v_tally_lines := '[]'::jsonb;
  end if;

  -- notification summary fully computed in PG (avoids 3 extra RTTs)
  v_event_type := case
    when (v_proposal->>'status')='near_eligibility' and (v_proposal->>'scheme_type')='cd' then 'cd_shortfall'
    when v_posting is not null and (v_posting->>'status')='created_verified' then case when (v_proposal->>'scheme_type')='tod' then 'tod_credit_note_created' else 'cd_credit_note_created' end
    else null end;

  if v_event_type is null then
    v_notification := jsonb_build_object('eventType', null, 'messageId', null, 'status', null, 'canQueue', false, 'blockedReason', 'A message is not applicable at the current workflow state.');
  else
    select id, status into v_existing_id, v_existing_status from public.notification_messages n where n.company_id=p_company_id and n.proposal_id=p_proposal_id and n.event_type=v_event_type order by n.created_at desc limit 1;
    if v_existing_id is not null then
      v_notification := jsonb_build_object('eventType', v_event_type, 'messageId', v_existing_id, 'status', v_existing_status, 'canQueue', false, 'blockedReason', 'An event already exists for this business action.');
    else
      select id into v_contact_id from public.customer_contacts c where c.company_id=p_company_id and c.customer_id=(v_proposal->>'customer_id')::uuid and c.is_active order by c.is_primary desc, c.entered_at limit 1;
      if v_contact_id is null then
        v_notification := jsonb_build_object('eventType', v_event_type, 'messageId', null, 'status', null, 'canQueue', false, 'blockedReason', 'No active controlled customer contact is recorded.');
      else
        select id into v_opt_in from public.whatsapp_opt_ins w where w.company_id=p_company_id and w.customer_contact_id=v_contact_id and w.is_opted_in and w.revoked_at is null limit 1;
        if v_opt_in is null then
          v_notification := jsonb_build_object('eventType', v_event_type, 'messageId', null, 'status', null, 'canQueue', false, 'blockedReason', 'The active controlled contact has no recorded WhatsApp opt-in.');
        else
          select organization_id into v_org_id from public.companies where id=p_company_id;
          select id into v_template from public.whatsapp_templates t where t.organization_id=v_org_id and t.event_type=v_event_type and t.is_active limit 1;
          if v_template is null then
            v_notification := jsonb_build_object('eventType', v_event_type, 'messageId', null, 'status', null, 'canQueue', false, 'blockedReason', 'No active approved WhatsApp template is available for this event.');
          else
            v_notification := jsonb_build_object('eventType', v_event_type, 'messageId', null, 'status', null, 'canQueue', true, 'blockedReason', null);
          end if;
        end if;
      end if;
    end if;
  end if;

  select jsonb_build_object(
    'proposal', v_proposal,
    'latestEvaluation', v_evaluation,
    'openIssues', v_issues,
    'reviews', v_reviews,
    'creditNotePosting', case when v_posting is null then null else v_posting || jsonb_build_object('document', v_document) end,
    'tallyEvidence', jsonb_build_object('tiers', v_tiers, 'vouchers', v_vouchers, 'lines', v_lines, 'tallyLines', v_tally_lines),
    'notification', v_notification
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_proposal_detail(uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_proposal_detail(uuid,uuid) to service_role;

comment on function public.get_company_overview(uuid) is 'Overview dashboard in one PG round-trip (replaces 10 PostgREST hops).';
comment on function public.get_operations_health_counts(uuid) is 'Operations health aggregates: GROUP BY status for 3 tables + failed retry/terminal in one RPC (replaces 20 count head + 1000 fetch).';
comment on function public.get_notification_health(uuid) is 'Notification health GROUP BY (replaces 1000 row fetch + JS aggregation).';
comment on function public.get_proposal_detail(uuid,uuid) is 'Proposal detail 4 waterfalls 10 RTT → 1 RPC (proposal+eval+issues+reviews+posting+tiers+vouchers+lines+tallyLines).';
