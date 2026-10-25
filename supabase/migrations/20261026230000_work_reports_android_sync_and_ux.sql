-- Work Reports Android Sync & Management UX Alignment:
--   1. Auto-materialize current-period obligations on assignment creation / reactivation
--      when effective on the current Asia/Ho_Chi_Minh business date (`USER`, `TEAM`, `USER_SET`, `GROUP`).
--   2. Per-actor bounded auto-materialization (default 7-day lookback window in Asia/Ho_Chi_Minh)
--      when an authenticated user loads `work_report_list_my_obligations`, idempotent under concurrency.
--   3. Backward-compatible server-computed `is_overdue` boolean on `work_report_list_my_obligations`
--      and `work_report_get_submission` (preserving `REJECTED` and `reopened_until` semantics).
--   4. Enriched `work_report_list_assignments` projection with deadline metadata, overdue/rejected counts,
--      per-person progress (`assignee_progress`), and append-only state audit history (`audit_history`).

begin;

-- -----------------------------------------------------------------------------
-- 1. Supporting indexes for per-actor obligation materialization & assignment tracking.
-- -----------------------------------------------------------------------------
create index if not exists work_report_assignment_targets_user_assignment_idx
  on public.work_report_assignment_targets (target_user_id, assignment_id);

create index if not exists work_report_assignments_active_effective_idx
  on public.work_report_assignments (state, effective_from, effective_to)
  where is_current;

create index if not exists work_report_assignments_target_user_idx
  on public.work_report_assignments (target_user_id)
  where is_current and target_user_id is not null;

create index if not exists work_report_assignments_target_team_idx
  on public.work_report_assignments (target_team_id)
  where is_current and target_team_id is not null;

create index if not exists work_report_audit_events_assignment_lookup_idx
  on public.work_report_audit_events (template_id, action, created_at desc)
  where action in ('ASSIGNMENT_CREATE', 'ASSIGNMENT_STATE');

