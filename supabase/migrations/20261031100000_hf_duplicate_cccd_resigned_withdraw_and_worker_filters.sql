-- Hotfix:
-- 1. Duplicate CCCD report & self-withdraw: allow withdrawing ON or OFF profiles
--    whenever at least one other ON or OFF profile remains in the same canonical
--    (CCCD + project_id + first_work_date) duplicate group, and allow currently
--    assigned Project Managers (QLDA) to withdraw duplicate profiles within the
--    projects they manage (in addition to the profile creator and actors holding
--    duplicate_cccd_withdraw).
-- 2. Worker directory & Excel export: add server-side filters for first_work_date
--    range (p_first_work_date_from, p_first_work_date_to) and recruitment source
--    (p_provider_type in ('hrp', 'vendor')), plus literal search on export.

begin;

create function public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_source text;
  v_definition text;
  v_expected text := p_expected;
  v_replacement text := p_replacement;
  v_next text;
  v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'HF duplicate CCCD withdraw invalid source patch specification';
  end if;

  select replace(p.prosrc, chr(13), '')
    into v_source
    from pg_catalog.pg_proc p
   where p.oid = p_signature;
  if v_source is null then
    raise exception 'HF duplicate CCCD withdraw source function not found: %', p_signature;
  end if;

  v_expected := replace(v_expected, chr(13), '');
  v_replacement := replace(v_replacement, chr(13), '');
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'HF duplicate CCCD withdraw expected % source fragment(s), found % in %',
      p_expected_count, v_count, p_signature;
  end if;

  v_next := replace(v_source, v_expected, v_replacement);
  select replace(pg_catalog.pg_get_functiondef(p.oid), chr(13), '')
    into v_definition
    from pg_catalog.pg_proc p
   where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'HF duplicate CCCD withdraw could not reconstruct function definition: %', p_signature;
  end if;

  execute replace(v_definition, v_source, v_next);
end;
$function$;

revoke all on function public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  regprocedure, text, text, integer
) from public, anon, authenticated, service_role;

-- 1a. Allow currently assigned Project Managers (QLDA) on the target entry's project
--     to self-withdraw duplicate CCCD rows (both pre-lock and post-lock).
select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure,
  $old$if v_entry.created_by_user_id is distinct from p_app_user_id
     and not public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw') then
    raise exception 'self withdraw requires entry creator or duplicate CCCD withdraw capability' using errcode = '42501';
  end if;$old$,
  $new$if v_entry.created_by_user_id is distinct from p_app_user_id
     and not public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw')
     and not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id) then
    raise exception 'self withdraw requires entry creator, assigned project manager, or duplicate CCCD withdraw capability' using errcode = '42501';
  end if;$new$,
  2
);

-- 1b. Allow withdrawing ON or OFF duplicate rows as long as at least one other valid
--     ON or OFF non-voided, non-deleted counterpart remains in the same canonical
--     (CCCD + project_id + first_work_date) duplicate cluster.
select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure,
  $old$     and coalesce((
           select st.status
             from public.direct_entry_employment_status_events st
            where st.entry_id = e.entry_id
            order by st.version desc
            limit 1
         ), 'UNCONFIRMED') = 'ON';$old$,
  $new$     and coalesce((
           select st.status
             from public.direct_entry_employment_status_events st
            where st.entry_id = e.entry_id
            order by st.version desc
            limit 1
         ), 'UNCONFIRMED') in ('ON', 'OFF');$new$,
  1
);

-- 1c. Record project_manager_self_withdraw / project scope when an assigned QLDA
--     (who is neither the creator nor a global duplicate_cccd_withdraw holder) withdraws.
select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure,
  $old$    'entry_self_withdraw_duplicate_cccd',
    case when v_entry.created_by_user_id = p_app_user_id
      then 'entry_creator_self_withdraw' else 'duplicate_cccd_withdraw' end,
    case when v_entry.created_by_user_id = p_app_user_id then 'own' else 'all' end,
    null
  );$old$,
  $new$    'entry_self_withdraw_duplicate_cccd',
    case
      when v_entry.created_by_user_id = p_app_user_id then 'entry_creator_self_withdraw'
      when public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw') then 'duplicate_cccd_withdraw'
      else 'project_manager_self_withdraw'
    end,
    case
      when v_entry.created_by_user_id = p_app_user_id then 'own'
      when public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw') then 'all'
      else 'project'
    end,
    null
  );$new$,
  1
);

