-- Attendance Backend WP1: append-only check-in event table, server-anchored /
-- unverified-device-clock time evidence, per-actor concurrency-safe daily
-- sequence allocation, idempotent replay/conflict handling, forced RLS, and
-- service-role-only SECURITY DEFINER RPC.

begin;

-- -----------------------------------------------------------------------------
-- 1. Append-only check-in event table (`public.attendance_checkins`).
-- -----------------------------------------------------------------------------
create table public.attendance_checkins (
  checkin_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  business_date date not null,
  sequence_in_day integer not null,
  latitude double precision not null,
  longitude double precision not null,
  accuracy_meters double precision not null,
  address_hint text not null default '',
  note text not null default '',
  device_claimed_at timestamp with time zone not null,
  captured_at timestamp with time zone not null,
  received_at timestamp with time zone not null default pg_catalog.clock_timestamp(),
  time_source text not null,
  time_verified boolean not null,
  time_anchor_issued_at timestamp with time zone,
  elapsed_since_anchor_ms bigint,
  sync_delay_seconds integer not null,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  time_token_digest text,
  photo_storage_key text not null,
  photo_sha256 text not null,
  photo_size_bytes integer not null,
  photo_mime_type text not null,

  constraint attendance_checkins_actor_idempotency_key
    unique (app_user_id, idempotency_key),
  constraint attendance_checkins_actor_day_sequence_key
    unique (app_user_id, business_date, sequence_in_day),
  constraint attendance_checkins_sequence_positive_check
    check (sequence_in_day >= 1),
  constraint attendance_checkins_latitude_check
    check (
      latitude not in (
        'NaN'::double precision,
        'Infinity'::double precision,
        '-Infinity'::double precision
      )
      and latitude >= -90.0
      and latitude <= 90.0
    ),
  constraint attendance_checkins_longitude_check
    check (
      longitude not in (
        'NaN'::double precision,
        'Infinity'::double precision,
        '-Infinity'::double precision
      )
      and longitude >= -180.0
      and longitude <= 180.0
    ),
  constraint attendance_checkins_accuracy_check
    check (
      accuracy_meters not in (
        'NaN'::double precision,
        'Infinity'::double precision,
        '-Infinity'::double precision
      )
      and accuracy_meters >= 0.0
    ),
  constraint attendance_checkins_address_hint_length_check
    check (pg_catalog.length(address_hint) <= 500),
  constraint attendance_checkins_note_length_check
    check (pg_catalog.length(note) <= 2000),
  constraint attendance_checkins_timestamps_finite_check
    check (
      device_claimed_at not in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone)
      and captured_at not in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone)
      and received_at not in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone)
    ),
  constraint attendance_checkins_future_timestamp_check
    check (
      captured_at <= received_at + interval '30 seconds'
      and device_claimed_at <= received_at + interval '30 seconds'
    ),
  constraint attendance_checkins_business_date_hcm_check
    check (business_date = (captured_at at time zone 'Asia/Ho_Chi_Minh')::date),
  constraint attendance_checkins_sync_delay_check
    check (sync_delay_seconds >= 0),
  constraint attendance_checkins_time_source_check
    check (time_source in ('SERVER_ANCHORED', 'DEVICE_CLOCK_UNVERIFIED')),
  constraint attendance_checkins_time_consistency_check
    check (
      (
        time_source = 'SERVER_ANCHORED'
        and time_verified = true
        and time_anchor_issued_at is not null
        and time_anchor_issued_at not in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone)
        and time_anchor_issued_at <= received_at + interval '30 seconds'
        and elapsed_since_anchor_ms is not null
        and elapsed_since_anchor_ms >= 0
        and elapsed_since_anchor_ms <= 86400000
        and time_token_digest is not null
        and captured_at = time_anchor_issued_at + (elapsed_since_anchor_ms * interval '1 millisecond')
        and received_at <= captured_at + interval '168 hours'
      )
      or
      (
        time_source = 'DEVICE_CLOCK_UNVERIFIED'
        and time_verified = false
        and time_anchor_issued_at is null
        and elapsed_since_anchor_ms is null
        and time_token_digest is null
        and captured_at = device_claimed_at
      )
    ),
  constraint attendance_checkins_request_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint attendance_checkins_time_token_digest_check
    check (time_token_digest is null or time_token_digest ~ '^[0-9a-f]{64}$'),
  constraint attendance_checkins_photo_storage_key_check
    check (pg_catalog.length(pg_catalog.btrim(photo_storage_key)) between 1 and 512),
  constraint attendance_checkins_photo_sha256_check
    check (photo_sha256 ~ '^[0-9a-f]{64}$'),
  constraint attendance_checkins_photo_size_bytes_check
    check (photo_size_bytes between 1 and 10485760),
  constraint attendance_checkins_photo_mime_type_check
    check (photo_mime_type = 'image/jpeg')
);

