-- =============================================================================
-- LEAVE-WP1 — Leave Management Backend Foundation (Schema, Ledger, Routing & RPCs)
--
-- Scope:
--   1. Module-scoped leave policy configuration (`leave_policy_configs`, `leave_policy_revisions`)
--      with initial `carry_over_expiry_month = NULL, carry_over_expiry_day = NULL`
--      (requires explicit Admin/BoD configuration before applying carry-over lots).
--   2. Employee leave profiles (`leave_employee_profiles`) with explicit shared-account
--      exclusion (`is_shared_non_employee`), module-scoped leave routing classification
--      (`leave_unit_kind`), employment lifecycle (`UNCONFIGURED`, `PROBATION`, `OFFICIAL`,
--      `INACTIVE`), `work_start_date`, `official_effective_date`, and per-employee
--      configurable next seniority effective date & units.
--   3. Marketing/IT Department Approver configuration (`leave_department_approvers`)
--      and narrow module-specific role grants (`leave_module_grants`: `HR_REPORT_VIEWER`,
--      `HR_LEAVE_OPERATOR`, `LEAVE_ADMIN_BOD_APPROVER`) with zero seeded HR accounts.
--   4. Append-only FIFO leave entitlement lots (`leave_lots`), opening balance batches
--      (`leave_opening_batches`), request/day records (`leave_requests`, `leave_request_days`),
--      lot allocations (`leave_request_lot_allocations`), immutable ledger (`leave_ledger_entries`),
--      audit log (`leave_audit_events`), and idempotency store (`leave_idempotency_records`).
--   5. Forced RLS + default-deny on all tables; `SECURITY DEFINER` RPCs with locked
--      `search_path = pg_catalog, public` granted exclusively to `service_role`.
--   6. Does NOT alter existing RBAC capabilities, scopes, teams, departments, or other modules.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Core tables & constraints.
-- -----------------------------------------------------------------------------
create table if not exists public.leave_policy_configs (
  config_key text primary key default 'default'
    constraint leave_policy_configs_key_chk check (config_key = 'default'),
  annual_base_units integer not null default 24
    constraint leave_policy_configs_annual_base_chk check (annual_base_units = 24),
  monthly_accrual_units integer not null default 2
    constraint leave_policy_configs_monthly_accrual_chk check (monthly_accrual_units = 2),
  default_seniority_years integer not null default 5
    constraint leave_policy_configs_seniority_years_chk check (default_seniority_years = 5),
  default_seniority_step_units integer not null default 2
    constraint leave_policy_configs_seniority_units_chk check (default_seniority_step_units = 2),
  carry_over_expiry_month integer null
    constraint leave_policy_configs_expiry_month_chk
    check (carry_over_expiry_month is null or carry_over_expiry_month between 1 and 12),
  carry_over_expiry_day integer null
    constraint leave_policy_configs_expiry_day_chk
    check (carry_over_expiry_day is null or carry_over_expiry_day between 1 and 31),
  row_version integer not null default 1
    constraint leave_policy_configs_row_version_chk check (row_version >= 1),
  updated_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  updated_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  constraint leave_policy_configs_expiry_pair_chk check (
    (carry_over_expiry_month is null and carry_over_expiry_day is null)
    or (carry_over_expiry_month is not null and carry_over_expiry_day is not null)
  )
);

insert into public.leave_policy_configs (
  config_key,
  annual_base_units,
  monthly_accrual_units,
  default_seniority_years,
  default_seniority_step_units,
  carry_over_expiry_month,
  carry_over_expiry_day,
  row_version
)
values ('default', 24, 2, 5, 2, null, null, 1)
on conflict (config_key) do nothing;

create table if not exists public.leave_policy_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  config_key text not null default 'default',
  annual_base_units integer not null,
  monthly_accrual_units integer not null,
  default_seniority_years integer not null,
  default_seniority_step_units integer not null,
  carry_over_expiry_month integer null,
  carry_over_expiry_day integer null,
  reason text not null,
  changed_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now())
);

create table if not exists public.leave_employee_profiles (
  app_user_id uuid primary key
    references public.direct_entry_app_users(app_user_id) on delete cascade,
  is_shared_non_employee boolean not null default false,
  employment_status text not null default 'UNCONFIGURED'
    constraint leave_employee_profiles_status_chk
    check (employment_status in ('UNCONFIGURED', 'PROBATION', 'OFFICIAL')),
  unit_kind text not null default 'UNCLASSIFIED'
    constraint leave_employee_profiles_unit_kind_chk
    check (unit_kind in (
      'UNCLASSIFIED',
      'RECRUITMENT',
      'MARKETING',
      'IT',
      'ACCOUNTING',
      'MANAGEMENT_BOD'
    )),
  work_start_date date null,
  official_effective_date date null,
  next_seniority_effective_date date null,
  next_seniority_units integer not null default 0
    constraint leave_employee_profiles_seniority_units_chk
    check (next_seniority_units between 0 and 60),
  notes text null,
  row_version integer not null default 1
    constraint leave_employee_profiles_row_version_chk check (row_version >= 1),
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  updated_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  updated_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  constraint leave_employee_profiles_official_date_chk check (
    official_effective_date is null
    or work_start_date is null
    or official_effective_date >= work_start_date
  )
);

create table if not exists public.leave_department_approvers (
  approver_assignment_id uuid primary key default gen_random_uuid(),
  unit_kind text not null
    constraint leave_department_approvers_unit_kind_chk
    check (unit_kind in ('MARKETING', 'IT', 'ACCOUNTING')),
  approver_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id),
  valid_from date not null,
  valid_to date null
    constraint leave_department_approvers_valid_range_chk
    check (valid_to is null or valid_to > valid_from),
  is_current boolean not null default true,
  reason text not null,
  row_version integer not null default 1
    constraint leave_department_approvers_row_version_chk check (row_version >= 1),
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  updated_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  updated_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id)
);

create unique index if not exists leave_department_approvers_current_uidx
  on public.leave_department_approvers (unit_kind)
  where is_current = true;

create table if not exists public.leave_module_grants (
  grant_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete cascade,
  role_code text not null
    constraint leave_module_grants_role_code_chk
    check (role_code in (
      'HR_REPORT_VIEWER',
      'HR_LEAVE_OPERATOR',
      'LEAVE_ADMIN_BOD_APPROVER'
    )),
  valid_from date not null,
  valid_to date null
    constraint leave_module_grants_valid_range_chk
    check (valid_to is null or valid_to > valid_from),
  is_current boolean not null default true,
  reason text not null,
  row_version integer not null default 1
    constraint leave_module_grants_row_version_chk check (row_version >= 1),
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  updated_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  updated_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id)
);

create unique index if not exists leave_module_grants_current_uidx
  on public.leave_module_grants (app_user_id, role_code)
  where is_current = true;

create table if not exists public.leave_opening_batches (
  batch_id uuid primary key default gen_random_uuid(),
  leave_year integer not null
    constraint leave_opening_batches_year_chk check (leave_year between 2020 and 2100),
  batch_kind text not null
    constraint leave_opening_batches_kind_chk check (batch_kind in ('SINGLE', 'BULK')),
  row_count integer not null
    constraint leave_opening_batches_row_count_chk check (row_count >= 1),
  total_carry_over_units integer not null default 0
    constraint leave_opening_batches_carry_over_chk check (total_carry_over_units >= 0),
  total_opening_units integer not null default 0
    constraint leave_opening_batches_opening_chk check (total_opening_units >= 0),
  total_seniority_units integer not null default 0
    constraint leave_opening_batches_seniority_chk check (total_seniority_units >= 0),
  reason text not null,
  payload jsonb not null default '[]'::jsonb,
  applied_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  applied_by_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id)
);

create table if not exists public.leave_lots (
  lot_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete cascade,
  leave_year integer not null
    constraint leave_lots_year_chk check (leave_year between 2020 and 2100),
  lot_kind text not null
    constraint leave_lots_kind_chk check (lot_kind in (
      'CARRY_OVER',
      'OPENING_CURRENT_YEAR',
      'MONTHLY_ACCRUAL',
      'PROBATION_CATCHUP',
      'SENIORITY_GRANT',
      'MANUAL_ADJUSTMENT'
    )),
  accrual_month integer null
    constraint leave_lots_accrual_month_chk
    check (accrual_month is null or accrual_month between 1 and 12),
  granted_units integer not null
    constraint leave_lots_granted_units_chk check (granted_units > 0),
  reserved_units integer not null default 0
    constraint leave_lots_reserved_units_chk check (reserved_units >= 0),
  consumed_units integer not null default 0
    constraint leave_lots_consumed_units_chk check (consumed_units >= 0),
  expired_units integer not null default 0
    constraint leave_lots_expired_units_chk check (expired_units >= 0),
  usable_from_date date not null,
  expires_after_date date null,
  source_ref text not null,
  opening_batch_id uuid null
    references public.leave_opening_batches(batch_id),
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  updated_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  created_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  constraint leave_lots_units_conservation_chk check (
    reserved_units + consumed_units + expired_units <= granted_units
  )
);

create unique index if not exists leave_lots_monthly_accrual_uidx
  on public.leave_lots (app_user_id, leave_year, accrual_month)
  where lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP');

create unique index if not exists leave_lots_opening_kind_uidx
  on public.leave_lots (app_user_id, leave_year, lot_kind)
  where lot_kind in ('CARRY_OVER', 'OPENING_CURRENT_YEAR');

create index if not exists leave_lots_fifo_idx
  on public.leave_lots (
    app_user_id,
    expires_after_date asc nulls last,
    usable_from_date asc,
    created_at asc,
    lot_id asc
  );

create table if not exists public.leave_requests (
  request_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id),
  status text not null
    constraint leave_requests_status_chk check (status in (
      'PENDING',
      'APPROVED',
      'REJECTED',
      'WITHDRAWN',
      'CANCELLED'
    )),
  pay_treatment text not null
    constraint leave_requests_pay_treatment_chk check (pay_treatment in (
      'PAID_LEAVE',
      'UNPAID_PROBATION',
      'UNPAID_UNCONFIGURED_PROFILE'
    )),
  employment_status_snapshot text not null
    constraint leave_requests_emp_status_snapshot_chk
    check (employment_status_snapshot in ('UNCONFIGURED', 'PROBATION', 'OFFICIAL')),
  unit_kind_snapshot text not null
    constraint leave_requests_unit_kind_snapshot_chk
    check (unit_kind_snapshot in (
      'UNCLASSIFIED',
      'RECRUITMENT',
      'MARKETING',
      'IT',
      'ACCOUNTING',
      'MANAGEMENT_BOD'
    )),
  profile_configured_at_submit boolean not null default false,
  requested_units integer not null
    constraint leave_requests_requested_units_chk check (requested_units > 0),
  reason text not null,
  route_kind text not null
    constraint leave_requests_route_kind_chk check (route_kind in (
      'TEAM_LEADER',
      'DEPARTMENT_HEAD',
      'ADMIN_BOD_DIRECT',
      'ADMIN_BOD_FALLBACK'
    )),
  primary_approver_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  routed_team_id uuid null
    references public.teams(team_id),
  routed_team_code text null,
  routed_team_name text null,
  fallback_reason text null,
  submitted_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  decided_at timestamptz null,
  decided_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  decision_reason text null,
  cancelled_at timestamptz null,
  cancelled_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  cancellation_reason text null,
  row_version integer not null default 1
    constraint leave_requests_row_version_chk check (row_version >= 1),
  updated_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  constraint leave_requests_no_self_decision_chk check (
    decided_by_app_user_id is null or decided_by_app_user_id <> app_user_id
  )
);

create index if not exists leave_requests_user_idx
  on public.leave_requests (app_user_id, submitted_at desc);

create index if not exists leave_requests_status_route_idx
  on public.leave_requests (status, route_kind, primary_approver_app_user_id, submitted_at desc);

create table if not exists public.leave_request_days (
  request_day_id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.leave_requests(request_id) on delete cascade,
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id),
  leave_date date not null,
  session_code text not null
    constraint leave_request_days_session_code_chk
    check (session_code in ('FULL', 'AM', 'PM')),
  half_day_units integer not null
    constraint leave_request_days_half_day_units_chk check (
      (session_code = 'FULL' and half_day_units = 2)
      or (session_code in ('AM', 'PM') and half_day_units = 1)
    ),
  is_active boolean not null default true,
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  constraint leave_request_days_request_date_uidx unique (request_id, leave_date)
);

create unique index if not exists leave_request_days_active_am_uidx
  on public.leave_request_days (app_user_id, leave_date)
  where is_active = true and session_code in ('FULL', 'AM');

create unique index if not exists leave_request_days_active_pm_uidx
  on public.leave_request_days (app_user_id, leave_date)
  where is_active = true and session_code in ('FULL', 'PM');

create index if not exists leave_request_days_user_date_idx
  on public.leave_request_days (app_user_id, leave_date);

create table if not exists public.leave_request_lot_allocations (
  allocation_id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.leave_requests(request_id) on delete cascade,
  request_day_id uuid not null
    references public.leave_request_days(request_day_id) on delete cascade,
  lot_id uuid not null
    references public.leave_lots(lot_id),
  leave_date date not null,
  allocated_units integer not null
    constraint leave_request_lot_allocations_units_chk check (allocated_units in (1, 2)),
  status text not null
    constraint leave_request_lot_allocations_status_chk check (status in (
      'RESERVED',
      'CONSUMED',
      'RELEASED',
      'REVERSED'
    )),
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  settled_at timestamptz null,
  released_at timestamptz null
);

create index if not exists leave_request_lot_allocations_request_idx
  on public.leave_request_lot_allocations (request_id, leave_date);

create index if not exists leave_request_lot_allocations_lot_idx
  on public.leave_request_lot_allocations (lot_id, status);

create table if not exists public.leave_ledger_entries (
  ledger_entry_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id),
  lot_id uuid null
    references public.leave_lots(lot_id),
  request_id uuid null
    references public.leave_requests(request_id),
  request_day_id uuid null
    references public.leave_request_days(request_day_id),
  opening_batch_id uuid null
    references public.leave_opening_batches(batch_id),
  entry_type text not null
    constraint leave_ledger_entries_type_chk check (entry_type in (
      'GRANT_OPENING_CARRY_OVER',
      'GRANT_OPENING_CURRENT_YEAR',
      'GRANT_MONTHLY_ACCRUAL',
      'GRANT_PROBATION_CATCHUP',
      'GRANT_SENIORITY',
      'GRANT_MANUAL_ADJUSTMENT',
      'RESERVE',
      'SETTLE_RESERVE_TO_CONSUME',
      'CONSUME',
      'RELEASE_RESERVE',
      'REVERSAL_CONSUME',
      'EXPIRE_CARRY_OVER'
    )),
  effective_date date not null,
  delta_available_units integer not null default 0,
  delta_reserved_units integer not null default 0,
  delta_consumed_units integer not null default 0,
  delta_expired_units integer not null default 0,
  actor_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now())
);

create index if not exists leave_ledger_entries_user_idx
  on public.leave_ledger_entries (app_user_id, created_at desc);

create table if not exists public.leave_audit_events (
  audit_event_id uuid primary key default gen_random_uuid(),
  event_type text not null,
  actor_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  target_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id),
  request_id uuid null
    references public.leave_requests(request_id),
  opening_batch_id uuid null
    references public.leave_opening_batches(batch_id),
  reason text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now())
);

create index if not exists leave_audit_events_target_idx
  on public.leave_audit_events (target_app_user_id, created_at desc);