-- -----------------------------------------------------------------------------
-- 2. Internal helpers for scoped obligation materialization (never exposed to runtime roles).
-- -----------------------------------------------------------------------------
create or replace function public.work_report__internal_materialize_assignment_for_date(
  p_assignment_id uuid,
  p_business_date date
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_inserted integer := 0;
begin
  if p_assignment_id is null or p_business_date is null then
    return 0;
  end if;

  with candidate as (
    select a.*,
           u.app_user_id as assignee_id,
           public.work_report_current_team(u.app_user_id) as team_id,
           u.snapshot_group_id,
           u.snapshot_group_name
      from public.work_report_assignments a
      join public.work_report_templates tpl
        on tpl.template_id = a.template_id
       and tpl.status = 'ACTIVE'
      cross join lateral (
        select a.target_user_id as app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
         where a.target_kind = 'USER'
        union all
        select x.target_user_id as app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
          from public.work_report_assignment_targets x
         where a.target_kind = 'USER_SET'
           and x.assignment_id = a.assignment_id
        union all
        select l.app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiter_team_memberships m
            on m.recruiter_id = l.recruiter_id
           and m.is_current
         where a.target_kind = 'TEAM'
           and m.team_id = a.target_team_id
           and l.verified
           and l.is_current
        union all
        select gm.member_user_id as app_user_id,
               g.group_id as snapshot_group_id,
               g.display_name as snapshot_group_name
          from public.work_report_groups g
          join public.work_report_group_members gm
            on gm.group_id = g.group_id
         where a.target_kind = 'GROUP'
           and g.group_id = a.target_group_id
           and g.active
      ) u
     where a.assignment_id = p_assignment_id
       and a.is_current
       and a.state = 'ACTIVE'
       and a.effective_from <= p_business_date
       and (a.effective_to is null or p_business_date <= a.effective_to)
  ),
  authorized as (
    select c.*
      from candidate c
     where exists (
             select 1
               from public.direct_entry_app_users du
              where du.app_user_id = c.assignee_id
                and du.enabled
           )
       and (
             c.target_kind <> 'GROUP'
             or (
               public.work_report__internal_is_eligible_assignee(c.assignee_id)
               and not exists (
                 select 1
                   from public.work_report_group_members gm_out
                  where gm_out.group_id = c.target_group_id
                    and not public.work_report__internal_actor_can_assign_member(
                      c.assigned_by_user_id,
                      gm_out.member_user_id,
                      c.template_id
                    )
               )
             )
           )
  ),
  materialized as (
    select a.*,
           p.period_key,
           p.period_start_date,
           p.period_end_date,
           public.work_report_due_at(
             p.period_end_date,
             a.due_day_offset,
             a.due_time_local,
             a.exclude_sundays
           ) as due_at
      from authorized a
      cross join lateral public.work_report_period(a.frequency, p_business_date) p
  ),
  deduplicated as (
    select distinct on (m.template_id, m.assignee_id, m.period_key)
           m.*
      from materialized m
     order by m.template_id, m.assignee_id, m.period_key, m.due_at asc, m.created_at asc, m.assignment_id asc
  ),
  inserted as (
    insert into public.work_report_obligations (
      template_id,
      template_version_id,
      assignment_id,
      assignee_app_user_id,
      snapshot_team_id,
      snapshot_team_code,
      snapshot_team_display_name,
      snapshot_group_id,
      snapshot_group_name,
      period_type,
      period_key,
      period_start_date,
      period_end_date,
      due_at,
      is_mandatory
    )
    select d.template_id,
           d.template_version_id,
           d.assignment_id,
           d.assignee_id,
           d.team_id,
           t.code,
           t.display_name,
           d.snapshot_group_id,
           d.snapshot_group_name,
           d.frequency,
           d.period_key,
           d.period_start_date,
           d.period_end_date,
           d.due_at,
           d.is_mandatory
      from deduplicated d
      left join public.teams t on t.team_id = d.team_id
     order by d.template_id, d.assignee_id, d.period_key
    on conflict (template_id, assignee_app_user_id, period_key) do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from inserted;

  return v_inserted;
end;
$function$;

create or replace function public.work_report__internal_materialize_actor_obligations(
  p_app_user_id uuid,
  p_business_date date,
  p_lookback_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_days integer := greatest(least(coalesce(p_lookback_days, 7), 31), 1);
  v_window_start date;
  v_team_id uuid;
  v_is_eligible boolean;
  v_inserted integer := 0;
begin
  if p_app_user_id is null or p_business_date is null then
    return 0;
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.enabled
  ) then
    return 0;
  end if;

  -- Serialize concurrent personal-list materializations for the same actor without blocking other actors.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('work_report_materialize_actor'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  v_window_start := p_business_date - (v_days - 1);
  v_team_id := public.work_report_current_team(p_app_user_id);
  v_is_eligible := public.work_report__internal_is_eligible_assignee(p_app_user_id);

  with window_dates as (
    select gs::date as business_date
      from pg_catalog.generate_series(
        v_window_start::timestamp,
        p_business_date::timestamp,
        interval '1 day'
      ) gs
  ),
  actor_assignments as (
    select a.*,
           case
             when a.target_kind = 'GROUP' then g.group_id
             else null::uuid
           end as snapshot_group_id,
           case
             when a.target_kind = 'GROUP' then g.display_name
             else null::text
           end as snapshot_group_name
      from public.work_report_assignments a
      join public.work_report_templates tpl
        on tpl.template_id = a.template_id
       and tpl.status = 'ACTIVE'
      left join public.work_report_groups g
        on a.target_kind = 'GROUP'
       and g.group_id = a.target_group_id
     where a.is_current
       and a.state = 'ACTIVE'
       and a.effective_from <= p_business_date
       and (a.effective_to is null or a.effective_to >= v_window_start)
       and (
         (a.target_kind = 'USER' and a.target_user_id = p_app_user_id)
         or (
           a.target_kind = 'USER_SET'
           and exists (
             select 1
               from public.work_report_assignment_targets x
              where x.assignment_id = a.assignment_id
                and x.target_user_id = p_app_user_id
           )
         )
         or (
           a.target_kind = 'TEAM'
           and exists (
             select 1
               from public.direct_entry_app_user_recruiter_links l
               join public.recruiter_team_memberships m
                 on m.recruiter_id = l.recruiter_id
                and m.is_current
              where l.app_user_id = p_app_user_id
                and l.verified
                and l.is_current
                and m.team_id = a.target_team_id
           )
         )
         or (
           a.target_kind = 'GROUP'
           and v_is_eligible
           and g.active is true
           and exists (
             select 1
               from public.work_report_group_members gm
              where gm.group_id = a.target_group_id
                and gm.member_user_id = p_app_user_id
           )
           and not exists (
             select 1
               from public.work_report_group_members gm_out
              where gm_out.group_id = a.target_group_id
                and not public.work_report__internal_actor_can_assign_member(
                  a.assigned_by_user_id,
                  gm_out.member_user_id,
                  a.template_id
                )
           )
         )
       )
  ),
  materialized as (
    select aa.*,
           p.period_key,
           p.period_start_date,
           p.period_end_date,
           public.work_report_due_at(
             p.period_end_date,
             aa.due_day_offset,
             aa.due_time_local,
             aa.exclude_sundays
           ) as due_at
      from actor_assignments aa
      join window_dates wd
        on aa.effective_from <= wd.business_date
       and (aa.effective_to is null or wd.business_date <= aa.effective_to)
       and (
         aa.frequency <> 'ONCE'
         or (
           wd.business_date = greatest(aa.effective_from, v_window_start)
           and not exists (
             select 1
               from public.work_report_obligations o_once
              where o_once.assignment_id = aa.assignment_id
                and o_once.assignee_app_user_id = p_app_user_id
           )
         )
       )
      cross join lateral public.work_report_period(aa.frequency, wd.business_date) p
  ),
  deduplicated as (
    select distinct on (m.template_id, m.period_key)
           m.*
      from materialized m
     order by m.template_id, m.period_key, m.due_at asc, m.created_at asc, m.assignment_id asc
  ),
  inserted as (
    insert into public.work_report_obligations (
      template_id,
      template_version_id,
      assignment_id,
      assignee_app_user_id,
      snapshot_team_id,
      snapshot_team_code,
      snapshot_team_display_name,
      snapshot_group_id,
      snapshot_group_name,
      period_type,
      period_key,
      period_start_date,
      period_end_date,
      due_at,
      is_mandatory
    )
    select d.template_id,
           d.template_version_id,
           d.assignment_id,
           p_app_user_id,
           v_team_id,
           t.code,
           t.display_name,
           d.snapshot_group_id,
           d.snapshot_group_name,
           d.frequency,
           d.period_key,
           d.period_start_date,
           d.period_end_date,
           d.due_at,
           d.is_mandatory
      from deduplicated d
      left join public.teams t on t.team_id = v_team_id
     order by d.template_id, d.period_key
    on conflict (template_id, assignee_app_user_id, period_key) do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from inserted;

  return v_inserted;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Update assignment creation & state transitions to auto-materialize current period.
-- -----------------------------------------------------------------------------
create or replace function public.work_report_create_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_kind text,
  p_target_user_id uuid,
  p_target_team_id uuid,
  p_target_user_ids uuid[],
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time without time zone,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_scope_team_id uuid;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_target_kind not in ('USER', 'TEAM', 'USER_SET')
     or p_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or p_due_day_offset not between 0 and 31
     or p_effective_from is null
     or (p_effective_to is not null and p_effective_to < p_effective_from)
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;
  if (p_target_kind = 'USER') <> (p_target_user_id is not null and p_target_team_id is null)
     or (p_target_kind = 'TEAM') <> (p_target_team_id is not null and p_target_user_id is null)
     or (p_target_kind = 'USER_SET' and (p_target_user_id is not null or p_target_team_id is not null)) then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_target_kind = 'USER_SET' and coalesce(cardinality(p_target_user_ids), 0) < 1 then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_target_kind = 'TEAM' then
    v_scope_team_id := p_target_team_id;
  elsif p_target_kind = 'USER' then
    v_scope_team_id := public.work_report_resolve_assignment_user_team(p_target_user_id);
  end if;

  if p_target_kind in ('USER', 'TEAM') then
    select a.acting_scope_kind, a.delegation_id
      into v_scope, v_delegation_id
      from public.work_report__internal_resolve_capability_authority(
        p_app_user_id, 'report_assign', p_template_id, v_scope_team_id
      ) a;
    if v_scope is null then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  else
    if exists (
      select 1
        from unnest(p_target_user_ids) x(user_id)
       where not exists (
         select 1
           from public.work_report__internal_resolve_capability_authority(
             p_app_user_id, 'report_assign', p_template_id, public.work_report_current_team(x.user_id)
           ) a
       )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null) then 'all'
      else 'team'
    end;
  end if;

  select * into v_template from public.work_report_templates where template_id = p_template_id for share;
  if not found or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id,
    'target_kind', p_target_kind,
    'target_user_id', p_target_user_id,
    'target_team_id', p_target_team_id,
    'target_user_ids', p_target_user_ids,
    'frequency', p_frequency,
    'is_mandatory', p_is_mandatory,
    'due_day_offset', p_due_day_offset,
    'due_time_local', p_due_time_local,
    'exclude_sundays', p_exclude_sundays,
    'effective_from', p_effective_from,
    'effective_to', p_effective_to
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'work_report_assignment_create', p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_assignments (
    template_id,
    template_version_id,
    target_kind,
    target_user_id,
    target_team_id,
    frequency,
    is_mandatory,
    due_day_offset,
    due_time_local,
    exclude_sundays,
    effective_from,
    effective_to,
    assigned_by_user_id
  )
  values (
    p_template_id,
    v_template.current_published_version_id,
    p_target_kind,
    p_target_user_id,
    p_target_team_id,
    p_frequency,
    coalesce(p_is_mandatory, true),
    p_due_day_offset,
    p_due_time_local,
    coalesce(p_exclude_sundays, false),
    p_effective_from,
    p_effective_to,
    p_app_user_id
  )
  returning assignment_id into v_assignment_id;

  if p_target_kind = 'USER_SET' then
    insert into public.work_report_assignment_targets (assignment_id, target_user_id)
      select v_assignment_id, x
        from (select distinct unnest(p_target_user_ids) x) q;
  end if;

  perform public.work_report__internal_materialize_assignment_for_date(
    v_assignment_id,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    scope_team_id,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    case when v_scope = 'team' then v_scope_team_id else null end,
    p_template_id,
    'APPLIED',
    jsonb_build_object(
      'assignment_id', v_assignment_id,
      'target_kind', p_target_kind,
      'delegation_id', v_delegation_id
    )
  );

  v_result := jsonb_build_object('assignment_id', v_assignment_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'work_report_assignment_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.work_report_create_group_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_group_id uuid,
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time without time zone,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_group public.work_report_groups%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_template_id is null
     or p_target_group_id is null
     or p_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or p_due_day_offset not between 0 and 31
     or p_due_time_local is null
     or p_effective_from is null
     or (p_effective_to is not null and p_effective_to < p_effective_from)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;

  select *
    into v_group
    from public.work_report_groups g
   where g.group_id = p_target_group_id
     for share;

  if not found then
    raise exception 'WORK_REPORT_GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
      from public.work_report_group_members gm0
     where gm0.group_id = p_target_group_id
  ) or exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_target_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, p_template_id)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if not v_group.active then
    raise exception 'WORK_REPORT_GROUP_INACTIVE' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_target_group_id
       and not public.work_report__internal_is_eligible_assignee(gm.member_user_id)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  select *
    into v_template
    from public.work_report_templates t
   where t.template_id = p_template_id
     for share;

  if not found or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id,
    'target_kind', 'GROUP',
    'target_group_id', p_target_group_id,
    'frequency', p_frequency,
    'is_mandatory', p_is_mandatory,
    'due_day_offset', p_due_day_offset,
    'due_time_local', p_due_time_local,
    'exclude_sundays', p_exclude_sundays,
    'effective_from', p_effective_from,
    'effective_to', p_effective_to
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_assignment_create',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_assignments (
    template_id,
    template_version_id,
    target_kind,
    target_user_id,
    target_team_id,
    target_group_id,
    frequency,
    is_mandatory,
    due_day_offset,
    due_time_local,
    exclude_sundays,
    effective_from,
    effective_to,
    assigned_by_user_id
  )
  values (
    p_template_id,
    v_template.current_published_version_id,
    'GROUP',
    null,
    null,
    p_target_group_id,
    p_frequency,
    coalesce(p_is_mandatory, true),
    p_due_day_offset,
    p_due_time_local,
    coalesce(p_exclude_sundays, false),
    p_effective_from,
    p_effective_to,
    p_app_user_id
  )
  returning assignment_id into v_assignment_id;

  perform public.work_report__internal_materialize_assignment_for_date(
    v_assignment_id,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    p_template_id,
    'APPLIED',
    jsonb_build_object(
      'assignment_id', v_assignment_id,
      'target_kind', 'GROUP',
      'target_group_id', p_target_group_id
    )
  );

  v_result := jsonb_build_object('assignment_id', v_assignment_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_assignment_create',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$function$;

create or replace function public.work_report_set_assignment_state(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_state text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_assignment public.work_report_assignments%rowtype;
  v_group_active boolean;
  v_team_id uuid;
  v_scope text;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_state not in ('ACTIVE', 'PAUSED', 'REVOKED') then
    raise exception 'WORK_REPORT_ASSIGNMENT_STATE_INVALID' using errcode = '22023';
  end if;

  select *
    into v_assignment
    from public.work_report_assignments
   where assignment_id = p_assignment_id
     for update;
  if not found then
    raise exception 'WORK_REPORT_ASSIGNMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_team_id := case v_assignment.target_kind
    when 'TEAM' then v_assignment.target_team_id
    when 'USER' then public.work_report_resolve_assignment_user_team(v_assignment.target_user_id)
    else null
  end;

  if v_assignment.target_kind = 'USER_SET' then
    if exists (
      select 1
        from public.work_report_assignment_targets x
       where x.assignment_id = p_assignment_id
         and not exists (
           select 1
             from public.work_report__internal_resolve_capability_authority(
               p_app_user_id,
               'report_assign',
               v_assignment.template_id,
               public.work_report_current_team(x.target_user_id)
             ) a
         )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null) then 'all'
      else 'team'
    end;
  elsif v_assignment.target_kind = 'GROUP' then
    if not exists (
      select 1
        from public.work_report_group_members gm0
       where gm0.group_id = v_assignment.target_group_id
    ) or exists (
      select 1
        from public.work_report_group_members gm
       where gm.group_id = v_assignment.target_group_id
         and not public.work_report__internal_actor_can_assign_member(
           p_app_user_id,
           gm.member_user_id,
           v_assignment.template_id
         )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if p_state = 'ACTIVE' then
      select g.active
        into v_group_active
        from public.work_report_groups g
       where g.group_id = v_assignment.target_group_id;
      if not coalesce(v_group_active, false) then
        raise exception 'WORK_REPORT_GROUP_INACTIVE' using errcode = '22023';
      end if;
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null) then 'all'
      else 'team'
    end;
  else
    select a.acting_scope_kind, a.delegation_id
      into v_scope, v_delegation_id
      from public.work_report__internal_resolve_capability_authority(
        p_app_user_id,
        'report_assign',
        v_assignment.template_id,
        v_team_id
      ) a;
    if v_scope is null then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  if v_assignment.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = '40001';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'assignment_id', p_assignment_id,
    'expected_version', p_expected_version,
    'state', p_state
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_assignment_state',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  update public.work_report_assignments
     set state = p_state,
         is_current = (p_state <> 'REVOKED'),
         version = version + 1,
         updated_at = now()
   where assignment_id = p_assignment_id;

  if p_state = 'REVOKED' then
    update public.work_report_obligations
       set obligation_status = 'CANCELLED',
           status_changed_by_user_id = p_app_user_id,
           version = version + 1,
           updated_at = now()
     where assignment_id = p_assignment_id
       and obligation_status = 'ACTIVE'
       and not exists (
         select 1
           from public.work_report_submissions s
          where s.obligation_id = work_report_obligations.obligation_id
            and s.first_submitted_at is not null
       );
  elsif p_state = 'ACTIVE' then
    perform public.work_report__internal_materialize_assignment_for_date(
      p_assignment_id,
      (now() at time zone 'Asia/Ho_Chi_Minh')::date
    );
  end if;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    scope_team_id,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_STATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    case when v_scope = 'team' then v_team_id end,
    v_assignment.template_id,
    'APPLIED',
    jsonb_build_object(
      'assignment_id', p_assignment_id,
      'state', p_state,
      'delegation_id', v_delegation_id
    )
  );

  v_result := jsonb_build_object(
    'assignment_id', p_assignment_id,
    'state', p_state,
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_assignment_state',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Update `work_report_list_my_obligations` and `work_report_get_submission`
--    with per-actor auto-materialization and server-computed `is_overdue`.
-- -----------------------------------------------------------------------------
create or replace function public.work_report_list_my_obligations(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_business_date date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if p_status is not null and p_status not in ('ACTIVE', 'EXEMPTED', 'CANCELLED') then
    raise exception 'WORK_REPORT_STATUS_INVALID' using errcode = '22023';
  end if;

  perform public.work_report__internal_materialize_actor_obligations(
    p_app_user_id,
    v_business_date,
    7
  );

  return jsonb_build_object(
    'items',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'obligation_id', o.obligation_id,
          'template_id', o.template_id,
          'template_version_id', o.template_version_id,
          'template_code', t.template_code,
          'template_name', t.display_name,
          'period_type', o.period_type,
          'period_key', o.period_key,
          'period_start_date', o.period_start_date,
          'period_end_date', o.period_end_date,
          'due_at', o.due_at,
          'is_mandatory', o.is_mandatory,
          'obligation_status', o.obligation_status,
          'reopened_until', o.reopened_until,
          'version', o.version,
          'submission_id', s.submission_id,
          'submission_state', coalesce(s.state, 'NOT_STARTED'),
          'submission_version', s.version,
          'is_overdue', (
            o.obligation_status = 'ACTIVE'
            and coalesce(s.state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT')
            and now() > o.due_at
            and coalesce(o.reopened_until < now(), true)
          ),
          'schema_json', v.schema_json
        )
        order by o.period_start_date desc, t.template_code
      )
      from public.work_report_obligations o
      join public.work_report_templates t on t.template_id = o.template_id
      join public.work_report_template_versions v on v.version_id = o.template_version_id
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
      where o.assignee_app_user_id = p_app_user_id
        and (p_status is null or o.obligation_status = p_status)
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.work_report_get_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  select o.* into v_obligation
    from public.work_report_obligations o
   where o.obligation_id = p_obligation_id
      or exists (
        select 1
          from public.work_report_submissions s
         where s.submission_id = p_obligation_id
           and s.obligation_id = o.obligation_id
      );
  if not found then
    raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_obligation.assignee_app_user_id <> p_app_user_id then
    begin
      perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_view');
    exception when insufficient_privilege then
      raise exception 'WORK_REPORT_ACCESS_DENIED' using errcode = '42501';
    end;
    if not public.direct_entry_has_scope(p_app_user_id, 'all') then
      perform public.work_report_assert_scope(p_app_user_id, 'report_view', v_obligation.snapshot_team_id, false);
    end if;
  end if;
  select jsonb_build_object(
    'obligation', jsonb_build_object(
      'obligation_id', o.obligation_id,
      'template_id', o.template_id,
      'assignee_app_user_id', o.assignee_app_user_id,
      'snapshot_team_id', o.snapshot_team_id,
      'snapshot_team_code', o.snapshot_team_code,
      'snapshot_team_display_name', o.snapshot_team_display_name,
      'period_key', o.period_key,
      'period_start_date', o.period_start_date,
      'period_end_date', o.period_end_date,
      'due_at', o.due_at,
      'obligation_status', o.obligation_status,
      'reopened_until', o.reopened_until,
      'is_overdue', (
        o.obligation_status = 'ACTIVE'
        and coalesce(s.state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT')
        and now() > o.due_at
        and coalesce(o.reopened_until < now(), true)
      ),
      'version', o.version
    ),
    'template', jsonb_build_object(
      'template_code', t.template_code,
      'display_name', t.display_name,
      'schema_json', v.schema_json
    ),
    'submission', case when s.submission_id is null then null else jsonb_build_object(
      'submission_id', s.submission_id,
      'state', s.state,
      'draft_payload_json', s.draft_payload_json,
      'first_submitted_at', s.first_submitted_at,
      'latest_submitted_at', s.latest_submitted_at,
      'is_late', s.is_late,
      'has_post_deadline_amendment', s.has_post_deadline_amendment,
      'current_revision_id', s.current_revision_id,
      'version', s.version
    ) end,
    'latest_review_event', (
      select jsonb_build_object(
        'decision', re.decision,
        'reason', re.reason_text,
        'reviewed_at', re.created_at,
        'revision_no', rr.revision_no
      )
        from public.work_report_review_events re
        left join public.work_report_submission_revisions rr on rr.revision_id = re.revision_id
       where re.submission_id = s.submission_id
       order by re.created_at desc, re.review_event_id desc
       limit 1
    ),
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'revision_id', r.revision_id,
        'revision_no', r.revision_no,
        'payload_json', r.payload_json,
        'created_at', r.created_at
      ) order by r.revision_no desc)
        from public.work_report_submission_revisions r
       where r.submission_id = s.submission_id
    ), '[]'::jsonb)
  ) into v_result
    from public.work_report_obligations o
    join public.work_report_templates t on t.template_id = o.template_id
    join public.work_report_template_versions v on v.version_id = o.template_version_id
    left join public.work_report_submissions s on s.obligation_id = o.obligation_id
   where o.obligation_id = v_obligation.obligation_id;
  return v_result;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Enrich `work_report_list_assignments` with deadline metadata, overdue/rejected
--    counts, per-person obligation progress, and state audit history.
-- -----------------------------------------------------------------------------
create or replace function public.work_report_list_assignments(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_direct_cap boolean;
  v_direct_all boolean;
  v_delegated_all boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_direct_cap := public.work_report__internal_has_direct_capability(p_app_user_id, 'report_assign');
  v_direct_all := v_direct_cap and public.direct_entry_has_scope(p_app_user_id, 'all');
  v_delegated_all := exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'all'
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  );

  if p_team_id is not null then
    if not exists (select 1 from public.teams t where t.team_id = p_team_id and t.active) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if not (
      v_direct_all
      or v_delegated_all
      or (
        v_direct_cap and exists (
          select 1
            from public.direct_entry_scope_grants s
           where s.app_user_id = p_app_user_id
             and s.scope_kind = 'team'
             and s.team_id = p_team_id
             and s.is_current
        )
      )
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'team'
           and d.scope_team_id = p_team_id
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'assignment_id', tracked.assignment_id,
      'template_id', tracked.template_id,
      'template_code', tracked.template_code,
      'template_name', tracked.template_name,
      'target_kind', tracked.target_kind,
      'target_group_id', tracked.target_group_id,
      'target_label', tracked.target_label,
      'target_member_count', tracked.target_member_count,
      'frequency', tracked.frequency,
      'is_mandatory', tracked.is_mandatory,
      'due_day_offset', tracked.due_day_offset,
      'due_time_local', to_char(tracked.due_time_local, 'HH24:MI:SS'),
      'exclude_sundays', tracked.exclude_sundays,
      'effective_from', tracked.effective_from,
      'effective_to', tracked.effective_to,
      'state', tracked.state,
      'version', tracked.version,
      'created_at', tracked.created_at,
      'obligation_total', tracked.obligation_total,
      'submitted_count', tracked.submitted_count,
      'not_started_count', tracked.not_started_count,
      'draft_count', tracked.draft_count,
      'overdue_count', tracked.overdue_count,
      'rejected_count', tracked.rejected_count,
      'exempted_count', tracked.exempted_count,
      'cancelled_count', tracked.cancelled_count
    ) order by tracked.updated_at desc, tracked.assignment_id)
      from (
        select a.assignment_id,
               a.template_id,
               t.template_code,
               t.display_name as template_name,
               a.target_kind,
               a.target_group_id,
               case a.target_kind
                 when 'TEAM' then coalesce(team.display_name, team.code, 'Nhóm không còn hoạt động')
                 when 'USER' then coalesce(target_user.display_name, 'Tài khoản không còn hoạt động')
                 when 'GROUP' then case
                   when grp.group_id is null then 'Nhóm báo cáo'
                   when grp.active then grp.display_name
                   else grp.display_name || ' (Ngừng sử dụng)'
                 end
                 else coalesce(target_list.target_label, 'Danh sách nhân viên')
               end as target_label,
               case a.target_kind
                 when 'USER' then 1
                 when 'USER_SET' then coalesce(target_list.member_count, 0)
                 when 'GROUP' then coalesce((
                   select count(*)::integer
                     from public.work_report_group_members gm_cnt
                    where gm_cnt.group_id = a.target_group_id
                 ), 0)
                 when 'TEAM' then coalesce((
                   select count(distinct l.app_user_id)::integer
                     from public.direct_entry_app_user_recruiter_links l
                     join public.recruiter_team_memberships m
                       on m.recruiter_id = l.recruiter_id
                      and m.is_current
                     join public.direct_entry_app_users du
                       on du.app_user_id = l.app_user_id
                      and du.enabled
                    where m.team_id = a.target_team_id
                      and l.verified
                      and l.is_current
                 ), 0)
                 else 0
               end as target_member_count,
               a.frequency,
               a.is_mandatory,
               a.due_day_offset,
               a.due_time_local,
               a.exclude_sundays,
               a.effective_from,
               a.effective_to,
               a.state,
               a.version,
               a.created_at,
               a.updated_at,
               count(o.obligation_id)::integer as obligation_total,
               count(o.obligation_id) filter (where s.first_submitted_at is not null)::integer as submitted_count,
               count(o.obligation_id) filter (where o.obligation_status = 'ACTIVE' and s.submission_id is null)::integer as not_started_count,
               count(o.obligation_id) filter (where o.obligation_status = 'ACTIVE' and s.state = 'DRAFT')::integer as draft_count,
               count(o.obligation_id) filter (
                 where o.obligation_status = 'ACTIVE'
                   and coalesce(s.state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT')
                   and now() > o.due_at
                   and coalesce(o.reopened_until < now(), true)
               )::integer as overdue_count,
               count(o.obligation_id) filter (
                 where o.obligation_status = 'ACTIVE'
                   and s.state = 'REJECTED'
               )::integer as rejected_count,
               count(o.obligation_id) filter (where o.obligation_status = 'EXEMPTED')::integer as exempted_count,
               count(o.obligation_id) filter (where o.obligation_status = 'CANCELLED')::integer as cancelled_count
          from public.work_report_assignments a
          join public.work_report_templates t on t.template_id = a.template_id
          left join public.teams team on team.team_id = a.target_team_id
          left join public.direct_entry_app_users target_user on target_user.app_user_id = a.target_user_id
          left join public.work_report_groups grp on grp.group_id = a.target_group_id
          left join lateral (
            select string_agg(u.display_name, ', ' order by u.display_name, u.app_user_id) as target_label,
                   count(*)::integer as member_count
              from public.work_report_assignment_targets x
              join public.direct_entry_app_users u on u.app_user_id = x.target_user_id
             where x.assignment_id = a.assignment_id
          ) target_list on true
          left join public.work_report_obligations o on o.assignment_id = a.assignment_id
          left join public.work_report_submissions s on s.obligation_id = o.obligation_id
         where (
           (a.target_kind = 'TEAM' and exists (
             select 1
               from public.work_report__internal_resolve_capability_authority(
                 p_app_user_id, 'report_assign', a.template_id, a.target_team_id
               )
           )) or
           (a.target_kind = 'USER' and exists (
             select 1
               from public.work_report__internal_resolve_capability_authority(
                 p_app_user_id, 'report_assign', a.template_id, public.work_report_current_team(a.target_user_id)
               )
           )) or
           (a.target_kind = 'USER_SET'
             and exists (select 1 from public.work_report_assignment_targets x where x.assignment_id = a.assignment_id)
             and not exists (
               select 1
                 from public.work_report_assignment_targets x
                where x.assignment_id = a.assignment_id
                  and not exists (
                    select 1
                      from public.work_report__internal_resolve_capability_authority(
                        p_app_user_id, 'report_assign', a.template_id, public.work_report_current_team(x.target_user_id)
                      )
                  )
             )
           ) or
           (a.target_kind = 'GROUP'
             and exists (select 1 from public.work_report_group_members gm where gm.group_id = a.target_group_id)
             and not exists (
               select 1
                 from public.work_report_group_members gm
                where gm.group_id = a.target_group_id
                  and not public.work_report__internal_actor_can_assign_member(
                    p_app_user_id,
                    gm.member_user_id,
                    a.template_id
                  )
             )
           )
         )
           and (
             p_team_id is null
             or (a.target_kind = 'TEAM' and a.target_team_id = p_team_id)
             or (a.target_kind = 'USER' and public.work_report_current_team(a.target_user_id) = p_team_id)
             or (a.target_kind = 'USER_SET' and exists (
               select 1
                 from public.work_report_assignment_targets x
                where x.assignment_id = a.assignment_id
                  and public.work_report_current_team(x.target_user_id) = p_team_id
             ))
             or (a.target_kind = 'GROUP' and exists (
               select 1
                 from public.work_report_group_members gm
                where gm.group_id = a.target_group_id
                  and public.work_report_current_team(gm.member_user_id) = p_team_id
             ))
           )
         group by a.assignment_id, t.template_code, t.display_name, team.display_name, team.code,
           target_user.display_name, grp.group_id, grp.display_name, grp.active,
           target_list.target_label, target_list.member_count
      ) tracked
  ), '[]'::jsonb));
