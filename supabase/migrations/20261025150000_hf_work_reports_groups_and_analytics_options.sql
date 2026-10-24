-- Hotfix Work Reports:
--   1. Reusable cross-team custom report groups (`work_report_groups`, `work_report_group_members`)
--      and `target_kind = 'GROUP'` assignment lifecycle (create, list/tracking, pause/resume/revoke,
--      obligation materialization with team + group snapshots and fail-closed scope checks).
--   2. Dedicated server-scoped analytics filter options (`work_report_analytics_filter_options`)
--      gated strictly by `report_analytics_view` (including canonical Full Admin read closure)
--      without requiring `report_view` or `report_assign`.

begin;

-- -----------------------------------------------------------------------------
-- 1. Custom Report Group catalog & membership tables (not administrative Teams
--    or Departments; grants zero capabilities or data scopes).
-- -----------------------------------------------------------------------------
create table public.work_report_groups (
  group_id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) between 1 and 160),
  description text check (description is null or length(description) <= 1000),
  active boolean not null default true,
  created_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  updated_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index work_report_groups_active_updated_idx
  on public.work_report_groups (active, updated_at desc, group_id);

create trigger work_report_groups_no_delete
  before delete on public.work_report_groups
  for each row execute function public.work_report_immutable_guard();

create table public.work_report_group_members (
  group_id uuid not null references public.work_report_groups(group_id) on delete restrict,
  member_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  added_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (group_id, member_user_id)
);

create index work_report_group_members_user_idx
  on public.work_report_group_members (member_user_id, group_id);

alter table public.work_report_groups enable row level security;
alter table public.work_report_groups force row level security;
alter table public.work_report_group_members enable row level security;
alter table public.work_report_group_members force row level security;

-- -----------------------------------------------------------------------------
-- 2. Extend `work_report_assignments` (`target_kind = 'GROUP'`) and
--    `work_report_obligations` (`snapshot_group_id`, `snapshot_group_name`).
-- -----------------------------------------------------------------------------
alter table public.work_report_assignments
  add column if not exists target_group_id uuid references public.work_report_groups(group_id) on delete restrict;

do $update_assignment_target_constraints$
declare
  v_con record;
begin
  for v_con in
    select c.conname
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.work_report_assignments'::pg_catalog.regclass
       and c.contype = 'c'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%target_kind%'
  loop
    execute pg_catalog.format(
      'alter table public.work_report_assignments drop constraint %I',
      v_con.conname
    );
  end loop;
end;
$update_assignment_target_constraints$;

alter table public.work_report_assignments
  add constraint work_report_assignments_target_kind_check
  check (target_kind in ('USER', 'TEAM', 'USER_SET', 'GROUP'));

alter table public.work_report_assignments
  add constraint work_report_assignments_target_shape_check
  check (
    (target_kind = 'USER' and target_user_id is not null and target_team_id is null and target_group_id is null) or
    (target_kind = 'TEAM' and target_team_id is not null and target_user_id is null and target_group_id is null) or
    (target_kind = 'USER_SET' and target_user_id is null and target_team_id is null and target_group_id is null) or
    (target_kind = 'GROUP' and target_group_id is not null and target_user_id is null and target_team_id is null)
  );

create unique index if not exists work_report_assignments_group_current_idx
  on public.work_report_assignments (template_id, target_group_id)
  where is_current and target_kind = 'GROUP';

create index if not exists work_report_assignments_group_current_lookup_idx
  on public.work_report_assignments (target_group_id, is_current);

alter table public.work_report_obligations
  add column if not exists snapshot_group_id uuid references public.work_report_groups(group_id) on delete restrict,
  add column if not exists snapshot_group_name text;

