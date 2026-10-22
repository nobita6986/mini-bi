-- MBI-DA-2026-01 Chặng 2 / WF-03 (Items 2.5 & 2.6):
--   2.5 Workforce Tenure / Active ON Duration & In-Period Status Presence Days:
--       evaluates contiguous ON intervals on non-superseded events using half-open intervals
--       ([start, next_effective_date) for closed intervals, [start, as_of + 1 day) for intervals still active at as_of,
--       and [from, to + 1 day) for the filter period window), grouped by explicit sample populations
--       (all_ever_on, currently_on, exited_after_on), duration distribution buckets, and period presence window.
--   2.6 Early Attrition & Continuous D7/D30/D90 Cohort Retention:
--       evaluates ON cohorts starting from each episode's first actual ON effective_date on the non-superseded
--       event chain (excluding UNCONFIRMED-only or UNKNOWN episodes), strictly separating matured vs immature
--       checkpoints (cohort_start_date + k <= as_of vs > as_of) and continuously retained vs exited episodes.
begin;

create or replace function public.direct_entry_workforce_reporting_scoped(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_audience jsonb;
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from_text text;
  v_to_text text;
  v_as_of_text text;
  v_from date;
  v_to date;
  v_open_as_of date;
  v_as_of_override date;
  v_today date;
  v_as_of date;
  v_as_of_source text;
  v_project text;
  v_recruiter text;
  v_provider text;
  v_employment text;
  v_team_bucket text;
  v_team_code text;
  v_result jsonb;
begin
  v_audience := public.direct_entry_reporting_resolve_audience(p_auth_subject, p_app_user_id);

  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'invalid reporting filters' using errcode = '22023';
  end if;

  v_from_text := nullif(btrim(v_filters->>'from'), '');
  if v_from_text is not null then
    if v_from_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invalid from date' using errcode = '22023';
    end if;
    begin
      v_from := v_from_text::date;
    exception when others then
      raise exception 'invalid from date' using errcode = '22023';
    end;
    if to_char(v_from, 'YYYY-MM-DD') <> v_from_text then
      raise exception 'invalid from date' using errcode = '22023';
    end if;
  end if;

  v_to_text := nullif(btrim(v_filters->>'to'), '');
  if v_to_text is not null then
    if v_to_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invalid to date' using errcode = '22023';
    end if;
    begin
      v_to := v_to_text::date;
    exception when others then
      raise exception 'invalid to date' using errcode = '22023';
    end;
    if to_char(v_to, 'YYYY-MM-DD') <> v_to_text then
      raise exception 'invalid to date' using errcode = '22023';
    end if;
  end if;

  if v_from is not null and v_to is not null and v_from > v_to then
    raise exception 'from must be <= to' using errcode = '22023';
  end if;

  if v_from is not null and v_to is not null then
    v_open_as_of := (v_from - 1);
  end if;

  v_as_of_text := nullif(btrim(v_filters->>'as_of'), '');
  if v_as_of_text is not null then
    if v_as_of_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invalid as_of date' using errcode = '22023';
    end if;
    begin
      v_as_of_override := v_as_of_text::date;
    exception when others then
      raise exception 'invalid as_of date' using errcode = '22023';
    end;
    if to_char(v_as_of_override, 'YYYY-MM-DD') <> v_as_of_text then
      raise exception 'invalid as_of date' using errcode = '22023';
    end if;
  end if;

  v_today := public.direct_entry_authorization_date();
  v_as_of := coalesce(v_as_of_override, v_to, v_today);
  v_as_of_source := case
    when v_as_of_override is not null then 'explicit_as_of'
    when v_to is not null then 'filter_to'
    else 'current_hcm_date'
  end;

  v_project := nullif(btrim(v_filters->>'project'), '');
  v_recruiter := nullif(btrim(v_filters->>'recruiter'), '');
  v_provider := nullif(btrim(v_filters->>'provider'), '');
  v_employment := nullif(btrim(v_filters->>'employment'), '');

  v_team_bucket := nullif(btrim(v_filters->>'team_bucket'), '');
  if v_team_bucket is not null then
    if v_audience->>'audience' = 'own' then
      raise exception 'team bucket not allowed for own scope' using errcode = '42501';
    end if;
    if v_team_bucket = 'unknown' then
      if v_audience->>'audience' <> 'all' then
        raise exception 'unknown team bucket requires all scope' using errcode = '42501';
      end if;
    elsif v_team_bucket like 'team:%' and char_length(v_team_bucket) > 5 then
      v_team_code := substring(v_team_bucket from 6);
      if v_audience->>'audience' = 'team' then
        if not exists (
          select 1
          from public.teams t
          where t.code = v_team_code
            and t.team_id in (
              select (x#>>'{}')::uuid
              from jsonb_array_elements(coalesce(v_audience->'team_ids', '[]'::jsonb)) x
            )
        ) then
          raise exception 'team bucket out of scope' using errcode = '42501';
        end if;
      end if;
    else
      raise exception 'invalid team_bucket filter' using errcode = '22023';
    end if;
  end if;

  with authorized as (
    select a.entry_id
    from public.direct_entry_reporting_authorized_entries(p_auth_subject, p_app_user_id) a
  ),
  scoped_episodes as (
    select
      f.entry_id,
      f.first_work_date
    from authorized a
    join public.direct_entry_reporting_facts_v01 f on f.entry_id = a.entry_id
    join public.direct_entries de on de.entry_id = f.entry_id
    join public.direct_entry_submissions ds on ds.submission_id = de.submission_id
    where ds.state = 'SUBMITTED'
      and de.deleted_at is null
      and de.voided_at is null
      and (v_project is null or f.project_key = v_project)
      and (v_recruiter is null or f.recruiter_key = v_recruiter)
      and (v_provider is null or f.provider_type_key = v_provider)
      and (v_employment is null or f.employment_type_key = v_employment)
      and (
        v_team_bucket is null
        or (v_team_bucket = 'unknown' and f.team_code is null)
        or (v_team_bucket like 'team:%' and f.team_code = v_team_code)
      )
  ),
  active_events as (
    select
      ev.event_id,
      ev.entry_id,
      ev.status,
      ev.effective_date,
      ev.version,
      lag(ev.status) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as prev_status
    from public.direct_entry_employment_status_events ev
    join scoped_episodes ep on ep.entry_id = ev.entry_id
    where not exists (
      select 1
      from public.direct_entry_employment_status_events r
      where r.supersedes_event_id = ev.event_id
    )
  ),
  snapshot_rows as (
    select
      ep.entry_id,
      case
        when ep.first_work_date > v_as_of then 'FUTURE'
        when latest_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then latest_ev.status
        else 'UNKNOWN'
      end as as_of_status
    from scoped_episodes ep
    left join lateral (
      select ev.status
      from active_events ev
      where ev.entry_id = ep.entry_id
        and ev.effective_date <= v_as_of
      order by ev.effective_date desc, ev.version desc
      limit 1
    ) latest_ev on ep.first_work_date <= v_as_of
  ),
  snapshot_agg as (
    select
      count(*) filter (where sr.as_of_status <> 'FUTURE')::int as eligible_episode_total,
      count(*) filter (where sr.as_of_status = 'ON')::int as on_count,
      count(*) filter (where sr.as_of_status = 'UNCONFIRMED')::int as unconfirmed_count,
      count(*) filter (where sr.as_of_status = 'OFF')::int as off_count,
      count(*) filter (where sr.as_of_status = 'UNKNOWN')::int as unknown_count,
      count(*) filter (where sr.as_of_status = 'FUTURE')::int as future_episode_count
    from snapshot_rows sr
  ),
  period_events as (
    select
      ev.event_id,
      ev.entry_id,
      ev.prev_status,
      ev.status
    from active_events ev
    join scoped_episodes ep on ep.entry_id = ev.entry_id
    where v_from is not null
      and v_to is not null
      and ep.first_work_date <= v_to
      and ev.effective_date >= v_from
      and ev.effective_date <= v_to
  ),
  transitions_agg as (
    select
      count(*) filter (where pe.prev_status is null and pe.status in ('ON', 'UNCONFIRMED'))::int as initial_total_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is null and pe.status in ('ON', 'UNCONFIRMED'))::int as initial_total_episode_count,
      count(*) filter (where pe.prev_status is null and pe.status = 'ON')::int as initial_on_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is null and pe.status = 'ON')::int as initial_on_episode_count,
      count(*) filter (where pe.prev_status is null and pe.status = 'UNCONFIRMED')::int as initial_unconfirmed_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is null and pe.status = 'UNCONFIRMED')::int as initial_unconfirmed_episode_count,
      count(*) filter (where pe.prev_status = 'UNCONFIRMED' and pe.status = 'ON')::int as unconfirmed_to_on_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status = 'UNCONFIRMED' and pe.status = 'ON')::int as unconfirmed_to_on_episode_count,
      count(*) filter (where pe.prev_status = 'UNCONFIRMED' and pe.status = 'OFF')::int as unconfirmed_to_off_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status = 'UNCONFIRMED' and pe.status = 'OFF')::int as unconfirmed_to_off_episode_count,
      count(*) filter (where pe.prev_status = 'ON' and pe.status = 'OFF')::int as on_to_off_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status = 'ON' and pe.status = 'OFF')::int as on_to_off_episode_count,
      count(*) filter (where pe.prev_status = 'OFF' and pe.status = 'ON')::int as off_to_on_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status = 'OFF' and pe.status = 'ON')::int as off_to_on_episode_count,
      count(*) filter (
        where pe.prev_status is not null
          and pe.prev_status <> pe.status
          and not (
            (pe.prev_status = 'UNCONFIRMED' and pe.status in ('ON', 'OFF'))
            or (pe.prev_status = 'ON' and pe.status = 'OFF')
            or (pe.prev_status = 'OFF' and pe.status = 'ON')
          )
      )::int as other_transition_event_count,
      count(distinct pe.entry_id) filter (
        where pe.prev_status is not null
          and pe.prev_status <> pe.status
          and not (
            (pe.prev_status = 'UNCONFIRMED' and pe.status in ('ON', 'OFF'))
            or (pe.prev_status = 'ON' and pe.status = 'OFF')
            or (pe.prev_status = 'OFF' and pe.status = 'ON')
          )
      )::int as other_transition_episode_count,
      count(*) filter (where pe.prev_status is not null and pe.prev_status <> pe.status)::int as total_transition_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is not null and pe.prev_status <> pe.status)::int as total_transition_episode_count,
      count(*) filter (where pe.prev_status is not null and pe.prev_status = pe.status)::int as noop_repeat_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is not null and pe.prev_status = pe.status)::int as noop_repeat_episode_count
    from period_events pe
  ),
  -- WF-02 (2.3): Opening (from - 1 day) & Closing (to) snapshots and per-status balance flows
  opening_snapshot_rows as (
    select
      ep.entry_id,
      ep.first_work_date,
      case
        when v_open_as_of is null then null
        when ep.first_work_date > v_open_as_of then 'FUTURE'
        when open_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then open_ev.status
        else 'UNKNOWN'
      end as open_status
    from scoped_episodes ep
    left join lateral (
      select ev.status
      from active_events ev
      where ev.entry_id = ep.entry_id
        and v_open_as_of is not null
        and ev.effective_date <= v_open_as_of
      order by ev.effective_date desc, ev.version desc
      limit 1
    ) open_ev on v_open_as_of is not null and ep.first_work_date <= v_open_as_of
  ),
  closing_snapshot_rows as (
    select
      ep.entry_id,
      ep.first_work_date,
      case
        when v_to is null then null
        when ep.first_work_date > v_to then 'FUTURE'
        when close_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then close_ev.status
        else 'UNKNOWN'
      end as close_status
    from scoped_episodes ep
    left join lateral (
      select ev.status
      from active_events ev
      where ev.entry_id = ep.entry_id
        and v_to is not null
        and ev.effective_date <= v_to
      order by ev.effective_date desc, ev.version desc
      limit 1
    ) close_ev on v_to is not null and ep.first_work_date <= v_to
  ),
  opening_snapshot_agg as (
    select
      count(*) filter (where osr.open_status is not null and osr.open_status <> 'FUTURE')::int as eligible_episode_total,
      count(*) filter (where osr.open_status = 'ON')::int as on_count,
      count(*) filter (where osr.open_status = 'UNCONFIRMED')::int as unconfirmed_count,
      count(*) filter (where osr.open_status = 'OFF')::int as off_count,
      count(*) filter (where osr.open_status = 'UNKNOWN')::int as unknown_count,
      count(*) filter (where osr.open_status = 'FUTURE')::int as future_episode_count
    from opening_snapshot_rows osr
  ),
  closing_snapshot_agg as (
    select
      count(*) filter (where csr.close_status is not null and csr.close_status <> 'FUTURE')::int as eligible_episode_total,
      count(*) filter (where csr.close_status = 'ON')::int as on_count,
      count(*) filter (where csr.close_status = 'UNCONFIRMED')::int as unconfirmed_count,
      count(*) filter (where csr.close_status = 'OFF')::int as off_count,
      count(*) filter (where csr.close_status = 'UNKNOWN')::int as unknown_count,
      count(*) filter (where csr.close_status = 'FUTURE')::int as future_episode_count
    from closing_snapshot_rows csr
  ),
  balance_episode_base as (
    select
      ep.entry_id,
      ep.first_work_date,
      (ep.first_work_date >= v_from) as is_new_in_period,
      case
        when ep.first_work_date < v_from then null
        when pre_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then pre_ev.status
        when first_in_period_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then first_in_period_ev.status
        else 'UNKNOWN'
      end as new_entry_status,
      case
        when ep.first_work_date >= v_from
             and pre_ev.event_id is null
             and first_in_period_ev.event_id is not null then first_in_period_ev.event_id
        else null
      end as consumed_initial_event_id
    from scoped_episodes ep
    left join lateral (
      select ev.event_id, ev.status
      from active_events ev
      where ev.entry_id = ep.entry_id
        and ev.effective_date < v_from
      order by ev.effective_date desc, ev.version desc
      limit 1
    ) pre_ev on ep.first_work_date >= v_from
    left join lateral (
      select ev.event_id, ev.status
      from active_events ev
      where ev.entry_id = ep.entry_id
        and ev.effective_date >= v_from
        and ev.effective_date <= v_to
      order by ev.effective_date asc, ev.version asc
      limit 1
    ) first_in_period_ev on ep.first_work_date >= v_from
    where v_from is not null
      and v_to is not null
      and ep.first_work_date <= v_to
  ),
  balance_new_agg as (
    select
      count(*) filter (where b.is_new_in_period)::int as new_total_count,
      count(*) filter (where b.is_new_in_period and b.new_entry_status = 'ON')::int as new_on_count,
      count(*) filter (where b.is_new_in_period and b.new_entry_status = 'UNCONFIRMED')::int as new_unconfirmed_count,
      count(*) filter (where b.is_new_in_period and b.new_entry_status = 'OFF')::int as new_off_count,
      count(*) filter (where b.is_new_in_period and b.new_entry_status = 'UNKNOWN')::int as new_unknown_count
    from balance_episode_base b
  ),
  balance_transition_steps as (
    select
      ev.event_id,
      ev.entry_id,
      case
        when ev.prev_status in ('ON', 'UNCONFIRMED', 'OFF') then ev.prev_status
        else 'UNKNOWN'
      end as from_status,
      case
        when ev.status in ('ON', 'UNCONFIRMED', 'OFF') then ev.status
        else 'UNKNOWN'
      end as to_status
    from balance_episode_base b
    join active_events ev on ev.entry_id = b.entry_id
    where ev.effective_date >= v_from
      and ev.effective_date <= v_to
      and (b.consumed_initial_event_id is null or ev.event_id <> b.consumed_initial_event_id)
  ),
  balance_flows_agg as (
    select
      count(*) filter (where s.from_status <> 'ON' and s.to_status = 'ON')::int as on_trans_in,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status = 'ON')::int as on_in_from_unconfirmed,
      count(*) filter (where s.from_status = 'OFF' and s.to_status = 'ON')::int as on_in_from_off,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'ON')::int as on_in_from_unknown,
      count(*) filter (where s.from_status = 'ON' and s.to_status <> 'ON')::int as on_trans_out,
      count(*) filter (where s.from_status = 'ON' and s.to_status = 'OFF')::int as on_out_to_off,
      count(*) filter (where s.from_status = 'ON' and s.to_status = 'UNCONFIRMED')::int as on_out_to_unconfirmed,

      count(*) filter (where s.from_status <> 'UNCONFIRMED' and s.to_status = 'UNCONFIRMED')::int as unconfirmed_trans_in,
      count(*) filter (where s.from_status = 'ON' and s.to_status = 'UNCONFIRMED')::int as unconfirmed_in_from_on,
      count(*) filter (where s.from_status = 'OFF' and s.to_status = 'UNCONFIRMED')::int as unconfirmed_in_from_off,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'UNCONFIRMED')::int as unconfirmed_in_from_unknown,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status <> 'UNCONFIRMED')::int as unconfirmed_trans_out,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status = 'ON')::int as unconfirmed_out_to_on,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status = 'OFF')::int as unconfirmed_out_to_off,

      count(*) filter (where s.from_status <> 'OFF' and s.to_status = 'OFF')::int as off_trans_in,
      count(*) filter (where s.from_status = 'ON' and s.to_status = 'OFF')::int as off_in_from_on,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status = 'OFF')::int as off_in_from_unconfirmed,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'OFF')::int as off_in_from_unknown,
      count(*) filter (where s.from_status = 'OFF' and s.to_status <> 'OFF')::int as off_trans_out,
      count(*) filter (where s.from_status = 'OFF' and s.to_status = 'ON')::int as off_out_to_on,
      count(*) filter (where s.from_status = 'OFF' and s.to_status = 'UNCONFIRMED')::int as off_out_to_unconfirmed,

      count(*) filter (where s.from_status <> 'UNKNOWN' and s.to_status = 'UNKNOWN')::int as unknown_trans_in,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status <> 'UNKNOWN')::int as unknown_trans_out,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'ON')::int as unknown_out_to_on,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'UNCONFIRMED')::int as unknown_out_to_unconfirmed,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'OFF')::int as unknown_out_to_off
    from balance_transition_steps s
  ),
  -- WF-02 (2.4) & WF-03 (2.5, 2.6): Distinct state change chain up to v_as_of (collapsing no-op repeats)
  as_of_distinct_state_events as (
    select
      ev.event_id,
      ev.entry_id,
      ev.status,
      ev.effective_date,
      ev.version,
      ev.prev_status,
      lead(ev.effective_date) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as next_effective_date,
      lead(ev.status) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as next_status
    from active_events ev
    join scoped_episodes ep on ep.entry_id = ev.entry_id
    where ep.first_work_date <= v_as_of
      and ev.effective_date <= v_as_of
      and (ev.prev_status is null or ev.prev_status <> ev.status)
  ),
  as_of_waiting_intervals as (
    select
      dse.entry_id,
      dse.event_id,
      dse.effective_date as start_date,
      coalesce(dse.next_effective_date, v_as_of) as end_date,
      (dse.next_effective_date is not null) as is_completed,
      dse.next_status,
      greatest(0, (coalesce(dse.next_effective_date, v_as_of) - dse.effective_date)::int) as waiting_days
    from as_of_distinct_state_events dse
    where dse.status = 'UNCONFIRMED'
  ),
  as_of_waiting_episodes as (
    select
      wi.entry_id,
      sr.as_of_status,
      count(*)::int as interval_count,
      sum(wi.waiting_days)::int as total_waiting_days,
      bool_or(wi.is_completed and wi.next_status = 'ON') as placed_to_on
    from as_of_waiting_intervals wi
    join snapshot_rows sr on sr.entry_id = wi.entry_id
    group by wi.entry_id, sr.as_of_status
  ),
  as_of_episode_entry_mode as (
    select
      sr.entry_id,
      sr.as_of_status,
      first_ev.status as initial_status,
      exists (
        select 1
        from as_of_waiting_episodes we
        where we.entry_id = sr.entry_id
      ) as had_waiting
    from snapshot_rows sr
    left join lateral (
      select dse.status
      from as_of_distinct_state_events dse
      where dse.entry_id = sr.entry_id
      order by dse.effective_date asc, dse.version asc
      limit 1
    ) first_ev on true
    where sr.as_of_status <> 'FUTURE'
  ),
  as_of_entry_mode_agg as (
    select
      count(*) filter (where em.had_waiting)::int as waiting_episode_total,
      count(*) filter (where not em.had_waiting and em.initial_status = 'ON')::int as direct_on_episode_count,
      count(*) filter (where not em.had_waiting and em.initial_status = 'OFF')::int as direct_off_episode_count,
      count(*) filter (where not em.had_waiting and em.as_of_status = 'UNKNOWN')::int as unknown_episode_count
    from as_of_episode_entry_mode em
  ),
  as_of_waiting_samples_agg as (
    select
      count(*)::int as all_ep_count,
      coalesce(sum(we.interval_count), 0)::int as all_interval_count,
      coalesce(sum(we.total_waiting_days), 0)::int as all_waiting_days,
      max(we.total_waiting_days)::int as all_max_waiting_days,

      count(*) filter (where we.as_of_status <> 'UNCONFIRMED')::int as completed_ep_count,
      coalesce(sum(we.interval_count) filter (where we.as_of_status <> 'UNCONFIRMED'), 0)::int as completed_interval_count,
      coalesce(sum(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED'), 0)::int as completed_waiting_days,
      max(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED')::int as completed_max_waiting_days,

      count(*) filter (where we.as_of_status <> 'UNCONFIRMED' and we.placed_to_on)::int as placed_ep_count,
      coalesce(sum(we.interval_count) filter (where we.as_of_status <> 'UNCONFIRMED' and we.placed_to_on), 0)::int as placed_interval_count,
      coalesce(sum(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED' and we.placed_to_on), 0)::int as placed_waiting_days,
      max(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED' and we.placed_to_on)::int as placed_max_waiting_days,

      count(*) filter (where we.as_of_status <> 'UNCONFIRMED' and not we.placed_to_on)::int as exited_ep_count,
      coalesce(sum(we.interval_count) filter (where we.as_of_status <> 'UNCONFIRMED' and not we.placed_to_on), 0)::int as exited_interval_count,
      coalesce(sum(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED' and not we.placed_to_on), 0)::int as exited_waiting_days,
      max(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED' and not we.placed_to_on)::int as exited_max_waiting_days,

      count(*) filter (where we.as_of_status = 'UNCONFIRMED')::int as current_ep_count,
      coalesce(sum(we.interval_count) filter (where we.as_of_status = 'UNCONFIRMED'), 0)::int as current_interval_count,
      coalesce(sum(we.total_waiting_days) filter (where we.as_of_status = 'UNCONFIRMED'), 0)::int as current_waiting_days,
      max(we.total_waiting_days) filter (where we.as_of_status = 'UNCONFIRMED')::int as current_max_waiting_days
    from as_of_waiting_episodes we
  ),
  period_distinct_state_events as (
    select
      ev.event_id,
      ev.entry_id,
      ev.status,
      ev.effective_date,
      ev.version,
      lead(ev.effective_date) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as next_effective_date,
      lead(ev.status) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as next_status
    from active_events ev
    join scoped_episodes ep on ep.entry_id = ev.entry_id
    where v_from is not null
      and v_to is not null
      and ep.first_work_date <= v_to
      and ev.effective_date <= v_to
      and (ev.prev_status is null or ev.prev_status <> ev.status)
  ),
  period_waiting_intervals as (
    select
      pdse.entry_id,
      pdse.effective_date as start_date,
      coalesce(pdse.next_effective_date, v_to) as end_date,
      pdse.next_effective_date,
      pdse.next_status,
      greatest(0, (coalesce(pdse.next_effective_date, v_to) - pdse.effective_date)::int) as full_interval_waiting_days,
      greatest(
        0,
        (least(coalesce(pdse.next_effective_date, v_to), v_to) - greatest(pdse.effective_date, v_from))::int
      ) as clipped_period_waiting_days,
      (pdse.effective_date <= v_to and coalesce(pdse.next_effective_date, v_to) >= v_from) as overlaps_period,
      (
        pdse.next_effective_date is not null
        and pdse.next_effective_date >= v_from
        and pdse.next_effective_date <= v_to
        and pdse.next_status = 'ON'
      ) as placed_in_period,
      (
        pdse.next_effective_date is not null
        and pdse.next_effective_date >= v_from
        and pdse.next_effective_date <= v_to
        and pdse.next_status = 'OFF'
      ) as exited_in_period
    from period_distinct_state_events pdse
    where pdse.status = 'UNCONFIRMED'
  ),
  period_waiting_agg as (
    select
      count(distinct pwi.entry_id) filter (where pwi.overlaps_period)::int as active_waiting_episode_count,
      coalesce(sum(pwi.clipped_period_waiting_days) filter (where pwi.overlaps_period), 0)::int as in_period_waiting_days,
      count(*) filter (where pwi.placed_in_period)::int as placed_event_count,
      count(distinct pwi.entry_id) filter (where pwi.placed_in_period)::int as placed_episode_count,
      coalesce(sum(pwi.full_interval_waiting_days) filter (where pwi.placed_in_period), 0)::int as placed_total_waiting_days,
      count(*) filter (where pwi.exited_in_period)::int as exited_event_count,
      count(distinct pwi.entry_id) filter (where pwi.exited_in_period)::int as exited_episode_count,
      coalesce(sum(pwi.full_interval_waiting_days) filter (where pwi.exited_in_period), 0)::int as exited_total_waiting_days
    from period_waiting_intervals pwi
  ),
  -- WF-03 (2.5): Active ON tenure / duration intervals and in-period status presence days
  -- Closed ON intervals use half-open [start_date, next_effective_date);
  -- Active ON intervals at v_as_of use half-open [start_date, v_as_of + 1).
  as_of_on_intervals as (
    select
      dse.entry_id,
      dse.event_id,
      dse.effective_date as start_date,
      coalesce(dse.next_effective_date, (v_as_of + 1)) as end_exclusive_date,
      greatest(0, (coalesce(dse.next_effective_date, (v_as_of + 1)) - dse.effective_date)::int) as on_days
    from as_of_distinct_state_events dse
    where dse.status = 'ON'
  ),
  as_of_on_episodes as (
    select
      oi.entry_id,
      sr.as_of_status,
      count(*)::int as interval_count,
      sum(oi.on_days)::int as total_on_days
    from as_of_on_intervals oi
    join snapshot_rows sr on sr.entry_id = oi.entry_id
    group by oi.entry_id, sr.as_of_status
  ),
  as_of_duration_agg as (
    select
      count(*)::int as all_ep_count,
      coalesce(sum(oe.interval_count), 0)::int as all_interval_count,
      coalesce(sum(oe.total_on_days), 0)::int as all_on_days,
      max(oe.total_on_days)::int as all_max_on_days,

      count(*) filter (where oe.as_of_status = 'ON')::int as current_ep_count,
      coalesce(sum(oe.interval_count) filter (where oe.as_of_status = 'ON'), 0)::int as current_interval_count,
      coalesce(sum(oe.total_on_days) filter (where oe.as_of_status = 'ON'), 0)::int as current_on_days,
      max(oe.total_on_days) filter (where oe.as_of_status = 'ON')::int as current_max_on_days,

      count(*) filter (where oe.as_of_status <> 'ON')::int as exited_ep_count,
      coalesce(sum(oe.interval_count) filter (where oe.as_of_status <> 'ON'), 0)::int as exited_interval_count,
      coalesce(sum(oe.total_on_days) filter (where oe.as_of_status <> 'ON'), 0)::int as exited_on_days,
      max(oe.total_on_days) filter (where oe.as_of_status <> 'ON')::int as exited_max_on_days,

      count(*) filter (where oe.total_on_days <= 7)::int as days_0_to_7_count,
      count(*) filter (where oe.total_on_days >= 8 and oe.total_on_days <= 30)::int as days_8_to_30_count,
      count(*) filter (where oe.total_on_days >= 31 and oe.total_on_days <= 90)::int as days_31_to_90_count,
      count(*) filter (where oe.total_on_days >= 91)::int as days_91_plus_count
    from as_of_on_episodes oe
  ),
  -- Period presence window uses half-open [v_from, v_to + 1) intersected with [start_date, end_exclusive_date).
  -- Only intervals with strictly positive overlap (> 0 days) count as present in the period.
  period_on_intervals as (
    select
      pdse.entry_id,
      pdse.effective_date as start_date,
      coalesce(pdse.next_effective_date, (v_to + 1)) as end_exclusive_date,
      greatest(
        0,
        (least(coalesce(pdse.next_effective_date, (v_to + 1)), (v_to + 1)) - greatest(pdse.effective_date, v_from))::int
      ) as clipped_period_on_days,
      (
        least(coalesce(pdse.next_effective_date, (v_to + 1)), (v_to + 1))
        > greatest(pdse.effective_date, v_from)
      ) as overlaps_period
    from period_distinct_state_events pdse
    where pdse.status = 'ON'
  ),
  period_presence_agg as (
    select
      count(distinct poi.entry_id) filter (where poi.overlaps_period)::int as active_on_episode_count,
      coalesce(sum(poi.clipped_period_on_days) filter (where poi.overlaps_period), 0)::int as in_period_on_days
    from period_on_intervals poi
  ),
  -- WF-03 (2.6): Early attrition and continuous D7 / D30 / D90 cohort retention from first ON effective_date
  cohort_episodes as (
    select distinct on (dse.entry_id)
      dse.entry_id,
      dse.effective_date as cohort_start_date,
      dse.next_effective_date as first_exit_date,
      (dse.effective_date + 7) as d7_date,
      (dse.effective_date + 30) as d30_date,
      (dse.effective_date + 90) as d90_date
    from as_of_distinct_state_events dse
    where dse.status = 'ON'
    order by dse.entry_id, dse.effective_date asc, dse.version asc
  ),
  retention_agg as (
    select
      count(*)::int as cohort_episode_total,
      count(*) filter (where ce.first_exit_date is null)::int as continuously_retained_count,
      count(*) filter (where ce.first_exit_date is not null)::int as exited_from_on_total,

      count(*) filter (where ce.d7_date <= v_as_of)::int as d7_matured_count,
      count(*) filter (where ce.d7_date > v_as_of)::int as d7_immature_count,
      count(*) filter (
        where ce.d7_date <= v_as_of
          and (ce.first_exit_date is null or ce.first_exit_date > ce.d7_date)
      )::int as d7_retained_count,
      count(*) filter (
        where ce.d7_date <= v_as_of
          and ce.first_exit_date is not null
          and ce.first_exit_date <= ce.d7_date
      )::int as d7_exited_count,

      count(*) filter (where ce.d30_date <= v_as_of)::int as d30_matured_count,
      count(*) filter (where ce.d30_date > v_as_of)::int as d30_immature_count,
      count(*) filter (
        where ce.d30_date <= v_as_of
          and (ce.first_exit_date is null or ce.first_exit_date > ce.d30_date)
      )::int as d30_retained_count,
      count(*) filter (
        where ce.d30_date <= v_as_of
          and ce.first_exit_date is not null
          and ce.first_exit_date <= ce.d30_date
      )::int as d30_exited_count,

      count(*) filter (where ce.d90_date <= v_as_of)::int as d90_matured_count,
      count(*) filter (where ce.d90_date > v_as_of)::int as d90_immature_count,
      count(*) filter (
        where ce.d90_date <= v_as_of
          and (ce.first_exit_date is null or ce.first_exit_date > ce.d90_date)
      )::int as d90_retained_count,
      count(*) filter (
        where ce.d90_date <= v_as_of
          and ce.first_exit_date is not null
          and ce.first_exit_date <= ce.d90_date
      )::int as d90_exited_count
    from cohort_episodes ce
  ),
  period_cohort_episodes as (
    select distinct on (pdse.entry_id)
      pdse.entry_id,
      pdse.effective_date as cohort_start_date,
      pdse.next_effective_date as first_exit_by_to_date
    from period_distinct_state_events pdse
    where pdse.status = 'ON'
    order by pdse.entry_id, pdse.effective_date asc, pdse.version asc
  ),
  period_cohort_agg as (
    select
      count(*) filter (where pce.cohort_start_date >= v_from and pce.cohort_start_date <= v_to)::int as entered_on_count,
      count(*) filter (
        where pce.cohort_start_date >= v_from
          and pce.cohort_start_date <= v_to
          and pce.first_exit_by_to_date is null
      )::int as retained_at_to_count,
      count(*) filter (
        where pce.cohort_start_date >= v_from
          and pce.cohort_start_date <= v_to
          and pce.first_exit_by_to_date is not null
      )::int as exited_by_to_count
    from period_cohort_episodes pce
  )
  select jsonb_build_object(
    'audience', v_audience,
    'snapshot', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'eligible_episode_total', sa.eligible_episode_total,
      'on_count', sa.on_count,
      'unconfirmed_count', sa.unconfirmed_count,
      'off_count', sa.off_count,
      'unknown_count', sa.unknown_count,
      'future_episode_count', sa.future_episode_count
    ),
    'transitions', case
      when v_from is not null and v_to is not null then
        jsonb_build_object(
          'applicable', true,
          'reason', null,
          'from_date', to_char(v_from, 'YYYY-MM-DD'),
          'to_date', to_char(v_to, 'YYYY-MM-DD'),
          'initial', jsonb_build_object(
            'total', jsonb_build_object('event_count', ta.initial_total_event_count, 'episode_count', ta.initial_total_episode_count),
            'on', jsonb_build_object('event_count', ta.initial_on_event_count, 'episode_count', ta.initial_on_episode_count),
            'unconfirmed', jsonb_build_object('event_count', ta.initial_unconfirmed_event_count, 'episode_count', ta.initial_unconfirmed_episode_count)
          ),
          'pairs', jsonb_build_object(
            'unconfirmed_to_on', jsonb_build_object('event_count', ta.unconfirmed_to_on_event_count, 'episode_count', ta.unconfirmed_to_on_episode_count),
            'unconfirmed_to_off', jsonb_build_object('event_count', ta.unconfirmed_to_off_event_count, 'episode_count', ta.unconfirmed_to_off_episode_count),
            'on_to_off', jsonb_build_object('event_count', ta.on_to_off_event_count, 'episode_count', ta.on_to_off_episode_count),
            'off_to_on', jsonb_build_object('event_count', ta.off_to_on_event_count, 'episode_count', ta.off_to_on_episode_count),
            'other', jsonb_build_object('event_count', ta.other_transition_event_count, 'episode_count', ta.other_transition_episode_count)
          ),
          'totals', jsonb_build_object(
            'transition_event_count', ta.total_transition_event_count,
            'transition_episode_count', ta.total_transition_episode_count,
            'noop_repeat_event_count', ta.noop_repeat_event_count,
            'noop_repeat_episode_count', ta.noop_repeat_episode_count
          )
        )
      else
        jsonb_build_object(
          'applicable', false,
          'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
          'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
          'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
        )
    end,
    'balance', case
      when v_from is not null and v_to is not null then
        jsonb_build_object(
          'applicable', true,
          'reason', null,
          'from_date', to_char(v_from, 'YYYY-MM-DD'),
          'to_date', to_char(v_to, 'YYYY-MM-DD'),
          'opening_as_of_date', to_char(v_open_as_of, 'YYYY-MM-DD'),
          'closing_as_of_date', to_char(v_to, 'YYYY-MM-DD'),
          'opening_snapshot', jsonb_build_object(
            'as_of_date', to_char(v_open_as_of, 'YYYY-MM-DD'),
            'as_of_source', 'explicit_as_of',
            'eligible_episode_total', osa.eligible_episode_total,
            'on_count', osa.on_count,
            'unconfirmed_count', osa.unconfirmed_count,
            'off_count', osa.off_count,
            'unknown_count', osa.unknown_count,
            'future_episode_count', osa.future_episode_count
          ),
          'closing_snapshot', jsonb_build_object(
            'as_of_date', to_char(v_to, 'YYYY-MM-DD'),
            'as_of_source', 'filter_to',
            'eligible_episode_total', csa.eligible_episode_total,
            'on_count', csa.on_count,
            'unconfirmed_count', csa.unconfirmed_count,
            'off_count', csa.off_count,
            'unknown_count', csa.unknown_count,
            'future_episode_count', csa.future_episode_count
          ),
          'new_episodes_in_period', jsonb_build_object(
            'total', bna.new_total_count,
            'initial_on', bna.new_on_count,
            'initial_unconfirmed', bna.new_unconfirmed_count,
            'initial_off', bna.new_off_count,
            'initial_unknown', bna.new_unknown_count
          ),
          'by_status', jsonb_build_object(
            'on', jsonb_build_object(
              'opening_count', osa.on_count,
              'new_episode_inflow_count', bna.new_on_count,
              'transition_inflow_count', bfa.on_trans_in,
              'transition_inflow_by_source', jsonb_build_object(
                'from_on', 0,
                'from_unconfirmed', bfa.on_in_from_unconfirmed,
                'from_off', bfa.on_in_from_off,
                'from_unknown', bfa.on_in_from_unknown
              ),
              'total_inflow_count', bna.new_on_count + bfa.on_trans_in,
              'outflow_count', bfa.on_trans_out,
              'outflow_by_target', jsonb_build_object(
                'to_on', 0,
                'to_unconfirmed', bfa.on_out_to_unconfirmed,
                'to_off', bfa.on_out_to_off
              ),
              'net_change', (bna.new_on_count + bfa.on_trans_in) - bfa.on_trans_out,
              'closing_count', csa.on_count
            ),
            'unconfirmed', jsonb_build_object(
              'opening_count', osa.unconfirmed_count,
              'new_episode_inflow_count', bna.new_unconfirmed_count,
              'transition_inflow_count', bfa.unconfirmed_trans_in,
              'transition_inflow_by_source', jsonb_build_object(
                'from_on', bfa.unconfirmed_in_from_on,
                'from_unconfirmed', 0,
                'from_off', bfa.unconfirmed_in_from_off,
                'from_unknown', bfa.unconfirmed_in_from_unknown
              ),
              'total_inflow_count', bna.new_unconfirmed_count + bfa.unconfirmed_trans_in,
              'outflow_count', bfa.unconfirmed_trans_out,
              'outflow_by_target', jsonb_build_object(
                'to_on', bfa.unconfirmed_out_to_on,
                'to_unconfirmed', 0,
                'to_off', bfa.unconfirmed_out_to_off
              ),
              'net_change', (bna.new_unconfirmed_count + bfa.unconfirmed_trans_in) - bfa.unconfirmed_trans_out,
              'closing_count', csa.unconfirmed_count
            ),
            'off', jsonb_build_object(
              'opening_count', osa.off_count,
              'new_episode_inflow_count', bna.new_off_count,
              'transition_inflow_count', bfa.off_trans_in,
              'transition_inflow_by_source', jsonb_build_object(
                'from_on', bfa.off_in_from_on,
                'from_unconfirmed', bfa.off_in_from_unconfirmed,
                'from_off', 0,
                'from_unknown', bfa.off_in_from_unknown
              ),
              'total_inflow_count', bna.new_off_count + bfa.off_trans_in,
              'outflow_count', bfa.off_trans_out,
              'outflow_by_target', jsonb_build_object(
                'to_on', bfa.off_out_to_on,
                'to_unconfirmed', bfa.off_out_to_unconfirmed,
                'to_off', 0
              ),
              'net_change', (bna.new_off_count + bfa.off_trans_in) - bfa.off_trans_out,
              'closing_count', csa.off_count
            ),
            'unknown', jsonb_build_object(
              'opening_count', osa.unknown_count,
              'new_episode_inflow_count', bna.new_unknown_count,
              'transition_inflow_count', bfa.unknown_trans_in,
              'transition_inflow_by_source', jsonb_build_object(
                'from_on', 0,
                'from_unconfirmed', 0,
                'from_off', 0,
                'from_unknown', 0
              ),
              'total_inflow_count', bna.new_unknown_count + bfa.unknown_trans_in,
              'outflow_count', bfa.unknown_trans_out,
              'outflow_by_target', jsonb_build_object(
                'to_on', bfa.unknown_out_to_on,
                'to_unconfirmed', bfa.unknown_out_to_unconfirmed,
                'to_off', bfa.unknown_out_to_off
              ),
              'net_change', (bna.new_unknown_count + bfa.unknown_trans_in) - bfa.unknown_trans_out,
              'closing_count', csa.unknown_count
            )
          ),
          'totals', jsonb_build_object(
            'opening_eligible_total', osa.eligible_episode_total,
            'new_episode_total', bna.new_total_count,
            'transition_inflow_total', bfa.on_trans_in + bfa.unconfirmed_trans_in + bfa.off_trans_in + bfa.unknown_trans_in,
            'transition_outflow_total', bfa.on_trans_out + bfa.unconfirmed_trans_out + bfa.off_trans_out + bfa.unknown_trans_out,
            'net_eligible_change', bna.new_total_count,
            'closing_eligible_total', csa.eligible_episode_total
          )
        )
      else
        jsonb_build_object(
          'applicable', false,
          'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
          'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
          'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
        )
    end,
    'waiting', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'eligible_episode_total', sa.eligible_episode_total,
      'waiting_episode_total', ema.waiting_episode_total,
      'direct_on_episode_count', ema.direct_on_episode_count,
      'direct_off_episode_count', ema.direct_off_episode_count,
      'unknown_episode_count', ema.unknown_episode_count,
      'all_waiting', jsonb_build_object(
        'episode_count', wsa.all_ep_count,
        'interval_count', wsa.all_interval_count,
        'total_waiting_days', wsa.all_waiting_days,
        'max_waiting_days', wsa.all_max_waiting_days
      ),
      'completed_waiting', jsonb_build_object(
        'episode_count', wsa.completed_ep_count,
        'interval_count', wsa.completed_interval_count,
        'total_waiting_days', wsa.completed_waiting_days,
        'max_waiting_days', wsa.completed_max_waiting_days
      ),
      'placed_to_on', jsonb_build_object(
        'episode_count', wsa.placed_ep_count,
        'interval_count', wsa.placed_interval_count,
        'total_waiting_days', wsa.placed_waiting_days,
        'max_waiting_days', wsa.placed_max_waiting_days
      ),
      'exited_without_on', jsonb_build_object(
        'episode_count', wsa.exited_ep_count,
        'interval_count', wsa.exited_interval_count,
        'total_waiting_days', wsa.exited_waiting_days,
        'max_waiting_days', wsa.exited_max_waiting_days
      ),
      'currently_waiting', jsonb_build_object(
        'episode_count', wsa.current_ep_count,
        'interval_count', wsa.current_interval_count,
        'total_waiting_days', wsa.current_waiting_days,
        'max_waiting_days', wsa.current_max_waiting_days
      ),
      'period_waiting', case
        when v_from is not null and v_to is not null then
          jsonb_build_object(
            'applicable', true,
            'reason', null,
            'from_date', to_char(v_from, 'YYYY-MM-DD'),
            'to_date', to_char(v_to, 'YYYY-MM-DD'),
            'active_waiting_episode_count', pwa.active_waiting_episode_count,
            'in_period_waiting_days', pwa.in_period_waiting_days,
            'placed_in_period', jsonb_build_object(
              'event_count', pwa.placed_event_count,
              'episode_count', pwa.placed_episode_count,
              'total_waiting_days', pwa.placed_total_waiting_days
            ),
            'exited_in_period', jsonb_build_object(
              'event_count', pwa.exited_event_count,
              'episode_count', pwa.exited_episode_count,
              'total_waiting_days', pwa.exited_total_waiting_days
            )
          )
        else
          jsonb_build_object(
            'applicable', false,
            'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
            'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
            'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
          )
      end
    ),
    'duration', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'eligible_episode_total', sa.eligible_episode_total,
      'known_status_episode_count', (sa.eligible_episode_total - sa.unknown_count),
      'unknown_status_episode_count', sa.unknown_count,
      'ever_on_episode_count', da.all_ep_count,
      'never_on_episode_count', greatest(0, (sa.eligible_episode_total - sa.unknown_count) - da.all_ep_count),
      'all_ever_on', jsonb_build_object(
        'episode_count', da.all_ep_count,
        'interval_count', da.all_interval_count,
        'total_on_days', da.all_on_days,
        'max_on_days', da.all_max_on_days
      ),
      'currently_on', jsonb_build_object(
        'episode_count', da.current_ep_count,
        'interval_count', da.current_interval_count,
        'total_on_days', da.current_on_days,
        'max_on_days', da.current_max_on_days
      ),
      'exited_after_on', jsonb_build_object(
        'episode_count', da.exited_ep_count,
        'interval_count', da.exited_interval_count,
        'total_on_days', da.exited_on_days,
        'max_on_days', da.exited_max_on_days
      ),
      'distribution', jsonb_build_object(
        'days_0_to_7_count', da.days_0_to_7_count,
        'days_8_to_30_count', da.days_8_to_30_count,
        'days_31_to_90_count', da.days_31_to_90_count,
        'days_91_plus_count', da.days_91_plus_count
      ),
      'period_presence', case
        when v_from is not null and v_to is not null then
          jsonb_build_object(
            'applicable', true,
            'reason', null,
            'from_date', to_char(v_from, 'YYYY-MM-DD'),
            'to_date', to_char(v_to, 'YYYY-MM-DD'),
            'active_on_episode_count', ppa.active_on_episode_count,
            'in_period_on_days', ppa.in_period_on_days
          )
        else
          jsonb_build_object(
            'applicable', false,
            'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
            'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
            'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
          )
      end
    ),
    'retention', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'eligible_episode_total', sa.eligible_episode_total,
      'cohort_episode_total', ra.cohort_episode_total,
      'never_entered_on_count', greatest(0, (sa.eligible_episode_total - sa.unknown_count) - ra.cohort_episode_total),
      'unknown_status_episode_count', sa.unknown_count,
      'continuously_retained_count', ra.continuously_retained_count,
      'exited_from_on_total', ra.exited_from_on_total,
      'checkpoints', jsonb_build_object(
        'd7', jsonb_build_object(
          'checkpoint_days', 7,
          'matured_count', ra.d7_matured_count,
          'immature_count', ra.d7_immature_count,
          'retained_count', ra.d7_retained_count,
          'exited_count', ra.d7_exited_count
        ),
        'd30', jsonb_build_object(
          'checkpoint_days', 30,
          'matured_count', ra.d30_matured_count,
          'immature_count', ra.d30_immature_count,
          'retained_count', ra.d30_retained_count,
          'exited_count', ra.d30_exited_count
        ),
        'd90', jsonb_build_object(
          'checkpoint_days', 90,
          'matured_count', ra.d90_matured_count,
          'immature_count', ra.d90_immature_count,
          'retained_count', ra.d90_retained_count,
          'exited_count', ra.d90_exited_count
        )
      ),
      'period_cohort', case
        when v_from is not null and v_to is not null then
          jsonb_build_object(
            'applicable', true,
            'reason', null,
            'from_date', to_char(v_from, 'YYYY-MM-DD'),
            'to_date', to_char(v_to, 'YYYY-MM-DD'),
            'entered_on_count', pca.entered_on_count,
            'retained_at_to_count', pca.retained_at_to_count,
            'exited_by_to_count', pca.exited_by_to_count
          )
        else
          jsonb_build_object(
            'applicable', false,
            'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
            'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
            'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
          )
      end
    )
  )
  into v_result
  from snapshot_agg sa
  cross join transitions_agg ta
  cross join opening_snapshot_agg osa
  cross join closing_snapshot_agg csa
  cross join balance_new_agg bna
  cross join balance_flows_agg bfa
  cross join as_of_entry_mode_agg ema
  cross join as_of_waiting_samples_agg wsa
  cross join period_waiting_agg pwa
  cross join as_of_duration_agg da
  cross join period_presence_agg ppa
  cross join retention_agg ra
  cross join period_cohort_agg pca;

  return v_result;
end;
$function$;

comment on function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb) is
  'WF-01, WF-02 & WF-03 (MBI-DA-2026-01): Actor-scoped business-effective workforce snapshot as-of (2.1), period status transitions (2.2), opening/closing balance reconciliation (2.3), UNCONFIRMED waiting duration & placement metrics (2.4), active ON tenure & in-period status presence days (2.5), and D7/D30/D90 cohort retention & early attrition (2.6) on non-superseded direct_entry_employment_status_events.';

do $align_wf03_rpc_owner$
declare
  v_table_owner_oid oid;
  v_table_owner name;
  v_facts_rpc_owner name;
  v_proc_owner_oid oid;
  v_proc_owner name;
begin
  select c.relowner, r.rolname
    into v_table_owner_oid, v_table_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_employment_status_events'::pg_catalog.regclass;

  select r.rolname
    into v_facts_rpc_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = 'public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)'::pg_catalog.regprocedure;

  if v_table_owner is null or v_facts_rpc_owner is null or v_table_owner <> v_facts_rpc_owner then
    raise exception 'WF-03 expected owner mismatch between status events table and reporting facts RPC'
      using errcode = '55000';
  end if;

  select p.proowner, r.rolname
    into v_proc_owner_oid, v_proc_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = 'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)'::pg_catalog.regprocedure;

  if v_proc_owner_oid is distinct from v_table_owner_oid
     and pg_catalog.pg_has_role(current_user, v_table_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb) owner to %I',
      v_table_owner
    );
    v_proc_owner_oid := v_table_owner_oid;
    v_proc_owner := v_table_owner;
  end if;

  if v_proc_owner_oid is distinct from v_table_owner_oid then
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reporting_resolve_audience(uuid, uuid) to %I',
      v_proc_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reporting_authorized_entries(uuid, uuid) to %I',
      v_proc_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_authorization_date() to %I',
      v_proc_owner
    );
  end if;
end;
$align_wf03_rpc_owner$;

revoke all on function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)
  to service_role;

do $assert_wf03_rpc_boundary$
declare
  v_proc constant pg_catalog.regprocedure :=
    'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)'::pg_catalog.regprocedure;
  v_status_table constant pg_catalog.regclass :=
    'public.direct_entry_employment_status_events'::pg_catalog.regclass;
  v_table_owner oid;
  v_proc_owner oid;
  v_prosecdef boolean;
  v_proconfig text[];
  v_owner_can_bypass_rls boolean;
  v_status_rls_forced boolean;
  v_status_policy_count integer;
  v_public_exec boolean;
begin
  select c.relowner,
         (c.relrowsecurity and c.relforcerowsecurity),
         (select count(*)::integer from pg_catalog.pg_policy pol where pol.polrelid = c.oid)
    into v_table_owner, v_status_rls_forced, v_status_policy_count
    from pg_catalog.pg_class c
   where c.oid = v_status_table;

  select p.proowner,
         p.prosecdef,
         coalesce(p.proconfig, array[]::text[]),
         (r.rolsuper or r.rolbypassrls),
         exists (
           select 1
             from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
            where a.grantee = 0
              and a.privilege_type = 'EXECUTE'
         )
    into v_proc_owner, v_prosecdef, v_proconfig, v_owner_can_bypass_rls, v_public_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = v_proc;

  if v_proc_owner is null
     or not pg_catalog.pg_has_role(v_proc_owner, v_table_owner, 'USAGE')
     or not coalesce(v_prosecdef, false)
     or not (v_proconfig @> array['search_path=pg_catalog, public'])
     or not coalesce(v_status_rls_forced, false)
     or coalesce(v_status_policy_count, -1) <> 0
     or not coalesce(v_owner_can_bypass_rls, false)
     or pg_catalog.has_table_privilege('anon', v_status_table, 'SELECT')
     or pg_catalog.has_table_privilege('authenticated', v_status_table, 'SELECT')
     or pg_catalog.has_table_privilege('service_role', v_status_table, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, v_status_table, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, 'public.direct_entries'::pg_catalog.regclass, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, 'public.direct_entry_submissions'::pg_catalog.regclass, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, 'public.direct_entry_reporting_facts_v01'::pg_catalog.regclass, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, 'public.teams'::pg_catalog.regclass, 'SELECT')
     or not pg_catalog.has_function_privilege(v_proc_owner, 'public.direct_entry_reporting_resolve_audience(uuid, uuid)'::pg_catalog.regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege(v_proc_owner, 'public.direct_entry_reporting_authorized_entries(uuid, uuid)'::pg_catalog.regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege(v_proc_owner, 'public.direct_entry_authorization_date()'::pg_catalog.regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege(v_proc_owner, v_proc, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_proc, 'EXECUTE')
     or coalesce(v_public_exec, true)
     or pg_catalog.has_function_privilege('public', v_proc, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_proc, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_proc, 'EXECUTE') then
    raise exception 'WF-03 RPC security definer owner/RLS/ACL boundary drift'
      using errcode = '55000';
  end if;
end;
$assert_wf03_rpc_boundary$;

commit;