create table if not exists public.leave_idempotency_records (
  idempotency_record_id uuid primary key default gen_random_uuid(),
  operation_code text not null,
  actor_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id),
  idempotency_key text not null,
  request_fingerprint text not null,
  response_payload jsonb not null,
  created_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  constraint leave_idempotency_records_uidx
    unique (operation_code, actor_app_user_id, idempotency_key)
);

-- Enable & force RLS on all 13 leave tables (default-deny with 0 policies).
alter table public.leave_policy_configs enable row level security;
alter table public.leave_policy_configs force row level security;

alter table public.leave_policy_revisions enable row level security;
alter table public.leave_policy_revisions force row level security;

alter table public.leave_employee_profiles enable row level security;
alter table public.leave_employee_profiles force row level security;

alter table public.leave_department_approvers enable row level security;
alter table public.leave_department_approvers force row level security;

alter table public.leave_module_grants enable row level security;
alter table public.leave_module_grants force row level security;

alter table public.leave_opening_batches enable row level security;
alter table public.leave_opening_batches force row level security;

alter table public.leave_lots enable row level security;
alter table public.leave_lots force row level security;

alter table public.leave_requests enable row level security;
alter table public.leave_requests force row level security;

alter table public.leave_request_days enable row level security;
alter table public.leave_request_days force row level security;

alter table public.leave_request_lot_allocations enable row level security;
alter table public.leave_request_lot_allocations force row level security;

alter table public.leave_ledger_entries enable row level security;
alter table public.leave_ledger_entries force row level security;

alter table public.leave_audit_events enable row level security;
alter table public.leave_audit_events force row level security;

alter table public.leave_idempotency_records enable row level security;
alter table public.leave_idempotency_records force row level security;

-- -----------------------------------------------------------------------------
-- 2. Immutability triggers & internal helpers.
-- -----------------------------------------------------------------------------
create or replace function public.leave_management__internal_immutable_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  raise exception '% is append-only; % is not allowed', tg_table_name, tg_op
    using errcode = 'P0001';
end;
$function$;

drop trigger if exists leave_policy_revisions_immutable_trg on public.leave_policy_revisions;
create trigger leave_policy_revisions_immutable_trg
  before update or delete on public.leave_policy_revisions
  for each statement execute function public.leave_management__internal_immutable_guard();

drop trigger if exists leave_opening_batches_immutable_trg on public.leave_opening_batches;
create trigger leave_opening_batches_immutable_trg
  before update or delete on public.leave_opening_batches
  for each statement execute function public.leave_management__internal_immutable_guard();

drop trigger if exists leave_ledger_entries_immutable_trg on public.leave_ledger_entries;
create trigger leave_ledger_entries_immutable_trg
  before update or delete on public.leave_ledger_entries
  for each statement execute function public.leave_management__internal_immutable_guard();

drop trigger if exists leave_audit_events_immutable_trg on public.leave_audit_events;
create trigger leave_audit_events_immutable_trg
  before update or delete on public.leave_audit_events
  for each statement execute function public.leave_management__internal_immutable_guard();

drop trigger if exists leave_idempotency_records_immutable_trg on public.leave_idempotency_records;
create trigger leave_idempotency_records_immutable_trg
  before update or delete on public.leave_idempotency_records
  for each statement execute function public.leave_management__internal_immutable_guard();

create or replace function public.leave_management__internal_business_date()
returns date
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select public.direct_entry_authorization_date()
$function$;

create or replace function public.leave_management__internal_validate_reason(
  p_reason text,
  p_error_code text default 'LEAVE_REASON_INVALID'
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_trimmed text := pg_catalog.btrim(coalesce(p_reason, ''));
begin
  if v_trimmed = ''
     or pg_catalog.length(v_trimmed) > 2000
     or v_trimmed ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception '%', p_error_code
      using errcode = '22023';
  end if;
  return v_trimmed;
end;
$function$;

create or replace function public.leave_management__internal_lock_employee(
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('leave_management_emp_v1'),
    pg_catalog.hashtext(coalesce(p_app_user_id::text, ''))
  );
end;
$function$;

create or replace function public.leave_management__internal_resolve_carry_over_expiry_date(
  p_leave_year integer,
  p_month integer,
  p_day integer
)
returns date
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_last_day integer;
begin
  if p_leave_year is null or p_month is null or p_day is null then
    return null;
  end if;
  v_last_day := pg_catalog.date_part(
    'day',
    (pg_catalog.make_date(p_leave_year, p_month, 1) + interval '1 month - 1 day')::date
  )::integer;
  return pg_catalog.make_date(p_leave_year, p_month, least(p_day, v_last_day));
end;
$function$;

create or replace function public.leave_management__internal_account_summary(
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
  v_recruiter_id uuid;
  v_recruiter_name text;
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

  select r.recruiter_id, r.display_name, r.personnel_code
    into v_recruiter_id, v_recruiter_name, v_personnel_code
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
    'app_user_id', v_user.app_user_id,
    'display_name', coalesce(v_recruiter_name, v_user.display_name),
    'login_id', v_login_id,
    'personnel_code', v_personnel_code,
    'recruiter_id', v_recruiter_id,
    'account_enabled', v_user.enabled
  );
end;
$function$;

create or replace function public.leave_management__internal_resolve_authority(
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
  v_today date := public.leave_management__internal_business_date();
  v_is_full_admin boolean := false;
  v_is_bod boolean := false;
  v_is_admin_bod_grant boolean := false;
  v_is_hr_operator boolean := false;
  v_is_hr_report_viewer boolean := false;
  v_is_team_leader boolean := false;
  v_is_dept_approver boolean := false;
  v_is_shared boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'Direct entry actor mapping is not active'
      using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select exists (
           select 1
             from public.leave_employee_profiles p
            where p.app_user_id = p_app_user_id
              and p.is_shared_non_employee = true
         )
    into v_is_shared;

  v_is_full_admin := (
    public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
    and public.direct_entry_has_scope(p_app_user_id, 'all')
  );

  v_is_bod := (
    public.direct_entry_has_scope(p_app_user_id, 'all')
    and (
      public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
      or (
        public.direct_entry_has_capability(p_app_user_id, 'report_analytics_view')
        and public.direct_entry_has_capability(p_app_user_id, 'report_view')
      )
    )
  );

  select exists (
           select 1
             from public.leave_module_grants g
            where g.app_user_id = p_app_user_id
              and g.role_code = 'LEAVE_ADMIN_BOD_APPROVER'
              and g.is_current = true
              and g.valid_from <= v_today
              and (g.valid_to is null or v_today < g.valid_to)
         ),
         exists (
           select 1
             from public.leave_module_grants g
            where g.app_user_id = p_app_user_id
              and g.role_code = 'HR_LEAVE_OPERATOR'
              and g.is_current = true
              and g.valid_from <= v_today
              and (g.valid_to is null or v_today < g.valid_to)
         ),
         exists (
           select 1
             from public.leave_module_grants g
            where g.app_user_id = p_app_user_id
              and g.role_code = 'HR_REPORT_VIEWER'
              and g.is_current = true
              and g.valid_from <= v_today
              and (g.valid_to is null or v_today < g.valid_to)
         )
    into v_is_admin_bod_grant, v_is_hr_operator, v_is_hr_report_viewer;

  select exists (
           select 1
             from public.direct_entry_team_leader_assignments tla
             join public.teams t on t.team_id = tla.team_id
            where tla.leader_app_user_id = p_app_user_id
              and t.active = true
              and t.code <> '__system_vendor__'
              and tla.valid_from <= v_today
              and (tla.valid_to is null or v_today < tla.valid_to)
              and (tla.valid_to is null or tla.valid_to > tla.valid_from)
         )
    into v_is_team_leader;

  select exists (
           select 1
             from public.leave_department_approvers da
            where da.approver_app_user_id = p_app_user_id
              and da.is_current = true
              and da.valid_from <= v_today
              and (da.valid_to is null or v_today < da.valid_to)
         )
    into v_is_dept_approver;

  if v_is_shared then
    v_is_team_leader := false;
    v_is_dept_approver := false;
  end if;

  return pg_catalog.jsonb_build_object(
    'app_user_id', p_app_user_id,
    'is_shared_non_employee', v_is_shared,
    'is_full_admin', v_is_full_admin,
    'is_bod', (v_is_bod or v_is_admin_bod_grant),
    'is_hr_operator', v_is_hr_operator,
    'is_hr_report_viewer', v_is_hr_report_viewer,
    'is_team_leader', v_is_team_leader,
    'is_department_approver', v_is_dept_approver,
    'can_submit_request', (not v_is_shared),
    'can_approve_requests', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_admin_bod_grant or v_is_team_leader or v_is_dept_approver)),
    'can_view_monthly_report', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator or v_is_hr_report_viewer)),
    'can_manage_config', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator))
  );
end;
$function$;