-- 1d. Align can_self_withdraw in direct_entry_duplicate_cccd_report with the updated
--     eligibility (ON/OFF counterpart in same project+day cluster, plus assigned QLDA).
select public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure,
  $old$                                   'can_self_withdraw', (
                                     l.latest_status in ('ON','OFF')
                                     and exists (
                                       select 1
                                         from statused same_day_active
                                        where same_day_active.entry_id <> l.entry_id
                                          and same_day_active.cccd = l.cccd
                                          and same_day_active.project_id = l.project_id
                                          and same_day_active.first_work_date = l.first_work_date
                                          and same_day_active.latest_status = 'ON'
                                     )
                                     and (
                                       l.created_by_user_id = p_app_user_id
                                       or public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw')
                                     )
                                   )$old$,
  $new$                                   'can_self_withdraw', (
                                     l.latest_status in ('ON','OFF')
                                     and exists (
                                       select 1
                                         from statused same_day_active
                                        where same_day_active.entry_id <> l.entry_id
                                          and same_day_active.cccd = l.cccd
                                          and same_day_active.project_id = l.project_id
                                          and same_day_active.first_work_date = l.first_work_date
                                          and same_day_active.latest_status in ('ON','OFF')
                                     )
                                     and (
                                       l.created_by_user_id = p_app_user_id
                                       or public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw')
                                       or public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, l.project_id)
                                     )
                                   )$new$,
  1
);

drop function public.direct_entry_hf_duplicate_cccd_replace_proc_source(
  regprocedure, text, text, integer
);

comment on function public.direct_entry_self_withdraw_duplicate_cccd(
  uuid, uuid, uuid, integer, text, text
) is
  'Creator, assigned Project Manager (QLDA), or delegated duplicate-CCCD withdrawal. ON/OFF targets are eligible inside a duplicate cluster sharing canonical CCCD, project, and first-work date while at least one other ON/OFF counterpart remains in that cluster. service_role only.';

