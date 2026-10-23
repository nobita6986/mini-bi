-- Attendance Admin Report & Headquarters Location Configuration:
-- 1. Append-only headquarters coordinate revision ledger (`public.attendance_hq_location_revisions`)
--    with forced RLS, zero table grants, and immutability trigger so historical check-in distances
--    remain deterministically bound to the HQ revision active at check-in reference time.
-- 2. Business-date index on `public.attendance_checkins` for server-side date-range filtering & paging.
-- 3. Internal report-reader authority guard (`Admin` or `BoD` at `all` scope; `Team Leader`,
--    `Accounting`, `Staff` denied) and two `service_role`-only RPCs:
--      - `public.attendance_admin_report` (STABLE, read-only)
--      - `public.attendance_set_hq_location` (VOLATILE, Full Admin only)

begin;

-- -----------------------------------------------------------------------------
-- 1. Append-only HQ coordinate revision table & report index.
-- -----------------------------------------------------------------------------
create table public.attendance_hq_location_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  version integer not null,
  latitude double precision not null,
  longitude double precision not null,
  effective_from timestamp with time zone not null default pg_catalog.clock_timestamp(),
  configured_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  idempotency_key uuid not null,
  request_fingerprint text not null,

  constraint attendance_hq_location_revisions_version_key
    unique (version),
  constraint attendance_hq_location_revisions_actor_idempotency_key
    unique (configured_by_user_id, idempotency_key),
  constraint attendance_hq_location_revisions_version_positive_chk
    check (version >= 1),
  constraint attendance_hq_location_revisions_latitude_chk
    check (
      latitude not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
      and latitude >= -90.0
      and latitude <= 90.0
    ),
  constraint attendance_hq_location_revisions_longitude_chk
    check (
      longitude not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
      and longitude >= -180.0
      and longitude <= 180.0
    ),
  constraint attendance_hq_location_revisions_effective_from_finite_chk
    check (
      effective_from not in (
        'infinity'::timestamp with time zone,
        '-infinity'::timestamp with time zone
      )
    ),
  constraint attendance_hq_location_revisions_fingerprint_hex_chk
    check (request_fingerprint ~ '^[0-9a-f]{64}$')
);

create index attendance_hq_location_revisions_effective_idx
  on public.attendance_hq_location_revisions (effective_from desc, version desc);

create index if not exists attendance_checkins_business_date_captured_idx
  on public.attendance_checkins (business_date desc, captured_at desc, checkin_id desc);

create trigger attendance_hq_location_revisions_immutable_guard
  before update or delete on public.attendance_hq_location_revisions
  for each row
  execute function public.attendance__internal_immutable_guard();

alter table public.attendance_hq_location_revisions enable row level security;
alter table public.attendance_hq_location_revisions force row level security;