create or replace function public.leave_management__internal_resolve_routing(
  p_app_user_id uuid,
  p_as_of date default public.leave_management__internal_business_date()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_unit_kind text := 'UNCLASSIFIED';
  v_recruiter_id uuid;
  v_team_count integer := 0;
  v_team_id uuid;
  v_team_code text;
  v_team_name text;
  v_leader_count integer := 0;
  v_leader_app_user_id uuid;
  v_dept_approver_id uuid;
  v_is_requester_team_leader boolean := false;
  v_is_requester_dept_approver boolean := false;
begin
  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_app_user_id;

  if found then
    v_has_profile := true;
    v_unit_kind := v_profile.unit_kind;
    v_profile_configured := (
      not v_profile.is_shared_non_employee
      and v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
  end if;

  select l.recruiter_id
    into v_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.app_user_id = p_app_user_id
     and l.verified = true
     and l.is_current = true
     and r.active = true
     and coalesce(r.personnel_code, '') <> '__system_vendor__'
   order by l.valid_from desc, l.link_id desc
   limit 1;

  select exists (
           select 1
             from public.direct_entry_team_leader_assignments tla
             join public.teams t on t.team_id = tla.team_id
            where tla.leader_app_user_id = p_app_user_id
              and t.active = true
              and t.code <> '__system_vendor__'
              and tla.valid_from <= p_as_of
              and (tla.valid_to is null or p_as_of < tla.valid_to)
              and (tla.valid_to is null or tla.valid_to > tla.valid_from)
         )
    into v_is_requester_team_leader;

  select exists (
           select 1
             from public.leave_department_approvers da
            where da.approver_app_user_id = p_app_user_id
              and da.is_current = true
              and da.valid_from <= p_as_of
              and (da.valid_to is null or p_as_of < da.valid_to)
         )
    into v_is_requester_dept_approver;

  if v_is_requester_team_leader or v_is_requester_dept_approver or v_unit_kind = 'MANAGEMENT_BOD' then
    return pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_DIRECT',
      'unit_kind', case when v_unit_kind = 'UNCLASSIFIED' and v_is_requester_team_leader then 'RECRUITMENT' else v_unit_kind end,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', null,
      'profile_configured', v_profile_configured
    );
  end if;

  if v_unit_kind in ('MARKETING', 'IT', 'ACCOUNTING') then
    select da.approver_app_user_id
      into v_dept_approver_id
      from public.leave_department_approvers da
      join public.direct_entry_app_users u on u.app_user_id = da.approver_app_user_id
     where da.unit_kind = v_unit_kind
       and da.is_current = true
       and da.valid_from <= p_as_of
       and (da.valid_to is null or p_as_of < da.valid_to)
       and u.enabled = true
     limit 1;

    if v_dept_approver_id is not null and v_dept_approver_id <> p_app_user_id then
      return pg_catalog.jsonb_build_object(
        'route_kind', 'DEPARTMENT_HEAD',
        'unit_kind', v_unit_kind,
        'primary_approver_app_user_id', v_dept_approver_id,
        'team_id', null,
        'team_code', null,
        'team_name', null,
        'fallback_reason', null,
        'profile_configured', v_profile_configured
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_FALLBACK',
      'unit_kind', v_unit_kind,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', 'DEPARTMENT_APPROVER_NOT_CONFIGURED',
      'profile_configured', v_profile_configured
    );
  end if;

  if v_recruiter_id is not null then
    select count(*)::integer,
           (pg_catalog.array_agg(t.team_id order by t.code))[1],
           (pg_catalog.array_agg(t.code order by t.code))[1],
           (pg_catalog.array_agg(t.display_name order by t.code))[1]
      into v_team_count, v_team_id, v_team_code, v_team_name
      from public.recruiter_team_memberships rtm
      join public.teams t on t.team_id = rtm.team_id
     where rtm.recruiter_id = v_recruiter_id
       and t.active = true
       and t.code <> '__system_vendor__'
       and rtm.valid_from <= p_as_of
       and (rtm.valid_to is null or p_as_of < rtm.valid_to)
       and (rtm.valid_to is null or rtm.valid_to > rtm.valid_from);

    if v_team_count = 1 then
      select count(distinct tla.leader_app_user_id)::integer,
             (pg_catalog.array_agg(tla.leader_app_user_id order by tla.valid_from desc, tla.assignment_id desc))[1]
        into v_leader_count, v_leader_app_user_id
        from public.direct_entry_team_leader_assignments tla
        join public.direct_entry_app_users u on u.app_user_id = tla.leader_app_user_id
       where tla.team_id = v_team_id
         and u.enabled = true
         and tla.valid_from <= p_as_of
         and (tla.valid_to is null or p_as_of < tla.valid_to)
         and (tla.valid_to is null or tla.valid_to > tla.valid_from);

      if v_leader_count = 1 and v_leader_app_user_id is not null and v_leader_app_user_id <> p_app_user_id then
        return pg_catalog.jsonb_build_object(
          'route_kind', 'TEAM_LEADER',
          'unit_kind', case when v_unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_unit_kind end,
          'primary_approver_app_user_id', v_leader_app_user_id,
          'team_id', v_team_id,
          'team_code', v_team_code,
          'team_name', v_team_name,
          'fallback_reason', null,
          'profile_configured', v_profile_configured
        );
      end if;

      return pg_catalog.jsonb_build_object(
        'route_kind', 'ADMIN_BOD_FALLBACK',
        'unit_kind', case when v_unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_unit_kind end,
        'primary_approver_app_user_id', null,
        'team_id', v_team_id,
        'team_code', v_team_code,
        'team_name', v_team_name,
        'fallback_reason', case when v_leader_count = 0 then 'TEAM_WITHOUT_ACTIVE_LEADER' else 'TEAM_MULTIPLE_LEADERS_OR_SELF' end,
        'profile_configured', v_profile_configured
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_FALLBACK',
      'unit_kind', case when v_unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_unit_kind end,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', case when v_team_count = 0 then 'RECRUITER_WITHOUT_ACTIVE_TEAM' else 'RECRUITER_MULTI_ACTIVE_TEAMS' end,
      'profile_configured', v_profile_configured
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'route_kind', 'ADMIN_BOD_FALLBACK',
    'unit_kind', v_unit_kind,
    'primary_approver_app_user_id', null,
    'team_id', null,
    'team_code', null,
    'team_name', null,
    'fallback_reason', case when not v_has_profile or not v_profile_configured then 'PROFILE_UNCONFIGURED_OR_UNMAPPED' else 'UNMAPPED_UNIT_OR_RECRUITER' end,
    'profile_configured', v_profile_configured
  );
end;
$function$;

create or replace function public.leave_management__internal_can_actor_decide_request(
  p_actor_app_user_id uuid,
  p_request public.leave_requests,
  p_as_of date default public.leave_management__internal_business_date()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_auth jsonb;
  v_is_admin_or_bod boolean := false;
  v_is_current_team_leader boolean := false;
  v_is_current_dept_approver boolean := false;
begin
  if p_actor_app_user_id is null or p_request.request_id is null then
    return false;
  end if;

  if p_actor_app_user_id = p_request.app_user_id then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id;

  if not found or not v_user.enabled then
    return false;
  end if;

  v_auth := public.leave_management__internal_resolve_authority(v_user.auth_subject, p_actor_app_user_id);
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    return false;
  end if;

  v_is_admin_or_bod := (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  );

  if v_is_admin_or_bod then
    return true;
  end if;

  if p_request.primary_approver_app_user_id = p_actor_app_user_id then
    return true;
  end if;

  if p_request.route_kind = 'TEAM_LEADER' and p_request.routed_team_id is not null then
    select exists (
             select 1
               from public.direct_entry_team_leader_assignments tla
              where tla.team_id = p_request.routed_team_id
                and tla.leader_app_user_id = p_actor_app_user_id
                and tla.valid_from <= p_as_of
                and (tla.valid_to is null or p_as_of < tla.valid_to)
                and (tla.valid_to is null or tla.valid_to > tla.valid_from)
           )
      into v_is_current_team_leader;
    if v_is_current_team_leader then
      return true;
    end if;
  end if;

  if p_request.route_kind = 'DEPARTMENT_HEAD' and p_request.unit_kind_snapshot in ('MARKETING', 'IT', 'ACCOUNTING') then
    select exists (
             select 1
               from public.leave_department_approvers da
              where da.unit_kind = p_request.unit_kind_snapshot
                and da.approver_app_user_id = p_actor_app_user_id
                and da.is_current = true
                and da.valid_from <= p_as_of
                and (da.valid_to is null or p_as_of < da.valid_to)
           )
      into v_is_current_dept_approver;
    if v_is_current_dept_approver then
      return true;
    end if;
  end if;

  return false;
end;
$function$;

create or replace function public.leave_management__internal_sync_employee_accruals(
  p_app_user_id uuid,
  p_as_of date default public.leave_management__internal_business_date()
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_profile public.leave_employee_profiles%rowtype;
  v_policy public.leave_policy_configs%rowtype;
  v_alloc record;
  v_lot record;
  v_lot_avail integer;
  v_year integer := pg_catalog.date_part('year', p_as_of)::integer;
  v_current_month integer := pg_catalog.date_part('month', p_as_of)::integer;
  v_start_year integer;
  v_start_month integer;
  v_official_date date;
  v_m integer;
  v_month_first date;
  v_usable_from date;
  v_lot_kind text;
  v_entry_type text;
  v_new_lot_id uuid;
  v_sen_units integer := 0;
  v_sen_date date := null;
  v_existing_sen_units integer := 0;
  v_diff_sen integer := 0;
  v_full_years integer := 0;
  v_anniv_date date;
begin
  if p_app_user_id is null then
    return;
  end if;

  perform public.leave_management__internal_lock_employee(p_app_user_id);

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  -- Step 1: Settle due RESERVED allocations where leave_date <= p_as_of into CONSUMED
  for v_alloc in
    select a.allocation_id,
           a.request_id,
           a.request_day_id,
           a.lot_id,
           a.leave_date,
           a.allocated_units
      from public.leave_request_lot_allocations a
      join public.leave_requests r on r.request_id = a.request_id
     where r.app_user_id = p_app_user_id
       and r.status = 'APPROVED'
       and a.status = 'RESERVED'
       and a.leave_date <= p_as_of
     order by a.leave_date asc, a.allocation_id asc
     for update of a
  loop
    update public.leave_request_lot_allocations
       set status = 'CONSUMED',
           settled_at = pg_catalog.timezone('utc', pg_catalog.now())
     where allocation_id = v_alloc.allocation_id;

    update public.leave_lots
       set reserved_units = reserved_units - v_alloc.allocated_units,
           consumed_units = consumed_units + v_alloc.allocated_units,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where lot_id = v_alloc.lot_id;

    insert into public.leave_ledger_entries (
      app_user_id,
      lot_id,
      request_id,
      request_day_id,
      entry_type,
      effective_date,
      delta_available_units,
      delta_reserved_units,
      delta_consumed_units,
      delta_expired_units,
      actor_app_user_id,
      reason,
      metadata
    )
    values (
      p_app_user_id,
      v_alloc.lot_id,
      v_alloc.request_id,
      v_alloc.request_day_id,
      'SETTLE_RESERVE_TO_CONSUME',
      v_alloc.leave_date,
      0,
      -v_alloc.allocated_units,
      v_alloc.allocated_units,
      0,
      null,
      'Chốt phép giữ chỗ khi đến ngày nghỉ thực tế',
      pg_catalog.jsonb_build_object(
        'allocation_id', v_alloc.allocation_id,
        'leave_date', v_alloc.leave_date,
        'settled_as_of', p_as_of
      )
    );
  end loop;

  -- Step 2: Expire remaining available units on lots where expires_after_date < p_as_of
  for v_lot in
    select l.*
      from public.leave_lots l
     where l.app_user_id = p_app_user_id
       and l.expires_after_date is not null
       and l.expires_after_date < p_as_of
     order by l.expires_after_date asc, l.lot_id asc
     for update of l
  loop
    v_lot_avail := v_lot.granted_units - v_lot.reserved_units - v_lot.consumed_units - v_lot.expired_units;
    if v_lot_avail > 0 then
      update public.leave_lots
         set expired_units = expired_units + v_lot_avail,
             updated_at = pg_catalog.timezone('utc', pg_catalog.now())
       where lot_id = v_lot.lot_id;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        entry_type,
        effective_date,
        delta_available_units,
        delta_reserved_units,
        delta_consumed_units,
        delta_expired_units,
        actor_app_user_id,
        reason,
        metadata
      )
      values (
        p_app_user_id,
        v_lot.lot_id,
        'EXPIRE_CARRY_OVER',
        (v_lot.expires_after_date + 1),
        -v_lot_avail,
        0,
        0,
        v_lot_avail,
        null,
        'Hết hạn phép chuyển năm sau ngày ' || v_lot.expires_after_date::text,
        pg_catalog.jsonb_build_object(
          'expires_after_date', v_lot.expires_after_date,
          'expired_as_of', p_as_of
        )
      );
    end if;
  end loop;

  -- Step 3: Accrue monthly & probation catch-up & seniority lots for OFFICIAL configured profile
  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_app_user_id
   for update;

  if not found then
    return;
  end if;

  if v_profile.is_shared_non_employee
     or v_profile.employment_status <> 'OFFICIAL'
     or v_profile.work_start_date is null then
    return;
  end if;

  v_official_date := coalesce(v_profile.official_effective_date, v_profile.work_start_date);
  if p_as_of < v_official_date then
    return;
  end if;

  v_start_year := pg_catalog.date_part('year', v_profile.work_start_date)::integer;
  if v_start_year > v_year then
    return;
  end if;

  if v_start_year = v_year then
    v_start_month := pg_catalog.date_part('month', v_profile.work_start_date)::integer;
  else
    v_start_month := 1;
  end if;

  for v_m in v_start_month..v_current_month loop
    v_month_first := pg_catalog.make_date(v_year, v_m, 1);
    v_usable_from := greatest(v_month_first, v_profile.work_start_date, v_official_date);

    if v_official_date > v_profile.work_start_date
       and (
         pg_catalog.date_part('year', v_official_date)::integer > v_year
         or (
           pg_catalog.date_part('year', v_official_date)::integer = v_year
           and v_m < pg_catalog.date_part('month', v_official_date)::integer
         )
       ) then
      v_lot_kind := 'PROBATION_CATCHUP';
      v_entry_type := 'GRANT_PROBATION_CATCHUP';
    else
      v_lot_kind := 'MONTHLY_ACCRUAL';
      v_entry_type := 'GRANT_MONTHLY_ACCRUAL';
    end if;

    v_new_lot_id := null;

    insert into public.leave_lots (
      app_user_id,
      leave_year,
      lot_kind,
      accrual_month,
      granted_units,
      usable_from_date,
      expires_after_date,
      source_ref,
      created_by_app_user_id
    )
    values (
      p_app_user_id,
      v_year,
      v_lot_kind,
      v_m,
      coalesce(v_policy.monthly_accrual_units, 2),
      v_usable_from,
      pg_catalog.make_date(v_year, 12, 31),
      pg_catalog.format('AUTO_MONTH:%s:%s', v_year, lpad(v_m::text, 2, '0')),
      null
    )
    on conflict (app_user_id, leave_year, accrual_month)
      where lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')
      do nothing
    returning lot_id into v_new_lot_id;

    if v_new_lot_id is not null then
      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        entry_type,
        effective_date,
        delta_available_units,
        delta_reserved_units,
        delta_consumed_units,
        delta_expired_units,
        actor_app_user_id,
        reason,
        metadata
      )
      values (
        p_app_user_id,
        v_new_lot_id,
        v_entry_type,
        v_usable_from,
        coalesce(v_policy.monthly_accrual_units, 2),
        0,
        0,
        0,
        null,
        case
          when v_lot_kind = 'PROBATION_CATCHUP' then
            pg_catalog.format('Tính bù phép tháng %s/%s khi lên chính thức', lpad(v_m::text, 2, '0'), v_year)
          else
            pg_catalog.format('Cộng phép định kỳ tháng %s/%s', lpad(v_m::text, 2, '0'), v_year)
        end,
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'accrual_month', v_m,
          'usable_from_date', v_usable_from,
          'lot_kind', v_lot_kind
        )
      );
    end if;
  end loop;

  -- Step 4: Seniority grant (configured next_seniority_effective_date/units or default 5-year milestone)
  if v_profile.next_seniority_effective_date is not null and v_profile.next_seniority_units > 0 then
    if pg_catalog.date_part('year', v_profile.next_seniority_effective_date)::integer <= v_year
       and p_as_of >= v_profile.next_seniority_effective_date then
      v_sen_units := v_profile.next_seniority_units;
      v_sen_date := greatest(
        pg_catalog.make_date(v_year, 1, 1),
        v_profile.next_seniority_effective_date,
        v_official_date
      );
    end if;
  else
    v_full_years := pg_catalog.date_part('year', pg_catalog.age(p_as_of, v_profile.work_start_date))::integer;
    if v_full_years >= 5 then
      v_sen_units := (v_full_years / 5) * coalesce(v_policy.default_seniority_step_units, 2);
      v_anniv_date := (v_profile.work_start_date + pg_catalog.make_interval(years => (v_full_years / 5) * 5))::date;
      v_sen_date := greatest(
        pg_catalog.make_date(v_year, 1, 1),
        v_anniv_date,
        v_official_date
      );
    end if;
  end if;

  if v_sen_units > 0 and v_sen_date is not null and p_as_of >= v_sen_date then
    select coalesce(sum(l.granted_units), 0)::integer
      into v_existing_sen_units
      from public.leave_lots l
     where l.app_user_id = p_app_user_id
       and l.leave_year = v_year
       and l.lot_kind = 'SENIORITY_GRANT';

    v_diff_sen := v_sen_units - v_existing_sen_units;
    if v_diff_sen > 0 then
      insert into public.leave_lots (
        app_user_id,
        leave_year,
        lot_kind,
        accrual_month,
        granted_units,
        usable_from_date,
        expires_after_date,
        source_ref,
        created_by_app_user_id
      )
      values (
        p_app_user_id,
        v_year,
        'SENIORITY_GRANT',
        null,
        v_diff_sen,
        v_sen_date,
        pg_catalog.make_date(v_year, 12, 31),
        pg_catalog.format('AUTO_SENIORITY:%s:%s', v_year, v_sen_units),
        null
      )
      returning lot_id into v_new_lot_id;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        entry_type,
        effective_date,
        delta_available_units,
        delta_reserved_units,
        delta_consumed_units,
        delta_expired_units,
        actor_app_user_id,
        reason,
        metadata
      )
      values (
        p_app_user_id,
        v_new_lot_id,
        'GRANT_SENIORITY',
        v_sen_date,
        v_diff_sen,
        0,
        0,
        0,
        null,
        pg_catalog.format('Cộng phép thâm niên năm %s', v_year),
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'usable_from_date', v_sen_date,
          'target_seniority_units', v_sen_units,
          'granted_delta_units', v_diff_sen
        )
      );
    end if;
  end if;
end;
$function$;

create or replace function public.leave_management__internal_compute_balance_summary(
  p_app_user_id uuid,
  p_leave_year integer,
  p_as_of date default public.leave_management__internal_business_date()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_total_granted integer := 0;
  v_carry_over_granted integer := 0;
  v_monthly_accrued integer := 0;
  v_seniority_granted integer := 0;
  v_opening_current_year integer := 0;
  v_reserved integer := 0;
  v_consumed integer := 0;
  v_expired integer := 0;
  v_available integer := 0;
  v_carry_over_available integer := 0;
  v_Pending_paid integer := 0;
  v_Pending_unpaid integer := 0;
  v_approved_unpaid integer := 0;
  v_lots jsonb := '[]'::jsonb;
begin
  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_app_user_id;

  if found then
    v_has_profile := true;
    v_profile_configured := (
      not v_profile.is_shared_non_employee
      and v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
  end if;

  select coalesce(sum(l.granted_units), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind = 'CARRY_OVER'), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind = 'SENIORITY_GRANT'), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind in ('OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT')), 0)::integer,
         coalesce(sum(l.reserved_units), 0)::integer,
         coalesce(sum(l.consumed_units), 0)::integer,
         coalesce(sum(l.expired_units), 0)::integer,
         coalesce(
           sum(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
             filter (
               where l.usable_from_date <= p_as_of
                 and (l.expires_after_date is null or p_as_of <= l.expires_after_date)
             ),
           0
         )::integer,
         coalesce(
           sum(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
             filter (
               where l.lot_kind = 'CARRY_OVER'
                 and l.usable_from_date <= p_as_of
                 and (l.expires_after_date is null or p_as_of <= l.expires_after_date)
             ),
           0
         )::integer,
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'lot_id', l.lot_id,
               'leave_year', l.leave_year,
               'lot_kind', l.lot_kind,
               'accrual_month', l.accrual_month,
               'granted_units', l.granted_units,
               'reserved_units', l.reserved_units,
               'consumed_units', l.consumed_units,
               'expired_units', l.expired_units,
               'available_units', (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units),
               'usable_from_date', l.usable_from_date,
               'expires_after_date', l.expires_after_date,
               'source_ref', l.source_ref
             )
             order by l.expires_after_date asc nulls last, l.usable_from_date asc, l.created_at asc, l.lot_id asc
           ),
           '[]'::jsonb
         )
    into v_total_granted,
         v_carry_over_granted,
         v_monthly_accrued,
         v_seniority_granted,
         v_opening_current_year,
         v_reserved,
         v_consumed,
         v_expired,
         v_available,
         v_carry_over_available,
         v_lots
    from public.leave_lots l
   where l.app_user_id = p_app_user_id
     and l.leave_year = p_leave_year;

  select coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and r.pay_treatment = 'PAID_LEAVE'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and r.pay_treatment <> 'PAID_LEAVE'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and r.pay_treatment <> 'PAID_LEAVE'),
           0
         )::integer
    into v_pending_paid,
         v_pending_unpaid,
         v_approved_unpaid
    from public.leave_requests r
    join public.leave_request_days d on d.request_id = r.request_id
   where r.app_user_id = p_app_user_id
     and pg_catalog.date_part('year', d.leave_date)::integer = p_leave_year;

  return pg_catalog.jsonb_build_object(
    'leave_year', p_leave_year,
    'as_of_date', p_as_of,
    'has_profile', v_has_profile,
    'profile_configured', v_profile_configured,
    'employment_status', case when v_has_profile then v_profile.employment_status else 'UNCONFIGURED' end,
    'unit_kind', case when v_has_profile then v_profile.unit_kind else 'UNCLASSIFIED' end,
    'work_start_date', case when v_has_profile then v_profile.work_start_date else null end,
    'official_effective_date', case when v_has_profile then v_profile.official_effective_date else null end,
    'next_seniority_effective_date', case when v_has_profile then v_profile.next_seniority_effective_date else null end,
    'next_seniority_units', case when v_has_profile then v_profile.next_seniority_units else 0 end,
    'total_granted_units', v_total_granted,
    'carry_over_granted_units', v_carry_over_granted,
    'carry_over_available_units', v_carry_over_available,
    'monthly_accrued_units', v_monthly_accrued,
    'seniority_granted_units', v_seniority_granted,
    'opening_or_adjustment_units', v_opening_current_year,
    'available_units', v_available,
    'reserved_units', v_reserved,
    'consumed_units', v_consumed,
    'expired_units', v_expired,
    'pending_paid_units', v_pending_paid,
    'pending_unpaid_units', v_pending_unpaid,
    'approved_unpaid_units', v_approved_unpaid,
    'lots', v_lots
  );