-- -----------------------------------------------------------------------------
-- 3. Internal eligibility & member-scope helpers (never exposed to runtime roles).
-- -----------------------------------------------------------------------------
create or replace function public.work_report__internal_is_eligible_assignee(
  p_app_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_current_link_count integer;
  v_valid_link_count integer;
begin
  if p_app_user_id is null then
    return false;
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
      join auth.users au on au.id = u.auth_subject
     where u.app_user_id = p_app_user_id
       and u.enabled
  ) then
    return false;
  end if;

  select count(*)::integer,
         count(*) filter (where l.verified and r.active)::integer
    into v_current_link_count, v_valid_link_count
    from public.direct_entry_app_user_recruiter_links l
    left join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.app_user_id = p_app_user_id
     and l.is_current;

  if v_current_link_count > 0 then
    if v_current_link_count <> 1 or v_valid_link_count <> 1 then
      return false;
    end if;
    return public.work_report_current_team(p_app_user_id) is not null;
  end if;

  return true;
end;
$function$;

create or replace function public.work_report__internal_actor_can_assign_member(
  p_app_user_id uuid,
  p_member_user_id uuid,
  p_template_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_member_team_id uuid;
  v_direct_cap boolean;
begin
  if p_app_user_id is null or p_member_user_id is null then
    return false;
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_member_user_id
  ) then
    return false;
  end if;

  v_member_team_id := public.work_report_current_team(p_member_user_id);

  if p_template_id is not null then
    return exists (
      select 1
        from public.work_report__internal_resolve_capability_authority(
          p_app_user_id,
          'report_assign',
          p_template_id,
          v_member_team_id
        )
    );
  end if;

  v_direct_cap := public.work_report__internal_has_direct_capability(p_app_user_id, 'report_assign');

  if v_direct_cap and public.direct_entry_has_scope(p_app_user_id, 'all') then
    return true;
  end if;

  if exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'all'
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  ) then
    return true;
  end if;

  if v_member_team_id is null then
    return false;
  end if;

  if v_direct_cap and exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = v_member_team_id
       and s.is_current
  ) then
    return true;
  end if;

  if exists (
    select 1
      from public.work_report_delegations d
      join public.teams t on t.team_id = d.scope_team_id and t.active
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'team'
       and d.scope_team_id = v_member_team_id
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  ) then
    return true;
  end if;

  return false;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Custom Report Group management & assignment RPCs.
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
            'app_user_id', u.app_user_id,
            'display_name', u.display_name,
            'enabled', u.enabled,
            'team_id', tm.team_id,
            'team_code', tm.code,
            'team_display_name', tm.display_name
          ) order by u.display_name, u.app_user_id)
            from public.work_report_group_members gm
            join public.direct_entry_app_users u on u.app_user_id = gm.member_user_id
            left join public.teams tm on tm.team_id = public.work_report_current_team(u.app_user_id)
           where gm.group_id = g.group_id
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
                 u.display_name,
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

