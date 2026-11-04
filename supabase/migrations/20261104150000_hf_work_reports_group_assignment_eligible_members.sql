-- =============================================================================
-- Hotfix: Work Reports Custom Group Assignment Eligibility & User Full Name Resolution
-- =============================================================================
-- Purpose:
--   1. When a custom report group (`public.work_report_groups`) already exists and
--      one of its historical members is later deactivated (`direct_entry_app_users.enabled = false`),
--      `public.work_report_create_group_assignment` and `public.work_report_set_group_active`
--      previously rejected the entire group with `WORK_REPORT_GROUP_MEMBER_INELIGIBLE` (22023)
--      because they checked `exists (... not work_report__internal_is_eligible_assignee(...))`.
--   2. Align `work_report_create_group_assignment` and `work_report_set_group_active`
--      so that an existing group is valid as long as it contains at least one currently
--      eligible member (`not exists (... and work_report__internal_is_eligible_assignee(...))`),
--      while preserving fail-closed scope authorization across all group members.
--   3. Align `work_report_list_assignments` `target_member_count` for `GROUP` to count
--      currently eligible members, matching `TEAM` and actual materialized obligations.
--   4. Add internal helper `public.work_report__internal_user_display_name(uuid)` to
--      resolve canonical employee full names from `public.recruiters.display_name`
--      (via verified `public.direct_entry_app_user_recruiter_links`, including historical
--      links for disabled accounts, or unambiguous `personnel_code` match) before falling
--      back to `public.direct_entry_app_users.display_name`. Apply this across Work Reports
--      RPCs so login IDs (e.g. `anh3dt.td`, `hungdv.td`) are resolved to full names.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Internal helper for canonical Work Reports user display name resolution.
-- -----------------------------------------------------------------------------
create or replace function public.work_report__internal_user_display_name(
  p_app_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth_subject uuid;
  v_user_display_name text;
  v_login_id text;
  v_linked_display_name text;
  v_linked_personnel_code text;
  v_matched_display_name text;
  v_matched_personnel_code text;
  v_lookup_code text;
begin
  if p_app_user_id is null then
    return null;
  end if;

  select u.auth_subject,
         nullif(pg_catalog.btrim(u.display_name), '')
    into v_auth_subject, v_user_display_name
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found then
    return null;
  end if;

  select pg_catalog.lower(
           nullif(
             pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), '@', 1),
             ''
           )
         )
    into v_login_id
    from auth.users au
   where au.id = v_auth_subject;

  -- Prefer verified recruiter link (prioritizing current + active links, while still
  -- resolving historical links when an account was later disabled).
  select nullif(pg_catalog.btrim(r.display_name), ''),
         nullif(pg_catalog.btrim(r.personnel_code), '')
    into v_linked_display_name, v_linked_personnel_code
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
   where l.app_user_id = p_app_user_id
     and l.verified = true
   order by l.is_current desc,
            r.active desc,
            l.valid_from desc nulls last,
            r.recruiter_id asc
   limit 1;

  if v_linked_display_name is not null
     and not public.attendance__internal_is_login_or_code_like(
       v_linked_display_name,
       v_linked_personnel_code,
       v_login_id
     ) then
    return v_linked_display_name;
  end if;

  -- Try unambiguous personnel_code match when no non-code linked recruiter name exists.
  v_lookup_code := coalesce(
    v_login_id,
    case
      when public.attendance__internal_is_login_or_code_like(v_user_display_name, null, null) then
        pg_catalog.lower(v_user_display_name)
      else null
    end
  );

  if v_lookup_code is not null then
    select case when count(*) = 1 then max(nullif(pg_catalog.btrim(r.display_name), '')) else null end,
           case when count(*) = 1 then max(nullif(pg_catalog.btrim(r.personnel_code), '')) else null end
      into v_matched_display_name, v_matched_personnel_code
      from public.recruiters r
     where r.personnel_code is not null
       and pg_catalog.lower(pg_catalog.btrim(r.personnel_code)) = v_lookup_code;

    if v_matched_display_name is not null
       and not public.attendance__internal_is_login_or_code_like(
         v_matched_display_name,
         v_matched_personnel_code,
         v_login_id
       ) then
      return v_matched_display_name;
    end if;
  end if;

  return v_user_display_name;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 2. Custom report group list, activation, and group assignment creation.
-- -----------------------------------------------------------------------------
create or replace function public.work_report_list_groups(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_direct_cap boolean;
  v_all_scope boolean;
  v_has_team_scope boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_direct_cap := public.work_report__internal_has_direct_capability(p_app_user_id, 'report_assign');
  v_all_scope := (v_direct_cap and public.direct_entry_has_scope(p_app_user_id, 'all'))
    or exists (
      select 1
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.scope_kind = 'all'
         and public.work_report__internal_is_delegation_effective(d.delegation_id)
    );

  if not v_all_scope then
    v_has_team_scope := (
      v_direct_cap and exists (
        select 1
          from public.direct_entry_scope_grants s
          join public.teams t on t.team_id = s.team_id and t.active
         where s.app_user_id = p_app_user_id
           and s.scope_kind = 'team'
           and s.is_current
      )
    ) or exists (
      select 1
        from public.work_report_delegations d
        join public.teams t on t.team_id = d.scope_team_id and t.active
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.scope_kind = 'team'
         and public.work_report__internal_is_delegation_effective(d.delegation_id)
    );
    if not v_has_team_scope then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'scope_kind', case when v_all_scope then 'all' else 'team' end,
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'group_id', g.group_id,
        'display_name', g.display_name,
        'description', g.description,
        'active', g.active,
        'version', g.version,
        'created_at', g.created_at,
        'updated_at', g.updated_at,
        'assignment_count', (
          select count(*)::integer
            from public.work_report_assignments a
           where a.target_group_id = g.group_id
        ),
        'members', coalesce((
          select jsonb_agg(jsonb_build_object(
            'app_user_id', grp_member.app_user_id,
            'display_name', grp_member.display_name,
            'enabled', grp_member.enabled,
            'team_id', grp_member.team_id,
            'team_code', grp_member.team_code,
            'team_display_name', grp_member.team_display_name
          ) order by grp_member.display_name, grp_member.app_user_id)
            from (
              select u.app_user_id,
                     coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name,
                     u.enabled,
                     tm.team_id,
                     tm.code as team_code,
                     tm.display_name as team_display_name
                from public.work_report_group_members gm
                join public.direct_entry_app_users u on u.app_user_id = gm.member_user_id
                left join public.teams tm on tm.team_id = public.work_report_current_team(u.app_user_id)
               where gm.group_id = g.group_id
            ) grp_member
        ), '[]'::jsonb)
      ) order by g.active desc, g.display_name asc, g.group_id asc)
        from public.work_report_groups g
       where exists (
         select 1
           from public.work_report_group_members gm0
          where gm0.group_id = g.group_id
       )
         and not exists (
           select 1
             from public.work_report_group_members gm_out
            where gm_out.group_id = g.group_id
              and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm_out.member_user_id, null)
         )
    ), '[]'::jsonb),
    'eligible_users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'app_user_id', eligible.app_user_id,
        'display_name', eligible.display_name,
        'team_id', eligible.team_id,
        'team_code', eligible.team_code,
        'team_display_name', eligible.team_display_name
      ) order by eligible.display_name, eligible.app_user_id)
        from (
          select u.app_user_id,
                 coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name,
                 tm.team_id,
                 tm.code as team_code,
                 tm.display_name as team_display_name
            from public.direct_entry_app_users u
            left join public.teams tm on tm.team_id = public.work_report_current_team(u.app_user_id)
           where public.work_report__internal_is_eligible_assignee(u.app_user_id)
             and public.work_report__internal_actor_can_assign_member(p_app_user_id, u.app_user_id, null)
        ) eligible
    ), '[]'::jsonb)
  );
end;
$function$;

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

