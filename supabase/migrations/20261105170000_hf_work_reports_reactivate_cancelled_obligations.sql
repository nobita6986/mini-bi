-- Reactivate unsubmitted work-report obligations when an active assignment replaces a revoked assignment.
-- Preserve the existing obligation row and history; submitted obligations are never reactivated.

begin;

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
    insert into public.work_report_obligations as existing (
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
    on conflict (template_id, assignee_app_user_id, period_key) do update
       set template_version_id = excluded.template_version_id,
           assignment_id = excluded.assignment_id,
           snapshot_team_id = excluded.snapshot_team_id,
           snapshot_team_code = excluded.snapshot_team_code,
           snapshot_team_display_name = excluded.snapshot_team_display_name,
           snapshot_group_id = excluded.snapshot_group_id,
           snapshot_group_name = excluded.snapshot_group_name,
           period_type = excluded.period_type,
           period_start_date = excluded.period_start_date,
           period_end_date = excluded.period_end_date,
           due_at = excluded.due_at,
           is_mandatory = excluded.is_mandatory,
           obligation_status = 'ACTIVE',
           status_changed_by_user_id = null,
           status_reason_id = null,
           reopened_until = null,
           version = existing.version + 1,
           updated_at = pg_catalog.now()
     where existing.obligation_status = 'CANCELLED'
       and not exists (
         select 1
           from public.work_report_submissions s
          where s.obligation_id = existing.obligation_id
            and s.first_submitted_at is not null
       )
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
    insert into public.work_report_obligations as existing (
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
    on conflict (template_id, assignee_app_user_id, period_key) do update
       set template_version_id = excluded.template_version_id,
           assignment_id = excluded.assignment_id,
           snapshot_team_id = excluded.snapshot_team_id,
           snapshot_team_code = excluded.snapshot_team_code,
           snapshot_team_display_name = excluded.snapshot_team_display_name,
           snapshot_group_id = excluded.snapshot_group_id,
           snapshot_group_name = excluded.snapshot_group_name,
           period_type = excluded.period_type,
           period_start_date = excluded.period_start_date,
           period_end_date = excluded.period_end_date,
           due_at = excluded.due_at,
           is_mandatory = excluded.is_mandatory,
           obligation_status = 'ACTIVE',
           status_changed_by_user_id = null,
           status_reason_id = null,
           reopened_until = null,
           version = existing.version + 1,
           updated_at = pg_catalog.now()
     where existing.obligation_status = 'CANCELLED'
       and not exists (
         select 1
           from public.work_report_submissions s
          where s.obligation_id = existing.obligation_id
            and s.first_submitted_at is not null
       )
    returning 1
  )
  select count(*)::integer into v_inserted from inserted;

  return v_inserted;
end;
$function$;

-- Keep the existing materialization RPC paths, reactivating only cancelled obligations
-- that have never been submitted when an active assignment produces the same period.

do $align_work_report_materializers$
declare
  v_owner_oid oid;
  v_owner name;
  v_signature text;
  v_proc_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_owner_oid, v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.work_report_assignments'::pg_catalog.regclass;

  foreach v_signature in array array[
    'public.work_report__internal_materialize_assignment_for_date(uuid, date)',
    'public.work_report__internal_materialize_actor_obligations(uuid, date, integer)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_signature);

    if v_proc_owner_oid is distinct from v_owner_oid
       and pg_catalog.pg_has_role(current_user, v_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_signature, v_owner);
    end if;
  end loop;
end
$align_work_report_materializers$;

-- Repair the affected business period even if this migration is applied after
-- the incident date. The assignment helper still filters current, active,
-- effective assignments and current group/team eligibility before upserting.
do $backfill_work_report_obligations$
declare
  v_business_date date := date '2026-11-05';
  v_assignment_id uuid;
  v_touched integer;
  v_total_touched integer := 0;
begin
  for v_assignment_id in
    select a.assignment_id
      from public.work_report_assignments a
      join public.work_report_templates tpl
        on tpl.template_id = a.template_id
       and tpl.status = 'ACTIVE'
      cross join lateral public.work_report_period(a.frequency, date '2026-11-05') p
     where a.is_current
       and a.state = 'ACTIVE'
       and a.effective_from <= date '2026-11-05'
       and (a.effective_to is null or date '2026-11-05' <= a.effective_to)
       and exists (
         select 1
           from public.work_report_obligations o
          where o.template_id = a.template_id
            and o.period_type = a.frequency
            and o.period_key = p.period_key
            and o.period_start_date = p.period_start_date
            and o.period_end_date = p.period_end_date
            and o.obligation_status = 'CANCELLED'
            and not exists (
              select 1
                from public.work_report_submissions s
               where s.obligation_id = o.obligation_id
                 and s.first_submitted_at is not null
            )
            and (
              (a.target_kind = 'USER' and a.target_user_id = o.assignee_app_user_id)
              or (
                a.target_kind = 'USER_SET'
                and exists (
                  select 1
                    from public.work_report_assignment_targets x
                   where x.assignment_id = a.assignment_id
                     and x.target_user_id = o.assignee_app_user_id
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
                   where l.app_user_id = o.assignee_app_user_id
                     and l.verified
                     and l.is_current
                     and m.team_id = a.target_team_id
                )
              )
              or (
                a.target_kind = 'GROUP'
                and exists (
                  select 1
                    from public.work_report_groups g
                    join public.work_report_group_members gm
                      on gm.group_id = g.group_id
                   where g.group_id = a.target_group_id
                     and g.active
                     and gm.member_user_id = o.assignee_app_user_id
                )
              )
            )
       )
     group by a.assignment_id, a.template_id, a.created_at,
              public.work_report_due_at(
                p.period_end_date,
                a.due_day_offset,
                a.due_time_local,
                a.exclude_sundays
              )
     order by a.template_id,
              public.work_report_due_at(
                p.period_end_date,
                a.due_day_offset,
                a.due_time_local,
                a.exclude_sundays
              ),
              a.created_at,
              a.assignment_id
  loop
    v_touched := public.work_report__internal_materialize_assignment_for_date(
      v_assignment_id,
      v_business_date
    );
    v_total_touched := v_total_touched + coalesce(v_touched, 0);
  end loop;

  raise notice 'Work report obligation backfill for % touched % row(s)',
    v_business_date, v_total_touched;
end
$backfill_work_report_obligations$;

revoke all on function
  public.work_report__internal_materialize_assignment_for_date(uuid, date),
  public.work_report__internal_materialize_actor_obligations(uuid, date, integer)
from public, anon, authenticated, service_role;

-- Install-time security and contract self-check.
do $check_work_report_materializers$
declare
  v_owner_oid oid;
  v_fn pg_catalog.regprocedure;
  v_fn_owner oid;
  v_secdef boolean;
  v_config text;
  v_owner_bypasses_rls boolean;
begin
  select c.relowner
    into v_owner_oid
    from pg_catalog.pg_class c
   where c.oid = 'public.work_report_assignments'::pg_catalog.regclass;

  if v_owner_oid is null then
    raise exception 'Work Report assignment table owner missing' using errcode = '55000';
  end if;

  foreach v_fn in array array[
    'public.work_report__internal_materialize_assignment_for_date(uuid, date)'::pg_catalog.regprocedure,
    'public.work_report__internal_materialize_actor_obligations(uuid, date, integer)'::pg_catalog.regprocedure
  ]
  loop
    select p.proowner,
           p.prosecdef,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           (r.rolsuper or r.rolbypassrls)
      into v_fn_owner, v_secdef, v_config, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn;

    if v_fn_owner is distinct from v_owner_oid
       or not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or not coalesce(v_owner_bypasses_rls, false) then
      raise exception 'Work Report materializer owner/RLS/search_path drift on %', v_fn
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_fn),
             pg_catalog.acldefault('f', v_fn_owner)
           )) a
          where a.grantee = 0
            and a.privilege_type = 'EXECUTE'
       ) then
      raise exception 'Work Report internal materializer must stay revoked from runtime roles: %', v_fn
        using errcode = '55000';
    end if;
  end loop;
end
$check_work_report_materializers$;

commit;