-- Internal worker directory helper supporting search, first_work_date range, and provider_type filters.
create or replace function public.direct_entry_list_workers_search(
  p_search text,
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text,
  p_recruiter_id uuid,
  p_employment_status text,
  p_cursor text,
  p_page_size integer,
  p_first_work_date_from date,
  p_first_work_date_to date,
  p_provider_type text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_audience jsonb;
  v_scope text;
  v_recruiter_ids uuid[];
  v_project_ids text[];
  v_view_pii boolean;
  v_view_payment boolean;
  v_is_full_admin boolean := false;
  v_team_leader_team_id uuid;
  v_page_size integer;
  v_cursor_stamp timestamptz;
  v_cursor_id uuid;
  v_scanned integer;
  v_items jsonb;
  v_next_cursor text;
  v_summary jsonb;
  v_team_id uuid;
begin
  v_audience := public.direct_entry_worker_directory_audience(
    p_auth_subject, p_app_user_id, p_scope, p_project_id
  );
  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    null;
  end;
  begin
    v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_team_leader_team_id := null;
  end;
  v_scope := v_audience->>'scope';
  v_team_id := nullif(v_audience->>'team_id', '')::uuid;
  v_view_pii := true;
  v_view_payment := true;
  v_recruiter_ids := case
    when pg_catalog.jsonb_array_length(v_audience->'recruiter_ids') = 0 then null
    else array(select pg_catalog.jsonb_array_elements_text(v_audience->'recruiter_ids')::uuid)
  end;
  v_project_ids := case
    when pg_catalog.jsonb_array_length(v_audience->'project_ids') = 0 then null
    else array(select pg_catalog.jsonb_array_elements_text(v_audience->'project_ids'))
  end;

  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_employment_status is not null
     and p_employment_status not in ('UNCONFIRMED', 'ON', 'OFF') then
    raise exception 'invalid employment status filter' using errcode = '22023';
  end if;
  p_provider_type := nullif(pg_catalog.btrim(p_provider_type), '');
  if p_provider_type is not null
     and p_provider_type not in ('hrp', 'vendor') then
    raise exception 'invalid provider type filter' using errcode = '22023';
  end if;
  if p_first_work_date_from is not null
     and p_first_work_date_to is not null
     and p_first_work_date_from > p_first_work_date_to then
    raise exception 'invalid first work date range' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, '|', 1)::timestamptz;
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
  end if;

  p_search := nullif(pg_catalog.btrim(p_search), '');
  if p_search is not null and
     (pg_catalog.char_length(p_search) > 100 or p_search ~ '[[:cntrl:]]') then
    raise exception 'invalid worker search' using errcode = '22023';
  end if;

  with candidates as (
    select e.entry_id,
           e.created_at,
           e.version,
           e.project_id,
           e.team_id,
           e.created_by_user_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.recruiter_id,
           e.labor_type,
           (select lt.display_name from public.direct_entry_labor_types lt
             where lt.labor_type_key = e.labor_type) as labor_type_display,
           s.state,
           pr.display_name as project_display,
           rc.display_name as recruiter_display,
           st.status as employment_status,
           pay.state as payment_state,
           pay.account_number,
           pay.bank_id,
           pay.account_holder_name,
           pay.version as payment_version
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
      join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join lateral (
        select ev.status
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
      left join public.direct_entry_payments pay
        on pay.entry_id = e.entry_id
     where e.deleted_at is null and e.voided_at is null
       and s.state = 'SUBMITTED'
       and (
         v_scope = 'all'
         or (v_scope = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
         or (v_scope = 'managed' and e.project_id = any(v_project_ids))
         or (v_scope = 'team' and e.team_id = v_team_id)
       )
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_recruiter_id is null or e.recruiter_id = p_recruiter_id)
       and (p_employment_status is null or st.status = p_employment_status)
       and (p_first_work_date_from is null or e.first_work_date >= p_first_work_date_from)
       and (p_first_work_date_to is null or e.first_work_date <= p_first_work_date_to)
       and (p_provider_type is null or e.provider_type = p_provider_type)
       and (p_search is null
         or pg_catalog.strpos(pg_catalog.lower(coalesce(e.worker_details->>'display_name', '')), pg_catalog.lower(p_search)) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(e.employee_code, '')), pg_catalog.lower(p_search)) > 0)
  ),
  summary as (
    select count(*)::bigint as total_workers,
           count(distinct project_id)::bigint as project_count,
           count(distinct recruiter_id)::bigint as recruiter_count
      from candidates
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             || '|' || c.entry_id::text as cursor
      from candidates c
     where v_cursor_stamp is null
        or (c.created_at, c.entry_id) < (v_cursor_stamp, v_cursor_id)
     order by c.created_at desc, c.entry_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by created_at desc, entry_id desc limit v_page_size
  )
  select
    (select count(*)::int from page),
    (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'entry_id', t.entry_id,
               'entry_version', t.version,
               'submission_state', t.state,
               'employee_code', t.employee_code,
               'display_name', t.worker_details->>'display_name',
               'project_id', t.project_id,
               'project_display', t.project_display,
               'first_work_date', pg_catalog.to_char(t.first_work_date, 'YYYY-MM-DD'),
               'labor_type', t.labor_type,
               'labor_type_display', t.labor_type_display,
               'employment_status', t.employment_status,
               'recruiter_id', t.recruiter_id,
               'recruiter_display', t.recruiter_display,
               'payment', case
                 when v_view_payment and t.payment_state is not null then pg_catalog.jsonb_build_object(
                   'state', t.payment_state,
                   'account_number', t.account_number,
                   'bank_id', t.bank_id,
                   'account_holder_name', t.account_holder_name,
                   'version', t.payment_version
                 )
                 else null
               end,
               'pending_request', case when pr.request_id is null then null else pg_catalog.jsonb_build_object(
                 'request_id', pr.request_id,
                 'state', 'PENDING',
                 'version', pr.version
               ) end,
               'last_decision', case when ld.state is null then null else pg_catalog.jsonb_build_object(
                 'state', ld.state,
                 'decided_at', pg_catalog.to_char(ld.decided_at at time zone 'UTC', 'YYYY-MM-DD')
                   || 'T' || pg_catalog.to_char(ld.decided_at at time zone 'UTC', 'HH24:MI:SS.US')
                   || 'Z'
               ) end,
               'is_project_manager',
                 public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, t.project_id),
               'allowed_actions', pg_catalog.jsonb_build_object(
                 'view', true,
                 'view_pii', v_view_pii,
                 'view_payment', v_view_payment,
                 'direct_edit', public.direct_entry_resolve_direct_edit_authority(
                   p_auth_subject, p_app_user_id, t.created_by_user_id, t.team_id,
                   t.project_id, v_is_full_admin, v_team_leader_team_id
                 ) is not null,
                 'propose_change',
                   public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, t.project_id),
                 'propose_change_code', case
                   when public.direct_entry_actor_is_assigned_project_manager(
                     p_app_user_id, t.project_id
                   ) then null
                   else 'NOT_PROJECT_MANAGER'
                 end
               )
             ) order by t.created_at desc, t.entry_id desc), '[]'::jsonb)
        from trimmed t
        left join lateral (
          select r.request_id, r.version
            from public.direct_entry_change_requests r
            join public.direct_entry_change_request_items i
              on i.request_id = r.request_id
           where i.entry_id = t.entry_id
             and r.state = 'PENDING'
           order by r.created_at desc, r.request_id desc
           limit 1
        ) pr on true
        left join lateral (
          select r.state, r.decided_at
            from public.direct_entry_change_requests r
            join public.direct_entry_change_request_items i
              on i.request_id = r.request_id
           where i.entry_id = t.entry_id
             and r.state in ('APPROVED', 'REJECTED')
           order by r.decided_at desc nulls last, r.request_id desc
           limit 1
        ) ld on true
    ),
    (
      select t.cursor from trimmed t
       order by t.created_at asc, t.entry_id asc
       limit 1
    ),
    (
      select pg_catalog.jsonb_build_object(
        'total_workers', s.total_workers,
        'project_count', s.project_count,
        'recruiter_count', s.recruiter_count
      ) from summary s
    )
  into v_scanned, v_items, v_next_cursor, v_summary;

  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'scope', v_scope,
    'page_size', v_page_size,
    'has_more', v_scanned > v_page_size,
    'next_cursor', case when v_scanned > v_page_size then v_next_cursor else null end,
    'summary', v_summary,
    'authorization_date', public.direct_entry_authorization_date()
  );
