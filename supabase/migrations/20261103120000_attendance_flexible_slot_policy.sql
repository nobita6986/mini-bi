-- =============================================================================
-- Migration: 20261103120000_attendance_flexible_slot_policy.sql
-- Purpose:
--   1. Upgrade `public.attendance_slot_policy_versions` from fixed 4-slot
--      columns to flexible `slots jsonb` (1..12 slots in strictly increasing
--      HH:MM order, each with slot_index, slot_code, slot_label, session_code,
--      target_time, grace_before_minutes, grace_after_minutes).
--   2. Seed / upgrade untouched initial default policy (version 1) to 5 slots
--      in Asia/Ho_Chi_Minh:
--        - Time 1: 07:30 (±15m)
--        - Time 2: 10:00 (±15m)
--        - Time 3: 13:00 (±15m)
--        - Time 4: 15:00 (±15m)
--        - Time 5: 16:30 (±15m)
--      while preserving any policy version created or customized by an Admin.
--   3. Add flexible `public.attendance_create_slot_policy_admin(uuid, uuid, date, jsonb, integer, uuid, text)`
--      and keep the 18-parameter overload as a backward-compatible wrapper.
--   4. Upgrade `public.attendance_get_slot_policies_admin` and
--      `public.attendance_monthly_matrix_report` to expand slots dynamically
--      from the effective policy for each business day without hardcoding 4 or 5 slots.
-- =============================================================================

begin;

-- =============================================================================
-- SECTION 1: Internal Slot JSONB Validator & Normalizer
-- =============================================================================

