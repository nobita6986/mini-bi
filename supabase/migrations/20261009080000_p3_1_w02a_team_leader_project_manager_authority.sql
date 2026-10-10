-- P3.1-W02A - project-manager authority bridge (#72, append-only).
--
-- Keep P2.5's project/assignment ledger and OCC chain. Admin and Accounting
-- use the catalog-operator guard; team leaders use W01D's canonical authority
-- resolver and are limited to current members of their own effective team.

begin;

create or replace function public.direct_entry_assert_project_operation_authority(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (authority text, team_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  begin
    authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
    team_id := null;
    return next;
    return;
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
    authority := 'entry_admin';
    team_id := null;
    return next;
    return;
  exception
    when insufficient_privilege then
      null;
  end;

  team_id := public.direct_entry_assert_team_leader_read_authority(
    p_auth_subject, p_app_user_id, null
  );
  authority := 'team_manager_assign';
  return next;
end;
$$;
revoke all on function public.direct_entry_assert_project_operation_authority(uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_assert_project_operation_authority(uuid, uuid) is
  'P3.1-W02A internal authority selector: catalog operator, legacy P2.5 entry_admin@all, or W01D canonical own-team leader authority. It delegates leader resolution to W01D and is revoked from every role.';

create or replace function public.direct_entry_lock_project_team_manager_context(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_manager_recruiter_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_app_user_ids uuid[];
  v_leader_recruiter_id uuid;
  v_link_count integer;
  v_locked_team_id uuid;
  v_lock_key text;
begin
  if p_team_id is null or p_manager_recruiter_id is null then
    raise exception 'team manager context required' using errcode = '22023';
  end if;

  perform t.team_id
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select array_agg(ids.app_user_id order by ids.app_user_id)
    into v_app_user_ids
    from (
      select p_app_user_id as app_user_id
      union
      select l.app_user_id
        from public.direct_entry_app_user_recruiter_links l
       where l.recruiter_id = p_manager_recruiter_id
         and l.verified
         and l.valid_from <= public.direct_entry_authorization_date()
         and (l.valid_to is null
              or public.direct_entry_authorization_date() < l.valid_to)
         and (l.valid_to is null or l.valid_to > l.valid_from)
    ) ids;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_app_user_ids)
   order by u.app_user_id
   for update;
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_app_user_id
     and s.scope_kind = 'team'
   order by s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_app_user_id
     and g.capability = 'team_manager_assign'
   order by g.grant_id
   for update;

  for v_lock_key in
    select distinct keys.key
      from (
        select 'capability:' || p_app_user_id::text || ':team_manager_assign' as key
        union all
        select 'scope:' || p_app_user_id::text || ':team:' || p_team_id::text
        union all
        select 'recruiter-link:' || ids.app_user_id::text
          from unnest(v_app_user_ids) ids(app_user_id)
      ) keys
     order by keys.key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_app_user_ids)
   order by l.link_id
   for update;

  select count(*)::int,
         (array_agg(l.recruiter_id order by l.link_id))[1]
    into v_link_count, v_leader_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.valid_from <= public.direct_entry_authorization_date()
     and (l.valid_to is null
          or public.direct_entry_authorization_date() < l.valid_to)
     and (l.valid_to is null or l.valid_to > l.valid_from);
  if v_link_count <> 1 or v_leader_recruiter_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  perform r.recruiter_id
    from public.recruiters r
   where r.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by r.recruiter_id
   for update;

  for v_lock_key in
    select distinct keys.key
      from unnest(array[
        'provider:' || v_leader_recruiter_id::text,
        'team-membership:' || v_leader_recruiter_id::text,
        'provider:' || p_manager_recruiter_id::text,
        'team-membership:' || p_manager_recruiter_id::text
      ]) keys(key)
     order by keys.key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform m.membership_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by m.recruiter_id, m.membership_id
   for update;
  perform m.membership_id
    from public.recruiter_team_memberships m
   where m.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by m.recruiter_id, m.membership_id
   for update;

  v_locked_team_id := public.direct_entry_assert_team_leader_read_authority(
    p_auth_subject, p_app_user_id, p_team_id
  );
  if v_locked_team_id is distinct from p_team_id then
    raise exception 'team leader authority changed' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.direct_entry_lock_project_team_manager_context(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_lock_project_team_manager_context(uuid, uuid, uuid, uuid) is
  'W02-A internal lock set for project assignment writes: project first, then W01D team/app-user/grant/link order, then recruiter/provider/team-membership aggregate locks shared with W01C/W01D. Revalidates canonical leader authority while locks are held.';

create or replace function public.direct_entry_list_projects_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_include_inactive boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_team_id uuid;
  v_include_inactive boolean := coalesce(p_include_inactive, false);
  v_projects jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if v_authority = 'team_manager_assign' then
    v_include_inactive := false;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'project_id', p.project_id,
      'display_name', p.display_name,
      'active', p.active,
      'version', p.version,
      'created_at', rev.first_revision_at,
      'updated_at', rev.last_revision_at,
      'revision_count', coalesce(rev.revision_count, 0),
      'active_assignment_count', coalesce(asg.active_count, 0),
      'can_manage_project_master', v_authority <> 'team_manager_assign',
      'can_assign_managers', true
    ) order by p.display_name, p.project_id), '[]'::jsonb)
    into v_projects
    from public.direct_entry_projects p
    left join lateral (
      select min(r.created_at) as first_revision_at,
             max(r.created_at) as last_revision_at,
             count(*)::int as revision_count
        from public.direct_entry_project_revisions r
       where r.project_id = p.project_id
    ) rev on true
    left join lateral (
      select count(*)::int as active_count
        from public.direct_entry_project_manager_assignments a
       where a.project_id = p.project_id and a.valid_to is null
    ) asg on true
   where v_include_inactive or p.active;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'projects', v_projects
  );