-- -----------------------------------------------------------------------------
-- 3. Assignment options, tracking list, and detail with canonical user full names.
-- -----------------------------------------------------------------------------
create or replace function public.work_report_list_assignment_options(
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
  v_direct_has_team boolean;
  v_delegated_all boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_direct_cap := public.work_report__internal_has_direct_capability(p_app_user_id, 'report_assign');
  v_direct_all := v_direct_cap and public.direct_entry_has_scope(p_app_user_id, 'all');
  v_direct_has_team := v_direct_cap and exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active
     where s.app_user_id = p_app_user_id and s.scope_kind = 'team' and s.is_current
  );
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
          select 1 from public.direct_entry_scope_grants s
           where s.app_user_id = p_app_user_id
             and s.scope_kind = 'team'
             and s.team_id = p_team_id
             and s.is_current
        )
      )
      or exists (
        select 1 from public.work_report_delegations d
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

  return jsonb_build_object(
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'template_id', t.template_id,
        'template_code', t.template_code,
        'display_name', t.display_name,
        'default_frequency', t.default_frequency,
        'current_published_version_id', t.current_published_version_id
      ) order by t.template_code)
        from public.work_report_templates t
       where t.status = 'ACTIVE'
         and t.current_published_version_id is not null
         and (
           v_direct_all
           or v_direct_has_team
           or exists (
             select 1 from public.work_report_delegations d
              where d.delegate_app_user_id = p_app_user_id
                and d.capability = 'report_assign'
                and d.template_id = t.template_id
                and public.work_report__internal_is_delegation_effective(d.delegation_id)
           )
         )
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'team_id', t.team_id, 'code', t.code, 'display_name', t.display_name
      ) order by t.code)
        from public.teams t
       where t.active and (
         v_direct_all
         or v_delegated_all
         or (
           v_direct_cap and exists (
             select 1 from public.direct_entry_scope_grants s
              where s.app_user_id = p_app_user_id and s.scope_kind = 'team'
                and s.team_id = t.team_id and s.is_current
           )
         )
         or exists (
           select 1 from public.work_report_delegations d
            where d.delegate_app_user_id = p_app_user_id
              and d.capability = 'report_assign'
              and d.scope_kind = 'team'
              and d.scope_team_id = t.team_id
              and public.work_report__internal_is_delegation_effective(d.delegation_id)
         )
       )
    ), '[]'::jsonb),
    'users', case when p_team_id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'app_user_id', eligible.app_user_id, 'display_name', eligible.display_name
      ) order by eligible.display_name, eligible.app_user_id)
        from (
          select distinct
                 u.app_user_id,
                 coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.direct_entry_app_users u on u.app_user_id = l.app_user_id and u.enabled
            join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
            join public.recruiter_team_memberships m on m.recruiter_id = r.recruiter_id
              and m.team_id = p_team_id and m.is_current
           where l.verified and l.is_current
             and exists (
               select 1 from public.teams t where t.team_id = p_team_id and t.active
             )
        ) eligible
    ), '[]'::jsonb) end
  );
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
                 when 'USER' then coalesce(
                   public.work_report__internal_user_display_name(a.target_user_id),
                   target_user.display_name,
                   'Tài khoản không còn hoạt động'
                 )
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
            select string_agg(
                     coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name),
                     ', '
                     order by coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name), u.app_user_id
                   ) as target_label,
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
                 coalesce(
                   public.work_report__internal_user_display_name(o_row.assignee_app_user_id),
                   u_row.display_name,
                   o_row.assignee_app_user_id::text
                 ) as assignee_display_name,
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
                 coalesce(
                   public.work_report__internal_user_display_name(ae.actor_user_id),
                   au.display_name,
                   ae.actor_user_id::text
                 ) as actor_display_name,
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
-- 4. Analytics filter options, breakdown, contributions, reader, review & delegation.
-- -----------------------------------------------------------------------------
create or replace function public.work_report_analytics_filter_options(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_label text;
  v_team_ids uuid[];
begin
  select s.scope_kind, s.scope_label, s.authorized_team_ids
    into v_scope_kind, v_scope_label, v_team_ids
    from public.work_report__internal_resolve_analytics_scope(
      p_auth_subject,
      p_app_user_id,
      false,
      null,
      null,
      null
    ) s;

  return jsonb_build_object(
    'effective_scope', jsonb_build_object(
      'kind', v_scope_kind,
      'label', v_scope_label
    ),
    'templates', coalesce((
      with scoped_templates as (
        select distinct t.template_id
          from public.work_report_templates t
         where (
           v_scope_kind = 'all'
           and (
             exists (
               select 1
                 from public.work_report_template_versions tv
                where tv.template_id = t.template_id
                  and tv.status in ('PUBLISHED', 'ARCHIVED')
             )
             or exists (
               select 1
                 from public.work_report_obligations o
                where o.template_id = t.template_id
             )
           )
         )
         or (
           v_scope_kind = 'team'
           and (
             exists (
               select 1
                 from public.work_report_obligations o
                where o.template_id = t.template_id
                  and o.snapshot_team_id = any(v_team_ids)
             )
             or exists (
               select 1
                 from public.work_report_assignments a
                where a.template_id = t.template_id
                  and a.is_current
                  and (
                    (a.target_kind = 'TEAM' and a.target_team_id = any(v_team_ids))
                    or (a.target_kind = 'USER' and public.work_report_current_team(a.target_user_id) = any(v_team_ids))
                    or (a.target_kind = 'USER_SET' and exists (
                      select 1
                        from public.work_report_assignment_targets x
                       where x.assignment_id = a.assignment_id
                         and public.work_report_current_team(x.target_user_id) = any(v_team_ids)
                    ))
                    or (a.target_kind = 'GROUP' and exists (
                      select 1
                        from public.work_report_groups g
                        join public.work_report_group_members gm on gm.group_id = g.group_id
                       where g.group_id = a.target_group_id
                         and g.active
                         and public.work_report_current_team(gm.member_user_id) = any(v_team_ids)
                    ))
                  )
             )
           )
         )
      )
      select jsonb_agg(jsonb_build_object(
        'template_id', t.template_id,
        'template_code', t.template_code,
        'display_name', t.display_name,
        'status', t.status,
        'versions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'version_id', tv.version_id,
            'version_no', tv.version_no,
            'status', tv.status
          ) order by tv.version_no desc, tv.version_id desc)
            from public.work_report_template_versions tv
           where tv.template_id = t.template_id
             and (
               tv.status in ('PUBLISHED', 'ARCHIVED')
               or exists (
                 select 1
                   from public.work_report_obligations o
                  where o.template_version_id = tv.version_id
                    and (v_scope_kind = 'all' or o.snapshot_team_id = any(v_team_ids))
               )
             )
        ), '[]'::jsonb)
      ) order by t.display_name asc, t.template_code asc)
        from scoped_templates st
        join public.work_report_templates t on t.template_id = st.template_id
    ), '[]'::jsonb),
    'teams', coalesce((
      with scoped_teams as (
        select t.team_id,
               t.code,
               t.display_name
          from public.teams t
         where (v_scope_kind = 'all' and t.active)
            or (v_scope_kind = 'team' and t.team_id = any(v_team_ids))
        union
        select o.snapshot_team_id as team_id,
               coalesce(tm.code, max(o.snapshot_team_code), o.snapshot_team_id::text) as code,
               coalesce(
                 tm.display_name,
                 max(o.snapshot_team_display_name),
                 tm.code,
                 max(o.snapshot_team_code),
                 o.snapshot_team_id::text
               ) as display_name
          from public.work_report_obligations o
          left join public.teams tm on tm.team_id = o.snapshot_team_id
         where o.snapshot_team_id is not null
           and (v_scope_kind = 'all' or o.snapshot_team_id = any(v_team_ids))
         group by o.snapshot_team_id, tm.code, tm.display_name
      )
      select jsonb_agg(jsonb_build_object(
        'team_id', st.team_id,
        'code', st.code,
        'display_name', st.display_name
      ) order by st.display_name asc, st.code asc)
        from (
          select team_id, min(code) as code, min(display_name) as display_name
            from scoped_teams
           group by team_id
        ) st
    ), '[]'::jsonb),
    'assignees', coalesce((
      with user_team_links as (
        select u.app_user_id,
               public.work_report_current_team(u.app_user_id) as team_id
          from public.direct_entry_app_users u
         where (
           v_scope_kind = 'all'
           and public.work_report__internal_is_eligible_assignee(u.app_user_id)
         )
         or (
           v_scope_kind = 'team'
           and u.enabled
           and public.work_report_current_team(u.app_user_id) = any(v_team_ids)
         )
        union
        select o.assignee_app_user_id as app_user_id,
               o.snapshot_team_id as team_id
          from public.work_report_obligations o
         where v_scope_kind = 'all'
            or o.snapshot_team_id = any(v_team_ids)
      ),
      grouped_users as (
        select l.app_user_id,
               coalesce(
                 array_agg(distinct l.team_id) filter (where l.team_id is not null),
                 array[]::uuid[]
               ) as team_ids
          from user_team_links l
         group by l.app_user_id
      )
      select jsonb_agg(jsonb_build_object(
        'app_user_id', resolved_assignee.app_user_id,
        'display_name', resolved_assignee.display_name,
        'team_ids', to_jsonb(resolved_assignee.team_ids)
      ) order by resolved_assignee.display_name asc, resolved_assignee.app_user_id asc)
        from (
          select u.app_user_id,
                 coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name,
                 gu.team_ids
            from grouped_users gu
            join public.direct_entry_app_users u on u.app_user_id = gu.app_user_id
        ) resolved_assignee
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.work_report_list_readable_submissions(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid default null,
  p_version_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_team_id uuid default null,
  p_assignee_id uuid default null,
  p_state text default null,
  p_cursor text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_all_scope boolean;
  v_scope_kind text;
  v_scope_label text;
  v_authorized_team_ids uuid[];
  v_filter_team_ids uuid[];
  v_cursor_parts text[];
  v_cursor_submitted_at timestamptz;
  v_cursor_submission_id uuid;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_view');

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'WORK_REPORT_DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  if p_state is not null and p_state not in ('COMPLETED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED') then
    raise exception 'WORK_REPORT_STATE_INVALID' using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'WORK_REPORT_LIMIT_INVALID' using errcode = '22023';
  end if;

  if p_cursor is not null then
    v_cursor_parts := string_to_array(p_cursor, '|');
    if coalesce(cardinality(v_cursor_parts), 0) <> 2
       or v_cursor_parts[1] !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
       or v_cursor_parts[2] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end if;
    begin
      v_cursor_submitted_at := v_cursor_parts[1]::timestamptz;
      v_cursor_submission_id := v_cursor_parts[2]::uuid;
    exception when others then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end;
  end if;

  v_all_scope := public.direct_entry_has_scope(p_app_user_id, 'all');

  if v_all_scope then
    v_scope_kind := 'all';
    v_authorized_team_ids := null;

    if p_team_id is not null then
      select coalesce(t.display_name, t.code)
        into v_scope_label
        from public.teams t
       where t.team_id = p_team_id;
      if not found then
        raise exception 'WORK_REPORT_TEAM_NOT_FOUND' using errcode = 'P0002';
      end if;
      v_filter_team_ids := array[p_team_id];
    else
      v_scope_label := 'Toàn công ty';
      v_filter_team_ids := null;
    end if;

    if p_assignee_id is not null and not exists (
      select 1 from public.direct_entry_app_users u where u.app_user_id = p_assignee_id
    ) then
      raise exception 'WORK_REPORT_ASSIGNEE_NOT_FOUND' using errcode = 'P0002';
    end if;
  else
    select array_agg(s.team_id order by t.code),
           string_agg(coalesce(t.display_name, t.code), ', ' order by t.code)
      into v_authorized_team_ids, v_scope_label
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'team'
       and s.is_current;

    if coalesce(cardinality(v_authorized_team_ids), 0) = 0 then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;

    v_scope_kind := 'team';

    if p_team_id is not null then
      perform public.work_report_assert_scope(p_app_user_id, 'report_view', p_team_id, false);
      if not (p_team_id = any(v_authorized_team_ids)) then
        raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
      end if;
      v_filter_team_ids := array[p_team_id];
      select coalesce(t.display_name, t.code)
        into v_scope_label
        from public.teams t
       where t.team_id = p_team_id;
    else
      v_filter_team_ids := v_authorized_team_ids;
    end if;

    if p_assignee_id is not null then
      if not (
        coalesce(public.work_report_current_team(p_assignee_id) = any(v_filter_team_ids), false)
        or exists (
          select 1
            from public.work_report_obligations o
           where o.assignee_app_user_id = p_assignee_id
             and o.snapshot_team_id = any(v_filter_team_ids)
             and (p_template_id is null or o.template_id = p_template_id)
        )
      ) then
        raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
      end if;
    end if;
  end if;

  if p_template_id is not null and not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_version_id is not null and not exists (
    select 1
      from public.work_report_template_versions tv
     where tv.version_id = p_version_id
       and (p_template_id is null or tv.template_id = p_template_id)
  ) then
    raise exception 'WORK_REPORT_VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  with authorized_obligations as (
    select o.obligation_id,
           o.template_id,
           o.template_version_id,
           o.assignee_app_user_id,
           o.snapshot_team_id,
           o.snapshot_team_code,
           o.snapshot_team_display_name
      from public.work_report_obligations o
     where (v_all_scope or o.snapshot_team_id = any(v_authorized_team_ids))
       and (
         o.obligation_status in ('ACTIVE', 'EXEMPTED')
         or exists (
           select 1
             from public.work_report_submissions s2
            where s2.obligation_id = o.obligation_id
              and s2.current_revision_id is not null
         )
       )
  ),
  scoped_template_versions as (
    select distinct
           ao.template_id,
           tv.version_id,
           tv.version_no,
           tv.status
      from authorized_obligations ao
      join public.work_report_template_versions tv on tv.version_id = ao.template_version_id
  ),
  template_options as (
    select t.template_id,
           t.template_code,
           t.display_name,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'version_id', stv.version_id,
               'version_no', stv.version_no,
               'status', stv.status
             ) order by stv.version_no desc, stv.version_id desc)
               from scoped_template_versions stv
              where stv.template_id = t.template_id
           ), '[]'::jsonb) as versions
      from (select distinct template_id from authorized_obligations) dt
      join public.work_report_templates t on t.template_id = dt.template_id
  ),
  team_options as (
    select ao.snapshot_team_id as team_id,
           coalesce(tm.code, max(ao.snapshot_team_code), ao.snapshot_team_id::text) as code,
           coalesce(
             tm.display_name,
             max(ao.snapshot_team_display_name),
             tm.code,
             max(ao.snapshot_team_code),
             ao.snapshot_team_id::text
           ) as display_name
      from authorized_obligations ao
      left join public.teams tm on tm.team_id = ao.snapshot_team_id
     where ao.snapshot_team_id is not null
     group by ao.snapshot_team_id, tm.code, tm.display_name
  ),
  assignee_options as (
    select distinct
           u.app_user_id,
           coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name
      from authorized_obligations ao
      join public.direct_entry_app_users u on u.app_user_id = ao.assignee_app_user_id
  ),
  fetched as (
    select o.obligation_id,
           s.submission_id,
           o.template_id,
           t.display_name as template_name,
           s.template_version_id,
           tv.version_no as template_version_no,
           o.assignee_app_user_id,
           coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as assignee_display_name,
           o.snapshot_team_id as team_id,
           case
             when o.snapshot_team_id is null then null
             else coalesce(o.snapshot_team_display_name, tm.display_name, o.snapshot_team_code, tm.code)
           end as team_display_name,
           o.period_key,
           o.period_start_date,
           o.period_end_date,
           s.state,
           s.latest_submitted_at,
           s.is_late,
           s.has_post_deadline_amendment,
           rev.revision_no as current_revision_no
      from public.work_report_submissions s
      join public.work_report_obligations o on o.obligation_id = s.obligation_id
      join public.work_report_submission_revisions rev
        on rev.revision_id = s.current_revision_id
       and rev.submission_id = s.submission_id
      join public.work_report_templates t on t.template_id = o.template_id
      join public.work_report_template_versions tv on tv.version_id = s.template_version_id
      join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
      left join public.teams tm on tm.team_id = o.snapshot_team_id
     where s.current_revision_id is not null
       and s.first_submitted_at is not null
       and s.latest_submitted_at is not null
       and s.state in ('COMPLETED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED')
       and (v_filter_team_ids is null or o.snapshot_team_id = any(v_filter_team_ids))
       and (p_template_id is null or o.template_id = p_template_id)
       and (p_version_id is null or s.template_version_id = p_version_id)
       and (p_from is null or o.period_start_date >= p_from)
       and (p_to is null or o.period_start_date <= p_to)
       and (p_assignee_id is null or o.assignee_app_user_id = p_assignee_id)
       and (p_state is null or s.state = p_state)
       and (
         p_cursor is null
         or s.latest_submitted_at < v_cursor_submitted_at
         or (s.latest_submitted_at = v_cursor_submitted_at and s.submission_id < v_cursor_submission_id)
       )
     order by s.latest_submitted_at desc, s.submission_id desc
     limit p_limit + 1
  ),
  page_meta as (
    select (count(*) > p_limit) as has_more
      from fetched
  ),
  page_rows as (
    select *
      from fetched
     order by latest_submitted_at desc, submission_id desc
     limit p_limit
  )
  select jsonb_build_object(
    'effective_scope', jsonb_build_object(
      'kind', v_scope_kind,
      'label', v_scope_label
    ),
    'filter_options', jsonb_build_object(
      'templates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'template_id', topt.template_id,
          'template_code', topt.template_code,
          'display_name', topt.display_name,
          'versions', topt.versions
        ) order by topt.display_name, topt.template_code, topt.template_id)
          from template_options topt
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object(
          'team_id', tmopt.team_id,
          'code', tmopt.code,
          'display_name', tmopt.display_name
        ) order by tmopt.code, tmopt.team_id)
          from team_options tmopt
      ), '[]'::jsonb),
      'assignees', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', aopt.app_user_id,
          'display_name', aopt.display_name
        ) order by aopt.display_name, aopt.app_user_id)
          from assignee_options aopt
      ), '[]'::jsonb)
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'obligation_id', pr.obligation_id,
        'submission_id', pr.submission_id,
        'template_id', pr.template_id,
        'template_name', pr.template_name,
        'template_version_id', pr.template_version_id,
        'template_version_no', pr.template_version_no,
        'assignee_app_user_id', pr.assignee_app_user_id,
        'assignee_display_name', pr.assignee_display_name,
        'team_id', pr.team_id,
        'team_display_name', pr.team_display_name,
        'period_key', pr.period_key,
        'period_start_date', pr.period_start_date::text,
        'period_end_date', pr.period_end_date::text,
        'state', pr.state,
        'latest_submitted_at', pr.latest_submitted_at,
        'is_late', pr.is_late,
        'has_post_deadline_amendment', pr.has_post_deadline_amendment,
        'current_revision_no', pr.current_revision_no
      ) order by pr.latest_submitted_at desc, pr.submission_id desc)
        from page_rows pr
    ), '[]'::jsonb),
    'next_cursor', case
      when pm.has_more then (
        select to_char(pr.latest_submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               || '|' || pr.submission_id::text
          from page_rows pr
         order by pr.latest_submitted_at asc, pr.submission_id asc
         limit 1
      )
      else null
    end,
    'has_more', pm.has_more
  )
    into v_result
    from page_meta pm;

  return v_result;
