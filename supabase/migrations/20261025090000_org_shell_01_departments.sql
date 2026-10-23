-- =============================================================================
-- ORG-SHELL-01 (Work Package 1 of VFIN-01): Safe Department Shell & Accounting
-- Department Membership Backend.
--
-- Scope (strictly stability-first for live Go-Live system):
--   1. Department catalog (`public.organization_departments`) with two immutable,
--      non-deletable system departments seeded idempotently:
--        - RECRUITMENT ("Phòng Tuyển dụng")
--        - ACCOUNTING  ("Phòng Kế toán")
--   2. Effective-dated Accounting department memberships
--      (`public.organization_department_memberships`) with pair-version OCC,
--      actor + bounded reason, append-only audit (`organization_department_audit_events`),
--      actor-scoped idempotency (`organization_department_idempotency`), and
--      advisory-locked overlap protection so a user never holds two active or
--      overlapping memberships in the same department.
--   3. Read-only projection of existing `public.teams` under `RECRUITMENT`
--      without adding columns/FKs, backfilling, or touching Team, Team Membership,
--      Team Leader, Project-Team Scope, Direct Entry actor resolution, capability/scope
--      grants, or Work Reports authority.
--   4. Minimal internal VFIN default authority primitive keyed strictly on
--      immutable `system_key = 'ACCOUNTING'` (never department name/code/login/email
--      or retired `payment_view`/`payment_edit` tokens).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Shared immutable guard & Department catalog (`public.organization_departments`).
-- -----------------------------------------------------------------------------
create or replace function public.org_department__internal_immutable_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  raise exception 'organization_department append-only table cannot be modified or deleted'
    using errcode = '55000';
end;
$function$;

