-- =============================================================================
-- Hotfix: Worker Detail Read Scope Alignment (`direct_entry_read_projection`)
--         & Non-Throwing Salary Advance Access Probe (`salary_advance_get_actor_access`)
--
-- Scope:
--   1. Align `public.direct_entry_assert_draft_access` with `direct_entry_assert_entry_access`
--      so overlapping current scope grants (`v_matches > 1`) resolve via `min(g.scope_kind)`
--      instead of raising `42501 draft scope/capability denied`.
--   2. Align `public.direct_entry_resolve_submission_read_scope(uuid, uuid, uuid)` with
--      `public.direct_entry_list_own_submissions` so an `uploader` (exact 1 current `own`
--      scope grant with `team_id IS NULL` + `submission_create`) can read their own
--      non-deleted entries even without `entry_own`, while preserving `'project'`
--      precedence for assigned Project Managers on `SUBMITTED` rows.
--   3. Add `public.salary_advance_get_actor_access(uuid, uuid)` as a non-throwing
--      navigation/page-entry access probe returning `{ can_access, is_project_manager,
--      is_project_accountant, is_supervisory_viewer }` without raising `42501
--      SALARY_ADVANCE_ACCESS_DENIED` when `allowed = false`, while keeping `42501`
--      strictly enforced on all business RPCs (`salary_advance_get_actor_context`,
--      `salary_advance_list_project_workers`, `salary_advance_list_project_worker_history`,
--      `salary_advance_list_worker_history`, etc.).
--   4. Ensure cross-owner `EXECUTE` grants on internal `SECURITY DEFINER` helpers
--      for both worker detail read projection and salary advance access probing.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Align `direct_entry_assert_draft_access` with overlapping-scope resolution.
-- -----------------------------------------------------------------------------
do $patch_assert_draft_access$
declare
  v_sig regprocedure :=
    'public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text)'::regprocedure;
  v_owner name;
begin
  select r.rolname into v_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = v_sig;

  create or replace function public.direct_entry_assert_draft_access(
    p_auth_subject uuid, p_app_user_id uuid, p_entry_owner uuid, p_team_id uuid,
    p_resource_scope_date date, p_required_scope text default null
  )
  returns text language plpgsql security definer
  set search_path = pg_catalog, public
  as $function$
  declare
    v_scope text;
    v_capability text;
    v_matches integer;
  begin
    select count(*)::integer, min(g.scope_kind) into v_matches, v_scope
      from public.direct_entry_scope_grants g
      join public.direct_entry_capability_grants c on c.app_user_id = g.app_user_id and c.is_current
        and c.capability = case g.scope_kind when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end
     where g.app_user_id = p_app_user_id and g.is_current
       and (g.scope_kind <> 'team' or exists (select 1 from public.teams t where t.team_id = g.team_id and t.active))
       and ((g.scope_kind = 'own' and p_entry_owner = p_app_user_id)
         or (g.scope_kind = 'team' and g.team_id = p_team_id) or g.scope_kind = 'all')
       and (p_required_scope is null or g.scope_kind = p_required_scope);
    if v_matches = 0 then
      raise exception 'draft scope/capability denied' using errcode = '42501';
    end if;
    v_capability := case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end;
    perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, v_capability);
    return v_scope;
  end;
  $function$;

  if v_owner is not null then
    execute pg_catalog.format(
      'alter function public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text) owner to %I',
      v_owner
    );
  end if;
end;
$patch_assert_draft_access$;

revoke all on function public.direct_entry_assert_draft_access(
  uuid, uuid, uuid, uuid, date, text
) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Align `direct_entry_resolve_submission_read_scope` with `uploader` scope.
-- -----------------------------------------------------------------------------
do $patch_resolve_submission_read_scope$
declare
  v_sig regprocedure :=
    'public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)'::regprocedure;
  v_owner name;