end;
$function$;

revoke all on function public.direct_entry_list_workers_search(
  text, uuid, uuid, text, text, uuid, text, text, integer, date, date, text
) from public, anon, authenticated, service_role;

create or replace function public.direct_entry_list_workers_search(
  p_search text,
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text default null::text,
  p_recruiter_id uuid default null::uuid,
  p_employment_status text default null::text,
  p_cursor text default null::text,
  p_page_size integer default null::integer
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select public.direct_entry_list_workers_search(
    p_search, p_auth_subject, p_app_user_id, p_scope, p_project_id,
    p_recruiter_id, p_employment_status, p_cursor, p_page_size,
    null::date, null::date, null::text
  )
$function$;

revoke all on function public.direct_entry_list_workers_search(
  text, uuid, uuid, text, text, uuid, text, text, integer
) from public, anon, authenticated, service_role;

create or replace function public.direct_entry_list_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text,
  p_recruiter_id uuid,
  p_employment_status text,
  p_cursor text,
  p_page_size integer,
  p_search text,
  p_first_work_date_from date,
  p_first_work_date_to date,
  p_provider_type text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select public.direct_entry_list_workers_search(
    p_search, p_auth_subject, p_app_user_id, p_scope, p_project_id,
    p_recruiter_id, p_employment_status, p_cursor, p_page_size,
    p_first_work_date_from, p_first_work_date_to, p_provider_type
  )
$function$;

revoke all on function public.direct_entry_list_workers(
  uuid, uuid, text, text, uuid, text, text, integer, text, date, date, text
) from public, anon, authenticated, service_role;

grant execute on function public.direct_entry_list_workers(
  uuid, uuid, text, text, uuid, text, text, integer, text, date, date, text
) to service_role;

-- Filtered worker export RPC supporting search, first_work_date range, and provider_type.
create or replace function public.direct_entry_export_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text,
  p_recruiter_id uuid,
  p_employment_status text,
  p_reason text,
  p_search text,
  p_first_work_date_from date,
  p_first_work_date_to date,
  p_provider_type text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_audience jsonb;
  v_scope text;
  v_recruiter_ids uuid[];
  v_project_ids text[];
  v_scope_kind text;
  v_reason_id uuid;
  v_filter_hash text;
  v_total integer;
  v_rows jsonb;
  v_team_id uuid;
begin
  if p_reason is not null and pg_catalog.length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(pg_catalog.btrim(p_reason), '');

  if p_scope is null or p_scope not in ('recruited', 'managed', 'team', 'all') then
    raise exception 'worker export scope denied' using errcode = '42501';
  end if;

  v_audience := public.direct_entry_worker_directory_audience(
    p_auth_subject, p_app_user_id, p_scope, p_project_id
  );
  v_scope := v_audience->>'scope';
  v_team_id := nullif(v_audience->>'team_id', '')::uuid;
  v_recruiter_ids := case
    when pg_catalog.jsonb_array_length(v_audience->'recruiter_ids') = 0 then null
    else array(select pg_catalog.jsonb_array_elements_text(v_audience->'recruiter_ids')::uuid)
  end;
  v_project_ids := case
    when pg_catalog.jsonb_array_length(v_audience->'project_ids') = 0 then null
    else array(select pg_catalog.jsonb_array_elements_text(v_audience->'project_ids'))
  end;

  if p_employment_status is not null
     and p_employment_status not in ('UNCONFIRMED', 'ON', 'OFF') then
    raise exception 'invalid employment status filter' using errcode = '22023';
  end if;

  p_provider_type := nullif(pg_catalog.btrim(p_provider_type), '');
  if p_provider_type is not null
     and p_provider_type not in ('hrp', 'vendor') then
    raise exception 'invalid provider type filter' using errcode = '22023';
  end if;

  if p_first_work_date_from is not null
     and p_first_work_date_to is not null
     and p_first_work_date_from > p_first_work_date_to then
    raise exception 'invalid first work date range' using errcode = '22023';
  end if;

  p_search := nullif(pg_catalog.btrim(p_search), '');
  if p_search is not null and
     (pg_catalog.char_length(p_search) > 100 or p_search ~ '[[:cntrl:]]') then
    raise exception 'invalid worker search' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  with candidates as (
    select e.entry_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.provider_type,
           e.general_note,
           pr.display_name as project_display,
           rc.display_name as recruiter_display,
           (select lt.display_name from public.direct_entry_labor_types lt
             where lt.labor_type_key = e.labor_type) as labor_type_display,
           st.status as employment_status,
           st.leave_date,
           st.leave_reason_text,
           pay.account_number,
           pay.bank_name,
           pay.account_holder_name
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
      join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join lateral (
        select ev.status, ev.leave_date, ev.leave_reason_text
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
      left join public.direct_entry_payments pay
        on pay.entry_id = e.entry_id
     where e.deleted_at is null and e.voided_at is null
       and s.state = 'SUBMITTED'
       and (
         (v_scope = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
         or (v_scope = 'managed' and e.project_id = any(v_project_ids))
         or (v_scope = 'team' and e.team_id = v_team_id)
         or (v_scope = 'all')
       )
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_recruiter_id is null or e.recruiter_id = p_recruiter_id)
       and (p_employment_status is null or st.status = p_employment_status)
       and (p_first_work_date_from is null or e.first_work_date >= p_first_work_date_from)
       and (p_first_work_date_to is null or e.first_work_date <= p_first_work_date_to)
       and (p_provider_type is null or e.provider_type = p_provider_type)
       and (p_search is null
         or pg_catalog.strpos(pg_catalog.lower(coalesce(e.worker_details->>'display_name', '')), pg_catalog.lower(p_search)) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(e.employee_code, '')), pg_catalog.lower(p_search)) > 0)
  ),
  bounded as (
    select * from candidates
     order by first_work_date desc, entry_id desc
     limit 10001
  )
  select coalesce((select count(*)::int from bounded), 0),
         coalesce((
           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'employee_code', b.employee_code,
             'display_name', b.worker_details->>'display_name',
             'date_of_birth', case
               when b.worker_details->'date_of_birth'->>'state' = 'provided'
               then b.worker_details->'date_of_birth'->>'value' else null end,
             'national_id', case
               when b.worker_details->'national_id'->>'state' = 'provided'
               then b.worker_details->'national_id'->>'value' else null end,
             'national_id_issued_at', case
               when b.worker_details->'national_id_issued_at'->>'state' = 'provided'
               then b.worker_details->'national_id_issued_at'->>'value' else null end,
             'phone', case
               when b.worker_details->'phone'->>'state' = 'provided'
               then b.worker_details->'phone'->>'value' else null end,
             'address', case
               when b.worker_details->'address'->>'state' = 'provided'
               then b.worker_details->'address'->>'value' else null end,
             'project_display', b.project_display,
             'first_work_date', pg_catalog.to_char(b.first_work_date, 'YYYY-MM-DD'),
             'labor_type_display', b.labor_type_display,
             'recruiter_display', b.recruiter_display,
             'provider_type', public.recruitment_provider_type_display(b.provider_type),
             'employment_status', b.employment_status,
             'leave_date', case when b.leave_date is null then null
               else pg_catalog.to_char(b.leave_date, 'YYYY-MM-DD') end,
             'leave_reason', b.leave_reason_text,
             'account_number', b.account_number,
             'bank_name', b.bank_name,
             'account_holder_name', b.account_holder_name,
             'payment_note', null,
             'general_note', b.general_note
           ) order by b.first_work_date desc, b.entry_id desc)
           from bounded b
         ), '[]'::jsonb)
    into v_total, v_rows;

  v_filter_hash := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'scope', p_scope,
      'project_id', p_project_id,
      'recruiter_id', p_recruiter_id,
      'employment_status', p_employment_status
    ) || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'search', p_search,
      'first_work_date_from', p_first_work_date_from,
      'first_work_date_to', p_first_work_date_to,
      'provider_type', p_provider_type
    ))
  );
  v_scope_kind := case
    when p_scope = 'recruited' then 'own'
    when p_scope = 'managed' then 'project'
    when p_scope = 'team' then 'team'
    else 'all'
  end;

  if v_total > 10000 then
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, denial_code, reason_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'worker_export', null,
      'worker-export:' || p_scope || ':' || v_total::text || ':' || v_filter_hash,
      v_scope_kind, 'REJECTED', 'EXPORT_ROW_LIMIT_EXCEEDED', v_reason_id,
      array[]::text[]
    );
    return pg_catalog.jsonb_build_object('status', 'too_many_rows', 'limit', 10000);
  end if;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, denial_code, reason_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'worker_export', null,
    'worker-export:' || p_scope || ':' || v_total::text || ':' || v_filter_hash,
    v_scope_kind, 'ALLOW', null, v_reason_id, array[]::text[]
  );

  return pg_catalog.jsonb_build_object('status', 'ok', 'rows', v_rows);
