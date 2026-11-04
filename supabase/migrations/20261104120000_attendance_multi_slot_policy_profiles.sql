-- =============================================================================
-- Migration: 20261104120000_attendance_multi_slot_policy_profiles.sql
-- Purpose:
--   1. Introduce named slot policy profiles (`public.attendance_slot_policy_profiles`)
--      with the system default profile `'00000000-0000-4000-8000-000000000001'::uuid`
--      (`profile_code = 'DEFAULT'`, `display_name = 'Mặc định'`, `is_default = true`).
--   2. Scope `public.attendance_slot_policy_versions` by `profile_id` while
--      preserving all existing versions as the history of the Default profile.
--   3. Introduce employee slot policy assignments (`public.attendance_slot_policy_assignments`)
--      keyed by `app_user_id` with immediate effect, no future dates, and full
--      historical retention so past report dates never change retroactively when
--      an employee switches or unassigns profiles.
--   4. Upgrade `attendance_get_slot_policies_admin`, `attendance_create_slot_policy_admin`,
--      `attendance_upsert_slot_policy_profile_admin`,
--      `attendance_assign_employee_slot_policy_admin`,
--      `attendance_unassign_employee_slot_policy_admin`,
--      `attendance_monthly_matrix_report`, and Wave 2 Attendance Explanations
--      to evaluate per-employee, per-day slot policies.
-- =============================================================================

begin;

-- =============================================================================
-- SECTION 1: Named Slot Policy Profiles & Version History Scoping
-- =============================================================================