end;
$function$;

create or replace function public.leave_management__internal_project_request(
  p_request public.leave_requests
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_days jsonb := '[]'::jsonb;
  v_allocations jsonb := '[]'::jsonb;
  v_requester jsonb;
  v_primary_approver jsonb;
  v_decided_by jsonb;
begin
  v_requester := public.leave_management__internal_account_summary(p_request.app_user_id);
  if p_request.primary_approver_app_user_id is not null then
    v_primary_approver := public.leave_management__internal_account_summary(p_request.primary_approver_app_user_id);
  end if;
  if p_request.decided_by_app_user_id is not null then
    v_decided_by := public.leave_management__internal_account_summary(p_request.decided_by_app_user_id);
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'request_day_id', d.request_day_id,
               'leave_date', d.leave_date,
               'session_code', d.session_code,
               'half_day_units', d.half_day_units,
               'is_active', d.is_active
             )
             order by d.leave_date asc
           ),
           '[]'::jsonb
         )
    into v_days
    from public.leave_request_days d
   where d.request_id = p_request.request_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'allocation_id', a.allocation_id,
               'request_day_id', a.request_day_id,
               'lot_id', a.lot_id,
               'lot_kind', l.lot_kind,
               'leave_date', a.leave_date,
               'allocated_units', a.allocated_units,
               'status', a.status,
               'settled_at', a.settled_at,
               'released_at', a.released_at
             )
             order by a.leave_date asc, a.allocation_id asc
           ),
           '[]'::jsonb
         )
    into v_allocations
    from public.leave_request_lot_allocations a
    join public.leave_lots l on l.lot_id = a.lot_id
   where a.request_id = p_request.request_id;

  return pg_catalog.jsonb_build_object(
    'request_id', p_request.request_id,
    'app_user_id', p_request.app_user_id,
    'requester', v_requester,
    'status', p_request.status,
    'pay_treatment', p_request.pay_treatment,
    'employment_status_snapshot', p_request.employment_status_snapshot,
    'unit_kind_snapshot', p_request.unit_kind_snapshot,
    'profile_configured_at_submit', p_request.profile_configured_at_submit,
    'requested_units', p_request.requested_units,
    'reason', p_request.reason,
    'route_kind', p_request.route_kind,
    'primary_approver_app_user_id', p_request.primary_approver_app_user_id,
    'primary_approver', v_primary_approver,
    'routed_team_id', p_request.routed_team_id,
    'routed_team_code', p_request.routed_team_code,
    'routed_team_name', p_request.routed_team_name,
    'fallback_reason', p_request.fallback_reason,
    'submitted_at', p_request.submitted_at,
    'decided_at', p_request.decided_at,
    'decided_by_app_user_id', p_request.decided_by_app_user_id,
    'decided_by', v_decided_by,
    'decision_reason', p_request.decision_reason,
    'cancelled_at', p_request.cancelled_at,
    'cancelled_by_app_user_id', p_request.cancelled_by_app_user_id,
    'cancellation_reason', p_request.cancellation_reason,
    'row_version', p_request.row_version,
    'days', v_days,
    'allocations', v_allocations
  );
end;
$function$;


create or replace function public.leave_management_get_my_summary(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_leave_year integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_account jsonb;
  v_routing jsonb;
  v_balance jsonb;
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_requests jsonb := '[]'::jsonb;
  v_ledger jsonb := '[]'::jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    raise exception 'LEAVE_SHARED_ACCOUNT_FORBIDDEN'
      using errcode = '42501';
  end if;

  perform public.leave_management__internal_sync_employee_accruals(p_actor_app_user_id, v_today);

  v_account := public.leave_management__internal_account_summary(p_actor_app_user_id);
  v_routing := public.leave_management__internal_resolve_routing(p_actor_app_user_id, v_today);
  v_balance := public.leave_management__internal_compute_balance_summary(p_actor_app_user_id, v_year, v_today);

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  select coalesce(
           pg_catalog.jsonb_agg(
             public.leave_management__internal_project_request(r)
             order by r.submitted_at desc, r.request_id desc
           ),
           '[]'::jsonb
         )
    into v_requests
    from public.leave_requests r
   where r.app_user_id = p_actor_app_user_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'ledger_entry_id', le.ledger_entry_id,
               'lot_id', le.lot_id,
               'request_id', le.request_id,
               'entry_type', le.entry_type,
               'effective_date', le.effective_date,
               'delta_available_units', le.delta_available_units,
               'delta_reserved_units', le.delta_reserved_units,
               'delta_consumed_units', le.delta_consumed_units,
               'delta_expired_units', le.delta_expired_units,
               'reason', le.reason,
               'created_at', le.created_at
             )
             order by le.created_at desc
           ),
           '[]'::jsonb
         )
    into v_ledger
    from (
      select e.*
        from public.leave_ledger_entries e
       where e.app_user_id = p_actor_app_user_id
       order by e.created_at desc
       limit 100
    ) le;

  return pg_catalog.jsonb_build_object(
    'as_of_date', v_today,
    'leave_year', v_year,
    'account', v_account,
    'authority', v_auth,
    'routing', v_routing,
    'policy', pg_catalog.jsonb_build_object(
      'annual_base_units', v_policy.annual_base_units,
      'monthly_accrual_units', v_policy.monthly_accrual_units,
      'default_seniority_years', v_policy.default_seniority_years,
      'default_seniority_step_units', v_policy.default_seniority_step_units,
      'carry_over_expiry_month', v_policy.carry_over_expiry_month,
      'carry_over_expiry_day', v_policy.carry_over_expiry_day,
      'carry_over_expires_after_date', v_carry_over_expiry,
      'row_version', v_policy.row_version
    ),
    'balance', v_balance,
    'requests', v_requests,
    'ledger_entries', v_ledger
  );
end;
$function$;