create index attendance_checkins_actor_captured_idx
  on public.attendance_checkins (app_user_id, captured_at desc, checkin_id desc);

alter table public.attendance_checkins enable row level security;
alter table public.attendance_checkins force row level security;

-- -----------------------------------------------------------------------------
-- 2. Append-only immutability trigger (`UPDATE` and `DELETE` forbidden).
-- -----------------------------------------------------------------------------
create or replace function public.attendance__internal_immutable_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  raise exception 'ATTENDANCE_CHECKINS_IMMUTABLE' using errcode = '55000';
end;
$function$;

create trigger attendance_checkins_immutable_guard
  before update or delete on public.attendance_checkins
  for each row execute function public.attendance__internal_immutable_guard();

-- -----------------------------------------------------------------------------
-- 3. Service-role-only check-in RPC (`public.attendance_record_checkin`).
-- -----------------------------------------------------------------------------
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
  v_sync_delay_seconds integer;
  v_sequence_in_day integer;
  v_daily_count integer;
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
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
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
  v_sync_delay_seconds := greatest(
    0,
    pg_catalog.floor(extract(epoch from (v_received_at - v_captured_at)))::integer
  );

  select coalesce(max(c.sequence_in_day), 0) + 1
    into v_sequence_in_day
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.business_date = v_business_date;

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
    photo_mime_type
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
    p_photo_mime_type
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

comment on function public.attendance_record_checkin(
  uuid, uuid, uuid, text, double precision, double precision, double precision, text, text, timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone
) is
  'Service-role-only Attendance WP1 check-in writer. Enforces server-bound actor mapping, per-actor advisory locking, Asia/Ho_Chi_Minh business_date, SERVER_ANCHORED (24h capture / 7d sync window) vs DEVICE_CLOCK_UNVERIFIED evidence, and idempotent replay/conflict.';