create table if not exists public.attendance_slot_policy_profiles (
  profile_id uuid primary key default gen_random_uuid(),
  profile_code text not null
    constraint attendance_slot_policy_profiles_code_check
    check (profile_code ~ '^[A-Z0-9][A-Z0-9._:-]{0,63}$'),
  display_name text not null
    constraint attendance_slot_policy_profiles_name_check
    check (
      char_length(btrim(display_name)) between 1 and 128
      and display_name !~ '[\x00-\x1F\x7F]'
    ),
  description text not null default ''
    constraint attendance_slot_policy_profiles_desc_check
    check (
      char_length(description) <= 500
      and description !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  is_default boolean not null default false,
  active boolean not null default true
    constraint attendance_slot_policy_profiles_default_active_check
    check (not is_default or active = true),
  version integer not null default 1
    constraint attendance_slot_policy_profiles_version_check
    check (version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  last_idempotency_key uuid null unique,
  last_request_fingerprint text null
    constraint attendance_slot_policy_profiles_fingerprint_check
    check (
      last_request_fingerprint is null
      or last_request_fingerprint ~ '^[0-9a-f]{64}$'
    )
);

create unique index if not exists attendance_slot_policy_profiles_code_uk
  on public.attendance_slot_policy_profiles (profile_code);

create unique index if not exists attendance_slot_policy_profiles_name_lower_uk
  on public.attendance_slot_policy_profiles (lower(btrim(display_name)));

create unique index if not exists attendance_slot_policy_profiles_default_uk
  on public.attendance_slot_policy_profiles (is_default)
  where is_default = true;

insert into public.attendance_slot_policy_profiles (
  profile_id,
  profile_code,
  display_name,
  description,
  is_default,
  active,
  version,
  created_at,
  updated_at,
  updated_by_user_id
)
values (
  '00000000-0000-4000-8000-000000000001'::uuid,
  'DEFAULT',
  'Mặc định',
  'Cấu hình khung giờ chấm công mặc định của hệ thống',
  true,
  true,
  1,
  timestamptz '2000-01-01 00:00:00+07',
  timestamptz '2000-01-01 00:00:00+07',
  null
)
on conflict (profile_id) do nothing;

alter table public.attendance_slot_policy_profiles enable row level security;
alter table public.attendance_slot_policy_profiles force row level security;
revoke all on table public.attendance_slot_policy_profiles
  from public, anon, authenticated, service_role;

-- Upgrade `public.attendance_slot_policy_versions` to scope versions per profile
alter table public.attendance_slot_policy_versions
  disable trigger attendance_slot_policy_versions_immutable_tg;

alter table public.attendance_slot_policy_versions
  add column if not exists profile_id uuid
    references public.attendance_slot_policy_profiles(profile_id) on delete restrict;

update public.attendance_slot_policy_versions
   set profile_id = '00000000-0000-4000-8000-000000000001'::uuid
 where profile_id is null;

alter table public.attendance_slot_policy_versions
  alter column profile_id set default '00000000-0000-4000-8000-000000000001'::uuid,
  alter column profile_id set not null;

do $drop_legacy_policy_uk$
declare
  v_con name;
begin
  for v_con in
    select c.conname
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.attendance_slot_policy_versions'::pg_catalog.regclass
       and c.contype = 'u'
       and c.conname in (
         'attendance_slot_policy_versions_version_key',
         'attendance_slot_policy_versions_effective_from_date_key'
       )
  loop
    execute pg_catalog.format(
      'alter table public.attendance_slot_policy_versions drop constraint if exists %I',
      v_con
    );
  end loop;
end;
$drop_legacy_policy_uk$;

alter table public.attendance_slot_policy_versions
  drop constraint if exists attendance_slot_policy_versions_profile_version_uk,
  add constraint attendance_slot_policy_versions_profile_version_uk
    unique (profile_id, version),
  drop constraint if exists attendance_slot_policy_versions_profile_effective_from_uk,
  add constraint attendance_slot_policy_versions_profile_effective_from_uk
    unique (profile_id, effective_from_date),
  drop constraint if exists attendance_slot_policy_actor_check,
  add constraint attendance_slot_policy_actor_check check (
    (
      profile_id = '00000000-0000-4000-8000-000000000001'::uuid
      and version = 1
      and configured_by_user_id is null
    )
    or configured_by_user_id is not null
  );

create index if not exists attendance_slot_policy_versions_profile_effective_idx
  on public.attendance_slot_policy_versions (profile_id, effective_from_date desc, version desc);

alter table public.attendance_slot_policy_versions
  enable trigger attendance_slot_policy_versions_immutable_tg;

-- =============================================================================
-- SECTION 2: Employee Slot Policy Assignments & Explanation Profile Snapshot
-- =============================================================================

create table if not exists public.attendance_slot_policy_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  profile_id uuid not null
    references public.attendance_slot_policy_profiles(profile_id) on delete restrict,
  valid_from date not null,
  valid_to date null,
  superseded_same_day boolean not null default false,
  version integer not null default 1
    constraint attendance_slot_policy_assignments_version_check
    check (version >= 1),
  assigned_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  assigned_at timestamptz not null default clock_timestamp(),
  revoked_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  revoked_at timestamptz null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  idempotency_key uuid not null unique,
  request_fingerprint text not null
    constraint attendance_slot_policy_assignments_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  revoke_idempotency_key uuid null unique,
  revoke_request_fingerprint text null
    constraint attendance_slot_policy_assignments_revoke_fingerprint_check
    check (
      revoke_request_fingerprint is null
      or revoke_request_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  constraint attendance_slot_policy_assignments_range_check
    check (valid_to is null or valid_to >= valid_from),
  constraint attendance_slot_policy_assignments_superseded_check
    check (
      not superseded_same_day
      or (valid_to is not null and valid_to = valid_from and revoked_at is not null)
    )
);

create unique index if not exists attendance_slot_policy_assignments_open_user_uk
  on public.attendance_slot_policy_assignments (app_user_id)
  where valid_to is null;

create index if not exists attendance_slot_policy_assignments_user_dates_idx
  on public.attendance_slot_policy_assignments (app_user_id, valid_from desc, valid_to)
  where not superseded_same_day;

create index if not exists attendance_slot_policy_assignments_profile_idx
  on public.attendance_slot_policy_assignments (profile_id, valid_from desc);

create or replace function public.attendance__internal_slot_policy_assignment_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.valid_to is not null and new.valid_to < new.valid_from then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_RANGE_INVALID'
      using errcode = '22023';
  end if;

  if not coalesce(new.superseded_same_day, false) then
    perform 1
      from public.attendance_slot_policy_assignments a
     where a.app_user_id = new.app_user_id
       and a.assignment_id <> new.assignment_id
       and not a.superseded_same_day
       and daterange(a.valid_from, coalesce(a.valid_to, 'infinity'::date), '[]')
        && daterange(new.valid_from, coalesce(new.valid_to, 'infinity'::date), '[]');

    if found then
      raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP'
        using errcode = 'PT409';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.attendance__internal_slot_policy_assignment_no_overlap()
  from public, anon, authenticated, service_role;

drop trigger if exists attendance_slot_policy_assignments_no_overlap_trg
  on public.attendance_slot_policy_assignments;

create trigger attendance_slot_policy_assignments_no_overlap_trg
before insert or update on public.attendance_slot_policy_assignments
for each row
execute function public.attendance__internal_slot_policy_assignment_no_overlap();

alter table public.attendance_slot_policy_assignments enable row level security;
alter table public.attendance_slot_policy_assignments force row level security;
revoke all on table public.attendance_slot_policy_assignments
  from public, anon, authenticated, service_role;

-- Add profile snapshot columns to `public.attendance_explanations`
alter table public.attendance_explanations
  add column if not exists policy_profile_id_used uuid not null
    default '00000000-0000-4000-8000-000000000001'::uuid
    references public.attendance_slot_policy_profiles(profile_id) on delete restrict,
  add column if not exists policy_profile_code_used text not null
    default 'DEFAULT',
  add column if not exists policy_profile_name_used text not null
    default 'Mặc định';

-- =============================================================================
-- SECTION 3: Internal Helpers for Profile & Policy Resolution
-- =============================================================================

create or replace function public.attendance__internal_format_slot_policy(
  p_policy public.attendance_slot_policy_versions,
  p_effective_to_date date default null,
  p_actor_display_name text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_profile public.attendance_slot_policy_profiles%rowtype;
begin
  select *
    into v_profile
  from public.attendance_slot_policy_profiles pr
  where pr.profile_id = coalesce(
    p_policy.profile_id,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

  return jsonb_build_object(
    'profile_id', coalesce(v_profile.profile_id, '00000000-0000-4000-8000-000000000001'::uuid),
    'profile_code', coalesce(v_profile.profile_code, 'DEFAULT'),
    'profile_name', coalesce(v_profile.display_name, 'Mặc định'),
    'is_default', coalesce(v_profile.is_default, true),
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
end;
$$;

create or replace function public.attendance__internal_resolve_employee_slot_policy(
  p_app_user_id uuid,
  p_business_date date
)
returns table (
  profile_id uuid,
  profile_code text,
  profile_name text,
  is_default boolean,
  assignment_id uuid,
  assignment_valid_from date,
  assignment_valid_to date,
  policy_version integer,
  policy_effective_from_date date,
  slots jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_default_profile_id constant uuid := '00000000-0000-4000-8000-000000000001'::uuid;
  v_assign public.attendance_slot_policy_assignments%rowtype;
  v_profile public.attendance_slot_policy_profiles%rowtype;
  v_policy public.attendance_slot_policy_versions%rowtype;
begin
  select a.*
    into v_assign
  from public.attendance_slot_policy_assignments a
  where a.app_user_id = p_app_user_id
    and not a.superseded_same_day
    and a.valid_from <= p_business_date
    and (a.valid_to is null or p_business_date <= a.valid_to)
  order by a.valid_from desc, a.assigned_at desc, a.assignment_id desc
  limit 1;

  if found then
    select pr.*
      into v_profile
    from public.attendance_slot_policy_profiles pr
    where pr.profile_id = v_assign.profile_id;
  end if;

  if v_profile.profile_id is null then
    select pr.*
      into v_profile
    from public.attendance_slot_policy_profiles pr
    where pr.profile_id = v_default_profile_id;
  end if;

  select pv.*
    into v_policy
  from public.attendance_slot_policy_versions pv
  where pv.profile_id = v_profile.profile_id
    and pv.effective_from_date <= p_business_date
  order by pv.effective_from_date desc, pv.version desc
  limit 1;

  if not found then
    select pv.*
      into v_policy
    from public.attendance_slot_policy_versions pv
    where pv.profile_id = v_profile.profile_id
    order by pv.version asc
    limit 1;
  end if;

  if not found then
    select pv.*
      into v_policy
    from public.attendance_slot_policy_versions pv
    where pv.profile_id = v_default_profile_id
    order by pv.effective_from_date desc, pv.version desc
    limit 1;
  end if;

  return query
  select
    v_profile.profile_id,
    v_profile.profile_code,
    v_profile.display_name,
    v_profile.is_default,
    v_assign.assignment_id,
    v_assign.valid_from,
    v_assign.valid_to,
    v_policy.version,
    v_policy.effective_from_date,
    v_policy.slots;
end;
$$;

-- =============================================================================
-- SECTION 4: Slot Policy Profile & Assignment Admin RPCs
-- =============================================================================

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
  v_default_profile_id constant uuid := '00000000-0000-4000-8000-000000000001'::uuid;
  v_can_manage boolean;
  v_today_vn date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_default_profile public.attendance_slot_policy_profiles%rowtype;
  v_current_policy jsonb;
  v_latest_policy jsonb;
  v_versions jsonb;
  v_profiles jsonb;
  v_assignments jsonb;
  v_employee_options jsonb;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  select pr.*
    into v_default_profile
  from public.attendance_slot_policy_profiles pr
  where pr.profile_id = v_default_profile_id;

  with policy_with_bounds as (
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
    left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident
      on u.app_user_id is not null
  )
  select
    (
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
    (
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
        where pb.profile_id = v_default_profile_id
      ),
      '[]'::jsonb
    ),
    coalesce(
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
            'active_assignment_count', coalesce((
              select count(*)::integer
              from public.attendance_slot_policy_assignments a
              where a.profile_id = pr.profile_id
                and not a.superseded_same_day
                and a.valid_from <= v_today_vn
                and (a.valid_to is null or v_today_vn <= a.valid_to)
            ), 0),
            'current_policy', (
              select public.attendance__internal_format_slot_policy(
                pb_cur.policy_row,
                pb_cur.effective_to_date,
                pb_cur.actor_display_name
              )
              from policy_with_bounds pb_cur
              where pb_cur.profile_id = pr.profile_id
              order by (pb_cur.effective_from_date <= v_today_vn) desc, pb_cur.effective_from_date desc, pb_cur.version desc
              limit 1
            ),
            'latest_policy', (
              select public.attendance__internal_format_slot_policy(
                pb_lat.policy_row,
                pb_lat.effective_to_date,
                pb_lat.actor_display_name
              )
              from policy_with_bounds pb_lat
              where pb_lat.profile_id = pr.profile_id
              order by pb_lat.version desc
              limit 1
            ),
            'versions', coalesce((
              select jsonb_agg(
                public.attendance__internal_format_slot_policy(
                  pb_all.policy_row,
                  pb_all.effective_to_date,
                  pb_all.actor_display_name
                )
                order by pb_all.version desc
              )
              from policy_with_bounds pb_all
              where pb_all.profile_id = pr.profile_id
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
  into v_current_policy, v_latest_policy, v_versions, v_profiles;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'assignment_id', a.assignment_id,
        'app_user_id', a.app_user_id,
        'employee_display_name', ident.employee_display_name,
        'personnel_code', ident.personnel_code,
        'enabled', u.enabled,
        'profile_id', pr.profile_id,
        'profile_code', pr.profile_code,
        'profile_name', pr.display_name,
        'valid_from', pg_catalog.to_char(a.valid_from, 'YYYY-MM-DD'),
        'valid_to', case when a.valid_to is null then null else pg_catalog.to_char(a.valid_to, 'YYYY-MM-DD') end,
        'superseded_same_day', a.superseded_same_day,
        'effective', (
          not a.superseded_same_day
          and a.valid_from <= v_today_vn
          and (a.valid_to is null or v_today_vn <= a.valid_to)
          and pr.active = true
        ),
        'version', a.version,
        'created_at', pg_catalog.to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updated_at', pg_catalog.to_char(a.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      order by
        (
          not a.superseded_same_day
          and a.valid_from <= v_today_vn
          and (a.valid_to is null or v_today_vn <= a.valid_to)
        ) desc,
        lower(ident.employee_display_name) asc,
        a.valid_from desc,
        a.assigned_at desc,
        a.assignment_id desc
    ),
    '[]'::jsonb
  )
    into v_assignments
  from public.attendance_slot_policy_assignments a
  join public.attendance_slot_policy_profiles pr
    on pr.profile_id = a.profile_id
  join public.direct_entry_app_users u
    on u.app_user_id = a.app_user_id
  cross join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'app_user_id', u.app_user_id,
        'display_name', ident.employee_display_name,
        'employee_display_name', ident.employee_display_name,
        'personnel_code', ident.personnel_code,
        'enabled', u.enabled,
        'current_profile_id', coalesce(cur_a.profile_id, v_default_profile.profile_id),
        'current_profile_code', coalesce(cur_a.profile_code, v_default_profile.profile_code),
        'current_profile_name', coalesce(cur_a.profile_name, v_default_profile.display_name),
        'current_profile_is_default', (cur_a.assignment_id is null),
        'current_assignment_id', cur_a.assignment_id,
        'current_assignment_version', cur_a.version,
        'current_assignment_valid_from', cur_a.valid_from
      )
      order by lower(ident.employee_display_name) asc, u.app_user_id asc
    ),
    '[]'::jsonb
  )
    into v_employee_options
  from public.direct_entry_app_users u
  cross join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident
  left join lateral (
    select
      a.assignment_id,
      a.profile_id,
      pr.profile_code,
      pr.display_name as profile_name,
      a.version,
      pg_catalog.to_char(a.valid_from, 'YYYY-MM-DD') as valid_from
    from public.attendance_slot_policy_assignments a
    join public.attendance_slot_policy_profiles pr
      on pr.profile_id = a.profile_id
    where a.app_user_id = u.app_user_id
      and not a.superseded_same_day
      and a.valid_from <= v_today_vn
      and (a.valid_to is null or v_today_vn <= a.valid_to)
    order by a.valid_from desc, a.assigned_at desc, a.assignment_id desc
    limit 1
  ) cur_a on true
  where u.enabled = true;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_manage_slot_policy', v_can_manage
    ),
    'business_date', v_today_vn::text,
    'current_policy', v_current_policy,
    'latest_policy', v_latest_policy,
    'versions', v_versions,
    'profiles', v_profiles,
    'assignments', v_assignments,
    'employee_options', v_employee_options
  );
end;
$$;

create or replace function public.attendance_upsert_slot_policy_profile_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_profile_id uuid,
  p_profile_code text,
  p_display_name text,
  p_description text,
  p_active boolean,
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
  v_existing public.attendance_slot_policy_versions%rowtype;
  v_existing_effective_to date;
  v_profile public.attendance_slot_policy_profiles%rowtype;
  v_latest public.attendance_slot_policy_versions%rowtype;
  v_saved public.attendance_slot_policy_versions%rowtype;
  v_normalized_slots jsonb;
  v_effective_from date := coalesce(p_effective_from_date, v_today_vn);
  v_clean_code text;
  v_clean_name text;
  v_clean_desc text;
  v_next_active boolean;
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

    select *
      into v_profile
    from public.attendance_slot_policy_profiles pr
    where pr.profile_id = v_existing.profile_id;

    select (min(p2.effective_from_date) - 1)
      into v_existing_effective_to
    from public.attendance_slot_policy_versions p2
    where p2.profile_id = v_existing.profile_id
      and p2.effective_from_date > v_existing.effective_from_date;

    select coalesce(ident.employee_display_name, u.display_name)
      into v_actor_display_name
    from public.direct_entry_app_users u
    left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident on true
    where u.app_user_id = v_existing.configured_by_user_id;

    return jsonb_build_object(
      'replayed', true,
      'policy', public.attendance__internal_format_slot_policy(
        v_existing,
        v_existing_effective_to,
        v_actor_display_name
      ),
      'profile', jsonb_build_object(
        'profile_id', v_profile.profile_id,
        'profile_code', v_profile.profile_code,
        'display_name', v_profile.display_name,
        'description', v_profile.description,
        'is_default', v_profile.is_default,
        'active', v_profile.active,
        'version', v_profile.version
      )
    );
  end if;

  v_normalized_slots := public.attendance__internal_normalize_slots_jsonb(p_slots);

  if v_effective_from is null
     or v_effective_from in ('infinity'::date, '-infinity'::date)
     or v_effective_from < date '2000-01-01'
     or v_effective_from > date '2100-12-31'
     or not public.attendance__internal_validate_slots_jsonb(v_normalized_slots) then
    raise exception 'ATTENDANCE_SLOT_POLICY_INVALID'
      using errcode = '22023';
  end if;

  if p_profile_id is null then
    v_clean_code := upper(btrim(coalesce(p_profile_code, '')));
    v_clean_name := btrim(coalesce(p_display_name, ''));
    v_clean_desc := btrim(coalesce(p_description, ''));
    v_next_active := coalesce(p_active, true);

    if v_clean_code = ''
       or v_clean_code = 'DEFAULT'
       or v_clean_code !~ '^[A-Z0-9][A-Z0-9._:-]{0,63}$' then
      raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID'
        using errcode = '22023';
    end if;

    if char_length(v_clean_name) < 1
       or char_length(v_clean_name) > 128
       or v_clean_name ~ '[\x00-\x1F\x7F]'
       or char_length(v_clean_desc) > 500
       or v_clean_desc ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
      raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID'
        using errcode = '22023';
    end if;

    if p_expected_version is not null and p_expected_version <> 0 then
      raise exception 'ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;

    if exists (
      select 1
      from public.attendance_slot_policy_profiles pr
      where pr.profile_code = v_clean_code
         or lower(btrim(pr.display_name)) = lower(v_clean_name)
    ) then
      raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_CODE_CONFLICT'
        using errcode = 'PT409';
    end if;

    insert into public.attendance_slot_policy_profiles (
      profile_code,
      display_name,
      description,
      is_default,
      active,
      version,
      created_at,
      updated_at,
      updated_by_user_id,
      last_idempotency_key,
      last_request_fingerprint
    )
    values (
      v_clean_code,
      v_clean_name,
      v_clean_desc,
      false,
      v_next_active,
      1,
      clock_timestamp(),
      clock_timestamp(),
      p_app_user_id,
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_profile;

    insert into public.attendance_slot_policy_versions (
      profile_id,
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
      v_profile.profile_id,
      1,
      v_effective_from,
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
  else
    if p_expected_version is null or p_expected_version < 1 then
      raise exception 'ATTENDANCE_SLOT_POLICY_INVALID'
        using errcode = '22023';
    end if;

    select *
      into v_profile
    from public.attendance_slot_policy_profiles pr
    where pr.profile_id = p_profile_id
    for update;

    if not found then
      raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    select *
      into v_latest
    from public.attendance_slot_policy_versions p
    where p.profile_id = v_profile.profile_id
    order by p.version desc
    limit 1
    for update;

    if not found or v_latest.version <> p_expected_version then
      raise exception 'ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;

    if v_effective_from < v_today_vn then
      raise exception 'ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST'
        using errcode = '22023';
    end if;

    if v_effective_from <= v_latest.effective_from_date then
      raise exception 'ATTENDANCE_SLOT_POLICY_OVERLAP'
        using errcode = 'PT409';
    end if;

    v_clean_name := coalesce(nullif(btrim(coalesce(p_display_name, '')), ''), v_profile.display_name);
    v_clean_desc := case
      when p_description is null then v_profile.description
      else btrim(p_description)
    end;

    if char_length(v_clean_name) < 1
       or char_length(v_clean_name) > 128
       or v_clean_name ~ '[\x00-\x1F\x7F]'
       or char_length(v_clean_desc) > 500
       or v_clean_desc ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
      raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID'
        using errcode = '22023';
    end if;

    if v_profile.is_default and p_active is not null and not p_active then
      raise exception 'ATTENDANCE_SLOT_POLICY_DEFAULT_DEACTIVATE_FORBIDDEN'
        using errcode = '22023';
    end if;

    if exists (
      select 1
      from public.attendance_slot_policy_profiles pr
      where pr.profile_id <> v_profile.profile_id
        and lower(btrim(pr.display_name)) = lower(v_clean_name)
    ) then
      raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_CODE_CONFLICT'
        using errcode = 'PT409';
    end if;

    v_next_active := case
      when v_profile.is_default then true
      when p_active is null then v_profile.active
      else p_active
    end;

    update public.attendance_slot_policy_profiles pr
    set display_name = v_clean_name,
        description = v_clean_desc,
        active = v_next_active,
        version = pr.version + 1,
        updated_at = clock_timestamp(),
        updated_by_user_id = p_app_user_id,
        last_idempotency_key = p_idempotency_key,
        last_request_fingerprint = p_request_fingerprint
    where pr.profile_id = v_profile.profile_id
    returning * into v_profile;

    insert into public.attendance_slot_policy_versions (
      profile_id,
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
      v_profile.profile_id,
      v_latest.version + 1,
      v_effective_from,
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
  end if;

  select array_agg(val order by ord)
    into v_changed_fields
  from (
    select 0 as ord, 'profile:' || v_profile.profile_code || '(' || v_profile.display_name || ')' as val
    union all
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
    'attendance_slot_policy:' || v_profile.profile_code || ':v' || v_saved.version::text,
    'all',
    'APPLIED',
    v_changed_fields
  );

  select coalesce(ident.employee_display_name, u.display_name)
    into v_actor_display_name
  from public.direct_entry_app_users u
  left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident on true
  where u.app_user_id = p_app_user_id;

  return jsonb_build_object(
    'replayed', false,
    'policy', public.attendance__internal_format_slot_policy(
      v_saved,
      null,
      v_actor_display_name
    ),
    'profile', jsonb_build_object(
      'profile_id', v_profile.profile_id,
      'profile_code', v_profile.profile_code,
      'display_name', v_profile.display_name,
      'description', v_profile.description,
      'is_default', v_profile.is_default,
      'active', v_profile.active,
      'version', v_profile.version
    )
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
  v_default_profile_id constant uuid := '00000000-0000-4000-8000-000000000001'::uuid;
begin
  if p_effective_from_date is null then
    raise exception 'ATTENDANCE_SLOT_POLICY_INVALID'
      using errcode = '22023';
  end if;

  return public.attendance_upsert_slot_policy_profile_admin(
    p_auth_subject => p_auth_subject,
    p_app_user_id => p_app_user_id,
    p_profile_id => v_default_profile_id,
    p_profile_code => 'DEFAULT',
    p_display_name => null,
    p_description => null,
    p_active => true,
    p_effective_from_date => p_effective_from_date,
    p_slots => p_slots,
    p_expected_version => p_expected_version,
    p_idempotency_key => p_idempotency_key,
    p_request_fingerprint => p_request_fingerprint
  );
end;
$$;

create or replace function public.attendance_assign_employee_slot_policy_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_profile_id uuid,
  p_effective_date date,
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
  v_effective_date date := coalesce(
    p_effective_date,
    (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_existing public.attendance_slot_policy_assignments%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_profile public.attendance_slot_policy_profiles%rowtype;
  v_open public.attendance_slot_policy_assignments%rowtype;
  v_saved public.attendance_slot_policy_assignments%rowtype;
  v_ident record;
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

  if p_target_app_user_id is null
     or p_profile_id is null then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  if v_effective_date > v_today_vn then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023',
            detail = 'Slot policy profile assignment takes effect immediately and cannot be scheduled in the future.';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_slot_policy_assignments_user'),
    hashtext(p_target_app_user_id::text)
  );

  select *
    into v_existing
  from public.attendance_slot_policy_assignments a
  where a.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;

    select *
      into v_profile
    from public.attendance_slot_policy_profiles pr
    where pr.profile_id = v_existing.profile_id;

    select *
      into v_target_user
    from public.direct_entry_app_users u
    where u.app_user_id = v_existing.app_user_id;

    select *
      into v_ident
    from public.attendance__internal_resolve_employee_identity(v_existing.app_user_id);

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'employee_display_name', v_ident.employee_display_name,
        'personnel_code', v_ident.personnel_code,
        'enabled', v_target_user.enabled,
        'profile_id', v_profile.profile_id,
        'profile_code', v_profile.profile_code,
        'profile_name', v_profile.display_name,
        'valid_from', pg_catalog.to_char(v_existing.valid_from, 'YYYY-MM-DD'),
        'valid_to', case when v_existing.valid_to is null then null else pg_catalog.to_char(v_existing.valid_to, 'YYYY-MM-DD') end,
        'superseded_same_day', v_existing.superseded_same_day,
        'effective', (
          not v_existing.superseded_same_day
          and v_existing.valid_from <= v_today_vn
          and (v_existing.valid_to is null or v_today_vn <= v_existing.valid_to)
          and v_profile.active = true
        ),
        'version', v_existing.version
      )
    );
  end if;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = p_target_app_user_id
  for update;

  if not found or v_target_user.enabled is distinct from true then
    raise exception 'ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_profile
  from public.attendance_slot_policy_profiles pr
  where pr.profile_id = p_profile_id
  for share;

  if not found then
    raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_profile.is_default then
    raise exception 'ATTENDANCE_SLOT_POLICY_DEFAULT_ASSIGNMENT_REDUNDANT'
      using errcode = '22023';
  end if;

  if not v_profile.active then
    raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_INACTIVE'
      using errcode = '22023';
  end if;

  select *
    into v_open
  from public.attendance_slot_policy_assignments a
  where a.app_user_id = p_target_app_user_id
    and a.valid_to is null
    and not a.superseded_same_day
  order by a.valid_from desc, a.assigned_at desc
  limit 1
  for update;

  if p_expected_version is not null then
    if (v_open.assignment_id is null and p_expected_version <> 0 and p_expected_version <> v_profile.version)
       or (v_open.assignment_id is not null and v_open.version <> p_expected_version and v_profile.version <> p_expected_version) then
      raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;
  end if;

  if v_open.assignment_id is not null then
    if v_open.valid_from > v_effective_date then
      raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_DATE_ORDER_INVALID'
        using errcode = '22023';
    end if;

    if v_open.valid_from = v_effective_date then
      update public.attendance_slot_policy_assignments a
      set valid_to = v_effective_date,
          superseded_same_day = true,
          revoked_by_user_id = p_app_user_id,
          revoked_at = clock_timestamp(),
          version = a.version + 1,
          updated_at = clock_timestamp()
      where a.assignment_id = v_open.assignment_id;
    else
      update public.attendance_slot_policy_assignments a
      set valid_to = (v_effective_date - 1),
          superseded_same_day = false,
          revoked_by_user_id = p_app_user_id,
          revoked_at = clock_timestamp(),
          version = a.version + 1,
          updated_at = clock_timestamp()
      where a.assignment_id = v_open.assignment_id;
    end if;
  end if;

  begin
    insert into public.attendance_slot_policy_assignments (
      app_user_id,
      profile_id,
      valid_from,
      valid_to,
      superseded_same_day,
      version,
      assigned_by_user_id,
      assigned_at,
      idempotency_key,
      request_fingerprint
    )
    values (
      p_target_app_user_id,
      p_profile_id,
      v_effective_date,
      null,
      false,
      1,
      p_app_user_id,
      clock_timestamp(),
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_saved;
  exception
    when exclusion_violation or unique_violation then
      raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP'
        using errcode = 'PT409';
  end;

  select *
    into v_ident
  from public.attendance__internal_resolve_employee_identity(p_target_app_user_id);

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
    'attendance_slot_policy_assign',
    'entry_admin',
    'attendance_slot_policy_assignment:' || v_saved.assignment_id::text,
    'all',
    'APPLIED',
    array[
      'target_app_user_id:' || p_target_app_user_id::text,
      'profile_code:' || v_profile.profile_code,
      'valid_from:' || v_saved.valid_from::text
    ]
  );

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_saved.assignment_id,
      'app_user_id', v_saved.app_user_id,
      'employee_display_name', v_ident.employee_display_name,
      'personnel_code', v_ident.personnel_code,
      'enabled', v_target_user.enabled,
      'profile_id', v_profile.profile_id,
      'profile_code', v_profile.profile_code,
      'profile_name', v_profile.display_name,
      'valid_from', pg_catalog.to_char(v_saved.valid_from, 'YYYY-MM-DD'),
      'valid_to', case when v_saved.valid_to is null then null else pg_catalog.to_char(v_saved.valid_to, 'YYYY-MM-DD') end,
      'superseded_same_day', v_saved.superseded_same_day,
      'effective', (
        not v_saved.superseded_same_day
        and v_saved.valid_from <= v_today_vn
        and (v_saved.valid_to is null or v_today_vn <= v_saved.valid_to)
        and v_profile.active = true
      ),
      'version', v_saved.version
    )
  );
end;
$$;

create or replace function public.attendance_unassign_employee_slot_policy_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_effective_date date,
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
  v_effective_date date := coalesce(
    p_effective_date,
    (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_existing public.attendance_slot_policy_assignments%rowtype;
  v_current public.attendance_slot_policy_assignments%rowtype;
  v_updated public.attendance_slot_policy_assignments%rowtype;
  v_profile public.attendance_slot_policy_profiles%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_ident record;
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

  if p_assignment_id is null
     or p_expected_version is null
     or p_expected_version < 1 then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  if v_effective_date > v_today_vn then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023',
            detail = 'Slot policy profile unassignment takes effect immediately and cannot be scheduled in the future.';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_slot_policy_assignments_unassign'),
    hashtext(p_assignment_id::text)
  );

  select *
    into v_existing
  from public.attendance_slot_policy_assignments a
  where a.revoke_idempotency_key = p_idempotency_key;

  if found then
    if v_existing.revoke_request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;

    select *
      into v_profile
    from public.attendance_slot_policy_profiles pr
    where pr.profile_id = v_existing.profile_id;

    select *
      into v_target_user
    from public.direct_entry_app_users u
    where u.app_user_id = v_existing.app_user_id;

    select *
      into v_ident
    from public.attendance__internal_resolve_employee_identity(v_existing.app_user_id);

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'employee_display_name', v_ident.employee_display_name,
        'personnel_code', v_ident.personnel_code,
        'enabled', v_target_user.enabled,
        'profile_id', v_profile.profile_id,
        'profile_code', v_profile.profile_code,
        'profile_name', v_profile.display_name,
        'valid_from', pg_catalog.to_char(v_existing.valid_from, 'YYYY-MM-DD'),
        'valid_to', case when v_existing.valid_to is null then null else pg_catalog.to_char(v_existing.valid_to, 'YYYY-MM-DD') end,
        'superseded_same_day', v_existing.superseded_same_day,
        'effective', false,
        'version', v_existing.version
      )
    );
  end if;

  select *
    into v_current
  from public.attendance_slot_policy_assignments a
  where a.assignment_id = p_assignment_id
  for update;

  if not found then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_current.version <> p_expected_version then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_current.valid_to is not null or v_current.superseded_same_day then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_ALREADY_CLOSED'
      using errcode = 'PT409';
  end if;

  if v_effective_date < v_current.valid_from then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_RANGE_INVALID'
      using errcode = '22023';
  end if;

  if v_effective_date = v_current.valid_from then
    update public.attendance_slot_policy_assignments a
    set valid_to = v_effective_date,
        superseded_same_day = true,
        revoked_by_user_id = p_app_user_id,
        revoked_at = clock_timestamp(),
        revoke_idempotency_key = p_idempotency_key,
        revoke_request_fingerprint = p_request_fingerprint,
        version = a.version + 1,
        updated_at = clock_timestamp()
    where a.assignment_id = p_assignment_id
    returning * into v_updated;
  else
    update public.attendance_slot_policy_assignments a
    set valid_to = (v_effective_date - 1),
        superseded_same_day = false,
        revoked_by_user_id = p_app_user_id,
        revoked_at = clock_timestamp(),
        revoke_idempotency_key = p_idempotency_key,
        revoke_request_fingerprint = p_request_fingerprint,
        version = a.version + 1,
        updated_at = clock_timestamp()
    where a.assignment_id = p_assignment_id
    returning * into v_updated;
  end if;

  select *
    into v_profile
  from public.attendance_slot_policy_profiles pr
  where pr.profile_id = v_updated.profile_id;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = v_updated.app_user_id;

  select *
    into v_ident
  from public.attendance__internal_resolve_employee_identity(v_updated.app_user_id);

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
    'attendance_slot_policy_unassign',
    'entry_admin',
    'attendance_slot_policy_assignment:' || v_updated.assignment_id::text,
    'all',
    'APPLIED',
    array[
      'target_app_user_id:' || v_updated.app_user_id::text,
      'profile_code:' || v_profile.profile_code,
      'effective_date:' || v_effective_date::text,
      'valid_to:' || coalesce(v_updated.valid_to::text, 'null'),
      'superseded_same_day:' || v_updated.superseded_same_day::text
    ]
  );

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_updated.assignment_id,
      'app_user_id', v_updated.app_user_id,
      'employee_display_name', v_ident.employee_display_name,
      'personnel_code', v_ident.personnel_code,
      'enabled', v_target_user.enabled,
      'profile_id', v_profile.profile_id,
      'profile_code', v_profile.profile_code,
      'profile_name', v_profile.display_name,
      'valid_from', pg_catalog.to_char(v_updated.valid_from, 'YYYY-MM-DD'),
      'valid_to', case when v_updated.valid_to is null then null else pg_catalog.to_char(v_updated.valid_to, 'YYYY-MM-DD') end,
      'superseded_same_day', v_updated.superseded_same_day,
      'effective', false,
      'version', v_updated.version
    )
  );
