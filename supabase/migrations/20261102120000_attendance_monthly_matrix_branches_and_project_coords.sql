-- =============================================================================
-- Migration: 20261102120000_attendance_monthly_matrix_branches_and_project_coords.sql
-- Purpose:
--   1. HRP Branches (`public.attendance_branches`, `public.attendance_branch_revisions`,
--      `public.attendance_branch_assignments`) with `app_user_id` assignment, effective
--      date range (`valid_from`..`valid_to`), overlap prevention trigger, and OCC/audit.
--   2. Branch-Based Check-In Distance snapshot on `public.attendance_checkins`:
--      - Effective branch assignment uses branch coordinates (Haversine) and snapshots
--        `branch_id_used`, `branch_code_used`, `branch_name_used`, `branch_version_used`,
--        `distance_meters`, `distance_status` on the check-in row so historical distances
--        never drift when branch assignments or coordinates later change.
--      - Assigned branch without coordinates records `BRANCH_NOT_CONFIGURED` (`distance_meters = null`),
--        never silently falls back to HQ, and never blocks check-in.
--      - Unassigned accounts continue using HQ point-in-time revisions.
--   3. Project Coordinates (`location_*` on `public.direct_entry_projects` + project revisions +
--      `public.direct_entry_update_project_location`) and `public.hrp_sync_catalog` RPC per
--      `BI-HRP-WORKER-SYNC-CONTRACT.md`.
--   4. Monthly Attendance Matrix Report RPC (`public.attendance_monthly_matrix_report`) combining
--      daily check-in milestones, distance/target snapshots, and approved leave days (`FULL`/`AM`/`PM`)
--      with single-query set-based aggregation and server-side filtering.
-- =============================================================================

begin;

-- =============================================================================
-- SECTION 1: HRP Branches & Employee Branch Assignments
-- =============================================================================

create table public.attendance_branches (
  branch_id uuid primary key default gen_random_uuid(),
  branch_code text not null,
  display_name text not null,
  address text not null default '',
  latitude double precision null,
  longitude double precision null,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,

  constraint attendance_branches_code_key unique (branch_code),
  constraint attendance_branches_code_check check (
    branch_code ~ '^[A-Z0-9][A-Z0-9._:-]{0,63}$'
  ),
  constraint attendance_branches_display_name_check check (
    display_name = btrim(display_name)
    and length(display_name) between 1 and 256
    and display_name !~ '[\x00-\x1F\x7F]'
  ),
  constraint attendance_branches_address_check check (
    length(address) <= 500
    and address !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
  ),
  constraint attendance_branches_latitude_check check (
    latitude is null
    or (
      latitude not in (
        'NaN'::double precision,
        'Infinity'::double precision,
        '-Infinity'::double precision
      )
      and latitude >= -90.0
      and latitude <= 90.0
    )
  ),
  constraint attendance_branches_longitude_check check (
    longitude is null
    or (
      longitude not in (
        'NaN'::double precision,
        'Infinity'::double precision,
        '-Infinity'::double precision
      )
      and longitude >= -180.0
      and longitude <= 180.0
    )
  ),
  constraint attendance_branches_coordinates_pair_check check (
    (latitude is null) = (longitude is null)
  ),
  constraint attendance_branches_version_check check (version >= 1)
);

create index attendance_branches_active_code_idx
  on public.attendance_branches (active, branch_code);

alter table public.attendance_branches enable row level security;
alter table public.attendance_branches force row level security;

revoke all on table public.attendance_branches
  from public, anon, authenticated, service_role;

create table public.attendance_branch_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  branch_id uuid not null
    references public.attendance_branches(branch_id) on delete restrict,
  version integer not null,
  action text not null,
  branch_code text not null,
  display_name text not null,
  address text not null,
  latitude double precision null,
  longitude double precision null,
  active boolean not null,
  effective_from timestamptz not null default clock_timestamp(),
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  idempotency_key uuid not null,
  request_fingerprint text not null,

  constraint attendance_branch_revisions_branch_version_key unique (branch_id, version),
  constraint attendance_branch_revisions_idempotency_key_key unique (idempotency_key),
  constraint attendance_branch_revisions_version_check check (version >= 1),
  constraint attendance_branch_revisions_action_check check (
    action in ('CREATE', 'UPDATE')
  ),
  constraint attendance_branch_revisions_fingerprint_check check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint attendance_branch_revisions_coordinates_pair_check check (
    (latitude is null) = (longitude is null)
  )
);

create index attendance_branch_revisions_effective_idx
  on public.attendance_branch_revisions (branch_id, effective_from desc, version desc);

create trigger attendance_branch_revisions_immutable_guard
before update or delete on public.attendance_branch_revisions
for each row
execute function public.attendance__internal_immutable_guard();

alter table public.attendance_branch_revisions enable row level security;
alter table public.attendance_branch_revisions force row level security;

revoke all on table public.attendance_branch_revisions
  from public, anon, authenticated, service_role;