end;
$$;
revoke all on function public.direct_entry_list_projects_admin(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_projects_admin(uuid, uuid, boolean)
  to service_role;
comment on function public.direct_entry_list_projects_admin(uuid, uuid, boolean) is
  'P3.1-W02A project read: Admin/Accounting receive their requested project catalog; team leaders receive active projects only. service_role only.';

create or replace function public.direct_entry_get_project_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_team_id uuid;
  v_project jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;

  select jsonb_build_object(
      'project_id', p.project_id,
      'display_name', p.display_name,
      'active', p.active,
      'version', p.version,
      'created_at', rev.first_revision_at,
      'updated_at', rev.last_revision_at,
      'revision_count', coalesce(rev.revision_count, 0),
      'active_assignment_count', coalesce(asg.active_count, 0),
      'can_manage_project_master', v_authority <> 'team_manager_assign',
      'can_assign_managers', true
    )
    into v_project
    from public.direct_entry_projects p
    left join lateral (
      select min(r.created_at) as first_revision_at,
             max(r.created_at) as last_revision_at,
             count(*)::int as revision_count
        from public.direct_entry_project_revisions r
       where r.project_id = p.project_id
    ) rev on true
    left join lateral (
      select count(*)::int as active_count
        from public.direct_entry_project_manager_assignments a
       where a.project_id = p.project_id and a.valid_to is null
    ) asg on true
   where p.project_id = p_project_id
     and (v_authority <> 'team_manager_assign' or p.active);
  if v_project is null then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  return v_project;
end;
$$;
revoke all on function public.direct_entry_get_project_admin(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_project_admin(uuid, uuid, text)
  to service_role;
comment on function public.direct_entry_get_project_admin(uuid, uuid, text) is
  'P3.1-W02A project read: Admin/Accounting may read any project; team leaders may read active projects only. Inactive-project unassignment uses its existing assignment mutation path. service_role only.';

create or replace function public.direct_entry_list_project_manager_assignments(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text default null,
  p_include_history boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_team_id uuid;
  v_assignments jsonb;
  v_active integer;
  v_project_version integer;
  v_project_active boolean;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;

  if p_project_id is not null then
    select p.version, p.active into v_project_version, v_project_active
      from public.direct_entry_projects p
     where p.project_id = p_project_id;
    if v_project_version is null then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    if v_authority = 'team_manager_assign' and not v_project_active then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'assignment_id', a.assignment_id,
      'project_id', a.project_id,
      'project_version', p.version,
      'manager_recruiter_id', a.manager_recruiter_id,
      'valid_from', a.valid_from,
      'valid_to', a.valid_to,
      'effective', a.valid_from <= public.direct_entry_authorization_date()
        and (a.valid_to is null or public.direct_entry_authorization_date() < a.valid_to),
      'version', a.version,
      'revoked_at', a.revoked_at,
      'created_at', a.created_at,
      'updated_at', a.updated_at
    ) order by a.project_id, a.valid_from, a.assignment_id), '[]'::jsonb)
    into v_assignments
    from public.direct_entry_project_manager_assignments a
    join public.direct_entry_projects p on p.project_id = a.project_id
   where (p_project_id is null or a.project_id = p_project_id)
     and (v_authority <> 'team_manager_assign' or p.active)
     and (p_include_history or a.valid_to is null)
     and (
       v_authority <> 'team_manager_assign'
       or (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.valid_from <= public.direct_entry_authorization_date()
            and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
            and (m.valid_to is null or m.valid_to > m.valid_from)
       ) = 1
     )
     and (
       v_authority <> 'team_manager_assign'
       or exists (
         select 1
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.team_id = v_team_id
            and m.valid_from <= public.direct_entry_authorization_date()
            and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
            and (m.valid_to is null or m.valid_to > m.valid_from)
       )
     );

  select count(*)::int into v_active
    from public.direct_entry_project_manager_assignments a
   where (p_project_id is null or a.project_id = p_project_id)
     and exists (
       select 1
         from public.direct_entry_projects p
        where p.project_id = a.project_id
          and (v_authority <> 'team_manager_assign' or p.active)
     )
     and a.valid_to is null
     and (
       v_authority <> 'team_manager_assign'
       or (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.valid_from <= public.direct_entry_authorization_date()
            and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
            and (m.valid_to is null or m.valid_to > m.valid_from)
       ) = 1
     )
     and (
       v_authority <> 'team_manager_assign'
       or exists (
         select 1
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.team_id = v_team_id
            and m.valid_from <= public.direct_entry_authorization_date()
            and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
            and (m.valid_to is null or m.valid_to > m.valid_from)
       )
     );

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'project_id', p_project_id,
    'project_version', v_project_version,
    'project_active', v_project_active,
    'include_history', p_include_history,
    'active_assignment_count', v_active,
    'assignments', v_assignments
  );