end;
$function$;

create or replace function public.work_report_list_pending_reviews(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid default null,
  p_cursor text default null,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := statement_timestamp();
  v_limit integer := coalesce(p_page_size, 50);
  v_cursor_parts text[];
  v_has_cursor boolean := false;
  v_cursor_submitted_at timestamptz;
  v_cursor_obligation_id uuid;
  v_items jsonb;
  v_next_cursor text;
  v_has_more boolean := false;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_review', v_as_of) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if v_limit not between 1 and 100 then
    raise exception 'WORK_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  if p_template_id is not null and not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    v_cursor_parts := string_to_array(p_cursor, '|');
    if coalesce(array_length(v_cursor_parts, 1), 0) <> 2 then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end if;
    begin
      if v_cursor_parts[1] !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
        raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
      end if;
      v_cursor_submitted_at := v_cursor_parts[1]::timestamptz;
      v_cursor_obligation_id := v_cursor_parts[2]::uuid;
      v_has_cursor := true;
    exception when others then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end;
  end if;

  with candidate_rows as (
    select o.obligation_id,
           s.submission_id,
           o.template_id,
           t.template_code,
           t.display_name as template_name,
           v.version_no as template_version,
           o.assignee_app_user_id,
           coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as assignee_label,
           o.snapshot_team_id as team_id,
           coalesce(o.snapshot_team_display_name, tm.display_name, o.snapshot_team_code, tm.code, 'Chưa phân nhóm') as team_label,
           o.period_key,
           o.due_at,
           coalesce(s.latest_submitted_at, s.updated_at, s.created_at) as submitted_at,
           s.state,
           s.version
      from public.work_report_obligations o
      join public.work_report_submissions s on s.obligation_id = o.obligation_id
      join public.work_report_templates t on t.template_id = o.template_id
      join public.work_report_template_versions v on v.version_id = o.template_version_id
      join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
      left join public.teams tm on tm.team_id = o.snapshot_team_id
     where o.obligation_status = 'ACTIVE'
       and s.state = 'PENDING_REVIEW'
       and (p_template_id is null or o.template_id = p_template_id)
       and exists (
         select 1
           from public.work_report__internal_resolve_capability_authority(
             p_app_user_id, 'report_review', o.template_id, o.snapshot_team_id, v_as_of
           ) auth
       )
  ),
  window_rows as (
    select c.*
      from candidate_rows c
     where not v_has_cursor
        or c.submitted_at < v_cursor_submitted_at
        or (c.submitted_at = v_cursor_submitted_at and c.obligation_id < v_cursor_obligation_id)
     order by c.submitted_at desc, c.obligation_id desc
     limit (v_limit + 1)
  ),
  page_rows as (
    select *
      from window_rows
     order by submitted_at desc, obligation_id desc
     limit v_limit
  )
  select coalesce((
           select jsonb_agg(jsonb_build_object(
             'obligation_id', pr.obligation_id,
             'submission_id', pr.submission_id,
             'template_id', pr.template_id,
             'template_code', pr.template_code,
             'template_name', pr.template_name,
             'template_version', pr.template_version,
             'assignee_app_user_id', pr.assignee_app_user_id,
             'assignee_label', pr.assignee_label,
             'team_id', pr.team_id,
             'team_label', pr.team_label,
             'period_key', pr.period_key,
             'due_at', pr.due_at,
             'submitted_at', pr.submitted_at,
             'state', pr.state,
             'version', pr.version
           ) order by pr.submitted_at desc, pr.obligation_id desc)
           from page_rows pr
         ), '[]'::jsonb),
         (select count(*) > v_limit from window_rows),
         case
           when (select count(*) > v_limit from window_rows) then (
             select to_char(pr.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || pr.obligation_id::text
               from page_rows pr
              order by pr.submitted_at asc, pr.obligation_id asc
              limit 1
           )
           else null
         end
    into v_items, v_has_more, v_next_cursor;

  return jsonb_build_object(
    'items', v_items,
    'next_cursor', v_next_cursor,
    'has_more', v_has_more
  );
end;
$function$;

create or replace function public.work_report_get_review_submission(
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
  v_scope text;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  select o.* into v_obligation
    from public.work_report_obligations o
   where o.obligation_id = p_obligation_id
      or exists (
        select 1 from public.work_report_submissions s
         where s.submission_id = p_obligation_id
           and s.obligation_id = o.obligation_id
      );
  if not found then
    raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select a.acting_scope_kind into v_scope
    from public.work_report__internal_resolve_capability_authority(
      p_app_user_id, 'report_review', v_obligation.template_id, v_obligation.snapshot_team_id
    ) a;
  if v_scope is null then
    raise exception 'WORK_REPORT_ACCESS_DENIED' using errcode = '42501';
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
      'version', o.version
    ),
    'template', jsonb_build_object(
      'template_id', t.template_id,
      'template_code', t.template_code,
      'display_name', t.display_name,
      'version_id', v.version_id,
      'version_no', v.version_no,
      'schema_json', v.schema_json
    ),
    'submission', case when s.submission_id is null then null else jsonb_build_object(
      'submission_id', s.submission_id,
      'state', s.state,
      'first_submitted_at', s.first_submitted_at,
      'latest_submitted_at', s.latest_submitted_at,
      'is_late', s.is_late,
      'has_post_deadline_amendment', s.has_post_deadline_amendment,
      'current_revision_id', s.current_revision_id,
      'version', s.version
    ) end,
    'current_revision', case when r.revision_id is null then null else jsonb_build_object(
      'revision_id', r.revision_id,
      'revision_no', r.revision_no,
      'payload_json', r.payload_json,
      'created_at', r.created_at
    ) end,
    'assignee_display_name', coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name),
    'team_display_name', coalesce(o.snapshot_team_display_name, tm.display_name, o.snapshot_team_code, tm.code),
    'review_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'review_event_id', re.review_event_id,
        'decision', re.decision,
        'reason', re.reason_text,
        'reviewed_at', re.created_at,
        'reviewer_display_name', coalesce(public.work_report__internal_user_display_name(ru.app_user_id), ru.display_name),
        'revision_no', rr.revision_no
      ) order by re.created_at desc, re.review_event_id desc)
        from public.work_report_review_events re
        join public.direct_entry_app_users ru on ru.app_user_id = re.reviewer_user_id
        left join public.work_report_submission_revisions rr on rr.revision_id = re.revision_id
       where re.submission_id = s.submission_id
    ), '[]'::jsonb)
  ) into v_result
    from public.work_report_obligations o
    join public.work_report_templates t on t.template_id = o.template_id
    join public.work_report_template_versions v on v.version_id = o.template_version_id
    join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
    left join public.teams tm on tm.team_id = o.snapshot_team_id
    left join public.work_report_submissions s on s.obligation_id = o.obligation_id
    left join public.work_report_submission_revisions r on r.revision_id = s.current_revision_id
   where o.obligation_id = v_obligation.obligation_id;

  return v_result;