create table public.attendance_branch_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  branch_id uuid not null
    references public.attendance_branches(branch_id) on delete restrict,
  valid_from date not null,
  valid_to date null,
  version integer not null default 1,
  assigned_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  revoked_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  revoked_at timestamptz null,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  revoke_idempotency_key uuid null,
  revoke_request_fingerprint text null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  constraint attendance_branch_assignments_idempotency_key_key unique (idempotency_key),
  constraint attendance_branch_assignments_revoke_idempotency_key_key unique (revoke_idempotency_key),
  constraint attendance_branch_assignments_valid_range_check check (
    valid_to is null or valid_to >= valid_from
  ),
  constraint attendance_branch_assignments_revocation_consistency_check check (
    (valid_to is null and revoked_at is null and revoked_by_user_id is null and revoke_idempotency_key is null and revoke_request_fingerprint is null)
    or (valid_to is not null and revoked_at is not null and revoked_by_user_id is not null and revoke_idempotency_key is not null and revoke_request_fingerprint is not null)
  ),
  constraint attendance_branch_assignments_version_check check (version >= 1),
  constraint attendance_branch_assignments_fingerprint_check check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint attendance_branch_assignments_revoke_fingerprint_check check (
    revoke_request_fingerprint is null or revoke_request_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

create unique index attendance_branch_assignments_open_user_uidx
  on public.attendance_branch_assignments (app_user_id)
  where valid_to is null;

create index attendance_branch_assignments_user_dates_idx
  on public.attendance_branch_assignments (app_user_id, valid_from desc, valid_to);

create index attendance_branch_assignments_branch_dates_idx
  on public.attendance_branch_assignments (branch_id, valid_from desc, valid_to);

create or replace function public.attendance__internal_branch_assignment_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.valid_to is not null and new.valid_to < new.valid_from then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID'
      using errcode = '22023';
  end if;

  perform 1
  from public.attendance_branch_assignments a
  where a.app_user_id = new.app_user_id
    and a.assignment_id <> new.assignment_id
    and daterange(a.valid_from, coalesce(a.valid_to, 'infinity'::date), '[]')
     && daterange(new.valid_from, coalesce(new.valid_to, 'infinity'::date), '[]');

  if found then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

create trigger attendance_branch_assignments_no_overlap_trg
before insert or update on public.attendance_branch_assignments
for each row
execute function public.attendance__internal_branch_assignment_no_overlap();

alter table public.attendance_branch_assignments enable row level security;
alter table public.attendance_branch_assignments force row level security;

revoke all on table public.attendance_branch_assignments
  from public, anon, authenticated, service_role;

-- =============================================================================
-- SECTION 2: Branch-Based Check-In Distance Snapshot & Updated Check-In / Report RPCs
-- =============================================================================

alter table public.attendance_checkins
  add column distance_target_kind text null,
  add column branch_id_used uuid null
    references public.attendance_branches(branch_id) on delete restrict,
  add column branch_code_used text null,
  add column branch_name_used text null,
  add column branch_version_used integer null,
  add column hq_version_used integer null,
  add column distance_meters double precision null,
  add column distance_status text null,
  add constraint attendance_checkins_distance_target_kind_check check (
    distance_target_kind is null or distance_target_kind in ('HQ', 'BRANCH')
  ),
  add constraint attendance_checkins_branch_version_used_check check (
    branch_version_used is null or branch_version_used >= 1
  ),
  add constraint attendance_checkins_hq_version_used_check check (
    hq_version_used is null or hq_version_used >= 1
  ),
  add constraint attendance_checkins_distance_meters_check check (
    distance_meters is null
    or (
      distance_meters not in (
        'NaN'::double precision,
        'Infinity'::double precision,
        '-Infinity'::double precision
      )
      and distance_meters >= 0.0
    )
  ),
  add constraint attendance_checkins_distance_status_check check (
    distance_status is null
    or distance_status in (
      'COMPUTED',
      'HQ_NOT_CONFIGURED',
      'BRANCH_NOT_CONFIGURED',
      'INVALID_GPS'
    )
  );

create index attendance_checkins_branch_business_date_idx
  on public.attendance_checkins (branch_id_used, business_date desc)
  where branch_id_used is not null;

create or replace function public.attendance_record_checkin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_meters double precision,
  p_address_hint text,
  p_note text,
  p_device_claimed_at timestamp with time zone,
  p_time_source text,
  p_time_anchor_issued_at timestamp with time zone,
  p_elapsed_since_anchor_ms bigint,
  p_time_token_digest text,
  p_photo_storage_key text,
  p_photo_sha256 text,
  p_photo_size_bytes integer,
  p_photo_mime_type text,
  p_received_at timestamp with time zone default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_address_hint text;
  v_note text;
  v_existing public.attendance_checkins%rowtype;
  v_inserted public.attendance_checkins%rowtype;
  v_received_at timestamp with time zone;
  v_captured_at timestamp with time zone;
  v_time_verified boolean;
  v_business_date date;
  v_effective_at timestamp with time zone;
  v_sync_delay_seconds integer;
  v_sequence_in_day integer;
  v_daily_count integer;
  v_gps_valid boolean;
  v_distance_target_kind text;
  v_branch_id_used uuid := null;
  v_branch_code_used text := null;
  v_branch_name_used text := null;
  v_branch_version_used integer := null;
  v_hq_version_used integer := null;
  v_target_lat double precision := null;
  v_target_lon double precision := null;
  v_distance_meters double precision := null;
  v_distance_status text := null;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'ACTOR_NOT_AVAILABLE' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled = true
  ) then
    raise exception 'ACTOR_NOT_AVAILABLE' using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_INVALID' using errcode = '22023';
  end if;

  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
  end if;

  if p_latitude is null
     or p_latitude in (
       'NaN'::double precision,
       'Infinity'::double precision,
       '-Infinity'::double precision
     )
     or p_latitude < -90.0
     or p_latitude > 90.0
     or p_longitude is null
     or p_longitude in (
       'NaN'::double precision,
       'Infinity'::double precision,
       '-Infinity'::double precision
     )
     or p_longitude < -180.0
     or p_longitude > 180.0 then
    raise exception 'GPS_COORDINATES_INVALID' using errcode = '22023';
  end if;

  if p_accuracy_meters is null
     or p_accuracy_meters in (
       'NaN'::double precision,
       'Infinity'::double precision,
       '-Infinity'::double precision
     )
     or p_accuracy_meters < 0.0 then
    raise exception 'GPS_ACCURACY_INVALID' using errcode = '22023';
  end if;

  v_address_hint := pg_catalog.btrim(coalesce(p_address_hint, ''));
  v_note := pg_catalog.btrim(coalesce(p_note, ''));
  if pg_catalog.length(v_address_hint) > 500 or pg_catalog.length(v_note) > 2000 then
    raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
  end if;

  if p_device_claimed_at is null
     or p_device_claimed_at in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone) then
    raise exception 'CAPTURED_AT_INVALID' using errcode = '22023';
  end if;

  if p_photo_storage_key is null
     or pg_catalog.length(pg_catalog.btrim(p_photo_storage_key)) not between 1 and 512
     or p_photo_sha256 is null
     or p_photo_sha256 !~ '^[0-9a-f]{64}$'
     or p_photo_size_bytes is null
     or p_photo_size_bytes < 1
     or p_photo_size_bytes > 10485760
     or p_photo_mime_type is distinct from 'image/jpeg' then
    raise exception 'PHOTO_INVALID' using errcode = '22023';
  end if;

  -- Per-actor transaction advisory lock serializes both same-key concurrent retries
  -- and same-day sequence_in_day allocation without blocking other actors.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('attendance_checkin_v1'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  select *
    into v_existing
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;

    select count(*)::integer
      into v_daily_count
      from public.attendance_checkins c
     where c.app_user_id = p_app_user_id
       and c.business_date = v_existing.business_date;

    return pg_catalog.jsonb_build_object(
      'checkin_id', v_existing.checkin_id,
      'business_date', v_existing.business_date::text,
      'sequence_in_day', v_existing.sequence_in_day,
      'daily_count', v_daily_count,
      'captured_at', pg_catalog.to_char(v_existing.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'received_at', pg_catalog.to_char(v_existing.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'time_source', v_existing.time_source,
      'replayed', true
    );
  end if;

  v_received_at := coalesce(p_received_at, pg_catalog.clock_timestamp());
  if v_received_at in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone) then
    raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
  end if;

  if p_time_source = 'SERVER_ANCHORED' then
    if p_time_anchor_issued_at is null
       or p_time_anchor_issued_at in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone)
       or p_time_token_digest is null
       or p_time_token_digest !~ '^[0-9a-f]{64}$' then
      raise exception 'ATTENDANCE_TIME_TOKEN_INVALID' using errcode = '22023';
    end if;

    if p_elapsed_since_anchor_ms is null
       or p_elapsed_since_anchor_ms < 0
       or p_elapsed_since_anchor_ms > 86400000 then
      raise exception 'ATTENDANCE_TIME_ELAPSED_INVALID' using errcode = '22023';
    end if;

    v_captured_at := p_time_anchor_issued_at + (p_elapsed_since_anchor_ms * interval '1 millisecond');

    if p_device_claimed_at - v_captured_at > interval '5 seconds'
       or v_captured_at - p_device_claimed_at > interval '5 seconds' then
      raise exception 'ATTENDANCE_TIME_MISMATCH' using errcode = '22023';
    end if;

    if p_time_anchor_issued_at > v_received_at + interval '30 seconds'
       or v_captured_at > v_received_at + interval '30 seconds'
       or p_device_claimed_at > v_received_at + interval '30 seconds' then
      raise exception 'CAPTURED_AT_FUTURE' using errcode = '22023';
    end if;

    if v_received_at > v_captured_at + interval '168 hours' then
      raise exception 'ATTENDANCE_SYNC_WINDOW_EXPIRED' using errcode = '22023';
    end if;

    v_time_verified := true;
  elsif p_time_source = 'DEVICE_CLOCK_UNVERIFIED' then
    if p_time_anchor_issued_at is not null
       or p_elapsed_since_anchor_ms is not null
       or p_time_token_digest is not null then
      raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
    end if;

    v_captured_at := p_device_claimed_at;
    v_time_verified := false;
  else
    raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
  end if;

  if v_captured_at > v_received_at + interval '30 seconds'
     or p_device_claimed_at > v_received_at + interval '30 seconds' then
    raise exception 'CAPTURED_AT_FUTURE' using errcode = '22023';
  end if;

  v_business_date := (v_captured_at at time zone 'Asia/Ho_Chi_Minh')::date;
  v_effective_at := case when v_time_verified then v_captured_at else v_received_at end;
  v_sync_delay_seconds := greatest(
    0,
    pg_catalog.floor(extract(epoch from (v_received_at - v_captured_at)))::integer
  );

  select coalesce(max(c.sequence_in_day), 0) + 1
    into v_sequence_in_day
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.business_date = v_business_date;

  -- Resolve point-in-time distance target (Branch if assigned on check-in business_date, else HQ)
  v_gps_valid := (p_accuracy_meters <= 100000.0);

  select
    a.branch_id,
    coalesce(rev.branch_code, b.branch_code),
    coalesce(rev.display_name, b.display_name),
    coalesce(rev.version, b.version),
    case when rev.version is not null then rev.latitude else b.latitude end,
    case when rev.version is not null then rev.longitude else b.longitude end
  into
    v_branch_id_used,
    v_branch_code_used,
    v_branch_name_used,
    v_branch_version_used,
    v_target_lat,
    v_target_lon
  from public.attendance_branch_assignments a
  join public.attendance_branches b
    on b.branch_id = a.branch_id
  left join lateral (
    select
      r.version,
      r.branch_code,
      r.display_name,
      r.latitude,
      r.longitude,
      r.active
    from public.attendance_branch_revisions r
    where r.branch_id = a.branch_id
      and r.effective_from <= v_effective_at
    order by r.effective_from desc, r.version desc
    limit 1
  ) rev on true
  where a.app_user_id = p_app_user_id
    and a.valid_from <= v_business_date
    and (a.valid_to is null or v_business_date <= a.valid_to)
    and coalesce(rev.active, b.active) = true
  order by a.valid_from desc
  limit 1;

  if v_branch_id_used is not null then
    v_distance_target_kind := 'BRANCH';
    v_hq_version_used := null;
    if not v_gps_valid then
      v_distance_status := 'INVALID_GPS';
      v_distance_meters := null;
      v_branch_version_used := null;
    elsif v_target_lat is null or v_target_lon is null then
      -- Assigned branch lacks coordinates: do NOT fall back to HQ and do NOT block check-in
      v_distance_status := 'BRANCH_NOT_CONFIGURED';
      v_distance_meters := null;
    else
      v_distance_status := 'COMPUTED';
      v_distance_meters := pg_catalog.round(
        (
          2.0 * 6371000.0 * pg_catalog.asin(
            least(
              1.0::double precision,
              pg_catalog.sqrt(
                greatest(
                  0.0::double precision,
                  pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_latitude - v_target_lat) / 2.0), 2.0)
                  + pg_catalog.cos(pg_catalog.radians(v_target_lat))
                    * pg_catalog.cos(pg_catalog.radians(p_latitude))
                    * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_longitude - v_target_lon) / 2.0), 2.0)
                )
              )
            )
          )
        )::numeric,
        1
      )::double precision;
    end if;
  else
    v_distance_target_kind := 'HQ';
    select
      r.version,
      r.latitude,
      r.longitude
    into
      v_hq_version_used,
      v_target_lat,
      v_target_lon
    from public.attendance_hq_location_revisions r
    where r.effective_from <= v_effective_at
    order by r.effective_from desc, r.version desc
    limit 1;

    if not v_gps_valid then
      v_distance_status := 'INVALID_GPS';
      v_distance_meters := null;
      v_hq_version_used := null;
    elsif v_hq_version_used is null then
      v_distance_status := 'HQ_NOT_CONFIGURED';
      v_distance_meters := null;
    else
      v_distance_status := 'COMPUTED';
      v_distance_meters := pg_catalog.round(
        (
          2.0 * 6371000.0 * pg_catalog.asin(
            least(
              1.0::double precision,
              pg_catalog.sqrt(
                greatest(
                  0.0::double precision,
                  pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_latitude - v_target_lat) / 2.0), 2.0)
                  + pg_catalog.cos(pg_catalog.radians(v_target_lat))
                    * pg_catalog.cos(pg_catalog.radians(p_latitude))
                    * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_longitude - v_target_lon) / 2.0), 2.0)
                )
              )
            )
          )
        )::numeric,
        1
      )::double precision;
    end if;
  end if;

  insert into public.attendance_checkins (
    app_user_id,
    business_date,
    sequence_in_day,
    latitude,
    longitude,
    accuracy_meters,
    address_hint,
    note,
    device_claimed_at,
    captured_at,
    received_at,
    time_source,
    time_verified,
    time_anchor_issued_at,
    elapsed_since_anchor_ms,
    sync_delay_seconds,
    idempotency_key,
    request_fingerprint,
    time_token_digest,
    photo_storage_key,
    photo_sha256,
    photo_size_bytes,
    photo_mime_type,
    distance_target_kind,
    branch_id_used,
    branch_code_used,
    branch_name_used,
    branch_version_used,
    hq_version_used,
    distance_meters,
    distance_status
  ) values (
    p_app_user_id,
    v_business_date,
    v_sequence_in_day,
    p_latitude,
    p_longitude,
    p_accuracy_meters,
    v_address_hint,
    v_note,
    p_device_claimed_at,
    v_captured_at,
    v_received_at,
    p_time_source,
    v_time_verified,
    p_time_anchor_issued_at,
    p_elapsed_since_anchor_ms,
    v_sync_delay_seconds,
    p_idempotency_key,
    p_request_fingerprint,
    p_time_token_digest,
    pg_catalog.btrim(p_photo_storage_key),
    p_photo_sha256,
    p_photo_size_bytes,
    p_photo_mime_type,
    v_distance_target_kind,
    v_branch_id_used,
    v_branch_code_used,
    v_branch_name_used,
    v_branch_version_used,
    v_hq_version_used,
    v_distance_meters,
    v_distance_status
  )
  returning * into v_inserted;

  select count(*)::integer
    into v_daily_count
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.business_date = v_business_date;

  return pg_catalog.jsonb_build_object(
    'checkin_id', v_inserted.checkin_id,
    'business_date', v_inserted.business_date::text,
    'sequence_in_day', v_inserted.sequence_in_day,
    'daily_count', v_daily_count,
    'captured_at', pg_catalog.to_char(v_inserted.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'received_at', pg_catalog.to_char(v_inserted.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'time_source', v_inserted.time_source,
    'replayed', false
  );
end;
$function$;

-- Update attendance_admin_report to use persisted check-in snapshot (with fallback for pre-migration rows)
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
  v_can_configure_hq boolean;
  v_today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_to_date date := coalesce(p_to_date, v_today);
  v_from_date date := coalesce(p_from_date, coalesce(p_to_date, v_today) - 6);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_search text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  v_search_pattern text := null;
  v_employee_options jsonb := '[]'::jsonb;
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

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'app_user_id', eo.app_user_id,
               'display_name', eo.display_name,
               'personnel_code', eo.personnel_code
             )
             order by pg_catalog.lower(eo.display_name) asc,
                      eo.display_name asc,
                      coalesce(eo.personnel_code, '') asc,
                      eo.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_employee_options
    from (
      select distinct
        c.app_user_id,
        u.display_name,
        rec.personnel_code
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
      where c.business_date between v_from_date and v_to_date
    ) eo;

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
       where c.distance_status is null
         and h.effective_from <= (
           case when c.time_verified then c.captured_at else c.received_at end
         )
       order by h.effective_from desc, h.version desc
       limit 1
    ) hq on true
    where c.business_date between v_from_date and v_to_date
      and (p_employee_id is null or c.app_user_id = p_employee_id)
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