-- -----------------------------------------------------------------------------
-- 3b. Service-role-only idempotency lookup RPC (`public.attendance_lookup_checkin_idempotency`).
--     Allows pre-R2 / post-168h retries to replay an already-committed check-in or
--     raise IDEMPOTENCY_CONFLICT without uploading duplicate/orphan objects to R2.
-- -----------------------------------------------------------------------------
create or replace function public.attendance_lookup_checkin_idempotency(
  p_auth_subject uuid,
  p_app_user_id uuid,
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
  v_existing public.attendance_checkins%rowtype;
  v_daily_count integer;
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('attendance_checkin_v1'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  select *
    into v_existing
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.idempotency_key = p_idempotency_key;

  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  if v_existing.request_fingerprint <> p_request_fingerprint then
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
  end if;

  select count(*)::integer
    into v_daily_count
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.business_date = v_existing.business_date;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'checkin', pg_catalog.jsonb_build_object(
      'checkin_id', v_existing.checkin_id,
      'business_date', v_existing.business_date::text,
      'sequence_in_day', v_existing.sequence_in_day,
      'daily_count', v_daily_count,
      'captured_at', pg_catalog.to_char(v_existing.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'received_at', pg_catalog.to_char(v_existing.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'time_source', v_existing.time_source,
      'replayed', true
    )
  );
end;
$function$;

comment on function public.attendance_lookup_checkin_idempotency(
  uuid, uuid, uuid, text
) is
  'Service-role-only Attendance WP1 pre-write idempotency probe. Serializes per actor, replays committed check-ins even past the 168h sync window, and raises IDEMPOTENCY_CONFLICT on fingerprint mismatch.';

-- -----------------------------------------------------------------------------
-- 4. Owner alignment and helper privileges (`s0_t1c_runner` & `postgres` safe).
-- -----------------------------------------------------------------------------
do $align_attendance_wp1_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_checkin_table_owner_oid oid;
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
    into v_checkin_table_owner_oid
    from pg_catalog.pg_class c
   where c.oid = 'public.attendance_checkins'::pg_catalog.regclass;

  if v_checkin_table_owner_oid is distinct from v_base_owner_oid
     and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter table public.attendance_checkins owner to %I',
      v_base_owner
    );
  end if;

  foreach v_sig in array array[
    'public.attendance__internal_immutable_guard()',
    'public.attendance_lookup_checkin_idempotency(uuid,uuid,uuid,text)',
    'public.attendance_record_checkin(uuid,uuid,uuid,text,double precision,double precision,double precision,text,text,timestamp with time zone,text,timestamp with time zone,bigint,text,text,text,integer,text,timestamp with time zone)'
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
       'public.attendance_lookup_checkin_idempotency(uuid,uuid,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_record_checkin(uuid,uuid,uuid,text,double precision,double precision,double precision,text,text,timestamp with time zone,text,timestamp with time zone,bigint,text,text,text,integer,text,timestamp with time zone)'::pg_catalog.regprocedure
     )
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_mapping(uuid,uuid) to %I',
      v_owner
    );
  end loop;
end;
$align_attendance_wp1_owners$;

-- -----------------------------------------------------------------------------
-- 5. Strict table & function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on table public.attendance_checkins
  from public, anon, authenticated, service_role;

revoke all on function public.attendance__internal_immutable_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_lookup_checkin_idempotency(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.attendance_lookup_checkin_idempotency(
  uuid, uuid, uuid, text
) to service_role;

revoke all on function public.attendance_record_checkin(
  uuid, uuid, uuid, text, double precision, double precision, double precision, text, text, timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone
) from public, anon, authenticated, service_role;

grant execute on function public.attendance_record_checkin(
  uuid, uuid, uuid, text, double precision, double precision, double precision, text, text, timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone
) to service_role;

-- -----------------------------------------------------------------------------
-- 6. Data-free install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $check_attendance_wp1$
declare
  v_table constant pg_catalog.regclass := 'public.attendance_checkins'::pg_catalog.regclass;
  v_guard constant pg_catalog.regprocedure :=
    'public.attendance__internal_immutable_guard()'::pg_catalog.regprocedure;
  v_lookup_rpc constant pg_catalog.regprocedure :=
    'public.attendance_lookup_checkin_idempotency(uuid,uuid,uuid,text)'::pg_catalog.regprocedure;
  v_rpc constant pg_catalog.regprocedure :=
    'public.attendance_record_checkin(uuid,uuid,uuid,text,double precision,double precision,double precision,text,text,timestamp with time zone,text,timestamp with time zone,bigint,text,text,text,integer,text,timestamp with time zone)'::pg_catalog.regprocedure;
  v_target_rpc pg_catalog.regprocedure;
  v_need_insert boolean;
  v_rls boolean;
  v_force_rls boolean;
  v_policy_count integer;
  v_exposed_table_acl integer;
  v_secdef boolean;
  v_config text;
  v_owner_bypasses_rls boolean;
  v_owner_table_privs boolean;
  v_owner_helper_exec boolean;
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
   where c.oid = v_table;

  if not coalesce(v_rls, false)
     or not coalesce(v_force_rls, false)
     or coalesce(v_policy_count, -1) <> 0
     or coalesce(v_exposed_table_acl, -1) <> 0
     or pg_catalog.has_table_privilege('public', v_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_table_privilege('anon', v_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_table_privilege('authenticated', v_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_table_privilege('service_role', v_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    raise exception 'Attendance WP1 table RLS/ACL boundary drift on public.attendance_checkins'
      using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('public', v_guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_guard, 'EXECUTE')
     or exists (
       select 1
         from pg_catalog.aclexplode(coalesce(
           (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_guard),
           pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_guard))
         )) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'
     ) then
    raise exception 'Attendance WP1 internal trigger guard must stay revoked from all runtime roles'
      using errcode = '55000';
  end if;

  foreach v_target_rpc in array array[v_lookup_rpc, v_rpc]
  loop
    v_need_insert := (v_target_rpc = v_rpc);
    select p.prosecdef,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           (r.rolsuper or r.rolbypassrls),
           (
             pg_catalog.has_table_privilege(p.proowner, v_table, 'SELECT')
             and (not v_need_insert or pg_catalog.has_table_privilege(p.proowner, v_table, 'INSERT'))
             and pg_catalog.has_table_privilege(p.proowner, 'public.direct_entry_app_users'::pg_catalog.regclass, 'SELECT')
           ),
           pg_catalog.has_function_privilege(
             p.proowner,
             'public.direct_entry_assert_actor_mapping(uuid,uuid)'::pg_catalog.regprocedure,
             'EXECUTE'
           )
      into v_secdef, v_config, v_owner_bypasses_rls, v_owner_table_privs, v_owner_helper_exec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_target_rpc;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or not coalesce(v_owner_bypasses_rls, false)
       or not coalesce(v_owner_table_privs, false)
       or not coalesce(v_owner_helper_exec, false) then
      raise exception 'Attendance WP1 RPC security definer owner/RLS/search_path drift on %', v_target_rpc
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
      raise exception 'Attendance WP1 RPC EXECUTE ACL drift on %', v_target_rpc
        using errcode = '55000';
    end if;
  end loop;
end;
$check_attendance_wp1$;

commit;