-- -----------------------------------------------------------------------------
-- 2. Internal authority helper: Admin or BoD only (returns true iff Full Admin).
-- -----------------------------------------------------------------------------
create or replace function public.attendance__internal_assert_report_reader(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_is_full_admin boolean;
  v_is_bod boolean;
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

  if not public.direct_entry_has_scope(p_app_user_id, 'all') then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  v_is_full_admin :=
    public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage');

  v_is_bod :=
    public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
    or (
      public.direct_entry_has_capability(p_app_user_id, 'report_analytics_view')
      and public.direct_entry_has_capability(p_app_user_id, 'report_view')
    );

  if not v_is_full_admin and not v_is_bod then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  return v_is_full_admin;
end;
$function$;

comment on function public.attendance__internal_assert_report_reader(uuid, uuid) is
  'Internal Attendance Admin Report authority guard: verifies an enabled actor with current all scope and either canonical Full Admin triple or canonical BoD executive authority (entry_privileged_edit or report_analytics_view + report_view); returns true iff Full Admin.';

-- -----------------------------------------------------------------------------
-- 3. Read-only Attendance Admin Report RPC (`public.attendance_admin_report`).
-- -----------------------------------------------------------------------------
create or replace function public.attendance_admin_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_from_date date default null,
  p_to_date date default null,
  p_page integer default 1,
  p_page_size integer default 25,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_can_configure_hq boolean;
  v_today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_to_date date := coalesce(p_to_date, v_today);
  v_from_date date := coalesce(p_from_date, coalesce(p_to_date, v_today) - 6);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_search text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  v_search_pattern text := null;
  v_current_hq jsonb;
  v_overview jsonb;
  v_total_rows integer := 0;
  v_total_pages integer := 1;
  v_items jsonb := '[]'::jsonb;
begin
  v_can_configure_hq := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

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

  select jsonb_build_object(
           'version', h.version,
           'latitude', h.latitude,
           'longitude', h.longitude,
           'effective_from', pg_catalog.to_char(h.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'effective_from_local', pg_catalog.to_char(h.effective_from at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
           'configured_by_display_name', u.display_name
         )
    into v_current_hq
    from public.attendance_hq_location_revisions h
    join public.direct_entry_app_users u
      on u.app_user_id = h.configured_by_user_id
   order by h.effective_from desc, h.version desc
   limit 1;

  with filtered_base as (
    select
      c.checkin_id,
      c.app_user_id,
      u.display_name as employee_display_name,
      rec.personnel_code,
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
    join public.direct_entry_app_users u
      on u.app_user_id = c.app_user_id
    left join lateral (
      select case when count(*) = 1 then max(r.personnel_code) else null end as personnel_code
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r
          on r.recruiter_id = l.recruiter_id
         and r.active
       where l.app_user_id = u.app_user_id
         and l.verified
         and l.is_current
    ) rec on true
    left join lateral (
      select h.version, h.latitude, h.longitude
        from public.attendance_hq_location_revisions h
       where h.effective_from <= (
         case when c.time_verified then c.captured_at else c.received_at end
       )
       order by h.effective_from desc, h.version desc
       limit 1
    ) hq on true
    where c.business_date between v_from_date and v_to_date
      and (
        v_search_pattern is null
        or u.display_name ilike v_search_pattern escape '\'
        or coalesce(rec.personnel_code, '') ilike v_search_pattern escape '\'
      )
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
        when not b.gps_valid then 'INVALID_GPS'
        when b.hq_version is null then 'HQ_NOT_CONFIGURED'
        else 'COMPUTED'
      end as distance_status,
      case
        when b.gps_valid and b.hq_version is not null then b.hq_version
        else null
      end as hq_version_used,
      case
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
      c.hq_version_used
    from computed c
    order by c.captured_at desc, c.checkin_id desc
    offset ((v_page - 1) * v_page_size)
    limit v_page_size
  )
  select
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
            'hq_version_used', p.hq_version_used
          )
          order by p.raw_captured_at desc, p.checkin_id desc
        )
        from paged p
      ),
      '[]'::jsonb
    )
    into v_overview, v_total_rows, v_items
    from agg a;

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
      'timezone', 'Asia/Ho_Chi_Minh'
    ),
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

comment on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text
) is
  'Service-role-only read-only Attendance Admin Report RPC for Admin and BoD. Filters by Asia/Ho_Chi_Minh business_date, server-paginates detail rows, and computes deterministic point-in-time distances against append-only HQ revisions.';