end;
$$;


-- =============================================================================
-- SECTION 5: Multi-Profile Monthly Attendance Matrix Report RPC
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
  v_default_profile_id constant uuid := '00000000-0000-4000-8000-000000000001'::uuid;
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
  v_branch_options jsonb;
  v_employee_options jsonb;
  v_overview jsonb;
  v_total_rows integer := 0;
  v_total_pages integer := 0;
  v_snapshot_token text;
  v_items jsonb := '[]'::jsonb;
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

  with policy_with_bounds as (
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

  with month_candidate_users as materialized (
    select
      u.app_user_id,
      u.display_name as raw_display_name,
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
    from public.direct_entry_app_users u
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
       or exists (
         select 1
         from public.attendance_explanations ae
         where ae.app_user_id = u.app_user_id
           and ae.business_date between v_month_start and v_month_end
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
  profile_day_policies as materialized (
    select
      pr.profile_id,
      pr.profile_code,
      pr.display_name as profile_name,
      pr.is_default,
      cal.d::date as business_date,
      extract(day from cal.d)::integer as day_of_month,
      pol.version as policy_version,
      pol.slots as policy_slots
    from public.attendance_slot_policy_profiles pr
    cross join generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
    join lateral (
      select p.*
      from public.attendance_slot_policy_versions p
      where p.profile_id = pr.profile_id
      order by (p.effective_from_date <= cal.d::date) desc, p.effective_from_date desc, p.version desc
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
  employee_day_policies as materialized (
    select
      ce.app_user_id,
      pdp.business_date,
      pdp.day_of_month,
      pdp.profile_id,
      pdp.profile_code,
      pdp.profile_name,
      pdp.is_default,
      pdp.policy_version,
      pdp.policy_slots
    from candidate_employees ce
    cross join generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
    left join lateral (
      select a.profile_id
      from public.attendance_slot_policy_assignments a
      where a.app_user_id = ce.app_user_id
        and not a.superseded_same_day
        and a.valid_from <= cal.d::date
        and (a.valid_to is null or cal.d::date <= a.valid_to)
      order by a.valid_from desc, a.assigned_at desc, a.assignment_id desc
      limit 1
    ) emp_assign on true
    join profile_day_policies pdp
      on pdp.profile_id = coalesce(emp_assign.profile_id, v_default_profile_id)
     and pdp.business_date = cal.d::date
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
      edp.profile_id as policy_profile_id,
      edp.profile_code as policy_profile_code,
      edp.profile_name as policy_profile_name,
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
    join employee_day_policies edp
      on edp.app_user_id = mcr.app_user_id
     and edp.business_date = mcr.business_date
    cross join lateral (
      select
        s.policy_version,
        s.slot_index,
        s.slot_code,
        s.target_time,
        s.target_minute,
        s.grace_before_minutes,
        s.grace_after_minutes
      from profile_day_slot_defs s
      where s.profile_id = edp.profile_id
        and s.business_date = mcr.business_date
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
  daily_slot_explanations as (
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
        v_completed_days_in_month - coalesce(completed.elapsed_checkin_day_count, 0)
      )::integer as no_checkin_day_count,
      (
        v_completed_days_in_month
        - coalesce(completed.elapsed_checkin_day_count, 0)
        - (coalesce(completed.elapsed_leave_day_count, 0) - coalesce(completed.elapsed_overlap_day_count, 0))
      )::integer as no_checkin_without_leave_day_count
    from candidate_employees ce
    left join lateral (
      select jsonb_agg(sub_p.profile_name order by sub_p.first_date asc) as profile_names_in_month
      from (
        select
          edp_p.profile_name,
          min(edp_p.business_date) as first_date
        from employee_day_policies edp_p
        where edp_p.app_user_id = ce.app_user_id
        group by edp_p.profile_name
      ) sub_p
    ) prof_names on true
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
    left join lateral (
      select
        count(*) filter (where coalesce(dc.checkin_count, 0) > 0)::integer as elapsed_checkin_day_count,
        count(*) filter (where coalesce(dl.leave_units, 0) > 0)::integer as elapsed_leave_day_count,
        count(*) filter (
          where coalesce(dc.checkin_count, 0) > 0 and coalesce(dl.leave_units, 0) > 0
        )::integer as elapsed_overlap_day_count
      from employee_day_policies edp_elapsed
      left join daily_checkins dc
        on dc.app_user_id = ce.app_user_id
       and dc.business_date = edp_elapsed.business_date
      left join daily_leaves dl
        on dl.app_user_id = ce.app_user_id
       and dl.business_date = edp_elapsed.business_date
      where edp_elapsed.app_user_id = ce.app_user_id
        and edp_elapsed.business_date < v_today_vn
    ) completed on true
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
              when day_slots.missing_slot_count > 0 then 'NO_CHECKIN'
              else 'UPCOMING'
            end,
            'missing_slot_count', day_slots.missing_slot_count,
            'late_or_early_checkin_count', day_slots.late_or_early_checkin_count,
            'slots', day_slots.slots
          )
          order by edp.business_date asc
        )
        from employee_day_policies edp
        left join daily_checkins dc
          on dc.app_user_id = pe.app_user_id
         and dc.business_date = edp.business_date
        left join daily_leaves dl
          on dl.app_user_id = pe.app_user_id
         and dl.business_date = edp.business_date
        cross join lateral (
          select
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
          from profile_day_slot_defs mds
          left join daily_slot_checkins dsc
            on dsc.app_user_id = pe.app_user_id
           and dsc.business_date = edp.business_date
           and dsc.slot_index = mds.slot_index
          left join daily_slot_explanations dse
            on dse.app_user_id = pe.app_user_id
           and dse.business_date = edp.business_date
           and dse.slot_code = mds.slot_code
          where mds.profile_id = edp.profile_id
            and mds.business_date = edp.business_date
        ) day_slots
        where edp.app_user_id = pe.app_user_id
      ) as days
    from paged_employees pe
  )
  select
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
  into v_employee_options, v_total_rows, v_snapshot_token, v_overview, v_items
  from agg a
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


-- =============================================================================
-- SECTION 6: Multi-Profile Wave 2 Attendance Explanations
-- =============================================================================

create or replace function public.attendance_explanation__internal_evaluate_employee_day_slots(
  p_app_user_id uuid,
  p_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now_local timestamp without time zone := clock_timestamp() at time zone 'Asia/Ho_Chi_Minh';
  v_today_local date := v_now_local::date;
  v_resolved record;
  v_slots jsonb;
begin
  if p_app_user_id is null or p_business_date is null then
    raise exception 'ATTENDANCE_EXPLANATION_QUERY_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_resolved
  from public.attendance__internal_resolve_employee_slot_policy(
    p_app_user_id,
    p_business_date
  );

  with slot_defs as (
    select
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
        p_business_date < v_today_local
        or (
          p_business_date = v_today_local
          and v_now_local > p_business_date
            + (slot_elem->>'target_time')::time
            + make_interval(mins => (slot_elem->>'grace_after_minutes')::integer)
        )
      ) as is_due
    from jsonb_array_elements(v_resolved.slots) as slot_elem
  ),
  raw_checkins as (
    select
      c.checkin_id,
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
    where c.app_user_id = p_app_user_id
      and c.business_date = p_business_date
  ),
  enriched_checkins as (
    select
      rc.*,
      ns.slot_index as assigned_slot_index,
      ns.slot_code as assigned_slot_code,
      (rc.local_minute_of_day - ns.target_minute)::integer as delta_minutes,
      case
        when (rc.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then
          ((- (rc.local_minute_of_day - ns.target_minute)) - ns.grace_before_minutes)::integer
        when (rc.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then
          ((rc.local_minute_of_day - ns.target_minute) - ns.grace_after_minutes)::integer
        else 0
      end as over_grace_minutes,
      case
        when (rc.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then 'EARLY'
        when (rc.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then 'LATE'
        else 'ON_TIME'
      end as deviation_status
    from raw_checkins rc
    cross join lateral (
      select
        s.slot_index,
        s.slot_code,
        s.target_minute,
        s.grace_before_minutes,
        s.grace_after_minutes
      from slot_defs s
      order by abs(rc.local_minute_of_day - s.target_minute) asc, s.slot_index asc
      limit 1
    ) ns
  ),
  slot_checkins as (
    select
      ec.assigned_slot_index as slot_index,
      count(*)::integer as checkin_count,
      count(*) filter (where ec.deviation_status <> 'ON_TIME')::integer as out_of_grace_count,
      jsonb_agg(
        jsonb_build_object(
          'checkin_id', ec.checkin_id,
          'sequence_in_day', ec.sequence_in_day,
          'captured_at', ec.captured_at_utc,
          'captured_at_local', ec.captured_at_local,
          'time_local', ec.time_local,
          'time_verified', ec.time_verified,
          'assigned_slot_code', ec.assigned_slot_code,
          'delta_minutes', ec.delta_minutes,
          'over_grace_minutes', ec.over_grace_minutes,
          'deviation_status', ec.deviation_status,
          'distance_target_kind', ec.distance_target_kind,
          'distance_status', ec.distance_status,
          'distance_meters', ec.distance_meters
        )
        order by ec.captured_at asc, ec.sequence_in_day asc, ec.checkin_id asc
      ) as checkins
    from enriched_checkins ec
    group by ec.assigned_slot_index
  ),
  leave_coverage as (
    select
      coalesce(bool_or(ld.session_code in ('FULL', 'AM')), false) as am_covered,
      coalesce(bool_or(ld.session_code in ('FULL', 'PM')), false) as pm_covered
    from public.leave_request_days ld
    join public.leave_requests lr
      on lr.request_id = ld.request_id
    where ld.app_user_id = p_app_user_id
      and ld.leave_date = p_business_date
      and ld.is_active = true
      and lr.status = 'APPROVED'
  ),
  slot_explanations as (
    select distinct on (ae.slot_code)
      ae.explanation_id,
      ae.slot_code,
      ae.status,
      ae.original_slot_status,
      ae.reason,
      to_char(ae.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as submitted_at_utc,
      to_char(ae.submitted_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as submitted_at_local,
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
    left join public.direct_entry_app_users du
      on du.app_user_id = ae.decided_by_app_user_id
    left join lateral public.attendance__internal_resolve_employee_identity(du.app_user_id) dec_ident
      on du.app_user_id is not null
    where ae.app_user_id = p_app_user_id
      and ae.business_date = p_business_date
    order by
      ae.slot_code asc,
      case ae.status
        when 'APPROVED' then 1
        when 'PENDING' then 2
        else 3
      end asc,
      ae.submitted_at desc,
      ae.explanation_id desc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slot_code', sd.slot_code,
        'slot_index', sd.slot_index,
        'slot_label', sd.slot_label,
        'session_code', sd.session_code,
        'target_time', sd.target_time,
        'grace_before_minutes', sd.grace_before_minutes,
        'grace_after_minutes', sd.grace_after_minutes,
        'is_leave_covered', (
          case
            when sd.session_code = 'AM' then lc.am_covered
            else lc.pm_covered
          end
        ),
        'original_slot_status', (
          case
            when coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
            when coalesce(sc.checkin_count, 0) > 0 then 'ON_TIME'
            when (
              case
                when sd.session_code = 'AM' then lc.am_covered
                else lc.pm_covered
              end
            ) then 'LEAVE_COVERED'
            else 'MISSING'
          end
        ),
        'slot_status', (
          case
            when se.status = 'APPROVED' and (
              (coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0)
              or (
                coalesce(sc.checkin_count, 0) = 0
                and not (
                  case
                    when sd.session_code = 'AM' then lc.am_covered
                    else lc.pm_covered
                  end
                )
              )
            ) then 'EXPLAINED_APPROVED'
            when coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
            when coalesce(sc.checkin_count, 0) > 0 then 'ON_TIME'
            when (
              case
                when sd.session_code = 'AM' then lc.am_covered
                else lc.pm_covered
              end
            ) then 'LEAVE_COVERED'
            when not sd.is_due then 'UPCOMING'
            else 'MISSING'
          end
        ),
        'eligible_for_explanation', (
          sd.is_due
          and coalesce(se.status, '') not in ('PENDING', 'APPROVED')
          and (
            (coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0)
            or (
              coalesce(sc.checkin_count, 0) = 0
              and not (
                case
                  when sd.session_code = 'AM' then lc.am_covered
                  else lc.pm_covered
                end
              )
            )
          )
        ),
        'checkins', coalesce(sc.checkins, '[]'::jsonb),
        'explanation', case
          when se.explanation_id is not null then
            jsonb_build_object(
              'explanation_id', se.explanation_id,
              'status', se.status,
              'original_slot_status', se.original_slot_status,
              'reason', se.reason,
              'submitted_at', se.submitted_at_utc,
              'submitted_at_local', se.submitted_at_local,
              'decided_at', se.decided_at_utc,
              'decided_at_local', se.decided_at_local,
              'decided_by_display_name', se.decided_by_display_name,
              'decision_note', se.decision_note,
              'row_version', se.row_version
            )
          else null
        end
      )
      order by sd.slot_index asc
    ),
    '[]'::jsonb
  )
    into v_slots
  from slot_defs sd
  cross join leave_coverage lc
  left join slot_checkins sc
    on sc.slot_index = sd.slot_index
  left join slot_explanations se
    on se.slot_code = sd.slot_code;

  return jsonb_build_object(
    'business_date', p_business_date::text,
    'policy_profile_id_used', v_resolved.profile_id,
    'policy_profile_code_used', v_resolved.profile_code,
    'policy_profile_name_used', v_resolved.profile_name,
    'policy_is_default_used', v_resolved.is_default,
    'policy_version_used', v_resolved.policy_version,
    'slots', v_slots
  );
end;
$$;

create or replace function public.attendance_explanation__internal_project_item(
  p_explanation public.attendance_explanations
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_requester jsonb;
  v_primary_approver jsonb := null;
  v_decided_by jsonb := null;
  v_audit_events jsonb := '[]'::jsonb;
begin
  v_requester := public.leave_management__internal_account_summary(p_explanation.app_user_id);

  if p_explanation.primary_approver_app_user_id is not null then
    v_primary_approver := public.leave_management__internal_account_summary(
      p_explanation.primary_approver_app_user_id
    );
  end if;

  if p_explanation.decided_by_app_user_id is not null then
    v_decided_by := public.leave_management__internal_account_summary(
      p_explanation.decided_by_app_user_id
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'audit_event_id', e.audit_event_id,
        'action', e.action,
        'actor', public.leave_management__internal_account_summary(e.actor_app_user_id),
        'before_status', e.before_status,
        'after_status', e.after_status,
        'note', e.note,
        'created_at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'created_at_local', to_char(e.created_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
      )
      order by e.created_at asc, e.audit_event_id asc
    ),
    '[]'::jsonb
  )
    into v_audit_events
  from public.attendance_explanation_audit_events e
  where e.explanation_id = p_explanation.explanation_id;

  return jsonb_build_object(
    'explanation_id', p_explanation.explanation_id,
    'app_user_id', p_explanation.app_user_id,
    'requester', v_requester,
    'business_date', p_explanation.business_date::text,
    'slot_code', p_explanation.slot_code,
    'slot_index', p_explanation.slot_index,
    'slot_label', p_explanation.slot_label,
    'session_code', p_explanation.session_code,
    'target_time', p_explanation.target_time,
    'grace_before_minutes', p_explanation.grace_before_minutes,
    'grace_after_minutes', p_explanation.grace_after_minutes,
    'policy_profile_id_used', p_explanation.policy_profile_id_used,
    'policy_profile_code_used', p_explanation.policy_profile_code_used,
    'policy_profile_name_used', p_explanation.policy_profile_name_used,
    'policy_version_used', p_explanation.policy_version_used,
    'original_slot_status', p_explanation.original_slot_status,
    'effective_slot_status', case
      when p_explanation.status = 'APPROVED' then 'EXPLAINED_APPROVED'
      else p_explanation.original_slot_status
    end,
    'related_checkins', p_explanation.related_checkins_snapshot,
    'reason', p_explanation.reason,
    'status', p_explanation.status,
    'unit_kind_snapshot', p_explanation.unit_kind_snapshot,
    'route_kind', p_explanation.route_kind,
    'primary_approver', v_primary_approver,
    'routed_team', case
      when p_explanation.routed_team_id is not null then
        jsonb_build_object(
          'team_id', p_explanation.routed_team_id,
          'team_code', p_explanation.routed_team_code,
          'team_name', p_explanation.routed_team_name
        )
      else null
    end,
    'fallback_reason', p_explanation.fallback_reason,
    'submitted_at', to_char(p_explanation.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'submitted_at_local', to_char(p_explanation.submitted_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
    'decided_at', case
      when p_explanation.decided_at is not null then
        to_char(p_explanation.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      else null
    end,
    'decided_at_local', case
      when p_explanation.decided_at is not null then
        to_char(p_explanation.decided_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
      else null
    end,
    'decided_by', v_decided_by,
    'decision_note', p_explanation.decision_note,
    'row_version', p_explanation.row_version,
    'updated_at', to_char(p_explanation.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'audit_events', v_audit_events
  );
end;
$$;

create or replace function public.attendance_submit_explanation(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_business_date date,
  p_slot_code text,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_auth jsonb;
  v_today_local date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_slot_code text := upper(btrim(coalesce(p_slot_code, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := lower(btrim(coalesce(p_request_fingerprint, '')));
  v_existing_idem public.attendance_explanation_idempotency_records%rowtype;
  v_day_evaluation jsonb;
  v_policy_profile_id_used uuid;
  v_policy_profile_code_used text;
  v_policy_profile_name_used text;
  v_policy_version_used integer;
  v_slot_eval jsonb;
  v_original_slot_status text;
  v_routing jsonb;
  v_inserted public.attendance_explanations%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  if not (v_auth ->> 'can_submit_request')::boolean then
    raise exception 'ATTENDANCE_EXPLANATION_SUBMIT_DENIED'
      using errcode = '42501';
  end if;

  if char_length(v_idempotency_key) < 8
     or char_length(v_idempotency_key) > 128
     or v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_explanation_submit:' || p_actor_app_user_id::text),
    hashtext(coalesce(p_business_date::text, '') || ':' || v_slot_code)
  );

  select *
    into v_existing_idem
  from public.attendance_explanation_idempotency_records r
  where r.app_user_id = p_actor_app_user_id
     and r.operation = 'explanation_submit'
     and r.idempotency_key = v_idempotency_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;
    return jsonb_set(v_existing_idem.response_payload, '{replayed}', 'true'::jsonb, true);
  end if;

  if p_business_date is null
     or p_business_date < date '2000-01-01'
     or p_business_date > date '2100-12-31' then
    raise exception 'ATTENDANCE_EXPLANATION_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_business_date > v_today_local then
    raise exception 'ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED'
      using errcode = '22023';
  end if;

  if v_slot_code !~ '^SLOT_([1-9]|1[0-2])$' then
    raise exception 'ATTENDANCE_EXPLANATION_SLOT_INVALID'
      using errcode = '22023';
  end if;

  if char_length(v_reason) < 3
     or char_length(v_reason) > 500
     or v_reason ~ '[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]' then
    raise exception 'ATTENDANCE_EXPLANATION_REASON_INVALID'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.attendance_explanations ae
    where ae.app_user_id = p_actor_app_user_id
      and ae.business_date = p_business_date
      and ae.slot_code = v_slot_code
      and ae.status in ('PENDING', 'APPROVED')
  ) then
    raise exception 'ATTENDANCE_EXPLANATION_ALREADY_EXISTS'
      using errcode = 'PT409';
  end if;

  v_day_evaluation := public.attendance_explanation__internal_evaluate_employee_day_slots(
    p_actor_app_user_id,
    p_business_date
  );
  v_policy_profile_id_used := coalesce(
    (v_day_evaluation ->> 'policy_profile_id_used')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );
  v_policy_profile_code_used := coalesce(v_day_evaluation ->> 'policy_profile_code_used', 'DEFAULT');
  v_policy_profile_name_used := coalesce(v_day_evaluation ->> 'policy_profile_name_used', 'Mặc định');
  v_policy_version_used := (v_day_evaluation ->> 'policy_version_used')::integer;

  select elem
    into v_slot_eval
  from jsonb_array_elements(v_day_evaluation -> 'slots') as elem
  where elem ->> 'slot_code' = v_slot_code
  limit 1;

  if v_slot_eval is null then
    raise exception 'ATTENDANCE_EXPLANATION_SLOT_INVALID'
      using errcode = '22023';
  end if;

  v_original_slot_status := v_slot_eval ->> 'original_slot_status';
  if coalesce((v_slot_eval ->> 'eligible_for_explanation')::boolean, false) is not true
     or v_original_slot_status not in ('MISSING', 'OUT_OF_GRACE') then
    raise exception 'ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE'
      using errcode = 'PT409';
  end if;

  v_routing := public.leave_management__internal_resolve_routing(
    p_actor_app_user_id,
    v_today_local
  );

  insert into public.attendance_explanations (
    app_user_id,
    business_date,
    slot_code,
    slot_index,
    slot_label,
    session_code,
    target_time,
    grace_before_minutes,
    grace_after_minutes,
    policy_profile_id_used,
    policy_profile_code_used,
    policy_profile_name_used,
    policy_version_used,
    original_slot_status,
    related_checkins_snapshot,
    reason,
    status,
    unit_kind_snapshot,
    route_kind,
    primary_approver_app_user_id,
    routed_team_id,
    routed_team_code,
    routed_team_name,
    fallback_reason,
    submitted_at,
    row_version,
    updated_at
  )
  values (
    p_actor_app_user_id,
    p_business_date,
    v_slot_code,
    (v_slot_eval ->> 'slot_index')::integer,
    v_slot_eval ->> 'slot_label',
    v_slot_eval ->> 'session_code',
    v_slot_eval ->> 'target_time',
    (v_slot_eval ->> 'grace_before_minutes')::integer,
    (v_slot_eval ->> 'grace_after_minutes')::integer,
    v_policy_profile_id_used,
    v_policy_profile_code_used,
    v_policy_profile_name_used,
    v_policy_version_used,
    v_original_slot_status,
    coalesce(v_slot_eval -> 'checkins', '[]'::jsonb),
    v_reason,
    'PENDING',
    v_routing ->> 'unit_kind',
    v_routing ->> 'route_kind',
    case
      when (v_routing ->> 'primary_approver_app_user_id') is not null then
        (v_routing ->> 'primary_approver_app_user_id')::uuid
      else null
    end,
    case
      when (v_routing ->> 'team_id') is not null then
        (v_routing ->> 'team_id')::uuid
      else null
    end,
    v_routing ->> 'team_code',
    v_routing ->> 'team_name',
    v_routing ->> 'fallback_reason',
    clock_timestamp(),
    1,
    clock_timestamp()
  )
  returning * into v_inserted;

  insert into public.attendance_explanation_audit_events (
    explanation_id,
    action,
    actor_app_user_id,
    before_status,
    after_status,
    note,
    payload
  )
  values (
    v_inserted.explanation_id,
    'SUBMITTED',
    p_actor_app_user_id,
    null,
    'PENDING',
    v_reason,
    jsonb_build_object(
      'business_date', p_business_date::text,
      'slot_code', v_slot_code,
      'policy_profile_id_used', v_policy_profile_id_used,
      'policy_profile_code_used', v_policy_profile_code_used,
      'policy_profile_name_used', v_policy_profile_name_used,
      'policy_version_used', v_policy_version_used,
      'original_slot_status', v_original_slot_status,
      'route_kind', v_inserted.route_kind,
      'primary_approver_app_user_id', v_inserted.primary_approver_app_user_id
    )
  );

  v_response := jsonb_build_object(
    'replayed', false,
    'explanation', public.attendance_explanation__internal_project_item(v_inserted)
  );

  insert into public.attendance_explanation_idempotency_records (
    app_user_id,
    operation,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    p_actor_app_user_id,
    'explanation_submit',
    v_idempotency_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$$;

-- =============================================================================
-- SECTION 7: Owner Alignment & Strict ACL Grants
-- =============================================================================

do $owner_align$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_tbl regclass;
  v_tbl_owner_oid oid;
  v_fn regprocedure;
  v_proc_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_owner
  from pg_catalog.pg_class c
  join pg_catalog.pg_roles r on r.oid = c.relowner
  where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner is null then
    raise exception 'ATTENDANCE_MULTI_SLOT_POLICY_OWNER_RESOLUTION_FAILED';
  end if;

  for v_tbl, v_tbl_owner_oid in
    select c.oid::regclass, c.relowner
      from pg_catalog.pg_class c
     where c.oid in (
       'public.attendance_slot_policy_profiles'::pg_catalog.regclass,
       'public.attendance_slot_policy_assignments'::pg_catalog.regclass
     )
  loop
    if v_tbl_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter table %s owner to %I', v_tbl, v_owner);
    end if;
  end loop;

  for v_fn, v_proc_owner_oid in
    select p.oid::regprocedure, p.proowner
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.attendance__internal_format_slot_policy(public.attendance_slot_policy_versions,date,text)'::pg_catalog.regprocedure,
       'public.attendance__internal_resolve_employee_slot_policy(uuid,date)'::pg_catalog.regprocedure,
       'public.attendance_get_slot_policies_admin(uuid,uuid)'::pg_catalog.regprocedure,
       'public.attendance_upsert_slot_policy_profile_admin(uuid,uuid,uuid,text,text,text,boolean,date,jsonb,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_create_slot_policy_admin(uuid,uuid,date,jsonb,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_assign_employee_slot_policy_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_unassign_employee_slot_policy_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure,
       'public.attendance_explanation__internal_evaluate_employee_day_slots(uuid,date)'::pg_catalog.regprocedure,
       'public.attendance_explanation__internal_project_item(public.attendance_explanations)'::pg_catalog.regprocedure,
       'public.attendance_submit_explanation(uuid,uuid,date,text,text,text,text)'::pg_catalog.regprocedure
     )
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;
end;
$owner_align$;

revoke all on function public.attendance__internal_format_slot_policy(public.attendance_slot_policy_versions, date, text)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance__internal_resolve_employee_slot_policy(uuid, date)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_explanation__internal_evaluate_employee_day_slots(uuid, date)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_explanation__internal_project_item(public.attendance_explanations)
  from public, anon, authenticated, service_role;

revoke all on function public.attendance_get_slot_policies_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_get_slot_policies_admin(uuid, uuid)
  to service_role;

revoke all on function public.attendance_upsert_slot_policy_profile_admin(uuid, uuid, uuid, text, text, text, boolean, date, jsonb, integer, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_upsert_slot_policy_profile_admin(uuid, uuid, uuid, text, text, text, boolean, date, jsonb, integer, uuid, text)
  to service_role;

revoke all on function public.attendance_create_slot_policy_admin(uuid, uuid, date, jsonb, integer, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_create_slot_policy_admin(uuid, uuid, date, jsonb, integer, uuid, text)
  to service_role;

revoke all on function public.attendance_assign_employee_slot_policy_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_assign_employee_slot_policy_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)
  to service_role;

revoke all on function public.attendance_unassign_employee_slot_policy_admin(uuid, uuid, uuid, date, integer, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_unassign_employee_slot_policy_admin(uuid, uuid, uuid, date, integer, uuid, text)
  to service_role;

revoke all on function public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)
  to service_role;

revoke all on function public.attendance_submit_explanation(uuid, uuid, date, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_submit_explanation(uuid, uuid, date, text, text, text, text)
  to service_role;

do $grant_internal_owner_exec$
declare
  v_owner name;
  v_helper_fn pg_catalog.regprocedure;
begin
  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.attendance__internal_format_slot_policy(public.attendance_slot_policy_versions,date,text)'::pg_catalog.regprocedure,
       'public.attendance__internal_resolve_employee_slot_policy(uuid,date)'::pg_catalog.regprocedure,
       'public.attendance_get_slot_policies_admin(uuid,uuid)'::pg_catalog.regprocedure,
       'public.attendance_upsert_slot_policy_profile_admin(uuid,uuid,uuid,text,text,text,boolean,date,jsonb,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_create_slot_policy_admin(uuid,uuid,date,jsonb,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_assign_employee_slot_policy_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_unassign_employee_slot_policy_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure,
       'public.attendance_explanation__internal_evaluate_employee_day_slots(uuid,date)'::pg_catalog.regprocedure,
       'public.attendance_explanation__internal_project_item(public.attendance_explanations)'::pg_catalog.regprocedure,
       'public.attendance_submit_explanation(uuid,uuid,date,text,text,text,text)'::pg_catalog.regprocedure
     )
  loop
    for v_helper_fn in
      select p.oid::pg_catalog.regprocedure
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (
           p.proname like 'attendance__internal_%'
           or p.proname like 'attendance_explanation__internal_%'
           or p.proname like 'leave_management__internal_%'
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