end;
$$;
revoke all on function public.direct_entry_list_project_manager_assignments(uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_project_manager_assignments(uuid, uuid, text, boolean)
  to service_role;
comment on function public.direct_entry_list_project_manager_assignments(uuid, uuid, text, boolean) is
  'P3.1-W02A assignment read: Admin/Accounting see all; team leaders see only assignments whose manager is an unambiguous current member of their own effective team. service_role only.';

create or replace function public.direct_entry_list_project_manager_candidates(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_team_id uuid;
  v_candidates jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;

  select coalesce(jsonb_agg(t.candidate order by t.display_name, t.recruiter_id), '[]'::jsonb)
    into v_candidates
    from (
      select r.display_name, r.recruiter_id, jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', r.display_name,
        'personnel_code', r.personnel_code,
        'personnel_position', r.personnel_position
      ) as candidate
        from public.recruiters r
       where r.active
         and exists (
           select 1
             from public.direct_entry_app_user_recruiter_links l
            where l.recruiter_id = r.recruiter_id
              and l.verified
              and l.valid_from <= public.direct_entry_authorization_date()
              and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
              and (l.valid_to is null or l.valid_to > l.valid_from)
         )
         and (
           v_authority <> 'team_manager_assign'
           or (
             select count(*)::int
               from public.direct_entry_app_user_recruiter_links l
              where l.recruiter_id = r.recruiter_id
                and l.verified
                and l.valid_from <= public.direct_entry_authorization_date()
                and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
           ) = 1
         )
         and (
           v_authority <> 'team_manager_assign'
           or exists (
             select 1
               from public.direct_entry_app_user_recruiter_links l
               join public.direct_entry_app_users au on au.app_user_id = l.app_user_id
              where l.recruiter_id = r.recruiter_id
                and l.verified
                and l.valid_from <= public.direct_entry_authorization_date()
                and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
                and au.enabled
                and au.auth_subject is not null
           )
         )
         and (
           v_authority <> 'team_manager_assign'
           or (
             select count(*)::int
               from public.recruiter_provider_memberships m
              where m.recruiter_id = r.recruiter_id
                and m.valid_from <= public.direct_entry_authorization_date()
                and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
           ) = 1
           and (
             select count(*)::int
               from public.recruiter_provider_memberships m
              where m.recruiter_id = r.recruiter_id
                and m.provider_type = 'hrp'
                and m.vendor_id is null
                and m.valid_from <= public.direct_entry_authorization_date()
                and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
           ) = 1
         )
         and (
           v_authority <> 'team_manager_assign'
           or (
             select count(*)::int
               from public.recruiter_team_memberships m
              where m.recruiter_id = r.recruiter_id
                and m.valid_from <= public.direct_entry_authorization_date()
                and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
                and (m.valid_to is null or m.valid_to > m.valid_from)
           ) = 1
         )
         and (
           v_authority <> 'team_manager_assign'
           or exists (
             select 1
               from public.recruiter_team_memberships m
              where m.recruiter_id = r.recruiter_id
                and m.team_id = v_team_id
                and m.valid_from <= public.direct_entry_authorization_date()
                and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
                and (m.valid_to is null or m.valid_to > m.valid_from)
           )
         )
         and (
           p_search is null or btrim(p_search) = ''
           or r.display_name ilike '%' || btrim(p_search) || '%'
           or coalesce(r.personnel_code, '') ilike '%' || btrim(p_search) || '%'
         )
       order by r.display_name, r.recruiter_id
       limit 100
    ) t;
  return jsonb_build_object('candidates', v_candidates);
end;
$$;
revoke all on function public.direct_entry_list_project_manager_candidates(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_project_manager_candidates(uuid, uuid, text)
  to service_role;
comment on function public.direct_entry_list_project_manager_candidates(uuid, uuid, text) is
  'P3.1-W02A candidate read: Admin/Accounting see all eligible candidates; team leaders see only eligible effective members of their own team. Projection excludes auth and app-user identifiers. service_role only.';

create or replace function public.direct_entry_assign_project_manager(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_manager_recruiter_id uuid,
  p_valid_from date,
  p_expected_project_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_team_id uuid;
  v_project public.direct_entry_projects;
  v_valid_from date;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_link_count integer;
  v_enabled_link_count integer;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_assignment_id uuid;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;
  if p_manager_recruiter_id is null then
    raise exception 'project manager required' using errcode = '22023';
  end if;
  if p_expected_project_version is null or p_expected_project_version < 1 then
    raise exception 'expected project version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  v_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_manager_assignment_assign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'manager_recruiter_id', p_manager_recruiter_id,
      'valid_from', v_valid_from,
      'expected_project_version', p_expected_project_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Lock project first, then the canonical leader/team and target-recruiter
  -- authority aggregates in the same order as W01C/W01D before validating.
  v_project := public.direct_entry_lock_project(p_project_id, p_expected_project_version);
  if not v_project.active then
    raise exception 'project is not active' using errcode = '22023';
  end if;
  if v_authority = 'team_manager_assign' then
    perform public.direct_entry_lock_project_team_manager_context(
      p_auth_subject, p_app_user_id, v_team_id, p_manager_recruiter_id
    );
    select count(*)::int,
           count(*) filter (where m.team_id = v_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = p_manager_recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from);
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
    select count(*)::int
      into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to);
    select count(*)::int
      into v_enabled_link_count
      from public.direct_entry_app_user_recruiter_links l
      join public.direct_entry_app_users au on au.app_user_id = l.app_user_id
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
       and au.enabled
       and au.auth_subject is not null;
    select count(*)::int,
           count(*) filter (
             where m.provider_type = 'hrp' and m.vendor_id is null
           )::int
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = p_manager_recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
    if v_link_count <> 1 or v_enabled_link_count <> 1
       or v_provider_count <> 1 or v_hrp_provider_count <> 1
       or not exists (
         select 1 from public.recruiters r
          where r.recruiter_id = p_manager_recruiter_id and r.active
       ) then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
  end if;
  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = p_manager_recruiter_id and r.active
  ) then
    raise exception 'project manager recruiter is not active' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
       and (l.valid_to is null or l.valid_to > l.valid_from)
  ) then
    raise exception 'project manager has no verified account link' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.direct_entry_project_manager_assignments a
     where a.project_id = p_project_id
       and a.manager_recruiter_id = p_manager_recruiter_id
       and a.valid_to is null
  ) then
    raise exception 'project manager is already assigned to this project'
      using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);
  insert into public.direct_entry_project_manager_assignments
    (project_id, manager_recruiter_id, valid_from, valid_to,
     created_by_user_id, reason_id, version)
  values
    (p_project_id, p_manager_recruiter_id, v_valid_from, null,
     p_app_user_id, v_reason_id, 1)
  returning assignment_id into v_assignment_id;

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      p_project_id, p_app_user_id, v_reason_id, v_before,
      jsonb_set(
        public.direct_entry_project_snapshot(v_project),
        '{assignment_change}',
        jsonb_build_object(
          'change', 'ASSIGN',
          'assignment_id', v_assignment_id,
          'manager_recruiter_id', p_manager_recruiter_id,
          'valid_from', v_valid_from,
          'valid_to', null
        ),
        true
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     scope_team_id, outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_assign',
     v_authority, v_assignment_id::text,
     case when v_authority = 'team_manager_assign' then 'team' else 'all' end,
     case when v_authority = 'team_manager_assign' then v_team_id else null end,
     'APPLIED', v_reason_id,
     array['project_id', 'manager_recruiter_id', 'valid_from'], v_revision_id);

  v_result := jsonb_build_object(
    'assignment_id', v_assignment_id,
    'project_id', p_project_id,
    'manager_recruiter_id', p_manager_recruiter_id,
    'valid_from', v_valid_from,
    'valid_to', null,
    'version', 1,
    'project_version', v_project_version,
    'already_assigned', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_manager_assignment_assign', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text) is
  'P3.1-W02A assignment mutation: Admin/Accounting may assign any eligible manager; team leaders may assign only an eligible current member of their own team. All use the P2.5 project OCC, idempotency, revision and audit chain.';

create or replace function public.direct_entry_unassign_project_manager(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_expected_project_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_team_id uuid;
  v_assignment public.direct_entry_project_manager_assignments%rowtype;
  v_project public.direct_entry_projects;
  v_project_id text;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_revoke_to date;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_assignment_id is null then
    raise exception 'assignment required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected version required' using errcode = '22023';
  end if;
  if p_expected_project_version is null or p_expected_project_version < 1 then
    raise exception 'expected project version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'assignment_id', p_assignment_id,
      'expected_version', p_expected_version,
      'expected_project_version', p_expected_project_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Assignment identity is immutable: this unlocked lookup discovers only the
  -- project. Lock order is always project first, assignment second.
  select a.project_id into v_project_id
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id = p_assignment_id;
  if v_project_id is null then
    raise exception 'project manager assignment not found' using errcode = 'P0002';
  end if;

  v_project := public.direct_entry_lock_project(v_project_id, p_expected_project_version);
  select * into v_assignment
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id = p_assignment_id
   for update;
  if not found then
    raise exception 'project manager assignment not found' using errcode = 'P0002';
  end if;

  if v_authority = 'team_manager_assign' then
    perform public.direct_entry_lock_project_team_manager_context(
      p_auth_subject, p_app_user_id, v_team_id, v_assignment.manager_recruiter_id
    );
    select count(*)::int,
           count(*) filter (where m.team_id = v_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_assignment.manager_recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from);
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
  end if;

  if v_assignment.valid_to is not null then
    v_result := jsonb_build_object(
      'assignment_id', v_assignment.assignment_id,
      'project_id', v_assignment.project_id,
      'valid_to', v_assignment.valid_to,
      'version', v_assignment.version,
      'project_version', v_project.version,
      'already_unassigned', true
    );
    perform public.direct_entry_idempotency_finish(
      p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key, v_result
    );
    return v_result;
  end if;

  if p_expected_version <> v_assignment.version then
    raise exception 'project assignment version conflict' using errcode = '40001';
  end if;

  v_revoke_to := greatest(
    public.direct_entry_authorization_date(), v_assignment.valid_from
  );
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);

  update public.direct_entry_project_manager_assignments
     set valid_to = v_revoke_to,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where assignment_id = p_assignment_id;

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      v_project_id, p_app_user_id, v_reason_id, v_before,
      jsonb_set(
        public.direct_entry_project_snapshot(v_project),
        '{assignment_change}',
        jsonb_build_object(
          'change', 'UNASSIGN',
          'assignment_id', p_assignment_id,
          'manager_recruiter_id', v_assignment.manager_recruiter_id,
          'valid_to', v_revoke_to
        ),
        true
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     scope_team_id, outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_unassign',
     v_authority, p_assignment_id::text,
     case when v_authority = 'team_manager_assign' then 'team' else 'all' end,
     case when v_authority = 'team_manager_assign' then v_team_id else null end,
     'APPLIED', v_reason_id,
     array['valid_to', 'revoked_by_user_id', 'revoke_reason_id'], v_revision_id);

  v_result := jsonb_build_object(
    'assignment_id', v_assignment.assignment_id,
    'project_id', v_assignment.project_id,
    'valid_to', v_revoke_to,
    'version', v_assignment.version + 1,
    'project_version', v_project_version,
    'already_unassigned', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text)
  to service_role;
comment on function public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text) is
  'P3.1-W02A assignment mutation: Admin/Accounting may unassign any assignment; team leaders may unassign only current members of their own team. Project is locked before assignment; team authority/membership are rechecked after locks. Inactive projects remain revocable.';

