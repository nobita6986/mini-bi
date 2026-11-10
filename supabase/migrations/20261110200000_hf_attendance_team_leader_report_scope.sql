-- =============================================================================
-- Migration: 20261110200000_hf_attendance_team_leader_report_scope.sql
-- Purpose:
--   Allow canonical Team Leaders (`team_manager_assign` + `report_view` +
--   `report_analytics_view` + effective current team leader authority verified
--   by `public.direct_entry_assert_team_leader_current_team`) to read
--   attendance check-in reports, monthly attendance matrix reports (including
--   Excel export), and check-in photos strictly for current members of their
--   own team (`public.work_report_current_team(app_user_id) = team_id`).
--
--   Invariants preserved:
--   1. `public.attendance__internal_assert_report_reader` is NOT widened so HQ
--      location, branch admin, and slot-policy admin RPCs remain restricted to
--      Full Admin / BoD with `all` scope.
--   2. Internal helper `public.attendance__internal_resolve_report_scope` is
--      `SECURITY DEFINER` with locked `search_path` and `EXECUTE` revoked from
--      `public`, `anon`, `authenticated`, and `service_role`.
--   3. Cross-team `employee_id` filters and cross-team check-in photo requests
--      fail closed with `42501 ATTENDANCE_REPORT_ACCESS_DENIED`.
-- =============================================================================

begin;

create or replace function public.attendance__internal_resolve_report_scope(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (
  scope_kind text,
  team_id uuid,
  can_configure_hq boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_can_configure_hq boolean;
  v_team_id uuid;
begin
  if p_auth_subject is null
     or p_app_user_id is null
     or not exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = p_app_user_id
          and u.auth_subject = p_auth_subject
          and u.enabled
     ) then
    raise exception 'ATTENDANCE_ACTOR_DENIED' using errcode = '42501';
  end if;

  begin
    v_can_configure_hq := public.attendance__internal_assert_report_reader(
      p_auth_subject,
      p_app_user_id
    );
    return query select 'all'::text, null::uuid, v_can_configure_hq;
    return;
  exception
    when insufficient_privilege then
      null;
  end;

  if not (
    public.direct_entry_has_capability(p_app_user_id, 'team_manager_assign')
    and public.direct_entry_has_capability(p_app_user_id, 'report_view')
    and public.direct_entry_has_capability(p_app_user_id, 'report_analytics_view')
  ) then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  begin
    v_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject,
      p_app_user_id,
      null
    );
  exception
    when insufficient_privilege then
      raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end;

  if v_team_id is null then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  return query select 'team'::text, v_team_id, false;
end;
$function$;