create or replace function public.work_report_create_group(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_display_name text,
  p_description text,
  p_member_user_ids uuid[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_name text;
  v_description text;
  v_distinct_count integer;
  v_group_id uuid;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_name := pg_catalog.btrim(coalesce(p_display_name, ''));
  v_description := case
    when p_description is null then null
    else nullif(pg_catalog.btrim(p_description), '')
  end;

  if pg_catalog.length(v_name) not between 1 and 160
     or (v_description is not null and pg_catalog.length(v_description) > 1000)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128
     or coalesce(cardinality(p_member_user_ids), 0) < 1
     or exists (select 1 from unnest(p_member_user_ids) as x(uid) where x.uid is null) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select count(distinct x.uid)::integer
    into v_distinct_count
    from unnest(p_member_user_ids) as x(uid);
  if v_distinct_count <> cardinality(p_member_user_ids) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_actor_can_assign_member(p_app_user_id, x.uid, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_is_eligible_assignee(x.uid)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'display_name', v_name,
    'description', v_description,
    'member_user_ids', (
      select jsonb_agg(x.uid order by x.uid)
        from unnest(p_member_user_ids) as x(uid)
    )
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_group_create',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_groups (
    display_name,
    description,
    active,
    created_by_user_id,
    updated_by_user_id
  )
  values (
    v_name,
    v_description,
    true,
    p_app_user_id,
    p_app_user_id
  )
  returning group_id into v_group_id;

  insert into public.work_report_group_members (
    group_id,
    member_user_id,
    added_by_user_id
  )
  select v_group_id, x.uid, p_app_user_id
    from unnest(p_member_user_ids) as x(uid);

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
    'GROUP_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    'APPLIED',
    jsonb_build_object(
      'group_id', v_group_id,
      'member_count', v_distinct_count
    )
  );

  v_result := jsonb_build_object('group_id', v_group_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_group_create',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$function$;

create or replace function public.work_report_update_group(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_group_id uuid,
  p_expected_version integer,
  p_display_name text,
  p_description text,
  p_member_user_ids uuid[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_group public.work_report_groups%rowtype;
  v_name text;
  v_description text;
  v_distinct_count integer;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_name := pg_catalog.btrim(coalesce(p_display_name, ''));
  v_description := case
    when p_description is null then null
    else nullif(pg_catalog.btrim(p_description), '')
  end;

  if p_group_id is null
     or p_expected_version is null or p_expected_version < 1
     or pg_catalog.length(v_name) not between 1 and 160
     or (v_description is not null and pg_catalog.length(v_description) > 1000)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128
     or coalesce(cardinality(p_member_user_ids), 0) < 1
     or exists (select 1 from unnest(p_member_user_ids) as x(uid) where x.uid is null) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select count(distinct x.uid)::integer
    into v_distinct_count
    from unnest(p_member_user_ids) as x(uid);
  if v_distinct_count <> cardinality(p_member_user_ids) then
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

  if exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_actor_can_assign_member(p_app_user_id, x.uid, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if v_group.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = '40001';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_is_eligible_assignee(x.uid)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'group_id', p_group_id,
    'expected_version', p_expected_version,
    'display_name', v_name,
    'description', v_description,
    'member_user_ids', (
      select jsonb_agg(x.uid order by x.uid)
        from unnest(p_member_user_ids) as x(uid)
    )
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_group_update',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  update public.work_report_groups
     set display_name = v_name,
         description = v_description,
         updated_by_user_id = p_app_user_id,
         version = version + 1,
         updated_at = now()
   where group_id = p_group_id;

  delete from public.work_report_group_members gm
   where gm.group_id = p_group_id
     and not (gm.member_user_id = any(p_member_user_ids));

  insert into public.work_report_group_members (
    group_id,
    member_user_id,
    added_by_user_id
  )
  select p_group_id, x.uid, p_app_user_id
    from unnest(p_member_user_ids) as x(uid)
  on conflict (group_id, member_user_id) do nothing;

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
    'GROUP_UPDATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    'APPLIED',
    jsonb_build_object(
      'group_id', p_group_id,
      'member_count', v_distinct_count,
      'version', p_expected_version + 1
    )
  );

  v_result := jsonb_build_object('group_id', p_group_id, 'version', p_expected_version + 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_group_update',
    p_idempotency_key,
    v_result
  );
  return v_result;
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

  if p_active and exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and not public.work_report__internal_is_eligible_assignee(gm.member_user_id)
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
-- 5. Extend assignment state, tracking, and obligation materialization for GROUP.
-- -----------------------------------------------------------------------------
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
      'frequency', tracked.frequency,
      'is_mandatory', tracked.is_mandatory,
      'effective_from', tracked.effective_from,
      'effective_to', tracked.effective_to,
      'state', tracked.state,
      'version', tracked.version,
      'created_at', tracked.created_at,
      'obligation_total', tracked.obligation_total,
      'submitted_count', tracked.submitted_count,
      'not_started_count', tracked.not_started_count,
      'draft_count', tracked.draft_count,
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
               a.frequency,
               a.is_mandatory,
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
               count(o.obligation_id) filter (where o.obligation_status = 'EXEMPTED')::integer as exempted_count,
               count(o.obligation_id) filter (where o.obligation_status = 'CANCELLED')::integer as cancelled_count
          from public.work_report_assignments a
          join public.work_report_templates t on t.template_id = a.template_id
          left join public.teams team on team.team_id = a.target_team_id
          left join public.direct_entry_app_users target_user on target_user.app_user_id = a.target_user_id
          left join public.work_report_groups grp on grp.group_id = a.target_group_id
          left join lateral (
            select string_agg(u.display_name, ', ' order by u.display_name, u.app_user_id) as target_label
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
           target_user.display_name, grp.group_id, grp.display_name, grp.active, target_list.target_label
      ) tracked
  ), '[]'::jsonb));
end;
$function$;

create or replace function public.work_report_ensure_obligations_for_window(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_inserted integer;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_business_date is null then
    raise exception 'WORK_REPORT_DATE_INVALID' using errcode = '22023';
  end if;

  with candidate as (
    select a.*,
           u.app_user_id as assignee_id,
           public.work_report_current_team(u.app_user_id) as team_id,
           u.snapshot_group_id,
           u.snapshot_group_name
      from public.work_report_assignments a
      cross join lateral (
        select a.target_user_id as app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
         where a.target_kind = 'USER'
        union all
        select x.target_user_id,
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
            on m.recruiter_id = l.recruiter_id and m.is_current
         where a.target_kind = 'TEAM'
           and m.team_id = a.target_team_id
           and l.verified
           and l.is_current
        union all
        select gm.member_user_id,
               g.group_id as snapshot_group_id,
               g.display_name as snapshot_group_name
          from public.work_report_groups g
          join public.work_report_group_members gm
            on gm.group_id = g.group_id
         where a.target_kind = 'GROUP'
           and g.group_id = a.target_group_id
           and g.active
      ) u
     where a.is_current
       and a.state = 'ACTIVE'
       and a.effective_from <= p_business_date
       and (a.effective_to is null or p_business_date <= a.effective_to)
  ),
  authorized as (
    select c.*
      from candidate c
     where exists (
       select 1
         from public.work_report__internal_resolve_capability_authority(
           p_app_user_id,
           'report_assign',
           c.template_id,
           c.team_id
         ) auth
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
                  p_app_user_id,
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
     where exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = m.assignee_id
          and u.enabled
     )
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
    on conflict (template_id, assignee_app_user_id, period_key) do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from inserted;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    'OBLIGATION_MATERIALIZE',
    p_app_user_id,
    'report_assign',
    case when public.direct_entry_has_scope(p_app_user_id, 'all') then 'all' else 'team' end,
    'APPLIED',
    jsonb_build_object('business_date', p_business_date, 'inserted_count', v_inserted)
  );

  return jsonb_build_object('business_date', p_business_date, 'inserted_count', v_inserted);
end;
$function$;

-- -----------------------------------------------------------------------------
-- 6. Dedicated server-scoped analytics filter options (`report_analytics_view`).
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
        'app_user_id', u.app_user_id,
        'display_name', u.display_name,
        'team_ids', to_jsonb(gu.team_ids)
      ) order by u.display_name asc, u.app_user_id asc)
        from grouped_users gu
        join public.direct_entry_app_users u on u.app_user_id = gu.app_user_id
    ), '[]'::jsonb)
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 7. Align table & routine ownership with canonical Work Reports owner.
-- -----------------------------------------------------------------------------
do $align_hf_work_reports_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_rel text;
  v_rel_owner_oid oid;
  v_sig text;
  v_proc_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.work_report_assignments'::pg_catalog.regclass;

  foreach v_rel in array array[
    'public.work_report_groups',
    'public.work_report_group_members'
  ]
  loop
    select c.relowner
      into v_rel_owner_oid
      from pg_catalog.pg_class c
     where c.oid = pg_catalog.to_regclass(v_rel);

    if v_rel_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter table %s owner to %I', v_rel, v_base_owner);
    end if;
  end loop;

  foreach v_sig in array array[
    'public.work_report__internal_is_eligible_assignee(uuid)',
    'public.work_report__internal_actor_can_assign_member(uuid, uuid, uuid)',
    'public.work_report_list_groups(uuid, uuid)',
    'public.work_report_create_group(uuid, uuid, text, text, uuid[], text)',
    'public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)',
    'public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)',
    'public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)',
    'public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)',
    'public.work_report_list_assignments(uuid, uuid, uuid)',
    'public.work_report_ensure_obligations_for_window(uuid, uuid, date)',
    'public.work_report_analytics_filter_options(uuid, uuid)'
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
$align_hf_work_reports_owners$;

-- -----------------------------------------------------------------------------
-- 8. Strict table & function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on table public.work_report_groups
  from public, anon, authenticated, service_role;

revoke all on table public.work_report_group_members
  from public, anon, authenticated, service_role;

revoke all on function public.work_report__internal_is_eligible_assignee(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.work_report__internal_actor_can_assign_member(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.work_report_list_groups(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_groups(uuid, uuid)
  to service_role;

revoke all on function public.work_report_create_group(uuid, uuid, text, text, uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_group(uuid, uuid, text, text, uuid[], text)
  to service_role;

revoke all on function public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)
  to service_role;

revoke all on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  to service_role;

revoke all on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  to service_role;

revoke all on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  to service_role;

revoke all on function public.work_report_list_assignments(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_assignments(uuid, uuid, uuid)
  to service_role;

revoke all on function public.work_report_ensure_obligations_for_window(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_ensure_obligations_for_window(uuid, uuid, date)
  to service_role;

revoke all on function public.work_report_analytics_filter_options(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_analytics_filter_options(uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 9. Install-time fail-closed catalog & ACL self-check.
-- -----------------------------------------------------------------------------
do $check_hf_work_reports_groups_and_analytics_options$
declare
  v_tbl pg_catalog.regclass;
  v_rls boolean;
  v_force_rls boolean;
  v_policy_count integer;
  v_exposed_table_acl integer;
  v_internal_fn pg_catalog.regprocedure;
  v_rpc_fn pg_catalog.regprocedure;
  v_secdef boolean;
  v_config text;
  v_owner_bypasses_rls boolean;
begin
  foreach v_tbl in array array[
    'public.work_report_groups'::pg_catalog.regclass,
    'public.work_report_group_members'::pg_catalog.regclass
  ]
  loop
    select c.relrowsecurity,
           c.relforcerowsecurity,
           (select count(*)::integer from pg_catalog.pg_policy p where p.polrelid = c.oid),
           (
             select count(*)::integer
               from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
               left join pg_catalog.pg_roles gr on gr.oid = a.grantee
              where a.grantee = 0
                 or gr.rolname in ('anon', 'authenticated', 'service_role')
           )
      into v_rls, v_force_rls, v_policy_count, v_exposed_table_acl
      from pg_catalog.pg_class c
     where c.oid = v_tbl;

    if not coalesce(v_rls, false)
       or not coalesce(v_force_rls, false)
       or coalesce(v_policy_count, -1) <> 0
       or coalesce(v_exposed_table_acl, -1) <> 0 then
      raise exception 'HF Work Reports table RLS/ACL drift on %', v_tbl
        using errcode = '55000';
    end if;
  end loop;

  foreach v_internal_fn in array array[
    'public.work_report__internal_is_eligible_assignee(uuid)'::pg_catalog.regprocedure,
    'public.work_report__internal_actor_can_assign_member(uuid, uuid, uuid)'::pg_catalog.regprocedure
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
      raise exception 'HF Work Reports internal routine must stay revoked from all runtime roles: %', v_internal_fn
        using errcode = '55000';
    end if;
  end loop;

  foreach v_rpc_fn in array array[
    'public.work_report_list_groups(uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_create_group(uuid, uuid, text, text, uuid[], text)'::pg_catalog.regprocedure,
    'public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)'::pg_catalog.regprocedure,
    'public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)'::pg_catalog.regprocedure,
    'public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)'::pg_catalog.regprocedure,
    'public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)'::pg_catalog.regprocedure,
    'public.work_report_list_assignments(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.work_report_ensure_obligations_for_window(uuid, uuid, date)'::pg_catalog.regprocedure,
    'public.work_report_analytics_filter_options(uuid, uuid)'::pg_catalog.regprocedure
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
      raise exception 'HF Work Reports RPC security definer owner/RLS/search_path drift on %', v_rpc_fn
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
      raise exception 'HF Work Reports RPC EXECUTE ACL drift on %', v_rpc_fn
        using errcode = '55000';
    end if;
  end loop;
end;
$check_hf_work_reports_groups_and_analytics_options$;

commit;