create table if not exists public.organization_departments (
  department_id uuid primary key default gen_random_uuid(),
  system_key text not null unique
    constraint organization_departments_system_key_chk
    check (system_key in ('RECRUITMENT', 'ACCOUNTING')),
  code text not null unique
    constraint organization_departments_code_chk
    check (
      code = pg_catalog.btrim(code)
      and pg_catalog.length(code) between 2 and 64
      and code ~ '^[A-Z0-9][A-Z0-9_-]*$'
    ),
  name text not null unique
    constraint organization_departments_name_chk
    check (
      name = pg_catalog.btrim(name)
      and pg_catalog.length(name) between 1 and 256
      and name !~ '[\x00-\x1F\x7F]'
    ),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organization_departments enable row level security;
alter table public.organization_departments force row level security;

create or replace function public.org_department__internal_guard_department()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'system department cannot be hard-deleted'
      using errcode = '55000';
  end if;

  if new.department_id <> old.department_id
     or new.system_key <> old.system_key
     or new.created_at <> old.created_at then
    raise exception 'department identity and system_key are immutable'
      using errcode = '55000';
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists organization_departments_guard_trg
  on public.organization_departments;
create trigger organization_departments_guard_trg
  before update or delete on public.organization_departments
  for each row execute function public.org_department__internal_guard_department();

insert into public.organization_departments (system_key, code, name, is_active)
values
  ('RECRUITMENT', 'RECRUITMENT', 'Phòng Tuyển dụng', true),
  ('ACCOUNTING', 'ACCOUNTING', 'Phòng Kế toán', true)
on conflict (system_key) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Effective-dated memberships, append-only audit, and idempotency ledger.
-- -----------------------------------------------------------------------------
create table if not exists public.organization_department_memberships (
  membership_id uuid primary key default gen_random_uuid(),
  department_id uuid not null
    references public.organization_departments(department_id) on delete restrict,
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  valid_from date not null,
  valid_to date null,
  version integer not null
    constraint organization_department_memberships_version_chk
    check (version >= 1),
  granted_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  grant_reason text not null
    constraint organization_department_memberships_grant_reason_chk
    check (
      grant_reason = pg_catalog.btrim(grant_reason)
      and pg_catalog.length(grant_reason) between 1 and 4000
      and grant_reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  revoked_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  revoke_reason text null
    constraint organization_department_memberships_revoke_reason_chk
    check (
      revoke_reason is null
      or (
        revoke_reason = pg_catalog.btrim(revoke_reason)
        and pg_catalog.length(revoke_reason) between 1 and 4000
        and revoke_reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_department_memberships_interval_chk
    check (valid_to is null or valid_to >= valid_from),
  constraint organization_department_memberships_revocation_state_chk
    check (
      (
        valid_to is null
        and revoked_at is null
        and revoked_by_user_id is null
        and revoke_reason is null
      )
      or (
        valid_to is not null
        and revoked_at is not null
        and revoked_by_user_id is not null
        and revoke_reason is not null
      )
    ),
  constraint organization_department_memberships_pair_version_uk
    unique (department_id, app_user_id, version)
);

create unique index if not exists organization_department_memberships_open_pair_uidx
  on public.organization_department_memberships (department_id, app_user_id)
  where valid_to is null;

create index if not exists organization_department_memberships_dept_from_idx
  on public.organization_department_memberships (department_id, valid_from desc, membership_id desc);

create index if not exists organization_department_memberships_user_dept_idx
  on public.organization_department_memberships (app_user_id, department_id, valid_from desc);

alter table public.organization_department_memberships enable row level security;
alter table public.organization_department_memberships force row level security;

create or replace function public.org_department__internal_membership_accounting_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if not exists (
    select 1
      from public.organization_departments d
     where d.department_id = new.department_id
       and d.system_key = 'ACCOUNTING'
  ) then
    raise exception 'DEPARTMENT_MEMBERSHIP_UNSUPPORTED'
      using errcode = '22023';
  end if;
  return new;
end;
$function$;

create or replace function public.org_department__internal_membership_marker_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if new.valid_to is not null
     and new.valid_to = new.valid_from
     and coalesce(pg_catalog.current_setting('org_department.membership_cancel_marker', true), '') <> 'on' then
    raise exception 'zero-length department membership marker requires audited end RPC'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create or replace function public.org_department__internal_membership_no_overlap()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(new.department_id::text || ':' || new.app_user_id::text)
  );

  if exists (
    select 1
      from public.organization_department_memberships m
     where m.department_id = new.department_id
       and m.app_user_id = new.app_user_id
       and m.membership_id <> new.membership_id
       and pg_catalog.daterange(m.valid_from, m.valid_to, '[)')
           && pg_catalog.daterange(new.valid_from, new.valid_to, '[)')
  ) then
    raise exception 'DEPARTMENT_MEMBERSHIP_OVERLAP'
      using errcode = '23P01';
  end if;

  return new;
end;
$function$;

create or replace function public.org_department__internal_membership_history_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'department membership history is append-only'
      using errcode = '55000';
  end if;

  if new.membership_id <> old.membership_id
     or new.department_id <> old.department_id
     or new.app_user_id <> old.app_user_id
     or new.valid_from <> old.valid_from
     or new.granted_by_user_id <> old.granted_by_user_id
     or new.grant_reason <> old.grant_reason
     or new.created_at <> old.created_at then
    raise exception 'department membership identity is immutable'
      using errcode = '55000';
  end if;

  if old.valid_to is not null then
    raise exception 'ended department membership cannot be reopened or altered'
      using errcode = '55000';
  end if;

  if new.valid_to is null or new.version <> old.version + 1 then
    raise exception 'department membership close must set valid_to and increment version'
      using errcode = '55000';
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists a_organization_department_memberships_accounting_only_trg
  on public.organization_department_memberships;
create trigger a_organization_department_memberships_accounting_only_trg
  before insert or update on public.organization_department_memberships
  for each row execute function public.org_department__internal_membership_accounting_only();

drop trigger if exists b_organization_department_memberships_marker_guard_trg
  on public.organization_department_memberships;
create trigger b_organization_department_memberships_marker_guard_trg
  before insert or update on public.organization_department_memberships
  for each row execute function public.org_department__internal_membership_marker_guard();

drop trigger if exists c_organization_department_memberships_no_overlap_trg
  on public.organization_department_memberships;
create trigger c_organization_department_memberships_no_overlap_trg
  before insert or update on public.organization_department_memberships
  for each row execute function public.org_department__internal_membership_no_overlap();

drop trigger if exists d_organization_department_memberships_history_guard_trg
  on public.organization_department_memberships;
create trigger d_organization_department_memberships_history_guard_trg
  before update or delete on public.organization_department_memberships
  for each row execute function public.org_department__internal_membership_history_guard();

create table if not exists public.organization_department_audit_events (
  audit_event_id uuid primary key default gen_random_uuid(),
  department_id uuid not null
    references public.organization_departments(department_id) on delete restrict,
  membership_id uuid not null
    references public.organization_department_memberships(membership_id) on delete restrict,
  target_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  action text not null
    constraint organization_department_audit_events_action_chk
    check (action in ('ACCOUNTING_MEMBER_ASSIGNED', 'ACCOUNTING_MEMBER_ENDED')),
  reason text not null
    constraint organization_department_audit_events_reason_chk
    check (
      reason = pg_catalog.btrim(reason)
      and pg_catalog.length(reason) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  before_snapshot jsonb null,
  after_snapshot jsonb not null,
  idempotency_key uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists organization_department_audit_events_dept_created_idx
  on public.organization_department_audit_events (department_id, created_at desc);

create index if not exists organization_department_audit_events_target_created_idx
  on public.organization_department_audit_events (target_app_user_id, created_at desc);

alter table public.organization_department_audit_events enable row level security;
alter table public.organization_department_audit_events force row level security;

drop trigger if exists organization_department_audit_events_immutable_trg
  on public.organization_department_audit_events;
create trigger organization_department_audit_events_immutable_trg
  before update or delete on public.organization_department_audit_events
  for each row execute function public.org_department__internal_immutable_guard();

create table if not exists public.organization_department_idempotency (
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  idempotency_key uuid not null,
  action text not null
    constraint organization_department_idempotency_action_chk
    check (action in ('ACCOUNTING_MEMBER_ASSIGNED', 'ACCOUNTING_MEMBER_ENDED')),
  request_fingerprint text not null
    constraint organization_department_idempotency_fp_chk
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_user_id, idempotency_key)
);

alter table public.organization_department_idempotency enable row level security;
alter table public.organization_department_idempotency force row level security;

drop trigger if exists organization_department_idempotency_immutable_trg
  on public.organization_department_idempotency;
create trigger organization_department_idempotency_immutable_trg
  before update or delete on public.organization_department_idempotency
  for each row execute function public.org_department__internal_immutable_guard();

-- -----------------------------------------------------------------------------
-- 3. Internal projections & minimal VFIN default authority primitives.
-- -----------------------------------------------------------------------------
create or replace function public.org_department__internal_account_summary(
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_linked_name text;
  v_personnel_code text;
  v_login_id text;
begin
  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found then
    return null;
  end if;

  select r.display_name, r.personnel_code
    into v_linked_name, v_personnel_code
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.app_user_id = v_user.app_user_id
     and l.verified = true
     and l.is_current = true
   order by l.valid_from desc, l.link_id desc
   limit 1;

  select pg_catalog.lower(
           nullif(
             pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), '@', 1),
             ''
           )
         )
    into v_login_id
    from auth.users au
   where au.id = v_user.auth_subject;

  return pg_catalog.jsonb_build_object(
    'account_ref', v_user.app_user_id,
    'display_name', coalesce(v_linked_name, v_user.display_name),
    'login_id', v_login_id,
    'personnel_code', v_personnel_code,
    'account_enabled', v_user.enabled
  );
end;
$function$;

create or replace function public.org_department__internal_department_projection(
  p_department public.organization_departments,
  p_as_of date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_active_member_count integer := null;
  v_team_count integer := null;
  v_active_team_count integer := null;
begin
  if p_department.system_key = 'ACCOUNTING' then
    select count(*)::integer
      into v_active_member_count
      from public.organization_department_memberships m
      join public.direct_entry_app_users u
        on u.app_user_id = m.app_user_id
       and u.enabled = true
     where m.department_id = p_department.department_id
       and m.valid_from <= p_as_of
       and (m.valid_to is null or p_as_of < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from);
  elsif p_department.system_key = 'RECRUITMENT' then
    select count(*)::integer,
           count(*) filter (where t.active)::integer
      into v_team_count, v_active_team_count
      from public.teams t
     where t.code <> '__system_vendor__';
  end if;

  return pg_catalog.jsonb_build_object(
    'department_id', p_department.department_id,
    'system_key', p_department.system_key,
    'code', p_department.code,
    'name', p_department.name,
    'is_active', p_department.is_active,
    'membership_mode', case p_department.system_key
      when 'ACCOUNTING' then 'MANAGED_MEMBERSHIP'
      else 'READ_ONLY_TEAMS_PROJECTION'
    end,
    'default_policy_code', case p_department.system_key
      when 'ACCOUNTING' then 'VENDOR_FINANCE_VIEW_AND_RECORD'
      else 'EXISTING_TEAM_AUTHORITY_READ_ONLY'
    end,
    'active_member_count', v_active_member_count,
    'team_count', v_team_count,
    'active_team_count', v_active_team_count,
    'created_at', pg_catalog.to_char(p_department.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(p_department.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$function$;

create or replace function public.org_department__internal_membership_projection(
  p_membership public.organization_department_memberships,
  p_pair_version integer,
  p_as_of date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_account jsonb;
  v_dept_active boolean := false;
  v_granted_by jsonb;
  v_revoked_by jsonb := null;
  v_state text;
  v_interval_active boolean := false;
  v_account_enabled boolean := false;
begin
  v_account := public.org_department__internal_account_summary(p_membership.app_user_id);
  v_granted_by := public.org_department__internal_account_summary(p_membership.granted_by_user_id);
  if p_membership.revoked_by_user_id is not null then
    v_revoked_by := public.org_department__internal_account_summary(p_membership.revoked_by_user_id);
  end if;

  select d.is_active
    into v_dept_active
    from public.organization_departments d
   where d.department_id = p_membership.department_id;

  if p_membership.valid_to is not null
     and (p_membership.valid_to = p_membership.valid_from or p_as_of >= p_membership.valid_to) then
    v_state := 'HISTORY';
    v_interval_active := false;
  elsif p_membership.valid_from > p_as_of then
    v_state := 'SCHEDULED';
    v_interval_active := false;
  else
    v_state := 'CURRENT';
    v_interval_active := true;
  end if;

  v_account_enabled := coalesce((v_account->>'account_enabled')::boolean, false);

  return pg_catalog.jsonb_build_object(
    'membership_id', p_membership.membership_id,
    'department_id', p_membership.department_id,
    'account_ref', p_membership.app_user_id,
    'display_name', coalesce(v_account->>'display_name', ''),
    'login_id', v_account->'login_id',
    'personnel_code', v_account->'personnel_code',
    'account_enabled', v_account_enabled,
    'valid_from', p_membership.valid_from::text,
    'valid_to', case when p_membership.valid_to is null then null else p_membership.valid_to::text end,
    'state', v_state,
    'effective', (v_interval_active and v_account_enabled and coalesce(v_dept_active, false)),
    'version', p_membership.version,
    'pair_version', p_pair_version,
    'granted_by_display_name', coalesce(v_granted_by->>'display_name', ''),
    'revoked_by_display_name', case when v_revoked_by is null then null else v_revoked_by->>'display_name' end,
    'revoked_at', case
      when p_membership.revoked_at is null then null
      else pg_catalog.to_char(p_membership.revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    end,
    'created_at', pg_catalog.to_char(p_membership.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(p_membership.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$function$;

create or replace function public.org_department__internal_has_active_membership(
  p_app_user_id uuid,
  p_system_key text,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
     and p_system_key is not null
     and p_as_of is not null
     and exists (
       select 1
         from public.organization_department_memberships m
         join public.organization_departments d
           on d.department_id = m.department_id
          and d.system_key = p_system_key
          and d.is_active = true
         join public.direct_entry_app_users u
           on u.app_user_id = m.app_user_id
          and u.enabled = true
        where m.app_user_id = p_app_user_id
          and m.valid_from <= p_as_of
          and (m.valid_to is null or p_as_of < m.valid_to)
          and (m.valid_to is null or m.valid_to > m.valid_from)
     );
$function$;

create or replace function public.org_department__internal_resolve_vfin_default_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of date := coalesce(p_as_of, public.direct_entry_authorization_date());
  v_full_admin boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_full_admin := public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
    and public.direct_entry_has_scope(p_app_user_id, 'all');

  if v_full_admin then
    return pg_catalog.jsonb_build_object(
      'allowed', true,
      'authority_source', 'full_admin',
      'can_view', true,
      'can_record', true
    );
  end if;

  if public.org_department__internal_has_active_membership(p_app_user_id, 'ACCOUNTING', v_as_of) then
    return pg_catalog.jsonb_build_object(
      'allowed', true,
      'authority_source', 'accounting_department',
      'can_view', true,
      'can_record', true
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'allowed', false,
    'authority_source', 'none',
    'can_view', false,
    'can_record', false
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Service-role-only Full Admin RPCs.
-- -----------------------------------------------------------------------------
create or replace function public.org_department_list_departments_admin(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_departments jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  select coalesce(
           pg_catalog.jsonb_agg(
             public.org_department__internal_department_projection(d, v_today)
             order by
               case d.system_key
                 when 'RECRUITMENT' then 1
                 when 'ACCOUNTING' then 2
                 else 99
               end,
               d.department_id
           ),
           '[]'::jsonb
         )
    into v_departments
    from public.organization_departments d;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'departments', v_departments
  );
end;
$function$;

create or replace function public.org_department_get_department_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_department public.organization_departments%rowtype;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null then
    raise exception 'DEPARTMENT_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_today := public.direct_entry_authorization_date();

  select d.*
    into v_department
    from public.organization_departments d
   where d.department_id = p_department_id;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'department', public.org_department__internal_department_projection(v_department, v_today)
  );
end;
$function$;

create or replace function public.org_department_list_accounting_memberships_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_include_history boolean default false,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_dept public.organization_departments%rowtype;
  v_search text;
  v_offset integer;
  v_total integer;
  v_memberships jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_include_history is null
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'DEPARTMENT_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = ''
       or pg_catalog.length(v_search) > 120
       or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'DEPARTMENT_SEARCH_INVALID'
        using errcode = '22023';
    end if;
  else
    v_search := null;
  end if;

  v_today := public.direct_entry_authorization_date();
  v_offset := (p_page - 1) * p_page_size;

  select d.*
    into v_dept
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING';

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  with enriched as (
    select m as membership_row,
           m.membership_id,
           m.valid_from,
           m.valid_to,
           coalesce(pv.max_version, m.version) as pair_version,
           coalesce(linked.display_name, u.display_name) as resolved_name,
           pg_catalog.lower(
             nullif(
               pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), '@', 1),
               ''
             )
           ) as resolved_login,
           linked.personnel_code as resolved_code,
           case
             when m.valid_to is not null and (m.valid_to = m.valid_from or v_today >= m.valid_to) then 3
             when m.valid_from > v_today then 2
             else 1
           end as state_rank
      from public.organization_department_memberships m
      join public.direct_entry_app_users u
        on u.app_user_id = m.app_user_id
      join auth.users au
        on au.id = u.auth_subject
      left join lateral (
        select r.display_name, r.personnel_code
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiters r on r.recruiter_id = l.recruiter_id
         where l.app_user_id = u.app_user_id
           and l.verified = true
           and l.is_current = true
         order by l.valid_from desc, l.link_id desc
         limit 1
      ) linked on true
      left join lateral (
        select max(m2.version)::integer as max_version
          from public.organization_department_memberships m2
         where m2.department_id = m.department_id
           and m2.app_user_id = m.app_user_id
      ) pv on true
     where m.department_id = v_dept.department_id
       and (
         p_include_history
         or (
           (m.valid_to is null or v_today < m.valid_to)
           and (m.valid_to is null or m.valid_to > m.valid_from)
         )
       )
       and (
         v_search is null
         or coalesce(linked.display_name, u.display_name) ilike '%' || v_search || '%'
         or coalesce(
              pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), '@', 1),
              ''
            ) ilike '%' || v_search || '%'
         or coalesce(linked.personnel_code, '') ilike '%' || v_search || '%'
       )
  )
  select (select count(*)::integer from enriched),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      public.org_department__internal_membership_projection(
                        page_row.membership_row,
                        page_row.pair_version,
                        v_today
                      )
                      order by
                        page_row.state_rank asc,
                        page_row.valid_from desc,
                        pg_catalog.lower(page_row.resolved_name) asc,
                        page_row.membership_id desc
                    )
               from (
                 select e.*
                   from enriched e
                  order by
                    e.state_rank asc,
                    e.valid_from desc,
                    pg_catalog.lower(e.resolved_name) asc,
                    e.membership_id desc
                  limit p_page_size offset v_offset
               ) page_row
           ),
           '[]'::jsonb
         )
    into v_total, v_memberships;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'department_id', v_dept.department_id,
    'include_history', p_include_history,
    'search', v_search,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'memberships', v_memberships
  );
end;
$function$;

create or replace function public.org_department_list_accounting_candidates_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_dept public.organization_departments%rowtype;
  v_search text;
  v_offset integer;
  v_total integer;
  v_candidates jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'DEPARTMENT_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = ''
       or pg_catalog.length(v_search) > 120
       or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'DEPARTMENT_SEARCH_INVALID'
        using errcode = '22023';
    end if;
  else
    v_search := null;
  end if;

  v_today := public.direct_entry_authorization_date();
  v_offset := (p_page - 1) * p_page_size;

  select d.*
    into v_dept
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING';

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  with candidate_pool as (
    select u.app_user_id as account_ref,
           coalesce(linked.display_name, u.display_name) as display_name,
           pg_catalog.lower(
             nullif(
               pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), '@', 1),
               ''
             )
           ) as login_id,
           linked.personnel_code as personnel_code,
           u.enabled as account_enabled,
           (open_m.membership_id is not null and open_m.valid_from <= v_today) as has_active_membership,
           open_m.membership_id as open_membership_id,
           coalesce(pv.max_version, 0) as pair_version
      from public.direct_entry_app_users u
      join auth.users au
        on au.id = u.auth_subject
      left join lateral (
        select r.display_name, r.personnel_code
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiters r on r.recruiter_id = l.recruiter_id
         where l.app_user_id = u.app_user_id
           and l.verified = true
           and l.is_current = true
         order by l.valid_from desc, l.link_id desc
         limit 1
      ) linked on true
      left join lateral (
        select m.membership_id, m.valid_from
          from public.organization_department_memberships m
         where m.department_id = v_dept.department_id
           and m.app_user_id = u.app_user_id
           and m.valid_to is null
         limit 1
      ) open_m on true
      left join lateral (
        select max(m2.version)::integer as max_version
          from public.organization_department_memberships m2
         where m2.department_id = v_dept.department_id
           and m2.app_user_id = u.app_user_id
      ) pv on true
     where u.enabled = true
       and (
         v_search is null
         or coalesce(linked.display_name, u.display_name) ilike '%' || v_search || '%'
         or coalesce(
              pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), '@', 1),
              ''
            ) ilike '%' || v_search || '%'
         or coalesce(linked.personnel_code, '') ilike '%' || v_search || '%'
       )
  )
  select (select count(*)::integer from candidate_pool),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'account_ref', c.account_ref,
                        'display_name', c.display_name,
                        'login_id', c.login_id,
                        'personnel_code', c.personnel_code,
                        'account_enabled', c.account_enabled,
                        'has_active_membership', c.has_active_membership,
                        'open_membership_id', c.open_membership_id,
                        'pair_version', c.pair_version
                      )
                      order by
                        pg_catalog.lower(c.display_name) asc,
                        coalesce(c.login_id, '') asc,
                        c.account_ref asc
                    )
               from (
                 select cp.*
                   from candidate_pool cp
                  order by
                    pg_catalog.lower(cp.display_name) asc,
                    coalesce(cp.login_id, '') asc,
                    cp.account_ref asc
                  limit p_page_size offset v_offset
               ) c
           ),
           '[]'::jsonb
         )
    into v_total, v_candidates;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'department_id', v_dept.department_id,
    'search', v_search,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'candidates', v_candidates
  );