-- =============================================================================
-- SECTION 2B: HRP Branch & Assignment Admin RPCs
-- =============================================================================

create or replace function public.attendance_list_branches_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_include_inactive boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_can_manage boolean;
  v_include_inactive boolean := coalesce(p_include_inactive, true);
  v_today_vn date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_branches jsonb;
  v_assignments jsonb;
  v_employee_options jsonb;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'branch_id', b.branch_id,
        'branch_code', b.branch_code,
        'display_name', b.display_name,
        'address', b.address,
        'latitude', b.latitude,
        'longitude', b.longitude,
        'active', b.active,
        'version', b.version,
        'active_assignment_count', coalesce(cnt.active_count, 0),
        'created_at', b.created_at,
        'updated_at', b.updated_at,
        'updated_by_display_name', u.display_name
      )
      order by b.branch_code asc, b.branch_id asc
    ),
    '[]'::jsonb
  )
    into v_branches
  from public.attendance_branches b
  join public.direct_entry_app_users u
    on u.app_user_id = b.updated_by_user_id
  left join lateral (
    select count(*)::integer as active_count
    from public.attendance_branch_assignments a
    where a.branch_id = b.branch_id
      and a.valid_from <= v_today_vn
      and (a.valid_to is null or v_today_vn <= a.valid_to)
  ) cnt on true
  where v_include_inactive or b.active = true;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'assignment_id', a.assignment_id,
        'app_user_id', a.app_user_id,
        'employee_display_name', emp.display_name,
        'personnel_code', rec.personnel_code,
        'branch_id', a.branch_id,
        'branch_code', b.branch_code,
        'branch_name', b.display_name,
        'valid_from', a.valid_from,
        'valid_to', a.valid_to,
        'effective', (
          a.valid_from <= v_today_vn
          and (a.valid_to is null or v_today_vn <= a.valid_to)
          and b.active = true
        ),
        'version', a.version,
        'created_at', a.created_at,
        'updated_at', a.updated_at
      )
      order by
        (a.valid_to is null) desc,
        a.valid_from desc,
        lower(emp.display_name) asc,
        a.assignment_id asc
    ),
    '[]'::jsonb
  )
    into v_assignments
  from public.attendance_branch_assignments a
  join public.attendance_branches b
    on b.branch_id = a.branch_id
  join public.direct_entry_app_users emp
    on emp.app_user_id = a.app_user_id
  left join lateral (
    select r.personnel_code
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
    where l.app_user_id = a.app_user_id
      and l.is_current = true
      and l.verified = true
    limit 1
  ) rec on true
  where v_include_inactive or a.valid_to is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'app_user_id', u.app_user_id,
        'display_name', u.display_name,
        'personnel_code', rec.personnel_code,
        'enabled', u.enabled
      )
      order by lower(u.display_name) asc, u.app_user_id asc
    ),
    '[]'::jsonb
  )
    into v_employee_options
  from public.direct_entry_app_users u
  left join lateral (
    select r.personnel_code
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
    where l.app_user_id = u.app_user_id
      and l.is_current = true
      and l.verified = true
    limit 1
  ) rec on true
  where u.enabled = true;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_manage_branches', v_can_manage
    ),
    'business_date', v_today_vn,
    'include_inactive', v_include_inactive,
    'branches', v_branches,
    'assignments', v_assignments,
    'employee_options', v_employee_options
  );