begin
  select r.rolname into v_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = v_sig;

  create or replace function public.direct_entry_resolve_submission_read_scope(
    p_auth_subject uuid, p_app_user_id uuid, p_entry_id uuid
  )
  returns text language plpgsql security definer
  set search_path = pg_catalog, public
  as $function$
  declare
    v_scope text;
    v_entry public.direct_entries%rowtype;
    v_submission_state text;
    v_recruiter_link_count integer;
    v_team_leader_team_id uuid;
    v_can_read_own_submissions boolean;
  begin
    v_scope := public.direct_entry_resolve_draft_scope(p_auth_subject, p_app_user_id, p_entry_id);
    if v_scope is not null then return v_scope; end if;

    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

    select e.* into v_entry
      from public.direct_entries e
     where e.entry_id = p_entry_id and e.deleted_at is null;
    if not found then return null; end if;

    select s.state into v_submission_state
      from public.direct_entry_submissions s
     where s.submission_id = v_entry.submission_id;
    if not found then return null; end if;

    v_can_read_own_submissions := (
      v_entry.created_by_user_id = p_app_user_id
      and (
        select count(*)::integer
          from public.direct_entry_scope_grants g
         where g.app_user_id = p_app_user_id
           and g.scope_kind = 'own'
           and g.team_id is null
           and g.is_current
      ) = 1
      and public.direct_entry_has_capability(p_app_user_id, 'submission_create')
    );

    if v_submission_state <> 'SUBMITTED' then
      if v_can_read_own_submissions then return 'own'; end if;
      return null;
    end if;

    if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id) then
      return 'project';
    end if;
    if v_can_read_own_submissions then
      return 'own';
    end if;
    if v_entry.team_id is not null then
      begin
        v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
          p_auth_subject, p_app_user_id, v_entry.team_id
        );
        return 'team';
      exception when insufficient_privilege then
        null;
      end;
    end if;
    if exists(
      select 1
        from public.direct_entry_change_request_items i
        join public.direct_entry_change_requests r on r.request_id = i.request_id
       where i.entry_id = v_entry.entry_id
         and public.direct_entry_team_leader_request_team(p_app_user_id, r.request_id) = v_entry.team_id
    ) then
      return 'team_review';
    end if;
    select count(*)::integer into v_recruiter_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id and l.verified and l.is_current;
    if v_recruiter_link_count = 1 and exists(
      select 1
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
       where l.app_user_id = p_app_user_id
         and l.recruiter_id = v_entry.recruiter_id
         and l.verified
         and l.is_current
    ) then
      return 'recruited';
    end if;
    if public.direct_entry_has_scope(p_app_user_id, 'all') and (
        public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
        or public.direct_entry_has_capability(p_app_user_id, 'change_review')
    ) then
      return 'all';
    end if;
    return null;
  end;
  $function$;

  if v_owner is not null then
    execute pg_catalog.format(
      'alter function public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid) owner to %I',
      v_owner
    );
  end if;
end;
$patch_resolve_submission_read_scope$;

revoke all on function public.direct_entry_resolve_submission_read_scope(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Non-throwing Salary Advance access probe (`salary_advance_get_actor_access`).
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance_get_actor_access(
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
  v_auth jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  return pg_catalog.jsonb_build_object(
    'can_access', coalesce((v_auth->>'allowed')::boolean, false),
    'is_project_manager', coalesce((v_auth->>'is_project_manager')::boolean, false),
    'is_project_accountant', coalesce((v_auth->>'is_project_accountant')::boolean, false),
    'is_supervisory_viewer', coalesce((v_auth->>'is_supervisory_viewer')::boolean, false)
  );
end;
$function$;

do $align_hotfix_owners_and_grants$
declare
  v_owner name;
begin
  select r.rolname into v_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = 'public.salary_advance_get_actor_context(uuid, uuid)'::regprocedure;

  if v_owner is not null then
    execute pg_catalog.format(
      'alter function public.salary_advance_get_actor_access(uuid, uuid) owner to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.salary_advance__internal_resolve_authority(uuid, uuid) to %I',
      v_owner
    );
  end if;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
       'public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)'::regprocedure,
       'public.direct_entry_resolve_draft_scope(uuid,uuid,uuid,text)'::regprocedure,
       'public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text)'::regprocedure,
       'public.direct_entry_resolve_actor_context(uuid)'::regprocedure
     )
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_resolve_draft_scope(uuid,uuid,uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_entry_access(uuid,uuid,text,uuid,uuid,date,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_team_leader_request_team(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_actor_has_project_assignment(uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_project_assignment_effective(uuid,text) to %I',
      v_owner
    );
  end loop;
end;
$align_hotfix_owners_and_grants$;

revoke all on function public.salary_advance_get_actor_access(uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.salary_advance_get_actor_access(uuid, uuid)
  to service_role;

commit;
