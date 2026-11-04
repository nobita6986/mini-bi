-- =============================================================================
-- Hotfix: Work Reports Custom Group Assignment & Reactivation Eligibility
-- =============================================================================
-- Purpose:
--   1. When a custom report group (`public.work_report_groups`) already exists and
--      one of its historical members is later deactivated (`direct_entry_app_users.enabled = false`),
--      `public.work_report_create_group_assignment` and `public.work_report_set_group_active`
--      previously rejected the entire group with `WORK_REPORT_GROUP_MEMBER_INELIGIBLE` (22023)
--      because they checked `exists (... not work_report__internal_is_eligible_assignee(...))`.
--   2. Obligation materialization (`work_report__internal_materialize_assignment_for_date`,
--      `work_report__internal_materialize_actor_obligations`, and
--      `work_report_ensure_obligations_for_window`) already filters out disabled/ineligible
--      members via `work_report__internal_is_eligible_assignee`, and group creation/editing
--      (`work_report_create_group`, `work_report_update_group`) already rejects adding
--      ineligible users to a group.
--   3. Align `work_report_create_group_assignment` and `work_report_set_group_active`
--      so that an existing group is valid as long as it contains at least one currently
--      eligible member (`not exists (... and work_report__internal_is_eligible_assignee(...))`),
--      while preserving fail-closed scope authorization across all group members.
--   4. Align `work_report_list_assignments` `target_member_count` for `GROUP` to count
--      currently eligible members, matching `TEAM` and actual materialized obligations.
-- =============================================================================

begin;

create or replace function public.work_report_set_group_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_group_id uuid,
  p_expected_version integer,
  p_active boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_group public.work_report_groups%rowtype;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_group_id is null
     or p_expected_version is null or p_expected_version < 1
     or p_active is null
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select *
    into v_group
    from public.work_report_groups g
   where g.group_id = p_group_id
     for update;

  if not found then
    raise exception 'WORK_REPORT_GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
      from public.work_report_group_members gm0
     where gm0.group_id = p_group_id
  ) or exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if v_group.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = '40001';
  end if;

  if p_active and not exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and public.work_report__internal_is_eligible_assignee(gm.member_user_id)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'group_id', p_group_id,
    'expected_version', p_expected_version,
    'active', p_active
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_group_active',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  update public.work_report_groups
     set active = p_active,
         updated_by_user_id = p_app_user_id,
         version = version + 1,
         updated_at = now()
   where group_id = p_group_id;

  v_scope := case
    when public.direct_entry_has_scope(p_app_user_id, 'all') then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    case when p_active then 'GROUP_ACTIVATE' else 'GROUP_DEACTIVATE' end,
    p_app_user_id,
    'report_assign',
    v_scope,
    'APPLIED',
    jsonb_build_object(
      'group_id', p_group_id,
      'active', p_active,
      'version', p_expected_version + 1
    )
  );

  v_result := jsonb_build_object(
    'group_id', p_group_id,
    'active', p_active,
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_group_active',
    p_idempotency_key,
    v_result
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

  if not exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_target_group_id
       and public.work_report__internal_is_eligible_assignee(gm.member_user_id)
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
                      and public.work_report__internal_is_eligible_assignee(gm_cnt.member_user_id)
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

-- -----------------------------------------------------------------------------
-- Align routine ownership with canonical Work Reports owner.
-- -----------------------------------------------------------------------------
do $align_hf_work_reports_group_assignment_owners$
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
    'public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)',
    'public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)',
    'public.work_report_list_assignments(uuid, uuid, uuid)'
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
$align_hf_work_reports_group_assignment_owners$;

-- -----------------------------------------------------------------------------
-- Strict function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  to service_role;

revoke all on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  to service_role;

revoke all on function public.work_report_list_assignments(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_assignments(uuid, uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- Install-time fail-closed catalog & ACL self-check.
-- -----------------------------------------------------------------------------
do $check_hf_work_reports_group_assignment_eligible_members$
declare
  v_rpc_fn pg_catalog.regprocedure;
  v_secdef boolean;
  v_config text;
  v_owner_bypasses_rls boolean;
begin
  foreach v_rpc_fn in array array[
    'public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)'::pg_catalog.regprocedure,
    'public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)'::pg_catalog.regprocedure,
    'public.work_report_list_assignments(uuid, uuid, uuid)'::pg_catalog.regprocedure
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
$check_hf_work_reports_group_assignment_eligible_members$;

commit;