end;
$$;

create or replace function public.attendance_upsert_branch_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_branch_id uuid,
  p_branch_code text,
  p_display_name text,
  p_address text,
  p_latitude double precision,
  p_longitude double precision,
  p_active boolean,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_can_manage boolean;
  v_actor_display_name text;
  v_existing_rev public.attendance_branch_revisions%rowtype;
  v_current_branch public.attendance_branches%rowtype;
  v_branch_code text := upper(btrim(coalesce(p_branch_code, '')));
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_address text := btrim(coalesce(p_address, ''));
  v_active boolean := coalesce(p_active, true);
  v_new_version integer;
  v_now timestamptz := clock_timestamp();
  v_saved public.attendance_branches%rowtype;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_BRANCH_WRITE_DENIED'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  if v_branch_code !~ '^[A-Z0-9][A-Z0-9._:-]{0,63}$'
     or length(v_display_name) < 1
     or length(v_display_name) > 256
     or v_display_name ~ '[\x00-\x1F\x7F]'
     or length(v_address) > 500
     or v_address ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
     or (p_latitude is null) <> (p_longitude is null)
     or (
       p_latitude is not null
       and (
         p_latitude in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
         or p_latitude < -90.0 or p_latitude > 90.0
       )
     )
     or (
       p_longitude is not null
       and (
         p_longitude in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
         or p_longitude < -180.0 or p_longitude > 180.0
       )
     )
     or p_expected_version is null
     or p_expected_version < 0 then
    raise exception 'ATTENDANCE_BRANCH_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_branches_write'),
    0
  );

  select *
    into v_existing_rev
  from public.attendance_branch_revisions r
  where r.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_rev.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;

    select u.display_name
      into v_actor_display_name
    from public.direct_entry_app_users u
    where u.app_user_id = v_existing_rev.actor_user_id;

    return jsonb_build_object(
      'replayed', true,
      'branch', jsonb_build_object(
        'branch_id', v_existing_rev.branch_id,
        'branch_code', v_existing_rev.branch_code,
        'display_name', v_existing_rev.display_name,
        'address', v_existing_rev.address,
        'latitude', v_existing_rev.latitude,
        'longitude', v_existing_rev.longitude,
        'active', v_existing_rev.active,
        'version', v_existing_rev.version,
        'updated_at', v_existing_rev.effective_from,
        'updated_by_display_name', v_actor_display_name
      )
    );
  end if;

  if p_branch_id is null then
    if p_expected_version <> 0 then
      raise exception 'ATTENDANCE_BRANCH_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;

    if exists (
      select 1
      from public.attendance_branches b
      where b.branch_code = v_branch_code
    ) then
      raise exception 'ATTENDANCE_BRANCH_CODE_CONFLICT'
        using errcode = 'PT409';
    end if;

    v_new_version := 1;

    insert into public.attendance_branches (
      branch_code,
      display_name,
      address,
      latitude,
      longitude,
      active,
      version,
      created_at,
      updated_at,
      updated_by_user_id
    )
    values (
      v_branch_code,
      v_display_name,
      v_address,
      p_latitude,
      p_longitude,
      v_active,
      v_new_version,
      v_now,
      v_now,
      p_app_user_id
    )
    returning * into v_saved;

    insert into public.attendance_branch_revisions (
      branch_id,
      version,
      action,
      branch_code,
      display_name,
      address,
      latitude,
      longitude,
      active,
      effective_from,
      actor_user_id,
      idempotency_key,
      request_fingerprint
    )
    values (
      v_saved.branch_id,
      v_saved.version,
      'CREATE',
      v_saved.branch_code,
      v_saved.display_name,
      v_saved.address,
      v_saved.latitude,
      v_saved.longitude,
      v_saved.active,
      v_now,
      p_app_user_id,
      p_idempotency_key,
      p_request_fingerprint
    );
  else
    select *
      into v_current_branch
    from public.attendance_branches b
    where b.branch_id = p_branch_id
    for update;

    if not found then
      raise exception 'ATTENDANCE_BRANCH_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    if v_current_branch.version <> p_expected_version then
      raise exception 'ATTENDANCE_BRANCH_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;

    if exists (
      select 1
      from public.attendance_branches b
      where b.branch_code = v_branch_code
        and b.branch_id <> p_branch_id
    ) then
      raise exception 'ATTENDANCE_BRANCH_CODE_CONFLICT'
        using errcode = 'PT409';
    end if;

    v_new_version := v_current_branch.version + 1;

    update public.attendance_branches
    set
      branch_code = v_branch_code,
      display_name = v_display_name,
      address = v_address,
      latitude = p_latitude,
      longitude = p_longitude,
      active = v_active,
      version = v_new_version,
      updated_at = v_now,
      updated_by_user_id = p_app_user_id
    where branch_id = p_branch_id
    returning * into v_saved;

    insert into public.attendance_branch_revisions (
      branch_id,
      version,
      action,
      branch_code,
      display_name,
      address,
      latitude,
      longitude,
      active,
      effective_from,
      actor_user_id,
      idempotency_key,
      request_fingerprint
    )
    values (
      v_saved.branch_id,
      v_saved.version,
      'UPDATE',
      v_saved.branch_code,
      v_saved.display_name,
      v_saved.address,
      v_saved.latitude,
      v_saved.longitude,
      v_saved.active,
      v_now,
      p_app_user_id,
      p_idempotency_key,
      p_request_fingerprint
    );
  end if;

  select u.display_name
    into v_actor_display_name
  from public.direct_entry_app_users u
  where u.app_user_id = p_app_user_id;

  return jsonb_build_object(
    'replayed', false,
    'branch', jsonb_build_object(
      'branch_id', v_saved.branch_id,
      'branch_code', v_saved.branch_code,
      'display_name', v_saved.display_name,
      'address', v_saved.address,
      'latitude', v_saved.latitude,
      'longitude', v_saved.longitude,
      'active', v_saved.active,
      'version', v_saved.version,
      'updated_at', v_saved.updated_at,
      'updated_by_display_name', v_actor_display_name
    )
  );
end;
$$;

create or replace function public.attendance_assign_employee_branch_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_branch_id uuid,
  p_valid_from date,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_can_manage boolean;
  v_existing public.attendance_branch_assignments%rowtype;
  v_branch public.attendance_branches%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_valid_from date := coalesce(
    p_valid_from,
    (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_inserted public.attendance_branch_assignments%rowtype;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_BRANCH_WRITE_DENIED'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  if p_target_app_user_id is null
     or p_branch_id is null
     or p_expected_version is null
     or p_expected_version < 1 then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_branch_assignments_user'),
    hashtext(p_target_app_user_id::text)
  );

  select *
    into v_existing
  from public.attendance_branch_assignments a
  where a.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;

    select *
      into v_branch
    from public.attendance_branches b
    where b.branch_id = v_existing.branch_id;

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'branch_id', v_existing.branch_id,
        'branch_code', v_branch.branch_code,
        'branch_name', v_branch.display_name,
        'valid_from', v_existing.valid_from,
        'valid_to', v_existing.valid_to,
        'version', v_existing.version
      )
    );
  end if;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = p_target_app_user_id;

  if not found or v_target_user.enabled is distinct from true then
    raise exception 'ATTENDANCE_BRANCH_TARGET_USER_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_branch
  from public.attendance_branches b
  where b.branch_id = p_branch_id
  for share;

  if not found then
    raise exception 'ATTENDANCE_BRANCH_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_branch.version <> p_expected_version then
    raise exception 'ATTENDANCE_BRANCH_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if not v_branch.active then
    raise exception 'ATTENDANCE_BRANCH_INACTIVE'
      using errcode = '22023';
  end if;

  insert into public.attendance_branch_assignments (
    app_user_id,
    branch_id,
    valid_from,
    valid_to,
    version,
    assigned_by_user_id,
    idempotency_key,
    request_fingerprint
  )
  values (
    p_target_app_user_id,
    p_branch_id,
    v_valid_from,
    null,
    1,
    p_app_user_id,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_inserted.assignment_id,
      'app_user_id', v_inserted.app_user_id,
      'branch_id', v_inserted.branch_id,
      'branch_code', v_branch.branch_code,
      'branch_name', v_branch.display_name,
      'valid_from', v_inserted.valid_from,
      'valid_to', v_inserted.valid_to,
      'version', v_inserted.version
    )
  );
