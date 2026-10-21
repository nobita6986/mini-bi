begin;

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
  v_all_scope boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_assign');
  v_all_scope := public.direct_entry_has_scope(p_app_user_id, 'all');

  if p_team_id is not null then
    if not exists (select 1 from public.teams t where t.team_id = p_team_id and t.active) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if not v_all_scope then
      perform public.work_report_assert_scope(p_app_user_id, 'report_assign', p_team_id, false);
    end if;
  elsif not v_all_scope and not exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active
     where s.app_user_id = p_app_user_id and s.scope_kind = 'team' and s.is_current
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'assignment_id', tracked.assignment_id,
      'template_id', tracked.template_id,
      'template_code', tracked.template_code,
      'template_name', tracked.template_name,
      'target_kind', tracked.target_kind,
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
       select a.assignment_id, a.template_id, t.template_code, t.display_name as template_name,
         a.target_kind,
         case a.target_kind when 'TEAM' then coalesce(team.display_name, team.code, 'Nhóm không còn hoạt động')
           when 'USER' then coalesce(target_user.display_name, 'Tài khoản không còn hoạt động')
           else coalesce(target_list.target_label, 'Danh sách nhân viên') end as target_label,
         a.frequency, a.is_mandatory, a.effective_from, a.effective_to, a.state, a.version,
         a.created_at, a.updated_at,
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
      left join lateral (
        select string_agg(u.display_name, ', ' order by u.display_name, u.app_user_id) as target_label
          from public.work_report_assignment_targets x
          join public.direct_entry_app_users u on u.app_user_id = x.target_user_id
         where x.assignment_id = a.assignment_id
      ) target_list on true
      left join public.work_report_obligations o on o.assignment_id = a.assignment_id
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
     where (v_all_scope or
       (a.target_kind = 'TEAM' and exists (
         select 1 from public.direct_entry_scope_grants g
         join public.teams scoped_team on scoped_team.team_id = g.team_id and scoped_team.active
          where g.app_user_id = p_app_user_id and g.scope_kind = 'team'
            and g.team_id = a.target_team_id and g.is_current
       )) or
       (a.target_kind = 'USER' and exists (
         select 1 from public.direct_entry_scope_grants g
         join public.teams scoped_team on scoped_team.team_id = g.team_id and scoped_team.active
          where g.app_user_id = p_app_user_id and g.scope_kind = 'team'
            and g.team_id = public.work_report_current_team(a.target_user_id) and g.is_current
       )) or
       (a.target_kind = 'USER_SET'
         and exists (select 1 from public.work_report_assignment_targets x where x.assignment_id = a.assignment_id)
         and not exists (
           select 1 from public.work_report_assignment_targets x
            where x.assignment_id = a.assignment_id
              and not exists (
                select 1 from public.direct_entry_scope_grants g
                join public.teams scoped_team on scoped_team.team_id = g.team_id and scoped_team.active
                 where g.app_user_id = p_app_user_id and g.scope_kind = 'team' and g.is_current
                   and g.team_id = public.work_report_current_team(x.target_user_id)
              )
         )
       ))
       and (p_team_id is null or
         (a.target_kind = 'TEAM' and a.target_team_id = p_team_id) or
         (a.target_kind = 'USER' and public.work_report_current_team(a.target_user_id) = p_team_id) or
         (a.target_kind = 'USER_SET' and exists (
           select 1 from public.work_report_assignment_targets x
            where x.assignment_id = a.assignment_id
              and public.work_report_current_team(x.target_user_id) = p_team_id
         ))
       )
     group by a.assignment_id, t.template_code, t.display_name, team.display_name, team.code,
       target_user.display_name, target_list.target_label
      ) tracked
  ), '[]'::jsonb));
end;
$function$;

revoke all on function public.work_report_list_assignments(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_assignments(uuid, uuid, uuid) to service_role;

commit;
