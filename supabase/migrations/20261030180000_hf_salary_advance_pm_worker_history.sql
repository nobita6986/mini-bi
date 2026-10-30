-- =============================================================================
-- Hotfix: Salary Advance Worker Info, 30-Day Summary & History for QLDA (PM)
-- =============================================================================
-- 1. Extract reusable internal helper
--    `public.salary_advance__internal_compute_worker_30d_summary` so both
--    request detail (`salary_advance__internal_worker_30d_summary`) and QLDA
--    worker picker (`salary_advance_list_project_workers`) compute the exact
--    same 30-day rolling summary (`Asia/Ho_Chi_Minh`, `APPROVED` + `REVIEWED`,
--    matching across `worker_entry_id`, `candidate_id`, or canonical CCCD)
--    strictly within the caller's authorized project scope.
-- 2. Extend `public.salary_advance__internal_worker_30d_summary` and
--    `public.salary_advance_list_worker_history` so a Creator Project Manager
--    (`is_creator_project_manager`) on a currently managed project receives
--    the 30-day summary and full filterable/paginated history scoped strictly
--    to `managed_project_ids`, without leaking advances from unmanaged projects
--    and without exposing raw CCCD.
-- 3. Include `advance_30d_summary` on each worker option returned by
--    `public.salary_advance_list_project_workers` (scoped to the QLDA's
--    `managed_project_ids`) and add `service_role`-only RPC
--    `public.salary_advance_list_project_worker_history` so QLDA can open the
--    worker's advance history on demand in the Create Request dialog before
--    submitting a request.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Internal helper: compute 30-day salary advance summary for a worker
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_compute_worker_30d_summary(
  p_worker_entry_id uuid,
  p_is_supervisory boolean,
  p_scoped_project_ids text[],
  p_today date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_cccd text := null;
  v_effective_today date;
  v_from_date date;
  v_total_count integer := 0;
  v_total_amount bigint := 0;
begin
  select e.*
    into v_entry
    from public.direct_entries e
   where e.entry_id = p_worker_entry_id;

  if coalesce(v_entry.worker_details->'national_id'->>'state', '') = 'provided' then
    v_cccd := public.direct_entry_canonical_national_id(
      v_entry.worker_details->'national_id'->>'value'
    );
    if not public.direct_entry_is_canonical_national_id(v_cccd) then
      v_cccd := null;
    end if;
  end if;

  v_effective_today := coalesce(
    p_today,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_from_date := (v_effective_today - 29);

  select count(*)::integer,
         coalesce(sum(r.requested_amount_vnd), 0)::bigint
    into v_total_count,
         v_total_amount
    from public.salary_advance_requests r
    join public.direct_entries de
      on de.entry_id = r.worker_entry_id
   where (
     r.worker_entry_id = p_worker_entry_id
     or (v_entry.candidate_id is not null and de.candidate_id = v_entry.candidate_id)
     or (
       v_cccd is not null
       and coalesce(de.worker_details->'national_id'->>'state', '') = 'provided'
       and public.direct_entry_canonical_national_id(de.worker_details->'national_id'->>'value') = v_cccd
     )
   )
     and (
       coalesce(p_is_supervisory, false)
       or r.project_id = any(coalesce(p_scoped_project_ids, array[]::text[]))
     )
     and r.request_state = 'APPROVED'
     and r.evidence_review_state = 'REVIEWED'
     and (
       (coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) at time zone 'Asia/Ho_Chi_Minh')::date
       between v_from_date and v_effective_today
     );

  return pg_catalog.jsonb_build_object(
    'window_days', 30,
    'window_from_date', pg_catalog.to_char(v_from_date, 'YYYY-MM-DD'),
    'window_to_date', pg_catalog.to_char(v_effective_today, 'YYYY-MM-DD'),
    'timezone', 'Asia/Ho_Chi_Minh',
    'qualifying_rule', 'APPROVED_AND_EVIDENCE_REVIEWED',
    'total_count', coalesce(v_total_count, 0),
    'total_amount_vnd', coalesce(v_total_amount, 0)::bigint::text
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 2. Internal helper: 30-day summary on request detail (Accountant / QLDA / Supervisory)
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_worker_30d_summary(
  p_req public.salary_advance_requests,
  p_auth jsonb,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_access jsonb;
  v_is_creator_pm boolean := false;
  v_is_assigned_accountant boolean := false;
  v_is_supervisory boolean := false;
  v_scoped_project_ids text[] := array[]::text[];
  v_today date;
begin
  v_access := public.salary_advance__internal_request_access(p_auth, p_app_user_id, p_req);
  v_is_creator_pm := coalesce((v_access->>'is_creator_project_manager')::boolean, false);
  v_is_assigned_accountant := coalesce((v_access->>'is_assigned_project_accountant')::boolean, false);
  v_is_supervisory := coalesce((v_access->>'is_supervisory_viewer')::boolean, false);

  if not v_is_creator_pm and not v_is_assigned_accountant and not v_is_supervisory then
    return null;
  end if;

  if not v_is_supervisory then
    if v_is_assigned_accountant then
      v_scoped_project_ids := v_scoped_project_ids || array(
        select pg_catalog.jsonb_array_elements_text(coalesce(p_auth->'accountant_project_ids', '[]'::jsonb))
      );
    end if;
    if v_is_creator_pm then
      v_scoped_project_ids := v_scoped_project_ids || array(
        select pg_catalog.jsonb_array_elements_text(coalesce(p_auth->'managed_project_ids', '[]'::jsonb))
      );
    end if;
  end if;

  v_today := coalesce(
    (p_auth->>'authorization_date')::date,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  return public.salary_advance__internal_compute_worker_30d_summary(
    p_req.worker_entry_id,
    v_is_supervisory,
    v_scoped_project_ids,
    v_today
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Internal helper: shared worker advance history query & aggregation
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_query_worker_history(
  p_anchor_request_id uuid,
  p_worker_entry_id uuid,
  p_is_supervisory boolean,
  p_scoped_project_ids text[],
  p_today date,
  p_period_mode text default 'THIS_MONTH',
  p_month text default null,
  p_from_date text default null,
  p_to_date text default null,
  p_cursor text default null,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_cccd text := null;
  v_effective_today date;
  v_mode text;
  v_raw_month text;
  v_raw_from text;
  v_raw_to text;
  v_resolved_month text := null;
  v_filter_from date := null;
  v_filter_to date := null;
  v_page_size integer;
  v_cursor_ts timestamptz := null;
  v_cursor_id uuid := null;
  v_total_count integer := 0;
  v_total_amount bigint := 0;
  v_fetched_count integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_next_cursor text := null;
begin
  v_page_size := coalesce(p_page_size, 20);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_effective_today := coalesce(
    p_today,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  v_mode := pg_catalog.upper(pg_catalog.btrim(coalesce(nullif(pg_catalog.btrim(p_period_mode), ''), 'THIS_MONTH')));
  v_raw_month := nullif(pg_catalog.btrim(coalesce(p_month, '')), '');
  v_raw_from := nullif(pg_catalog.btrim(coalesce(p_from_date, '')), '');
  v_raw_to := nullif(pg_catalog.btrim(coalesce(p_to_date, '')), '');

  if v_mode = 'LAST_30_DAYS' then
    if v_raw_month is not null or v_raw_from is not null or v_raw_to is not null then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_filter_from := (v_effective_today - 29);
    v_filter_to := v_effective_today;

  elsif v_mode = 'THIS_MONTH' then
    if v_raw_month is not null or v_raw_from is not null or v_raw_to is not null then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_filter_from := pg_catalog.date_trunc('month', v_effective_today::timestamp)::date;
    v_filter_to := (pg_catalog.date_trunc('month', v_effective_today::timestamp) + interval '1 month - 1 day')::date;
    v_resolved_month := pg_catalog.to_char(v_effective_today, 'YYYY-MM');

  elsif v_mode = 'MONTH' then
    if v_raw_month is null
       or v_raw_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
       or v_raw_from is not null
       or v_raw_to is not null then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_filter_from := pg_catalog.to_date(v_raw_month || '-01', 'YYYY-MM-DD');
    v_filter_to := (v_filter_from + interval '1 month - 1 day')::date;
    v_resolved_month := v_raw_month;

  elsif v_mode = 'ALL' then
    if v_raw_month is not null or v_raw_from is not null or v_raw_to is not null then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_filter_from := null;
    v_filter_to := null;

  elsif v_mode = 'CUSTOM_RANGE' then
    if v_raw_month is not null or (v_raw_from is null and v_raw_to is null) then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;

    if v_raw_from is not null then
      if v_raw_from !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'SALARY_ADVANCE_QUERY_INVALID'
          using errcode = '22023';
      end if;
      begin
        v_filter_from := v_raw_from::date;
      exception
        when others then
          raise exception 'SALARY_ADVANCE_QUERY_INVALID'
            using errcode = '22023';
      end;
      if pg_catalog.to_char(v_filter_from, 'YYYY-MM-DD') <> v_raw_from then
        raise exception 'SALARY_ADVANCE_QUERY_INVALID'
          using errcode = '22023';
      end if;
    end if;

    if v_raw_to is not null then
      if v_raw_to !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'SALARY_ADVANCE_QUERY_INVALID'
          using errcode = '22023';
      end if;
      begin
        v_filter_to := v_raw_to::date;
      exception
        when others then
          raise exception 'SALARY_ADVANCE_QUERY_INVALID'
            using errcode = '22023';
      end;
      if pg_catalog.to_char(v_filter_to, 'YYYY-MM-DD') <> v_raw_to then
        raise exception 'SALARY_ADVANCE_QUERY_INVALID'
          using errcode = '22023';
      end if;
    end if;

    if v_filter_from is not null and v_filter_to is not null and v_filter_from > v_filter_to then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;

  else
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_cursor is not null and pg_catalog.btrim(p_cursor) <> '' then
    if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_cursor_ts := pg_catalog.split_part(p_cursor, '|', 1)::timestamptz;
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
  end if;

  select e.*
    into v_entry
    from public.direct_entries e
   where e.entry_id = p_worker_entry_id;

  if coalesce(v_entry.worker_details->'national_id'->>'state', '') = 'provided' then
    v_cccd := public.direct_entry_canonical_national_id(
      v_entry.worker_details->'national_id'->>'value'
    );
    if not public.direct_entry_is_canonical_national_id(v_cccd) then
      v_cccd := null;
    end if;
  end if;

  with matching as (
    select r.request_id,
           r.project_id,
           coalesce(pr.display_name, r.project_id) as project_display_name,
           r.worker_entry_id,
           de.employee_code as worker_employee_code,
           public.salary_advance__internal_worker_display_name(de.worker_details) as worker_display_name,
           r.requested_amount_vnd,
           coalesce(r.payment_method, 'CASH') as payment_method,
           r.initial_content,
           r.request_state,
           r.evidence_review_state,
           coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) as effective_at,
           (coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) at time zone 'Asia/Ho_Chi_Minh')::date as effective_date,
           r.created_at,
           r.decided_at,
           r.evidence_reviewed_at,
           r.created_by_user_id,
           r.decided_by_user_id,
           r.evidence_reviewed_by_user_id
      from public.salary_advance_requests r
      join public.direct_entries de
        on de.entry_id = r.worker_entry_id
      left join public.direct_entry_projects pr
        on pr.project_id = r.project_id
     where (
       r.worker_entry_id = p_worker_entry_id
       or (v_entry.candidate_id is not null and de.candidate_id = v_entry.candidate_id)
       or (
         v_cccd is not null
         and coalesce(de.worker_details->'national_id'->>'state', '') = 'provided'
         and public.direct_entry_canonical_national_id(de.worker_details->'national_id'->>'value') = v_cccd
       )
     )
       and (
         coalesce(p_is_supervisory, false)
         or r.project_id = any(coalesce(p_scoped_project_ids, array[]::text[]))
       )
       and r.request_state = 'APPROVED'
       and r.evidence_review_state = 'REVIEWED'
       and (
         v_filter_from is null
         or (coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) at time zone 'Asia/Ho_Chi_Minh')::date >= v_filter_from
       )
       and (
         v_filter_to is null
         or (coalesce(r.evidence_reviewed_at, r.decided_at, r.created_at) at time zone 'Asia/Ho_Chi_Minh')::date <= v_filter_to
       )
  ),
  agg as (
    select count(*)::integer as total_count,
           coalesce(sum(m.requested_amount_vnd), 0)::bigint as total_amount
      from matching m
  ),
  paged as (
    select m.*
      from matching m
     where (
       v_cursor_ts is null
       or (m.effective_at, m.request_id) < (v_cursor_ts, v_cursor_id)
     )
     order by m.effective_at desc, m.request_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select p.*
      from paged p
     order by p.effective_at desc, p.request_id desc
     limit v_page_size
  )
  select (select a.total_count from agg a),
         (select a.total_amount from agg a),
         (select count(*)::integer from paged),
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'request_id', t.request_id,
               'project_id', t.project_id,
               'project_display_name', t.project_display_name,
               'worker_entry_id', t.worker_entry_id,
               'worker_employee_code', t.worker_employee_code,
               'worker_display_name', t.worker_display_name,
               'requested_amount_vnd', t.requested_amount_vnd::text,
               'payment_method', t.payment_method,
               'initial_content', t.initial_content,
               'request_state', t.request_state,
               'evidence_review_state', t.evidence_review_state,
               'effective_date', pg_catalog.to_char(t.effective_date, 'YYYY-MM-DD'),
               'effective_at', pg_catalog.to_char(t.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'created_at', pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'decided_at', case
                 when t.decided_at is not null
                   then pg_catalog.to_char(t.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 else null
               end,
               'evidence_reviewed_at', case
                 when t.evidence_reviewed_at is not null
                   then pg_catalog.to_char(t.evidence_reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 else null
               end,
               'created_by_display_name', public.salary_advance__internal_actor_display_name(t.created_by_user_id),
               'decided_by_display_name', case
                 when t.decided_by_user_id is not null
                   then public.salary_advance__internal_actor_display_name(t.decided_by_user_id)
                 else null
               end,
               'evidence_reviewed_by_display_name', case
                 when t.evidence_reviewed_by_user_id is not null
                   then public.salary_advance__internal_actor_display_name(t.evidence_reviewed_by_user_id)
                 else null
               end
             )
             order by t.effective_at desc, t.request_id desc
           ),
           '[]'::jsonb
         ),
         (
           select pg_catalog.to_char(t2.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                  || '|' || t2.request_id::text
             from trimmed t2
            order by t2.effective_at asc, t2.request_id asc
            limit 1
         )
    into v_total_count,
         v_total_amount,
         v_fetched_count,
         v_items,
         v_next_cursor
    from trimmed t;

  return pg_catalog.jsonb_build_object(
    'request_id', p_anchor_request_id,
    'worker_entry_id', p_worker_entry_id,
    'worker_employee_code', v_entry.employee_code,
    'worker_display_name', public.salary_advance__internal_worker_display_name(v_entry.worker_details),
    'period_mode', v_mode,
    'month', v_resolved_month,
    'from_date', case
      when v_filter_from is not null then pg_catalog.to_char(v_filter_from, 'YYYY-MM-DD')
      else null
    end,
    'to_date', case
      when v_filter_to is not null then pg_catalog.to_char(v_filter_to, 'YYYY-MM-DD')
      else null
    end,
    'timezone', 'Asia/Ho_Chi_Minh',
    'qualifying_rule', 'APPROVED_AND_EVIDENCE_REVIEWED',
    'total_count', coalesce(v_total_count, 0),
    'total_amount_vnd', coalesce(v_total_amount, 0)::bigint::text,
    'items', v_items,
    'has_more', (v_fetched_count > v_page_size),
    'next_cursor', case when v_fetched_count > v_page_size then v_next_cursor else null end
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. RPC: list project workers (including QLDA-scoped 30-day advance summary)
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance_list_project_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_search text default null,
  p_cursor text default null,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_managed_project_ids text[] := array[]::text[];
  v_today date;
  v_page_size integer;
  v_search text;
  v_cursor_code text := null;
  v_cursor_id uuid := null;
  v_items jsonb := '[]'::jsonb;
  v_total_fetched integer := 0;
  v_next_cursor text := null;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_managed_project_ids := array(
    select pg_catalog.jsonb_array_elements_text(coalesce(v_auth->'managed_project_ids', '[]'::jsonb))
  );
  v_today := coalesce(
    (v_auth->>'authorization_date')::date,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_search := public.salary_advance__internal_validate_text(
    p_search,
    1,
    120,
    true,
    'SALARY_ADVANCE_QUERY_INVALID'
  );

  if p_cursor is not null and pg_catalog.btrim(p_cursor) <> '' then
    if p_cursor !~ '^[^|]+\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_cursor_code := pg_catalog.split_part(p_cursor, '|', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
  end if;

  with eligible as (
    select e.entry_id as worker_entry_id,
           e.employee_code,
           public.salary_advance__internal_worker_display_name(e.worker_details) as display_name,
           pg_catalog.to_char(e.first_work_date, 'YYYY-MM-DD') as first_work_date,
           (public.salary_advance__internal_resolve_worker_portrait(e.candidate_id) is not null) as has_portrait
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
     where e.project_id = p_project_id
       and e.deleted_at is null
       and e.voided_at is null
       and s.state = 'SUBMITTED'
       and coalesce(e.provider_type, '') <> 'vendor'
       and not exists (
         select 1
           from public.recruiter_provider_memberships m
          where m.recruiter_id = e.recruiter_id
            and m.is_current = true
            and (m.provider_type = 'vendor' or m.vendor_id is not null)
       )
  ),
  filtered as (
    select w.*
      from eligible w
     where (
       v_search is null
       or pg_catalog.lower(w.employee_code) like '%' || pg_catalog.lower(v_search) || '%'
       or pg_catalog.lower(w.display_name) like '%' || pg_catalog.lower(v_search) || '%'
     )
       and (
         v_cursor_code is null
         or (w.employee_code, w.worker_entry_id::text) > (v_cursor_code, v_cursor_id::text)
       )
     order by w.employee_code asc, w.worker_entry_id asc
     limit v_page_size + 1
  ),
  trimmed as (
    select t.*,
           public.salary_advance__internal_evaluate_worker(t.worker_entry_id) as eval,
           public.salary_advance__internal_compute_worker_30d_summary(
             t.worker_entry_id,
             false,
             v_managed_project_ids,
             v_today
           ) as advance_30d_summary
      from (
        select *
          from filtered
         order by employee_code asc, worker_entry_id asc
         limit v_page_size
      ) t
  )
  select (select count(*)::integer from filtered),
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'worker_entry_id', t.worker_entry_id,
               'employee_code', t.employee_code,
               'display_name', t.display_name,
               'first_work_date', t.first_work_date,
               'provider_type', coalesce(t.eval->>'provider_type', 'hrp'),
               'recruiter_display_name', t.eval->>'recruiter_display_name',
               'recruiter_code', t.eval->'recruiter_code',
               'has_portrait', t.has_portrait,
               'employment_status', t.eval->>'employment_status',
               'active_on_project_count', (t.eval->>'active_on_project_count')::integer,
               'has_duplicate_cccd', (t.eval->>'has_duplicate_cccd')::boolean,
               'is_eligible', (t.eval->>'is_eligible')::boolean,
               'ineligible_reasons', t.eval->'ineligible_reasons',
               'bank_transfer_eligible', (t.eval->>'bank_transfer_eligible')::boolean,
               'bank_ineligible_reason', t.eval->'bank_ineligible_reason',
               'bank_account', case
                 when t.eval->'bank_account' is not null
                      and pg_catalog.jsonb_typeof(t.eval->'bank_account') = 'object' then
                   pg_catalog.jsonb_build_object(
                     'bank_id', t.eval->'bank_account'->'bank_id',
                     'institution_name', t.eval->'bank_account'->'institution_name',
                     'account_number', t.eval->'bank_account'->'account_number',
                     'account_number_masked', t.eval->'bank_account'->'account_number_masked',
                     'account_holder_name', t.eval->'bank_account'->'account_holder_name',
                     'has_bank_account', t.eval->'bank_account'->'has_bank_account',
                     'is_self_owned', t.eval->'bank_account'->'is_self_owned'
                   )
                 else null
               end,
               'advance_30d_summary', t.advance_30d_summary
             )
             order by t.employee_code asc, t.worker_entry_id asc
           ),
           '[]'::jsonb
         ),
         (
           select t2.employee_code || '|' || t2.worker_entry_id::text
             from trimmed t2
            order by t2.employee_code desc, t2.worker_entry_id desc
            limit 1
         )
    into v_total_fetched, v_items, v_next_cursor
    from trimmed t;

  return pg_catalog.jsonb_build_object(
    'project_id', p_project_id,
    'workers', v_items,
    'has_more', (v_total_fetched > v_page_size),
    'next_cursor', case when v_total_fetched > v_page_size then v_next_cursor else null end
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. RPC: list worker salary advance history by request (Accountant / QLDA / Supervisory)
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance_list_worker_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_period_mode text default 'THIS_MONTH',
  p_month text default null,
  p_from_date text default null,
  p_to_date text default null,
  p_cursor text default null,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_is_creator_pm boolean := false;
  v_is_assigned_accountant boolean := false;
  v_is_supervisory boolean := false;
  v_scoped_project_ids text[] := array[]::text[];
  v_today date;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  if p_request_id is null then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  v_is_creator_pm := coalesce((v_access->>'is_creator_project_manager')::boolean, false);
  v_is_assigned_accountant := coalesce((v_access->>'is_assigned_project_accountant')::boolean, false);
  v_is_supervisory := coalesce((v_access->>'is_supervisory_viewer')::boolean, false);

  if not v_is_creator_pm and not v_is_assigned_accountant and not v_is_supervisory then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not v_is_supervisory then
    if v_is_assigned_accountant then
      v_scoped_project_ids := v_scoped_project_ids || array(
        select pg_catalog.jsonb_array_elements_text(coalesce(v_auth->'accountant_project_ids', '[]'::jsonb))
      );
    end if;
    if v_is_creator_pm then
      v_scoped_project_ids := v_scoped_project_ids || array(
        select pg_catalog.jsonb_array_elements_text(coalesce(v_auth->'managed_project_ids', '[]'::jsonb))
      );
    end if;
  end if;

  v_today := coalesce(
    (v_auth->>'authorization_date')::date,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  return public.salary_advance__internal_query_worker_history(
    v_req.request_id,
    v_req.worker_entry_id,
    v_is_supervisory,
    v_scoped_project_ids,
    v_today,
    p_period_mode,
    p_month,
    p_from_date,
    p_to_date,
    p_cursor,
    p_page_size
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 6. RPC: list worker salary advance history by project + worker (QLDA pre-create)
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance_list_project_worker_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_worker_entry_id uuid,
  p_period_mode text default 'THIS_MONTH',
  p_month text default null,
  p_from_date text default null,
  p_to_date text default null,
  p_cursor text default null,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_entry public.direct_entries%rowtype;
  v_recruiter_info jsonb;
  v_managed_project_ids text[] := array[]::text[];
  v_today date;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_worker_entry_id is null then
    raise exception 'SALARY_ADVANCE_WORKER_INVALID'
      using errcode = '22023';
  end if;

  select e.*
    into v_entry
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
   where e.entry_id = p_worker_entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and s.state = 'SUBMITTED';

  if not found then
    raise exception 'SALARY_ADVANCE_WORKER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_entry.project_id <> p_project_id then
    raise exception 'SALARY_ADVANCE_WORKER_PROJECT_MISMATCH'
      using errcode = '22023';
  end if;

  v_recruiter_info := public.salary_advance__internal_worker_recruiter_info(p_worker_entry_id);
  if coalesce((v_recruiter_info->>'is_vendor_recruited')::boolean, false) then
    raise exception 'SALARY_ADVANCE_WORKER_VENDOR_RECRUITED'
      using errcode = 'PT409';
  end if;

  v_managed_project_ids := array(
    select pg_catalog.jsonb_array_elements_text(coalesce(v_auth->'managed_project_ids', '[]'::jsonb))
  );

  v_today := coalesce(
    (v_auth->>'authorization_date')::date,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  return public.salary_advance__internal_query_worker_history(
    null,
    p_worker_entry_id,
    false,
    v_managed_project_ids,
    v_today,
    p_period_mode,
    p_month,
    p_from_date,
    p_to_date,
    p_cursor,
    p_page_size
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 7. Owner alignment & internal helper privilege grants
-- -----------------------------------------------------------------------------
do $align_salary_advance_pm_worker_history_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_proc_owner_oid oid;
  v_fn pg_catalog.regprocedure;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  for v_fn, v_proc_owner_oid in
    select p.oid::pg_catalog.regprocedure, p.proowner
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'salary_advance%'
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_base_owner);
    end if;
  end loop;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname like 'salary_advance%'
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_canonical_national_id(text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_is_canonical_national_id(text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_vietqr_bank_display_name(text) to %I',
      v_owner
    );
  end loop;
end;
$align_salary_advance_pm_worker_history_owners$;

-- -----------------------------------------------------------------------------
-- 8. Strict function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`)
-- -----------------------------------------------------------------------------
revoke all on function
  public.salary_advance__internal_compute_worker_30d_summary(uuid, boolean, text[], date),
  public.salary_advance__internal_worker_30d_summary(public.salary_advance_requests, jsonb, uuid),
  public.salary_advance__internal_query_worker_history(uuid, uuid, boolean, text[], date, text, text, text, text, text, integer)
from public, anon, authenticated, service_role;

revoke all on function
  public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer),
  public.salary_advance_list_worker_history(uuid, uuid, uuid, text, text, text, text, text, integer),
  public.salary_advance_list_project_worker_history(uuid, uuid, text, uuid, text, text, text, text, text, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer),
  public.salary_advance_list_worker_history(uuid, uuid, uuid, text, text, text, text, text, integer),
  public.salary_advance_list_project_worker_history(uuid, uuid, text, uuid, text, text, text, text, text, integer)
to service_role;

commit;