end;
$$;

create or replace function public.attendance_unassign_employee_branch_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_valid_to date,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_can_manage boolean;
  v_existing public.attendance_branch_assignments%rowtype;
  v_current public.attendance_branch_assignments%rowtype;
  v_valid_to date := coalesce(
    p_valid_to,
    (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_updated public.attendance_branch_assignments%rowtype;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_BRANCH_WRITE_DENIED'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  if p_assignment_id is null
     or p_expected_version is null
     or p_expected_version < 1 then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_branch_assignments_unassign'),
    hashtext(p_assignment_id::text)
  );

  select *
    into v_existing
  from public.attendance_branch_assignments a
  where a.revoke_idempotency_key = p_idempotency_key;

  if found then
    if v_existing.revoke_request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'branch_id', v_existing.branch_id,
        'valid_from', v_existing.valid_from,
        'valid_to', v_existing.valid_to,
        'version', v_existing.version
      )
    );
  end if;

  select *
    into v_current
  from public.attendance_branch_assignments a
  where a.assignment_id = p_assignment_id
  for update;

  if not found then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_current.version <> p_expected_version then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_current.valid_to is not null then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED'
      using errcode = 'PT409';
  end if;

  if v_valid_to < v_current.valid_from then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID'
      using errcode = '22023';
  end if;

  update public.attendance_branch_assignments
  set
    valid_to = v_valid_to,
    version = v_current.version + 1,
    revoked_by_user_id = p_app_user_id,
    revoked_at = clock_timestamp(),
    revoke_idempotency_key = p_idempotency_key,
    revoke_request_fingerprint = p_request_fingerprint,
    updated_at = clock_timestamp()
  where assignment_id = p_assignment_id
  returning * into v_updated;

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_updated.assignment_id,
      'app_user_id', v_updated.app_user_id,
      'branch_id', v_updated.branch_id,
      'valid_from', v_updated.valid_from,
      'valid_to', v_updated.valid_to,
      'version', v_updated.version
    )
  );
end;
$$;

-- =============================================================================
-- SECTION 3: Project Coordinates & HRP Integration Catalog RPC
-- =============================================================================

alter table public.direct_entry_projects
  add column if not exists location_address text,
  add column if not exists location_latitude numeric(10,7),
  add column if not exists location_longitude numeric(10,7),
  add column if not exists location_radius_meters integer not null default 200,
  add column if not exists location_confirmed_at timestamptz,
  add column if not exists location_confirmed_by_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  add column if not exists updated_at timestamptz not null default now();

alter table public.direct_entry_projects
  add constraint direct_entry_projects_location_address_check check (
    location_address is null
    or (
      length(btrim(location_address)) between 1 and 500
      and location_address !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    )
  ),
  add constraint direct_entry_projects_location_latitude_check check (
    location_latitude is null
    or (location_latitude >= -90 and location_latitude <= 90)
  ),
  add constraint direct_entry_projects_location_longitude_check check (
    location_longitude is null
    or (location_longitude >= -180 and location_longitude <= 180)
  ),
  add constraint direct_entry_projects_location_radius_check check (
    location_radius_meters between 50 and 2000
  ),
  add constraint direct_entry_projects_location_pair_check check (
    (location_latitude is null) = (location_longitude is null)
    and (location_confirmed_at is null) = (location_confirmed_by_user_id is null)
    and (
      location_confirmed_at is null
      or (location_latitude is not null and location_longitude is not null)
    )
  );

create or replace function public.direct_entry_project_snapshot(
  p_project public.direct_entry_projects
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'project_id', p_project.project_id,
    'display_name', p_project.display_name,
    'active', p_project.active,
    'version', p_project.version,
    'location', case
      when p_project.location_latitude is not null and p_project.location_longitude is not null then
        jsonb_build_object(
          'address', p_project.location_address,
          'latitude', p_project.location_latitude::double precision,
          'longitude', p_project.location_longitude::double precision,
          'radius_meters', p_project.location_radius_meters,
          'confirmed_at', p_project.location_confirmed_at,
          'confirmed_by_user_id', p_project.location_confirmed_by_user_id
        )
      else null
    end
  );
$$;

create or replace function public.direct_entry_list_projects_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_include_inactive boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_team_id uuid;
  v_include_inactive boolean := coalesce(p_include_inactive, false);
  v_projects jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if v_authority = 'team_manager_assign' then
    v_include_inactive := false;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'project_id', p.project_id,
      'display_name', p.display_name,
      'active', p.active,
      'version', p.version,
      'created_at', rev.first_revision_at,
      'updated_at', rev.last_revision_at,
      'revision_count', coalesce(rev.revision_count, 0),
      'active_assignment_count', coalesce(asg.active_count, 0),
      'can_manage_project_master', v_authority <> 'team_manager_assign',
      'can_assign_managers',
        v_authority <> 'team_manager_assign'
        or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id),
      'location', case
        when p.location_latitude is not null and p.location_longitude is not null then
          jsonb_build_object(
            'address', p.location_address,
            'latitude', p.location_latitude::double precision,
            'longitude', p.location_longitude::double precision,
            'radius_meters', p.location_radius_meters,
            'confirmed_at', case
              when p.location_confirmed_at is not null then
                pg_catalog.to_char(
                  p.location_confirmed_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )
              else null
            end
          )
        else null
      end
    ) order by p.display_name, p.project_id), '[]'::jsonb)
    into v_projects
    from public.direct_entry_projects p
    left join lateral (
      select min(r.created_at) as first_revision_at,
             max(r.created_at) as last_revision_at,
             count(*)::int as revision_count
        from public.direct_entry_project_revisions r
       where r.project_id = p.project_id
    ) rev on true
    left join lateral (
      select count(*)::int as active_count
        from public.direct_entry_project_manager_assignments a
       where a.project_id = p.project_id and a.valid_to is null
    ) asg on true
   where (v_include_inactive or p.active)
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
     );

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'projects', v_projects
  );
end;
$function$;

create or replace function public.direct_entry_get_project_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_team_id uuid;
  v_project jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;

  select jsonb_build_object(
      'project_id', p.project_id,
      'display_name', p.display_name,
      'active', p.active,
      'version', p.version,
      'created_at', rev.first_revision_at,
      'updated_at', rev.last_revision_at,
      'revision_count', coalesce(rev.revision_count, 0),
      'active_assignment_count', coalesce(asg.active_count, 0),
      'can_manage_project_master', v_authority <> 'team_manager_assign',
      'can_assign_managers',
        v_authority <> 'team_manager_assign'
        or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id),
      'location', case
        when p.location_latitude is not null and p.location_longitude is not null then
          jsonb_build_object(
            'address', p.location_address,
            'latitude', p.location_latitude::double precision,
            'longitude', p.location_longitude::double precision,
            'radius_meters', p.location_radius_meters,
            'confirmed_at', case
              when p.location_confirmed_at is not null then
                pg_catalog.to_char(
                  p.location_confirmed_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )
              else null
            end
          )
        else null
      end
    )
    into v_project
    from public.direct_entry_projects p
    left join lateral (
      select min(r.created_at) as first_revision_at,
             max(r.created_at) as last_revision_at,
             count(*)::int as revision_count
        from public.direct_entry_project_revisions r
       where r.project_id = p.project_id
    ) rev on true
    left join lateral (
      select count(*)::int as active_count
        from public.direct_entry_project_manager_assignments a
       where a.project_id = p.project_id and a.valid_to is null
    ) asg on true
   where p.project_id = p_project_id
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
     );
  if v_project is null then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  return v_project;
end;
$function$;