-- -----------------------------------------------------------------------------
-- 4. Full-Admin-only HQ Location Configuration RPC (`public.attendance_set_hq_location`).
-- -----------------------------------------------------------------------------
create or replace function public.attendance_set_hq_location(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.attendance_hq_location_revisions%rowtype;
  v_current public.attendance_hq_location_revisions%rowtype;
  v_inserted public.attendance_hq_location_revisions%rowtype;
  v_actor_display_name text;
  v_effective_from timestamp with time zone;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_expected_version is null
     or p_expected_version < 0
     or p_latitude is null
     or p_longitude is null
     or p_latitude in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
     or p_longitude in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
     or p_latitude < -90.0 or p_latitude > 90.0
     or p_longitude < -180.0 or p_longitude > 180.0 then
    raise exception 'ATTENDANCE_HQ_COORDINATES_INVALID' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('attendance_hq_location', 0)
  );

  select u.display_name
    into v_actor_display_name
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  select h.*
    into v_existing
    from public.attendance_hq_location_revisions h
   where h.configured_by_user_id = p_app_user_id
     and h.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;

    return jsonb_build_object(
      'replayed', true,
      'hq', jsonb_build_object(
        'version', v_existing.version,
        'latitude', v_existing.latitude,
        'longitude', v_existing.longitude,
        'effective_from', pg_catalog.to_char(v_existing.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effective_from_local', pg_catalog.to_char(v_existing.effective_from at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
        'configured_by_display_name', v_actor_display_name
      )
    );
  end if;

  select h.*
    into v_current
    from public.attendance_hq_location_revisions h
   order by h.version desc
   limit 1;

  if coalesce(v_current.version, 0) <> p_expected_version then
    raise exception 'ATTENDANCE_HQ_VERSION_CONFLICT' using errcode = '40001';
  end if;

  v_effective_from := greatest(
    pg_catalog.clock_timestamp(),
    coalesce(v_current.effective_from + interval '1 microsecond', '-infinity'::timestamp with time zone)
  );

  insert into public.attendance_hq_location_revisions (
    version,
    latitude,
    longitude,
    effective_from,
    configured_by_user_id,
    idempotency_key,
    request_fingerprint
  )
  values (
    coalesce(v_current.version, 0) + 1,
    p_latitude,
    p_longitude,
    v_effective_from,
    p_app_user_id,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  return jsonb_build_object(
    'replayed', false,
    'hq', jsonb_build_object(
      'version', v_inserted.version,
      'latitude', v_inserted.latitude,
      'longitude', v_inserted.longitude,
      'effective_from', pg_catalog.to_char(v_inserted.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effective_from_local', pg_catalog.to_char(v_inserted.effective_from at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
      'configured_by_display_name', v_actor_display_name
    )
  );
end;
$function$;

comment on function public.attendance_set_hq_location(
  uuid, uuid, double precision, double precision, integer, uuid, text
) is
  'Service-role-only HQ coordinate configuration RPC for Full Admin. Appends an immutable HQ revision with optimistic version checking and idempotent replay so prior check-in distances never change.';

-- -----------------------------------------------------------------------------
-- 5. Owner alignment and helper privileges (`s0_t1c_runner` & `postgres` safe).
-- -----------------------------------------------------------------------------
do $align_attendance_admin_report_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_hq_table_owner_oid oid;
  v_proc_owner_oid oid;
  v_sig text;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  select c.relowner
    into v_hq_table_owner_oid
    from pg_catalog.pg_class c
   where c.oid = 'public.attendance_hq_location_revisions'::pg_catalog.regclass;

  if v_hq_table_owner_oid is distinct from v_base_owner_oid
     and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter table public.attendance_hq_location_revisions owner to %I',
      v_base_owner
    );
  end if;

  foreach v_sig in array array[
    'public.attendance__internal_assert_report_reader(uuid,uuid)',
    'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text)',
    'public.attendance_set_hq_location(uuid,uuid,double precision,double precision,integer,uuid,text)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_sig);

    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.attendance__internal_assert_report_reader(uuid,uuid)'::pg_catalog.regprocedure,
       'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text)'::pg_catalog.regprocedure,
       'public.attendance_set_hq_location(uuid,uuid,double precision,double precision,integer,uuid,text)'::pg_catalog.regprocedure
     )
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_scope(uuid,text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_app_user_admin(uuid,uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.attendance__internal_assert_report_reader(uuid,uuid) to %I',
      v_owner
    );
  end loop;
end;
$align_attendance_admin_report_owners$;

-- -----------------------------------------------------------------------------
-- 6. Strict table & function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on table public.attendance_hq_location_revisions
  from public, anon, authenticated, service_role;

revoke all on function public.attendance__internal_assert_report_reader(uuid, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text
) from public, anon, authenticated, service_role;

grant execute on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text
) to service_role;

revoke all on function public.attendance_set_hq_location(
  uuid, uuid, double precision, double precision, integer, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.attendance_set_hq_location(
  uuid, uuid, double precision, double precision, integer, uuid, text
) to service_role;

-- -----------------------------------------------------------------------------
-- 7. Data-free install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $check_attendance_admin_report$
declare
  v_hq_table constant pg_catalog.regclass :=
    'public.attendance_hq_location_revisions'::pg_catalog.regclass;
  v_checkin_table constant pg_catalog.regclass :=
    'public.attendance_checkins'::pg_catalog.regclass;
  v_helper constant pg_catalog.regprocedure :=
    'public.attendance__internal_assert_report_reader(uuid,uuid)'::pg_catalog.regprocedure;
  v_report_rpc constant pg_catalog.regprocedure :=
    'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text)'::pg_catalog.regprocedure;
  v_hq_rpc constant pg_catalog.regprocedure :=
    'public.attendance_set_hq_location(uuid,uuid,double precision,double precision,integer,uuid,text)'::pg_catalog.regprocedure;
  v_target_rpc pg_catalog.regprocedure;
  v_rls boolean;
  v_force_rls boolean;
  v_policy_count integer;
  v_exposed_table_acl integer;
  v_secdef boolean;
  v_config text;
  v_provolatile "char";
  v_owner_bypasses_rls boolean;
  v_owner_table_privs boolean;
begin
  select c.relrowsecurity,
         c.relforcerowsecurity,
         (select count(*)::integer from pg_catalog.pg_policy pol where pol.polrelid = c.oid),
         (select count(*)::integer
            from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
           where a.grantee = 0
              or a.grantee in (
                'anon'::pg_catalog.regrole,
                'authenticated'::pg_catalog.regrole,
                'service_role'::pg_catalog.regrole
              ))
    into v_rls, v_force_rls, v_policy_count, v_exposed_table_acl
    from pg_catalog.pg_class c
   where c.oid = v_hq_table;

  if not coalesce(v_rls, false)
     or not coalesce(v_force_rls, false)
     or coalesce(v_policy_count, -1) <> 0
     or coalesce(v_exposed_table_acl, -1) <> 0
     or pg_catalog.has_table_privilege('public', v_hq_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_table_privilege('anon', v_hq_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_table_privilege('authenticated', v_hq_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_table_privilege('service_role', v_hq_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    raise exception 'Attendance HQ location table RLS/ACL boundary drift on public.attendance_hq_location_revisions'
      using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('public', v_helper, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_helper, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_helper, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_helper, 'EXECUTE')
     or exists (
       select 1
         from pg_catalog.aclexplode(coalesce(
           (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_helper),
           pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_helper))
         )) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'
     ) then
    raise exception 'Attendance internal report-reader helper must stay revoked from all runtime roles'
      using errcode = '55000';
  end if;

  foreach v_target_rpc in array array[v_report_rpc, v_hq_rpc]
  loop
    select p.prosecdef,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           p.provolatile,
           (r.rolsuper or r.rolbypassrls),
           (
             pg_catalog.has_table_privilege(p.proowner, v_hq_table, 'SELECT')
             and pg_catalog.has_table_privilege(p.proowner, v_checkin_table, 'SELECT')
             and (v_target_rpc <> v_hq_rpc or pg_catalog.has_table_privilege(p.proowner, v_hq_table, 'INSERT'))
           )
      into v_secdef, v_config, v_provolatile, v_owner_bypasses_rls, v_owner_table_privs
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_target_rpc;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or (v_target_rpc = v_report_rpc and v_provolatile <> 's')
       or not coalesce(v_owner_bypasses_rls, false)
       or not coalesce(v_owner_table_privs, false) then
      raise exception 'Attendance Admin Report RPC security definer/volatility/RLS/search_path drift on %', v_target_rpc
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_target_rpc, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_target_rpc, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_target_rpc, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_target_rpc),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_target_rpc))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege('service_role', v_target_rpc, 'EXECUTE') then
      raise exception 'Attendance Admin Report RPC EXECUTE ACL drift on %', v_target_rpc
        using errcode = '55000';
    end if;
  end loop;
end;
$check_attendance_admin_report$;

commit;