create or replace function public.attendance_admin_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_from_date date,
  p_to_date date,
  p_page integer,
  p_page_size integer,
  p_search text,
  p_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_team_id uuid;
  v_can_configure_hq boolean;
  v_today_vn date := (pg_catalog.clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_to_date date := coalesce(p_to_date, v_today_vn);
  v_from_date date := coalesce(p_from_date, coalesce(p_to_date, v_today_vn) - 6);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_search text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  v_search_pattern text;
  v_employee_options jsonb := '[]'::jsonb;
  v_current_hq jsonb;
  v_overview jsonb;
  v_total_rows integer := 0;
  v_total_pages integer := 1;
  v_items jsonb := '[]'::jsonb;
begin
  select s.scope_kind, s.team_id, s.can_configure_hq
    into v_scope_kind, v_scope_team_id, v_can_configure_hq
    from public.attendance__internal_resolve_report_scope(
      p_auth_subject,
      p_app_user_id
    ) s;

  if v_from_date in ('infinity'::date, '-infinity'::date)
     or v_to_date in ('infinity'::date, '-infinity'::date)
     or v_from_date > v_to_date
     or (v_to_date - v_from_date) > 366 then
    raise exception 'ATTENDANCE_REPORT_RANGE_INVALID' using errcode = '22023';
  end if;

  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'ATTENDANCE_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  if v_search is not null then
    if pg_catalog.length(v_search) > 120 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'ATTENDANCE_REPORT_SEARCH_INVALID' using errcode = '22023';
    end if;
    if p_employee_id is not null then
      raise exception 'ATTENDANCE_REPORT_FILTER_CONFLICT' using errcode = '22023';
    end if;
    v_search_pattern :=
      '%' || pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(v_search, '\', '\\'),
          '%',
          '\%'
        ),
        '_',
        '\_'
      ) || '%';
  end if;

  if v_scope_kind = 'team'
     and p_employee_id is not null
     and public.work_report_current_team(p_employee_id) is distinct from v_scope_team_id then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'version', h.version,
           'latitude', h.latitude,
           'longitude', h.longitude,
           'effective_from', pg_catalog.to_char(h.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'effective_from_local', pg_catalog.to_char(h.effective_from at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
           'configured_by_display_name', coalesce(ident.employee_display_name, u.display_name)
         )
    into v_current_hq
    from public.attendance_hq_location_revisions h
    join public.direct_entry_app_users u
      on u.app_user_id = h.configured_by_user_id
    left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident on true
   order by h.effective_from desc, h.version desc
   limit 1;

  with scoped_employee_identities as materialized (
    select
      du.app_user_id,
      du.raw_display_name,
      ident.employee_display_name,
      ident.personnel_code
    from (
      select distinct
        c.app_user_id,
        u.display_name as raw_display_name
      from public.attendance_checkins c
      join public.direct_entry_app_users u
        on u.app_user_id = c.app_user_id
      where c.business_date between v_from_date and v_to_date
        and (
          v_scope_kind = 'all'
          or public.work_report_current_team(c.app_user_id) = v_scope_team_id
        )
    ) du
    cross join lateral public.attendance__internal_resolve_employee_identity(
      du.app_user_id
    ) ident
  ),
  employee_options_agg as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'app_user_id', sei.app_user_id,
          'display_name', sei.employee_display_name,
          'personnel_code', sei.personnel_code
        )
        order by pg_catalog.lower(sei.employee_display_name) asc,
                 sei.employee_display_name asc,
                 coalesce(sei.personnel_code, '') asc,
                 sei.app_user_id asc
      ),
      '[]'::jsonb
    ) as employee_options
    from scoped_employee_identities sei
  ),
  filtered_employees as materialized (
    select
      sei.app_user_id,
      sei.employee_display_name,
      sei.personnel_code
    from scoped_employee_identities sei
    where (p_employee_id is null or sei.app_user_id = p_employee_id)
      and (
        v_search_pattern is null
        or sei.employee_display_name ilike v_search_pattern escape '\'
        or sei.raw_display_name ilike v_search_pattern escape '\'
        or coalesce(sei.personnel_code, '') ilike v_search_pattern escape '\'
      )
  ),
  filtered_base as (
    select
      c.checkin_id,
      c.app_user_id,
      fe.employee_display_name,
      fe.personnel_code,
      c.business_date,
      c.sequence_in_day,
      c.captured_at,
      c.received_at,
      c.time_source,
      c.time_verified,
      c.sync_delay_seconds,
      c.latitude,
      c.longitude,
      c.accuracy_meters,
      c.address_hint,
      c.note,
      c.distance_target_kind,
      c.branch_id_used,
      c.branch_code_used,
      c.branch_name_used,
      c.branch_version_used,
      c.hq_version_used as persisted_hq_version_used,
      c.distance_meters as persisted_distance_meters,
      c.distance_status as persisted_distance_status,
      (
        c.latitude is not null
        and c.longitude is not null
        and c.accuracy_meters is not null
        and c.latitude not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        and c.longitude not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        and c.accuracy_meters not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        and c.latitude >= -90.0 and c.latitude <= 90.0
        and c.longitude >= -180.0 and c.longitude <= 180.0
        and c.accuracy_meters >= 0.0 and c.accuracy_meters <= 100000.0
      ) as gps_valid,
      hq.version as hq_version,
      hq.latitude as hq_latitude,
      hq.longitude as hq_longitude
    from public.attendance_checkins c
    join filtered_employees fe
      on fe.app_user_id = c.app_user_id
    left join lateral (
      select h.version, h.latitude, h.longitude
        from public.attendance_hq_location_revisions h
       where c.distance_status is null
         and h.effective_from <= (
           case when c.time_verified then c.captured_at else c.received_at end
         )
       order by h.effective_from desc, h.version desc
       limit 1
    ) hq on true
    where c.business_date between v_from_date and v_to_date
  ),
  computed as (
    select
      b.checkin_id,
      b.app_user_id,
      b.employee_display_name,
      b.personnel_code,
      b.business_date,
      b.sequence_in_day,
      b.captured_at,
      b.received_at,
      b.time_source,
      b.time_verified,
      b.sync_delay_seconds,
      case when b.gps_valid then b.latitude else null end as latitude,
      case when b.gps_valid then b.longitude else null end as longitude,
      case when b.gps_valid then b.accuracy_meters else null end as accuracy_meters,
      b.address_hint,
      b.note,
      case
        when b.persisted_distance_status is not null then
          coalesce(b.distance_target_kind, case when b.branch_id_used is not null then 'BRANCH' else 'HQ' end)
        else 'HQ'
      end as distance_target_kind,
      case
        when b.persisted_distance_status is not null then b.persisted_distance_status
        when not b.gps_valid then 'INVALID_GPS'
        when b.hq_version is null then 'HQ_NOT_CONFIGURED'
        else 'COMPUTED'
      end as distance_status,
      case
        when b.persisted_distance_status is not null then b.persisted_hq_version_used
        when b.gps_valid and b.hq_version is not null then b.hq_version
        else null
      end as hq_version_used,
      b.branch_id_used,
      b.branch_code_used,
      b.branch_name_used,
      case
        when b.persisted_distance_status is not null then b.branch_version_used
        else null
      end as branch_version_used,
      case
        when b.persisted_distance_status is not null then b.persisted_distance_meters
        when not b.gps_valid or b.hq_version is null then null
        else pg_catalog.round(
          (
            2.0 * 6371000.0 * pg_catalog.asin(
              least(
                1.0::double precision,
                pg_catalog.sqrt(
                  greatest(
                    0.0::double precision,
                    pg_catalog.power(pg_catalog.sin(pg_catalog.radians(b.latitude - b.hq_latitude) / 2.0), 2.0)
                    + pg_catalog.cos(pg_catalog.radians(b.hq_latitude))
                      * pg_catalog.cos(pg_catalog.radians(b.latitude))
                      * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(b.longitude - b.hq_longitude) / 2.0), 2.0)
                  )
                )
              )
            )
          )::numeric,
          1
        )::double precision
      end as distance_meters
    from filtered_base b
  ),
  agg as (
    select
      count(*)::integer as total_checkins,
      count(distinct c.app_user_id)::integer as unique_employees,
      count(*) filter (where c.time_verified)::integer as verified_time_count,
      count(*) filter (where not c.time_verified)::integer as unverified_time_count,
      count(*) filter (where c.distance_status = 'COMPUTED')::integer as distance_computed_count,
      count(*) filter (where c.distance_status <> 'COMPUTED')::integer as distance_unavailable_count,
      case
        when count(*) filter (where c.distance_status = 'COMPUTED') = 0 then null
        else pg_catalog.round(
          (avg(c.distance_meters) filter (where c.distance_status = 'COMPUTED'))::numeric,
          1
        )::double precision
      end as avg_distance_meters,
      case
        when count(*) filter (where c.distance_status = 'COMPUTED') = 0 then null
        else pg_catalog.round(
          (max(c.distance_meters) filter (where c.distance_status = 'COMPUTED'))::numeric,
          1
        )::double precision
      end as max_distance_meters
    from computed c
  ),
  paged as (
    select
      c.checkin_id,
      c.captured_at as raw_captured_at,
      c.employee_display_name,
      c.personnel_code,
      c.business_date::text as business_date,
      c.sequence_in_day,
      pg_catalog.to_char(c.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at,
      pg_catalog.to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as captured_at_local,
      pg_catalog.to_char(c.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as received_at,
      c.time_source,
      c.time_verified,
      c.sync_delay_seconds,
      c.latitude,
      c.longitude,
      c.accuracy_meters,
      c.address_hint,
      c.note,
      c.distance_meters,
      c.distance_status,
      c.distance_target_kind,
      c.hq_version_used,
      c.branch_id_used,
      c.branch_code_used,
      c.branch_name_used,
      c.branch_version_used
    from computed c
    order by c.captured_at desc, c.checkin_id desc
    offset ((v_page - 1) * v_page_size)
    limit v_page_size
  )
  select
    eoa.employee_options,
    jsonb_build_object(
      'total_checkins', a.total_checkins,
      'unique_employees', a.unique_employees,
      'verified_time_count', a.verified_time_count,
      'unverified_time_count', a.unverified_time_count,
      'distance_computed_count', a.distance_computed_count,
      'distance_unavailable_count', a.distance_unavailable_count,
      'avg_distance_meters', a.avg_distance_meters,
      'max_distance_meters', a.max_distance_meters
    ),
    a.total_checkins,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'checkin_id', p.checkin_id,
            'employee_display_name', p.employee_display_name,
            'personnel_code', p.personnel_code,
            'business_date', p.business_date,
            'sequence_in_day', p.sequence_in_day,
            'captured_at', p.captured_at,
            'captured_at_local', p.captured_at_local,
            'received_at', p.received_at,
            'time_source', p.time_source,
            'time_verified', p.time_verified,
            'sync_delay_seconds', p.sync_delay_seconds,
            'latitude', p.latitude,
            'longitude', p.longitude,
            'accuracy_meters', p.accuracy_meters,
            'address_hint', p.address_hint,
            'note', p.note,
            'distance_meters', p.distance_meters,
            'distance_status', p.distance_status,
            'hq_version_used', p.hq_version_used,
            'branch_id_used', p.branch_id_used,
            'branch_code_used', p.branch_code_used,
            'branch_name_used', p.branch_name_used,
            'branch_version_used', p.branch_version_used
          )
          order by p.raw_captured_at desc, p.checkin_id desc
        )
        from paged p
      ),
      '[]'::jsonb
    )
    into v_employee_options, v_overview, v_total_rows, v_items
    from agg a
    cross join employee_options_agg eoa;

  v_total_pages := greatest(
    1,
    pg_catalog.ceil(v_total_rows::numeric / v_page_size::numeric)::integer
  );

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_configure_hq', v_can_configure_hq
    ),
    'filters', jsonb_build_object(
      'from_date', v_from_date::text,
      'to_date', v_to_date::text,
      'search', v_search,
      'employee_id', p_employee_id,
      'timezone', 'Asia/Ho_Chi_Minh'
    ),
    'employee_options', v_employee_options,
    'current_hq', v_current_hq,
    'overview', v_overview,
    'pagination', jsonb_build_object(
      'page', v_page,
      'page_size', v_page_size,
      'total_rows', v_total_rows,
      'total_pages', v_total_pages,
      'has_more', (v_page * v_page_size) < v_total_rows
    ),
    'items', v_items
  );
end;
$function$;

create or replace function public.attendance_monthly_matrix_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_year_month text default null,
  p_branch_id uuid default null,
  p_employee_id uuid default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_default_profile_id constant uuid := '00000000-0000-4000-8000-000000000001'::uuid;
  v_scope_kind text;
  v_scope_team_id uuid;
  v_can_configure_hq boolean;
  v_now_vn timestamp without time zone := clock_timestamp() at time zone 'Asia/Ho_Chi_Minh';
  v_today_vn date := v_now_vn::date;
  v_year_month text := coalesce(nullif(btrim(p_year_month), ''), to_char(v_today_vn, 'YYYY-MM'));
  v_year integer;
  v_month integer;
  v_month_start date;
  v_month_end date;
  v_ref_date date;
  v_days_in_month integer;
  v_completed_days_in_month integer;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_escaped_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_current_hq jsonb;
  v_slot_policy jsonb;
  v_calendar_days jsonb;
  v_branch_options jsonb := '[]'::jsonb;
  v_employee_options jsonb := '[]'::jsonb;
  v_overview jsonb;
  v_total_rows integer := 0;
  v_total_pages integer := 0;
  v_snapshot_token text;
  v_items jsonb := '[]'::jsonb;