create or replace function public.direct_entry_update_project_location(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_expected_version integer,
  p_address text,
  p_latitude numeric,
  p_longitude numeric,
  p_radius_meters integer,
  p_clear boolean,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authority text;
  v_prior jsonb;
  v_result jsonb;
  v_current public.direct_entry_projects;
  v_after public.direct_entry_projects;
  v_before jsonb;
  v_clear boolean := coalesce(p_clear, false);
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_lat numeric(10,7);
  v_lon numeric(10,7);
  v_radius integer := coalesce(p_radius_meters, 200);
  v_reason_id uuid;
  v_project_version integer;
  v_revision_id uuid;
  v_now timestamptz := now();
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');

  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select a.authority into v_authority
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if v_authority = 'team_manager_assign' then
    raise exception 'project administration denied' using errcode = '42501';
  end if;

  if v_clear then
    if p_latitude is not null or p_longitude is not null or v_address is not null then
      raise exception 'clear location must not supply coordinates or address'
        using errcode = '22023';
    end if;
    v_lat := null;
    v_lon := null;
    v_radius := 200;
  else
    if p_latitude is null or p_longitude is null then
      raise exception 'latitude and longitude are required when setting project location'
        using errcode = '22023';
    end if;
    v_lat := round(p_latitude, 7);
    v_lon := round(p_longitude, 7);
    if v_lat < -90 or v_lat > 90 or v_lon < -180 or v_lon > 180 then
      raise exception 'project coordinates out of range'
        using errcode = '22023';
    end if;
    if v_radius < 50 or v_radius > 2000 then
      raise exception 'location_radius_meters must be between 50 and 2000'
        using errcode = '22023';
    end if;
    if v_address is not null and (
      length(v_address) > 500
      or v_address ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ) then
      raise exception 'location_address invalid'
        using errcode = '22023';
    end if;
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'project_location_update',
    p_idempotency_key,
    public.direct_entry_payload_hash(
      jsonb_build_object(
        'project_id', p_project_id,
        'expected_version', p_expected_version,
        'clear', v_clear,
        'address', v_address,
        'latitude', v_lat,
        'longitude', v_lon,
        'radius_meters', v_radius,
        'reason', p_reason
      )
    )
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_current := public.direct_entry_lock_project(p_project_id, p_expected_version);

  if v_clear then
    if v_current.location_latitude is null and v_current.location_longitude is null then
      raise exception 'project location is already empty'
        using errcode = '22023';
    end if;
  else
    if v_current.location_latitude is not distinct from v_lat
       and v_current.location_longitude is not distinct from v_lon
       and v_current.location_address is not distinct from v_address
       and v_current.location_radius_meters is not distinct from v_radius then
      raise exception 'project location is unchanged'
        using errcode = '22023';
    end if;
  end if;

  v_before := public.direct_entry_project_snapshot(v_current);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  update public.direct_entry_projects
  set
    location_address = case when v_clear then null else v_address end,
    location_latitude = v_lat,
    location_longitude = v_lon,
    location_radius_meters = v_radius,
    location_confirmed_at = case when v_clear then null else v_now end,
    location_confirmed_by_user_id = case when v_clear then null else p_app_user_id end,
    updated_at = v_now
  where project_id = p_project_id
  returning * into v_after;

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
  from public.direct_entry_bump_project_version(
    p_project_id,
    p_app_user_id,
    v_reason_id,
    v_before,
    public.direct_entry_project_snapshot(v_after)
  ) b;

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    reason_id,
    changed_fields,
    project_revision_id
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'project_location_update',
    v_authority,
    p_project_id,
    'all',
    'APPLIED',
    v_reason_id,
    array[
      'location_address',
      'location_latitude',
      'location_longitude',
      'location_radius_meters',
      'location_confirmed_at',
      'version'
    ],
    v_revision_id
  );

  v_result := jsonb_build_object(
    'project_id', v_after.project_id,
    'display_name', v_after.display_name,
    'active', v_after.active,
    'version', v_project_version,
    'revision_id', v_revision_id,
    'location', case
      when v_after.location_latitude is not null and v_after.location_longitude is not null then
        jsonb_build_object(
          'address', v_after.location_address,
          'latitude', v_after.location_latitude::double precision,
          'longitude', v_after.location_longitude::double precision,
          'radius_meters', v_after.location_radius_meters,
          'confirmed_at', case
            when v_after.location_confirmed_at is not null then
              pg_catalog.to_char(
                v_after.location_confirmed_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            else null
          end
        )
      else null
    end
  );

  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_location_update', p_idempotency_key, v_result
  );

  return v_result;
end;
$function$;

-- HRP Integration Catalog RPC (`public.hrp_sync_catalog`)
create or replace function public.hrp_sync_catalog(
  p_auth_subject uuid default null,
  p_app_user_id uuid default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_resolved_app_user_id uuid := p_app_user_id;
  v_resolved_auth_subject uuid := p_auth_subject;
  v_user_enabled boolean;
  v_now timestamptz := clock_timestamp();
  v_projects jsonb;
  v_recruiters jsonb;
  v_labor_types jsonb;
  v_project_count integer := 0;
  v_recruiter_count integer := 0;
  v_labor_type_count integer := 0;
begin
  if p_auth_subject is not null or p_app_user_id is not null then
    select u.app_user_id, u.auth_subject, u.enabled
      into v_resolved_app_user_id, v_resolved_auth_subject, v_user_enabled
    from public.direct_entry_app_users u
    where (p_auth_subject is null or u.auth_subject = p_auth_subject)
      and (p_app_user_id is null or u.app_user_id = p_app_user_id)
    limit 1;

    if v_user_enabled is distinct from true then
      raise exception 'HRP_SYNC_ACTOR_DENIED'
        using errcode = '42501';
    end if;
  end if;

  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'projectId', p.project_id,
          'displayName', p.display_name,
          'active', p.active,
          'version', p.version,
          'updatedAt', to_char(
            coalesce(rev.updated_at, p.location_confirmed_at, p.updated_at) at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'location', case
            when p.location_latitude is not null and p.location_longitude is not null then
              jsonb_build_object(
                'address', p.location_address,
                'latitude', p.location_latitude::double precision,
                'longitude', p.location_longitude::double precision,
                'radiusMeters', p.location_radius_meters,
                'confirmedAt', case
                  when p.location_confirmed_at is not null then
                    to_char(
                      p.location_confirmed_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                    )
                  else null
                end
              )
            else null
          end
        )
        order by p.project_id asc
      ),
      '[]'::jsonb
    )
    into v_project_count, v_projects
  from public.direct_entry_projects p
  left join lateral (
    select max(r.created_at) as updated_at
    from public.direct_entry_project_revisions r
    where r.project_id = p.project_id
  ) rev on true;

  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'recruiterId', r.recruiter_id,
          'displayName', r.display_name,
          'personnelCode', r.personnel_code,
          'personnelPosition', r.personnel_position,
          'active', r.active,
          'providerTypes', coalesce(prov.provider_types, '[]'::jsonb),
          'teams', coalesce(tm.teams, '[]'::jsonb)
        )
        order by lower(r.display_name) asc, r.recruiter_id asc
      ),
      '[]'::jsonb
    )
    into v_recruiter_count, v_recruiters
  from public.recruiters r
  left join lateral (
    select jsonb_agg(rpm.provider_type order by rpm.provider_type asc) as provider_types
    from public.recruiter_provider_memberships rpm
    where rpm.recruiter_id = r.recruiter_id
      and rpm.is_current = true
  ) prov on true
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'teamId', t.team_id,
        'code', t.code,
        'displayName', t.display_name,
        'active', t.active
      )
      order by t.code asc, t.team_id asc
    ) as teams
    from public.recruiter_team_memberships rtm
    join public.teams t
      on t.team_id = rtm.team_id
    where rtm.recruiter_id = r.recruiter_id
      and rtm.is_current = true
  ) tm on true;

  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'key', lt.labor_type_key,
          'displayName', lt.display_name,
          'active', lt.active,
          'sortOrder', lt.sort_order,
          'version', lt.version
        )
        order by lt.sort_order asc, lt.labor_type_key asc
      ),
      '[]'::jsonb
    )
    into v_labor_type_count, v_labor_types
  from public.direct_entry_labor_types lt;

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    changed_fields
  )
  values (
    v_resolved_auth_subject,
    v_resolved_app_user_id,
    'hrp_sync_catalog_read',
    'integration_hrp_catalog',
    'hrp_v1_catalog:' || coalesce(p_request_id::text, '00000000-0000-0000-0000-000000000000'),
    'all',
    'ALLOW',
    array[
      'endpoint:api.integrations.hrp.v1.catalog',
      'projects:' || v_project_count::text,
      'recruiters:' || v_recruiter_count::text,
      'labor_types:' || v_labor_type_count::text
    ]
  );

  return jsonb_build_object(
    'ok', true,
    'serverTime', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'projects', v_projects,
    'recruiters', v_recruiters,
    'laborTypes', v_labor_types
  );
end;
$$;

-- =============================================================================
-- SECTION 4: Monthly Attendance Matrix Report RPC
-- =============================================================================

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
  v_can_configure_hq boolean;
  v_today_vn date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_year_month text := coalesce(
    nullif(btrim(coalesce(p_year_month, '')), ''),
    to_char(v_today_vn, 'YYYY-MM')
  );
  v_year integer;
  v_month integer;
  v_month_start date;
  v_month_end date;
  v_days_in_month integer;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_escaped_search text := null;
  v_offset integer;
  v_current_hq jsonb := null;
  v_calendar_days jsonb := '[]'::jsonb;
  v_branch_options jsonb := '[]'::jsonb;
  v_employee_options jsonb := '[]'::jsonb;
  v_overview jsonb;
  v_items jsonb;
  v_total_rows integer := 0;
  v_total_pages integer := 0;
  v_snapshot_token text;