end;
$function$;

create or replace function public.work_report_list_delegations(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_all_scope boolean;
  v_as_of timestamptz := statement_timestamp();
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');
  v_all_scope := public.direct_entry_has_scope(p_app_user_id, 'all');

  if not v_all_scope and not exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'team'
       and s.is_current
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'delegation_id', d.delegation_id,
        'grantor_user_id', d.grantor_user_id,
        'grantor_display_name', coalesce(public.work_report__internal_user_display_name(gu.app_user_id), gu.display_name),
        'capability', d.capability,
        'delegate_app_user_id', d.delegate_app_user_id,
        'delegate_display_name', coalesce(public.work_report__internal_user_display_name(du.app_user_id), du.display_name),
        'template_id', d.template_id,
        'template_code', t.template_code,
        'template_name', t.display_name,
        'template_version_id', d.template_version_id,
        'scope_kind', d.scope_kind,
        'scope_id', d.scope_team_id,
        'scope_team_id', d.scope_team_id,
        'scope_label', case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end,
        'effective_from', d.effective_from,
        'effective_to', d.effective_to,
        'state', d.state,
        'status', case
          when d.state = 'REVOKED' or not d.is_current then 'REVOKED'
          when v_as_of > d.effective_to then 'EXPIRED'
          else 'ACTIVE'
        end,
        'is_current', d.is_current,
        'version', d.version,
        'created_at', d.created_at
      ) order by d.created_at desc, d.delegation_id desc)
        from public.work_report_delegations d
        join public.direct_entry_app_users gu on gu.app_user_id = d.grantor_user_id
        join public.direct_entry_app_users du on du.app_user_id = d.delegate_app_user_id
        join public.work_report_templates t on t.template_id = d.template_id
        left join public.teams tm on tm.team_id = d.scope_team_id
       where v_all_scope
          or d.grantor_user_id = p_app_user_id
          or (
            d.scope_kind = 'team'
            and exists (
              select 1
                from public.direct_entry_scope_grants s
                join public.teams scoped_team on scoped_team.team_id = s.team_id and scoped_team.active
               where s.app_user_id = p_app_user_id
                 and s.scope_kind = 'team'
                 and s.team_id = d.scope_team_id
                 and s.is_current
            )
          )
    ), '[]'::jsonb),
    'options', jsonb_build_object(
      'delegates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', del_opt.app_user_id,
          'display_name', del_opt.display_name
        ) order by del_opt.display_name, del_opt.app_user_id)
          from (
            select u.app_user_id,
                   coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name
              from public.direct_entry_app_users u
             where u.enabled
               and u.app_user_id <> p_app_user_id
               and (
                 v_all_scope
                 or exists (
                   select 1
                     from public.direct_entry_scope_grants s
                     join public.teams scoped_team on scoped_team.team_id = s.team_id and scoped_team.active
                    where s.app_user_id = p_app_user_id
                      and s.scope_kind = 'team'
                      and s.is_current
                      and s.team_id = public.work_report_current_team(u.app_user_id)
                 )
               )
          ) del_opt
      ), '[]'::jsonb),
      'templates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'template_id', t.template_id,
          'version_id', t.current_published_version_id,
          'name', t.display_name,
          'template_code', t.template_code,
          'display_name', t.display_name
        ) order by t.template_code)
          from public.work_report_templates t
         where t.status = 'ACTIVE'
           and t.current_published_version_id is not null
      ), '[]'::jsonb),
      'scopes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'scope_kind', sc.scope_kind,
          'scope_id', sc.scope_id,
          'label', sc.label
        ) order by sc.sort_order, sc.label)
          from (
            select 0 as sort_order, 'all'::text as scope_kind, null::uuid as scope_id, 'Toàn công ty'::text as label
             where v_all_scope
            union all
            select 1 as sort_order, 'team'::text as scope_kind, t.team_id as scope_id, coalesce(t.display_name, t.code) as label
              from public.teams t
             where t.active
               and (
                 v_all_scope
                 or exists (
                   select 1
                     from public.direct_entry_scope_grants s
                    where s.app_user_id = p_app_user_id
                      and s.scope_kind = 'team'
                      and s.team_id = t.team_id
                      and s.is_current
                 )
               )
          ) sc
      ), '[]'::jsonb),
      'capabilities', coalesce((
        select jsonb_agg(cap order by cap)
          from unnest(array['report_assign', 'report_review']::text[]) as cap
         where public.work_report__internal_has_direct_capability(p_app_user_id, cap)
      ), '[]'::jsonb)
    )
  );
