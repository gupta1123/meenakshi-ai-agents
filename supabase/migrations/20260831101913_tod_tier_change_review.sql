-- A TOD tier notification is a customer-facing milestone, not a promise that
-- a later return cannot reduce the tier. When that happens after a message
-- was sent, stop automatic messaging and require an explicit review.

create or replace function public.phase_6_enqueue_tod_tier_reached_trigger()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_percentage numeric;
  v_new_percentage numeric;
  v_was_sent boolean := false;
begin
  if new.scheme_type <> 'tod' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.achieved_tier_id is not null then
    select tier.discount_percentage into v_old_percentage
    from public.scheme_version_tiers tier where tier.id = old.achieved_tier_id;
    select tier.discount_percentage into v_new_percentage
    from public.scheme_version_tiers tier where tier.id = new.achieved_tier_id;
    v_old_percentage := coalesce(v_old_percentage, old.discount_percentage, 0);
    v_new_percentage := coalesce(v_new_percentage, new.discount_percentage, 0);

    if new.achieved_tier_id is null or v_new_percentage < v_old_percentage then
      select exists (
        select 1 from public.notification_messages message
        where message.proposal_id = old.id
          and message.event_type = 'tod_tier_reached'
          and message.business_event_key = 'phase6:tod_tier_reached:' || old.id::text || ':' || old.achieved_tier_id::text
          and message.status in ('sent', 'delivered', 'read')
      ) into v_was_sent;

      if v_was_sent then
        insert into public.processing_issues (
          company_id, proposal_id, customer_id, scheme_version_id, issue_key, issue_type, status, details
        ) values (
          new.company_id, new.id, new.customer_id, new.scheme_version_id,
          'tod-tier-reduction:' || new.id::text || ':' || old.achieved_tier_id::text,
          'tod_tier_reduced_after_notification', 'open',
          jsonb_build_object(
            'oldTierId', old.achieved_tier_id,
            'oldTierPercentage', v_old_percentage,
            'newTierId', new.achieved_tier_id,
            'newTierPercentage', case when new.achieved_tier_id is null then null else v_new_percentage end,
            'message', 'A prior TOD tier update was sent. The tier later reduced after refreshed Tally data; no correction message was sent automatically.'
          )
        ) on conflict (issue_key) do update
          set status = 'open', details = excluded.details, resolved_by = null, resolved_at = null, updated_at = now();
      end if;

      -- Do not turn a tier reduction into another automated message. A queued
      -- message for the old tier is independently suppressed by its claim rule.
      return new;
    end if;
  end if;

  if new.status in ('tracking', 'eligible') and new.achieved_tier_id is not null then
    perform public.enqueue_phase_6_notification(new.company_id, new.id, 'tod_tier_reached', null, null);
  end if;
  return new;
end;
$$;

revoke execute on function public.phase_6_enqueue_tod_tier_reached_trigger() from public, anon, authenticated;
grant execute on function public.phase_6_enqueue_tod_tier_reached_trigger() to service_role;