begin
  v_can_configure_hq := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

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
  v_days_in_month := (v_month_end - v_month_start) + 1;

  if v_page < 1 or v_page > 10000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'ATTENDANCE_REPORT_PAGINATION_INVALID'
      using errcode = '22023';
  end if;

  if v_search is not null and (
    length(v_search) > 100
    or v_search ~ '[\x00-\x1F\x7F]'
  ) then
    raise exception 'ATTENDANCE_REPORT_SEARCH_INVALID'
      using errcode = '22023';
  end if;

  if v_search is not null and p_employee_id is not null then
    raise exception 'ATTENDANCE_REPORT_FILTER_CONFLICT'
      using errcode = '22023';
  end if;

  if v_search is not null then
    v_escaped_search := replace(
      replace(
        replace(lower(v_search), '\', '\\'),
        '%', '\%'
      ),
      '_', '\_'
    );
  end if;

  v_offset := (v_page - 1) * v_page_size;

  -- Current HQ configuration
  select jsonb_build_object(
    'version', r.version,
    'latitude', r.latitude,
    'longitude', r.longitude,
    'effective_from', r.effective_from,
    'effective_from_local', to_char(
      r.effective_from at time zone 'Asia/Ho_Chi_Minh',
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'configured_by_display_name', u.display_name
  )
    into v_current_hq
  from public.attendance_hq_location_revisions r
  join public.direct_entry_app_users u
    on u.app_user_id = r.configured_by_user_id
  order by r.version desc
  limit 1;

  -- Calendar days of the month
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

  -- Branch filter options
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
  )
    into v_branch_options
  from public.attendance_branches b;

  -- Employee options scoped to month (unfiltered by search/employee_id/branch_id so selector stays populated)
  with month_candidate_users as (
    select
      u.app_user_id,
      u.display_name,
      u.enabled,
      rec.personnel_code,
      br.branch_id,
      br.branch_code,
      br.display_name as branch_name
    from public.direct_entry_app_users u
    left join lateral (
      select r.personnel_code
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r
        on r.recruiter_id = l.recruiter_id
      where l.app_user_id = u.app_user_id
        and l.is_current = true
        and l.verified = true
      limit 1
    ) rec on true
    left join lateral (
      select
        b.branch_id,
        b.branch_code,
        b.display_name
      from public.attendance_branch_assignments a
      join public.attendance_branches b
        on b.branch_id = a.branch_id
      where a.app_user_id = u.app_user_id
        and a.valid_from <= v_month_end
        and (a.valid_to is null or a.valid_to >= v_month_start)
      order by a.valid_from desc
      limit 1
    ) br on true
    where u.enabled = true
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
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'app_user_id', m.app_user_id,
        'display_name', m.display_name,
        'personnel_code', m.personnel_code,
        'branch_id', m.branch_id,
        'branch_code', m.branch_code,
        'branch_name', m.branch_name
      )
      order by lower(m.display_name) asc, m.app_user_id asc
    ),
    '[]'::jsonb
  )
    into v_employee_options
  from month_candidate_users m;

  -- Set-based monthly matrix calculation
  with candidate_employees as (
    select
      u.app_user_id,
      u.display_name as employee_display_name,
      u.enabled,
      rec.personnel_code,
      br.branch_id,
      br.branch_code,
      br.display_name as branch_display_name,
      br.address as branch_address,
      br.latitude as branch_latitude,
      br.longitude as branch_longitude,
      br.active as branch_active,
      br.version as branch_version,
      br.valid_from as branch_valid_from,
      br.valid_to as branch_valid_to
    from public.direct_entry_app_users u
    left join lateral (
      select r.personnel_code
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r
        on r.recruiter_id = l.recruiter_id
      where l.app_user_id = u.app_user_id
        and l.is_current = true
        and l.verified = true
      limit 1
    ) rec on true
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
    where (
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
    )
    and (p_employee_id is null or u.app_user_id = p_employee_id)
    and (
      p_branch_id is null
      or br.branch_id = p_branch_id
      or exists (
        select 1
        from public.attendance_checkins c
        where c.app_user_id = u.app_user_id
          and c.business_date between v_month_start and v_month_end
          and c.branch_id_used = p_branch_id
      )
    )
    and (
      v_escaped_search is null
      or lower(u.display_name) like '%' || v_escaped_search || '%' escape '\'
      or lower(coalesce(rec.personnel_code, '')) like '%' || v_escaped_search || '%' escape '\'
      or lower(coalesce(br.branch_code, '')) like '%' || v_escaped_search || '%' escape '\'
      or lower(coalesce(br.display_name, '')) like '%' || v_escaped_search || '%' escape '\'
    )
  ),
  month_checkins_enriched as (
    select
      c.checkin_id,
      c.app_user_id,
      c.business_date,
      c.sequence_in_day,
      c.captured_at,
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
  daily_checkins as (
    select
      mc.app_user_id,
      mc.business_date,
      count(*)::integer as checkin_count,
      count(*) filter (where mc.time_verified)::integer as verified_checkin_count,
      count(*) filter (where not mc.time_verified)::integer as unverified_checkin_count,
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
  daily_leaves as (
    select
      ld.app_user_id,
      ld.leave_date as business_date,
      sum(ld.half_day_units)::integer as half_day_units,
      round((sum(ld.half_day_units)::numeric / 2.0), 1)::double precision as leave_units,
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
  employee_rollup as (
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
      coalesce(chk.checkin_day_count, 0) as checkin_day_count,
      coalesce(chk.total_checkins, 0) as total_checkins,
      coalesce(chk.distance_computed_count, 0) as distance_computed_count,
      coalesce(chk.distance_unavailable_count, 0) as distance_unavailable_count,
      chk.min_distance_meters,
      chk.max_distance_meters,
      coalesce(lv.approved_leave_day_count, 0) as approved_leave_day_count,
      coalesce(lv.approved_leave_units, 0.0::double precision) as approved_leave_units,
      coalesce(both_days.overlap_day_count, 0) as checkin_and_leave_day_count,
      (v_days_in_month - coalesce(chk.checkin_day_count, 0))::integer as no_checkin_day_count,
      (
        v_days_in_month
        - coalesce(chk.checkin_day_count, 0)
        - (coalesce(lv.approved_leave_day_count, 0) - coalesce(both_days.overlap_day_count, 0))
      )::integer as no_checkin_without_leave_day_count
    from candidate_employees ce
    left join lateral (
      select
        count(*)::integer as checkin_day_count,
        coalesce(sum(dc.checkin_count), 0)::integer as total_checkins,
        coalesce(sum(dc.distance_computed_count), 0)::integer as distance_computed_count,
        coalesce(sum(dc.distance_unavailable_count), 0)::integer as distance_unavailable_count,
        min(dc.min_distance_meters) as min_distance_meters,
        max(dc.max_distance_meters) as max_distance_meters
      from daily_checkins dc
      where dc.app_user_id = ce.app_user_id
    ) chk on true
    left join lateral (
      select
        count(*)::integer as approved_leave_day_count,
        coalesce(round((sum(dl.half_day_units)::numeric / 2.0), 1)::double precision, 0.0::double precision) as approved_leave_units
      from daily_leaves dl
      where dl.app_user_id = ce.app_user_id
    ) lv on true
    left join lateral (
      select count(*)::integer as overlap_day_count
      from daily_checkins dc
      join daily_leaves dl
        on dl.app_user_id = dc.app_user_id
       and dl.business_date = dc.business_date
      where dc.app_user_id = ce.app_user_id
    ) both_days on true
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
        coalesce(
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
                'u', dc2.app_user_id,
                'd', dc2.business_date,
                'c', dc2.checkin_count,
                'vc', dc2.verified_checkin_count,
                'uc', dc2.unverified_checkin_count,
                'f', dc2.first_checkin_id,
                'l', dc2.last_checkin_id,
                'ft', dc2.first_captured_at,
                'lt', dc2.last_captured_at,
                'k', dc2.distance_target_kind,
                'bi', dc2.branch_id_used,
                'bc', dc2.branch_code_used,
                'bn', dc2.branch_name_used,
                'bv', dc2.branch_version_used,
                'hv', dc2.hq_version_used,
                'ds', dc2.distance_status,
                'dm', dc2.distance_meters,
                'dmin', dc2.min_distance_meters,
                'dmax', dc2.max_distance_meters
              )
              order by dc2.app_user_id asc, dc2.business_date asc
            )::text
            from daily_checkins dc2
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
      ) as snapshot_token
    from employee_rollup er
  ),
  paged_employees as (
    select er.*
    from employee_rollup er
    order by
      lower(er.employee_display_name) asc,
      coalesce(er.personnel_code, '') asc,
      er.app_user_id asc
    limit v_page_size
    offset v_offset
  ),
  paged_with_days as (
    select
      pe.*,
      (
        select jsonb_agg(
          jsonb_build_object(
            'business_date', cal.d::date,
            'day_of_month', extract(day from cal.d)::integer,
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
              else 'NO_CHECKIN'
            end
          )
          order by cal.d::date asc
        )
        from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
        left join daily_checkins dc
          on dc.app_user_id = pe.app_user_id
         and dc.business_date = cal.d::date
        left join daily_leaves dl
          on dl.app_user_id = pe.app_user_id
         and dl.business_date = cal.d::date
      ) as days
    from paged_employees pe
  )
  select
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
  into v_total_rows, v_snapshot_token, v_overview, v_items
  from agg a;

  v_total_pages := case
    when v_total_rows = 0 then 0
    else ceil(v_total_rows::numeric / v_page_size::numeric)::integer
  end;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_configure_hq', v_can_configure_hq,
      'can_manage_branches', v_can_configure_hq
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

-- =============================================================================
-- SECTION 5: Owner Alignment, Strict ACLs & Self-Check
-- =============================================================================

do $owner_align$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_tbl text;
  v_rel_owner_oid oid;
  v_fn regprocedure;
  v_proc_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_owner
  from pg_catalog.pg_class c
  join pg_catalog.pg_roles r on r.oid = c.relowner
  where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner is null then
    raise exception 'ATTENDANCE_MATRIX_OWNER_RESOLUTION_FAILED';
  end if;

  foreach v_tbl in array array[
    'attendance_branches',
    'attendance_branch_revisions',
    'attendance_branch_assignments'
  ] loop
    select c.relowner
      into v_rel_owner_oid
      from pg_catalog.pg_class c
     where c.oid = pg_catalog.to_regclass('public.' || v_tbl);

    if v_rel_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter table public.%I owner to %I', v_tbl, v_owner);
    end if;
  end loop;

  for v_fn, v_proc_owner_oid in
    select p.oid::regprocedure, p.proowner
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.attendance__internal_branch_assignment_no_overlap()'::pg_catalog.regprocedure,
       'public.attendance_record_checkin(uuid,uuid,uuid,text,double precision,double precision,double precision,text,text,timestamp with time zone,text,timestamp with time zone,bigint,text,text,text,integer,text,timestamp with time zone)'::pg_catalog.regprocedure,
       'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text,uuid)'::pg_catalog.regprocedure,
       'public.attendance_list_branches_admin(uuid,uuid,boolean)'::pg_catalog.regprocedure,
       'public.attendance_upsert_branch_admin(uuid,uuid,uuid,text,text,text,double precision,double precision,boolean,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_assign_employee_branch_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_unassign_employee_branch_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure,
       'public.direct_entry_project_snapshot(public.direct_entry_projects)'::pg_catalog.regprocedure,
       'public.direct_entry_list_projects_admin(uuid,uuid,boolean)'::pg_catalog.regprocedure,
       'public.direct_entry_get_project_admin(uuid,uuid,text)'::pg_catalog.regprocedure,
       'public.direct_entry_update_project_location(uuid,uuid,text,integer,text,numeric,numeric,integer,boolean,text,text)'::pg_catalog.regprocedure,
       'public.hrp_sync_catalog(uuid,uuid,uuid)'::pg_catalog.regprocedure
     )
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;
end;
$owner_align$;