create or replace function public.direct_entry_create_project(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_display_name text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_project public.direct_entry_projects;
  v_reason_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_project_id is null
     or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'project identifier is invalid' using errcode = '22023';
  end if;
  if p_display_name is null
     or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'project display name required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select a.authority into v_authority
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if v_authority = 'team_manager_assign' then
    raise exception 'project administration denied' using errcode = '42501';
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'display_name', btrim(p_display_name)
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;
  if exists (
    select 1 from public.direct_entry_projects p where p.project_id = p_project_id
  ) then
    raise exception 'project already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_projects (project_id, display_name, active, version)
  values (p_project_id, btrim(p_display_name), true, 1)
  returning * into v_project;

  v_revision_id := public.direct_entry_write_project_revision(
    p_project_id, v_project.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_project_snapshot(v_project)
  );
  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_create', v_authority,
     p_project_id, 'all', 'APPLIED', v_reason_id,
     array['project_id', 'display_name', 'active'], v_revision_id);

  v_result := jsonb_build_object(
    'project_id', v_project.project_id,
    'display_name', v_project.display_name,
    'active', v_project.active,
    'version', v_project.version,
    'revision_id', v_revision_id,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_create_project(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_project(uuid, uuid, text, text, text, text)
  to service_role;
comment on function public.direct_entry_create_project(uuid, uuid, text, text, text, text) is
  'P3.1-W02A project create: Admin and Accounting use the canonical catalog-operator guard; audit capability records the authority actually exercised. Existing project revision/idempotency contract is preserved.';

create or replace function public.direct_entry_update_project(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_expected_version integer,
  p_display_name text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_project public.direct_entry_projects;
  v_display_name text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_after jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_display_name is null
     or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'project display name required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select a.authority into v_authority
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if v_authority = 'team_manager_assign' then
    raise exception 'project administration denied' using errcode = '42501';
  end if;
  v_display_name := btrim(p_display_name);
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'expected_version', p_expected_version,
      'display_name', v_display_name
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_project := public.direct_entry_lock_project(p_project_id, p_expected_version);
  if v_project.display_name = v_display_name then
    raise exception 'project display name is unchanged' using errcode = '22023';
  end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);
  update public.direct_entry_projects
     set display_name = v_display_name
   where project_id = p_project_id;
  v_after := jsonb_set(v_before, '{display_name}', to_jsonb(v_display_name), true);

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      p_project_id, p_app_user_id, v_reason_id, v_before, v_after
    ) b;
  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_update', v_authority,
     p_project_id, 'all', 'APPLIED', v_reason_id,
     array['display_name'], v_revision_id);

  v_result := jsonb_build_object(
    'project_id', p_project_id,
    'display_name', v_display_name,
    'active', v_project.active,
    'version', v_project_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text)
  to service_role;