end;
$function$;

revoke all on function public.direct_entry_export_workers(
  uuid, uuid, text, text, uuid, text, text, text, date, date, text
) from public, anon, authenticated, service_role;

grant execute on function public.direct_entry_export_workers(
  uuid, uuid, text, text, uuid, text, text, text, date, date, text
) to service_role;

create or replace function public.direct_entry_export_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text default null::text,
  p_recruiter_id uuid default null::uuid,
  p_employment_status text default null::text,
  p_reason text default null::text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select public.direct_entry_export_workers(
    p_auth_subject, p_app_user_id, p_scope, p_project_id,
    p_recruiter_id, p_employment_status, p_reason,
    null::text, null::date, null::date, null::text
  )
$function$;

revoke all on function public.direct_entry_export_workers(
  uuid, uuid, text, text, uuid, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.direct_entry_export_workers(
  uuid, uuid, text, text, uuid, text, text
) to service_role;

-- Align function owners to table owner when permitted, and ensure SECURITY DEFINER
-- function owners have EXECUTE on private helpers across operator roles (`s0_t1c_runner`).
do $grant_worker_filter_internal$
declare
  v_table_owner_oid oid;
  v_table_owner name;
  v_sig text;
  v_proc_owner_oid oid;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_table_owner_oid, v_table_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  foreach v_sig in array array[
    'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)',
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)',
    'public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer,date,date,text)',
    'public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer)',
    'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer,text,date,date,text)',
    'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text,text,date,date,text)',
    'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_sig);

    if v_proc_owner_oid is distinct from v_table_owner_oid
       and pg_catalog.pg_has_role(current_user, v_table_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_table_owner);
    end if;
  end loop;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)'::regprocedure,
       'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure,
       'public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer,date,date,text)'::regprocedure,
       'public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
       'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
       'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer,text)'::regprocedure,
       'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer,text,date,date,text)'::regprocedure,
       'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)'::regprocedure,
       'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text,text,date,date,text)'::regprocedure
     )
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer,date,date,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text,text,date,date,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_worker_directory_audience(uuid,uuid,text,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_app_user_admin(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_authorization_date() to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reason(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_payload_hash(jsonb) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.recruitment_provider_type_display(text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid,text) to %I',
      v_owner
    );
  end loop;
end;
$grant_worker_filter_internal$;

commit;