revoke all on table
  public.attendance_branches,
  public.attendance_branch_revisions,
  public.attendance_branch_assignments
from public, anon, authenticated, service_role;

-- Internal helpers: revoke EXECUTE from all runtime roles including service_role
revoke all on function public.attendance__internal_branch_assignment_no_overlap()
  from public, anon, authenticated, service_role;

revoke all on function public.direct_entry_project_snapshot(public.direct_entry_projects)
  from public, anon, authenticated, service_role;

-- Service-role RPCs: revoke all then grant EXECUTE exclusively to service_role
revoke all on function public.attendance_record_checkin(uuid, uuid, uuid, text, double precision, double precision, double precision, text, text, timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_record_checkin(uuid, uuid, uuid, text, double precision, double precision, double precision, text, text, timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone)
  to service_role;

revoke all on function public.attendance_admin_report(uuid, uuid, date, date, integer, integer, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_admin_report(uuid, uuid, date, date, integer, integer, text, uuid)
  to service_role;

revoke all on function public.attendance_list_branches_admin(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_list_branches_admin(uuid, uuid, boolean)
  to service_role;

revoke all on function public.attendance_upsert_branch_admin(uuid, uuid, uuid, text, text, text, double precision, double precision, boolean, integer, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_upsert_branch_admin(uuid, uuid, uuid, text, text, text, double precision, double precision, boolean, integer, uuid, text)
  to service_role;

revoke all on function public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)
  to service_role;

revoke all on function public.attendance_unassign_employee_branch_admin(uuid, uuid, uuid, date, integer, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_unassign_employee_branch_admin(uuid, uuid, uuid, date, integer, uuid, text)
  to service_role;

revoke all on function public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)
  to service_role;

revoke all on function public.direct_entry_list_projects_admin(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_projects_admin(uuid, uuid, boolean)
  to service_role;

revoke all on function public.direct_entry_get_project_admin(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_project_admin(uuid, uuid, text)
  to service_role;

revoke all on function public.direct_entry_update_project_location(uuid, uuid, text, integer, text, numeric, numeric, integer, boolean, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_project_location(uuid, uuid, text, integer, text, numeric, numeric, integer, boolean, text, text)
  to service_role;

revoke all on function public.hrp_sync_catalog(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.hrp_sync_catalog(uuid, uuid, uuid)
  to service_role;

do $grant_internal_owner_exec$
declare
  v_base_owner name;
  v_owner name;
  v_helper_fn pg_catalog.regprocedure;
begin
  select r.rolname
    into v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  execute pg_catalog.format(
    'grant select, insert, update, delete on table public.attendance_branches, public.attendance_branch_revisions, public.attendance_branch_assignments to %I',
    v_base_owner
  );

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.attendance__internal_branch_assignment_no_overlap()'::pg_catalog.regprocedure,
       'public.attendance_record_checkin(uuid,uuid,uuid,text,double precision,double precision,double precision,text,text,timestamp with time zone,text,timestamp with time zone,bigint,text,text,text,integer,text,timestamp with time zone)'::pg_catalog.regprocedure,
       'public.attendance_admin_report(uuid,uuid,date,date,integer,integer,text,uuid)'::pg_catalog.regprocedure,
       'public.attendance_list_branches_admin(uuid,uuid,boolean)'::pg_catalog.regprocedure,
       'public.attendance_upsert_branch_admin(uuid,uuid,uuid,text,text,text,double precision,double precision,boolean,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_assign_employee_branch_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_unassign_employee_branch_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure,
       'public.direct_entry_project_snapshot(public.direct_entry_projects)'::pg_catalog.regprocedure,
       'public.direct_entry_list_projects_admin(uuid,uuid,boolean)'::pg_catalog.regprocedure,
       'public.direct_entry_get_project_admin(uuid,uuid,text)'::pg_catalog.regprocedure,
       'public.direct_entry_update_project_location(uuid,uuid,text,integer,text,numeric,numeric,integer,boolean,text,text)'::pg_catalog.regprocedure,
       'public.hrp_sync_catalog(uuid,uuid,uuid)'::pg_catalog.regprocedure
     )
  loop
    for v_helper_fn in
      select p.oid::pg_catalog.regprocedure
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in (
           'set_updated_at',
           'attendance__internal_branch_assignment_no_overlap',
           'attendance__internal_assert_report_reader',
           'direct_entry_assert_actor_mapping',
           'direct_entry_assert_actor_app_user_admin',
           'direct_entry_has_capability',
           'direct_entry_has_scope',
           'direct_entry_authorization_date',
           'direct_entry_assert_project_operation_authority',
           'direct_entry_project_team_scope_effective',
           'direct_entry_idempotency_begin',
           'direct_entry_idempotency_finish',
           'direct_entry_payload_hash',
           'direct_entry_lock_project',
           'direct_entry_project_snapshot',
           'direct_entry_reason',
           'direct_entry_bump_project_version'
         )
    loop
      execute pg_catalog.format(
        'grant execute on function %s to %I',
        v_helper_fn,
        v_owner
      );
    end loop;
  end loop;
end;
$grant_internal_owner_exec$;

commit;