end;
$function$;

create or replace function public.work_report_analytics_breakdown(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_version_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_team_id uuid default null,
  p_assignee_id uuid default null,
  p_finality text default 'final',
  p_group_by text default 'team',
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_label text;
  v_team_ids uuid[];
  v_as_of timestamptz := statement_timestamp();
  v_finality text := coalesce(p_finality, 'final');
  v_include_provisional boolean := false;
  v_offset integer;
  v_total_groups integer := 0;
  v_items jsonb;
begin
  select s.scope_kind, s.scope_label, s.authorized_team_ids
    into v_scope_kind, v_scope_label, v_team_ids
    from public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, false, p_team_id, p_assignee_id, p_template_id
    ) s;

  if p_template_id is null or not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_version_id is not null and not exists (
    select 1 from public.work_report_template_versions v
     where v.version_id = p_version_id and v.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'WORK_REPORT_DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  if v_finality not in ('final', 'provisional_included') then
    raise exception 'WORK_REPORT_FINALITY_INVALID' using errcode = '22023';
  end if;
  v_include_provisional := (v_finality = 'provisional_included');

  if p_group_by is null or p_group_by not in ('team', 'assignee', 'period') then
    raise exception 'WORK_REPORT_GROUP_BY_INVALID' using errcode = '22023';
  end if;

  if p_page is null or p_page not between 1 and 1000
     or p_page_size is null or p_page_size not between 1 and 100 then
    raise exception 'WORK_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  v_offset := (p_page - 1) * p_page_size;

  with scoped_obligations as (
    select o.obligation_id,
           o.template_version_id,
           o.assignee_app_user_id,
           coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as assignee_display_name,
           o.snapshot_team_id,
           coalesce(o.snapshot_team_display_name, t.display_name, o.snapshot_team_code, t.code, 'Chưa phân nhóm') as team_display_name,
           coalesce(o.snapshot_team_code, t.code, '') as team_code,
           o.period_key,
           o.period_start_date,
           o.due_at,
           o.obligation_status,
           s.submission_id,
           s.current_revision_id,
           s.state as submission_state,
           coalesce(s.is_late, false) as is_late,
           case p_group_by
             when 'team' then o.snapshot_team_id::text
             when 'assignee' then o.assignee_app_user_id::text
             else o.period_key
           end as group_id,
           case p_group_by
             when 'team' then coalesce(o.snapshot_team_display_name, t.display_name, o.snapshot_team_code, t.code, 'Chưa phân nhóm')
             when 'assignee' then coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name, o.assignee_app_user_id::text)
             else o.period_key
           end as group_label,
           case p_group_by
             when 'team' then coalesce(o.snapshot_team_code, t.code, '')
             when 'assignee' then coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name, '')
             else o.period_start_date::text || ':' || o.period_key
           end as group_sort
      from public.work_report_obligations o
      join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
      left join public.teams t on t.team_id = o.snapshot_team_id
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
     where o.template_id = p_template_id
       and o.obligation_status in ('ACTIVE', 'EXEMPTED')
       and (p_version_id is null or o.template_version_id = p_version_id)
       and (p_from is null or o.period_start_date >= p_from)
       and (p_to is null or o.period_start_date <= p_to)
       and (v_team_ids is null or o.snapshot_team_id = any(v_team_ids))
       and (p_assignee_id is null or o.assignee_app_user_id = p_assignee_id)
  ),
  version_metrics as (
    select v.version_id,
           v.version_no,
           (s.ordinality * 1000 + f.ordinality)::int as sort_key,
           f.value ->> 'field_key' as field_key,
           f.value ->> 'field_type' as field_type,
           f.value ->> 'label' as field_label,
           f.value -> 'metric_spec' ->> 'metric_key' as metric_key,
           f.value -> 'metric_spec' ->> 'unit' as unit,
           f.value -> 'metric_spec' ->> 'compatible_group' as compatible_group
      from public.work_report_template_versions v
      cross join lateral jsonb_array_elements(v.schema_json -> 'sections') with ordinality as s(value, ordinality)
      cross join lateral jsonb_array_elements(s.value -> 'fields') with ordinality as f(value, ordinality)
     where v.template_id = p_template_id
       and (f.value ->> 'is_metric')::boolean
       and (
         (p_version_id is not null and v.version_id = p_version_id)
         or (
           p_version_id is null
           and (
             exists (select 1 from scoped_obligations so where so.template_version_id = v.version_id)
             or (
               not exists (select 1 from scoped_obligations)
               and v.version_id = coalesce(
                 (select t.current_published_version_id from public.work_report_templates t where t.template_id = p_template_id),
                 (select v2.version_id from public.work_report_template_versions v2 where v2.template_id = p_template_id order by v2.version_no desc limit 1)
               )
             )
           )
         )
       )
  ),
  metric_groups as (
    select vm.metric_key,
           vm.unit,
           vm.compatible_group,
           (array_agg(vm.field_type order by vm.version_no desc))[1] as field_type,
           (array_agg(vm.field_label order by vm.version_no desc))[1] as base_label,
           min(vm.sort_key)::int as sort_key,
           min(vm.version_no)::int as min_version_no,
           max(vm.version_no)::int as max_version_no,
           array_agg(distinct vm.version_id) as version_ids,
           count(*) over (partition by vm.metric_key)::int as variants_for_metric_key
      from version_metrics vm
     group by vm.metric_key, vm.unit, vm.compatible_group
  ),
  grouped_base as (
    select so.group_id,
           max(so.group_label) as group_label,
           max(so.group_sort) as group_sort,
           count(*) filter (where so.obligation_status = 'ACTIVE')::int as due_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and so.submission_state in ('COMPLETED', 'APPROVED'))::int as completed_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and so.submission_state in ('COMPLETED', 'APPROVED') and not so.is_late)::int as on_time_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and so.submission_state in ('COMPLETED', 'APPROVED') and so.is_late)::int as late_submitted_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and coalesce(so.submission_state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT', 'REJECTED') and v_as_of <= so.due_at)::int as pending_due_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and coalesce(so.submission_state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT', 'REJECTED') and v_as_of > so.due_at)::int as overdue_missing_count,
           count(*) filter (where so.obligation_status = 'EXEMPTED')::int as exempted_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and so.submission_state = 'PENDING_REVIEW')::int as pending_review_count
      from scoped_obligations so
     group by so.group_id
  ),
  paged_groups as (
    select gb.*,
           count(*) over ()::int as total_groups
      from grouped_base gb
     order by
       case when p_group_by = 'period' then gb.group_sort end desc,
       case when p_group_by <> 'period' then gb.group_sort end asc,
       gb.group_id asc nulls last
     offset v_offset
     limit p_page_size
  ),
  enriched_groups as (
    select pg.*,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'metric_key', mg.metric_key,
               'label', case
                 when mg.variants_for_metric_key > 1 then
                   case
                     when mg.min_version_no = mg.max_version_no then format('%s (v%s)', mg.base_label, mg.max_version_no)
                     else format('%s (v%s-v%s)', mg.base_label, mg.min_version_no, mg.max_version_no)
                   end
                 else mg.base_label
               end,
               'unit', mg.unit,
               'compatible_group', mg.compatible_group,
               'sum_value', stats.sum_value,
               'avg_value', stats.avg_value,
               'min_value', stats.min_value,
               'max_value', stats.max_value,
               'count_valid', stats.count_valid,
               'missing_value_count', greatest(completed_obs.completed_for_group - stats.count_valid, 0)::int
             ) order by mg.sort_key, mg.metric_key, mg.max_version_no, mg.compatible_group)
               from metric_groups mg
               cross join lateral (
                 select count(*)::int as completed_for_group
                   from scoped_obligations so
                  where so.group_id is not distinct from pg.group_id
                    and so.obligation_status = 'ACTIVE'
                    and (
                      so.submission_state in ('COMPLETED', 'APPROVED')
                      or (v_include_provisional and so.submission_state = 'PENDING_REVIEW')
                    )
                    and so.template_version_id = any(mg.version_ids)
               ) completed_obs
               cross join lateral (
                 select case
                          when mg.field_type in ('integer', 'decimal') then
                            case when count(mv.numeric_value) = 0 then null else trim_scale(round(sum(mv.numeric_value), 4)) end
                          when mg.field_type = 'boolean' then
                            case when count(mv.boolean_value) = 0 then null else (count(distinct mv.submission_id) filter (where mv.boolean_value = true))::numeric end
                          else
                            case when count(mv.option_key) = 0 then null else (count(distinct mv.submission_id) filter (where mv.option_key is not null))::numeric end
                        end as sum_value,
                        case
                          when mg.field_type in ('integer', 'decimal') then
                            case when count(mv.numeric_value) = 0 then null else trim_scale(round(avg(mv.numeric_value), 2)) end
                          when mg.field_type = 'boolean' then
                            case
                              when count(distinct mv.submission_id) filter (where mv.boolean_value is not null) = 0 then null
                              else trim_scale(round(
                                (count(distinct mv.submission_id) filter (where mv.boolean_value = true)::numeric * 100.0)
                                / count(distinct mv.submission_id) filter (where mv.boolean_value is not null)::numeric,
                                2
                              ))
                            end
                          else null
                        end as avg_value,
                        case
                          when mg.field_type in ('integer', 'decimal') and count(mv.numeric_value) > 0 then
                            trim_scale(round(min(mv.numeric_value), 4))
                          else null
                        end as min_value,
                        case
                          when mg.field_type in ('integer', 'decimal') and count(mv.numeric_value) > 0 then
                            trim_scale(round(max(mv.numeric_value), 4))
                          else null
                        end as max_value,
                        case
                          when mg.field_type in ('integer', 'decimal') then
                            (count(distinct mv.submission_id) filter (where mv.numeric_value is not null))::int
                          when mg.field_type = 'boolean' then
                            (count(distinct mv.submission_id) filter (where mv.boolean_value is not null))::int
                          else
                            (count(distinct mv.submission_id) filter (where mv.option_key is not null))::int
                        end as count_valid
                   from scoped_obligations so
                   join public.work_report_metric_values mv
                     on mv.obligation_id = so.obligation_id
                    and mv.submission_id = so.submission_id
                    and mv.revision_id = so.current_revision_id
                  where so.group_id is not distinct from pg.group_id
                    and so.obligation_status = 'ACTIVE'
                    and (
                      so.submission_state in ('COMPLETED', 'APPROVED')
                      or (v_include_provisional and so.submission_state = 'PENDING_REVIEW')
                    )
                    and mv.is_eligible = true
                    and (mv.is_final = true or (v_include_provisional and mv.is_provisional = true))
                    and mv.metric_key = mg.metric_key
                    and mv.unit = mg.unit
                    and mv.compatible_group = mg.compatible_group
               ) stats
           ), '[]'::jsonb) as metrics
      from paged_groups pg
  )
  select coalesce(max(eg.total_groups), 0)::int,
         coalesce(jsonb_agg(jsonb_build_object(
           'group_id', eg.group_id,
           'group_label', eg.group_label,
           'due_count', eg.due_count,
           'completed_count', eg.completed_count,
           'on_time_count', eg.on_time_count,
           'late_submitted_count', eg.late_submitted_count,
           'pending_due_count', eg.pending_due_count,
           'overdue_missing_count', eg.overdue_missing_count,
           'exempted_count', eg.exempted_count,
           'pending_review_count', eg.pending_review_count,
           'completion_rate', case
             when eg.due_count = 0 then null
             else trim_scale(round((eg.completed_count::numeric * 100.0) / eg.due_count::numeric, 2))
           end,
           'metrics', eg.metrics
         )), '[]'::jsonb)
    into v_total_groups, v_items
    from enriched_groups eg;

  return jsonb_build_object(
    'as_of', to_char(v_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effective_scope', jsonb_build_object('kind', v_scope_kind, 'label', v_scope_label),
    'group_by', p_group_by,
    'page', p_page,
    'page_size', p_page_size,
    'total_groups', v_total_groups,
    'items', v_items
  );
end;
$function$;

create or replace function public.work_report_analytics_contributions(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_version_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_team_id uuid default null,
  p_assignee_id uuid default null,
  p_finality text default 'final',
  p_metric_key text default null,
  p_compatible_group text default null,
  p_target_team_id uuid default null,
  p_target_assignee_id uuid default null,
  p_target_period_key text default null,
  p_cursor text default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_label text;
  v_team_ids uuid[];
  v_as_of timestamptz := statement_timestamp();
  v_finality text := coalesce(p_finality, 'final');
  v_include_provisional boolean := false;
  v_effective_team_filter uuid := coalesce(p_target_team_id, p_team_id);
  v_cursor_parts text[];
  v_has_cursor boolean := false;
  v_cursor_has_submitted_at boolean := false;
  v_cursor_submitted_at timestamptz;
  v_cursor_period_start_date date;
  v_cursor_obligation_id uuid;
  v_items jsonb;
  v_next_cursor text;
begin
  select s.scope_kind, s.scope_label, s.authorized_team_ids
    into v_scope_kind, v_scope_label, v_team_ids
    from public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, true, p_team_id, p_assignee_id, p_template_id
    ) s;

  if p_target_team_id is not null then
    perform public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, true, p_target_team_id, null, p_template_id
    );
    if p_team_id is not null and p_team_id <> p_target_team_id then
      v_team_ids := array[]::uuid[];
    else
      v_team_ids := array[p_target_team_id];
    end if;
  end if;

  if p_target_assignee_id is not null then
    perform public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, true, v_effective_team_filter, p_target_assignee_id, p_template_id
    );
  end if;

  if p_template_id is null or not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_version_id is not null and not exists (
    select 1 from public.work_report_template_versions v
     where v.version_id = p_version_id and v.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'WORK_REPORT_DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  if v_finality not in ('final', 'provisional_included') then
    raise exception 'WORK_REPORT_FINALITY_INVALID' using errcode = '22023';
  end if;
  v_include_provisional := (v_finality = 'provisional_included');

  if p_metric_key is not null and p_metric_key !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'WORK_REPORT_METRIC_INVALID' using errcode = '22023';
  end if;

  if p_compatible_group is not null and p_compatible_group !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'WORK_REPORT_METRIC_INVALID' using errcode = '22023';
  end if;

  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'WORK_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    v_cursor_parts := string_to_array(p_cursor, '|');
    if coalesce(array_length(v_cursor_parts, 1), 0) <> 3 then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end if;
    begin
      if v_cursor_parts[1] = 'null' then
        v_cursor_submitted_at := null;
        v_cursor_has_submitted_at := false;
      else
        if v_cursor_parts[1] !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
          raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
        end if;
        v_cursor_submitted_at := v_cursor_parts[1]::timestamptz;
        v_cursor_has_submitted_at := true;
      end if;
      if v_cursor_parts[2] !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
      end if;
      v_cursor_period_start_date := v_cursor_parts[2]::date;
      v_cursor_obligation_id := v_cursor_parts[3]::uuid;
      v_has_cursor := true;
    exception when others then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end;
  end if;

  with candidate_rows as (
    select o.obligation_id,
           s.submission_id,
           r.revision_no,
           o.assignee_app_user_id,
           coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as assignee_display_name,
           o.snapshot_team_id,
           coalesce(o.snapshot_team_display_name, t.display_name, o.snapshot_team_code, t.code) as team_display_name,
           o.period_key,
           o.period_start_date,
           coalesce(s.state, 'NOT_STARTED') as state,
           s.latest_submitted_at as submitted_at,
           coalesce(s.is_late, false) as is_late,
           coalesce(s.has_post_deadline_amendment, false) as has_post_deadline_amendment,
           metric_contrib.metric_contribution_value
      from public.work_report_obligations o
      join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
      left join public.teams t on t.team_id = o.snapshot_team_id
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
      left join public.work_report_submission_revisions r on r.revision_id = s.current_revision_id
      left join lateral (
        select case
                 when max(mv.value_type) in ('INTEGER', 'DECIMAL') then trim_scale(round(sum(mv.numeric_value), 4))
                 when max(mv.value_type) = 'BOOLEAN' then case when bool_or(mv.boolean_value) then 1::numeric else 0::numeric end
                 else 1::numeric
               end as metric_contribution_value,
               count(*)::int as matched_rows
          from public.work_report_metric_values mv
         where p_metric_key is not null
           and mv.obligation_id = o.obligation_id
           and mv.submission_id = s.submission_id
           and mv.revision_id = s.current_revision_id
           and mv.is_eligible = true
           and (mv.is_final = true or (v_include_provisional and mv.is_provisional = true))
           and mv.metric_key = p_metric_key
           and (p_compatible_group is null or mv.compatible_group = p_compatible_group)
           and (
             (mv.value_type in ('INTEGER', 'DECIMAL') and mv.numeric_value is not null)
             or (mv.value_type = 'BOOLEAN' and mv.boolean_value is not null)
             or (mv.value_type in ('SINGLE_SELECT', 'MULTI_SELECT') and mv.option_key is not null)
           )
      ) metric_contrib on true
     where o.template_id = p_template_id
       and o.obligation_status = 'ACTIVE'
       and (p_version_id is null or o.template_version_id = p_version_id)
       and (p_from is null or o.period_start_date >= p_from)
       and (p_to is null or o.period_start_date <= p_to)
       and (v_team_ids is null or o.snapshot_team_id = any(v_team_ids))
       and (p_assignee_id is null or o.assignee_app_user_id = p_assignee_id)
       and (p_target_assignee_id is null or o.assignee_app_user_id = p_target_assignee_id)
       and (p_target_period_key is null or o.period_key = p_target_period_key)
       and (
         p_metric_key is null
         or (
           (
             s.state in ('COMPLETED', 'APPROVED')
             or (v_include_provisional and s.state = 'PENDING_REVIEW')
           )
           and coalesce(metric_contrib.matched_rows, 0) > 0
         )
       )
  ),
  window_rows as (
    select c.*
      from candidate_rows c
     where not v_has_cursor
        or (
          v_cursor_has_submitted_at
          and (
            c.submitted_at is null
            or c.submitted_at < v_cursor_submitted_at
            or (
              c.submitted_at = v_cursor_submitted_at
              and (
                c.period_start_date < v_cursor_period_start_date
                or (c.period_start_date = v_cursor_period_start_date and c.obligation_id < v_cursor_obligation_id)
              )
            )
          )
        )
        or (
          not v_cursor_has_submitted_at
          and c.submitted_at is null
          and (
            c.period_start_date < v_cursor_period_start_date
            or (c.period_start_date = v_cursor_period_start_date and c.obligation_id < v_cursor_obligation_id)
          )
        )
     order by c.submitted_at desc nulls last, c.period_start_date desc, c.obligation_id desc
     limit (p_limit + 1)
  ),
  page_rows as (
    select *
      from window_rows
     order by submitted_at desc nulls last, period_start_date desc, obligation_id desc
     limit p_limit
  )
  select coalesce((
           select jsonb_agg(jsonb_build_object(
             'obligation_id', pr.obligation_id,
             'submission_id', pr.submission_id,
             'revision_no', pr.revision_no,
             'assignee_app_user_id', pr.assignee_app_user_id,
             'assignee_display_name', pr.assignee_display_name,
             'snapshot_team_id', pr.snapshot_team_id,
             'team_display_name', pr.team_display_name,
             'period_key', pr.period_key,
             'state', pr.state,
             'submitted_at', pr.submitted_at,
             'is_late', pr.is_late,
             'has_post_deadline_amendment', pr.has_post_deadline_amendment,
             'metric_contribution_value', pr.metric_contribution_value
           ) order by pr.submitted_at desc nulls last, pr.period_start_date desc, pr.obligation_id desc)
           from page_rows pr
         ), '[]'::jsonb),
         case
           when (select count(*) from window_rows) > p_limit then (
             select case
                      when pr.submitted_at is null then 'null'
                      else to_char(pr.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                    end || '|' || pr.period_start_date::text || '|' || pr.obligation_id::text
               from page_rows pr
              order by pr.submitted_at asc nulls first, pr.period_start_date asc, pr.obligation_id asc
              limit 1
           )
           else null
         end
    into v_items, v_next_cursor;

  return jsonb_build_object(
    'as_of', to_char(v_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effective_scope', jsonb_build_object('kind', v_scope_kind, 'label', v_scope_label),
    'next_cursor', v_next_cursor,
    'items', v_items
  );
end;
$function$;

comment on function public.work_report_list_readable_submissions(
  uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer
) is
  'Service-role-only reader contract for Work Reports submitted reports. Reporting-period filters p_from/p_to apply inclusive bounds on work_report_obligations.period_start_date.';

-- -----------------------------------------------------------------------------
-- 5. Align routine ownership with canonical Work Reports owner.
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
    'public.work_report__internal_user_display_name(uuid)',
    'public.work_report_list_groups(uuid, uuid)',
    'public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)',
    'public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)',
    'public.work_report_list_assignment_options(uuid, uuid, uuid)',
    'public.work_report_list_assignments(uuid, uuid, uuid)',
    'public.work_report_get_assignment_detail(uuid, uuid, uuid)',
    'public.work_report_analytics_filter_options(uuid, uuid)',
    'public.work_report_list_readable_submissions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer)',
    'public.work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)',
    'public.work_report_get_review_submission(uuid, uuid, uuid)',
    'public.work_report_list_delegations(uuid, uuid)',
    'public.work_report_analytics_breakdown(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer, integer)',
    'public.work_report_analytics_contributions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, text, uuid, uuid, text, text, integer)'
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
-- 6. Strict function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on function public.work_report__internal_user_display_name(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.work_report_list_groups(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_groups(uuid, uuid)
  to service_role;

revoke all on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  to service_role;

revoke all on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  to service_role;

revoke all on function public.work_report_list_assignment_options(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_assignment_options(uuid, uuid, uuid)
  to service_role;

revoke all on function public.work_report_list_assignments(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_assignments(uuid, uuid, uuid)
  to service_role;

revoke all on function public.work_report_get_assignment_detail(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_get_assignment_detail(uuid, uuid, uuid)
  to service_role;

revoke all on function public.work_report_analytics_filter_options(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_analytics_filter_options(uuid, uuid)
  to service_role;

revoke all on function public.work_report_list_readable_submissions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_readable_submissions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer)
  to service_role;

revoke all on function public.work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)
  to service_role;

revoke all on function public.work_report_get_review_submission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_get_review_submission(uuid, uuid, uuid)
  to service_role;

revoke all on function public.work_report_list_delegations(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_delegations(uuid, uuid)
  to service_role;

revoke all on function public.work_report_analytics_breakdown(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_analytics_breakdown(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer, integer)
  to service_role;

revoke all on function public.work_report_analytics_contributions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, text, uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_analytics_contributions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, text, uuid, uuid, text, text, integer)
  to service_role;

-- -----------------------------------------------------------------------------
-- 7. Install-time fail-closed catalog & ACL self-check.
-- -----------------------------------------------------------------------------
do $check_hf_work_reports_group_assignment_eligible_members$
declare
  v_internal_fn pg_catalog.regprocedure;
  v_rpc_fn pg_catalog.regprocedure;
  v_secdef boolean;
  v_config text;
  v_owner_bypasses_rls boolean;
begin
  foreach v_internal_fn in array array[
    'public.work_report__internal_user_display_name(uuid)'::pg_catalog.regprocedure
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
    'public.work_report_list_groups(uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)'::pg_catalog.regprocedure,
    'public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)'::pg_catalog.regprocedure,
    'public.work_report_list_assignment_options(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_list_assignments(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_get_assignment_detail(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_analytics_filter_options(uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_list_readable_submissions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer)'::pg_catalog.regprocedure,
    'public.work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)'::pg_catalog.regprocedure,
    'public.work_report_get_review_submission(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_list_delegations(uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_analytics_breakdown(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer, integer)'::pg_catalog.regprocedure,
    'public.work_report_analytics_contributions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, text, uuid, uuid, text, text, integer)'::pg_catalog.regprocedure
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