create or replace function public.attendance__internal_validate_slots_jsonb(
  p_slots jsonb
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_elem jsonb;
  v_ord integer;
  v_slot_index integer;
  v_slot_code text;
  v_slot_label text;
  v_session_code text;
  v_target_time text;
  v_prev_time text := null;
  v_grace_before integer;
  v_grace_after integer;
begin
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    return false;
  end if;

  if jsonb_array_length(p_slots) < 1 or jsonb_array_length(p_slots) > 12 then
    return false;
  end if;

  for v_elem, v_ord in
    select elem, ord::integer
      from jsonb_array_elements(p_slots) with ordinality as t(elem, ord)
  loop
    if jsonb_typeof(v_elem) <> 'object' then
      return false;
    end if;

    if jsonb_typeof(v_elem->'slot_index') <> 'number'
       or (v_elem->>'slot_index') !~ '^[0-9]+$' then
      return false;
    end if;
    v_slot_index := (v_elem->>'slot_index')::integer;
    if v_slot_index is distinct from v_ord then
      return false;
    end if;

    v_slot_code := v_elem->>'slot_code';
    if v_slot_code is distinct from ('SLOT_' || v_ord::text) then
      return false;
    end if;

    v_slot_label := btrim(coalesce(v_elem->>'slot_label', ''));
    if v_slot_label = ''
       or char_length(v_slot_label) > 64
       or v_slot_label ~ '[\x00-\x1F\x7F]' then
      return false;
    end if;

    v_target_time := v_elem->>'target_time';
    if v_target_time is null
       or v_target_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      return false;
    end if;

    if v_prev_time is not null and v_prev_time >= v_target_time then
      return false;
    end if;
    v_prev_time := v_target_time;

    v_session_code := v_elem->>'session_code';
    if v_session_code is null or v_session_code not in ('AM', 'PM') then
      return false;
    end if;
    if (v_session_code = 'AM' and v_target_time >= '12:00')
       or (v_session_code = 'PM' and v_target_time < '12:00') then
      return false;
    end if;

    if jsonb_typeof(v_elem->'grace_before_minutes') <> 'number'
       or (v_elem->>'grace_before_minutes') !~ '^[0-9]+$' then
      return false;
    end if;
    v_grace_before := (v_elem->>'grace_before_minutes')::integer;
    if v_grace_before < 0 or v_grace_before > 240 then
      return false;
    end if;

    if jsonb_typeof(v_elem->'grace_after_minutes') <> 'number'
       or (v_elem->>'grace_after_minutes') !~ '^[0-9]+$' then
      return false;
    end if;
    v_grace_after := (v_elem->>'grace_after_minutes')::integer;
    if v_grace_after < 0 or v_grace_after > 240 then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function public.attendance__internal_normalize_slots_jsonb(
  p_slots jsonb
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb := '[]'::jsonb;
  v_elem jsonb;
  v_ord integer;
  v_target_time text;
  v_slot_label text;
  v_grace_before jsonb;
  v_grace_after jsonb;
begin
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    return null;
  end if;

  for v_elem, v_ord in
    select elem, ord::integer
      from jsonb_array_elements(p_slots) with ordinality as t(elem, ord)
  loop
    if jsonb_typeof(v_elem) <> 'object' then
      return null;
    end if;

    v_target_time := btrim(coalesce(v_elem->>'target_time', ''));
    v_slot_label := coalesce(
      nullif(btrim(coalesce(v_elem->>'slot_label', '')), ''),
      'Time ' || v_ord::text
    );
    v_grace_before := v_elem->'grace_before_minutes';
    v_grace_after := v_elem->'grace_after_minutes';

    v_result := v_result || jsonb_build_array(
      jsonb_build_object(
        'slot_index', v_ord,
        'slot_code', 'SLOT_' || v_ord::text,
        'slot_label', v_slot_label,
        'session_code', case when v_target_time < '12:00' then 'AM' else 'PM' end,
        'target_time', v_target_time,
        'grace_before_minutes', v_grace_before,
        'grace_after_minutes', v_grace_after
      )
    );
  end loop;

  return v_result;
end;
$$;

-- =============================================================================
-- SECTION 2: Upgrade `public.attendance_slot_policy_versions` & Seed 5 Slots
-- =============================================================================

alter table public.attendance_slot_policy_versions
  disable trigger attendance_slot_policy_versions_immutable_tg;

alter table public.attendance_slot_policy_versions
  drop constraint if exists attendance_slot_policy_chronological_check,
  alter column slot_1_time drop not null,
  alter column slot_1_grace_before_minutes drop not null,
  alter column slot_1_grace_after_minutes drop not null,
  alter column slot_2_time drop not null,
  alter column slot_2_grace_before_minutes drop not null,
  alter column slot_2_grace_after_minutes drop not null,
  alter column slot_3_time drop not null,
  alter column slot_3_grace_before_minutes drop not null,
  alter column slot_3_grace_after_minutes drop not null,
  alter column slot_4_time drop not null,
  alter column slot_4_grace_before_minutes drop not null,
  alter column slot_4_grace_after_minutes drop not null,
  add column if not exists slots jsonb;

-- Backfill `slots` for all existing rows (preserving any Admin-created versions)
update public.attendance_slot_policy_versions
   set slots = jsonb_build_array(
     jsonb_build_object(
       'slot_index', 1,
       'slot_code', 'SLOT_1',
       'slot_label', 'Time 1',
       'session_code', case when coalesce(slot_1_time, '08:00') < '12:00' then 'AM' else 'PM' end,
       'target_time', coalesce(slot_1_time, '08:00'),
       'grace_before_minutes', coalesce(slot_1_grace_before_minutes, 15),
       'grace_after_minutes', coalesce(slot_1_grace_after_minutes, 15)
     ),
     jsonb_build_object(
       'slot_index', 2,
       'slot_code', 'SLOT_2',
       'slot_label', 'Time 2',
       'session_code', case when coalesce(slot_2_time, '11:00') < '12:00' then 'AM' else 'PM' end,
       'target_time', coalesce(slot_2_time, '11:00'),
       'grace_before_minutes', coalesce(slot_2_grace_before_minutes, 15),
       'grace_after_minutes', coalesce(slot_2_grace_after_minutes, 15)
     ),
     jsonb_build_object(
       'slot_index', 3,
       'slot_code', 'SLOT_3',
       'slot_label', 'Time 3',
       'session_code', case when coalesce(slot_3_time, '13:00') < '12:00' then 'AM' else 'PM' end,
       'target_time', coalesce(slot_3_time, '13:00'),
       'grace_before_minutes', coalesce(slot_3_grace_before_minutes, 15),
       'grace_after_minutes', coalesce(slot_3_grace_after_minutes, 15)
     ),
     jsonb_build_object(
       'slot_index', 4,
       'slot_code', 'SLOT_4',
       'slot_label', 'Time 4',
       'session_code', case when coalesce(slot_4_time, '17:00') < '12:00' then 'AM' else 'PM' end,
       'target_time', coalesce(slot_4_time, '17:00'),
       'grace_before_minutes', coalesce(slot_4_grace_before_minutes, 15),
       'grace_after_minutes', coalesce(slot_4_grace_after_minutes, 15)
     )
   )
 where slots is null;

-- Upgrade untouched Stage 1 system default (version 1) to the 5-slot default
-- ONLY when no Admin has created or customized any policy version.
update public.attendance_slot_policy_versions
   set slot_1_time = '07:30',
       slot_1_grace_before_minutes = 15,
       slot_1_grace_after_minutes = 15,
       slot_2_time = '10:00',
       slot_2_grace_before_minutes = 15,
       slot_2_grace_after_minutes = 15,
       slot_3_time = '13:00',
       slot_3_grace_before_minutes = 15,
       slot_3_grace_after_minutes = 15,
       slot_4_time = '15:00',
       slot_4_grace_before_minutes = 15,
       slot_4_grace_after_minutes = 15,
       slots = jsonb_build_array(
         jsonb_build_object(
           'slot_index', 1,
           'slot_code', 'SLOT_1',
           'slot_label', 'Time 1',
           'session_code', 'AM',
           'target_time', '07:30',
           'grace_before_minutes', 15,
           'grace_after_minutes', 15
         ),
         jsonb_build_object(
           'slot_index', 2,
           'slot_code', 'SLOT_2',
           'slot_label', 'Time 2',
           'session_code', 'AM',
           'target_time', '10:00',
           'grace_before_minutes', 15,
           'grace_after_minutes', 15
         ),
         jsonb_build_object(
           'slot_index', 3,
           'slot_code', 'SLOT_3',
           'slot_label', 'Time 3',
           'session_code', 'PM',
           'target_time', '13:00',
           'grace_before_minutes', 15,
           'grace_after_minutes', 15
         ),
         jsonb_build_object(
           'slot_index', 4,
           'slot_code', 'SLOT_4',
           'slot_label', 'Time 4',
           'session_code', 'PM',
           'target_time', '15:00',
           'grace_before_minutes', 15,
           'grace_after_minutes', 15
         ),
         jsonb_build_object(
           'slot_index', 5,
           'slot_code', 'SLOT_5',
           'slot_label', 'Time 5',
           'session_code', 'PM',
           'target_time', '16:30',
           'grace_before_minutes', 15,
           'grace_after_minutes', 15
         )
       )
 where version = 1
   and configured_by_user_id is null
   and effective_from_date = date '2000-01-01'
   and slot_1_time = '08:00'
   and slot_2_time = '11:00'
   and slot_3_time = '13:00'
   and slot_4_time = '17:00'
   and slot_1_grace_before_minutes = 15
   and slot_1_grace_after_minutes = 15
   and slot_2_grace_before_minutes = 15
   and slot_2_grace_after_minutes = 15
   and slot_3_grace_before_minutes = 15
   and slot_3_grace_after_minutes = 15
   and slot_4_grace_before_minutes = 15
   and slot_4_grace_after_minutes = 15
   and not exists (
     select 1
       from public.attendance_slot_policy_versions as other_ver
      where other_ver.version > 1
         or other_ver.configured_by_user_id is not null
   );

-- Ensure initial 5-slot seed exists on fresh installs if table was empty
insert into public.attendance_slot_policy_versions (
  version,
  effective_from_date,
  slot_1_time,
  slot_1_grace_before_minutes,
  slot_1_grace_after_minutes,
  slot_2_time,
  slot_2_grace_before_minutes,
  slot_2_grace_after_minutes,
  slot_3_time,
  slot_3_grace_before_minutes,
  slot_3_grace_after_minutes,
  slot_4_time,
  slot_4_grace_before_minutes,
  slot_4_grace_after_minutes,
  slots,
  configured_by_user_id,
  configured_at,
  idempotency_key,
  request_fingerprint
)
values (
  1,
  date '2000-01-01',
  '07:30', 15, 15,
  '10:00', 15, 15,
  '13:00', 15, 15,
  '15:00', 15, 15,
  jsonb_build_array(
    jsonb_build_object(
      'slot_index', 1,
      'slot_code', 'SLOT_1',
      'slot_label', 'Time 1',
      'session_code', 'AM',
      'target_time', '07:30',
      'grace_before_minutes', 15,
      'grace_after_minutes', 15
    ),
    jsonb_build_object(
      'slot_index', 2,
      'slot_code', 'SLOT_2',
      'slot_label', 'Time 2',
      'session_code', 'AM',
      'target_time', '10:00',
      'grace_before_minutes', 15,
      'grace_after_minutes', 15
    ),
    jsonb_build_object(
      'slot_index', 3,
      'slot_code', 'SLOT_3',
      'slot_label', 'Time 3',
      'session_code', 'PM',
      'target_time', '13:00',
      'grace_before_minutes', 15,
      'grace_after_minutes', 15
    ),
    jsonb_build_object(
      'slot_index', 4,
      'slot_code', 'SLOT_4',
      'slot_label', 'Time 4',
      'session_code', 'PM',
      'target_time', '15:00',
      'grace_before_minutes', 15,
      'grace_after_minutes', 15
    ),
    jsonb_build_object(
      'slot_index', 5,
      'slot_code', 'SLOT_5',
      'slot_label', 'Time 5',
      'session_code', 'PM',
      'target_time', '16:30',
      'grace_before_minutes', 15,
      'grace_after_minutes', 15
    )
  ),
  null,
  timestamptz '2000-01-01 00:00:00+07',
  '00000000-0000-4000-8000-000000000001'::uuid,
  repeat('0', 64)
)
on conflict (version) do nothing;

alter table public.attendance_slot_policy_versions
  alter column slots set not null,
  drop constraint if exists attendance_slot_policy_slots_valid_check,
  add constraint attendance_slot_policy_slots_valid_check
    check (public.attendance__internal_validate_slots_jsonb(slots));

alter table public.attendance_slot_policy_versions
  enable trigger attendance_slot_policy_versions_immutable_tg;

-- =============================================================================
-- SECTION 3: Slot Policy Formatting Helper & Admin RPCs
-- =============================================================================

create or replace function public.attendance__internal_format_slot_policy(
  p_policy public.attendance_slot_policy_versions,
  p_effective_to_date date default null,
  p_actor_display_name text default null
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'version', p_policy.version,
    'effective_from_date', p_policy.effective_from_date::text,
    'effective_to_date', case
      when p_effective_to_date is not null then p_effective_to_date::text
      else null
    end,
    'configured_at', pg_catalog.to_char(
      p_policy.configured_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'configured_at_local', pg_catalog.to_char(
      p_policy.configured_at at time zone 'Asia/Ho_Chi_Minh',
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'configured_by_display_name', coalesce(p_actor_display_name, 'Mặc định hệ thống'),
    'slots', p_policy.slots
  );
$$;

create or replace function public.attendance_get_slot_policies_admin(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_can_manage boolean;
  v_today_vn date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_current_policy jsonb;
  v_latest_policy jsonb;
  v_versions jsonb;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  with policy_with_bounds as (
    select
      p as policy_row,
      p.version,
      p.effective_from_date,
      (
        lead(p.effective_from_date) over (
          order by p.effective_from_date asc, p.version asc
        ) - 1
      ) as effective_to_date,
      u.display_name as actor_display_name
    from public.attendance_slot_policy_versions p
    left join public.direct_entry_app_users u
      on u.app_user_id = p.configured_by_user_id
  )
  select
    (
      select public.attendance__internal_format_slot_policy(
        pb.policy_row,
        pb.effective_to_date,
        pb.actor_display_name
      )
      from policy_with_bounds pb
      where pb.effective_from_date <= v_today_vn
      order by pb.effective_from_date desc, pb.version desc
      limit 1
    ),
    (
      select public.attendance__internal_format_slot_policy(
        pb.policy_row,
        pb.effective_to_date,
        pb.actor_display_name
      )
      from policy_with_bounds pb
      order by pb.version desc
      limit 1
    ),
    coalesce(
      (
        select jsonb_agg(
          public.attendance__internal_format_slot_policy(
            pb.policy_row,
            pb.effective_to_date,
            pb.actor_display_name
          )
          order by pb.version desc
        )
        from policy_with_bounds pb
      ),
      '[]'::jsonb
    )
  into v_current_policy, v_latest_policy, v_versions;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_manage_slot_policy', v_can_manage
    ),
    'business_date', v_today_vn::text,
    'current_policy', v_current_policy,
    'latest_policy', v_latest_policy,
    'versions', v_versions
  );
end;
$$;

create or replace function public.attendance_create_slot_policy_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_effective_from_date date,
  p_slots jsonb,
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
  v_today_vn date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_normalized_slots jsonb;
  v_existing public.attendance_slot_policy_versions%rowtype;
  v_existing_effective_to date;
  v_latest public.attendance_slot_policy_versions%rowtype;
  v_saved public.attendance_slot_policy_versions%rowtype;
  v_actor_display_name text;
  v_changed_fields text[];
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_SLOT_POLICY_WRITE_DENIED'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_slot_policy_write'),
    0
  );

  select *
    into v_existing
  from public.attendance_slot_policy_versions p
  where p.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;

    select (min(p2.effective_from_date) - 1)
      into v_existing_effective_to
    from public.attendance_slot_policy_versions p2
    where p2.effective_from_date > v_existing.effective_from_date;

    select u.display_name
      into v_actor_display_name
    from public.direct_entry_app_users u
    where u.app_user_id = v_existing.configured_by_user_id;

    return jsonb_build_object(
      'replayed', true,
      'policy', public.attendance__internal_format_slot_policy(
        v_existing,
        v_existing_effective_to,
        v_actor_display_name
      )
    );
  end if;

  v_normalized_slots := public.attendance__internal_normalize_slots_jsonb(p_slots);

  if p_effective_from_date is null
     or p_effective_from_date in ('infinity'::date, '-infinity'::date)
     or p_effective_from_date < date '2000-01-01'
     or p_effective_from_date > date '2100-12-31'
     or p_expected_version is null
     or p_expected_version < 1
     or not public.attendance__internal_validate_slots_jsonb(v_normalized_slots) then
    raise exception 'ATTENDANCE_SLOT_POLICY_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_latest
  from public.attendance_slot_policy_versions p
  order by p.version desc
  limit 1
  for update;

  if not found or v_latest.version <> p_expected_version then
    raise exception 'ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if p_effective_from_date < v_today_vn then
    raise exception 'ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST'
      using errcode = '22023';
  end if;

  if p_effective_from_date <= v_latest.effective_from_date then
    raise exception 'ATTENDANCE_SLOT_POLICY_OVERLAP'
      using errcode = 'PT409';
  end if;

  insert into public.attendance_slot_policy_versions (
    version,
    effective_from_date,
    slot_1_time,
    slot_1_grace_before_minutes,
    slot_1_grace_after_minutes,
    slot_2_time,
    slot_2_grace_before_minutes,
    slot_2_grace_after_minutes,
    slot_3_time,
    slot_3_grace_before_minutes,
    slot_3_grace_after_minutes,
    slot_4_time,
    slot_4_grace_before_minutes,
    slot_4_grace_after_minutes,
    slots,
    configured_by_user_id,
    configured_at,
    idempotency_key,
    request_fingerprint
  )
  values (
    v_latest.version + 1,
    p_effective_from_date,
    v_normalized_slots #>> '{0,target_time}',
    (v_normalized_slots #>> '{0,grace_before_minutes}')::integer,
    (v_normalized_slots #>> '{0,grace_after_minutes}')::integer,
    v_normalized_slots #>> '{1,target_time}',
    (v_normalized_slots #>> '{1,grace_before_minutes}')::integer,
    (v_normalized_slots #>> '{1,grace_after_minutes}')::integer,
    v_normalized_slots #>> '{2,target_time}',
    (v_normalized_slots #>> '{2,grace_before_minutes}')::integer,
    (v_normalized_slots #>> '{2,grace_after_minutes}')::integer,
    v_normalized_slots #>> '{3,target_time}',
    (v_normalized_slots #>> '{3,grace_before_minutes}')::integer,
    (v_normalized_slots #>> '{3,grace_after_minutes}')::integer,
    v_normalized_slots,
    p_app_user_id,
    clock_timestamp(),
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_saved;

  select array_agg(val order by ord)
    into v_changed_fields
  from (
    select 1 as ord, 'version:' || v_saved.version::text as val
    union all
    select 2 as ord, 'effective_from_date:' || v_saved.effective_from_date::text as val
    union all
    select 3 as ord, 'slot_count:' || jsonb_array_length(v_saved.slots)::text as val
    union all
    select
      3 + (elem->>'slot_index')::integer as ord,
      (elem->>'slot_code') || ':' || (elem->>'slot_label') || '@' || (elem->>'target_time')
        || '(-' || (elem->>'grace_before_minutes') || '/+' || (elem->>'grace_after_minutes') || ')' as val
    from jsonb_array_elements(v_saved.slots) as elem
  ) as audit_items;

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
    p_auth_subject,
    p_app_user_id,
    'attendance_slot_policy_create',
    'entry_admin',
    'attendance_slot_policy:v' || v_saved.version::text,
    'all',
    'APPLIED',
    v_changed_fields
  );

  select u.display_name
    into v_actor_display_name
  from public.direct_entry_app_users u
  where u.app_user_id = p_app_user_id;

  return jsonb_build_object(
    'replayed', false,
    'policy', public.attendance__internal_format_slot_policy(
      v_saved,
      null,
      v_actor_display_name
    )
  );
end;
$$;

-- Keep 18-parameter overload as a backward-compatible wrapper delegating to the 7-parameter RPC
create or replace function public.attendance_create_slot_policy_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_effective_from_date date,
  p_slot_1_time text,
  p_slot_1_grace_before_minutes integer,
  p_slot_1_grace_after_minutes integer,
  p_slot_2_time text,
  p_slot_2_grace_before_minutes integer,
  p_slot_2_grace_after_minutes integer,
  p_slot_3_time text,
  p_slot_3_grace_before_minutes integer,
  p_slot_3_grace_after_minutes integer,
  p_slot_4_time text,
  p_slot_4_grace_before_minutes integer,
  p_slot_4_grace_after_minutes integer,
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
  v_slots jsonb;
begin
  v_slots := jsonb_build_array(
    jsonb_build_object(
      'slot_index', 1,
      'slot_code', 'SLOT_1',
      'slot_label', 'Time 1',
      'target_time', p_slot_1_time,
      'grace_before_minutes', p_slot_1_grace_before_minutes,
      'grace_after_minutes', p_slot_1_grace_after_minutes
    ),
    jsonb_build_object(
      'slot_index', 2,
      'slot_code', 'SLOT_2',
      'slot_label', 'Time 2',
      'target_time', p_slot_2_time,
      'grace_before_minutes', p_slot_2_grace_before_minutes,
      'grace_after_minutes', p_slot_2_grace_after_minutes
    ),
    jsonb_build_object(
      'slot_index', 3,
      'slot_code', 'SLOT_3',
      'slot_label', 'Time 3',
      'target_time', p_slot_3_time,
      'grace_before_minutes', p_slot_3_grace_before_minutes,
      'grace_after_minutes', p_slot_3_grace_after_minutes
    ),
    jsonb_build_object(
      'slot_index', 4,
      'slot_code', 'SLOT_4',
      'slot_label', 'Time 4',
      'target_time', p_slot_4_time,
      'grace_before_minutes', p_slot_4_grace_before_minutes,
      'grace_after_minutes', p_slot_4_grace_after_minutes
    )
  );

  return public.attendance_create_slot_policy_admin(
    p_auth_subject,
    p_app_user_id,
    p_effective_from_date,
    v_slots,
    p_expected_version,
    p_idempotency_key,
    p_request_fingerprint
  );
end;
$$;

-- =============================================================================
-- SECTION 4: Flexible-Slot Monthly Attendance Matrix Report RPC
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
  v_slot_policy jsonb := null;
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

  -- Slot policy summary (current policy on v_today_vn, latest policy, and policies active across the queried month)
  with policy_with_bounds as (
    select
      p as policy_row,
      p.version,
      p.effective_from_date,
      (
        lead(p.effective_from_date) over (
          order by p.effective_from_date asc, p.version asc
        ) - 1
      ) as effective_to_date,
      u.display_name as actor_display_name
    from public.attendance_slot_policy_versions p
    left join public.direct_entry_app_users u
      on u.app_user_id = p.configured_by_user_id
  ),
  month_active_versions as (
    select distinct on (pb.version)
      pb.*
    from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
    join lateral (
      select p2.*
      from policy_with_bounds p2
      where p2.effective_from_date <= cal.d::date
      order by p2.effective_from_date desc, p2.version desc
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
      where pb.effective_from_date <= v_today_vn
      order by pb.effective_from_date desc, pb.version desc
      limit 1
    ),
    'latest_policy', (
      select public.attendance__internal_format_slot_policy(
        pb.policy_row,
        pb.effective_to_date,
        pb.actor_display_name
      )
      from policy_with_bounds pb
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
        from month_active_versions mv
      ),
      '[]'::jsonb
    )
  )
    into v_slot_policy;

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

  -- Employee options scoped to month
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

  -- Set-based monthly matrix calculation with flexible N-slot assignment & leave session coverage
  with month_day_policies as (
    select
      cal.d::date as business_date,
      extract(day from cal.d)::integer as day_of_month,
      pol.version as policy_version,
      pol.slots as policy_slots
    from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
    join lateral (
      select p.*
      from public.attendance_slot_policy_versions p
      where p.effective_from_date <= cal.d::date
      order by p.effective_from_date desc, p.version desc
      limit 1
    ) pol on true
  ),
  month_day_slot_defs as (
    select
      mdp.business_date,
      mdp.day_of_month,
      mdp.policy_version,
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
      (slot_elem->>'grace_after_minutes')::integer as grace_after_minutes
    from month_day_policies mdp
    cross join lateral jsonb_array_elements(mdp.policy_slots) as slot_elem
  ),
  candidate_employees as (
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
  month_checkins_raw as (
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
  month_checkins_enriched as (
    select
      mcr.*,
      ns.policy_version,
      ns.slot_index as assigned_slot_index,
      ns.slot_code as assigned_slot_code,
      ns.target_time as assigned_slot_target_time,
      (mcr.local_minute_of_day - ns.target_minute)::integer as delta_minutes,
      case
        when (mcr.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then
          ((- (mcr.local_minute_of_day - ns.target_minute)) - ns.grace_before_minutes)::integer
        when (mcr.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then
          ((mcr.local_minute_of_day - ns.target_minute) - ns.grace_after_minutes)::integer
        else 0
      end as over_grace_minutes,
      case
        when (mcr.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then 'EARLY'
        when (mcr.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then 'LATE'
        else 'ON_TIME'
      end as deviation_status
    from month_checkins_raw mcr
    cross join lateral (
      select
        s.policy_version,
        s.slot_index,
        s.slot_code,
        s.target_time,
        s.target_minute,
        s.grace_before_minutes,
        s.grace_after_minutes
      from month_day_slot_defs s
      where s.business_date = mcr.business_date
      -- Deterministic tie-break: when equidistant between two adjacent slots, choose earlier slot (slot_index asc)
      order by abs(mcr.local_minute_of_day - s.target_minute) asc, s.slot_index asc
      limit 1
    ) ns
  ),
  daily_slot_checkins as (
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
  daily_checkins as (
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
  daily_leaves as (
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
                'id', mc2.checkin_id,
                'u', mc2.app_user_id,
                'd', mc2.business_date,
                'seq', mc2.sequence_in_day,
                't', mc2.captured_at_utc,
                'v', mc2.time_verified,
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
                'd', mdp2.business_date,
                'pv', mdp2.policy_version,
                'sl', mdp2.policy_slots
              )
              order by mdp2.business_date asc
            )::text
            from month_day_policies mdp2
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
            'business_date', mdp.business_date,
            'day_of_month', mdp.day_of_month,
            'policy_version_used', mdp.policy_version,
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
            end,
            'missing_slot_count', day_slots.missing_slot_count,
            'late_or_early_checkin_count', coalesce(dc.late_or_early_checkin_count, 0),
            'slots', day_slots.slots
          )
          order by mdp.business_date asc
        )
        from month_day_policies mdp
        left join daily_checkins dc
          on dc.app_user_id = pe.app_user_id
         and dc.business_date = mdp.business_date
        left join daily_leaves dl
          on dl.app_user_id = pe.app_user_id
         and dl.business_date = mdp.business_date
        cross join lateral (
          select
            count(*) filter (
              where coalesce(dsc.checkin_count, 0) = 0
                and not (
                  case
                    when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                    else coalesce(dl.pm_covered, false)
                  end
                )
            )::integer as missing_slot_count,
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
                    when coalesce(dsc.checkin_count, 0) > 0 and coalesce(dsc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
                    when coalesce(dsc.checkin_count, 0) > 0 then 'ON_TIME'
                    when (
                      case
                        when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                        else coalesce(dl.pm_covered, false)
                      end
                    ) then 'LEAVE_COVERED'
                    else 'MISSING'
                  end,
                  'checkins', coalesce(dsc.checkins, '[]'::jsonb)
                )
                order by mds.slot_index asc
              ),
              '[]'::jsonb
            ) as slots
          from month_day_slot_defs mds
          left join daily_slot_checkins dsc
            on dsc.app_user_id = pe.app_user_id
           and dsc.business_date = mdp.business_date
           and dsc.slot_index = mds.slot_index
          where mds.business_date = mdp.business_date
        ) day_slots
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

-- =============================================================================
-- SECTION 5: Owner Alignment, Strict ACLs & Helper Grants
-- =============================================================================

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
    raise exception 'ATTENDANCE_SLOT_POLICY_OWNER_RESOLUTION_FAILED';
  end if;

  for v_fn, v_proc_owner_oid in
    select p.oid::regprocedure, p.proowner
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.attendance__internal_validate_slots_jsonb(jsonb)'::pg_catalog.regprocedure,
       'public.attendance__internal_normalize_slots_jsonb(jsonb)'::pg_catalog.regprocedure,
       'public.attendance__internal_format_slot_policy(public.attendance_slot_policy_versions,date,text)'::pg_catalog.regprocedure,
       'public.attendance_get_slot_policies_admin(uuid,uuid)'::pg_catalog.regprocedure,
       'public.attendance_create_slot_policy_admin(uuid,uuid,date,jsonb,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_create_slot_policy_admin(uuid,uuid,date,text,integer,integer,text,integer,integer,text,integer,integer,text,integer,integer,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure
     )
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;
end;
$owner_align$;

revoke all on function public.attendance__internal_validate_slots_jsonb(jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance__internal_normalize_slots_jsonb(jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance__internal_format_slot_policy(
  public.attendance_slot_policy_versions,
  date,
  text
)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_get_slot_policies_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_get_slot_policies_admin(uuid, uuid)
  to service_role;

revoke all on function public.attendance_create_slot_policy_admin(
  uuid,
  uuid,
  date,
  jsonb,
  integer,
  uuid,
  text
)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_create_slot_policy_admin(
  uuid,
  uuid,
  date,
  jsonb,
  integer,
  uuid,
  text
)
  to service_role;

revoke all on function public.attendance_create_slot_policy_admin(
  uuid,
  uuid,
  date,
  text,
  integer,
  integer,
  text,
  integer,
  integer,
  text,
  integer,
  integer,
  text,
  integer,
  integer,
  integer,
  uuid,
  text
)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_create_slot_policy_admin(
  uuid,
  uuid,
  date,
  text,
  integer,
  integer,
  text,
  integer,
  integer,
  text,
  integer,
  integer,
  text,
  integer,
  integer,
  integer,
  uuid,
  text
)
  to service_role;

revoke all on function public.attendance_monthly_matrix_report(
  uuid,
  uuid,
  text,
  uuid,
  uuid,
  text,
  integer,
  integer
)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_monthly_matrix_report(
  uuid,
  uuid,
  text,
  uuid,
  uuid,
  text,
  integer,
  integer
)
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
    'grant select, insert on table public.attendance_slot_policy_versions to %I',
    v_base_owner
  );

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.attendance__internal_validate_slots_jsonb(jsonb)'::pg_catalog.regprocedure,
       'public.attendance__internal_normalize_slots_jsonb(jsonb)'::pg_catalog.regprocedure,
       'public.attendance__internal_format_slot_policy(public.attendance_slot_policy_versions,date,text)'::pg_catalog.regprocedure,
       'public.attendance_get_slot_policies_admin(uuid,uuid)'::pg_catalog.regprocedure,
       'public.attendance_create_slot_policy_admin(uuid,uuid,date,jsonb,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_create_slot_policy_admin(uuid,uuid,date,text,integer,integer,text,integer,integer,text,integer,integer,text,integer,integer,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure
     )
  loop
    for v_helper_fn in
      select p.oid::pg_catalog.regprocedure
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in (
           'attendance__internal_immutable_guard',
           'attendance__internal_assert_report_reader',
           'attendance__internal_validate_slots_jsonb',
           'attendance__internal_normalize_slots_jsonb',
           'attendance__internal_format_slot_policy',
           'direct_entry_assert_actor_mapping',
           'direct_entry_assert_actor_app_user_admin',
           'direct_entry_has_capability',
           'direct_entry_has_scope',
           'direct_entry_authorization_date'
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