end;
$function$;

create or replace function public.work_report_get_assignment_detail(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_assignment public.work_report_assignments%rowtype;
  v_authorized boolean := false;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id);

  if p_assignment_id is null then
    raise exception 'WORK_REPORT_ASSIGNMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select *
    into v_assignment
    from public.work_report_assignments a
   where a.assignment_id = p_assignment_id;

  if not found then
    raise exception 'WORK_REPORT_ASSIGNMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_authorized := (
    (v_assignment.target_kind = 'TEAM' and exists (
      select 1
        from public.work_report__internal_resolve_capability_authority(
          p_app_user_id, 'report_assign', v_assignment.template_id, v_assignment.target_team_id
        )
    )) or
    (v_assignment.target_kind = 'USER' and exists (
      select 1
        from public.work_report__internal_resolve_capability_authority(
          p_app_user_id, 'report_assign', v_assignment.template_id, public.work_report_current_team(v_assignment.target_user_id)
        )
    )) or
    (v_assignment.target_kind = 'USER_SET'
      and exists (select 1 from public.work_report_assignment_targets x where x.assignment_id = v_assignment.assignment_id)
      and not exists (
        select 1
          from public.work_report_assignment_targets x
         where x.assignment_id = v_assignment.assignment_id
           and not exists (
             select 1
               from public.work_report__internal_resolve_capability_authority(
                 p_app_user_id, 'report_assign', v_assignment.template_id, public.work_report_current_team(x.target_user_id)
               )
           )
      )
    ) or
    (v_assignment.target_kind = 'GROUP'
      and exists (select 1 from public.work_report_group_members gm where gm.group_id = v_assignment.target_group_id)
      and not exists (
        select 1
          from public.work_report_group_members gm
         where gm.group_id = v_assignment.target_group_id
           and not public.work_report__internal_actor_can_assign_member(
             p_app_user_id,
             gm.member_user_id,
             v_assignment.template_id
           )
      )
    )
  );

  if not coalesce(v_authorized, false) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'assignment_id', v_assignment.assignment_id,
    'assignee_progress', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'obligation_id', latest_o.obligation_id,
          'assignee_app_user_id', latest_o.assignee_app_user_id,
          'assignee_display_name', latest_o.assignee_display_name,
          'period_key', latest_o.period_key,
          'period_start_date', latest_o.period_start_date,
          'period_end_date', latest_o.period_end_date,
          'due_at', latest_o.due_at,
          'reopened_until', latest_o.reopened_until,
          'obligation_status', latest_o.obligation_status,
          'submission_state', latest_o.submission_state,
          'is_overdue', latest_o.is_overdue,
          'submitted_at', latest_o.submitted_at,
          'version', latest_o.version
        )
        order by latest_o.assignee_display_name asc, latest_o.period_start_date desc, latest_o.obligation_id desc
      )
        from (
          select distinct on (o_row.assignee_app_user_id)
                 o_row.obligation_id,
                 o_row.assignee_app_user_id,
                 coalesce(u_row.display_name, o_row.assignee_app_user_id::text) as assignee_display_name,
                 o_row.period_key,
                 o_row.period_start_date,
                 o_row.period_end_date,
                 o_row.due_at,
                 o_row.reopened_until,
                 o_row.obligation_status,
                 coalesce(s_row.state, 'NOT_STARTED') as submission_state,
                 (
                   o_row.obligation_status = 'ACTIVE'
                   and coalesce(s_row.state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT')
                   and now() > o_row.due_at
                   and coalesce(o_row.reopened_until < now(), true)
                 ) as is_overdue,
                 s_row.latest_submitted_at as submitted_at,
                 o_row.version
            from public.work_report_obligations o_row
            left join public.direct_entry_app_users u_row
              on u_row.app_user_id = o_row.assignee_app_user_id
            left join public.work_report_submissions s_row
              on s_row.obligation_id = o_row.obligation_id
           where o_row.assignment_id = v_assignment.assignment_id
           order by o_row.assignee_app_user_id, o_row.period_start_date desc, o_row.obligation_id desc
           limit 200
        ) latest_o
    ), '[]'::jsonb),
    'audit_history', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'event_id', recent_ae.audit_event_id,
          'action', recent_ae.action,
          'state', recent_ae.state,
          'actor_user_id', recent_ae.actor_user_id,
          'actor_display_name', recent_ae.actor_display_name,
          'created_at', recent_ae.created_at
        )
        order by recent_ae.created_at desc, recent_ae.audit_event_id desc
      )
        from (
          select ae.audit_event_id,
                 ae.action,
                 case
                   when ae.action = 'ASSIGNMENT_CREATE' then 'ACTIVE'
                   else coalesce(ae.metadata_json ->> 'state', v_assignment.state)
                 end as state,
                 ae.actor_user_id,
                 coalesce(au.display_name, ae.actor_user_id::text) as actor_display_name,
                 ae.created_at
            from public.work_report_audit_events ae
            left join public.direct_entry_app_users au
              on au.app_user_id = ae.actor_user_id
           where ae.template_id = v_assignment.template_id
             and ae.action in ('ASSIGNMENT_CREATE', 'ASSIGNMENT_STATE')
             and (ae.metadata_json ->> 'assignment_id') = v_assignment.assignment_id::text
           order by ae.created_at desc, ae.audit_event_id desc
           limit 25
        ) recent_ae
    ), '[]'::jsonb)
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 6. Align routine ownership with canonical Work Reports owner.
-- -----------------------------------------------------------------------------
do $align_work_reports_android_sync_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_sig text;
  v_proc_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.work_report_assignments'::pg_catalog.regclass;

  foreach v_sig in array array[
    'public.work_report__internal_materialize_assignment_for_date(uuid, date)',
    'public.work_report__internal_materialize_actor_obligations(uuid, date, integer)',
    'public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text)',
    'public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)',
    'public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)',
    'public.work_report_list_my_obligations(uuid, uuid, text)',
    'public.work_report_get_submission(uuid, uuid, uuid)',
    'public.work_report_list_assignments(uuid, uuid, uuid)',
    'public.work_report_get_assignment_detail(uuid, uuid, uuid)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_sig);

    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;
end;
$align_work_reports_android_sync_owners$;

-- -----------------------------------------------------------------------------
-- 7. Strict function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on function public.work_report__internal_materialize_assignment_for_date(uuid, date)
  from public, anon, authenticated, service_role;

revoke all on function public.work_report__internal_materialize_actor_obligations(uuid, date, integer)
  from public, anon, authenticated, service_role;

revoke all on function public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text)
  to service_role;