comment on function public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text) is
  'P3.1-W02A project update: Admin and Accounting use the canonical catalog-operator guard; audit capability records the authority actually exercised. Existing project OCC/revision/idempotency contract is preserved.';

create or replace function public.direct_entry_set_project_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_active boolean,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_project public.direct_entry_projects;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_after jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_active is null then
    raise exception 'project active flag required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select a.authority into v_authority
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if v_authority = 'team_manager_assign' then
    raise exception 'project administration denied' using errcode = '42501';
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_set_active', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'active', p_active,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_project := public.direct_entry_lock_project(p_project_id, p_expected_version);
  if v_project.active = p_active then
    raise exception 'project active state is unchanged' using errcode = '22023';
  end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);
  update public.direct_entry_projects
     set active = p_active
   where project_id = p_project_id;
  v_after := jsonb_set(v_before, '{active}', to_jsonb(p_active), true);

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      p_project_id, p_app_user_id, v_reason_id, v_before, v_after
    ) b;
  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_set_active', v_authority,
     p_project_id, 'all', 'APPLIED', v_reason_id,
     array['active'], v_revision_id);

  v_result := jsonb_build_object(
    'project_id', p_project_id,
    'display_name', v_project.display_name,
    'active', p_active,
    'version', v_project_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text)
  to service_role;