end;
$function$;

create or replace function public.org_department_assign_accounting_member(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_pair_version integer,
  p_effective_from date,
  p_reason text,
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
  v_today date;
  v_effective_from date;
  v_reason text;
  v_dept public.organization_departments%rowtype;
  v_idem public.organization_department_idempotency%rowtype;
  v_target public.direct_entry_app_users%rowtype;
  v_current_pair_version integer;
  v_inserted public.organization_department_memberships%rowtype;
  v_projection jsonb;
  v_base_payload jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_target_app_user_id is null
     or p_expected_pair_version is null
     or p_expected_pair_version < 0
     or p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case when p_reason is null then null else pg_catalog.btrim(p_reason) end;
  if v_reason is null
     or pg_catalog.length(v_reason) not between 1 and 4000
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'DEPARTMENT_MEMBERSHIP_REASON_INVALID'
      using errcode = '22023';
  end if;

  v_today := public.direct_entry_authorization_date();
  v_effective_from := coalesce(p_effective_from, v_today);

  select d.*
    into v_dept
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING'
   for update;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not v_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_idem_v1'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  select i.*
    into v_idem
    from public.organization_department_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_idem.action <> 'ACCOUNTING_MEMBER_ASSIGNED'
       or v_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(v_dept.department_id::text || ':' || p_target_app_user_id::text)
  );

  select u.*
    into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not v_target.enabled then
    raise exception 'TARGET_ACCOUNT_DISABLED'
      using errcode = '23514';
  end if;

  select coalesce(max(m.version), 0)::integer
    into v_current_pair_version
    from public.organization_department_memberships m
   where m.department_id = v_dept.department_id
     and m.app_user_id = p_target_app_user_id;

  if v_current_pair_version <> p_expected_pair_version then
    raise exception 'DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT'
      using errcode = '40001';
  end if;

  if exists (
    select 1
      from public.organization_department_memberships m
     where m.department_id = v_dept.department_id
       and m.app_user_id = p_target_app_user_id
       and (
         m.valid_to is null
         or pg_catalog.daterange(m.valid_from, m.valid_to, '[)')
            && pg_catalog.daterange(v_effective_from, null, '[)')
       )
  ) then
    raise exception 'DEPARTMENT_MEMBERSHIP_OVERLAP'
      using errcode = '23P01';
  end if;

  insert into public.organization_department_memberships (
    department_id,
    app_user_id,
    valid_from,
    valid_to,
    version,
    granted_by_user_id,
    grant_reason
  ) values (
    v_dept.department_id,
    p_target_app_user_id,
    v_effective_from,
    null,
    v_current_pair_version + 1,
    p_app_user_id,
    v_reason
  )
  returning * into v_inserted;

  v_projection := public.org_department__internal_membership_projection(
    v_inserted,
    v_inserted.version,
    v_today
  );

  insert into public.organization_department_audit_events (
    department_id,
    membership_id,
    target_app_user_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key
  ) values (
    v_dept.department_id,
    v_inserted.membership_id,
    p_target_app_user_id,
    p_app_user_id,
    'ACCOUNTING_MEMBER_ASSIGNED',
    v_reason,
    null,
    v_projection,
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object('membership', v_projection);

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ACCOUNTING_MEMBER_ASSIGNED',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.org_department_end_accounting_member(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_membership_id uuid,
  p_expected_pair_version integer,
  p_effective_to date,
  p_reason text,
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
  v_today date;
  v_effective_to date;
  v_reason text;
  v_dept public.organization_departments%rowtype;
  v_idem public.organization_department_idempotency%rowtype;
  v_target_user_id uuid;
  v_target public.direct_entry_app_users%rowtype;
  v_membership public.organization_department_memberships%rowtype;
  v_updated public.organization_department_memberships%rowtype;
  v_current_pair_version integer;
  v_before jsonb;
  v_after jsonb;
  v_base_payload jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_membership_id is null
     or p_expected_pair_version is null
     or p_expected_pair_version < 1
     or p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case when p_reason is null then null else pg_catalog.btrim(p_reason) end;
  if v_reason is null
     or pg_catalog.length(v_reason) not between 1 and 4000
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'DEPARTMENT_MEMBERSHIP_REASON_INVALID'
      using errcode = '22023';
  end if;

  v_today := public.direct_entry_authorization_date();

  select d.*
    into v_dept
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING'
   for update;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_idem_v1'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  select i.*
    into v_idem
    from public.organization_department_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_idem.action <> 'ACCOUNTING_MEMBER_ENDED'
       or v_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select m.app_user_id
    into v_target_user_id
    from public.organization_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = v_dept.department_id;

  if not found then
    raise exception 'DEPARTMENT_MEMBERSHIP_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(v_dept.department_id::text || ':' || v_target_user_id::text)
  );

  select u.*
    into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = v_target_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select m.*
    into v_membership
    from public.organization_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = v_dept.department_id
   for update;

  if not found then
    raise exception 'DEPARTMENT_MEMBERSHIP_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select coalesce(max(m.version), 0)::integer
    into v_current_pair_version
    from public.organization_department_memberships m
   where m.department_id = v_dept.department_id
     and m.app_user_id = v_target_user_id;

  if v_current_pair_version <> p_expected_pair_version
     or v_membership.version <> p_expected_pair_version then
    raise exception 'DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT'
      using errcode = '40001';
  end if;

  if v_membership.valid_to is not null then
    raise exception 'DEPARTMENT_MEMBERSHIP_ALREADY_ENDED'
      using errcode = '40001';
  end if;

  if p_effective_to is not null and p_effective_to > v_today then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_effective_to is not null and p_effective_to < v_membership.valid_from then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_effective_to := greatest(coalesce(p_effective_to, v_today), v_membership.valid_from);

  v_before := public.org_department__internal_membership_projection(
    v_membership,
    v_current_pair_version,
    v_today
  );

  if v_effective_to = v_membership.valid_from then
    perform pg_catalog.set_config('org_department.membership_cancel_marker', 'on', true);
  end if;

  update public.organization_department_memberships
     set valid_to = v_effective_to,
         revoked_by_user_id = p_app_user_id,
         revoke_reason = v_reason,
         revoked_at = now(),
         version = v_current_pair_version + 1
   where membership_id = p_membership_id
  returning * into v_updated;

  v_after := public.org_department__internal_membership_projection(
    v_updated,
    v_updated.version,
    v_today
  );

  insert into public.organization_department_audit_events (
    department_id,
    membership_id,
    target_app_user_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key
  ) values (
    v_dept.department_id,
    v_updated.membership_id,
    v_target_user_id,
    p_app_user_id,
    'ACCOUNTING_MEMBER_ENDED',
    v_reason,
    v_before,
    v_after,
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object('membership', v_after);

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ACCOUNTING_MEMBER_ENDED',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.org_department_list_recruitment_teams_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_include_inactive boolean default true,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_dept public.organization_departments%rowtype;
  v_search text;
  v_offset integer;
  v_total integer;
  v_teams jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_include_inactive is null
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'DEPARTMENT_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = ''
       or pg_catalog.length(v_search) > 120
       or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'DEPARTMENT_SEARCH_INVALID'
        using errcode = '22023';
    end if;
  else
    v_search := null;
  end if;

  v_today := public.direct_entry_authorization_date();
  v_offset := (p_page - 1) * p_page_size;

  select d.*
    into v_dept
    from public.organization_departments d
   where d.system_key = 'RECRUITMENT';

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select count(*)::integer
    into v_total
    from public.teams t
   where t.code <> '__system_vendor__'
     and (p_include_inactive or t.active)
     and (
       v_search is null
       or t.code ilike '%' || v_search || '%'
       or t.display_name ilike '%' || v_search || '%'
     );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'team_id', page_team.team_id,
               'code', page_team.code,
               'display_name', page_team.display_name,
               'active', page_team.active,
               'version', page_team.version
             )
             order by pg_catalog.lower(page_team.code) asc, page_team.team_id asc
           ),
           '[]'::jsonb
         )
    into v_teams
    from (
      select t.team_id, t.code, t.display_name, t.active, t.version
        from public.teams t
       where t.code <> '__system_vendor__'
         and (p_include_inactive or t.active)
         and (
           v_search is null
           or t.code ilike '%' || v_search || '%'
           or t.display_name ilike '%' || v_search || '%'
         )
       order by pg_catalog.lower(t.code) asc, t.team_id asc
       limit p_page_size offset v_offset
    ) page_team;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'department_id', v_dept.department_id,
    'system_key', v_dept.system_key,
    'include_inactive', p_include_inactive,
    'search', v_search,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'teams', v_teams
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Owner alignment & helper EXECUTE privileges (`s0_t1c_runner` & `postgres` safe).
-- -----------------------------------------------------------------------------
do $align_org_shell_01_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_rel text;
  v_rel_owner_oid oid;
  v_sig text;
  v_proc_owner_oid oid;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  foreach v_rel in array array[
    'public.organization_departments',
    'public.organization_department_memberships',
    'public.organization_department_audit_events',
    'public.organization_department_idempotency'
  ]
  loop
    select c.relowner
      into v_rel_owner_oid
      from pg_catalog.pg_class c
     where c.oid = pg_catalog.to_regclass(v_rel);

    if v_rel_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter table %s owner to %I', v_rel, v_base_owner);
    end if;
  end loop;

  foreach v_sig in array array[
    'public.org_department__internal_immutable_guard()',
    'public.org_department__internal_guard_department()',
    'public.org_department__internal_membership_accounting_only()',
    'public.org_department__internal_membership_marker_guard()',
    'public.org_department__internal_membership_no_overlap()',
    'public.org_department__internal_membership_history_guard()',
    'public.org_department__internal_account_summary(uuid)',
    'public.org_department__internal_department_projection(public.organization_departments, date)',
    'public.org_department__internal_membership_projection(public.organization_department_memberships, integer, date)',
    'public.org_department__internal_has_active_membership(uuid, text, date)',
    'public.org_department__internal_resolve_vfin_default_authority(uuid, uuid, date)',
    'public.org_department_list_departments_admin(uuid, uuid)',
    'public.org_department_get_department_admin(uuid, uuid, uuid)',
    'public.org_department_list_accounting_memberships_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.org_department_list_accounting_candidates_admin(uuid, uuid, text, integer, integer)',
    'public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_list_recruitment_teams_admin(uuid, uuid, text, boolean, integer, integer)'
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
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname like 'org_department_%'
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_app_user_admin(uuid, uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_mapping(uuid, uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_scope(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_authorization_date() to %I',
      v_owner
    );
  end loop;
end;
$align_org_shell_01_owners$;

-- -----------------------------------------------------------------------------
-- 6. Strict table & function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on table public.organization_departments
  from public, anon, authenticated, service_role;

revoke all on table public.organization_department_memberships
  from public, anon, authenticated, service_role;

revoke all on table public.organization_department_audit_events
  from public, anon, authenticated, service_role;

revoke all on table public.organization_department_idempotency
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_immutable_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_guard_department()
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_membership_accounting_only()
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_membership_marker_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_membership_no_overlap()
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_membership_history_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_account_summary(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_department_projection(public.organization_departments, date)
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_membership_projection(public.organization_department_memberships, integer, date)
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_has_active_membership(uuid, text, date)
  from public, anon, authenticated, service_role;

revoke all on function public.org_department__internal_resolve_vfin_default_authority(uuid, uuid, date)
  from public, anon, authenticated, service_role;

revoke all on function public.org_department_list_departments_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_list_departments_admin(uuid, uuid)
  to service_role;

revoke all on function public.org_department_get_department_admin(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_get_department_admin(uuid, uuid, uuid)
  to service_role;

revoke all on function public.org_department_list_accounting_memberships_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_list_accounting_memberships_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;

revoke all on function public.org_department_list_accounting_candidates_admin(uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_list_accounting_candidates_admin(uuid, uuid, text, integer, integer)
  to service_role;

revoke all on function public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)
  to service_role;

revoke all on function public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)
  to service_role;

revoke all on function public.org_department_list_recruitment_teams_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_list_recruitment_teams_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;

-- -----------------------------------------------------------------------------
-- 7. Data-free install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $check_org_shell_01$
declare
  v_seed_count integer;
  v_tbl pg_catalog.regclass;
  v_rls boolean;
  v_force_rls boolean;
  v_policy_count integer;
  v_exposed_table_acl integer;
  v_internal_fn pg_catalog.regprocedure;
  v_rpc_fn pg_catalog.regprocedure;
  v_secdef boolean;
  v_config text;
  v_owner_bypasses_rls boolean;
begin
  select count(*)::integer
    into v_seed_count
    from public.organization_departments d
   where d.system_key in ('RECRUITMENT', 'ACCOUNTING');

  if v_seed_count <> 2 then
    raise exception 'ORG-SHELL-01 system department seed failed (expected 2, got %)', v_seed_count
      using errcode = '55000';
  end if;

  foreach v_tbl in array array[
    'public.organization_departments'::pg_catalog.regclass,
    'public.organization_department_memberships'::pg_catalog.regclass,
    'public.organization_department_audit_events'::pg_catalog.regclass,
    'public.organization_department_idempotency'::pg_catalog.regclass
  ]
  loop
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
     where c.oid = v_tbl;

    if not coalesce(v_rls, false)
       or not coalesce(v_force_rls, false)
       or coalesce(v_policy_count, -1) <> 0
       or coalesce(v_exposed_table_acl, -1) <> 0
       or pg_catalog.has_table_privilege('public', v_tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or pg_catalog.has_table_privilege('anon', v_tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or pg_catalog.has_table_privilege('authenticated', v_tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or pg_catalog.has_table_privilege('service_role', v_tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      raise exception 'ORG-SHELL-01 table RLS/ACL boundary drift on %', v_tbl
        using errcode = '55000';
    end if;
  end loop;

  foreach v_internal_fn in array array[
    'public.org_department__internal_immutable_guard()'::pg_catalog.regprocedure,
    'public.org_department__internal_guard_department()'::pg_catalog.regprocedure,
    'public.org_department__internal_membership_accounting_only()'::pg_catalog.regprocedure,
    'public.org_department__internal_membership_marker_guard()'::pg_catalog.regprocedure,
    'public.org_department__internal_membership_no_overlap()'::pg_catalog.regprocedure,
    'public.org_department__internal_membership_history_guard()'::pg_catalog.regprocedure,
    'public.org_department__internal_account_summary(uuid)'::pg_catalog.regprocedure,
    'public.org_department__internal_department_projection(public.organization_departments, date)'::pg_catalog.regprocedure,
    'public.org_department__internal_membership_projection(public.organization_department_memberships, integer, date)'::pg_catalog.regprocedure,
    'public.org_department__internal_has_active_membership(uuid, text, date)'::pg_catalog.regprocedure,
    'public.org_department__internal_resolve_vfin_default_authority(uuid, uuid, date)'::pg_catalog.regprocedure
  ]
  loop
    if pg_catalog.has_function_privilege('public', v_internal_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_internal_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_internal_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_internal_fn, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_internal_fn),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_internal_fn))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       ) then
      raise exception 'ORG-SHELL-01 internal routine must stay revoked from all runtime roles: %', v_internal_fn
        using errcode = '55000';
    end if;
  end loop;

  foreach v_rpc_fn in array array[
    'public.org_department_list_departments_admin(uuid, uuid)'::pg_catalog.regprocedure,
    'public.org_department_get_department_admin(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.org_department_list_accounting_memberships_admin(uuid, uuid, text, boolean, integer, integer)'::pg_catalog.regprocedure,
    'public.org_department_list_accounting_candidates_admin(uuid, uuid, text, integer, integer)'::pg_catalog.regprocedure,
    'public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.org_department_list_recruitment_teams_admin(uuid, uuid, text, boolean, integer, integer)'::pg_catalog.regprocedure
  ]
  loop
    select p.prosecdef,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           (r.rolsuper or r.rolbypassrls)
      into v_secdef, v_config, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_rpc_fn;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or not coalesce(v_owner_bypasses_rls, false) then
      raise exception 'ORG-SHELL-01 RPC security definer owner/RLS/search_path drift on %', v_rpc_fn
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_rpc_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_rpc_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_rpc_fn, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_rpc_fn),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_rpc_fn))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege('service_role', v_rpc_fn, 'EXECUTE') then
      raise exception 'ORG-SHELL-01 RPC EXECUTE ACL drift on %', v_rpc_fn
        using errcode = '55000';
    end if;
  end loop;
end;
$check_org_shell_01$;

commit;