create or replace function public.leave_management_create_request(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_days jsonb,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_pay_treatment text;
  v_emp_status_snapshot text;
  v_unit_kind_snapshot text;
  v_routing jsonb;
  v_day_item jsonb;
  v_day_date_text text;
  v_day_date date;
  v_session_code text;
  v_half_day_units integer;
  v_total_units integer := 0;
  v_min_date date := null;
  v_max_date date := null;
  v_seen_dates date[] := array[]::date[];
  v_sim_lot record;
  v_sim_needed integer;
  v_request_row public.leave_requests%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    raise exception 'LEAVE_SHARED_ACCOUNT_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID');

  perform public.leave_management__internal_lock_employee(p_actor_app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'CREATE_REQUEST'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  perform public.leave_management__internal_sync_employee_accruals(p_actor_app_user_id, v_today);

  if p_days is null
     or pg_catalog.jsonb_typeof(p_days) <> 'array'
     or pg_catalog.jsonb_array_length(p_days) < 1
     or pg_catalog.jsonb_array_length(p_days) > 60 then
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  end if;

  for v_day_item in
    select value
      from pg_catalog.jsonb_array_elements(p_days)
  loop
    if pg_catalog.jsonb_typeof(v_day_item) <> 'object' then
      raise exception 'LEAVE_REQUEST_DAYS_INVALID'
        using errcode = '22023';
    end if;

    v_day_date_text := pg_catalog.btrim(coalesce(v_day_item->>'leave_date', ''));
    v_session_code := pg_catalog.upper(pg_catalog.btrim(coalesce(v_day_item->>'session_code', '')));

    if v_day_date_text !~ '^\d{4}-\d{2}-\d{2}$'
       or v_session_code not in ('FULL', 'AM', 'PM') then
      raise exception 'LEAVE_REQUEST_DAYS_INVALID'
        using errcode = '22023';
    end if;

    begin
      v_day_date := v_day_date_text::date;
    exception
      when others then
        raise exception 'LEAVE_REQUEST_DAYS_INVALID'
          using errcode = '22023';
    end;

    if pg_catalog.date_part('year', v_day_date)::integer <> v_year then
      raise exception 'LEAVE_REQUEST_YEAR_OUT_OF_RANGE'
        using errcode = '22023';
    end if;

    if v_day_date = any(v_seen_dates) then
      raise exception 'LEAVE_REQUEST_DUPLICATE_DATE'
        using errcode = '22023';
    end if;
    v_seen_dates := pg_catalog.array_append(v_seen_dates, v_day_date);

    if exists (
      select 1
        from public.leave_request_days d
       where d.app_user_id = p_actor_app_user_id
         and d.leave_date = v_day_date
         and d.is_active = true
         and (
           d.session_code = 'FULL'
           or v_session_code = 'FULL'
           or d.session_code = v_session_code
         )
    ) then
      raise exception 'LEAVE_REQUEST_OVERLAP'
        using errcode = '23505';
    end if;

    v_half_day_units := case when v_session_code = 'FULL' then 2 else 1 end;
    v_total_units := v_total_units + v_half_day_units;

    if v_min_date is null or v_day_date < v_min_date then
      v_min_date := v_day_date;
    end if;
    if v_max_date is null or v_day_date > v_max_date then
      v_max_date := v_day_date;
    end if;
  end loop;

  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_actor_app_user_id;

  if found then
    v_has_profile := true;
    v_profile_configured := (
      not v_profile.is_shared_non_employee
      and v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
  end if;

  if not v_has_profile or not v_profile_configured then
    v_pay_treatment := 'UNPAID_UNCONFIGURED_PROFILE';
    v_emp_status_snapshot := 'UNCONFIGURED';
    v_unit_kind_snapshot := case when v_has_profile then v_profile.unit_kind else 'UNCLASSIFIED' end;
  elsif v_profile.employment_status = 'PROBATION'
        or v_min_date < coalesce(v_profile.official_effective_date, v_profile.work_start_date) then
    v_pay_treatment := 'UNPAID_PROBATION';
    v_emp_status_snapshot := v_profile.employment_status;
    v_unit_kind_snapshot := v_profile.unit_kind;
  else
    v_pay_treatment := 'PAID_LEAVE';
    v_emp_status_snapshot := 'OFFICIAL';
    v_unit_kind_snapshot := v_profile.unit_kind;
  end if;

  -- Verify FIFO balance availability across eligible lots for PAID_LEAVE
  if v_pay_treatment = 'PAID_LEAVE' then
    create temporary table if not exists pg_temp.leave_sim_lots (
      lot_id uuid primary key,
      usable_from_date date not null,
      expires_after_date date null,
      created_at timestamptz not null,
      remaining_units integer not null
    ) on commit drop;

    truncate table pg_temp.leave_sim_lots;

    insert into pg_temp.leave_sim_lots (
      lot_id,
      usable_from_date,
      expires_after_date,
      created_at,
      remaining_units
    )
    select l.lot_id,
           l.usable_from_date,
           l.expires_after_date,
           l.created_at,
           (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
      from public.leave_lots l
     where l.app_user_id = p_actor_app_user_id
       and l.leave_year = v_year
       and (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units) > 0;

    for v_day_date, v_half_day_units in
      select (elem->>'leave_date')::date as d_date,
             case when pg_catalog.upper(pg_catalog.btrim(elem->>'session_code')) = 'FULL' then 2 else 1 end as d_units
        from pg_catalog.jsonb_array_elements(p_days) as elem
       order by (elem->>'leave_date')::date asc
    loop
      v_sim_needed := v_half_day_units;
      for v_sim_lot in
        select s.lot_id,
               s.remaining_units
          from pg_temp.leave_sim_lots s
         where s.remaining_units > 0
           and s.usable_from_date <= v_day_date
           and (s.expires_after_date is null or v_day_date <= s.expires_after_date)
         order by s.expires_after_date asc nulls last,
                  s.usable_from_date asc,
                  s.created_at asc,
                  s.lot_id asc
      loop
        if v_sim_lot.remaining_units >= v_sim_needed then
          update pg_temp.leave_sim_lots
             set remaining_units = remaining_units - v_sim_needed
           where lot_id = v_sim_lot.lot_id;
          v_sim_needed := 0;
          exit;
        else
          v_sim_needed := v_sim_needed - v_sim_lot.remaining_units;
          update pg_temp.leave_sim_lots
             set remaining_units = 0
           where lot_id = v_sim_lot.lot_id;
        end if;
      end loop;

      if v_sim_needed > 0 then
        raise exception 'LEAVE_INSUFFICIENT_BALANCE'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  v_routing := public.leave_management__internal_resolve_routing(p_actor_app_user_id, v_today);

  insert into public.leave_requests (
    app_user_id,
    status,
    pay_treatment,
    employment_status_snapshot,
    unit_kind_snapshot,
    profile_configured_at_submit,
    requested_units,
    reason,
    route_kind,
    primary_approver_app_user_id,
    routed_team_id,
    routed_team_code,
    routed_team_name,
    fallback_reason,
    row_version
  )
  values (
    p_actor_app_user_id,
    'PENDING',
    v_pay_treatment,
    v_emp_status_snapshot,
    coalesce(v_routing->>'unit_kind', v_unit_kind_snapshot),
    v_profile_configured,
    v_total_units,
    v_reason,
    v_routing->>'route_kind',
    nullif(v_routing->>'primary_approver_app_user_id', '')::uuid,
    nullif(v_routing->>'team_id', '')::uuid,
    nullif(v_routing->>'team_code', ''),
    nullif(v_routing->>'team_name', ''),
    nullif(v_routing->>'fallback_reason', ''),
    1
  )
  returning * into v_request_row;

  begin
    insert into public.leave_request_days (
      request_id,
      app_user_id,
      leave_date,
      session_code,
      half_day_units,
      is_active
    )
    select v_request_row.request_id,
           p_actor_app_user_id,
           (elem->>'leave_date')::date,
           pg_catalog.upper(pg_catalog.btrim(elem->>'session_code')),
           case when pg_catalog.upper(pg_catalog.btrim(elem->>'session_code')) = 'FULL' then 2 else 1 end,
           true
      from pg_catalog.jsonb_array_elements(p_days) as elem
     order by (elem->>'leave_date')::date asc;
  exception
    when unique_violation then
      raise exception 'LEAVE_REQUEST_OVERLAP'
        using errcode = '23505';
  end;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    request_id,
    reason,
    payload
  )
  values (
    'REQUEST_CREATED',
    p_actor_app_user_id,
    p_actor_app_user_id,
    v_request_row.request_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'pay_treatment', v_pay_treatment,
      'requested_units', v_total_units,
      'route_kind', v_request_row.route_kind,
      'primary_approver_app_user_id', v_request_row.primary_approver_app_user_id,
      'fallback_reason', v_request_row.fallback_reason
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'request', public.leave_management__internal_project_request(v_request_row),
    'balance', public.leave_management__internal_compute_balance_summary(p_actor_app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'CREATE_REQUEST',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

create or replace function public.leave_management_withdraw_request(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_request_id uuid,
  p_expected_row_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text := null;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_req public.leave_requests%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    raise exception 'LEAVE_SHARED_ACCOUNT_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  if nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is not null then
    v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID');
  end if;

  perform public.leave_management__internal_lock_employee(p_actor_app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'WITHDRAW_REQUEST'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select r.*
    into v_req
    from public.leave_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'LEAVE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_req.app_user_id <> p_actor_app_user_id then
    raise exception 'LEAVE_REQUEST_OWNERSHIP_FORBIDDEN'
      using errcode = '42501';
  end if;

  if p_expected_row_version is null or v_req.row_version <> p_expected_row_version then
    raise exception 'LEAVE_ROW_VERSION_CONFLICT'
      using errcode = '40001';
  end if;

  if v_req.status <> 'PENDING' then
    raise exception 'LEAVE_INVALID_STATE_TRANSITION'
      using errcode = '22023';
  end if;

  update public.leave_request_days
     set is_active = false
   where request_id = v_req.request_id;

  update public.leave_requests
     set status = 'WITHDRAWN',
         cancelled_at = pg_catalog.timezone('utc', pg_catalog.now()),
         cancelled_by_app_user_id = p_actor_app_user_id,
         cancellation_reason = coalesce(v_reason, 'Người tạo tự rút đơn khi đang chờ duyệt'),
         row_version = row_version + 1,
         updated_at = pg_catalog.timezone('utc', pg_catalog.now())
   where request_id = v_req.request_id
   returning * into v_req;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    request_id,
    reason,
    payload
  )
  values (
    'REQUEST_WITHDRAWN',
    p_actor_app_user_id,
    p_actor_app_user_id,
    v_req.request_id,
    v_req.cancellation_reason,
    pg_catalog.jsonb_build_object(
      'row_version', v_req.row_version
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'request', public.leave_management__internal_project_request(v_req),
    'balance', public.leave_management__internal_compute_balance_summary(p_actor_app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'WITHDRAW_REQUEST',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

create or replace function public.leave_management_list_approval_inbox(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_status_filter text default 'PENDING',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_status_filter, 'PENDING')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_items jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_approve_requests')::boolean, false) then
    raise exception 'LEAVE_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_status not in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN', 'ALL') then
    raise exception 'LEAVE_FILTER_INVALID'
      using errcode = '22023';
  end if;

  select count(*)::integer
    into v_total
    from public.leave_requests r
   where (v_status = 'ALL' or r.status = v_status)
     and public.leave_management__internal_can_actor_decide_request(p_actor_app_user_id, r, v_today);

  select coalesce(
           pg_catalog.jsonb_agg(
             public.leave_management__internal_project_request(sub.r)
             order by sub.submitted_at desc, sub.request_id desc
           ),
           '[]'::jsonb
         )
    into v_items
    from (
      select r,
             r.submitted_at,
             r.request_id
        from public.leave_requests r
       where (v_status = 'ALL' or r.status = v_status)
         and public.leave_management__internal_can_actor_decide_request(p_actor_app_user_id, r, v_today)
       order by r.submitted_at desc, r.request_id desc
       limit v_limit
      offset v_offset
    ) sub;

  return pg_catalog.jsonb_build_object(
    'as_of_date', v_today,
    'status_filter', v_status,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
end;
$function$;

create or replace function public.leave_management_decide_request(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_request_id uuid,
  p_decision text,
  p_expected_row_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_decision text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
  v_reason text := null;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_req public.leave_requests%rowtype;
  v_day record;
  v_lot record;
  v_alloc record;
  v_needed integer;
  v_lot_avail integer;
  v_take integer;
  v_alloc_status text;
  v_entry_type text;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    raise exception 'LEAVE_SHARED_ACCOUNT_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  if v_decision not in ('APPROVE', 'REJECT', 'CANCEL_APPROVED') then
    raise exception 'LEAVE_DECISION_INVALID'
      using errcode = '22023';
  end if;

  if v_decision in ('REJECT', 'CANCEL_APPROVED') then
    v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_REQUIRED');
  elsif nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is not null then
    v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID');
  end if;

  select r.*
    into v_req
    from public.leave_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'LEAVE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform public.leave_management__internal_lock_employee(v_req.app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'DECIDE_REQUEST'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select r.*
    into v_req
    from public.leave_requests r
   where r.request_id = p_request_id
   for update;

  if p_actor_app_user_id = v_req.app_user_id then
    raise exception 'LEAVE_SELF_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if not public.leave_management__internal_can_actor_decide_request(p_actor_app_user_id, v_req, v_today) then
    raise exception 'LEAVE_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if p_expected_row_version is null or v_req.row_version <> p_expected_row_version then
    raise exception 'LEAVE_ROW_VERSION_CONFLICT'
      using errcode = '40001';
  end if;

  perform public.leave_management__internal_sync_employee_accruals(v_req.app_user_id, v_today);

  if v_decision = 'APPROVE' then
    if v_req.status <> 'PENDING' then
      raise exception 'LEAVE_INVALID_STATE_TRANSITION'
        using errcode = '22023';
    end if;

    if v_req.pay_treatment = 'PAID_LEAVE' then
      for v_day in
        select d.request_day_id,
               d.leave_date,
               d.half_day_units
          from public.leave_request_days d
         where d.request_id = v_req.request_id
         order by d.leave_date asc
      loop
        v_needed := v_day.half_day_units;

        for v_lot in
          select l.*
            from public.leave_lots l
           where l.app_user_id = v_req.app_user_id
             and l.usable_from_date <= v_day.leave_date
             and (l.expires_after_date is null or v_day.leave_date <= l.expires_after_date)
             and (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units) > 0
           order by l.expires_after_date asc nulls last,
                    l.usable_from_date asc,
                    l.created_at asc,
                    l.lot_id asc
           for update
        loop
          v_lot_avail := v_lot.granted_units - v_lot.reserved_units - v_lot.consumed_units - v_lot.expired_units;
          if v_lot_avail <= 0 then
            continue;
          end if;

          v_take := least(v_needed, v_lot_avail);

          if v_day.leave_date <= v_today then
            v_alloc_status := 'CONSUMED';
            v_entry_type := 'CONSUME';

            update public.leave_lots
               set consumed_units = consumed_units + v_take,
                   updated_at = pg_catalog.timezone('utc', pg_catalog.now())
             where lot_id = v_lot.lot_id;

            insert into public.leave_request_lot_allocations (
              request_id,
              request_day_id,
              lot_id,
              leave_date,
              allocated_units,
              status,
              settled_at
            )
            values (
              v_req.request_id,
              v_day.request_day_id,
              v_lot.lot_id,
              v_day.leave_date,
              v_take,
              v_alloc_status,
              pg_catalog.timezone('utc', pg_catalog.now())
            );

            insert into public.leave_ledger_entries (
              app_user_id,
              lot_id,
              request_id,
              request_day_id,
              entry_type,
              effective_date,
              delta_available_units,
              delta_reserved_units,
              delta_consumed_units,
              delta_expired_units,
              actor_app_user_id,
              reason,
              metadata
            )
            values (
              v_req.app_user_id,
              v_lot.lot_id,
              v_req.request_id,
              v_day.request_day_id,
              v_entry_type,
              v_day.leave_date,
              -v_take,
              0,
              v_take,
              0,
              p_actor_app_user_id,
              coalesce(v_reason, 'Duyệt đơn nghỉ phép (trừ phép trực tiếp)'),
              pg_catalog.jsonb_build_object(
                'leave_date', v_day.leave_date,
                'lot_kind', v_lot.lot_kind
              )
            );
          else
            v_alloc_status := 'RESERVED';
            v_entry_type := 'RESERVE';

            update public.leave_lots
               set reserved_units = reserved_units + v_take,
                   updated_at = pg_catalog.timezone('utc', pg_catalog.now())
             where lot_id = v_lot.lot_id;

            insert into public.leave_request_lot_allocations (
              request_id,
              request_day_id,
              lot_id,
              leave_date,
              allocated_units,
              status,
              settled_at
            )
            values (
              v_req.request_id,
              v_day.request_day_id,
              v_lot.lot_id,
              v_day.leave_date,
              v_take,
              v_alloc_status,
              null
            );

            insert into public.leave_ledger_entries (
              app_user_id,
              lot_id,
              request_id,
              request_day_id,
              entry_type,
              effective_date,
              delta_available_units,
              delta_reserved_units,
              delta_consumed_units,
              delta_expired_units,
              actor_app_user_id,
              reason,
              metadata
            )
            values (
              v_req.app_user_id,
              v_lot.lot_id,
              v_req.request_id,
              v_day.request_day_id,
              v_entry_type,
              v_day.leave_date,
              -v_take,
              v_take,
              0,
              0,
              p_actor_app_user_id,
              coalesce(v_reason, 'Duyệt đơn nghỉ phép (giữ chỗ ngày tương lai)'),
              pg_catalog.jsonb_build_object(
                'leave_date', v_day.leave_date,
                'lot_kind', v_lot.lot_kind
              )
            );
          end if;

          v_needed := v_needed - v_take;
          exit when v_needed = 0;
        end loop;

        if v_needed > 0 then
          raise exception 'LEAVE_INSUFFICIENT_BALANCE'
            using errcode = '22023';
        end if;
      end loop;
    end if;

    update public.leave_requests
       set status = 'APPROVED',
           decided_at = pg_catalog.timezone('utc', pg_catalog.now()),
           decided_by_app_user_id = p_actor_app_user_id,
           decision_reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where request_id = v_req.request_id
     returning * into v_req;

    insert into public.leave_audit_events (
      event_type,
      actor_app_user_id,
      target_app_user_id,
      request_id,
      reason,
      payload
    )
    values (
      'REQUEST_APPROVED',
      p_actor_app_user_id,
      v_req.app_user_id,
      v_req.request_id,
      v_reason,
      pg_catalog.jsonb_build_object(
        'pay_treatment', v_req.pay_treatment,
        'requested_units', v_req.requested_units,
        'row_version', v_req.row_version
      )
    );

  elsif v_decision = 'REJECT' then
    if v_req.status <> 'PENDING' then
      raise exception 'LEAVE_INVALID_STATE_TRANSITION'
        using errcode = '22023';
    end if;

    update public.leave_request_days
       set is_active = false
     where request_id = v_req.request_id;

    update public.leave_requests
       set status = 'REJECTED',
           decided_at = pg_catalog.timezone('utc', pg_catalog.now()),
           decided_by_app_user_id = p_actor_app_user_id,
           decision_reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where request_id = v_req.request_id
     returning * into v_req;

    insert into public.leave_audit_events (
      event_type,
      actor_app_user_id,
      target_app_user_id,
      request_id,
      reason,
      payload
    )
    values (
      'REQUEST_REJECTED',
      p_actor_app_user_id,
      v_req.app_user_id,
      v_req.request_id,
      v_reason,
      pg_catalog.jsonb_build_object(
        'row_version', v_req.row_version
      )
    );

  elsif v_decision = 'CANCEL_APPROVED' then
    if v_req.status <> 'APPROVED' then
      raise exception 'LEAVE_INVALID_STATE_TRANSITION'
        using errcode = '22023';
    end if;

    for v_alloc in
      select a.*
        from public.leave_request_lot_allocations a
       where a.request_id = v_req.request_id
         and a.status in ('RESERVED', 'CONSUMED')
       order by a.allocation_id asc
       for update
    loop
      select l.*
        into v_lot
        from public.leave_lots l
       where l.lot_id = v_alloc.lot_id
       for update;

      if v_alloc.status = 'RESERVED' then
        update public.leave_request_lot_allocations
           set status = 'RELEASED',
               released_at = pg_catalog.timezone('utc', pg_catalog.now())
         where allocation_id = v_alloc.allocation_id;

        update public.leave_lots
           set reserved_units = reserved_units - v_alloc.allocated_units,
               updated_at = pg_catalog.timezone('utc', pg_catalog.now())
         where lot_id = v_lot.lot_id;

        insert into public.leave_ledger_entries (
          app_user_id,
          lot_id,
          request_id,
          request_day_id,
          entry_type,
          effective_date,
          delta_available_units,
          delta_reserved_units,
          delta_consumed_units,
          delta_expired_units,
          actor_app_user_id,
          reason,
          metadata
        )
        values (
          v_req.app_user_id,
          v_lot.lot_id,
          v_req.request_id,
          v_alloc.request_day_id,
          'RELEASE_RESERVE',
          v_today,
          v_alloc.allocated_units,
          -v_alloc.allocated_units,
          0,
          0,
          p_actor_app_user_id,
          v_reason,
          pg_catalog.jsonb_build_object(
            'allocation_id', v_alloc.allocation_id,
            'leave_date', v_alloc.leave_date
          )
        );
      else
        update public.leave_request_lot_allocations
           set status = 'REVERSED',
               released_at = pg_catalog.timezone('utc', pg_catalog.now())
         where allocation_id = v_alloc.allocation_id;

        update public.leave_lots
           set consumed_units = consumed_units - v_alloc.allocated_units,
               updated_at = pg_catalog.timezone('utc', pg_catalog.now())
         where lot_id = v_lot.lot_id;

        insert into public.leave_ledger_entries (
          app_user_id,
          lot_id,
          request_id,
          request_day_id,
          entry_type,
          effective_date,
          delta_available_units,
          delta_reserved_units,
          delta_consumed_units,
          delta_expired_units,
          actor_app_user_id,
          reason,
          metadata
        )
        values (
          v_req.app_user_id,
          v_lot.lot_id,
          v_req.request_id,
          v_alloc.request_day_id,
          'REVERSAL_CONSUME',
          v_today,
          v_alloc.allocated_units,
          0,
          -v_alloc.allocated_units,
          0,
          p_actor_app_user_id,
          v_reason,
          pg_catalog.jsonb_build_object(
            'allocation_id', v_alloc.allocation_id,
            'leave_date', v_alloc.leave_date
          )
        );
      end if;

      -- If the lot has already expired as of v_today, immediately expire the returned units
      if v_lot.expires_after_date is not null and v_lot.expires_after_date < v_today then
        update public.leave_lots
           set expired_units = expired_units + v_alloc.allocated_units,
               updated_at = pg_catalog.timezone('utc', pg_catalog.now())
         where lot_id = v_lot.lot_id;

        insert into public.leave_ledger_entries (
          app_user_id,
          lot_id,
          request_id,
          request_day_id,
          entry_type,
          effective_date,
          delta_available_units,
          delta_reserved_units,
          delta_consumed_units,
          delta_expired_units,
          actor_app_user_id,
          reason,
          metadata
        )
        values (
          v_req.app_user_id,
          v_lot.lot_id,
          v_req.request_id,
          v_alloc.request_day_id,
          'EXPIRE_CARRY_OVER',
          v_today,
          -v_alloc.allocated_units,
          0,
          0,
          v_alloc.allocated_units,
          p_actor_app_user_id,
          'Hết hạn ngay phần phép hoàn lại do lô phép chuyển năm đã quá hạn ' || v_lot.expires_after_date::text,
          pg_catalog.jsonb_build_object(
            'allocation_id', v_alloc.allocation_id,
            'expires_after_date', v_lot.expires_after_date
          )
        );
      end if;
    end loop;

    update public.leave_request_days
       set is_active = false
     where request_id = v_req.request_id;

    update public.leave_requests
       set status = 'CANCELLED',
           cancelled_at = pg_catalog.timezone('utc', pg_catalog.now()),
           cancelled_by_app_user_id = p_actor_app_user_id,
           cancellation_reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where request_id = v_req.request_id
     returning * into v_req;

    insert into public.leave_audit_events (
      event_type,
      actor_app_user_id,
      target_app_user_id,
      request_id,
      reason,
      payload
    )
    values (
      'REQUEST_CANCELLED',
      p_actor_app_user_id,
      v_req.app_user_id,
      v_req.request_id,
      v_reason,
      pg_catalog.jsonb_build_object(
        'row_version', v_req.row_version
      )
    );
  end if;

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'request', public.leave_management__internal_project_request(v_req),
    'requester_balance', public.leave_management__internal_compute_balance_summary(v_req.app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'DECIDE_REQUEST',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;


create or replace function public.leave_management_get_admin_overview(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_search text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, ''))), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 300));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_dept_approvers jsonb := '[]'::jsonb;
  v_module_grants jsonb := '[]'::jsonb;
  v_employees jsonb := '[]'::jsonb;
  v_total_employees integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'approver_assignment_id', da.approver_assignment_id,
               'unit_kind', da.unit_kind,
               'approver_app_user_id', da.approver_app_user_id,
               'approver', public.leave_management__internal_account_summary(da.approver_app_user_id),
               'valid_from', da.valid_from,
               'valid_to', da.valid_to,
               'is_current', da.is_current,
               'reason', da.reason,
               'row_version', da.row_version
             )
             order by da.unit_kind asc
           ),
           '[]'::jsonb
         )
    into v_dept_approvers
    from public.leave_department_approvers da
   where da.is_current = true;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'grant_id', g.grant_id,
               'app_user_id', g.app_user_id,
               'account', public.leave_management__internal_account_summary(g.app_user_id),
               'role_code', g.role_code,
               'valid_from', g.valid_from,
               'valid_to', g.valid_to,
               'is_current', g.is_current,
               'reason', g.reason,
               'row_version', g.row_version
             )
             order by g.role_code asc, g.created_at desc
           ),
           '[]'::jsonb
         )
    into v_module_grants
    from public.leave_module_grants g
   where g.is_current = true;

  select count(*)::integer
    into v_total_employees
    from public.direct_entry_app_users u
    left join public.direct_entry_app_user_recruiter_links l
      on l.app_user_id = u.app_user_id
     and l.verified = true
     and l.is_current = true
    left join public.recruiters r
      on r.recruiter_id = l.recruiter_id
   where (
     v_search is null
     or pg_catalog.lower(coalesce(r.display_name, u.display_name, '')) like '%' || v_search || '%'
     or pg_catalog.lower(coalesce(r.personnel_code, '')) like '%' || v_search || '%'
   );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'account', public.leave_management__internal_account_summary(sub.app_user_id),
               'profile', case
                 when sub.profile_found then
                   pg_catalog.jsonb_build_object(
                     'app_user_id', sub.app_user_id,
                     'is_shared_non_employee', sub.is_shared_non_employee,
                     'employment_status', sub.employment_status,
                     'unit_kind', sub.unit_kind,
                     'work_start_date', sub.work_start_date,
                     'official_effective_date', sub.official_effective_date,
                     'next_seniority_effective_date', sub.next_seniority_effective_date,
                     'next_seniority_units', sub.next_seniority_units,
                     'notes', sub.notes,
                     'row_version', sub.row_version
                   )
                 else
                   pg_catalog.jsonb_build_object(
                     'app_user_id', sub.app_user_id,
                     'is_shared_non_employee', false,
                     'employment_status', 'UNCONFIGURED',
                     'unit_kind', 'UNCLASSIFIED',
                     'work_start_date', null,
                     'official_effective_date', null,
                     'next_seniority_effective_date', null,
                     'next_seniority_units', 0,
                     'notes', null,
                     'row_version', 0
                   )
               end,
               'routing', public.leave_management__internal_resolve_routing(sub.app_user_id, v_today),
               'balance', public.leave_management__internal_compute_balance_summary(sub.app_user_id, v_year, v_today)
             )
             order by sub.sort_name asc, sub.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_employees
    from (
      select u.app_user_id,
             coalesce(r.display_name, u.display_name) as sort_name,
             (p.app_user_id is not null) as profile_found,
             coalesce(p.is_shared_non_employee, false) as is_shared_non_employee,
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             coalesce(p.unit_kind, 'UNCLASSIFIED') as unit_kind,
             p.work_start_date,
             p.official_effective_date,
             p.next_seniority_effective_date,
             coalesce(p.next_seniority_units, 0) as next_seniority_units,
             p.notes,
             coalesce(p.row_version, 0) as row_version
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p
          on p.app_user_id = u.app_user_id
        left join public.direct_entry_app_user_recruiter_links l
          on l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
        left join public.recruiters r
          on r.recruiter_id = l.recruiter_id
       where (
         v_search is null
         or pg_catalog.lower(coalesce(r.display_name, u.display_name, '')) like '%' || v_search || '%'
         or pg_catalog.lower(coalesce(r.personnel_code, '')) like '%' || v_search || '%'
       )
       order by coalesce(r.display_name, u.display_name) asc, u.app_user_id asc
       limit v_limit
      offset v_offset
    ) sub;

  return pg_catalog.jsonb_build_object(
    'as_of_date', v_today,
    'leave_year', v_year,
    'authority', v_auth,
    'policy', pg_catalog.jsonb_build_object(
      'annual_base_units', v_policy.annual_base_units,
      'monthly_accrual_units', v_policy.monthly_accrual_units,
      'default_seniority_years', v_policy.default_seniority_years,
      'default_seniority_step_units', v_policy.default_seniority_step_units,
      'carry_over_expiry_month', v_policy.carry_over_expiry_month,
      'carry_over_expiry_day', v_policy.carry_over_expiry_day,
      'carry_over_expires_after_date', v_carry_over_expiry,
      'row_version', v_policy.row_version
    ),
    'department_approvers', v_dept_approvers,
    'module_grants', v_module_grants,
    'total_employees', v_total_employees,
    'limit', v_limit,
    'offset', v_offset,
    'employees', v_employees
  );
