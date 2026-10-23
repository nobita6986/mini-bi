-- Work Reports reader contract: scoped readable-submissions discovery and filter options
-- for actors holding report_view (including canonical Full Admin fallback via work_report_assert_actor).
-- Preserves public.work_report_get_submission(uuid, uuid, uuid) signature and behavior unchanged.
--
-- Reporting-period filter semantics (`p_from` / `p_to`):
--   Inclusive bounds on `work_report_obligations.period_start_date` (`DATE` in Asia/Ho_Chi_Minh
--   reporting calendar), aligned with `work_report_analytics_overview`,
--   `work_report_analytics_breakdown`, and `work_report_analytics_contributions`:
--     - `p_from is not null` => `o.period_start_date >= p_from`
--     - `p_to is not null`   => `o.period_start_date <= p_to`
--     - `p_from > p_to`      => SQLSTATE `22023` (`WORK_REPORT_DATE_RANGE_INVALID`)

begin;

create index if not exists work_report_submissions_readable_keyset_idx
  on public.work_report_submissions (latest_submitted_at desc, submission_id desc)
  where current_revision_id is not null
    and state in ('COMPLETED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

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
           u.display_name
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
           u.display_name as assignee_display_name,
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

comment on function public.work_report_list_readable_submissions(
  uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer
) is
  'Service-role-only reader contract for Work Reports submitted reports. Reporting-period filters p_from/p_to apply inclusive bounds on work_report_obligations.period_start_date.';

revoke all on function public.work_report_list_readable_submissions(
  uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer
) from public, anon, authenticated, service_role;

grant execute on function public.work_report_list_readable_submissions(
  uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer
) to service_role;

commit;
