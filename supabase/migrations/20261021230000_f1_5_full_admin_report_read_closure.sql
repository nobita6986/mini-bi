-- F1.5 access closure: keep canonical Full Admin read/analytics authority consistent on source evidence and drill-down paths.

begin;

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
        select 1 from public.work_report_submissions s
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

create or replace function public.work_report__internal_resolve_analytics_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_require_report_view boolean default false,
  p_filter_team_id uuid default null,
  p_filter_assignee_id uuid default null,
  p_template_id uuid default null
)
returns table(
  scope_kind text,
  scope_label text,
  authorized_team_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_all_scope boolean;
  v_team_ids uuid[];
  v_label text;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_analytics_view');
  if p_require_report_view then
    perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_view');
  end if;

  v_all_scope := public.direct_entry_has_scope(p_app_user_id, 'all');

  if v_all_scope then
    if p_filter_team_id is not null then
      select coalesce(t.display_name, t.code)
        into v_label
        from public.teams t
       where t.team_id = p_filter_team_id;
      if not found then
        raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
      end if;
      v_team_ids := array[p_filter_team_id];
    else
      v_label := 'Toàn công ty';
      v_team_ids := null;
    end if;

    if p_filter_assignee_id is not null and not exists (
      select 1 from public.direct_entry_app_users u where u.app_user_id = p_filter_assignee_id
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;

    return query select 'all'::text, v_label, v_team_ids;
    return;
  end if;

  select array_agg(s.team_id order by t.code),
         string_agg(coalesce(t.display_name, t.code), ', ' order by t.code)
    into v_team_ids, v_label
    from public.direct_entry_scope_grants s
    join public.teams t on t.team_id = s.team_id and t.active
   where s.app_user_id = p_app_user_id
     and s.scope_kind = 'team'
     and s.is_current;

  if coalesce(cardinality(v_team_ids), 0) = 0 then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if p_filter_team_id is not null then
    if not (p_filter_team_id = any(v_team_ids)) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    v_team_ids := array[p_filter_team_id];
    select coalesce(t.display_name, t.code)
      into v_label
      from public.teams t
     where t.team_id = p_filter_team_id;
  end if;

  if p_filter_assignee_id is not null then
    if not (
      coalesce(public.work_report_current_team(p_filter_assignee_id) = any(v_team_ids), false)
      or exists (
        select 1
          from public.work_report_obligations o
         where o.assignee_app_user_id = p_filter_assignee_id
           and o.snapshot_team_id = any(v_team_ids)
           and (p_template_id is null or o.template_id = p_template_id)
      )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return query select 'team'::text, v_label, v_team_ids;
end;
$function$;


revoke all on function public.work_report_get_submission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report__internal_resolve_analytics_scope(uuid, uuid, boolean, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_get_submission(uuid, uuid, uuid) to service_role;

commit;