end;
$function$;

create or replace function public.leave_management_update_policy_admin(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_carry_over_expiry_month integer,
  p_carry_over_expiry_day integer,
  p_expected_row_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_policy public.leave_policy_configs%rowtype;
  v_resolved_expiry date;
  v_lot_owner record;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  ) then
    raise exception 'LEAVE_POLICY_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_REQUIRED');

  if p_carry_over_expiry_month is null
     or p_carry_over_expiry_day is null
     or p_carry_over_expiry_month < 1
     or p_carry_over_expiry_month > 12
     or p_carry_over_expiry_day < 1
     or p_carry_over_expiry_day > 31 then
    raise exception 'LEAVE_POLICY_EXPIRY_INVALID'
      using errcode = '22023';
  end if;

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'UPDATE_POLICY_ADMIN'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default'
   for update;

  if p_expected_row_version is null or v_policy.row_version <> p_expected_row_version then
    raise exception 'LEAVE_ROW_VERSION_CONFLICT'
      using errcode = '40001';
  end if;

  update public.leave_policy_configs
     set carry_over_expiry_month = p_carry_over_expiry_month,
         carry_over_expiry_day = p_carry_over_expiry_day,
         row_version = row_version + 1,
         updated_at = pg_catalog.timezone('utc', pg_catalog.now()),
         updated_by_app_user_id = p_actor_app_user_id
   where config_key = 'default'
   returning * into v_policy;

  insert into public.leave_policy_revisions (
    config_key,
    annual_base_units,
    monthly_accrual_units,
    default_seniority_years,
    default_seniority_step_units,
    carry_over_expiry_month,
    carry_over_expiry_day,
    reason,
    changed_by_app_user_id
  )
  values (
    v_policy.config_key,
    v_policy.annual_base_units,
    v_policy.monthly_accrual_units,
    v_policy.default_seniority_years,
    v_policy.default_seniority_step_units,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day,
    v_reason,
    p_actor_app_user_id
  );

  v_resolved_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  -- Propagate carry-over expiry date to current-year CARRY_OVER lots and sync expirations
  for v_lot_owner in
    select distinct l.app_user_id
      from public.leave_lots l
     where l.leave_year = v_year
       and l.lot_kind = 'CARRY_OVER'
  loop
    perform public.leave_management__internal_lock_employee(v_lot_owner.app_user_id);

    update public.leave_lots
       set expires_after_date = v_resolved_expiry,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where app_user_id = v_lot_owner.app_user_id
       and leave_year = v_year
       and lot_kind = 'CARRY_OVER';

    perform public.leave_management__internal_sync_employee_accruals(v_lot_owner.app_user_id, v_today);
  end loop;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    reason,
    payload
  )
  values (
    'POLICY_UPDATED',
    p_actor_app_user_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'carry_over_expiry_month', v_policy.carry_over_expiry_month,
      'carry_over_expiry_day', v_policy.carry_over_expiry_day,
      'carry_over_expires_after_date', v_resolved_expiry,
      'row_version', v_policy.row_version
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'policy', pg_catalog.jsonb_build_object(
      'annual_base_units', v_policy.annual_base_units,
      'monthly_accrual_units', v_policy.monthly_accrual_units,
      'default_seniority_years', v_policy.default_seniority_years,
      'default_seniority_step_units', v_policy.default_seniority_step_units,
      'carry_over_expiry_month', v_policy.carry_over_expiry_month,
      'carry_over_expiry_day', v_policy.carry_over_expiry_day,
      'carry_over_expires_after_date', v_resolved_expiry,
      'row_version', v_policy.row_version
    )
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'UPDATE_POLICY_ADMIN',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

create or replace function public.leave_management_upsert_employee_profile_admin(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_is_shared_non_employee boolean,
  p_employment_status text,
  p_unit_kind text,
  p_work_start_date date,
  p_official_effective_date date,
  p_next_seniority_effective_date date,
  p_next_seniority_units integer,
  p_expected_row_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_existing_profile public.leave_employee_profiles%rowtype;
  v_has_existing boolean := false;
  v_emp_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_employment_status, 'UNCONFIGURED')));
  v_unit_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind, 'UNCLASSIFIED')));
  v_is_shared boolean := coalesce(p_is_shared_non_employee, false);
  v_official_date date := p_official_effective_date;
  v_sen_units integer := coalesce(p_next_seniority_units, 0);
  v_seniority_changed boolean := false;
  v_profile public.leave_employee_profiles%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_REQUIRED');

  if p_target_app_user_id is null then
    raise exception 'LEAVE_TARGET_USER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select u.*
    into v_target_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;

  if not found then
    raise exception 'LEAVE_TARGET_USER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform public.leave_management__internal_lock_employee(p_target_app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'UPSERT_EMPLOYEE_PROFILE_ADMIN'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_emp_status not in ('UNCONFIGURED', 'PROBATION', 'OFFICIAL')
     or v_unit_kind not in ('UNCLASSIFIED', 'RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
     or v_sen_units < 0
     or v_sen_units > 60 then
    raise exception 'LEAVE_PROFILE_INVALID'
      using errcode = '22023';
  end if;

  if v_emp_status in ('PROBATION', 'OFFICIAL') and not v_is_shared and p_work_start_date is null then
    raise exception 'LEAVE_PROFILE_WORK_START_DATE_REQUIRED'
      using errcode = '22023';
  end if;

  if v_emp_status = 'OFFICIAL' and not v_is_shared then
    v_official_date := coalesce(v_official_date, p_work_start_date);
    if v_official_date is null or v_official_date < p_work_start_date then
      raise exception 'LEAVE_PROFILE_OFFICIAL_DATE_INVALID'
        using errcode = '22023';
    end if;
  elsif v_official_date is not null and p_work_start_date is not null and v_official_date < p_work_start_date then
    raise exception 'LEAVE_PROFILE_OFFICIAL_DATE_INVALID'
      using errcode = '22023';
  end if;

  select p.*
    into v_existing_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_target_app_user_id
   for update;

  if found then
    v_has_existing := true;
    if p_expected_row_version is null or v_existing_profile.row_version <> p_expected_row_version then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = '40001';
    end if;
    v_seniority_changed := (
      v_existing_profile.next_seniority_effective_date is distinct from p_next_seniority_effective_date
      or v_existing_profile.next_seniority_units is distinct from v_sen_units
    );
  else
    if coalesce(p_expected_row_version, 0) <> 0 then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = '40001';
    end if;
    v_seniority_changed := (
      p_next_seniority_effective_date is not null
      or v_sen_units > 0
    );
  end if;

  if v_seniority_changed and not (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  ) then
    raise exception 'LEAVE_SENIORITY_CONFIG_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_has_existing then
    update public.leave_employee_profiles
       set is_shared_non_employee = v_is_shared,
           employment_status = v_emp_status,
           unit_kind = v_unit_kind,
           work_start_date = p_work_start_date,
           official_effective_date = v_official_date,
           next_seniority_effective_date = p_next_seniority_effective_date,
           next_seniority_units = v_sen_units,
           notes = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now()),
           updated_by_app_user_id = p_actor_app_user_id
     where app_user_id = p_target_app_user_id
     returning * into v_profile;
  else
    insert into public.leave_employee_profiles (
      app_user_id,
      is_shared_non_employee,
      employment_status,
      unit_kind,
      work_start_date,
      official_effective_date,
      next_seniority_effective_date,
      next_seniority_units,
      notes,
      row_version,
      updated_by_app_user_id
    )
    values (
      p_target_app_user_id,
      v_is_shared,
      v_emp_status,
      v_unit_kind,
      p_work_start_date,
      v_official_date,
      p_next_seniority_effective_date,
      v_sen_units,
      v_reason,
      1,
      p_actor_app_user_id
    )
    returning * into v_profile;
  end if;

  perform public.leave_management__internal_sync_employee_accruals(p_target_app_user_id, v_today);

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    reason,
    payload
  )
  values (
    'EMPLOYEE_PROFILE_UPSERTED',
    p_actor_app_user_id,
    p_target_app_user_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'is_shared_non_employee', v_profile.is_shared_non_employee,
      'employment_status', v_profile.employment_status,
      'unit_kind', v_profile.unit_kind,
      'work_start_date', v_profile.work_start_date,
      'official_effective_date', v_profile.official_effective_date,
      'next_seniority_effective_date', v_profile.next_seniority_effective_date,
      'next_seniority_units', v_profile.next_seniority_units,
      'row_version', v_profile.row_version
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'profile', pg_catalog.jsonb_build_object(
      'app_user_id', v_profile.app_user_id,
      'is_shared_non_employee', v_profile.is_shared_non_employee,
      'employment_status', v_profile.employment_status,
      'unit_kind', v_profile.unit_kind,
      'work_start_date', v_profile.work_start_date,
      'official_effective_date', v_profile.official_effective_date,
      'next_seniority_effective_date', v_profile.next_seniority_effective_date,
      'next_seniority_units', v_profile.next_seniority_units,
      'notes', v_profile.notes,
      'row_version', v_profile.row_version
    ),
    'routing', public.leave_management__internal_resolve_routing(p_target_app_user_id, v_today),
    'balance', public.leave_management__internal_compute_balance_summary(p_target_app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'UPSERT_EMPLOYEE_PROFILE_ADMIN',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

create or replace function public.leave_management_set_department_approver_admin(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_unit_kind text,
  p_approver_app_user_id uuid,
  p_valid_from date,
  p_expected_row_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_unit text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind, '')));
  v_valid_from date := coalesce(p_valid_from, v_today);
  v_current public.leave_department_approvers%rowtype;
  v_has_current boolean := false;
  v_new_row public.leave_department_approvers%rowtype;
  v_approver_user public.direct_entry_app_users%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  ) then
    raise exception 'LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_REQUIRED');

  if v_unit not in ('MARKETING', 'IT', 'ACCOUNTING') then
    raise exception 'LEAVE_UNIT_KIND_INVALID'
      using errcode = '22023';
  end if;

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'SET_DEPARTMENT_APPROVER_ADMIN'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_approver_app_user_id is not null then
    select u.*
      into v_approver_user
      from public.direct_entry_app_users u
     where u.app_user_id = p_approver_app_user_id
       and u.enabled = true;

    if not found then
      raise exception 'LEAVE_APPROVER_USER_NOT_FOUND'
        using errcode = 'P0002';
    end if;
  end if;

  select da.*
    into v_current
    from public.leave_department_approvers da
   where da.unit_kind = v_unit
     and da.is_current = true
   for update;

  if found then
    v_has_current := true;
    if p_expected_row_version is null or v_current.row_version <> p_expected_row_version then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = '40001';
    end if;

    update public.leave_department_approvers
       set is_current = false,
           valid_to = greatest(v_current.valid_from + 1, v_valid_from),
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now()),
           updated_by_app_user_id = p_actor_app_user_id
     where approver_assignment_id = v_current.approver_assignment_id;
  else
    if coalesce(p_expected_row_version, 0) <> 0 then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = '40001';
    end if;
  end if;

  if p_approver_app_user_id is not null then
    insert into public.leave_department_approvers (
      unit_kind,
      approver_app_user_id,
      valid_from,
      valid_to,
      is_current,
      reason,
      row_version,
      updated_by_app_user_id
    )
    values (
      v_unit,
      p_approver_app_user_id,
      v_valid_from,
      null,
      true,
      v_reason,
      case when v_has_current then v_current.row_version + 1 else 1 end,
      p_actor_app_user_id
    )
    returning * into v_new_row;
  end if;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    reason,
    payload
  )
  values (
    'DEPARTMENT_APPROVER_UPDATED',
    p_actor_app_user_id,
    p_approver_app_user_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'unit_kind', v_unit,
      'approver_app_user_id', p_approver_app_user_id,
      'valid_from', v_valid_from
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'department_approver', case
      when p_approver_app_user_id is not null then
        pg_catalog.jsonb_build_object(
          'approver_assignment_id', v_new_row.approver_assignment_id,
          'unit_kind', v_new_row.unit_kind,
          'approver_app_user_id', v_new_row.approver_app_user_id,
          'approver', public.leave_management__internal_account_summary(v_new_row.approver_app_user_id),
          'valid_from', v_new_row.valid_from,
          'valid_to', v_new_row.valid_to,
          'is_current', v_new_row.is_current,
          'reason', v_new_row.reason,
          'row_version', v_new_row.row_version
        )
      else
        null
    end
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'SET_DEPARTMENT_APPROVER_ADMIN',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

create or replace function public.leave_management_manage_module_grant_admin(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_action text,
  p_target_app_user_id uuid,
  p_role_code text,
  p_expected_row_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_reason text;
  v_action text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_action, '')));
  v_role text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_role_code, '')));
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_current public.leave_module_grants%rowtype;
  v_has_current boolean := false;
  v_new_row public.leave_module_grants%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'is_full_admin')::boolean, false) then
    raise exception 'LEAVE_MODULE_GRANT_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_REQUIRED');

  if v_action not in ('GRANT', 'REVOKE')
     or v_role not in ('HR_REPORT_VIEWER', 'HR_LEAVE_OPERATOR', 'LEAVE_ADMIN_BOD_APPROVER') then
    raise exception 'LEAVE_MODULE_GRANT_INVALID'
      using errcode = '22023';
  end if;

  select u.*
    into v_target_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;

  if not found then
    raise exception 'LEAVE_TARGET_USER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'MANAGE_MODULE_GRANT_ADMIN'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select g.*
    into v_current
    from public.leave_module_grants g
   where g.app_user_id = p_target_app_user_id
     and g.role_code = v_role
     and g.is_current = true
   for update;

  if found then
    v_has_current := true;
    if p_expected_row_version is null or v_current.row_version <> p_expected_row_version then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = '40001';
    end if;
  else
    if coalesce(p_expected_row_version, 0) <> 0 then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = '40001';
    end if;
  end if;

  if v_action = 'GRANT' then
    if v_has_current then
      update public.leave_module_grants
         set reason = v_reason,
             row_version = row_version + 1,
             updated_at = pg_catalog.timezone('utc', pg_catalog.now()),
             updated_by_app_user_id = p_actor_app_user_id
       where grant_id = v_current.grant_id
       returning * into v_new_row;
    else
      insert into public.leave_module_grants (
        app_user_id,
        role_code,
        valid_from,
        valid_to,
        is_current,
        reason,
        row_version,
        updated_by_app_user_id
      )
      values (
        p_target_app_user_id,
        v_role,
        v_today,
        null,
        true,
        v_reason,
        1,
        p_actor_app_user_id
      )
      returning * into v_new_row;
    end if;
  else
    if not v_has_current then
      raise exception 'LEAVE_MODULE_GRANT_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    update public.leave_module_grants
       set is_current = false,
           valid_to = greatest(v_current.valid_from + 1, v_today),
           reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now()),
           updated_by_app_user_id = p_actor_app_user_id
     where grant_id = v_current.grant_id
     returning * into v_new_row;
  end if;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    reason,
    payload
  )
  values (
    'MODULE_GRANT_' || v_action,
    p_actor_app_user_id,
    p_target_app_user_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'grant_id', v_new_row.grant_id,
      'role_code', v_new_row.role_code,
      'is_current', v_new_row.is_current,
      'row_version', v_new_row.row_version
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'grant', pg_catalog.jsonb_build_object(
      'grant_id', v_new_row.grant_id,
      'app_user_id', v_new_row.app_user_id,
      'account', public.leave_management__internal_account_summary(v_new_row.app_user_id),
      'role_code', v_new_row.role_code,
      'valid_from', v_new_row.valid_from,
      'valid_to', v_new_row.valid_to,
      'is_current', v_new_row.is_current,
      'reason', v_new_row.reason,
      'row_version', v_new_row.row_version
    )
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'MANAGE_MODULE_GRANT_ADMIN',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;


create or replace function public.leave_management_preview_opening_batch(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_leave_year integer,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_item jsonb;
  v_idx integer := 0;
  v_target_id_text text;
  v_target_id uuid;
  v_carry_units integer;
  v_open_units integer;
  v_sen_units integer;
  v_note text;
  v_seen_ids uuid[] := array[]::uuid[];
  v_account jsonb;
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean;
  v_row_errors jsonb;
  v_preview_rows jsonb := '[]'::jsonb;
  v_error_count integer := 0;
  v_total_carry integer := 0;
  v_total_open integer := 0;
  v_total_sen integer := 0;
  v_has_carry_expiry_error boolean := false;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_year < 2020 or v_year > 2100 then
    raise exception 'LEAVE_YEAR_INVALID'
      using errcode = '22023';
  end if;

  if p_rows is null
     or pg_catalog.jsonb_typeof(p_rows) <> 'array'
     or pg_catalog.jsonb_array_length(p_rows) < 1
     or pg_catalog.jsonb_array_length(p_rows) > 300 then
    raise exception 'LEAVE_OPENING_ROWS_INVALID'
      using errcode = '22023';
  end if;

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  for v_item in
    select value
      from pg_catalog.jsonb_array_elements(p_rows)
  loop
    v_idx := v_idx + 1;
    v_row_errors := '[]'::jsonb;
    v_target_id := null;
    v_account := null;

    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ROW_NOT_OBJECT');
    else
      v_target_id_text := pg_catalog.btrim(coalesce(v_item->>'app_user_id', ''));
      begin
        v_target_id := v_target_id_text::uuid;
      exception
        when others then
          v_target_id := null;
      end;

      begin
        v_carry_units := coalesce((v_item->>'carry_over_units')::integer, 0);
        v_open_units := coalesce((v_item->>'opening_current_year_units')::integer, 0);
        v_sen_units := coalesce((v_item->>'seniority_units')::integer, 0);
      exception
        when others then
          v_carry_units := -1;
          v_open_units := -1;
          v_sen_units := -1;
      end;

      v_note := nullif(pg_catalog.btrim(coalesce(v_item->>'note', '')), '');

      if v_target_id is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('INVALID_APP_USER_ID');
      else
        if v_target_id = any(v_seen_ids) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('DUPLICATE_APP_USER_IN_BATCH');
        else
          v_seen_ids := pg_catalog.array_append(v_seen_ids, v_target_id);
        end if;

        v_account := public.leave_management__internal_account_summary(v_target_id);
        if v_account is null then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('APP_USER_NOT_FOUND');
        end if;

        select p.*
          into v_profile
          from public.leave_employee_profiles p
         where p.app_user_id = v_target_id;
        v_has_profile := found;

        if v_has_profile and v_profile.is_shared_non_employee then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('SHARED_ACCOUNT_NOT_ELIGIBLE');
        end if;
      end if;

      if v_carry_units < 0 or v_carry_units > 120
         or v_open_units < 0 or v_open_units > 120
         or v_sen_units < 0 or v_sen_units > 60 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('UNITS_OUT_OF_RANGE');
      elsif (v_carry_units + v_open_units + v_sen_units) <= 0 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ZERO_UNITS_ROW');
      end if;

      if v_carry_units > 0 and v_carry_over_expiry is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED');
        v_has_carry_expiry_error := true;
      end if;

      if v_target_id is not null and v_carry_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'CARRY_OVER'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('CARRY_OVER_LOT_ALREADY_EXISTS');
        end if;
      end if;

      if v_target_id is not null and v_open_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'OPENING_CURRENT_YEAR'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('OPENING_CURRENT_YEAR_LOT_ALREADY_EXISTS');
        end if;
      end if;
    end if;

    if pg_catalog.jsonb_array_length(v_row_errors) > 0 then
      v_error_count := v_error_count + 1;
    else
      v_total_carry := v_total_carry + v_carry_units;
      v_total_open := v_total_open + v_open_units;
      v_total_sen := v_total_sen + v_sen_units;
    end if;

    v_preview_rows := v_preview_rows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'row_index', v_idx,
        'app_user_id', v_target_id,
        'account', v_account,
        'carry_over_units', greatest(coalesce(v_carry_units, 0), 0),
        'opening_current_year_units', greatest(coalesce(v_open_units, 0), 0),
        'seniority_units', greatest(coalesce(v_sen_units, 0), 0),
        'note', v_note,
        'valid', (pg_catalog.jsonb_array_length(v_row_errors) = 0),
        'errors', v_row_errors
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'leave_year', v_year,
    'carry_over_expires_after_date', v_carry_over_expiry,
    'valid', (v_error_count = 0),
    'has_carry_over_expiry_error', v_has_carry_expiry_error,
    'row_count', v_idx,
    'error_row_count', v_error_count,
    'total_carry_over_units', v_total_carry,
    'total_opening_current_year_units', v_total_open,
    'total_seniority_units', v_total_sen,
    'rows', v_preview_rows
  );
end;
$function$;

create or replace function public.leave_management_apply_opening_batch(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_leave_year integer,
  p_rows jsonb,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_preview jsonb;
  v_lock_id uuid;
  v_batch public.leave_opening_batches%rowtype;
  v_carry_expiry date;
  v_row jsonb;
  v_target_id uuid;
  v_carry_units integer;
  v_open_units integer;
  v_sen_units integer;
  v_lot_id uuid;
  v_applied_rows jsonb := '[]'::jsonb;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_REQUIRED');

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'APPLY_OPENING_BATCH'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_rows is not null and pg_catalog.jsonb_typeof(p_rows) = 'array' then
    for v_lock_id in
      select distinct (elem->>'app_user_id')::uuid as uid
        from pg_catalog.jsonb_array_elements(p_rows) as elem
       where pg_catalog.jsonb_typeof(elem) = 'object'
         and coalesce(elem->>'app_user_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       order by uid asc
    loop
      perform public.leave_management__internal_lock_employee(v_lock_id);
    end loop;
  end if;

  v_preview := public.leave_management_preview_opening_batch(
    p_actor_auth_subject,
    p_actor_app_user_id,
    v_year,
    p_rows
  );

  if not coalesce((v_preview->>'valid')::boolean, false) then
    if coalesce((v_preview->>'has_carry_over_expiry_error')::boolean, false) then
      raise exception 'LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED'
        using errcode = '22023';
    end if;
    raise exception 'LEAVE_OPENING_BATCH_VALIDATION_FAILED'
      using errcode = '22023';
  end if;

  v_carry_expiry := nullif(v_preview->>'carry_over_expires_after_date', '')::date;

  insert into public.leave_opening_batches (
    leave_year,
    batch_kind,
    row_count,
    total_carry_over_units,
    total_opening_units,
    total_seniority_units,
    reason,
    payload,
    applied_by_app_user_id
  )
  values (
    v_year,
    case when (v_preview->>'row_count')::integer = 1 then 'SINGLE' else 'BULK' end,
    (v_preview->>'row_count')::integer,
    (v_preview->>'total_carry_over_units')::integer,
    (v_preview->>'total_opening_current_year_units')::integer,
    (v_preview->>'total_seniority_units')::integer,
    v_reason,
    v_preview->'rows',
    p_actor_app_user_id
  )
  returning * into v_batch;

  for v_row in
    select value
      from pg_catalog.jsonb_array_elements(v_preview->'rows')
  loop
    v_target_id := (v_row->>'app_user_id')::uuid;
    v_carry_units := (v_row->>'carry_over_units')::integer;
    v_open_units := (v_row->>'opening_current_year_units')::integer;
    v_sen_units := (v_row->>'seniority_units')::integer;

    if v_carry_units > 0 then
      insert into public.leave_lots (
        app_user_id,
        leave_year,
        lot_kind,
        accrual_month,
        granted_units,
        usable_from_date,
        expires_after_date,
        source_ref,
        opening_batch_id,
        created_by_app_user_id
      )
      values (
        v_target_id,
        v_year,
        'CARRY_OVER',
        null,
        v_carry_units,
        pg_catalog.make_date(v_year, 1, 1),
        v_carry_expiry,
        pg_catalog.format('OPENING_CARRY_OVER:%s:%s', v_year, v_batch.batch_id),
        v_batch.batch_id,
        p_actor_app_user_id
      )
      returning lot_id into v_lot_id;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        opening_batch_id,
        entry_type,
        effective_date,
        delta_available_units,
        delta_reserved_units,
        delta_consumed_units,
        delta_expired_units,
        actor_app_user_id,
        reason,
        metadata
      )
      values (
        v_target_id,
        v_lot_id,
        v_batch.batch_id,
        'GRANT_OPENING_CARRY_OVER',
        pg_catalog.make_date(v_year, 1, 1),
        v_carry_units,
        0,
        0,
        0,
        p_actor_app_user_id,
        v_reason,
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'expires_after_date', v_carry_expiry,
          'note', v_row->>'note'
        )
      );
    end if;

    if v_open_units > 0 then
      insert into public.leave_lots (
        app_user_id,
        leave_year,
        lot_kind,
        accrual_month,
        granted_units,
        usable_from_date,
        expires_after_date,
        source_ref,
        opening_batch_id,
        created_by_app_user_id
      )
      values (
        v_target_id,
        v_year,
        'OPENING_CURRENT_YEAR',
        null,
        v_open_units,
        pg_catalog.make_date(v_year, 1, 1),
        pg_catalog.make_date(v_year, 12, 31),
        pg_catalog.format('OPENING_CURRENT_YEAR:%s:%s', v_year, v_batch.batch_id),
        v_batch.batch_id,
        p_actor_app_user_id
      )
      returning lot_id into v_lot_id;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        opening_batch_id,
        entry_type,
        effective_date,
        delta_available_units,
        delta_reserved_units,
        delta_consumed_units,
        delta_expired_units,
        actor_app_user_id,
        reason,
        metadata
      )
      values (
        v_target_id,
        v_lot_id,
        v_batch.batch_id,
        'GRANT_OPENING_CURRENT_YEAR',
        pg_catalog.make_date(v_year, 1, 1),
        v_open_units,
        0,
        0,
        0,
        p_actor_app_user_id,
        v_reason,
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'note', v_row->>'note'
        )
      );
    end if;

    if v_sen_units > 0 then
      insert into public.leave_lots (
        app_user_id,
        leave_year,
        lot_kind,
        accrual_month,
        granted_units,
        usable_from_date,
        expires_after_date,
        source_ref,
        opening_batch_id,
        created_by_app_user_id
      )
      values (
        v_target_id,
        v_year,
        'SENIORITY_GRANT',
        null,
        v_sen_units,
        pg_catalog.make_date(v_year, 1, 1),
        pg_catalog.make_date(v_year, 12, 31),
        pg_catalog.format('OPENING_SENIORITY:%s:%s', v_year, v_batch.batch_id),
        v_batch.batch_id,
        p_actor_app_user_id
      )
      returning lot_id into v_lot_id;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        opening_batch_id,
        entry_type,
        effective_date,
        delta_available_units,
        delta_reserved_units,
        delta_consumed_units,
        delta_expired_units,
        actor_app_user_id,
        reason,
        metadata
      )
      values (
        v_target_id,
        v_lot_id,
        v_batch.batch_id,
        'GRANT_SENIORITY',
        pg_catalog.make_date(v_year, 1, 1),
        v_sen_units,
        0,
        0,
        0,
        p_actor_app_user_id,
        v_reason,
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'note', v_row->>'note'
        )
      );
    end if;

    perform public.leave_management__internal_sync_employee_accruals(v_target_id, v_today);

    v_applied_rows := v_applied_rows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'app_user_id', v_target_id,
        'balance', public.leave_management__internal_compute_balance_summary(v_target_id, v_year, v_today)
      )
    );
  end loop;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    opening_batch_id,
    reason,
    payload
  )
  values (
    'OPENING_BATCH_APPLIED',
    p_actor_app_user_id,
    v_batch.batch_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'leave_year', v_year,
      'batch_kind', v_batch.batch_kind,
      'row_count', v_batch.row_count,
      'total_carry_over_units', v_batch.total_carry_over_units,
      'total_opening_units', v_batch.total_opening_units,
      'total_seniority_units', v_batch.total_seniority_units
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'batch', pg_catalog.jsonb_build_object(
      'batch_id', v_batch.batch_id,
      'leave_year', v_batch.leave_year,
      'batch_kind', v_batch.batch_kind,
      'row_count', v_batch.row_count,
      'total_carry_over_units', v_batch.total_carry_over_units,
      'total_opening_units', v_batch.total_opening_units,
      'total_seniority_units', v_batch.total_seniority_units,
      'reason', v_batch.reason,
      'applied_at', v_batch.applied_at
    ),
    'applied_rows', v_applied_rows
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'APPLY_OPENING_BATCH',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

create or replace function public.leave_management_monthly_report(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_year_month text,
  p_unit_kind_filter text default null,
  p_search text default null,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_ym text := pg_catalog.btrim(coalesce(p_year_month, pg_catalog.to_char(v_today, 'YYYY-MM')));
  v_unit_filter text := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind_filter, ''))), '');
  v_search text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, ''))), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 500));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_month_start date;
  v_month_end date;
  v_year integer;
  v_month integer;
  v_sync_as_of date;
  v_emp record;
  v_rows jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_view_monthly_report')::boolean, false) then
    raise exception 'LEAVE_REPORT_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_ym !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'LEAVE_REPORT_YEAR_MONTH_INVALID'
      using errcode = '22023';
  end if;

  if v_unit_filter is not null
     and v_unit_filter not in ('ALL', 'UNCLASSIFIED', 'RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD') then
    raise exception 'LEAVE_FILTER_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := (v_ym || '-01')::date;
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_year := pg_catalog.date_part('year', v_month_start)::integer;
  v_month := pg_catalog.date_part('month', v_month_start)::integer;
  v_sync_as_of := least(v_today, v_month_end);

  for v_emp in
    select u.app_user_id
      from public.direct_entry_app_users u
      left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
     where coalesce(p.is_shared_non_employee, false) = false
     order by u.app_user_id asc
  loop
    perform public.leave_management__internal_sync_employee_accruals(v_emp.app_user_id, v_sync_as_of);
  end loop;

  select count(*)::integer
    into v_total
    from public.direct_entry_app_users u
    left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
    left join public.direct_entry_app_user_recruiter_links l
      on l.app_user_id = u.app_user_id
     and l.verified = true
     and l.is_current = true
    left join public.recruiters r on r.recruiter_id = l.recruiter_id
   where coalesce(p.is_shared_non_employee, false) = false
     and (
       v_unit_filter is null
       or v_unit_filter = 'ALL'
       or coalesce(p.unit_kind, 'UNCLASSIFIED') = v_unit_filter
     )
     and (
       v_search is null
       or pg_catalog.lower(coalesce(r.display_name, u.display_name, '')) like '%' || v_search || '%'
       or pg_catalog.lower(coalesce(r.personnel_code, '')) like '%' || v_search || '%'
     );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'app_user_id', sub.app_user_id,
               'account', sub.account,
               'routing', sub.routing,
               'employment_status', sub.employment_status,
               'unit_kind', sub.unit_kind,
               'work_start_date', sub.work_start_date,
               'official_effective_date', sub.official_effective_date,
               'month_paid_leave_units', sub.month_paid_leave_units,
               'month_unpaid_probation_units', sub.month_unpaid_probation_units,
               'month_unpaid_other_units', sub.month_unpaid_other_units,
               'month_pending_units', sub.month_pending_units,
               'month_approved_request_count', sub.month_approved_request_count,
               'balance', sub.balance
             )
             order by sub.sort_name asc, sub.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_rows
    from (
      select u.app_user_id,
             coalesce(r.display_name, u.display_name) as sort_name,
             public.leave_management__internal_account_summary(u.app_user_id) as account,
             public.leave_management__internal_resolve_routing(u.app_user_id, v_sync_as_of) as routing,
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             coalesce(p.unit_kind, 'UNCLASSIFIED') as unit_kind,
             p.work_start_date,
             p.official_effective_date,
             coalesce(m.paid_units, 0)::integer as month_paid_leave_units,
             coalesce(m.unpaid_probation_units, 0)::integer as month_unpaid_probation_units,
             coalesce(m.unpaid_other_units, 0)::integer as month_unpaid_other_units,
             coalesce(m.pending_units, 0)::integer as month_pending_units,
             coalesce(m.approved_request_count, 0)::integer as month_approved_request_count,
             public.leave_management__internal_compute_balance_summary(u.app_user_id, v_year, v_sync_as_of) as balance
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
        left join public.direct_entry_app_user_recruiter_links l
          on l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
        left join public.recruiters r on r.recruiter_id = l.recruiter_id
        left join lateral (
          select coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and req.pay_treatment = 'PAID_LEAVE'),
                   0
                 ) as paid_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and req.pay_treatment = 'UNPAID_PROBATION'),
                   0
                 ) as unpaid_probation_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and req.pay_treatment = 'UNPAID_UNCONFIGURED_PROFILE'),
                   0
                 ) as unpaid_other_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'PENDING'),
                   0
                 ) as pending_units,
                 count(distinct req.request_id)
                   filter (where req.status = 'APPROVED') as approved_request_count
            from public.leave_request_days d
            join public.leave_requests req on req.request_id = d.request_id
           where d.app_user_id = u.app_user_id
             and d.leave_date between v_month_start and v_month_end
        ) m on true
       where coalesce(p.is_shared_non_employee, false) = false
         and (
           v_unit_filter is null
           or v_unit_filter = 'ALL'
           or coalesce(p.unit_kind, 'UNCLASSIFIED') = v_unit_filter
         )
         and (
           v_search is null
           or pg_catalog.lower(coalesce(r.display_name, u.display_name, '')) like '%' || v_search || '%'
           or pg_catalog.lower(coalesce(r.personnel_code, '')) like '%' || v_search || '%'
         )
       order by coalesce(r.display_name, u.display_name) asc, u.app_user_id asc
       limit v_limit
      offset v_offset
    ) sub;

  return pg_catalog.jsonb_build_object(
    'year_month', v_ym,
    'leave_year', v_year,
    'month', v_month,
    'as_of_date', v_sync_as_of,
    'unit_kind_filter', coalesce(v_unit_filter, 'ALL'),
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'rows', v_rows
  );
