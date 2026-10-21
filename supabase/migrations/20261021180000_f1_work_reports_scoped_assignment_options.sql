begin;

-- Team Leaders need a bounded directory for the assignment form. Keep template
-- administration and direct table access behind their existing boundaries.
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
  v_scope text;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_assign');
  v_scope := case when public.direct_entry_has_scope(p_app_user_id, 'all') then 'all' else 'team' end;

  if v_scope = 'all' then
    if p_team_id is not null and not exists (
      select 1 from public.teams t where t.team_id = p_team_id and t.active
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  else
    if not exists (
      select 1
        from public.direct_entry_scope_grants s
        join public.teams t on t.team_id = s.team_id and t.active
       where s.app_user_id = p_app_user_id and s.scope_kind = 'team' and s.is_current
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if p_team_id is not null then
      perform public.work_report_assert_scope(p_app_user_id, 'report_assign', p_team_id, false);
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
       where t.status = 'ACTIVE' and t.current_published_version_id is not null
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'team_id', t.team_id, 'code', t.code, 'display_name', t.display_name
      ) order by t.code)
        from public.teams t
       where t.active and (
         v_scope = 'all' or exists (
           select 1 from public.direct_entry_scope_grants s
            where s.app_user_id = p_app_user_id and s.scope_kind = 'team'
              and s.team_id = t.team_id and s.is_current
         )
       )
    ), '[]'::jsonb),
    'users', case when p_team_id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'app_user_id', eligible.app_user_id, 'display_name', eligible.display_name
      ) order by eligible.display_name, eligible.app_user_id)
        from (
          select distinct u.app_user_id, u.display_name
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

revoke all on function public.work_report_list_assignment_options(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_assignment_options(uuid, uuid, uuid) to service_role;

commit;