comment on function public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text) is
  'P3.1-W02A project activation: Admin and Accounting use the canonical catalog-operator guard; audit capability records the authority actually exercised. Team leaders cannot change project master state.';

do $$
declare
  v_signature text;
  v_source text;
  v_prosecdef boolean;
  v_config text;
  v_public_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_service_exec boolean;
  v_lock_position integer;
  v_assignment_lock_position integer;
  v_authority_recheck_position integer;
  v_membership_position integer;
begin
  foreach v_signature in array array[
    'public.direct_entry_assert_project_operation_authority(uuid,uuid)',
    'public.direct_entry_lock_project_team_manager_context(uuid,uuid,uuid,uuid)',
    'public.direct_entry_list_project_manager_assignments(uuid,uuid,text,boolean)',
    'public.direct_entry_list_project_manager_candidates(uuid,uuid,text)',
    'public.direct_entry_list_projects_admin(uuid,uuid,boolean)',
    'public.direct_entry_get_project_admin(uuid,uuid,text)',
    'public.direct_entry_assign_project_manager(uuid,uuid,text,uuid,date,integer,text,text)',
    'public.direct_entry_unassign_project_manager(uuid,uuid,uuid,integer,integer,text,text)',
    'public.direct_entry_create_project(uuid,uuid,text,text,text,text)',
    'public.direct_entry_update_project(uuid,uuid,text,integer,text,text,text)',
    'public.direct_entry_set_project_active(uuid,uuid,text,boolean,integer,text,text)'
  ] loop
    select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''),
           has_function_privilege('public', p.oid, 'EXECUTE'),
           has_function_privilege('anon', p.oid, 'EXECUTE'),
           has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           has_function_privilege('service_role', p.oid, 'EXECUTE'),
           pg_get_functiondef(p.oid)
      into v_prosecdef, v_config, v_public_exec, v_anon_exec,
           v_authenticated_exec, v_service_exec, v_source
      from pg_proc p
     where p.oid = to_regprocedure(v_signature);
    if v_source is null
       or not v_prosecdef
       or v_config <> 'search_path=pg_catalog, public' then
      raise exception 'W02A SECURITY DEFINER/search_path self-check failed: %', v_signature
        using errcode = '55000';
    end if;
    if v_signature = 'public.direct_entry_assert_project_operation_authority(uuid,uuid)' then
      if v_public_exec or v_anon_exec or v_authenticated_exec or v_service_exec
         or v_source not like '%direct_entry_assert_team_leader_read_authority%'
         or v_source not like '%direct_entry_assert_project_admin%' then
        raise exception 'W02A authority selector self-check failed'
          using errcode = '55000';
      end if;
    elsif v_signature =
      'public.direct_entry_lock_project_team_manager_context(uuid,uuid,uuid,uuid)' then
      if v_public_exec or v_anon_exec or v_authenticated_exec or v_service_exec
         or v_source not like '%for update%'
         or v_source not like '%pg_advisory_xact_lock%'
         or v_source not like '%direct_entry_assert_team_leader_read_authority%' then
        raise exception 'W02A leader context lock self-check failed'
          using errcode = '55000';
      end if;
    elsif v_public_exec or v_anon_exec or v_authenticated_exec or not v_service_exec then
      raise exception 'W02A service-role RPC ACL self-check failed: %', v_signature
        using errcode = '55000';
    end if;
  end loop;

  if to_regprocedure(
       'public.direct_entry_assert_team_manager_assign(uuid,uuid,text,uuid)'
     ) is not null then
    raise exception 'W02A must reuse W01D authority, not add a duplicate resolver'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'public.direct_entry_assign_project_manager(uuid,uuid,text,uuid,date,integer,text,text)'::regprocedure
  ) into v_source;
  v_lock_position := position('direct_entry_lock_project' in v_source);
  v_authority_recheck_position := v_lock_position + strpos(
    substring(v_source from v_lock_position + 1),
    'direct_entry_lock_project_team_manager_context'
  );
  v_membership_position := v_lock_position + strpos(
    substring(v_source from v_lock_position + 1),
    'from public.recruiter_team_memberships'
  );
  if v_lock_position = 0 or v_authority_recheck_position <= v_lock_position
     or v_membership_position <= v_lock_position
     or v_source not like '%scope_team_id%'
     or v_source not like '%v_authority%'
     or v_source not like '%direct_entry_lock_project_team_manager_context%' then
    raise exception 'W02A assignment authority/lock-order self-check failed'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'public.direct_entry_unassign_project_manager(uuid,uuid,uuid,integer,integer,text,text)'::regprocedure
  ) into v_source;
  v_lock_position := position('direct_entry_lock_project' in v_source);
  v_assignment_lock_position := position('for update' in v_source);
  v_authority_recheck_position := v_assignment_lock_position + strpos(
    substring(v_source from v_assignment_lock_position + 1),
    'direct_entry_lock_project_team_manager_context'
  );
  v_membership_position := v_assignment_lock_position + strpos(
    substring(v_source from v_assignment_lock_position + 1),
    'from public.recruiter_team_memberships'
  );
  if v_lock_position = 0 or v_assignment_lock_position <= v_lock_position
     or v_authority_recheck_position <= v_assignment_lock_position
     or v_membership_position <= v_assignment_lock_position
     or v_source not like '%scope_team_id%'
     or v_source not like '%v_authority%'
     or v_source not like '%direct_entry_lock_project_team_manager_context%' then
    raise exception 'W02A unassignment authority/lock-order self-check failed'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'public.direct_entry_list_project_manager_candidates(uuid,uuid,text)'::regprocedure
  ) into v_source;
  if v_source like '%''auth_subject''%'
     or v_source like '%''app_user_id''%'
     or v_source like '%''email''%'
     or v_source not like '%direct_entry_assert_project_operation_authority%'
     or v_source not like '%recruiter_team_memberships%'
     or v_source not like '%direct_entry_app_users%'
     or v_source not like '%recruiter_provider_memberships%' then
    raise exception 'W02A candidate projection/authority self-check failed'
      using errcode = '55000';
  end if;

  raise notice 'P3.1-W02A migration self-check OK (three authority modes, service-role ACL, scoped leader operations)';
end
$$;

commit;