end;
$function$;

-- =====================================================================
-- 5. OWNER ALIGNMENT, TABLE/FUNCTION ACL, AND INSTALL-TIME SELF-CHECK
-- =====================================================================

do $owner_align$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_tbl text;
  v_rel_owner_oid oid;
  v_fn regprocedure;
  v_proc_owner_oid oid;
  v_fn_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner is null then
    raise exception 'LEAVE_WP1_OWNER_RESOLUTION_FAILED';
  end if;

  foreach v_tbl in array array[
    'leave_policy_configs',
    'leave_policy_revisions',
    'leave_employee_profiles',
    'leave_department_approvers',
    'leave_module_grants',
    'leave_opening_batches',
    'leave_lots',
    'leave_requests',
    'leave_request_days',
    'leave_request_lot_allocations',
    'leave_ledger_entries',
    'leave_audit_events',
    'leave_idempotency_records'
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
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'leave_management%'
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;

  for v_fn_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname like 'leave_management%'
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_mapping(uuid, uuid) to %I',
      v_fn_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid, text) to %I',
      v_fn_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_scope(uuid, text) to %I',
      v_fn_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_authorization_date() to %I',
      v_fn_owner
    );
  end loop;
end;
$owner_align$;

revoke all on table
  public.leave_policy_configs,
  public.leave_policy_revisions,
  public.leave_employee_profiles,
  public.leave_department_approvers,
  public.leave_module_grants,
  public.leave_opening_batches,
  public.leave_lots,
  public.leave_requests,
  public.leave_request_days,
  public.leave_request_lot_allocations,
  public.leave_ledger_entries,
  public.leave_audit_events,
  public.leave_idempotency_records
