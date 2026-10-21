-- F1.5-WP1 Work Reports Analytics: scoped SQL aggregation, breakdown, drill-down contributions,
-- source evidence lookup by submission_id/obligation_id, and metric projection reconciliation.

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
    if not public.direct_entry_has_capability(p_app_user_id, 'report_view') then
      raise exception 'WORK_REPORT_ACCESS_DENIED' using errcode = '42501';
    end if;
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
  if p_require_report_view and not public.direct_entry_has_capability(p_app_user_id, 'report_view') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
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

create or replace function public.work_report_analytics_overview(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_version_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_team_id uuid default null,
  p_assignee_id uuid default null,
  p_finality text default 'final',
  p_as_of timestamptz default null
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
  v_as_of timestamptz := coalesce(p_as_of, statement_timestamp());
  v_compliance jsonb;
  v_metrics jsonb;
  v_ratios jsonb;
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

  if coalesce(p_finality, 'final') <> 'final' then
    raise exception 'WORK_REPORT_FINALITY_INVALID' using errcode = '22023';
  end if;

  with scoped_obligations as (
    select o.obligation_id,
           o.template_id,
           o.template_version_id,
           o.assignee_app_user_id,
           o.snapshot_team_id,
           o.period_type,
           o.period_key,
           o.period_start_date,
           o.period_end_date,
           o.due_at,
           o.obligation_status,
           s.submission_id,
           s.current_revision_id,
           s.state as submission_state,
           coalesce(s.is_late, false) as is_late
      from public.work_report_obligations o
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
     where o.template_id = p_template_id
       and (p_version_id is null or o.template_version_id = p_version_id)
       and (p_from is null or o.period_start_date >= p_from)
       and (p_to is null or o.period_start_date <= p_to)
       and (v_team_ids is null or o.snapshot_team_id = any(v_team_ids))
       and (p_assignee_id is null or o.assignee_app_user_id = p_assignee_id)
  ),
  compliance_counts as (
    select count(*) filter (where obligation_status = 'ACTIVE')::int as due_count,
           count(*) filter (where obligation_status = 'ACTIVE' and submission_state in ('COMPLETED', 'APPROVED'))::int as completed_count,
           count(*) filter (where obligation_status = 'ACTIVE' and submission_state in ('COMPLETED', 'APPROVED') and not is_late)::int as on_time_count,
           count(*) filter (where obligation_status = 'ACTIVE' and submission_state in ('COMPLETED', 'APPROVED') and is_late)::int as late_submitted_count,
           count(*) filter (where obligation_status = 'ACTIVE' and coalesce(submission_state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT', 'REJECTED') and v_as_of <= due_at)::int as pending_due_count,
           count(*) filter (where obligation_status = 'ACTIVE' and coalesce(submission_state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT', 'REJECTED') and v_as_of > due_at)::int as overdue_missing_count,
           count(*) filter (where obligation_status = 'EXEMPTED')::int as exempted_count,
           count(*) filter (where obligation_status = 'ACTIVE' and submission_state = 'PENDING_REVIEW')::int as pending_review_count
      from scoped_obligations
  )
  select jsonb_build_object(
    'due_count', c.due_count,
    'completed_count', c.completed_count,
    'on_time_count', c.on_time_count,
    'late_submitted_count', c.late_submitted_count,
    'pending_due_count', c.pending_due_count,
    'overdue_missing_count', c.overdue_missing_count,
    'exempted_count', c.exempted_count,
    'pending_review_count', c.pending_review_count,
    'completion_rate', case
      when c.due_count = 0 then null
      else trim_scale(round((c.completed_count::numeric * 100.0) / c.due_count::numeric, 2))
    end
  ) into v_compliance
    from compliance_counts c;

  with scoped_obligations as (
    select o.obligation_id,
           o.template_version_id,
           o.obligation_status,
           s.submission_id,
           s.current_revision_id,
           s.state as submission_state
      from public.work_report_obligations o
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
     where o.template_id = p_template_id
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
  aggregated_metrics as (
    select mg.metric_key,
           case
             when mg.variants_for_metric_key > 1 then
               case
                 when mg.min_version_no = mg.max_version_no then format('%s (v%s)', mg.base_label, mg.max_version_no)
                 else format('%s (v%s-v%s)', mg.base_label, mg.min_version_no, mg.max_version_no)
               end
             else mg.base_label
           end as label,
           mg.unit,
           mg.compatible_group,
           mg.sort_key,
           mg.max_version_no,
           stats.sum_value,
           stats.avg_value,
           stats.min_value,
           stats.max_value,
           stats.count_valid,
           greatest(completed_obs.completed_for_group - stats.count_valid, 0)::int as missing_value_count
      from metric_groups mg
      cross join lateral (
        select count(*)::int as completed_for_group
          from scoped_obligations so
         where so.obligation_status = 'ACTIVE'
           and so.submission_state in ('COMPLETED', 'APPROVED')
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
         where so.obligation_status = 'ACTIVE'
           and so.submission_state in ('COMPLETED', 'APPROVED')
           and mv.is_eligible = true
           and mv.is_final = true
           and mv.metric_key = mg.metric_key
           and mv.unit = mg.unit
           and mv.compatible_group = mg.compatible_group
      ) stats
  ),
  ratio_pairs(ratio_key, label, numerator_key, denominator_key) as (
    values
      ('interested_per_call_rate', 'Tỷ lệ ứng viên quan tâm / cuộc gọi', 'interested_candidates', 'calls_made'),
      ('started_per_interested_rate', 'Tỷ lệ NLĐ đi làm / ứng viên quan tâm', 'workers_started', 'interested_candidates'),
      ('started_per_call_rate', 'Tỷ lệ NLĐ đi làm / cuộc gọi', 'workers_started', 'calls_made')
  ),
  computed_ratios as (
    select rp.ratio_key,
           rp.label,
           rp.numerator_key as numerator_metric_key,
           rp.denominator_key as denominator_metric_key,
           num.sum_value as numerator_sum,
           den.sum_value as denominator_sum,
           100 as scale_factor,
           case
             when coalesce(den.sum_value, 0) <= 0 or num.sum_value is null then null
             else trim_scale(round((num.sum_value::numeric * 100.0) / den.sum_value::numeric, 2))
           end as value
      from ratio_pairs rp
      join aggregated_metrics num on num.metric_key = rp.numerator_key and num.max_version_no = (
        select max(m2.max_version_no) from aggregated_metrics m2 where m2.metric_key = rp.numerator_key
      )
      join aggregated_metrics den on den.metric_key = rp.denominator_key and den.max_version_no = (
        select max(m3.max_version_no) from aggregated_metrics m3 where m3.metric_key = rp.denominator_key
      )
  )
  select coalesce((
           select jsonb_agg(jsonb_build_object(
             'metric_key', am.metric_key,
             'label', am.label,
             'unit', am.unit,
             'compatible_group', am.compatible_group,
             'sum_value', am.sum_value,
             'avg_value', am.avg_value,
             'min_value', am.min_value,
             'max_value', am.max_value,
             'count_valid', am.count_valid,
             'missing_value_count', am.missing_value_count
           ) order by am.sort_key, am.metric_key, am.max_version_no, am.compatible_group)
           from aggregated_metrics am
         ), '[]'::jsonb),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'ratio_key', cr.ratio_key,
             'label', cr.label,
             'numerator_metric_key', cr.numerator_metric_key,
             'denominator_metric_key', cr.denominator_metric_key,
             'numerator_sum', cr.numerator_sum,
             'denominator_sum', cr.denominator_sum,
             'scale_factor', cr.scale_factor,
             'value', cr.value
           ) order by cr.ratio_key)
           from computed_ratios cr
         ), '[]'::jsonb)
    into v_metrics, v_ratios;

  return jsonb_build_object(
    'effective_scope', jsonb_build_object('kind', v_scope_kind, 'label', v_scope_label),
    'compliance', v_compliance,
    'metrics', v_metrics,
    'ratios', v_ratios
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
  p_page_size integer default 50,
  p_as_of timestamptz default null
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
  v_as_of timestamptz := coalesce(p_as_of, statement_timestamp());
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

  if coalesce(p_finality, 'final') <> 'final' then
    raise exception 'WORK_REPORT_FINALITY_INVALID' using errcode = '22023';
  end if;

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
           u.display_name as assignee_display_name,
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
             when 'assignee' then coalesce(u.display_name, o.assignee_app_user_id::text)
             else o.period_key
           end as group_label,
           case p_group_by
             when 'team' then coalesce(o.snapshot_team_code, t.code, '')
             when 'assignee' then coalesce(u.display_name, '')
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
                    and so.submission_state in ('COMPLETED', 'APPROVED')
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
                    and so.submission_state in ('COMPLETED', 'APPROVED')
                    and mv.is_eligible = true
                    and mv.is_final = true
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
  v_effective_team_filter uuid := coalesce(p_target_team_id, p_team_id);
  v_effective_assignee_filter uuid := coalesce(p_target_assignee_id, p_assignee_id);
  v_cursor_id uuid;
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

  if coalesce(p_finality, 'final') <> 'final' then
    raise exception 'WORK_REPORT_FINALITY_INVALID' using errcode = '22023';
  end if;

  if p_metric_key is not null and p_metric_key !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'WORK_REPORT_METRIC_INVALID' using errcode = '22023';
  end if;

  if p_compatible_group is not null and p_compatible_group !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'WORK_REPORT_METRIC_INVALID' using errcode = '22023';
  end if;

  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'WORK_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  if p_cursor is not null then
    begin
      v_cursor_id := p_cursor::uuid;
    exception when others then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end;
  end if;

  with candidate_rows as (
    select o.obligation_id,
           s.submission_id,
           r.revision_no,
           o.assignee_app_user_id,
           u.display_name as assignee_display_name,
           o.snapshot_team_id,
           coalesce(o.snapshot_team_display_name, t.display_name, o.snapshot_team_code, t.code) as team_display_name,
           o.period_key,
           o.period_start_date,
           coalesce(s.state, 'NOT_STARTED') as state,
           s.latest_submitted_at as submitted_at,
           coalesce(s.is_late, false) as is_late,
           coalesce(s.has_post_deadline_amendment, false) as has_post_deadline_amendment,
           metric_contrib.metric_contribution_value,
           row_number() over (
             order by s.latest_submitted_at desc nulls last, o.period_start_date desc, o.obligation_id desc
           )::int as rn
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
           and mv.is_final = true
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
           s.state in ('COMPLETED', 'APPROVED')
           and coalesce(metric_contrib.matched_rows, 0) > 0
         )
       )
  ),
  cursor_anchor as (
    select coalesce(
      (select c.rn from candidate_rows c where v_cursor_id is not null and c.obligation_id = v_cursor_id),
      0
    )::int as anchor_rn
  ),
  window_rows as (
    select c.*
      from candidate_rows c
      cross join cursor_anchor ca
     where c.rn > ca.anchor_rn
     order by c.rn
     limit (p_limit + 1)
  ),
  page_rows as (
    select *
      from window_rows
     order by rn
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
           ) order by pr.rn)
           from page_rows pr
         ), '[]'::jsonb),
         case
           when (select count(*) from window_rows) > p_limit then
             (select pr.obligation_id::text from page_rows pr order by pr.rn desc limit 1)
           else null
         end
    into v_items, v_next_cursor;

  return jsonb_build_object(
    'effective_scope', jsonb_build_object('kind', v_scope_kind, 'label', v_scope_label),
    'next_cursor', v_next_cursor,
    'items', v_items
  );