begin
  select s.scope_kind, s.team_id, s.can_configure_hq
    into v_scope_kind, v_scope_team_id, v_can_configure_hq
    from public.attendance__internal_resolve_report_scope(
      p_auth_subject,
      p_app_user_id
    ) s;

  if v_year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'ATTENDANCE_MATRIX_MONTH_INVALID'
      using errcode = '22023';
  end if;

  v_year := split_part(v_year_month, '-', 1)::integer;
  v_month := split_part(v_year_month, '-', 2)::integer;

  if v_year < 2000 or v_year > 2100 then
    raise exception 'ATTENDANCE_MATRIX_MONTH_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := make_date(v_year, v_month, 1);
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_ref_date := least(v_today_vn, v_month_end);
  v_days_in_month := (v_month_end - v_month_start) + 1;

  if v_today_vn <= v_month_start then
    v_completed_days_in_month := 0;
  elsif v_today_vn > v_month_end then
    v_completed_days_in_month := v_days_in_month;
  else
    v_completed_days_in_month := (v_today_vn - v_month_start);
  end if;

  if p_employee_id is not null and v_search is not null then
    raise exception 'ATTENDANCE_REPORT_FILTER_CONFLICT'
      using errcode = '22023';
  end if;

  if v_search is not null then
    if length(v_search) > 100 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'ATTENDANCE_REPORT_SEARCH_INVALID'
        using errcode = '22023';
    end if;
    v_escaped_search := replace(
      replace(
        replace(lower(v_search), '\', '\\'),
        '%',
        '\%'
      ),
      '_',
      '\_'
    );
  end if;

  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'ATTENDANCE_REPORT_PAGINATION_INVALID'
      using errcode = '22023';
  end if;

  if v_scope_kind = 'team'
     and p_employee_id is not null
     and public.work_report_current_team(p_employee_id) is distinct from v_scope_team_id then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_offset := (v_page - 1) * v_page_size;

  select jsonb_build_object(
    'version', r.version,
    'latitude', r.latitude,
    'longitude', r.longitude,
    'effective_from', to_char(r.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effective_from_local', to_char(r.effective_from at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
    'configured_by_display_name', coalesce(ident.employee_display_name, u.display_name)
  )
    into v_current_hq
  from public.attendance_hq_location_revisions r
  join public.direct_entry_app_users u
    on u.app_user_id = r.configured_by_user_id
  left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident on true
  order by r.effective_from desc, r.version desc
  limit 1;

  with policy_with_bounds as materialized (
    select
      p as policy_row,
      p.profile_id,
      p.version,
      p.effective_from_date,
      (
        lead(p.effective_from_date) over (
          partition by p.profile_id
          order by p.effective_from_date asc, p.version asc
        ) - 1
      ) as effective_to_date,
      coalesce(ident.employee_display_name, u.display_name) as actor_display_name
    from public.attendance_slot_policy_versions p
    left join public.direct_entry_app_users u
      on u.app_user_id = p.configured_by_user_id
    left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident on true
  ),
  default_month_active_versions as (
    select distinct on (pb.version)
      pb.*
    from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
    join lateral (
      select p2.*
      from policy_with_bounds p2
      where p2.profile_id = v_default_profile_id
      order by (p2.effective_from_date <= cal.d::date) desc, p2.effective_from_date desc, p2.version desc
      limit 1
    ) pb on true
    order by pb.version asc
  )
  select jsonb_build_object(
    'current_policy', (
      select public.attendance__internal_format_slot_policy(
        pb.policy_row,
        pb.effective_to_date,
        pb.actor_display_name
      )
      from policy_with_bounds pb
      where pb.profile_id = v_default_profile_id
      order by (pb.effective_from_date <= v_today_vn) desc, pb.effective_from_date desc, pb.version desc
      limit 1
    ),
    'latest_policy', (
      select public.attendance__internal_format_slot_policy(
        pb.policy_row,
        pb.effective_to_date,
        pb.actor_display_name
      )
      from policy_with_bounds pb
      where pb.profile_id = v_default_profile_id
      order by pb.version desc
      limit 1
    ),
    'month_policies', coalesce(
      (
        select jsonb_agg(
          public.attendance__internal_format_slot_policy(
            mv.policy_row,
            mv.effective_to_date,
            mv.actor_display_name
          )
          order by mv.version asc
        )
        from default_month_active_versions mv
      ),
      '[]'::jsonb
    ),
    'profiles', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'profile_id', pr.profile_id,
            'profile_code', pr.profile_code,
            'display_name', pr.display_name,
            'description', pr.description,
            'is_default', pr.is_default,
            'active', pr.active,
            'version', pr.version,
            'current_policy', (
              select public.attendance__internal_format_slot_policy(
                pb_c.policy_row,
                pb_c.effective_to_date,
                pb_c.actor_display_name
              )
              from policy_with_bounds pb_c
              where pb_c.profile_id = pr.profile_id
              order by (pb_c.effective_from_date <= v_today_vn) desc, pb_c.effective_from_date desc, pb_c.version desc
              limit 1
            ),
            'latest_policy', (
              select public.attendance__internal_format_slot_policy(
                pb_l.policy_row,
                pb_l.effective_to_date,
                pb_l.actor_display_name
              )
              from policy_with_bounds pb_l
              where pb_l.profile_id = pr.profile_id
              order by pb_l.version desc
              limit 1
            ),
            'month_policies', coalesce((
              select jsonb_agg(
                public.attendance__internal_format_slot_policy(
                  pmv.policy_row,
                  pmv.effective_to_date,
                  pmv.actor_display_name
                )
                order by pmv.version asc
              )
              from (
                select distinct on (pb_m.version)
                  pb_m.*
                from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal_m(d)
                join lateral (
                  select p3.*
                  from policy_with_bounds p3
                  where p3.profile_id = pr.profile_id
                  order by (p3.effective_from_date <= cal_m.d::date) desc, p3.effective_from_date desc, p3.version desc
                  limit 1
                ) pb_m on true
                order by pb_m.version asc
              ) pmv
            ), '[]'::jsonb)
          )
          order by
            pr.is_default desc,
            pr.active desc,
            lower(pr.display_name) asc,
            lower(pr.profile_code) asc,
            pr.profile_id asc
        )
        from public.attendance_slot_policy_profiles pr
      ),
      '[]'::jsonb
    )
  )
    into v_slot_policy;

  select jsonb_agg(
    jsonb_build_object(
      'business_date', d::date,
      'day_of_month', extract(day from d)::integer,
      'day_of_week', extract(isodow from d)::integer
    )
    order by d::date asc
  )
    into v_calendar_days
  from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as d;

  with eligible_month_users as materialized (
    select
      u.app_user_id,
      u.display_name as raw_display_name,
      u.enabled
    from public.direct_entry_app_users u
    where (
      v_scope_kind = 'all'
      or public.work_report_current_team(u.app_user_id) = v_scope_team_id
    )
      and (
        u.enabled = true
        or exists (
          select 1
          from public.attendance_checkins c
          where c.app_user_id = u.app_user_id
            and c.business_date between v_month_start and v_month_end
        )
        or exists (
          select 1
          from public.leave_request_days ld
          join public.leave_requests lr
            on lr.request_id = ld.request_id
          where ld.app_user_id = u.app_user_id
            and lr.status = 'APPROVED'
            and ld.leave_date between v_month_start and v_month_end
        )
        or exists (
          select 1
          from public.attendance_explanations ae
          where ae.app_user_id = u.app_user_id
            and ae.business_date between v_month_start and v_month_end
        )
      )
  ),
  month_candidate_users as materialized (
    select
      u.app_user_id,
      u.raw_display_name,
      ident.employee_display_name,
      u.enabled,
      ident.personnel_code,
      br.branch_id,
      br.branch_code,
      br.display_name as branch_display_name,
      br.address as branch_address,
      br.latitude as branch_latitude,
      br.longitude as branch_longitude,
      br.active as branch_active,
      br.version as branch_version,
      br.valid_from as branch_valid_from,
      br.valid_to as branch_valid_to,
      coalesce(sp.profile_id, v_default_profile_id) as slot_profile_id,
      coalesce(sp.profile_code, 'DEFAULT') as slot_profile_code,
      coalesce(sp.display_name, 'Mặc định') as slot_profile_name,
      coalesce(sp.is_default, true) as slot_profile_is_default,
      sp.assignment_id as slot_assignment_id,
      sp.valid_from as slot_assignment_valid_from,
      sp.valid_to as slot_assignment_valid_to
    from eligible_month_users u
    cross join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident
    left join lateral (
      select
        b.branch_id,
        b.branch_code,
        b.display_name,
        b.address,
        b.latitude,
        b.longitude,
        b.active,
        b.version,
        a.valid_from,
        a.valid_to
      from public.attendance_branch_assignments a
      join public.attendance_branches b
        on b.branch_id = a.branch_id
      where a.app_user_id = u.app_user_id
        and a.valid_from <= v_month_end
        and (a.valid_to is null or a.valid_to >= v_month_start)
      order by a.valid_from desc
      limit 1
    ) br on true
    left join lateral (
      select
        pr.profile_id,
        pr.profile_code,
        pr.display_name,
        pr.is_default,
        a.assignment_id,
        a.valid_from,
        a.valid_to
      from public.attendance_slot_policy_assignments a
      join public.attendance_slot_policy_profiles pr
        on pr.profile_id = a.profile_id
      where a.app_user_id = u.app_user_id
        and not a.superseded_same_day
        and a.valid_from <= v_month_end
        and (a.valid_to is null or a.valid_to >= v_month_start)
      order by
        (a.valid_from <= v_ref_date and (a.valid_to is null or v_ref_date <= a.valid_to)) desc,
        a.valid_from desc,
        a.assigned_at desc,
        a.assignment_id desc
      limit 1
    ) sp on true
  ),
  branch_options_agg as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'branch_id', b.branch_id,
          'branch_code', b.branch_code,
          'display_name', b.display_name,
          'active', b.active,
          'latitude', b.latitude,
          'longitude', b.longitude,
          'version', b.version
        )
        order by b.branch_code asc, b.branch_id asc
      ),
      '[]'::jsonb
    ) as branch_options
    from public.attendance_branches b
    where v_scope_kind = 'all'
       or exists (
         select 1
         from month_candidate_users m
         where m.branch_id = b.branch_id
       )
       or exists (
         select 1
         from month_candidate_users m
         join public.attendance_checkins c
           on c.app_user_id = m.app_user_id
         where c.business_date between v_month_start and v_month_end
           and c.branch_id_used = b.branch_id
       )
  ),
  employee_options_agg as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'app_user_id', m.app_user_id,
          'display_name', m.employee_display_name,
          'personnel_code', m.personnel_code,
          'branch_id', m.branch_id,
          'branch_code', m.branch_code,
          'branch_name', m.branch_display_name,
          'slot_profile_id', m.slot_profile_id,
          'slot_profile_code', m.slot_profile_code,
          'slot_profile_name', m.slot_profile_name
        )
        order by lower(m.employee_display_name) asc, m.app_user_id asc
      ),
      '[]'::jsonb
    ) as employee_options
    from month_candidate_users m
  ),
  month_calendar_days as materialized (
    select
      cal.d::date as business_date,
      extract(day from cal.d)::integer as day_of_month
    from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
  ),
  profile_day_policies as materialized (
    select
      pr.profile_id,
      pr.profile_code,
      pr.display_name as profile_name,
      pr.is_default,
      cal.business_date,
      cal.day_of_month,
      pol.version as policy_version,
      pol.slots as policy_slots
    from public.attendance_slot_policy_profiles pr
    cross join month_calendar_days cal
    join lateral (
      select p.*
      from public.attendance_slot_policy_versions p
      where p.profile_id = pr.profile_id
      order by (p.effective_from_date <= cal.business_date) desc, p.effective_from_date desc, p.version desc
      limit 1
    ) pol on true
  ),
  profile_day_slot_defs as materialized (
    select
      pdp.profile_id,
      pdp.profile_code,
      pdp.profile_name,
      pdp.is_default,
      pdp.business_date,
      pdp.day_of_month,
      pdp.policy_version,
      (slot_elem->>'slot_index')::integer as slot_index,
      slot_elem->>'slot_code' as slot_code,
      coalesce(
        nullif(btrim(coalesce(slot_elem->>'slot_label', '')), ''),
        'Time ' || (slot_elem->>'slot_index')
      ) as slot_label,
      slot_elem->>'session_code' as session_code,
      slot_elem->>'target_time' as target_time,
      (
        split_part(slot_elem->>'target_time', ':', 1)::integer * 60
        + split_part(slot_elem->>'target_time', ':', 2)::integer
      ) as target_minute,
      (slot_elem->>'grace_before_minutes')::integer as grace_before_minutes,
      (slot_elem->>'grace_after_minutes')::integer as grace_after_minutes,
      (
        pdp.business_date < v_today_vn
        or (
          pdp.business_date = v_today_vn
          and v_now_vn > pdp.business_date
            + (slot_elem->>'target_time')::time
            + make_interval(mins => (slot_elem->>'grace_after_minutes')::integer)
        )
      ) as is_due
    from profile_day_policies pdp
    cross join lateral jsonb_array_elements(pdp.policy_slots) as slot_elem
  ),
  candidate_employees as materialized (
    select
      m.app_user_id,
      m.employee_display_name,
      m.enabled,
      m.personnel_code,
      m.branch_id,
      m.branch_code,
      m.branch_display_name,
      m.branch_address,
      m.branch_latitude,
      m.branch_longitude,
      m.branch_active,
      m.branch_version,
      m.branch_valid_from,
      m.branch_valid_to,
      m.slot_profile_id,
      m.slot_profile_code,
      m.slot_profile_name,
      m.slot_profile_is_default,
      m.slot_assignment_id,
      m.slot_assignment_valid_from,
      m.slot_assignment_valid_to
    from month_candidate_users m
    where (p_employee_id is null or m.app_user_id = p_employee_id)
      and (
        p_branch_id is null
        or m.branch_id = p_branch_id
        or exists (
          select 1
          from public.attendance_checkins c
          where c.app_user_id = m.app_user_id
            and c.business_date between v_month_start and v_month_end
            and c.branch_id_used = p_branch_id
        )
      )
      and (
        v_escaped_search is null
        or lower(m.employee_display_name) like '%' || v_escaped_search || '%' escape '\'
        or lower(m.raw_display_name) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.personnel_code, '')) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.branch_code, '')) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.branch_display_name, '')) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.slot_profile_code, '')) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.slot_profile_name, '')) like '%' || v_escaped_search || '%' escape '\'
      )
  ),
  month_slot_assignments as materialized (
    select
      a.assignment_id,
      a.app_user_id,
      a.profile_id,
      a.valid_from,
      a.valid_to,
      a.assigned_at
    from public.attendance_slot_policy_assignments a
    join candidate_employees ce
      on ce.app_user_id = a.app_user_id
    where not a.superseded_same_day
      and a.valid_from <= v_month_end
      and (a.valid_to is null or a.valid_to >= v_month_start)
  ),
  employee_day_profile_ids as materialized (
    select
      ce.app_user_id,
      cal.business_date,
      coalesce(
        (
          select msa.profile_id
          from month_slot_assignments msa
          where msa.app_user_id = ce.app_user_id
            and msa.valid_from <= cal.business_date
            and (msa.valid_to is null or cal.business_date <= msa.valid_to)
          order by msa.valid_from desc, msa.assigned_at desc, msa.assignment_id desc
          limit 1
        ),
        v_default_profile_id
      ) as profile_id
    from candidate_employees ce
    cross join month_calendar_days cal
  ),
  employee_day_policies as materialized (
    select
      edpi.app_user_id,
      pdp.business_date,
      pdp.day_of_month,
      pdp.profile_id,
      pdp.profile_code,
      pdp.profile_name,
      pdp.is_default,
      pdp.policy_version,
      pdp.policy_slots
    from employee_day_profile_ids edpi
    join profile_day_policies pdp
      on pdp.profile_id = edpi.profile_id
     and pdp.business_date = edpi.business_date
  ),
  month_checkins_raw as materialized (
    select
      c.checkin_id,
      c.app_user_id,
      c.business_date,
      c.sequence_in_day,
      c.captured_at,
      to_char(c.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at_utc,
      to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as captured_at_local,
      to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI') as time_local,
      (
        extract(hour from (c.captured_at at time zone 'Asia/Ho_Chi_Minh'))::integer * 60
        + extract(minute from (c.captured_at at time zone 'Asia/Ho_Chi_Minh'))::integer
      ) as local_minute_of_day,
      c.time_verified,
      case
        when c.distance_status is not null then coalesce(c.distance_target_kind, case when c.branch_id_used is not null then 'BRANCH' else 'HQ' end)
        else 'HQ'
      end as distance_target_kind,
      c.branch_id_used,
      c.branch_code_used,
      c.branch_name_used,
      case
        when c.distance_status is not null then c.branch_version_used
        else null
      end as branch_version_used,
      case
        when c.distance_status is not null then c.hq_version_used
        when c.accuracy_meters <= 100000.0 then hq.version
        else null
      end as hq_version_used,
      case
        when c.distance_status is not null then c.distance_status
        when c.accuracy_meters > 100000.0 then 'INVALID_GPS'
        when hq.version is null then 'HQ_NOT_CONFIGURED'
        else 'COMPUTED'
      end as distance_status,
      case
        when c.distance_status is not null then c.distance_meters
        when c.accuracy_meters > 100000.0 or hq.version is null then null
        else round(
          (
            2.0 * 6371000.0 * asin(
              least(
                1.0::double precision,
                sqrt(
                  greatest(
                    0.0::double precision,
                    power(sin(radians(c.latitude - hq.latitude) / 2.0), 2)
                    + cos(radians(hq.latitude))
                      * cos(radians(c.latitude))
                      * power(sin(radians(c.longitude - hq.longitude) / 2.0), 2)
                  )
                )
              )
            )
          )::numeric,
          1
        )::double precision
      end as distance_meters
    from public.attendance_checkins c
    join candidate_employees ce
      on ce.app_user_id = c.app_user_id
    left join lateral (
      select
        r.version,
        r.latitude,
        r.longitude
      from public.attendance_hq_location_revisions r
      where c.distance_status is null
        and r.effective_from <= (
          case
            when c.time_verified then c.captured_at
            else c.received_at
          end
        )
      order by r.effective_from desc, r.version desc
      limit 1
    ) hq on true
    where c.business_date between v_month_start and v_month_end
  ),
  month_checkins_enriched as materialized (
    select distinct on (mcr.checkin_id)
      mcr.*,
      edp.profile_id as policy_profile_id,
      edp.profile_code as policy_profile_code,
      edp.profile_name as policy_profile_name,
      s.policy_version,
      s.slot_index as assigned_slot_index,
      s.slot_code as assigned_slot_code,
      s.target_time as assigned_slot_target_time,
      (mcr.local_minute_of_day - s.target_minute)::integer as delta_minutes,
      case
        when (mcr.local_minute_of_day - s.target_minute) < (-s.grace_before_minutes) then
          ((- (mcr.local_minute_of_day - s.target_minute)) - s.grace_before_minutes)::integer
        when (mcr.local_minute_of_day - s.target_minute) > s.grace_after_minutes then
          ((mcr.local_minute_of_day - s.target_minute) - s.grace_after_minutes)::integer
        else 0
      end as over_grace_minutes,
      case
        when (mcr.local_minute_of_day - s.target_minute) < (-s.grace_before_minutes) then 'EARLY'
        when (mcr.local_minute_of_day - s.target_minute) > s.grace_after_minutes then 'LATE'
        else 'ON_TIME'
      end as deviation_status
    from month_checkins_raw mcr
    join employee_day_policies edp
      on edp.app_user_id = mcr.app_user_id
     and edp.business_date = mcr.business_date
    join profile_day_slot_defs s
      on s.profile_id = edp.profile_id
     and s.business_date = mcr.business_date
    order by
      mcr.checkin_id,
      abs(mcr.local_minute_of_day - s.target_minute) asc,
      s.slot_index asc
  ),
  daily_slot_checkins as materialized (
    select
      mc.app_user_id,
      mc.business_date,
      mc.assigned_slot_index as slot_index,
      count(*)::integer as checkin_count,
      count(*) filter (where mc.deviation_status <> 'ON_TIME')::integer as out_of_grace_count,
      jsonb_agg(
        jsonb_build_object(
          'checkin_id', mc.checkin_id,
          'sequence_in_day', mc.sequence_in_day,
          'captured_at', mc.captured_at_utc,
          'captured_at_local', mc.captured_at_local,
          'time_local', mc.time_local,
          'time_verified', mc.time_verified,
          'assigned_slot_code', mc.assigned_slot_code,
          'delta_minutes', mc.delta_minutes,
          'over_grace_minutes', mc.over_grace_minutes,
          'deviation_status', mc.deviation_status,
          'distance_target_kind', mc.distance_target_kind,
          'distance_status', mc.distance_status,
          'distance_meters', mc.distance_meters
        )
        order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc
      ) as checkins
    from month_checkins_enriched mc
    group by mc.app_user_id, mc.business_date, mc.assigned_slot_index
  ),
  daily_checkins as materialized (
    select
      mc.app_user_id,
      mc.business_date,
      count(*)::integer as checkin_count,
      count(*) filter (where mc.time_verified)::integer as verified_checkin_count,
      count(*) filter (where not mc.time_verified)::integer as unverified_checkin_count,
      count(*) filter (where mc.deviation_status <> 'ON_TIME')::integer as late_or_early_checkin_count,
      count(*) filter (where mc.distance_status = 'COMPUTED')::integer as distance_computed_count,
      count(*) filter (where mc.distance_status <> 'COMPUTED')::integer as distance_unavailable_count,
      (array_agg(mc.checkin_id order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as first_checkin_id,
      (array_agg(mc.checkin_id order by mc.captured_at desc, mc.sequence_in_day desc, mc.checkin_id desc))[1] as last_checkin_id,
      min(mc.captured_at) as first_captured_at,
      max(mc.captured_at) as last_captured_at,
      (array_agg(mc.distance_target_kind order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as distance_target_kind,
      (array_agg(mc.branch_id_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_id_used,
      (array_agg(mc.branch_code_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_code_used,
      (array_agg(mc.branch_name_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_name_used,
      (array_agg(mc.branch_version_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_version_used,
      (array_agg(mc.hq_version_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as hq_version_used,
      (array_agg(mc.distance_status order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as distance_status,
      (array_agg(mc.distance_meters order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as distance_meters,
      min(mc.distance_meters) as min_distance_meters,
      max(mc.distance_meters) as max_distance_meters
    from month_checkins_enriched mc
    group by mc.app_user_id, mc.business_date
  ),
  daily_leaves as materialized (
    select
      ld.app_user_id,
      ld.leave_date as business_date,
      sum(ld.half_day_units)::integer as half_day_units,
      round((sum(ld.half_day_units)::numeric / 2.0), 1)::double precision as leave_units,
      bool_or(ld.session_code in ('FULL', 'AM')) as am_covered,
      bool_or(ld.session_code in ('FULL', 'PM')) as pm_covered,
      jsonb_agg(
        jsonb_build_object(
          'request_id', ld.request_id,
          'leave_date', ld.leave_date,
          'session_code', ld.session_code,
          'leave_type', ld.leave_type,
          'half_day_units', ld.half_day_units
        )
        order by
          case ld.session_code
            when 'FULL' then 1
            when 'AM' then 2
            when 'PM' then 3
            else 4
          end asc,
          ld.leave_type asc,
          ld.request_id asc
      ) as approved_leaves
    from public.leave_request_days ld
    join public.leave_requests lr
      on lr.request_id = ld.request_id
    join candidate_employees ce
      on ce.app_user_id = ld.app_user_id
    where lr.status = 'APPROVED'
      and ld.is_active = true
      and ld.leave_date between v_month_start and v_month_end
    group by ld.app_user_id, ld.leave_date
  ),
  daily_slot_explanations as materialized (
    select distinct on (ae.app_user_id, ae.business_date, ae.slot_code)
      ae.explanation_id,
      ae.app_user_id,
      ae.business_date,
      ae.slot_code,
      ae.slot_index,
      ae.original_slot_status,
      ae.reason,
      ae.status,
      ae.submitted_at,
      to_char(ae.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as submitted_at_utc,
      to_char(ae.submitted_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as submitted_at_local,
      ae.decided_at,
      case
        when ae.decided_at is not null then
          to_char(ae.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        else null
      end as decided_at_utc,
      case
        when ae.decided_at is not null then
          to_char(ae.decided_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
        else null
      end as decided_at_local,
      coalesce(dec_ident.employee_display_name, du.display_name) as decided_by_display_name,
      ae.decision_note,
      ae.row_version
    from public.attendance_explanations ae
    join candidate_employees ce
      on ce.app_user_id = ae.app_user_id
    left join public.direct_entry_app_users du
      on du.app_user_id = ae.decided_by_app_user_id
    left join lateral public.attendance__internal_resolve_employee_identity(du.app_user_id) dec_ident
      on du.app_user_id is not null
    where ae.business_date between v_month_start and v_month_end
    order by
      ae.app_user_id asc,
      ae.business_date asc,
      ae.slot_code asc,
      case ae.status
        when 'APPROVED' then 1
        when 'PENDING' then 2
        else 3
      end asc,
      ae.submitted_at desc,
      ae.explanation_id desc
  ),
  employee_profile_names_agg as (
    select
      sub_p.app_user_id,
      jsonb_agg(sub_p.profile_name order by sub_p.first_date asc) as profile_names_in_month
    from (
      select
        edp_p.app_user_id,
        edp_p.profile_name,
        min(edp_p.business_date) as first_date
      from employee_day_policies edp_p
      group by edp_p.app_user_id, edp_p.profile_name
    ) sub_p
    group by sub_p.app_user_id
  ),
  employee_checkins_agg as (
    select
      dc.app_user_id,
      count(*)::integer as checkin_day_count,
      coalesce(sum(dc.checkin_count), 0)::integer as total_checkins,
      coalesce(sum(dc.distance_computed_count), 0)::integer as distance_computed_count,
      coalesce(sum(dc.distance_unavailable_count), 0)::integer as distance_unavailable_count,
      min(dc.min_distance_meters) as min_distance_meters,
      max(dc.max_distance_meters) as max_distance_meters,
      count(*) filter (where dc.business_date < v_today_vn and dc.checkin_count > 0)::integer as elapsed_checkin_day_count
    from daily_checkins dc
    group by dc.app_user_id
  ),
  employee_leaves_agg as (
    select
      dl.app_user_id,
      count(*)::integer as approved_leave_day_count,
      coalesce(round((sum(dl.half_day_units)::numeric / 2.0), 1)::double precision, 0.0::double precision) as approved_leave_units,
      count(*) filter (where dl.business_date < v_today_vn and dl.leave_units > 0)::integer as elapsed_leave_day_count
    from daily_leaves dl
    group by dl.app_user_id
  ),
  employee_overlap_agg as (
    select
      dc.app_user_id,
      count(*)::integer as overlap_day_count,
      count(*) filter (
        where dc.business_date < v_today_vn
          and dc.checkin_count > 0
          and dl.leave_units > 0
      )::integer as elapsed_overlap_day_count
    from daily_checkins dc
    join daily_leaves dl
      on dl.app_user_id = dc.app_user_id
     and dl.business_date = dc.business_date
    group by dc.app_user_id
  ),
  employee_rollup as materialized (
    select
      ce.app_user_id,
      ce.employee_display_name,
      ce.personnel_code,
      ce.enabled,
      ce.branch_id,
      ce.branch_code,
      ce.branch_display_name,
      ce.branch_address,
      ce.branch_latitude,
      ce.branch_longitude,
      ce.branch_active,
      ce.branch_version,
      ce.branch_valid_from,
      ce.branch_valid_to,
      ce.slot_profile_id,
      ce.slot_profile_code,
      ce.slot_profile_name,
      ce.slot_profile_is_default,
      ce.slot_assignment_id,
      ce.slot_assignment_valid_from,
      ce.slot_assignment_valid_to,
      coalesce(prof_names.profile_names_in_month, jsonb_build_array(ce.slot_profile_name)) as profile_names_in_month,
      coalesce(chk.checkin_day_count, 0) as checkin_day_count,
      coalesce(chk.total_checkins, 0) as total_checkins,
      coalesce(chk.distance_computed_count, 0) as distance_computed_count,
      coalesce(chk.distance_unavailable_count, 0) as distance_unavailable_count,
      chk.min_distance_meters,
      chk.max_distance_meters,
      coalesce(lv.approved_leave_day_count, 0) as approved_leave_day_count,
      coalesce(lv.approved_leave_units, 0.0::double precision) as approved_leave_units,
      coalesce(both_days.overlap_day_count, 0) as checkin_and_leave_day_count,
      greatest(
        0,
        v_completed_days_in_month - coalesce(chk.elapsed_checkin_day_count, 0)
      )::integer as no_checkin_day_count,
      (
        v_completed_days_in_month
        - coalesce(chk.elapsed_checkin_day_count, 0)
        - (coalesce(lv.elapsed_leave_day_count, 0) - coalesce(both_days.elapsed_overlap_day_count, 0))
      )::integer as no_checkin_without_leave_day_count
    from candidate_employees ce
    left join employee_profile_names_agg prof_names
      on prof_names.app_user_id = ce.app_user_id
    left join employee_checkins_agg chk
      on chk.app_user_id = ce.app_user_id
    left join employee_leaves_agg lv
      on lv.app_user_id = ce.app_user_id
    left join employee_overlap_agg both_days
      on both_days.app_user_id = ce.app_user_id
  ),
  agg as (
    select
      count(*)::integer as total_employees,
      count(*) filter (where er.checkin_day_count > 0)::integer as employees_with_checkins,
      count(*) filter (where er.approved_leave_day_count > 0)::integer as employees_with_approved_leave,
      coalesce(sum(er.total_checkins), 0)::integer as total_checkins,
      coalesce(sum(er.checkin_day_count), 0)::integer as total_checkin_days,
      coalesce(sum(er.approved_leave_day_count), 0)::integer as total_approved_leave_days,
      coalesce(round(sum(er.approved_leave_units)::numeric, 1)::double precision, 0.0::double precision) as total_approved_leave_units,
      coalesce(sum(er.no_checkin_day_count), 0)::integer as total_no_checkin_days,
      coalesce(sum(er.no_checkin_without_leave_day_count), 0)::integer as total_no_checkin_without_leave_days,
      pg_catalog.md5(
        case
          when v_scope_kind = 'team' then 'team:' || coalesce(v_scope_team_id::text, '') || '|'
          else ''
        end
        || coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'u', er2.app_user_id,
                'n', er2.employee_display_name,
                'p', er2.personnel_code,
                'e', er2.enabled,
                'b', er2.branch_id,
                'bc', er2.branch_code,
                'bn', er2.branch_display_name,
                'ba', er2.branch_address,
                'blat', er2.branch_latitude,
                'blon', er2.branch_longitude,
                'bact', er2.branch_active,
                'bv', er2.branch_version,
                'bf', er2.branch_valid_from,
                'bt', er2.branch_valid_to,
                'sp', er2.slot_profile_id,
                'spc', er2.slot_profile_code,
                'spn', er2.slot_profile_name,
                'cd', er2.checkin_day_count,
                'tc', er2.total_checkins,
                'dc', er2.distance_computed_count,
                'du', er2.distance_unavailable_count,
                'dmin', er2.min_distance_meters,
                'dmax', er2.max_distance_meters,
                'ld', er2.approved_leave_day_count,
                'lu', er2.approved_leave_units,
                'ov', er2.checkin_and_leave_day_count
              )
              order by
                lower(er2.employee_display_name) asc,
                coalesce(er2.personnel_code, '') asc,
                er2.app_user_id asc
            )::text
            from employee_rollup er2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', mc2.checkin_id,
                'u', mc2.app_user_id,
                'd', mc2.business_date,
                'seq', mc2.sequence_in_day,
                't', mc2.captured_at_utc,
                'v', mc2.time_verified,
                'pr', mc2.policy_profile_id,
                's', mc2.assigned_slot_code,
                'dm', mc2.delta_minutes,
                'og', mc2.over_grace_minutes,
                'dv', mc2.deviation_status,
                'k', mc2.distance_target_kind,
                'bi', mc2.branch_id_used,
                'bv', mc2.branch_version_used,
                'hv', mc2.hq_version_used,
                'ds', mc2.distance_status,
                'dist', mc2.distance_meters
              )
              order by mc2.app_user_id asc, mc2.business_date asc, mc2.captured_at asc, mc2.sequence_in_day asc, mc2.checkin_id asc
            )::text
            from month_checkins_enriched mc2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'u', dl2.app_user_id,
                'd', dl2.business_date,
                'h', dl2.half_day_units,
                'l', dl2.approved_leaves
              )
              order by dl2.app_user_id asc, dl2.business_date asc
            )::text
            from daily_leaves dl2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'u', edp2.app_user_id,
                'd', edp2.business_date,
                'pr', edp2.profile_id,
                'pv', edp2.policy_version,
                'sl', edp2.policy_slots
              )
              order by edp2.app_user_id asc, edp2.business_date asc
            )::text
            from employee_day_policies edp2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', dse2.explanation_id,
                'u', dse2.app_user_id,
                'd', dse2.business_date,
                'sc', dse2.slot_code,
                'st', dse2.status,
                'rv', dse2.row_version
              )
              order by dse2.app_user_id asc, dse2.business_date asc, dse2.slot_code asc
            )::text
            from daily_slot_explanations dse2
          ),
          '[]'
        )
        || '|' || coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'pr', mds2.profile_id,
                'd', mds2.business_date,
                'sc', mds2.slot_code,
                'due', mds2.is_due
              )
              order by mds2.profile_id asc, mds2.business_date asc, mds2.slot_index asc
            )::text
            from profile_day_slot_defs mds2
          ),
          '[]'
        )
      ) as snapshot_token
    from employee_rollup er
  ),
  paged_employees as materialized (
    select er.*
    from employee_rollup er
    order by
      lower(er.employee_display_name) asc,
      coalesce(er.personnel_code, '') asc,
      er.app_user_id asc
    limit v_page_size
    offset v_offset
  ),
  paged_employee_day_policies as materialized (
    select edp.*
    from employee_day_policies edp
    join paged_employees pe
      on pe.app_user_id = edp.app_user_id
  ),
  paged_day_slots as materialized (
    select
      edp.app_user_id,
      edp.business_date,
      count(*) filter (
        where mds.is_due
          and coalesce(dsc.checkin_count, 0) = 0
          and not (
            case
              when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
              else coalesce(dl.pm_covered, false)
            end
          )
          and coalesce(dse.status, '') <> 'APPROVED'
      )::integer as missing_slot_count,
      coalesce(
        sum(dsc.out_of_grace_count) filter (
          where coalesce(dse.status, '') <> 'APPROVED'
        ),
        0
      )::integer as late_or_early_checkin_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'slot_code', mds.slot_code,
            'slot_index', mds.slot_index,
            'slot_label', mds.slot_label,
            'session_code', mds.session_code,
            'target_time', mds.target_time,
            'grace_before_minutes', mds.grace_before_minutes,
            'grace_after_minutes', mds.grace_after_minutes,
            'is_leave_covered', case
              when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
              else coalesce(dl.pm_covered, false)
            end,
            'slot_status', case
              when dse.status = 'APPROVED' and (
                (coalesce(dsc.checkin_count, 0) > 0 and coalesce(dsc.out_of_grace_count, 0) > 0)
                or (
                  coalesce(dsc.checkin_count, 0) = 0
                  and not (
                    case
                      when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                      else coalesce(dl.pm_covered, false)
                    end
                  )
                )
              ) then 'EXPLAINED_APPROVED'
              when coalesce(dsc.checkin_count, 0) > 0 and coalesce(dsc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
              when coalesce(dsc.checkin_count, 0) > 0 then 'ON_TIME'
              when (
                case
                  when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                  else coalesce(dl.pm_covered, false)
                end
              ) then 'LEAVE_COVERED'
              when not mds.is_due then 'UPCOMING'
              else 'MISSING'
            end,
            'checkins', coalesce(dsc.checkins, '[]'::jsonb),
            'explanation', case
              when dse.explanation_id is not null then
                jsonb_build_object(
                  'explanation_id', dse.explanation_id,
                  'status', dse.status,
                  'original_slot_status', dse.original_slot_status,
                  'reason', dse.reason,
                  'submitted_at', dse.submitted_at_utc,
                  'submitted_at_local', dse.submitted_at_local,
                  'decided_at', dse.decided_at_utc,
                  'decided_at_local', dse.decided_at_local,
                  'decided_by_display_name', dse.decided_by_display_name,
                  'decision_note', dse.decision_note,
                  'row_version', dse.row_version
                )
              else null
            end
          )
          order by mds.slot_index asc
        ),
        '[]'::jsonb
      ) as slots
    from paged_employee_day_policies edp
    join profile_day_slot_defs mds
      on mds.profile_id = edp.profile_id
     and mds.business_date = edp.business_date
    left join daily_leaves dl
      on dl.app_user_id = edp.app_user_id
     and dl.business_date = edp.business_date
    left join daily_slot_checkins dsc
      on dsc.app_user_id = edp.app_user_id
     and dsc.business_date = edp.business_date
     and dsc.slot_index = mds.slot_index
    left join daily_slot_explanations dse
      on dse.app_user_id = edp.app_user_id
     and dse.business_date = edp.business_date
     and dse.slot_code = mds.slot_code
    group by edp.app_user_id, edp.business_date
  ),
  paged_days_agg as materialized (
    select
      edp.app_user_id,
      jsonb_agg(
        jsonb_build_object(
          'business_date', edp.business_date,
          'day_of_month', edp.day_of_month,
          'policy_profile_id_used', edp.profile_id,
          'policy_profile_code_used', edp.profile_code,
          'policy_profile_name_used', edp.profile_name,
          'policy_is_default_used', edp.is_default,
          'policy_version_used', edp.policy_version,
          'has_checkin', (dc.checkin_count is not null and dc.checkin_count > 0),
          'checkin_count', coalesce(dc.checkin_count, 0),
          'first_checkin_id', dc.first_checkin_id,
          'last_checkin_id', dc.last_checkin_id,
          'first_captured_at', dc.first_captured_at,
          'first_captured_at_local', case
            when dc.first_captured_at is not null then
              to_char(dc.first_captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
            else null
          end,
          'first_time_local', case
            when dc.first_captured_at is not null then
              to_char(dc.first_captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI')
            else null
          end,
          'last_captured_at', dc.last_captured_at,
          'last_captured_at_local', case
            when dc.last_captured_at is not null then
              to_char(dc.last_captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
            else null
          end,
          'last_time_local', case
            when dc.last_captured_at is not null then
              to_char(dc.last_captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI')
            else null
          end,
          'verified_checkin_count', coalesce(dc.verified_checkin_count, 0),
          'unverified_checkin_count', coalesce(dc.unverified_checkin_count, 0),
          'distance_target_kind', dc.distance_target_kind,
          'branch_id_used', dc.branch_id_used,
          'branch_code_used', dc.branch_code_used,
          'branch_name_used', dc.branch_name_used,
          'branch_version_used', dc.branch_version_used,
          'hq_version_used', dc.hq_version_used,
          'distance_status', dc.distance_status,
          'distance_meters', dc.distance_meters,
          'min_distance_meters', dc.min_distance_meters,
          'max_distance_meters', dc.max_distance_meters,
          'has_approved_leave', (dl.leave_units is not null and dl.leave_units > 0),
          'approved_leave_units', coalesce(dl.leave_units, 0.0::double precision),
          'approved_leaves', coalesce(dl.approved_leaves, '[]'::jsonb),
          'day_status', case
            when dc.checkin_count is not null and dc.checkin_count > 0
                 and dl.leave_units is not null and dl.leave_units > 0 then 'CHECKED_IN_AND_LEAVE'
            when dc.checkin_count is not null and dc.checkin_count > 0 then 'CHECKED_IN'
            when dl.leave_units is not null and dl.leave_units > 0 then 'APPROVED_LEAVE'
            when coalesce(day_slots.missing_slot_count, 0) > 0 then 'NO_CHECKIN'
            else 'UPCOMING'
          end,
          'missing_slot_count', coalesce(day_slots.missing_slot_count, 0),
          'late_or_early_checkin_count', coalesce(day_slots.late_or_early_checkin_count, 0),
          'slots', coalesce(day_slots.slots, '[]'::jsonb)
        )
        order by edp.business_date asc
      ) as days
    from paged_employee_day_policies edp
    left join daily_checkins dc
      on dc.app_user_id = edp.app_user_id
     and dc.business_date = edp.business_date
    left join daily_leaves dl
      on dl.app_user_id = edp.app_user_id
     and dl.business_date = edp.business_date
    left join paged_day_slots day_slots
      on day_slots.app_user_id = edp.app_user_id
     and day_slots.business_date = edp.business_date
    group by edp.app_user_id
  ),
  paged_with_days as (
    select
      pe.*,
      coalesce(pda.days, '[]'::jsonb) as days
    from paged_employees pe
    left join paged_days_agg pda
      on pda.app_user_id = pe.app_user_id
  )
  select
    boa.branch_options,
    eoa.employee_options,
    a.total_employees,
    a.snapshot_token,
    jsonb_build_object(
      'total_employees', a.total_employees,
      'employees_with_checkins', a.employees_with_checkins,
      'employees_with_approved_leave', a.employees_with_approved_leave,
      'total_checkins', a.total_checkins,
      'total_checkin_days', a.total_checkin_days,
      'total_approved_leave_days', a.total_approved_leave_days,
      'total_approved_leave_units', a.total_approved_leave_units,
      'total_no_checkin_days', a.total_no_checkin_days,
      'total_no_checkin_without_leave_days', a.total_no_checkin_without_leave_days
    ),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'app_user_id', pwd.app_user_id,
            'employee_display_name', pwd.employee_display_name,
            'personnel_code', pwd.personnel_code,
            'enabled', pwd.enabled,
            'branch', case
              when pwd.branch_id is not null then
                jsonb_build_object(
                  'branch_id', pwd.branch_id,
                  'branch_code', pwd.branch_code,
                  'display_name', pwd.branch_display_name,
                  'address', pwd.branch_address,
                  'latitude', pwd.branch_latitude,
                  'longitude', pwd.branch_longitude,
                  'active', pwd.branch_active,
                  'version', pwd.branch_version,
                  'valid_from', pwd.branch_valid_from,
                  'valid_to', pwd.branch_valid_to
                )
              else null
            end,
            'slot_policy_profile', jsonb_build_object(
              'profile_id', pwd.slot_profile_id,
              'profile_code', pwd.slot_profile_code,
              'display_name', pwd.slot_profile_name,
              'is_default', pwd.slot_profile_is_default,
              'assignment_id', pwd.slot_assignment_id,
              'valid_from', pwd.slot_assignment_valid_from,
              'valid_to', pwd.slot_assignment_valid_to,
              'profile_names_in_month', pwd.profile_names_in_month
            ),
            'summary', jsonb_build_object(
              'checkin_day_count', pwd.checkin_day_count,
              'total_checkins', pwd.total_checkins,
              'approved_leave_day_count', pwd.approved_leave_day_count,
              'approved_leave_units', pwd.approved_leave_units,
              'checkin_and_leave_day_count', pwd.checkin_and_leave_day_count,
              'no_checkin_day_count', pwd.no_checkin_day_count,
              'no_checkin_without_leave_day_count', pwd.no_checkin_without_leave_day_count,
              'distance_computed_count', pwd.distance_computed_count,
              'distance_unavailable_count', pwd.distance_unavailable_count,
              'min_distance_meters', pwd.min_distance_meters,
              'max_distance_meters', pwd.max_distance_meters
            ),
            'days', pwd.days
          )
          order by
            lower(pwd.employee_display_name) asc,
            coalesce(pwd.personnel_code, '') asc,
            pwd.app_user_id asc
        )
        from paged_with_days pwd
      ),
      '[]'::jsonb
    )
  into v_branch_options, v_employee_options, v_total_rows, v_snapshot_token, v_overview, v_items
  from agg a
  cross join branch_options_agg boa
  cross join employee_options_agg eoa;

  v_total_pages := case
    when v_total_rows = 0 then 0
    else ceil(v_total_rows::numeric / v_page_size::numeric)::integer
  end;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_configure_hq', v_can_configure_hq,
      'can_manage_branches', v_can_configure_hq,
      'can_manage_slot_policy', v_can_configure_hq
    ),
    'filters', jsonb_build_object(
      'year_month', v_year_month,
      'from_date', v_month_start,
      'to_date', v_month_end,
      'branch_id', p_branch_id,
      'employee_id', p_employee_id,
      'search', v_search,
      'timezone', 'Asia/Ho_Chi_Minh'
    ),
    'days_in_month', v_days_in_month,
    'calendar_days', v_calendar_days,
    'current_hq', v_current_hq,
    'slot_policy', v_slot_policy,
    'branch_options', v_branch_options,
    'employee_options', v_employee_options,
    'overview', v_overview,
    'pagination', jsonb_build_object(
      'page', v_page,
      'page_size', v_page_size,
      'total_rows', v_total_rows,
      'total_pages', v_total_pages,
      'has_more', (v_page < v_total_pages),
      'snapshot_token', v_snapshot_token
    ),
    'items', v_items
  );
end;
$$;

create or replace function public.attendance_admin_checkin_photo(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_checkin_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_team_id uuid;
  v_can_configure_hq boolean;
  v_checkin_app_user_id uuid;
  v_storage_key text;
begin
  select s.scope_kind, s.team_id, s.can_configure_hq
    into v_scope_kind, v_scope_team_id, v_can_configure_hq
    from public.attendance__internal_resolve_report_scope(
      p_auth_subject,
      p_app_user_id
    ) s;

  if p_checkin_id is null then
    raise exception 'ATTENDANCE_REPORT_QUERY_INVALID' using errcode = '22023';
  end if;

  select c.app_user_id, c.photo_storage_key
    into v_checkin_app_user_id, v_storage_key
    from public.attendance_checkins c
   where c.checkin_id = p_checkin_id;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  if v_scope_kind = 'team'
     and public.work_report_current_team(v_checkin_app_user_id) is distinct from v_scope_team_id then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'found', true,
    'photo_storage_key', v_storage_key
  );
end;
$function$;

do $owner_align$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_fn regprocedure;
  v_proc_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_owner
  from pg_catalog.pg_class c
  join pg_catalog.pg_roles r on r.oid = c.relowner
  where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner is null then
    raise exception 'ATTENDANCE_REPORT_SCOPE_OWNER_RESOLUTION_FAILED';
  end if;

  foreach v_fn in array array[
    'public.attendance__internal_resolve_report_scope(uuid,uuid)'::pg_catalog.regprocedure,
    'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text,uuid)'::pg_catalog.regprocedure,
    'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure,
    'public.attendance_admin_checkin_photo(uuid,uuid,uuid)'::pg_catalog.regprocedure
  ] loop
    select p.proowner
      into v_proc_owner_oid
    from pg_catalog.pg_proc p
    where p.oid = v_fn;

    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;
end;
$owner_align$;

revoke all on function public.attendance__internal_resolve_report_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_admin_report(uuid, uuid, date, date, integer, integer, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_admin_report(uuid, uuid, date, date, integer, integer, text, uuid)
  to service_role;

revoke all on function public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)
  to service_role;

revoke all on function public.attendance_admin_checkin_photo(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_admin_checkin_photo(uuid, uuid, uuid)
  to service_role;

do $grant_internal_owner_exec$
declare
  v_owner name;
  v_helper_fn pg_catalog.regprocedure;
begin
  select r.rolname
    into v_owner
  from pg_catalog.pg_proc p
  join pg_catalog.pg_roles r on r.oid = p.proowner
  where p.oid = 'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure;

  if v_owner is not null then
    for v_helper_fn in
      select p.oid::pg_catalog.regprocedure
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (
           p.proname like 'attendance__internal_%'
           or p.proname like 'attendance_explanation__internal_%'
           or p.proname like 'leave_management__internal_%'
           or p.proname in (
             'direct_entry_assert_team_leader_current_team',
             'work_report_current_team'
           )
         )
    loop
      execute pg_catalog.format(
        'grant execute on function %s to %I',
        v_helper_fn,
        v_owner
      );
    end loop;
  end if;
end;
$grant_internal_owner_exec$;

commit;