from public, anon, authenticated, service_role;

revoke all on function
  public.leave_management__internal_immutable_guard(),
  public.leave_management__internal_business_date(),
  public.leave_management__internal_validate_reason(text, text),
  public.leave_management__internal_lock_employee(uuid),
  public.leave_management__internal_resolve_carry_over_expiry_date(integer, integer, integer),
  public.leave_management__internal_account_summary(uuid),
  public.leave_management__internal_resolve_authority(uuid, uuid),
  public.leave_management__internal_resolve_routing(uuid, date),
  public.leave_management__internal_can_actor_decide_request(uuid, public.leave_requests, date),
  public.leave_management__internal_sync_employee_accruals(uuid, date),
  public.leave_management__internal_compute_balance_summary(uuid, integer, date),
  public.leave_management__internal_project_request(public.leave_requests)
from public, anon, authenticated, service_role;

revoke all on function
  public.leave_management_get_my_summary(uuid, uuid, integer),
  public.leave_management_create_request(uuid, uuid, jsonb, text, text, text),
  public.leave_management_withdraw_request(uuid, uuid, uuid, integer, text, text, text),
  public.leave_management_list_approval_inbox(uuid, uuid, text, integer, integer),
  public.leave_management_decide_request(uuid, uuid, uuid, text, integer, text, text, text),
  public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer),
  public.leave_management_update_policy_admin(uuid, uuid, integer, integer, integer, text, text, text),
  public.leave_management_upsert_employee_profile_admin(uuid, uuid, uuid, boolean, text, text, date, date, date, integer, integer, text, text, text),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.leave_management_manage_module_grant_admin(uuid, uuid, text, uuid, text, integer, text, text, text),
  public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb),
  public.leave_management_apply_opening_batch(uuid, uuid, integer, jsonb, text, text, text),
  public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.leave_management_get_my_summary(uuid, uuid, integer),
  public.leave_management_create_request(uuid, uuid, jsonb, text, text, text),
  public.leave_management_withdraw_request(uuid, uuid, uuid, integer, text, text, text),
  public.leave_management_list_approval_inbox(uuid, uuid, text, integer, integer),
  public.leave_management_decide_request(uuid, uuid, uuid, text, integer, text, text, text),
  public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer),
  public.leave_management_update_policy_admin(uuid, uuid, integer, integer, integer, text, text, text),
  public.leave_management_upsert_employee_profile_admin(uuid, uuid, uuid, boolean, text, text, date, date, date, integer, integer, text, text, text),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.leave_management_manage_module_grant_admin(uuid, uuid, text, uuid, text, integer, text, text, text),
  public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb),
  public.leave_management_apply_opening_batch(uuid, uuid, integer, jsonb, text, text, text),
  public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer)
to service_role;

do $self_check$
declare
  v_unforced_rls integer;
  v_table_grants integer;
  v_bad_secdef integer;
  v_public_exec integer;
  v_service_exec integer;
begin
  select count(*)::integer
    into v_unforced_rls
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'leave_policy_configs',
       'leave_policy_revisions',
       'leave_employee_profiles',
       'leave_department_approvers',
       'leave_module_grants',
       'leave_opening_batches',
       'leave_lots',
       'leave_requests',
       'leave_request_days',
       'leave_request_lot_allocations',
       'leave_ledger_entries',
       'leave_audit_events',
       'leave_idempotency_records'
     )
     and (not c.relrowsecurity or not c.relforcerowsecurity);

  if v_unforced_rls <> 0 then
    raise exception 'LEAVE_WP1_SELF_CHECK_RLS_FAILED (% tables)', v_unforced_rls;
  end if;

  select count(*)::integer
    into v_table_grants
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name like 'leave_%'
     and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role');

  if v_table_grants <> 0 then
    raise exception 'LEAVE_WP1_SELF_CHECK_TABLE_GRANTS_FAILED (% grants)', v_table_grants;
  end if;

  select count(*)::integer
    into v_bad_secdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'leave_management%'
     and (
       not p.prosecdef
       or coalesce(pg_catalog.array_to_string(p.proconfig, ','), '') not like '%search_path=pg_catalog, public%'
     );

  if v_bad_secdef <> 0 then
    raise exception 'LEAVE_WP1_SELF_CHECK_SECDEF_FAILED (% functions)', v_bad_secdef;
  end if;

  select count(*)::integer
    into v_public_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'leave_management%'
     and (
       pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );

  if v_public_exec <> 0 then
    raise exception 'LEAVE_WP1_SELF_CHECK_PUBLIC_EXEC_FAILED (% functions)', v_public_exec;
  end if;

  select count(*)::integer
    into v_service_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'leave_management_%'
     and p.proname not like 'leave_management\_\_internal\_%' escape '\'
     and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE');

  if v_service_exec <> 13 then
    raise exception 'LEAVE_WP1_SELF_CHECK_SERVICE_EXEC_FAILED (expected 13, got %)', v_service_exec;
  end if;
end;
$self_check$;

commit;
