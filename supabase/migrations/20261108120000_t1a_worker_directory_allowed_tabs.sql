-- =============================================================================
-- Migration: 20261108120000_t1a_worker_directory_allowed_tabs.sql
-- Work Package: T1A — Worker Directory Server-Verified Allowed Tabs
-- Purpose:
--   Extend `public.direct_entry_resolve_actor_context(p_auth_subject uuid)` to
--   include `allowed_worker_tabs` (canonical ordered JSONB array of subset of
--   `["uploader", "recruited", "managed", "team", "all"]`) computed directly
--   from the active SQL authorization predicates of the Worker Directory and
--   Own-Submissions RPCs:
--     1. `uploader`  -> `public.direct_entry_list_own_submissions`
--                       (`20261020200000_r1_current_state_authorization.sql`):
--                       ((count(*) of current `own` scope grants with
--                         `team_id is null` = 1) and
--                        `public.direct_entry_has_capability(app_user_id, 'submission_create')`)
--                       or `public.direct_entry_actor_has_project_assignment(app_user_id)`
--     2. `recruited` -> `public.direct_entry_worker_directory_audience(..., 'recruited')`:
--                       exactly 1 verified current recruiter link pointing to an
--                       active `public.recruiters` row
--     3. `managed`   -> `public.direct_entry_actor_has_project_assignment(app_user_id)`
--     4. `team`      -> `public.direct_entry_has_capability(app_user_id, 'team_manager_assign')`
--                       and `public.direct_entry_assert_team_leader_current_team(p_auth_subject, app_user_id, null)`
--                       returns a non-null `team_id`
--     5. `all`       -> `public.direct_entry_has_scope(app_user_id, 'all')` and
--                       (`entry_admin` or `change_review`)
--
--   All existing fields of `direct_entry_resolve_actor_context` and its
--   `SECURITY DEFINER` + `service_role`-only ACL remain unchanged.
-- =============================================================================

begin;

create or replace function public.direct_entry_resolve_actor_context(p_auth_subject uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_id uuid;
  v_enabled boolean;
  v_review_scopes jsonb;
  v_team_leader_team_id uuid := null;
  v_allowed_worker_tabs jsonb := '[]'::jsonb;
begin
  select u.app_user_id, u.enabled
    into v_app_user_id, v_enabled
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  select case when not u.enabled then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind', s.kind,
      'team_id', s.team_id,
      'label', s.label
    ) order by case when s.kind = 'all' then 0 else 1 end, s.label, s.team_id)
      from (
        select distinct
          raw_scopes.kind,
          raw_scopes.team_id,
          raw_scopes.label
        from (
          select 'all'::text as kind, null::uuid as team_id, 'Toàn công ty'::text as label
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and public.direct_entry_has_scope(u.app_user_id, 'all')
          union all
          select 'team'::text as kind, t.team_id, coalesce(t.display_name, t.code) as label
            from public.direct_entry_scope_grants g
            join public.teams t on t.team_id = g.team_id and t.active
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and g.app_user_id = u.app_user_id
             and g.scope_kind = 'team'
             and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
          union all
          select d.scope_kind as kind,
                 case when d.scope_kind = 'team' then d.scope_team_id else null end as team_id,
                 case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end as label
            from public.work_report_delegations d
            left join public.teams tm on tm.team_id = d.scope_team_id
           where d.delegate_app_user_id = u.app_user_id
             and d.capability = 'report_review'
             and d.state = 'ACTIVE'
             and d.is_current
             and statement_timestamp() between d.effective_from and d.effective_to
             and public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
        ) raw_scopes
      ) s
  ), '[]'::jsonb) end
    into v_review_scopes
    from public.direct_entry_app_users u
   where u.app_user_id = v_app_user_id;

  if v_enabled and public.direct_entry_has_capability(v_app_user_id, 'team_manager_assign') then
    begin
      v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
        p_auth_subject, v_app_user_id, null
      );
    exception when insufficient_privilege then
      v_team_leader_team_id := null;
    end;
  end if;

  if v_enabled then
    select coalesce(
      jsonb_agg(t.tab_id order by t.ord),
      '[]'::jsonb
    )
    into v_allowed_worker_tabs
    from (
      select 'uploader'::text as tab_id, 1 as ord
       where (
         (
           select count(*)::integer
             from public.direct_entry_scope_grants g
            where g.app_user_id = v_app_user_id
              and g.scope_kind = 'own'
              and g.team_id is null
              and g.is_current
         ) = 1
         and public.direct_entry_has_capability(v_app_user_id, 'submission_create')
       )
       or public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'recruited'::text as tab_id, 2 as ord
       where (
         select count(*)::integer
           from public.direct_entry_app_user_recruiter_links l
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
       ) = 1
       and exists (
         select 1
           from public.direct_entry_app_user_recruiter_links l
           join public.recruiters r
             on r.recruiter_id = l.recruiter_id
            and r.active
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
       )
      union all
      select 'managed'::text as tab_id, 3 as ord
       where public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'team'::text as tab_id, 4 as ord
       where v_team_leader_team_id is not null
      union all
      select 'all'::text as tab_id, 5 as ord
       where public.direct_entry_has_scope(v_app_user_id, 'all')
         and (
           public.direct_entry_has_capability(v_app_user_id, 'entry_admin')
           or public.direct_entry_has_capability(v_app_user_id, 'change_review')
         )
    ) t;
  end if;

  return (
    select jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce((
        select jsonb_agg(distinct g.capability order by g.capability)
          from public.direct_entry_capability_grants g
         where g.app_user_id = u.app_user_id
           and public.direct_entry__internal_capability_grant_effective(g.grant_id)
      ), '[]'::jsonb),
      'recruiter_links', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', l.app_user_id, 'recruiter_id', l.recruiter_id, 'verified', l.verified,
          'valid_from', l.valid_from, 'valid_to', l.valid_to
        ) order by l.valid_from, l.recruiter_id)
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
         where l.app_user_id = u.app_user_id and l.verified and l.is_current and u.enabled
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', t.team_id, 'code', t.code,
          'display', t.display_name, 'active', t.active) order by t.team_id)
          from public.teams t
         where t.active and exists (
           select 1 from public.direct_entry_scope_grants g
            where g.app_user_id = u.app_user_id and g.scope_kind = 'team'
              and g.team_id = t.team_id
              and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
         )
      ), '[]'::jsonb),
      'team_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', g.team_id,
          'valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from, g.team_id)
          from public.direct_entry_scope_grants g
          join public.teams t on t.team_id = g.team_id and t.active
         where g.app_user_id = u.app_user_id
           and g.scope_kind = 'team'
           and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
      ), '[]'::jsonb),
      'all_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id and g.scope_kind = 'all' and g.is_current and u.enabled
      ), '[]'::jsonb),
      'allowed_worker_tabs', v_allowed_worker_tabs
    ) || case
      when jsonb_array_length(v_review_scopes) > 0 then jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u where u.app_user_id = v_app_user_id
  );
end;
$function$;

revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_resolve_actor_context(uuid)
  to service_role;

commit;