revoke all on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  to service_role;

revoke all on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  to service_role;

revoke all on function public.work_report_list_my_obligations(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_my_obligations(uuid, uuid, text)
  to service_role;

revoke all on function public.work_report_get_submission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_get_submission(uuid, uuid, uuid)
  to service_role;

revoke all on function public.work_report_list_assignments(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_assignments(uuid, uuid, uuid)
  to service_role;

revoke all on function public.work_report_get_assignment_detail(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_get_assignment_detail(uuid, uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 8. Install-time fail-closed catalog & ACL self-check.
-- -----------------------------------------------------------------------------
do $check_work_reports_android_sync_and_ux$
declare
  v_internal_fn pg_catalog.regprocedure;
  v_rpc_fn pg_catalog.regprocedure;
  v_secdef boolean;
  v_config text;
  v_owner_bypasses_rls boolean;
begin
  foreach v_internal_fn in array array[
    'public.work_report__internal_materialize_assignment_for_date(uuid, date)'::pg_catalog.regprocedure,
    'public.work_report__internal_materialize_actor_obligations(uuid, date, integer)'::pg_catalog.regprocedure
  ]
  loop
    if pg_catalog.has_function_privilege('public', v_internal_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_internal_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_internal_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_internal_fn, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_internal_fn),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_internal_fn))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       ) then
      raise exception 'Work Reports internal routine must stay revoked from all runtime roles: %', v_internal_fn
        using errcode = '55000';
    end if;
  end loop;

  foreach v_rpc_fn in array array[
    'public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text)'::pg_catalog.regprocedure,
    'public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)'::pg_catalog.regprocedure,
    'public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)'::pg_catalog.regprocedure,
    'public.work_report_list_my_obligations(uuid, uuid, text)'::pg_catalog.regprocedure,
    'public.work_report_get_submission(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_list_assignments(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_get_assignment_detail(uuid, uuid, uuid)'::pg_catalog.regprocedure
  ]
  loop
    select p.prosecdef,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           (r.rolsuper or r.rolbypassrls)
      into v_secdef, v_config, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_rpc_fn;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or not coalesce(v_owner_bypasses_rls, false) then
      raise exception 'Work Reports RPC security definer owner/RLS/search_path drift on %', v_rpc_fn
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_rpc_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_rpc_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_rpc_fn, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_rpc_fn),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_rpc_fn))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege('service_role', v_rpc_fn, 'EXECUTE') then
      raise exception 'Work Reports RPC EXECUTE ACL drift on %', v_rpc_fn
        using errcode = '55000';
    end if;
  end loop;
end;
$check_work_reports_android_sync_and_ux$;

commit;