end;
$function$;

create or replace function public.work_report_reconcile_metric_projection(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid default null
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
  v_result jsonb;
begin
  select s.scope_kind, s.scope_label, s.authorized_team_ids
    into v_scope_kind, v_scope_label, v_team_ids
    from public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, false, null, null, p_template_id
    ) s;

  if p_template_id is not null and not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  with scoped_submissions as (
    select s.submission_id,
           s.obligation_id,
           s.template_id,
           s.template_version_id,
           s.assignee_app_user_id,
           s.current_revision_id,
           s.state,
           o.snapshot_team_id,
           o.period_type,
           o.period_key,
           o.period_start_date,
           o.period_end_date,
           r.payload_json,
           tv.metric_contract_json
      from public.work_report_submissions s
      join public.work_report_obligations o on o.obligation_id = s.obligation_id
      join public.work_report_template_versions tv on tv.version_id = o.template_version_id
      left join public.work_report_submission_revisions r on r.revision_id = s.current_revision_id
     where (p_template_id is null or o.template_id = p_template_id)
       and (v_team_ids is null or o.snapshot_team_id = any(v_team_ids))
  ),
  expected_rows as (
    select ss.submission_id,
           ss.current_revision_id as revision_id,
           ss.obligation_id,
           ss.template_id,
           ss.template_version_id,
           ss.assignee_app_user_id,
           ss.snapshot_team_id,
           ss.period_type,
           ss.period_key,
           ss.period_start_date,
           ss.period_end_date,
           m.value ->> 'field_key' as field_key,
           m.value ->> 'metric_key' as metric_key,
           m.value ->> 'compatible_group' as compatible_group,
           upper(m.value ->> 'field_type') as value_type,
           m.value ->> 'unit' as unit,
           case
             when m.value ->> 'field_type' in ('integer', 'decimal') then
               (ss.payload_json -> (m.value ->> 'field_key') #>> '{}')::numeric(18,4)
             else null
           end as numeric_value,
           case
             when m.value ->> 'field_type' = 'boolean' then
               (ss.payload_json -> (m.value ->> 'field_key') #>> '{}')::boolean
             else null
           end as boolean_value,
           expanded.option_key,
           true as expected_current,
           (ss.state = 'PENDING_REVIEW') as expected_provisional,
           (ss.state in ('COMPLETED', 'APPROVED')) as expected_final,
           (ss.state in ('COMPLETED', 'APPROVED', 'PENDING_REVIEW')) as expected_eligible
      from scoped_submissions ss
      cross join lateral jsonb_array_elements(ss.metric_contract_json -> 'metrics') as m(value)
      cross join lateral (
        select null::text as option_key
         where m.value ->> 'field_type' in ('integer', 'decimal', 'boolean')
        union all
        select ss.payload_json -> (m.value ->> 'field_key') #>> '{}' as option_key
         where m.value ->> 'field_type' = 'single_select'
        union all
        select opt.value as option_key
          from jsonb_array_elements_text(
            case
              when m.value ->> 'field_type' = 'multi_select'
                   and jsonb_typeof(ss.payload_json -> (m.value ->> 'field_key')) = 'array'
              then ss.payload_json -> (m.value ->> 'field_key')
              else '[]'::jsonb
            end
          ) as opt(value)
         where m.value ->> 'field_type' = 'multi_select'
      ) expanded
     where ss.current_revision_id is not null
       and ss.state <> 'DRAFT'
       and ss.payload_json is not null
       and ss.payload_json ? (m.value ->> 'field_key')
       and jsonb_typeof(ss.payload_json -> (m.value ->> 'field_key')) <> 'null'
  ),
  scoped_actual_rows as (
    select mv.*,
           ss.current_revision_id as submission_current_revision_id,
           ss.state as submission_state
      from public.work_report_metric_values mv
      join scoped_submissions ss on ss.submission_id = mv.submission_id
  ),
  missing_projections as (
    select er.submission_id,
           er.revision_id,
           er.field_key,
           coalesce(er.option_key, '') as option_key,
           'MISSING_PROJECTION'::text as issue_kind
      from expected_rows er
     where not exists (
       select 1
         from scoped_actual_rows ar
        where ar.revision_id = er.revision_id
          and ar.field_key = er.field_key
          and coalesce(ar.option_key, '') = coalesce(er.option_key, '')
     )
  ),
  extra_current_projections as (
    select ar.submission_id,
           ar.revision_id,
           ar.field_key,
           coalesce(ar.option_key, '') as option_key,
           'EXTRA_CURRENT_PROJECTION'::text as issue_kind
      from scoped_actual_rows ar
     where (ar.revision_id is not distinct from ar.submission_current_revision_id or ar.is_current_revision or ar.is_eligible)
       and not exists (
         select 1
           from expected_rows er
          where er.revision_id = ar.revision_id
            and er.field_key = ar.field_key
            and coalesce(er.option_key, '') = coalesce(ar.option_key, '')
       )
  ),
  value_mismatches as (
    select er.submission_id,
           er.revision_id,
           er.field_key,
           coalesce(er.option_key, '') as option_key,
           'VALUE_MISMATCH'::text as issue_kind
      from expected_rows er
      join scoped_actual_rows ar
        on ar.revision_id = er.revision_id
       and ar.field_key = er.field_key
       and coalesce(ar.option_key, '') = coalesce(er.option_key, '')
     where ar.metric_key is distinct from er.metric_key
        or ar.compatible_group is distinct from er.compatible_group
        or ar.value_type is distinct from er.value_type
        or ar.unit is distinct from er.unit
        or ar.numeric_value is distinct from er.numeric_value
        or ar.boolean_value is distinct from er.boolean_value
        or ar.option_key is distinct from er.option_key
        or ar.obligation_id is distinct from er.obligation_id
        or ar.template_id is distinct from er.template_id
        or ar.template_version_id is distinct from er.template_version_id
        or ar.assignee_app_user_id is distinct from er.assignee_app_user_id
        or ar.snapshot_team_id is distinct from er.snapshot_team_id
        or ar.period_key is distinct from er.period_key
  ),
  flag_mismatches as (
    select er.submission_id,
           er.revision_id,
           er.field_key,
           coalesce(er.option_key, '') as option_key,
           'FLAG_MISMATCH'::text as issue_kind
      from expected_rows er
      join scoped_actual_rows ar
        on ar.revision_id = er.revision_id
       and ar.field_key = er.field_key
       and coalesce(ar.option_key, '') = coalesce(er.option_key, '')
     where ar.is_current_revision is distinct from er.expected_current
        or ar.is_provisional is distinct from er.expected_provisional
        or ar.is_final is distinct from er.expected_final
        or ar.is_eligible is distinct from er.expected_eligible
    union all
    select ar.submission_id,
           ar.revision_id,
           ar.field_key,
           coalesce(ar.option_key, '') as option_key,
           'STALE_REVISION_FLAG_ACTIVE'::text as issue_kind
      from scoped_actual_rows ar
     where ar.revision_id is distinct from ar.submission_current_revision_id
       and (ar.is_current_revision or ar.is_provisional or ar.is_final or ar.is_eligible)
  ),
  all_issues as (
    select * from missing_projections
    union all
    select * from extra_current_projections
    union all
    select * from value_mismatches
    union all
    select * from flag_mismatches
  )
  select jsonb_build_object(
    'ok', (select count(*) = 0 from all_issues),
    'checked_submissions_count', (select count(*)::int from scoped_submissions where current_revision_id is not null and state <> 'DRAFT'),
    'expected_metric_rows_count', (select count(*)::int from expected_rows),
    'actual_eligible_rows_count', (select count(*)::int from scoped_actual_rows where is_eligible),
    'missing_projection_count', (select count(*)::int from missing_projections),
    'extra_current_projection_count', (select count(*)::int from extra_current_projections),
    'value_mismatch_count', (select count(*)::int from value_mismatches),
    'flag_mismatch_count', (select count(*)::int from flag_mismatches),
    'total_discrepancy_count', (select count(*)::int from all_issues),
    'discrepancies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'submission_id', ai.submission_id,
        'revision_id', ai.revision_id,
        'field_key', ai.field_key,
        'option_key', nullif(ai.option_key, ''),
        'issue_kind', ai.issue_kind
      ) order by ai.issue_kind, ai.submission_id, ai.field_key)
      from all_issues ai
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.work_report_get_submission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report__internal_resolve_analytics_scope(uuid, uuid, boolean, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_analytics_overview(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_analytics_breakdown(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer, integer, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_analytics_contributions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, text, uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_reconcile_metric_projection(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.work_report_get_submission(uuid, uuid, uuid) to service_role;
grant execute on function public.work_report_analytics_overview(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.work_report_analytics_breakdown(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer, integer, timestamptz) to service_role;
grant execute on function public.work_report_analytics_contributions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, text, uuid, uuid, text, text, integer) to service_role;
grant execute on function public.work_report_reconcile_metric_projection(uuid, uuid, uuid) to service_role;

commit;
