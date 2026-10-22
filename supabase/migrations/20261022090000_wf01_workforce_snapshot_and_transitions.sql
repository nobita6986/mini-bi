-- MBI-DA-2026-01 Chặng 2 / WF-01: Workforce snapshot as-of and period status transitions.
-- Business-effective as-of evaluation (effective_date <= as_of on non-superseded events),
-- distinct from audit time-travel by applied_at.
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
    end
  )
  into v_result
  from snapshot_agg sa
  cross join transitions_agg ta;

  return v_result;
end;
$function$;

comment on function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb) is
  'WF-01 (MBI-DA-2026-01): Actor-scoped business-effective workforce snapshot as-of and period status transitions on non-superseded direct_entry_employment_status_events.';

do $align_wf01_rpc_owner$
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
    raise exception 'WF-01 expected owner mismatch between status events table and reporting facts RPC'
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
$align_wf01_rpc_owner$;

revoke all on function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)
  to service_role;

do $assert_wf01_rpc_boundary$
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
    raise exception 'WF-01 RPC security definer owner/RLS/ACL boundary drift'
      using errcode = '55000';
  end if;
end;
$assert_wf01_rpc_boundary$;

commit;
