-- =============================================================================
-- VFIN-01 (Work Package 2): Vendor Finance & Debt Management Backend
-- =============================================================================
-- Scope & Invariants (docs/plans/vendor-finance-agent-ready-masterplan.md):
--   1. Extend `direct_entry_capability_grants_capability_check` with exact two
--      tokens: `vendor_finance_view` and `vendor_finance_record` (31 DB tokens =
--      27 active + 4 retired compatibility tokens). Do NOT touch Team Leader
--      auto-grants (`work_report_team_leader_capability_grants`) or
--      `direct_entry_resolve_actor_context`.
--   2. Fail-closed VFIN authority guard accepts ONLY:
--      - Canonical Full Admin (`entry_admin` + `recruiter_master_manage` +
--        `team_master_manage` + effective `all` scope) -> view + record;
--      - Active membership in immutable `system_key = 'ACCOUNTING'` department
--        (`organization_departments.is_active = true`) -> view + record strictly
--        inside the VFIN boundary (never synthesizes actor-wide `all` scope or
--        non-VFIN capabilities);
--      - Direct `vendor_finance_record` grant + effective `all` scope -> view + record;
--      - Direct `vendor_finance_view` grant + effective `all` scope -> view ONLY.
--   3. Reuse canonical `public.vendors(vendor_id)` (excluding `'__system_vendor__'`);
--      do NOT create a second Vendor master and do NOT touch `teams`,
--      `recruiter_team_memberships`, `team_leader_assignments`,
--      `project_team_scopes`, Direct Entry worker documents, or Work Reports.
--   4. Append-only whole-VND `bigint` ledger (`vendor_finance_entries`),
--      opening balance batch header (`vendor_finance_opening_batches`),
--      date-anchored reconciliations (`vendor_finance_reconciliations`),
--      private R2 evidence metadata (`vendor_finance_evidence`),
--      audit log (`vendor_finance_audit_events`), idempotency ledger
--      (`vendor_finance_idempotency`), and rollback-safe document counter
--      (`vendor_finance_document_counters`).
--   5. Zero mutable `current_balance` column; per-vendor advisory + row lock
--      serialization guarantees gapless `vendor_sequence`, exact
--      `balance_before_minor` / `balance_after_minor` chain, and unique
--      server-generated `document_no`.
--   6. Every new table has RLS + FORCE RLS enabled, 0 permissive policies, and
--      zero privileges for `PUBLIC`, `anon`, `authenticated`, and `service_role`.
--      Only allowlisted `public.vendor_finance_*` RPCs are executable by
--      `service_role`.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Capability vocabulary extension (+2 VFIN tokens -> 31 total DB tokens).
-- -----------------------------------------------------------------------------
alter table public.direct_entry_capability_grants
  drop constraint direct_entry_capability_grants_capability_check;

alter table public.direct_entry_capability_grants
  add constraint direct_entry_capability_grants_capability_check
  check (capability in (
    'entry_create', 'entry_own', 'entry_team', 'entry_admin', 'entry_restore',
    'submission_create', 'change_request_create', 'change_review', 'entry_privileged_edit',
    'employment_status.request', 'employment_status.review', 'employment_status.apply',
    'document_upload', 'document_view', 'payment_view', 'payment_edit',
    'recruiter_master_manage', 'team_master_manage', 'pii_view', 'pii_export', 'audit_view',
    'catalog_master_manage', 'team_manager_assign',
    'report_form_manage', 'report_assign', 'report_view', 'report_analytics_view',
    'report_review', 'report_delegate',
    'vendor_finance_view', 'vendor_finance_record'
  ));

comment on constraint direct_entry_capability_grants_capability_check
  on public.direct_entry_capability_grants is
  'VFIN-01: canonical DB vocabulary has 31 tokens: 23 Direct Entry tokens (including four retired compatibility tokens), six active Work Reports tokens, plus two active Vendor Finance tokens (vendor_finance_view, vendor_finance_record).';

-- -----------------------------------------------------------------------------
-- 2. Tables & constraints.
-- -----------------------------------------------------------------------------
create table public.vendor_finance_document_counters (
  doc_year integer primary key
    check (doc_year between 1970 and 2999),
  last_seq bigint not null default 0
    check (last_seq >= 0),
  updated_at timestamptz not null default now()
);

alter table public.vendor_finance_document_counters enable row level security;
alter table public.vendor_finance_document_counters force row level security;

create table public.vendor_finance_opening_batches (
  batch_id uuid primary key default gen_random_uuid(),
  cutoff_date date not null,
  vendor_count integer not null
    check (vendor_count between 1 and 200),
  skipped_zero_count integer not null default 0
    check (skipped_zero_count >= 0 and skipped_zero_count <= 200),
  total_payable_minor bigint not null
    check (total_payable_minor >= 0),
  total_advance_minor bigint not null
    check (total_advance_minor >= 0),
  net_balance_minor bigint not null,
  reason text not null
    check (
      pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  created_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_by_display_name_snapshot text not null
    check (pg_catalog.length(pg_catalog.btrim(created_by_display_name_snapshot)) between 1 and 256),
  created_at timestamptz not null default now(),
  idempotency_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint vendor_finance_opening_batches_net_check
    check (net_balance_minor::numeric = total_payable_minor::numeric - total_advance_minor::numeric),
  constraint vendor_finance_opening_batches_actor_idempotency_key
    unique (created_by_user_id, idempotency_key)
);

create index vendor_finance_opening_batches_created_idx
  on public.vendor_finance_opening_batches (created_at desc, batch_id desc);

alter table public.vendor_finance_opening_batches enable row level security;
alter table public.vendor_finance_opening_batches force row level security;

create table public.vendor_finance_entries (
  entry_id uuid primary key default gen_random_uuid(),
  vendor_id text not null
    references public.vendors(vendor_id) on delete restrict
    check (
      vendor_id <> '__system_vendor__'
      and vendor_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
    ),
  vendor_sequence bigint not null
    check (vendor_sequence >= 1),
  entry_type text not null
    check (entry_type in (
      'OPENING_PAYABLE',
      'OPENING_ADVANCE',
      'DEBT_RECORDED',
      'PAYROLL_RECORDED',
      'PAYMENT_RECORDED',
      'ADVANCE_RECORDED',
      'ADJUSTMENT_INCREASE',
      'ADJUSTMENT_DECREASE',
      'REVERSAL'
    )),
  amount_minor bigint not null
    check (amount_minor > 0),
  balance_delta_minor bigint not null,
  balance_before_minor bigint not null,
  balance_after_minor bigint not null,
  effective_date date not null,
  reason text not null
    check (
      pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  document_no text not null unique
    check (document_no ~ '^VFIN-[0-9]{4}-[0-9]{6,}$'),
  vendor_display_name_snapshot text not null
    check (pg_catalog.length(pg_catalog.btrim(vendor_display_name_snapshot)) between 1 and 256),
  opening_batch_id uuid null
    references public.vendor_finance_opening_batches(batch_id) on delete restrict,
  reverses_entry_id uuid null unique
    references public.vendor_finance_entries(entry_id) on delete restrict,
  created_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_by_display_name_snapshot text not null
    check (pg_catalog.length(pg_catalog.btrim(created_by_display_name_snapshot)) between 1 and 256),
  created_at timestamptz not null default now(),
  idempotency_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint vendor_finance_entries_vendor_seq_key
    unique (vendor_id, vendor_sequence),
  constraint vendor_finance_entries_balance_equation_check
    check (balance_after_minor::numeric = balance_before_minor::numeric + balance_delta_minor::numeric),
  constraint vendor_finance_entries_sign_check
    check (
      (
        entry_type in ('OPENING_PAYABLE', 'DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE')
        and balance_delta_minor = amount_minor
      )
      or (
        entry_type in ('OPENING_ADVANCE', 'PAYMENT_RECORDED', 'ADVANCE_RECORDED', 'ADJUSTMENT_DECREASE')
        and balance_delta_minor = -amount_minor
      )
      or (
        entry_type = 'REVERSAL'
        and (balance_delta_minor = amount_minor or balance_delta_minor = -amount_minor)
      )
    ),
  constraint vendor_finance_entries_opening_link_check
    check ((entry_type in ('OPENING_PAYABLE', 'OPENING_ADVANCE')) = (opening_batch_id is not null)),
  constraint vendor_finance_entries_reversal_link_check
    check (
      (entry_type = 'REVERSAL') = (reverses_entry_id is not null)
      and (reverses_entry_id is null or reverses_entry_id <> entry_id)
    )
);

create unique index vendor_finance_entries_one_opening_per_vendor_uidx
  on public.vendor_finance_entries (vendor_id)
  where entry_type in ('OPENING_PAYABLE', 'OPENING_ADVANCE');

create unique index vendor_finance_entries_single_idempotency_uidx
  on public.vendor_finance_entries (created_by_user_id, idempotency_key)
  where opening_batch_id is null;

create index vendor_finance_entries_vendor_effective_idx
  on public.vendor_finance_entries (vendor_id, effective_date desc, vendor_sequence desc);

create index vendor_finance_entries_opening_batch_idx
  on public.vendor_finance_entries (opening_batch_id, vendor_id)
  where opening_batch_id is not null;

alter table public.vendor_finance_entries enable row level security;
alter table public.vendor_finance_entries force row level security;

create table public.vendor_finance_reconciliations (
  reconciliation_id uuid primary key default gen_random_uuid(),
  vendor_id text not null
    references public.vendors(vendor_id) on delete restrict
    check (
      vendor_id <> '__system_vendor__'
      and vendor_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
    ),
  as_of_date date not null,
  system_balance_minor bigint not null,
  confirmed_balance_minor bigint not null,
  difference_minor bigint not null,
  ledger_sequence_at_reconciliation bigint not null
    check (ledger_sequence_at_reconciliation >= 0),
  reason text not null
    check (
      pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  created_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_by_display_name_snapshot text not null
    check (pg_catalog.length(pg_catalog.btrim(created_by_display_name_snapshot)) between 1 and 256),
  created_at timestamptz not null default now(),
  idempotency_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint vendor_finance_reconciliations_diff_check
    check (difference_minor::numeric = confirmed_balance_minor::numeric - system_balance_minor::numeric),
  constraint vendor_finance_reconciliations_actor_idempotency_key
    unique (created_by_user_id, idempotency_key)
);

create index vendor_finance_reconciliations_vendor_date_idx
  on public.vendor_finance_reconciliations (vendor_id, as_of_date desc, created_at desc, reconciliation_id desc);

alter table public.vendor_finance_reconciliations enable row level security;
alter table public.vendor_finance_reconciliations force row level security;

create table public.vendor_finance_evidence (
  evidence_id uuid primary key default gen_random_uuid(),
  entry_id uuid null
    references public.vendor_finance_entries(entry_id) on delete restrict,
  reconciliation_id uuid null
    references public.vendor_finance_reconciliations(reconciliation_id) on delete restrict,
  status text not null
    check (status in ('RESERVED', 'READY', 'FAILED', 'EXPIRED')),
  storage_key text not null unique
    check (
      storage_key ~ '^vfin-01/(?:entry|reconciliation)/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  mime_type text not null
    check (mime_type in ('image/jpeg', 'image/png')),
  size_bytes integer not null
    check (size_bytes between 1 and 10485760),
  checksum_sha256 text not null
    check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  reserved_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finalized_at timestamptz null,
  cleanup_after timestamptz null,
  cleaned_up_at timestamptz null,
  failure_code text null
    check (failure_code is null or pg_catalog.length(pg_catalog.btrim(failure_code)) between 1 and 128),
  idempotency_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint vendor_finance_evidence_xor_target_check
    check (pg_catalog.num_nonnulls(entry_id, reconciliation_id) = 1),
  constraint vendor_finance_evidence_status_timestamps_check
    check (
      expires_at > reserved_at
      and (
        (status = 'RESERVED' and finalized_at is null and cleaned_up_at is null and failure_code is null)
        or (status = 'READY' and finalized_at is not null and cleanup_after is null and cleaned_up_at is null and failure_code is null)
        or (status in ('FAILED', 'EXPIRED') and finalized_at is null and cleanup_after is not null)
      )
    ),
  constraint vendor_finance_evidence_actor_idempotency_key
    unique (reserved_by_user_id, idempotency_key)
);

create unique index vendor_finance_evidence_one_ready_entry_uidx
  on public.vendor_finance_evidence (entry_id)
  where entry_id is not null and status = 'READY';

create unique index vendor_finance_evidence_one_ready_reconciliation_uidx
  on public.vendor_finance_evidence (reconciliation_id)
  where reconciliation_id is not null and status = 'READY';

create unique index vendor_finance_evidence_one_reserved_entry_uidx
  on public.vendor_finance_evidence (entry_id)
  where entry_id is not null and status = 'RESERVED';

create unique index vendor_finance_evidence_one_reserved_reconciliation_uidx
  on public.vendor_finance_evidence (reconciliation_id)
  where reconciliation_id is not null and status = 'RESERVED';

create index vendor_finance_evidence_cleanup_idx
  on public.vendor_finance_evidence (cleanup_after asc)
  where status in ('FAILED', 'EXPIRED') and cleaned_up_at is null;

alter table public.vendor_finance_evidence enable row level security;
alter table public.vendor_finance_evidence force row level security;

create table public.vendor_finance_idempotency (
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  idempotency_key uuid not null,
  action text not null
    check (action in (
      'RECORD_ENTRY',
      'REVERSE_ENTRY',
      'APPLY_OPENING_BATCH',
      'CREATE_RECONCILIATION',
      'RESERVE_EVIDENCE'
    )),
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_user_id, idempotency_key)
);

alter table public.vendor_finance_idempotency enable row level security;
alter table public.vendor_finance_idempotency force row level security;

create table public.vendor_finance_audit_events (
  audit_id uuid primary key default gen_random_uuid(),
  vendor_id text null
    references public.vendors(vendor_id) on delete restrict,
  entry_id uuid null
    references public.vendor_finance_entries(entry_id) on delete restrict,
  opening_batch_id uuid null
    references public.vendor_finance_opening_batches(batch_id) on delete restrict,
  reconciliation_id uuid null
    references public.vendor_finance_reconciliations(reconciliation_id) on delete restrict,
  evidence_id uuid null
    references public.vendor_finance_evidence(evidence_id) on delete restrict,
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  authority_source text not null
    check (authority_source in (
      'full_admin',
      'accounting_department',
      'direct_grant_record'
    )),
  action text not null
    check (action in (
      'OPENING_BATCH_APPLIED',
      'ENTRY_RECORDED',
      'ENTRY_REVERSED',
      'RECONCILIATION_CREATED',
      'EVIDENCE_RESERVED',
      'EVIDENCE_FINALIZED',
      'EVIDENCE_FAILED',
      'EVIDENCE_EXPIRED'
    )),
  reason text null
    check (reason is null or pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 4000),
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key uuid null,
  created_at timestamptz not null default now()
);

create index vendor_finance_audit_events_vendor_idx
  on public.vendor_finance_audit_events (vendor_id, created_at desc)
  where vendor_id is not null;

alter table public.vendor_finance_audit_events enable row level security;
alter table public.vendor_finance_audit_events force row level security;

-- -----------------------------------------------------------------------------
-- 3. Internal immutability, ledger chain integrity, arithmetic & authority helpers.
-- -----------------------------------------------------------------------------
create or replace function public.vendor_finance__internal_immutable_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  raise exception 'VENDOR_FINANCE_IMMUTABLE_RECORD: % is append-only and cannot be %d',
    tg_table_name, pg_catalog.lower(tg_op)
    using errcode = '55000';
end;
$function$;

create trigger vendor_finance_opening_batches_immutable
  before update or delete on public.vendor_finance_opening_batches
  for each row execute function public.vendor_finance__internal_immutable_guard();

create trigger vendor_finance_entries_immutable
  before update or delete on public.vendor_finance_entries
  for each row execute function public.vendor_finance__internal_immutable_guard();

create trigger vendor_finance_reconciliations_immutable
  before update or delete on public.vendor_finance_reconciliations
  for each row execute function public.vendor_finance__internal_immutable_guard();

create trigger vendor_finance_idempotency_immutable
  before update or delete on public.vendor_finance_idempotency
  for each row execute function public.vendor_finance__internal_immutable_guard();

create trigger vendor_finance_audit_events_immutable
  before update or delete on public.vendor_finance_audit_events
  for each row execute function public.vendor_finance__internal_immutable_guard();

create or replace function public.vendor_finance__internal_entry_integrity_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_prev_after bigint;
  v_existing_count bigint;
  v_orig public.vendor_finance_entries%rowtype;
begin
  if coalesce(pg_catalog.current_setting('vendor_finance.entry_write_marker', true), '') <> 'on' then
    raise exception 'VENDOR_FINANCE_DIRECT_WRITE_FORBIDDEN'
      using errcode = '42501';
  end if;

  if new.vendor_sequence = 1 then
    if new.balance_before_minor <> 0 then
      raise exception 'VENDOR_FINANCE_LEDGER_INVARIANT_VIOLATION: sequence 1 must start at balance 0'
        using errcode = '23514';
    end if;

    select count(*)::bigint
      into v_existing_count
      from public.vendor_finance_entries e
     where e.vendor_id = new.vendor_id;

    if coalesce(v_existing_count, 0) <> 0 then
      raise exception 'VENDOR_FINANCE_LEDGER_INVARIANT_VIOLATION: vendor already has ledger entries'
        using errcode = '23505';
    end if;
  else
    if new.entry_type in ('OPENING_PAYABLE', 'OPENING_ADVANCE') then
      raise exception 'VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED'
        using errcode = '23505';
    end if;

    select e.balance_after_minor
      into v_prev_after
      from public.vendor_finance_entries e
     where e.vendor_id = new.vendor_id
       and e.vendor_sequence = new.vendor_sequence - 1;

    if not found or v_prev_after is distinct from new.balance_before_minor then
      raise exception 'VENDOR_FINANCE_LEDGER_INVARIANT_VIOLATION: broken balance chain on vendor %',
        new.vendor_id
        using errcode = '23514';
    end if;
  end if;

  if new.entry_type = 'REVERSAL' then
    select e.*
      into v_orig
      from public.vendor_finance_entries e
     where e.entry_id = new.reverses_entry_id;

    if not found then
      raise exception 'VENDOR_FINANCE_ENTRY_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    if v_orig.vendor_id <> new.vendor_id then
      raise exception 'VENDOR_FINANCE_REVERSAL_VENDOR_MISMATCH'
        using errcode = '23514';
    end if;

    if v_orig.entry_type = 'REVERSAL' then
      raise exception 'VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL'
        using errcode = '23514';
    end if;

    if new.amount_minor <> v_orig.amount_minor
       or new.balance_delta_minor <> -v_orig.balance_delta_minor then
      raise exception 'VENDOR_FINANCE_REVERSAL_DELTA_MISMATCH'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

create trigger vendor_finance_entries_integrity_before_insert
  before insert on public.vendor_finance_entries
  for each row execute function public.vendor_finance__internal_entry_integrity_guard();

create or replace function public.vendor_finance__internal_evidence_lifecycle_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'VENDOR_FINANCE_IMMUTABLE_RECORD: vendor_finance_evidence cannot be deleted'
      using errcode = '55000';
  end if;

  if coalesce(pg_catalog.current_setting('vendor_finance.evidence_transition', true), '') <> 'on' then
    raise exception 'VENDOR_FINANCE_DIRECT_WRITE_FORBIDDEN'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if old.evidence_id is distinct from new.evidence_id
       or old.entry_id is distinct from new.entry_id
       or old.reconciliation_id is distinct from new.reconciliation_id
       or old.storage_key is distinct from new.storage_key
       or old.mime_type is distinct from new.mime_type
       or old.size_bytes is distinct from new.size_bytes
       or old.checksum_sha256 is distinct from new.checksum_sha256
       or old.reserved_by_user_id is distinct from new.reserved_by_user_id
       or old.reserved_at is distinct from new.reserved_at
       or old.expires_at is distinct from new.expires_at
       or old.idempotency_key is distinct from new.idempotency_key
       or old.request_fingerprint is distinct from new.request_fingerprint then
      raise exception 'VENDOR_FINANCE_EVIDENCE_IMMUTABLE_COLUMN'
        using errcode = '55000';
    end if;

    if old.status = 'READY' then
      raise exception 'VENDOR_FINANCE_EVIDENCE_ALREADY_READY'
        using errcode = '55000';
    end if;

    if old.status = 'RESERVED' and new.status not in ('READY', 'FAILED', 'EXPIRED') then
      raise exception 'VENDOR_FINANCE_EVIDENCE_TRANSITION_INVALID'
        using errcode = '55000';
    end if;

    if old.status in ('FAILED', 'EXPIRED') then
      if new.status <> old.status
         or old.cleanup_after is distinct from new.cleanup_after
         or old.failure_code is distinct from new.failure_code
         or old.cleaned_up_at is not null
         or new.cleaned_up_at is null then
        raise exception 'VENDOR_FINANCE_EVIDENCE_TRANSITION_INVALID'
          using errcode = '55000';
      end if;
    end if;
  end if;

  return new;
end;
$function$;

create trigger vendor_finance_evidence_lifecycle_guard
  before insert or update or delete on public.vendor_finance_evidence
  for each row execute function public.vendor_finance__internal_evidence_lifecycle_guard();

create or replace function public.vendor_finance__internal_parse_positive_minor(
  p_raw text
)
returns bigint
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_num numeric;
begin
  if p_raw is null or p_raw !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'VENDOR_FINANCE_AMOUNT_INVALID'
      using errcode = '22023';
  end if;

  v_num := p_raw::numeric;
  if v_num > 9223372036854775807::numeric then
    raise exception 'VENDOR_FINANCE_AMOUNT_OVERFLOW'
      using errcode = '22003';
  end if;

  return v_num::bigint;
end;
$function$;

create or replace function public.vendor_finance__internal_parse_non_negative_minor(
  p_raw text
)
returns bigint
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if p_raw = '0' then
    return 0;
  end if;
  return public.vendor_finance__internal_parse_positive_minor(p_raw);
end;
$function$;

create or replace function public.vendor_finance__internal_parse_signed_minor(
  p_raw text
)
returns bigint
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_num numeric;
begin
  if p_raw is null
     or p_raw = '-0'
     or p_raw !~ '^-?(?:0|[1-9][0-9]{0,18})$' then
    raise exception 'VENDOR_FINANCE_AMOUNT_INVALID'
      using errcode = '22023';
  end if;

  v_num := p_raw::numeric;
  if v_num < (-9223372036854775808)::numeric
     or v_num > 9223372036854775807::numeric then
    raise exception 'VENDOR_FINANCE_AMOUNT_OVERFLOW'
      using errcode = '22003';
  end if;

  return v_num::bigint;
end;
$function$;

create or replace function public.vendor_finance__internal_checked_add_minor(
  p_left bigint,
  p_right bigint
)
returns bigint
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_sum numeric;
begin
  v_sum := p_left::numeric + p_right::numeric;
  if v_sum < (-9223372036854775808)::numeric
     or v_sum > 9223372036854775807::numeric then
    raise exception 'VENDOR_FINANCE_AMOUNT_OVERFLOW'
      using errcode = '22003';
  end if;
  return v_sum::bigint;
end;
$function$;

create or replace function public.vendor_finance__internal_checked_sub_minor(
  p_left bigint,
  p_right bigint
)
returns bigint
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_diff numeric;
begin
  v_diff := p_left::numeric - p_right::numeric;
  if v_diff < (-9223372036854775808)::numeric
     or v_diff > 9223372036854775807::numeric then
    raise exception 'VENDOR_FINANCE_AMOUNT_OVERFLOW'
      using errcode = '22003';
  end if;
  return v_diff::bigint;
end;
$function$;

create or replace function public.vendor_finance__internal_validate_reason(
  p_reason text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_clean text;
begin
  if p_reason is null then
    raise exception 'VENDOR_FINANCE_REASON_INVALID'
      using errcode = '22023';
  end if;
  v_clean := pg_catalog.btrim(p_reason);
  if v_clean = ''
     or pg_catalog.length(v_clean) > 4000
     or v_clean ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'VENDOR_FINANCE_REASON_INVALID'
      using errcode = '22023';
  end if;
  return v_clean;
end;
$function$;

create or replace function public.vendor_finance__internal_actor_display_name(
  p_app_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_name text;
begin
  select coalesce(
           nullif(pg_catalog.btrim(linked.display_name), ''),
           nullif(pg_catalog.btrim(u.display_name), ''),
           'Hệ thống BI'
         )
    into v_name
    from public.direct_entry_app_users u
    left join lateral (
      select r.display_name
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where u.app_user_id = p_app_user_id;

  if v_name is null then
    raise exception 'VENDOR_FINANCE_ACTOR_NOT_FOUND'
      using errcode = '42501';
  end if;

  return pg_catalog.left(v_name, 256);
end;
$function$;

create or replace function public.vendor_finance__internal_next_document_no(
  p_effective_date date
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_year integer;
  v_seq bigint;
begin
  v_year := pg_catalog.date_part('year', coalesce(p_effective_date, public.direct_entry_authorization_date()))::integer;
  if v_year < 1970 or v_year > 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  insert into public.vendor_finance_document_counters (doc_year, last_seq, updated_at)
  values (v_year, 1, now())
  on conflict (doc_year) do update
     set last_seq = public.vendor_finance_document_counters.last_seq + 1,
         updated_at = now()
  returning last_seq into v_seq;

  return 'VFIN-' || v_year::text || '-' ||
    case
      when v_seq <= 999999 then pg_catalog.lpad(v_seq::text, 6, '0')
      else v_seq::text
    end;
end;
$function$;

create or replace function public.vendor_finance__internal_document_kind(
  p_entry_type text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select case p_entry_type
    when 'PAYROLL_RECORDED' then 'PAYROLL_VOUCHER'
    when 'PAYMENT_RECORDED' then 'PAYMENT_VOUCHER'
    when 'ADVANCE_RECORDED' then 'ADVANCE_VOUCHER'
    when 'OPENING_PAYABLE' then 'OPENING_BALANCE_VOUCHER'
    when 'OPENING_ADVANCE' then 'OPENING_BALANCE_VOUCHER'
    else 'DEBT_ADJUSTMENT_VOUCHER'
  end;
$function$;

create or replace function public.vendor_finance__internal_document_title_vi(
  p_entry_type text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select case p_entry_type
    when 'PAYROLL_RECORDED' then 'Phiếu ghi nhận lương phải trả Vendor'
    when 'PAYMENT_RECORDED' then 'Phiếu ghi nhận thanh toán công nợ Vendor'
    when 'ADVANCE_RECORDED' then 'Phiếu ghi nhận ứng Vendor'
    when 'OPENING_PAYABLE' then 'Phiếu ghi nhận số dư đầu kỳ'
    when 'OPENING_ADVANCE' then 'Phiếu ghi nhận số dư đầu kỳ'
    else 'Phiếu ghi nhận phát sinh/điều chỉnh công nợ'
  end;
$function$;

create or replace function public.vendor_finance__internal_disclaimer_vi()
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select 'Chứng từ ghi nhận nội bộ trên hệ thống BI, không phải xác nhận giao dịch ngân hàng hoặc chứng minh tiền đã được chuyển.'::text;
$function$;

create or replace function public.vendor_finance__internal_resolve_authority(
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
  v_default jsonb;
  v_has_all_scope boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  v_default := public.org_department__internal_resolve_vfin_default_authority(
    p_auth_subject,
    p_app_user_id,
    v_today
  );

  if coalesce((v_default->>'allowed')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'authorization_date', v_today::text,
      'can_view', coalesce((v_default->>'can_view')::boolean, false),
      'can_record', coalesce((v_default->>'can_record')::boolean, false),
      'authority_source', coalesce(v_default->>'authority_source', 'none')
    );
  end if;

  v_has_all_scope := public.direct_entry_has_scope(p_app_user_id, 'all');
  if v_has_all_scope then
    if public.direct_entry_has_capability(p_app_user_id, 'vendor_finance_record') then
      return pg_catalog.jsonb_build_object(
        'authorization_date', v_today::text,
        'can_view', true,
        'can_record', true,
        'authority_source', 'direct_grant_record'
      );
    end if;

    if public.direct_entry_has_capability(p_app_user_id, 'vendor_finance_view') then
      return pg_catalog.jsonb_build_object(
        'authorization_date', v_today::text,
        'can_view', true,
        'can_record', false,
        'authority_source', 'direct_grant_view'
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'can_view', false,
    'can_record', false,
    'authority_source', 'none'
  );
end;
$function$;

create or replace function public.vendor_finance__internal_assert_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_require_record boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
begin
  v_auth := public.vendor_finance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  if not coalesce((v_auth->>'can_view')::boolean, false) then
    raise exception 'VENDOR_FINANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_require_record and not coalesce((v_auth->>'can_record')::boolean, false) then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  return v_auth;
end;
$function$;

create or replace function public.vendor_finance__internal_evidence_projection(
  p_entry_id uuid,
  p_reconciliation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_ev public.vendor_finance_evidence%rowtype;
begin
  if p_entry_id is not null then
    select ev.*
      into v_ev
      from public.vendor_finance_evidence ev
     where ev.entry_id = p_entry_id
       and ev.status = 'READY'
     limit 1;
  elsif p_reconciliation_id is not null then
    select ev.*
      into v_ev
      from public.vendor_finance_evidence ev
     where ev.reconciliation_id = p_reconciliation_id
       and ev.status = 'READY'
     limit 1;
  else
    return null;
  end if;

  if not found then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'evidence_id', v_ev.evidence_id,
    'status', v_ev.status,
    'mime_type', v_ev.mime_type,
    'size_bytes', v_ev.size_bytes,
    'checksum_sha256', v_ev.checksum_sha256,
    'finalized_at', pg_catalog.to_jsonb(v_ev.finalized_at)
  );
end;
$function$;

create or replace function public.vendor_finance__internal_entry_projection(
  p_entry public.vendor_finance_entries,
  p_can_record boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_reverses_doc_no text;
  v_reversed_by_id uuid;
  v_reversed_by_doc_no text;
  v_vendor_active boolean;
  v_evidence jsonb;
begin
  if p_entry.reverses_entry_id is not null then
    select e.document_no
      into v_reverses_doc_no
      from public.vendor_finance_entries e
     where e.entry_id = p_entry.reverses_entry_id;
  end if;

  select r.entry_id, r.document_no
    into v_reversed_by_id, v_reversed_by_doc_no
    from public.vendor_finance_entries r
   where r.reverses_entry_id = p_entry.entry_id;

  select v.active
    into v_vendor_active
    from public.vendors v
   where v.vendor_id = p_entry.vendor_id;

  v_evidence := public.vendor_finance__internal_evidence_projection(p_entry.entry_id, null);

  return pg_catalog.jsonb_build_object(
    'entry_id', p_entry.entry_id,
    'vendor_id', p_entry.vendor_id,
    'vendor_display_name_snapshot', p_entry.vendor_display_name_snapshot,
    'vendor_active', coalesce(v_vendor_active, false),
    'vendor_sequence', p_entry.vendor_sequence,
    'document_no', p_entry.document_no,
    'document_kind', public.vendor_finance__internal_document_kind(p_entry.entry_type),
    'document_title_vi', public.vendor_finance__internal_document_title_vi(p_entry.entry_type),
    'entry_type', p_entry.entry_type,
    'amount_minor', p_entry.amount_minor::text,
    'balance_before_minor', p_entry.balance_before_minor::text,
    'balance_delta_minor', p_entry.balance_delta_minor::text,
    'balance_after_minor', p_entry.balance_after_minor::text,
    'effective_date', p_entry.effective_date::text,
    'reason', p_entry.reason,
    'opening_batch_id', p_entry.opening_batch_id,
    'reverses_entry_id', p_entry.reverses_entry_id,
    'reverses_document_no', v_reverses_doc_no,
    'reversed_by_entry_id', v_reversed_by_id,
    'reversed_by_document_no', v_reversed_by_doc_no,
    'can_reverse', (
      coalesce(p_can_record, false)
      and p_entry.entry_type <> 'REVERSAL'
      and v_reversed_by_id is null
    ),
    'can_attach_evidence', (
      coalesce(p_can_record, false)
      and v_evidence is null
    ),
    'evidence', v_evidence,
    'created_by_display_name', p_entry.created_by_display_name_snapshot,
    'created_at', pg_catalog.to_jsonb(p_entry.created_at),
    'internal_disclaimer', public.vendor_finance__internal_disclaimer_vi()
  );
end;
$function$;

create or replace function public.vendor_finance__internal_reconciliation_projection(
  p_rec public.vendor_finance_reconciliations,
  p_can_record boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_evidence jsonb;
begin
  v_evidence := public.vendor_finance__internal_evidence_projection(null, p_rec.reconciliation_id);

  return pg_catalog.jsonb_build_object(
    'reconciliation_id', p_rec.reconciliation_id,
    'vendor_id', p_rec.vendor_id,
    'as_of_date', p_rec.as_of_date::text,
    'system_balance_minor', p_rec.system_balance_minor::text,
    'confirmed_balance_minor', p_rec.confirmed_balance_minor::text,
    'difference_minor', p_rec.difference_minor::text,
    'ledger_sequence_at_reconciliation', p_rec.ledger_sequence_at_reconciliation,
    'reason', p_rec.reason,
    'can_attach_evidence', (coalesce(p_can_record, false) and v_evidence is null),
    'evidence', v_evidence,
    'created_by_display_name', p_rec.created_by_display_name_snapshot,
    'created_at', pg_catalog.to_jsonb(p_rec.created_at)
  );
end;
$function$;

create or replace function public.vendor_finance__internal_lock_vendor(
  p_vendor_id text
)
returns public.vendors
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_vendor public.vendors%rowtype;
begin
  if p_vendor_id is null
     or p_vendor_id = '__system_vendor__'
     or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_vendor:' || p_vendor_id, 0)
  );

  select v.*
    into v_vendor
    from public.vendors v
   where v.vendor_id = p_vendor_id
     and v.vendor_id <> '__system_vendor__'
     for update;

  if not found then
    raise exception 'VENDOR_FINANCE_VENDOR_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  return v_vendor;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Allowlisted `service_role` RPCs (`public.vendor_finance_*`).
-- -----------------------------------------------------------------------------

-- 4.1 Actor access probe (used by AppShell navigation without mutating actor grants).
create or replace function public.vendor_finance_get_actor_access(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  return public.vendor_finance__internal_resolve_authority(p_auth_subject, p_app_user_id);
end;
$function$;

-- 4.2 List vendors with company-wide KPI summary & fuzzy search.
create or replace function public.vendor_finance_list_vendors(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_active_filter text default 'all',
  p_balance_filter text default 'all',
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
  v_auth jsonb;
  v_can_record boolean;
  v_search text;
  v_offset integer;
  v_summary jsonb;
  v_total integer;
  v_vendors jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, false);
  v_can_record := coalesce((v_auth->>'can_record')::boolean, false);

  if p_active_filter is null or p_active_filter not in ('all', 'active', 'inactive')
     or p_balance_filter is null or p_balance_filter not in ('all', 'payable', 'advance', 'nonzero', 'uninitialized')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = ''
       or pg_catalog.length(v_search) > 120
       or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'VENDOR_FINANCE_SEARCH_INVALID'
        using errcode = '22023';
    end if;
  else
    v_search := null;
  end if;

  v_offset := (p_page - 1) * p_page_size;

  with vendor_rollups as (
    select v.vendor_id,
           v.display_name,
           v.active,
           coalesce(lat.balance_after_minor, 0)::bigint as current_balance_minor,
           coalesce(stats.entry_count, 0)::integer as entry_count,
           coalesce(stats.has_opening_entry, false) as has_opening_entry,
           stats.last_effective_date,
           stats.last_entry_at,
           rec.last_reconciled_as_of_date
      from public.vendors v
      left join lateral (
        select e.balance_after_minor
          from public.vendor_finance_entries e
         where e.vendor_id = v.vendor_id
         order by e.vendor_sequence desc
         limit 1
      ) lat on true
      left join lateral (
        select count(*)::integer as entry_count,
               coalesce(bool_or(e.entry_type in ('OPENING_PAYABLE', 'OPENING_ADVANCE')), false) as has_opening_entry,
               max(e.effective_date) as last_effective_date,
               max(e.created_at) as last_entry_at
          from public.vendor_finance_entries e
         where e.vendor_id = v.vendor_id
      ) stats on true
      left join lateral (
        select r.as_of_date as last_reconciled_as_of_date
          from public.vendor_finance_reconciliations r
         where r.vendor_id = v.vendor_id
         order by r.as_of_date desc, r.created_at desc, r.reconciliation_id desc
         limit 1
      ) rec on true
     where v.vendor_id <> '__system_vendor__'
  ),
  company_summary as (
    select coalesce(sum(vr.current_balance_minor::numeric) filter (where vr.current_balance_minor > 0), 0::numeric) as total_payable_num,
           coalesce(sum((-vr.current_balance_minor::numeric)) filter (where vr.current_balance_minor < 0), 0::numeric) as total_advance_num,
           coalesce(sum(vr.current_balance_minor::numeric), 0::numeric) as net_balance_num,
           count(*) filter (where vr.current_balance_minor > 0)::integer as vendors_with_payable_count,
           count(*) filter (where vr.current_balance_minor < 0)::integer as vendors_with_advance_count,
           count(*) filter (where vr.current_balance_minor <> 0)::integer as vendors_with_nonzero_balance_count,
           count(*)::integer as total_vendor_count,
           count(*) filter (where vr.entry_count = 0)::integer as uninitialized_vendor_count
      from vendor_rollups vr
  ),
  filtered as (
    select vr.*
      from vendor_rollups vr
     where (
       p_active_filter = 'all'
       or (p_active_filter = 'active' and vr.active = true)
       or (p_active_filter = 'inactive' and vr.active = false)
     )
       and (
       p_balance_filter = 'all'
       or (p_balance_filter = 'payable' and vr.current_balance_minor > 0)
       or (p_balance_filter = 'advance' and vr.current_balance_minor < 0)
       or (p_balance_filter = 'nonzero' and vr.current_balance_minor <> 0)
       or (p_balance_filter = 'uninitialized' and vr.entry_count = 0)
     )
       and (
       v_search is null
       or vr.vendor_id ilike '%' || v_search || '%'
       or vr.display_name ilike '%' || v_search || '%'
     )
  )
  select pg_catalog.jsonb_build_object(
           'total_payable_minor', pg_catalog.trunc(cs.total_payable_num, 0)::text,
           'total_advance_minor', pg_catalog.trunc(cs.total_advance_num, 0)::text,
           'net_balance_minor', pg_catalog.trunc(cs.net_balance_num, 0)::text,
           'vendors_with_payable_count', cs.vendors_with_payable_count,
           'vendors_with_advance_count', cs.vendors_with_advance_count,
           'vendors_with_nonzero_balance_count', cs.vendors_with_nonzero_balance_count,
           'total_vendor_count', cs.total_vendor_count,
           'uninitialized_vendor_count', cs.uninitialized_vendor_count
         ),
         (select count(*)::integer from filtered),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'vendor_id', page_row.vendor_id,
                        'display_name', page_row.display_name,
                        'active', page_row.active,
                        'current_balance_minor', page_row.current_balance_minor::text,
                        'balance_direction', case
                          when page_row.current_balance_minor > 0 then 'PAYABLE'
                          when page_row.current_balance_minor < 0 then 'ADVANCE'
                          else 'BALANCED'
                        end,
                        'entry_count', page_row.entry_count,
                        'has_opening_entry', page_row.has_opening_entry,
                        'eligible_for_opening', (page_row.entry_count = 0),
                        'last_effective_date', case
                          when page_row.last_effective_date is null then null
                          else page_row.last_effective_date::text
                        end,
                        'last_entry_at', pg_catalog.to_jsonb(page_row.last_entry_at),
                        'last_reconciled_as_of_date', case
                          when page_row.last_reconciled_as_of_date is null then null
                          else page_row.last_reconciled_as_of_date::text
                        end
                      )
                      order by
                        (page_row.current_balance_minor = 0) asc,
                        pg_catalog.abs(page_row.current_balance_minor::numeric) desc,
                        pg_catalog.lower(page_row.display_name) asc,
                        page_row.vendor_id asc
                    )
               from (
                 select f.*
                   from filtered f
                  order by
                    (f.current_balance_minor = 0) asc,
                    pg_catalog.abs(f.current_balance_minor::numeric) desc,
                    pg_catalog.lower(f.display_name) asc,
                    f.vendor_id asc
                  limit p_page_size offset v_offset
               ) page_row
           ),
           '[]'::jsonb
         )
    into v_summary, v_total, v_vendors
    from company_summary cs;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'allowed_actions', pg_catalog.jsonb_build_object(
      'can_view', true,
      'can_record', v_can_record
    ),
    'summary', v_summary,
    'filters', pg_catalog.jsonb_build_object(
      'search', v_search,
      'active', p_active_filter,
      'balance_filter', p_balance_filter
    ),
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'vendors', v_vendors
  );
end;
$function$;

-- 4.3 Get single vendor summary, category totals & recent reconciliations.
create or replace function public.vendor_finance_get_vendor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_can_record boolean;
  v_vendor public.vendors%rowtype;
  v_current_balance bigint;
  v_latest_seq bigint;
  v_entry_count integer;
  v_has_opening boolean;
  v_totals jsonb;
  v_latest_rec jsonb;
  v_recent_recs jsonb;
  v_allowed_entry_types jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, false);
  v_can_record := coalesce((v_auth->>'can_record')::boolean, false);

  if p_vendor_id is null
     or p_vendor_id = '__system_vendor__'
     or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
      using errcode = '22023';
  end if;

  select v.*
    into v_vendor
    from public.vendors v
   where v.vendor_id = p_vendor_id
     and v.vendor_id <> '__system_vendor__';

  if not found then
    raise exception 'VENDOR_FINANCE_VENDOR_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select e.balance_after_minor, e.vendor_sequence
    into v_current_balance, v_latest_seq
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
   order by e.vendor_sequence desc
   limit 1;

  v_current_balance := coalesce(v_current_balance, 0);
  v_latest_seq := coalesce(v_latest_seq, 0);

  with entry_rows as (
    select e.*,
           exists (
             select 1
               from public.vendor_finance_entries rev
              where rev.reverses_entry_id = e.entry_id
           ) as is_reversed
      from public.vendor_finance_entries e
     where e.vendor_id = v_vendor.vendor_id
  )
  select count(*)::integer,
         coalesce(bool_or(er.entry_type in ('OPENING_PAYABLE', 'OPENING_ADVANCE')), false),
         pg_catalog.jsonb_build_object(
           'opening_payable_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'OPENING_PAYABLE' and not er.is_reversed), 0::numeric), 0)::text,
           'opening_advance_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'OPENING_ADVANCE' and not er.is_reversed), 0::numeric), 0)::text,
           'debt_recorded_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'DEBT_RECORDED' and not er.is_reversed), 0::numeric), 0)::text,
           'payroll_recorded_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'PAYROLL_RECORDED' and not er.is_reversed), 0::numeric), 0)::text,
           'payment_recorded_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'PAYMENT_RECORDED' and not er.is_reversed), 0::numeric), 0)::text,
           'advance_recorded_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'ADVANCE_RECORDED' and not er.is_reversed), 0::numeric), 0)::text,
           'adjustment_increase_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'ADJUSTMENT_INCREASE' and not er.is_reversed), 0::numeric), 0)::text,
           'adjustment_decrease_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'ADJUSTMENT_DECREASE' and not er.is_reversed), 0::numeric), 0)::text,
           'reversed_entry_count', count(*) filter (where er.entry_type = 'REVERSAL')::integer
         )
    into v_entry_count, v_has_opening, v_totals
    from entry_rows er;

  select coalesce(
           pg_catalog.jsonb_agg(
             public.vendor_finance__internal_reconciliation_projection(page_rec.rec_row, v_can_record)
             order by page_rec.as_of_date desc, page_rec.created_at desc, page_rec.reconciliation_id desc
           ),
           '[]'::jsonb
         )
    into v_recent_recs
    from (
      select r as rec_row, r.as_of_date, r.created_at, r.reconciliation_id
        from public.vendor_finance_reconciliations r
       where r.vendor_id = v_vendor.vendor_id
       order by r.as_of_date desc, r.created_at desc, r.reconciliation_id desc
       limit 10
    ) page_rec;

  if pg_catalog.jsonb_array_length(v_recent_recs) > 0 then
    v_latest_rec := v_recent_recs->0;
  else
    v_latest_rec := null;
  end if;

  if not v_can_record then
    v_allowed_entry_types := '[]'::jsonb;
  elsif v_vendor.active then
    v_allowed_entry_types := '["DEBT_RECORDED","PAYROLL_RECORDED","PAYMENT_RECORDED","ADVANCE_RECORDED","ADJUSTMENT_INCREASE","ADJUSTMENT_DECREASE"]'::jsonb;
  else
    v_allowed_entry_types := '["PAYMENT_RECORDED","ADJUSTMENT_INCREASE","ADJUSTMENT_DECREASE"]'::jsonb;
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'allowed_actions', pg_catalog.jsonb_build_object(
      'can_view', true,
      'can_record', v_can_record,
      'can_reconcile', v_can_record,
      'allowed_entry_types', v_allowed_entry_types
    ),
    'vendor', pg_catalog.jsonb_build_object(
      'vendor_id', v_vendor.vendor_id,
      'display_name', v_vendor.display_name,
      'active', v_vendor.active,
      'current_balance_minor', v_current_balance::text,
      'balance_direction', case
        when v_current_balance > 0 then 'PAYABLE'
        when v_current_balance < 0 then 'ADVANCE'
        else 'BALANCED'
      end,
      'latest_sequence', v_latest_seq,
      'entry_count', coalesce(v_entry_count, 0),
      'has_opening_entry', coalesce(v_has_opening, false),
      'eligible_for_opening', (coalesce(v_entry_count, 0) = 0),
      'totals', v_totals,
      'latest_reconciliation', v_latest_rec,
      'recent_reconciliations', v_recent_recs
    )
  );
end;
$function$;

-- 4.4 Keyset cursor ledger pagination for a vendor (`vendor_sequence DESC`).
create or replace function public.vendor_finance_list_vendor_entries(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_before_sequence bigint default null,
  p_entry_type text default null,
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
  v_can_record boolean;
  v_vendor public.vendors%rowtype;
  v_entries jsonb;
  v_has_more boolean := false;
  v_next_before_sequence bigint := null;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, false);
  v_can_record := coalesce((v_auth->>'can_record')::boolean, false);

  if p_vendor_id is null
     or p_vendor_id = '__system_vendor__'
     or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
      using errcode = '22023';
  end if;

  if p_page_size is null or p_page_size < 1 or p_page_size > 100
     or (p_before_sequence is not null and p_before_sequence < 1) then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_entry_type is not null and p_entry_type not in (
    'OPENING_PAYABLE',
    'OPENING_ADVANCE',
    'DEBT_RECORDED',
    'PAYROLL_RECORDED',
    'PAYMENT_RECORDED',
    'ADVANCE_RECORDED',
    'ADJUSTMENT_INCREASE',
    'ADJUSTMENT_DECREASE',
    'REVERSAL'
  ) then
    raise exception 'VENDOR_FINANCE_ENTRY_TYPE_INVALID'
      using errcode = '22023';
  end if;

  select v.*
    into v_vendor
    from public.vendors v
   where v.vendor_id = p_vendor_id
     and v.vendor_id <> '__system_vendor__';

  if not found then
    raise exception 'VENDOR_FINANCE_VENDOR_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  with fetched as (
    select e as entry_row,
           e.vendor_sequence,
           pg_catalog.row_number() over (order by e.vendor_sequence desc) as rn
      from public.vendor_finance_entries e
     where e.vendor_id = v_vendor.vendor_id
       and (p_before_sequence is null or e.vendor_sequence < p_before_sequence)
       and (p_entry_type is null or e.entry_type = p_entry_type)
     order by e.vendor_sequence desc
     limit (p_page_size + 1)
  )
  select exists (select 1 from fetched where rn > p_page_size),
         (select min(vendor_sequence) from fetched where rn <= p_page_size),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      public.vendor_finance__internal_entry_projection(f.entry_row, v_can_record)
                      order by f.vendor_sequence desc
                    )
               from fetched f
              where f.rn <= p_page_size
           ),
           '[]'::jsonb
         )
    into v_has_more, v_next_before_sequence, v_entries;

  if not v_has_more then
    v_next_before_sequence := null;
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'vendor_id', v_vendor.vendor_id,
    'page_size', p_page_size,
    'has_more', coalesce(v_has_more, false),
    'next_before_sequence', v_next_before_sequence,
    'entries', v_entries
  );
end;
$function$;

-- 4.5 Get single entry / immutable voucher projection (`/finance/documents/[entryId]`).
create or replace function public.vendor_finance_get_entry(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_can_record boolean;
  v_entry public.vendor_finance_entries%rowtype;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, false);
  v_can_record := coalesce((v_auth->>'can_record')::boolean, false);

  if p_entry_id is null then
    raise exception 'VENDOR_FINANCE_ENTRY_INVALID'
      using errcode = '22023';
  end if;

  select e.*
    into v_entry
    from public.vendor_finance_entries e
   where e.entry_id = p_entry_id;

  if not found then
    raise exception 'VENDOR_FINANCE_ENTRY_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'allowed_actions', pg_catalog.jsonb_build_object(
      'can_view', true,
      'can_record', v_can_record
    ),
    'entry', public.vendor_finance__internal_entry_projection(v_entry, v_can_record)
  );
end;
$function$;

-- 4.6 List reconciliations for a vendor.
create or replace function public.vendor_finance_list_vendor_reconciliations(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
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
  v_auth jsonb;
  v_can_record boolean;
  v_vendor public.vendors%rowtype;
  v_offset integer;
  v_total integer;
  v_items jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, false);
  v_can_record := coalesce((v_auth->>'can_record')::boolean, false);

  if p_vendor_id is null
     or p_vendor_id = '__system_vendor__'
     or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
      using errcode = '22023';
  end if;

  if p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  select v.*
    into v_vendor
    from public.vendors v
   where v.vendor_id = p_vendor_id
     and v.vendor_id <> '__system_vendor__';

  if not found then
    raise exception 'VENDOR_FINANCE_VENDOR_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_offset := (p_page - 1) * p_page_size;

  select count(*)::integer,
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      public.vendor_finance__internal_reconciliation_projection(page_rec.rec_row, v_can_record)
                      order by page_rec.as_of_date desc, page_rec.created_at desc, page_rec.reconciliation_id desc
                    )
               from (
                 select r as rec_row, r.as_of_date, r.created_at, r.reconciliation_id
                   from public.vendor_finance_reconciliations r
                  where r.vendor_id = v_vendor.vendor_id
                  order by r.as_of_date desc, r.created_at desc, r.reconciliation_id desc
                  limit p_page_size offset v_offset
               ) page_rec
           ),
           '[]'::jsonb
         )
    into v_total, v_items
    from public.vendor_finance_reconciliations r
   where r.vendor_id = v_vendor.vendor_id;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'vendor_id', v_vendor.vendor_id,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'reconciliations', v_items
  );
end;
$function$;

-- 4.7 Record normal ledger entry (rejects OPENING_* and REVERSAL; serializes per vendor).
create or replace function public.vendor_finance_record_entry(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_entry_type text,
  p_amount_minor text,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_vendor public.vendors%rowtype;
  v_amount bigint;
  v_delta bigint;
  v_reason text;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_actor_name text;
  v_inserted public.vendor_finance_entries%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, true);
  v_authority_source := v_auth->>'authority_source';

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'RECORD_ENTRY'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_entry_type is null or p_entry_type not in (
    'DEBT_RECORDED',
    'PAYROLL_RECORDED',
    'PAYMENT_RECORDED',
    'ADVANCE_RECORDED',
    'ADJUSTMENT_INCREASE',
    'ADJUSTMENT_DECREASE'
  ) then
    raise exception 'VENDOR_FINANCE_ENTRY_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_effective_date is null
     or pg_catalog.date_part('year', p_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_amount := public.vendor_finance__internal_parse_positive_minor(p_amount_minor);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  if not v_vendor.active
     and p_entry_type not in ('PAYMENT_RECORDED', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE') then
    raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN'
      using errcode = '23514';
  end if;

  if p_entry_type in ('DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE') then
    v_delta := v_amount;
  else
    v_delta := -v_amount;
  end if;

  select e.vendor_sequence, e.balance_after_minor
    into v_prev_seq, v_prev_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
   order by e.vendor_sequence desc
   limit 1;

  v_prev_seq := coalesce(v_prev_seq, 0);
  v_prev_balance := coalesce(v_prev_balance, 0);
  v_next_seq := v_prev_seq + 1;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(v_prev_balance, v_delta);
  v_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

  insert into public.vendor_finance_entries (
    vendor_id,
    vendor_sequence,
    entry_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    vendor_display_name_snapshot,
    opening_batch_id,
    reverses_entry_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_next_seq,
    p_entry_type,
    v_amount,
    v_delta,
    v_prev_balance,
    v_after_balance,
    p_effective_date,
    v_reason,
    v_doc_no,
    v_vendor.display_name,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_inserted.entry_id,
    p_app_user_id,
    v_authority_source,
    'ENTRY_RECORDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'document_no', v_inserted.document_no,
      'entry_type', v_inserted.entry_type,
      'amount_minor', v_inserted.amount_minor::text,
      'balance_before_minor', v_inserted.balance_before_minor::text,
      'balance_delta_minor', v_inserted.balance_delta_minor::text,
      'balance_after_minor', v_inserted.balance_after_minor::text,
      'effective_date', v_inserted.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'entry', public.vendor_finance__internal_entry_projection(v_inserted, true)
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'RECORD_ENTRY',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- 4.8 Reverse an applied non-reversal entry at most once.
create or replace function public.vendor_finance_reverse_entry(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_orig public.vendor_finance_entries%rowtype;
  v_vendor public.vendors%rowtype;
  v_effective_date date;
  v_reason text;
  v_actor_name text;
  v_existing_rev uuid;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_delta bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_entries%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, true);
  v_authority_source := v_auth->>'authority_source';

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'REVERSE_ENTRY'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_entry_id is null then
    raise exception 'VENDOR_FINANCE_ENTRY_INVALID'
      using errcode = '22023';
  end if;

  v_effective_date := coalesce(p_effective_date, public.direct_entry_authorization_date());
  if pg_catalog.date_part('year', v_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  select e.*
    into v_orig
    from public.vendor_finance_entries e
   where e.entry_id = p_entry_id;

  if not found then
    raise exception 'VENDOR_FINANCE_ENTRY_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_vendor := public.vendor_finance__internal_lock_vendor(v_orig.vendor_id);

  if v_orig.entry_type = 'REVERSAL' then
    raise exception 'VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL'
      using errcode = '23514';
  end if;

  select r.entry_id
    into v_existing_rev
    from public.vendor_finance_entries r
   where r.reverses_entry_id = v_orig.entry_id;

  if found then
    raise exception 'VENDOR_FINANCE_ENTRY_ALREADY_REVERSED'
      using errcode = '23505';
  end if;

  v_delta := -v_orig.balance_delta_minor;

  select e.vendor_sequence, e.balance_after_minor
    into v_prev_seq, v_prev_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
   order by e.vendor_sequence desc
   limit 1;

  v_next_seq := coalesce(v_prev_seq, 0) + 1;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(coalesce(v_prev_balance, 0), v_delta);
  v_doc_no := public.vendor_finance__internal_next_document_no(v_effective_date);

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

  insert into public.vendor_finance_entries (
    vendor_id,
    vendor_sequence,
    entry_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    vendor_display_name_snapshot,
    opening_batch_id,
    reverses_entry_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_next_seq,
    'REVERSAL',
    v_orig.amount_minor,
    v_delta,
    coalesce(v_prev_balance, 0),
    v_after_balance,
    v_effective_date,
    v_reason,
    v_doc_no,
    v_vendor.display_name,
    null,
    v_orig.entry_id,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  -- Reload original projection so `reversed_by_entry_id` reflects the new reversal!
  select e.* into v_orig from public.vendor_finance_entries e where e.entry_id = v_orig.entry_id;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_inserted.entry_id,
    p_app_user_id,
    v_authority_source,
    'ENTRY_REVERSED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'document_no', v_inserted.document_no,
      'reverses_entry_id', v_orig.entry_id,
      'reverses_document_no', v_orig.document_no,
      'amount_minor', v_inserted.amount_minor::text,
      'balance_before_minor', v_inserted.balance_before_minor::text,
      'balance_delta_minor', v_inserted.balance_delta_minor::text,
      'balance_after_minor', v_inserted.balance_after_minor::text,
      'effective_date', v_inserted.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'reversal_entry', public.vendor_finance__internal_entry_projection(v_inserted, true),
    'reversed_entry', public.vendor_finance__internal_entry_projection(v_orig, true)
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'REVERSE_ENTRY',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- 4.9 Preview opening balance batch (validates entire batch; skips 0-amount rows).
create or replace function public.vendor_finance_preview_opening_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_cutoff_date date,
  p_items jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_len integer;
  v_idx integer;
  v_item jsonb;
  v_vendor_id text;
  v_entry_type text;
  v_amount bigint;
  v_seen text[] := array[]::text[];
  v_vendor public.vendors%rowtype;
  v_has_entries boolean;
  v_skipped_zero integer := 0;
  v_vendor_count integer := 0;
  v_total_payable bigint := 0;
  v_total_advance bigint := 0;
  v_net bigint;
  v_preview_items jsonb := '[]'::jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, true);

  if p_cutoff_date is null
     or pg_catalog.date_part('year', p_cutoff_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception 'VENDOR_FINANCE_OPENING_BATCH_INVALID'
      using errcode = '22023';
  end if;

  v_len := pg_catalog.jsonb_array_length(p_items);
  if v_len < 1 or v_len > 200 then
    raise exception 'VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID'
      using errcode = '22023';
  end if;

  for v_idx in 0..(v_len - 1) loop
    v_item := p_items->v_idx;
    if v_item is null or pg_catalog.jsonb_typeof(v_item) <> 'object' then
      raise exception 'VENDOR_FINANCE_OPENING_BATCH_INVALID'
        using errcode = '22023';
    end if;

    v_vendor_id := v_item->>'vendor_id';
    v_entry_type := v_item->>'entry_type';

    if v_vendor_id is null
       or v_vendor_id = '__system_vendor__'
       or v_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
      raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
        using errcode = '22023';
    end if;

    if v_vendor_id = any(v_seen) then
      raise exception 'VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR'
        using errcode = '22023';
    end if;
    v_seen := pg_catalog.array_append(v_seen, v_vendor_id);

    if v_entry_type is null or v_entry_type not in ('OPENING_PAYABLE', 'OPENING_ADVANCE') then
      raise exception 'VENDOR_FINANCE_ENTRY_TYPE_INVALID'
        using errcode = '22023';
    end if;

    v_amount := public.vendor_finance__internal_parse_non_negative_minor(v_item->>'amount_minor');

    select v.*
      into v_vendor
      from public.vendors v
     where v.vendor_id = v_vendor_id
       and v.vendor_id <> '__system_vendor__';

    if not found then
      raise exception 'VENDOR_FINANCE_VENDOR_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    if v_amount = 0 then
      v_skipped_zero := v_skipped_zero + 1;
      continue;
    end if;

    select exists (
             select 1
               from public.vendor_finance_entries e
              where e.vendor_id = v_vendor.vendor_id
           )
      into v_has_entries;

    if v_has_entries then
      raise exception 'VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED'
        using errcode = '23505';
    end if;

    v_vendor_count := v_vendor_count + 1;
    if v_entry_type = 'OPENING_PAYABLE' then
      v_total_payable := public.vendor_finance__internal_checked_add_minor(v_total_payable, v_amount);
    else
      v_total_advance := public.vendor_finance__internal_checked_add_minor(v_total_advance, v_amount);
    end if;

    v_preview_items := v_preview_items || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'vendor_id', v_vendor.vendor_id,
        'display_name', v_vendor.display_name,
        'active', v_vendor.active,
        'entry_type', v_entry_type,
        'amount_minor', v_amount::text,
        'balance_delta_minor', (case when v_entry_type = 'OPENING_PAYABLE' then v_amount else -v_amount end)::text
      )
    );
  end loop;

  if v_vendor_count = 0 then
    raise exception 'VENDOR_FINANCE_OPENING_BATCH_EMPTY'
      using errcode = '22023';
  end if;

  v_net := public.vendor_finance__internal_checked_sub_minor(v_total_payable, v_total_advance);

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'cutoff_date', p_cutoff_date::text,
    'vendor_count', v_vendor_count,
    'skipped_zero_count', v_skipped_zero,
    'total_payable_minor', v_total_payable::text,
    'total_advance_minor', v_total_advance::text,
    'net_balance_minor', v_net::text,
    'items', v_preview_items
  );
end;
$function$;

-- 4.10 Apply opening balance batch atomically in a single transaction.
create or replace function public.vendor_finance_apply_opening_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_cutoff_date date,
  p_items jsonb,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_reason text;
  v_actor_name text;
  v_len integer;
  v_idx integer;
  v_item jsonb;
  v_vendor_id text;
  v_entry_type text;
  v_amount bigint;
  v_seen text[] := array[]::text[];
  v_all_vendor_ids text[] := array[]::text[];
  v_sorted_vendor_id text;
  v_vendor public.vendors%rowtype;
  v_has_entries boolean;
  v_skipped_zero integer := 0;
  v_vendor_count integer := 0;
  v_total_payable bigint := 0;
  v_total_advance bigint := 0;
  v_net bigint;
  v_batch public.vendor_finance_opening_batches%rowtype;
  v_delta bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_entries%rowtype;
  v_entries_json jsonb := '[]'::jsonb;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, true);
  v_authority_source := v_auth->>'authority_source';

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'APPLY_OPENING_BATCH'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_cutoff_date is null
     or pg_catalog.date_part('year', p_cutoff_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception 'VENDOR_FINANCE_OPENING_BATCH_INVALID'
      using errcode = '22023';
  end if;

  v_len := pg_catalog.jsonb_array_length(p_items);
  if v_len < 1 or v_len > 200 then
    raise exception 'VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID'
      using errcode = '22023';
  end if;

  -- Pass 1: validate input syntax, uniqueness, and non-zero totals.
  for v_idx in 0..(v_len - 1) loop
    v_item := p_items->v_idx;
    if v_item is null or pg_catalog.jsonb_typeof(v_item) <> 'object' then
      raise exception 'VENDOR_FINANCE_OPENING_BATCH_INVALID'
        using errcode = '22023';
    end if;

    v_vendor_id := v_item->>'vendor_id';
    v_entry_type := v_item->>'entry_type';

    if v_vendor_id is null
       or v_vendor_id = '__system_vendor__'
       or v_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
      raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
        using errcode = '22023';
    end if;

    if v_vendor_id = any(v_seen) then
      raise exception 'VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR'
        using errcode = '22023';
    end if;
    v_seen := pg_catalog.array_append(v_seen, v_vendor_id);

    if v_entry_type is null or v_entry_type not in ('OPENING_PAYABLE', 'OPENING_ADVANCE') then
      raise exception 'VENDOR_FINANCE_ENTRY_TYPE_INVALID'
        using errcode = '22023';
    end if;

    v_amount := public.vendor_finance__internal_parse_non_negative_minor(v_item->>'amount_minor');
    v_all_vendor_ids := pg_catalog.array_append(v_all_vendor_ids, v_vendor_id);

    if v_amount = 0 then
      v_skipped_zero := v_skipped_zero + 1;
    else
      v_vendor_count := v_vendor_count + 1;
      if v_entry_type = 'OPENING_PAYABLE' then
        v_total_payable := public.vendor_finance__internal_checked_add_minor(v_total_payable, v_amount);
      else
        v_total_advance := public.vendor_finance__internal_checked_add_minor(v_total_advance, v_amount);
      end if;
    end if;
  end loop;

  if v_vendor_count = 0 then
    raise exception 'VENDOR_FINANCE_OPENING_BATCH_EMPTY'
      using errcode = '22023';
  end if;

  -- Pass 2: lock ALL referenced canonical vendors in deterministic ascending vendor_id order
  -- BEFORE touching document counters (eliminates multi-vendor deadlock).
  for v_sorted_vendor_id in
    select u.vid
      from pg_catalog.unnest(v_all_vendor_ids) as u(vid)
     order by u.vid asc
  loop
    perform public.vendor_finance__internal_lock_vendor(v_sorted_vendor_id);
  end loop;

  -- Pass 3: verify every non-zero vendor still has zero ledger rows under lock.
  for v_idx in 0..(v_len - 1) loop
    v_item := p_items->v_idx;
    v_amount := public.vendor_finance__internal_parse_non_negative_minor(v_item->>'amount_minor');
    if v_amount = 0 then
      continue;
    end if;
    v_vendor_id := v_item->>'vendor_id';

    select exists (
             select 1
               from public.vendor_finance_entries e
              where e.vendor_id = v_vendor_id
           )
      into v_has_entries;

    if v_has_entries then
      raise exception 'VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED'
        using errcode = '23505';
    end if;
  end loop;

  v_net := public.vendor_finance__internal_checked_sub_minor(v_total_payable, v_total_advance);

  insert into public.vendor_finance_opening_batches (
    cutoff_date,
    vendor_count,
    skipped_zero_count,
    total_payable_minor,
    total_advance_minor,
    net_balance_minor,
    reason,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    p_cutoff_date,
    v_vendor_count,
    v_skipped_zero,
    v_total_payable,
    v_total_advance,
    v_net,
    v_reason,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_batch;

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

  -- Pass 4: insert opening entries for non-zero rows in caller's deterministic item order.
  for v_idx in 0..(v_len - 1) loop
    v_item := p_items->v_idx;
    v_amount := public.vendor_finance__internal_parse_non_negative_minor(v_item->>'amount_minor');
    if v_amount = 0 then
      continue;
    end if;

    v_vendor_id := v_item->>'vendor_id';
    v_entry_type := v_item->>'entry_type';

    select v.* into v_vendor from public.vendors v where v.vendor_id = v_vendor_id;

    v_delta := case when v_entry_type = 'OPENING_PAYABLE' then v_amount else -v_amount end;
    v_doc_no := public.vendor_finance__internal_next_document_no(p_cutoff_date);

    insert into public.vendor_finance_entries (
      vendor_id,
      vendor_sequence,
      entry_type,
      amount_minor,
      balance_delta_minor,
      balance_before_minor,
      balance_after_minor,
      effective_date,
      reason,
      document_no,
      vendor_display_name_snapshot,
      opening_batch_id,
      reverses_entry_id,
      created_by_user_id,
      created_by_display_name_snapshot,
      idempotency_key,
      request_fingerprint
    ) values (
      v_vendor.vendor_id,
      1,
      v_entry_type,
      v_amount,
      v_delta,
      0,
      v_delta,
      p_cutoff_date,
      v_reason,
      v_doc_no,
      v_vendor.display_name,
      v_batch.batch_id,
      null,
      p_app_user_id,
      v_actor_name,
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_inserted;

    v_entries_json := v_entries_json || pg_catalog.jsonb_build_array(
      public.vendor_finance__internal_entry_projection(v_inserted, true)
    );
  end loop;

  insert into public.vendor_finance_audit_events (
    opening_batch_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_batch.batch_id,
    p_app_user_id,
    v_authority_source,
    'OPENING_BATCH_APPLIED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'cutoff_date', v_batch.cutoff_date::text,
      'vendor_count', v_batch.vendor_count,
      'skipped_zero_count', v_batch.skipped_zero_count,
      'total_payable_minor', v_batch.total_payable_minor::text,
      'total_advance_minor', v_batch.total_advance_minor::text,
      'net_balance_minor', v_batch.net_balance_minor::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'batch', pg_catalog.jsonb_build_object(
      'batch_id', v_batch.batch_id,
      'cutoff_date', v_batch.cutoff_date::text,
      'vendor_count', v_batch.vendor_count,
      'skipped_zero_count', v_batch.skipped_zero_count,
      'total_payable_minor', v_batch.total_payable_minor::text,
      'total_advance_minor', v_batch.total_advance_minor::text,
      'net_balance_minor', v_batch.net_balance_minor::text,
      'reason', v_batch.reason,
      'created_by_display_name', v_batch.created_by_display_name_snapshot,
      'created_at', pg_catalog.to_jsonb(v_batch.created_at)
    ),
    'entries', v_entries_json
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'APPLY_OPENING_BATCH',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- 4.11 Create date-anchored reconciliation (never mutates ledger).
create or replace function public.vendor_finance_create_reconciliation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_as_of_date date,
  p_confirmed_balance_minor text,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_vendor public.vendors%rowtype;
  v_confirmed bigint;
  v_reason text;
  v_actor_name text;
  v_system_num numeric;
  v_system bigint;
  v_latest_seq bigint;
  v_diff bigint;
  v_inserted public.vendor_finance_reconciliations%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, true);
  v_authority_source := v_auth->>'authority_source';

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'CREATE_RECONCILIATION'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_as_of_date is null
     or pg_catalog.date_part('year', p_as_of_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_confirmed := public.vendor_finance__internal_parse_signed_minor(p_confirmed_balance_minor);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  select coalesce(sum(e.balance_delta_minor::numeric) filter (where e.effective_date <= p_as_of_date), 0::numeric),
         coalesce(max(e.vendor_sequence), 0)::bigint
    into v_system_num, v_latest_seq
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id;

  if v_system_num < (-9223372036854775808)::numeric
     or v_system_num > 9223372036854775807::numeric then
    raise exception 'VENDOR_FINANCE_AMOUNT_OVERFLOW'
      using errcode = '22003';
  end if;

  v_system := v_system_num::bigint;
  v_diff := public.vendor_finance__internal_checked_sub_minor(v_confirmed, v_system);

  insert into public.vendor_finance_reconciliations (
    vendor_id,
    as_of_date,
    system_balance_minor,
    confirmed_balance_minor,
    difference_minor,
    ledger_sequence_at_reconciliation,
    reason,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    p_as_of_date,
    v_system,
    v_confirmed,
    v_diff,
    v_latest_seq,
    v_reason,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    reconciliation_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_inserted.reconciliation_id,
    p_app_user_id,
    v_authority_source,
    'RECONCILIATION_CREATED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'as_of_date', v_inserted.as_of_date::text,
      'system_balance_minor', v_inserted.system_balance_minor::text,
      'confirmed_balance_minor', v_inserted.confirmed_balance_minor::text,
      'difference_minor', v_inserted.difference_minor::text,
      'ledger_sequence_at_reconciliation', v_inserted.ledger_sequence_at_reconciliation
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'reconciliation', public.vendor_finance__internal_reconciliation_projection(v_inserted, true)
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'CREATE_RECONCILIATION',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- 4.12 Reserve private R2 evidence upload (max 1 READY image per entry or reconciliation).
create or replace function public.vendor_finance_reserve_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_mime_type text,
  p_size_bytes integer,
  p_checksum_sha256 text,
  p_ttl_seconds integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_replayed_ev public.vendor_finance_evidence%rowtype;
  v_entry public.vendor_finance_entries%rowtype;
  v_rec public.vendor_finance_reconciliations%rowtype;
  v_vendor_id text;
  v_entry_id uuid := null;
  v_reconciliation_id uuid := null;
  v_target_segment text;
  v_ready_exists boolean;
  v_superseded_keys text[] := array[]::text[];
  v_evidence_id uuid;
  v_storage_key text;
  v_now timestamptz := now();
  v_expires_at timestamptz;
  v_inserted public.vendor_finance_evidence%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, true);
  v_authority_source := v_auth->>'authority_source';

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'RESERVE_EVIDENCE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;

    select ev.*
      into v_replayed_ev
      from public.vendor_finance_evidence ev
     where ev.evidence_id = (v_existing_idem.result_payload->'reservation'->>'evidence_id')::uuid;

    if not found or v_replayed_ev.status <> 'RESERVED' or v_replayed_ev.expires_at <= v_now then
      if found and v_replayed_ev.status = 'READY' then
        raise exception 'VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED'
          using errcode = '23505';
      end if;
      raise exception 'VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED'
        using errcode = '40900';
    end if;

    return pg_catalog.jsonb_build_object(
      'reservation', v_existing_idem.result_payload->'reservation',
      'superseded_storage_keys', '[]'::jsonb,
      'replayed', true
    );
  end if;

  if p_target_kind is null or p_target_kind not in ('ENTRY', 'RECONCILIATION')
     or p_target_id is null then
    raise exception 'VENDOR_FINANCE_EVIDENCE_TARGET_INVALID'
      using errcode = '22023';
  end if;

  if p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png') then
    raise exception 'VENDOR_FINANCE_EVIDENCE_MIME_INVALID'
      using errcode = '22023';
  end if;

  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 10485760 then
    raise exception 'VENDOR_FINANCE_EVIDENCE_SIZE_INVALID'
      using errcode = '22023';
  end if;

  if p_checksum_sha256 is null or p_checksum_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID'
      using errcode = '22023';
  end if;

  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 900 then
    raise exception 'VENDOR_FINANCE_EVIDENCE_TTL_INVALID'
      using errcode = '22023';
  end if;

  if p_target_kind = 'ENTRY' then
    select e.*
      into v_entry
      from public.vendor_finance_entries e
     where e.entry_id = p_target_id;

    if not found then
      raise exception 'VENDOR_FINANCE_ENTRY_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    v_vendor_id := v_entry.vendor_id;
    v_entry_id := v_entry.entry_id;
    v_target_segment := 'entry';
  else
    select r.*
      into v_rec
      from public.vendor_finance_reconciliations r
     where r.reconciliation_id = p_target_id;

    if not found then
      raise exception 'VENDOR_FINANCE_RECONCILIATION_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    v_vendor_id := v_rec.vendor_id;
    v_reconciliation_id := v_rec.reconciliation_id;
    v_target_segment := 'reconciliation';
  end if;

  perform public.vendor_finance__internal_lock_vendor(v_vendor_id);

  if v_entry_id is not null then
    select exists (
             select 1
               from public.vendor_finance_evidence ev
              where ev.entry_id = v_entry_id
                and ev.status = 'READY'
           )
      into v_ready_exists;
  else
    select exists (
             select 1
               from public.vendor_finance_evidence ev
              where ev.reconciliation_id = v_reconciliation_id
                and ev.status = 'READY'
           )
      into v_ready_exists;
  end if;

  if v_ready_exists then
    raise exception 'VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED'
      using errcode = '23505';
  end if;

  perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);

  -- Supersede any prior RESERVED upload attempt on the same target so retry works cleanly.
  if v_entry_id is not null then
    with superseded as (
      update public.vendor_finance_evidence ev
         set status = 'EXPIRED',
             cleanup_after = v_now,
             failure_code = 'SUPERSEDED_BY_RETRY'
       where ev.entry_id = v_entry_id
         and ev.status = 'RESERVED'
      returning ev.storage_key
    )
    select coalesce(pg_catalog.array_agg(s.storage_key), array[]::text[])
      into v_superseded_keys
      from superseded s;
  else
    with superseded as (
      update public.vendor_finance_evidence ev
         set status = 'EXPIRED',
             cleanup_after = v_now,
             failure_code = 'SUPERSEDED_BY_RETRY'
       where ev.reconciliation_id = v_reconciliation_id
         and ev.status = 'RESERVED'
      returning ev.storage_key
    )
    select coalesce(pg_catalog.array_agg(s.storage_key), array[]::text[])
      into v_superseded_keys
      from superseded s;
  end if;

  v_evidence_id := gen_random_uuid();
  v_storage_key := 'vfin-01/' || v_target_segment || '/' || p_target_id::text || '/' || v_evidence_id::text;
  v_expires_at := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);

  insert into public.vendor_finance_evidence (
    evidence_id,
    entry_id,
    reconciliation_id,
    status,
    storage_key,
    mime_type,
    size_bytes,
    checksum_sha256,
    reserved_by_user_id,
    reserved_at,
    expires_at,
    idempotency_key,
    request_fingerprint
  ) values (
    v_evidence_id,
    v_entry_id,
    v_reconciliation_id,
    'RESERVED',
    v_storage_key,
    p_mime_type,
    p_size_bytes,
    p_checksum_sha256,
    p_app_user_id,
    v_now,
    v_expires_at,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    entry_id,
    reconciliation_id,
    evidence_id,
    actor_user_id,
    authority_source,
    action,
    metadata,
    idempotency_key
  ) values (
    v_vendor_id,
    v_entry_id,
    v_reconciliation_id,
    v_inserted.evidence_id,
    p_app_user_id,
    v_authority_source,
    'EVIDENCE_RESERVED',
    pg_catalog.jsonb_build_object(
      'target_kind', p_target_kind,
      'mime_type', v_inserted.mime_type,
      'size_bytes', v_inserted.size_bytes,
      'checksum_sha256', v_inserted.checksum_sha256
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'reservation', pg_catalog.jsonb_build_object(
      'evidence_id', v_inserted.evidence_id,
      'target_kind', p_target_kind,
      'target_id', p_target_id,
      'status', v_inserted.status,
      'storage_key', v_inserted.storage_key,
      'mime_type', v_inserted.mime_type,
      'size_bytes', v_inserted.size_bytes,
      'checksum_sha256', v_inserted.checksum_sha256,
      'reserved_at', pg_catalog.to_jsonb(v_inserted.reserved_at),
      'expires_at', pg_catalog.to_jsonb(v_inserted.expires_at)
    )
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'RESERVE_EVIDENCE',
    p_request_fingerprint,
    v_base_payload
  );

  return pg_catalog.jsonb_build_object(
    'reservation', v_base_payload->'reservation',
    'superseded_storage_keys', pg_catalog.to_jsonb(v_superseded_keys),
    'replayed', false
  );
end;
$function$;

-- 4.13 Finalize or fail a reserved evidence upload after server-side R2 verification.
create or replace function public.vendor_finance_complete_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_evidence_id uuid,
  p_outcome text,
  p_failure_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_ev public.vendor_finance_evidence%rowtype;
  v_vendor_id text;
  v_now timestamptz := now();
  v_updated public.vendor_finance_evidence%rowtype;
  v_target_kind text;
  v_target_id uuid;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, true);
  v_authority_source := v_auth->>'authority_source';

  if p_evidence_id is null
     or p_outcome is null
     or p_outcome not in ('INFO', 'READY', 'FAILED', 'EXPIRED') then
    raise exception 'VENDOR_FINANCE_EVIDENCE_INVALID'
      using errcode = '22023';
  end if;

  select ev.*
    into v_ev
    from public.vendor_finance_evidence ev
   where ev.evidence_id = p_evidence_id;

  if not found then
    raise exception 'VENDOR_FINANCE_EVIDENCE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_ev.entry_id is not null then
    select e.vendor_id into v_vendor_id
      from public.vendor_finance_entries e
     where e.entry_id = v_ev.entry_id;
    v_target_kind := 'ENTRY';
    v_target_id := v_ev.entry_id;
  else
    select r.vendor_id into v_vendor_id
      from public.vendor_finance_reconciliations r
     where r.reconciliation_id = v_ev.reconciliation_id;
    v_target_kind := 'RECONCILIATION';
    v_target_id := v_ev.reconciliation_id;
  end if;

  perform public.vendor_finance__internal_lock_vendor(v_vendor_id);

  -- Reload under vendor lock.
  select ev.* into v_ev
    from public.vendor_finance_evidence ev
   where ev.evidence_id = p_evidence_id;

  if p_outcome = 'INFO' then
    if v_ev.status = 'RESERVED' and v_ev.expires_at <= v_now then
      perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);

      update public.vendor_finance_evidence ev
         set status = 'EXPIRED',
             cleanup_after = v_now,
             failure_code = 'RESERVATION_TTL_EXPIRED'
       where ev.evidence_id = v_ev.evidence_id
      returning * into v_ev;

      insert into public.vendor_finance_audit_events (
        vendor_id,
        entry_id,
        reconciliation_id,
        evidence_id,
        actor_user_id,
        authority_source,
        action,
        metadata
      ) values (
        v_vendor_id,
        v_ev.entry_id,
        v_ev.reconciliation_id,
        v_ev.evidence_id,
        p_app_user_id,
        v_authority_source,
        'EVIDENCE_EXPIRED',
        pg_catalog.jsonb_build_object(
          'failure_code', v_ev.failure_code
        )
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'evidence_id', v_ev.evidence_id,
      'target_kind', v_target_kind,
      'target_id', v_target_id,
      'status', v_ev.status,
      'storage_key', v_ev.storage_key,
      'mime_type', v_ev.mime_type,
      'size_bytes', v_ev.size_bytes,
      'checksum_sha256', v_ev.checksum_sha256,
      'expires_at', pg_catalog.to_jsonb(v_ev.expires_at),
      'finalized_at', pg_catalog.to_jsonb(v_ev.finalized_at),
      'is_expired', (v_ev.status = 'EXPIRED')
    );
  end if;

  if v_ev.status = 'READY' then
    if p_outcome = 'READY' then
      return pg_catalog.jsonb_build_object(
        'evidence', pg_catalog.jsonb_build_object(
          'evidence_id', v_ev.evidence_id,
          'target_kind', v_target_kind,
          'target_id', v_target_id,
          'status', v_ev.status,
          'mime_type', v_ev.mime_type,
          'size_bytes', v_ev.size_bytes,
          'checksum_sha256', v_ev.checksum_sha256,
          'finalized_at', pg_catalog.to_jsonb(v_ev.finalized_at)
        ),
        'replayed', true
      );
    end if;
    raise exception 'VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED'
      using errcode = '23505';
  end if;

  if p_outcome = 'EXPIRED' then
    if v_ev.status in ('EXPIRED', 'FAILED') then
      return pg_catalog.jsonb_build_object(
        'evidence_id', v_ev.evidence_id,
        'status', v_ev.status,
        'failure_code', v_ev.failure_code
      );
    end if;

    perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);

    update public.vendor_finance_evidence ev
       set status = 'EXPIRED',
           cleanup_after = v_now,
           failure_code = coalesce(nullif(pg_catalog.btrim(p_failure_code), ''), 'RESERVATION_TTL_EXPIRED')
     where ev.evidence_id = v_ev.evidence_id
    returning * into v_updated;

    insert into public.vendor_finance_audit_events (
      vendor_id,
      entry_id,
      reconciliation_id,
      evidence_id,
      actor_user_id,
      authority_source,
      action,
      metadata
    ) values (
      v_vendor_id,
      v_ev.entry_id,
      v_ev.reconciliation_id,
      v_updated.evidence_id,
      p_app_user_id,
      v_authority_source,
      'EVIDENCE_EXPIRED',
      pg_catalog.jsonb_build_object(
        'failure_code', v_updated.failure_code
      )
    );

    return pg_catalog.jsonb_build_object(
      'evidence_id', v_updated.evidence_id,
      'status', v_updated.status,
      'failure_code', v_updated.failure_code
    );
  end if;

  if v_ev.status <> 'RESERVED' then
    raise exception 'VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED'
      using errcode = '40900';
  end if;

  perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);

  if p_outcome = 'FAILED' then
    update public.vendor_finance_evidence ev
       set status = 'FAILED',
           cleanup_after = v_now,
           failure_code = coalesce(nullif(pg_catalog.btrim(p_failure_code), ''), 'VERIFICATION_FAILED')
     where ev.evidence_id = v_ev.evidence_id
    returning * into v_updated;

    insert into public.vendor_finance_audit_events (
      vendor_id,
      entry_id,
      reconciliation_id,
      evidence_id,
      actor_user_id,
      authority_source,
      action,
      metadata
    ) values (
      v_vendor_id,
      v_ev.entry_id,
      v_ev.reconciliation_id,
      v_updated.evidence_id,
      p_app_user_id,
      v_authority_source,
      'EVIDENCE_FAILED',
      pg_catalog.jsonb_build_object(
        'failure_code', v_updated.failure_code
      )
    );

    return pg_catalog.jsonb_build_object(
      'evidence_id', v_updated.evidence_id,
      'status', v_updated.status,
      'failure_code', v_updated.failure_code
    );
  end if;

  if v_ev.expires_at <= v_now then
    update public.vendor_finance_evidence ev
       set status = 'EXPIRED',
           cleanup_after = v_now,
           failure_code = 'RESERVATION_TTL_EXPIRED'
     where ev.evidence_id = v_ev.evidence_id
    returning * into v_updated;

    insert into public.vendor_finance_audit_events (
      vendor_id,
      entry_id,
      reconciliation_id,
      evidence_id,
      actor_user_id,
      authority_source,
      action,
      metadata
    ) values (
      v_vendor_id,
      v_ev.entry_id,
      v_ev.reconciliation_id,
      v_updated.evidence_id,
      p_app_user_id,
      v_authority_source,
      'EVIDENCE_EXPIRED',
      pg_catalog.jsonb_build_object(
        'failure_code', v_updated.failure_code
      )
    );

    -- Return committable EXPIRED outcome (do NOT raise exception, otherwise PostgreSQL
    -- would roll back the RESERVED -> EXPIRED transition above!).
    return pg_catalog.jsonb_build_object(
      'expired', true,
      'evidence_id', v_updated.evidence_id,
      'status', v_updated.status,
      'failure_code', v_updated.failure_code
    );
  end if;

  update public.vendor_finance_evidence ev
     set status = 'READY',
         finalized_at = v_now
   where ev.evidence_id = v_ev.evidence_id
  returning * into v_updated;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    entry_id,
    reconciliation_id,
    evidence_id,
    actor_user_id,
    authority_source,
    action,
    metadata
  ) values (
    v_vendor_id,
    v_ev.entry_id,
    v_ev.reconciliation_id,
    v_updated.evidence_id,
    p_app_user_id,
    v_authority_source,
    'EVIDENCE_FINALIZED',
    pg_catalog.jsonb_build_object(
      'mime_type', v_updated.mime_type,
      'size_bytes', v_updated.size_bytes,
      'checksum_sha256', v_updated.checksum_sha256
    )
  );

  return pg_catalog.jsonb_build_object(
    'evidence', pg_catalog.jsonb_build_object(
      'evidence_id', v_updated.evidence_id,
      'target_kind', v_target_kind,
      'target_id', v_target_id,
      'status', v_updated.status,
      'mime_type', v_updated.mime_type,
      'size_bytes', v_updated.size_bytes,
      'checksum_sha256', v_updated.checksum_sha256,
      'finalized_at', pg_catalog.to_jsonb(v_updated.finalized_at)
    ),
    'replayed', false
  );
end;
$function$;

-- 4.14 Authorized read of READY evidence metadata for short-lived signed download URL.
create or replace function public.vendor_finance_get_evidence_download(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_evidence_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_ev public.vendor_finance_evidence%rowtype;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, false);

  if p_evidence_id is null then
    raise exception 'VENDOR_FINANCE_EVIDENCE_INVALID'
      using errcode = '22023';
  end if;

  select ev.*
    into v_ev
    from public.vendor_finance_evidence ev
   where ev.evidence_id = p_evidence_id
     and ev.status = 'READY';

  if not found then
    raise exception 'VENDOR_FINANCE_EVIDENCE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'evidence_id', v_ev.evidence_id,
    'target_kind', case when v_ev.entry_id is not null then 'ENTRY' else 'RECONCILIATION' end,
    'target_id', coalesce(v_ev.entry_id, v_ev.reconciliation_id),
    'storage_key', v_ev.storage_key,
    'mime_type', v_ev.mime_type,
    'size_bytes', v_ev.size_bytes,
    'checksum_sha256', v_ev.checksum_sha256,
    'finalized_at', pg_catalog.to_jsonb(v_ev.finalized_at)
  );
end;
$function$;

-- 4.15 Mark FAILED/EXPIRED staged evidence cleaned up after R2 staging deletion.
create or replace function public.vendor_finance_mark_evidence_cleaned(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_evidence_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_ev public.vendor_finance_evidence%rowtype;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, true);

  if p_evidence_id is null then
    raise exception 'VENDOR_FINANCE_EVIDENCE_INVALID'
      using errcode = '22023';
  end if;

  select ev.*
    into v_ev
    from public.vendor_finance_evidence ev
   where ev.evidence_id = p_evidence_id;

  if not found then
    raise exception 'VENDOR_FINANCE_EVIDENCE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_ev.status not in ('FAILED', 'EXPIRED') then
    raise exception 'VENDOR_FINANCE_EVIDENCE_CLEANUP_INVALID'
      using errcode = '22023';
  end if;

  if v_ev.cleaned_up_at is null then
    perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);
    update public.vendor_finance_evidence ev
       set cleaned_up_at = now()
     where ev.evidence_id = v_ev.evidence_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'evidence_id', v_ev.evidence_id,
    'cleaned', true
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Owner alignment & helper EXECUTE privileges (`s0_t1c_runner` & `postgres` safe).
-- -----------------------------------------------------------------------------
do $align_vfin_01_owners$
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
    'public.vendor_finance_document_counters',
    'public.vendor_finance_opening_batches',
    'public.vendor_finance_entries',
    'public.vendor_finance_reconciliations',
    'public.vendor_finance_evidence',
    'public.vendor_finance_idempotency',
    'public.vendor_finance_audit_events'
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
    'public.vendor_finance__internal_immutable_guard()',
    'public.vendor_finance__internal_entry_integrity_guard()',
    'public.vendor_finance__internal_evidence_lifecycle_guard()',
    'public.vendor_finance__internal_parse_positive_minor(text)',
    'public.vendor_finance__internal_parse_non_negative_minor(text)',
    'public.vendor_finance__internal_parse_signed_minor(text)',
    'public.vendor_finance__internal_checked_add_minor(bigint, bigint)',
    'public.vendor_finance__internal_checked_sub_minor(bigint, bigint)',
    'public.vendor_finance__internal_validate_reason(text)',
    'public.vendor_finance__internal_actor_display_name(uuid)',
    'public.vendor_finance__internal_next_document_no(date)',
    'public.vendor_finance__internal_document_kind(text)',
    'public.vendor_finance__internal_document_title_vi(text)',
    'public.vendor_finance__internal_disclaimer_vi()',
    'public.vendor_finance__internal_resolve_authority(uuid, uuid)',
    'public.vendor_finance__internal_assert_authority(uuid, uuid, boolean)',
    'public.vendor_finance__internal_evidence_projection(uuid, uuid)',
    'public.vendor_finance__internal_entry_projection(public.vendor_finance_entries, boolean)',
    'public.vendor_finance__internal_reconciliation_projection(public.vendor_finance_reconciliations, boolean)',
    'public.vendor_finance__internal_lock_vendor(text)',
    'public.vendor_finance_get_actor_access(uuid, uuid)',
    'public.vendor_finance_list_vendors(uuid, uuid, text, text, text, integer, integer)',
    'public.vendor_finance_get_vendor(uuid, uuid, text)',
    'public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer)',
    'public.vendor_finance_get_entry(uuid, uuid, uuid)',
    'public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer)',
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)',
    'public.vendor_finance_preview_opening_batch(uuid, uuid, date, jsonb)',
    'public.vendor_finance_apply_opening_batch(uuid, uuid, date, jsonb, text, uuid, text)',
    'public.vendor_finance_create_reconciliation(uuid, uuid, text, date, text, text, uuid, text)',
    'public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)',
    'public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)',
    'public.vendor_finance_get_evidence_download(uuid, uuid, uuid)',
    'public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)'
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
       and p.proname like 'vendor_finance_%'
  loop
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
    execute pg_catalog.format(
      'grant execute on function public.org_department__internal_has_active_membership(uuid, text, date) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.org_department__internal_resolve_vfin_default_authority(uuid, uuid, date) to %I',
      v_owner
    );
  end loop;
end;
$align_vfin_01_owners$;

-- -----------------------------------------------------------------------------
-- 6. Strict table & function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on table public.vendor_finance_document_counters
  from public, anon, authenticated, service_role;

revoke all on table public.vendor_finance_opening_batches
  from public, anon, authenticated, service_role;

revoke all on table public.vendor_finance_entries
  from public, anon, authenticated, service_role;

revoke all on table public.vendor_finance_reconciliations
  from public, anon, authenticated, service_role;

revoke all on table public.vendor_finance_evidence
  from public, anon, authenticated, service_role;

revoke all on table public.vendor_finance_idempotency
  from public, anon, authenticated, service_role;

revoke all on table public.vendor_finance_audit_events
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_immutable_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_entry_integrity_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_evidence_lifecycle_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_parse_positive_minor(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_parse_non_negative_minor(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_parse_signed_minor(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_checked_add_minor(bigint, bigint)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_checked_sub_minor(bigint, bigint)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_validate_reason(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_actor_display_name(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_next_document_no(date)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_document_kind(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_document_title_vi(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_disclaimer_vi()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_resolve_authority(uuid, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_assert_authority(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_evidence_projection(uuid, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_entry_projection(public.vendor_finance_entries, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_reconciliation_projection(public.vendor_finance_reconciliations, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_lock_vendor(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance_get_actor_access(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_actor_access(uuid, uuid)
  to service_role;

revoke all on function public.vendor_finance_list_vendors(uuid, uuid, text, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_vendors(uuid, uuid, text, text, text, integer, integer)
  to service_role;

revoke all on function public.vendor_finance_get_vendor(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_vendor(uuid, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer)
  to service_role;

revoke all on function public.vendor_finance_get_entry(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_entry(uuid, uuid, uuid)
  to service_role;

revoke all on function public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer)
  to service_role;

revoke all on function public.vendor_finance_record_entry(uuid, uuid, text, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_record_entry(uuid, uuid, text, text, text, date, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_preview_opening_batch(uuid, uuid, date, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_preview_opening_batch(uuid, uuid, date, jsonb)
  to service_role;

revoke all on function public.vendor_finance_apply_opening_batch(uuid, uuid, date, jsonb, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_apply_opening_batch(uuid, uuid, date, jsonb, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_create_reconciliation(uuid, uuid, text, date, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_create_reconciliation(uuid, uuid, text, date, text, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)
  to service_role;

revoke all on function public.vendor_finance_get_evidence_download(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_evidence_download(uuid, uuid, uuid)
  to service_role;

revoke all on function public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 7. Data-free install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $check_vfin_01$
declare
  v_cap_count integer;
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
    into v_cap_count
    from pg_catalog.regexp_matches(
           (
             select pg_catalog.pg_get_constraintdef(c.oid)
               from pg_catalog.pg_constraint c
               join pg_catalog.pg_class t on t.oid = c.conrelid
               join pg_catalog.pg_namespace n on n.oid = t.relnamespace
              where n.nspname = 'public'
                and t.relname = 'direct_entry_capability_grants'
                and c.conname = 'direct_entry_capability_grants_capability_check'
           ),
           '''([^'']+)''',
           'g'
         ) m;

  if coalesce(v_cap_count, 0) <> 31 then
    raise exception 'VFIN-01 capability check constraint count drift (expected 31, got %)', v_cap_count
      using errcode = '55000';
  end if;

  foreach v_tbl in array array[
    'public.vendor_finance_document_counters'::pg_catalog.regclass,
    'public.vendor_finance_opening_batches'::pg_catalog.regclass,
    'public.vendor_finance_entries'::pg_catalog.regclass,
    'public.vendor_finance_reconciliations'::pg_catalog.regclass,
    'public.vendor_finance_evidence'::pg_catalog.regclass,
    'public.vendor_finance_idempotency'::pg_catalog.regclass,
    'public.vendor_finance_audit_events'::pg_catalog.regclass
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
      raise exception 'VFIN-01 table RLS/ACL boundary drift on %', v_tbl
        using errcode = '55000';
    end if;
  end loop;

  foreach v_internal_fn in array array[
    'public.vendor_finance__internal_immutable_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_entry_integrity_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_evidence_lifecycle_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_parse_positive_minor(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_parse_non_negative_minor(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_parse_signed_minor(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_checked_add_minor(bigint, bigint)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_checked_sub_minor(bigint, bigint)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_validate_reason(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_actor_display_name(uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_next_document_no(date)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_document_kind(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_document_title_vi(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_disclaimer_vi()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_resolve_authority(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_assert_authority(uuid, uuid, boolean)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_evidence_projection(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_entry_projection(public.vendor_finance_entries, boolean)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_reconciliation_projection(public.vendor_finance_reconciliations, boolean)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_lock_vendor(text)'::pg_catalog.regprocedure
  ]
  loop
    select p.prosecdef,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           (r.rolsuper or r.rolbypassrls)
      into v_secdef, v_config, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_internal_fn;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or not coalesce(v_owner_bypasses_rls, false) then
      raise exception 'VFIN-01 internal routine security definer/owner/search_path drift on %', v_internal_fn
        using errcode = '55000';
    end if;

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
      raise exception 'VFIN-01 internal routine must stay revoked from all runtime roles: %', v_internal_fn
        using errcode = '55000';
    end if;
  end loop;

  foreach v_rpc_fn in array array[
    'public.vendor_finance_get_actor_access(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_vendors(uuid, uuid, text, text, text, integer, integer)'::pg_catalog.regprocedure,
    'public.vendor_finance_get_vendor(uuid, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer)'::pg_catalog.regprocedure,
    'public.vendor_finance_get_entry(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer)'::pg_catalog.regprocedure,
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_preview_opening_batch(uuid, uuid, date, jsonb)'::pg_catalog.regprocedure,
    'public.vendor_finance_apply_opening_batch(uuid, uuid, date, jsonb, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_create_reconciliation(uuid, uuid, text, date, text, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_get_evidence_download(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)'::pg_catalog.regprocedure
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
      raise exception 'VFIN-01 RPC security definer owner/RLS/search_path drift on %', v_rpc_fn
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
      raise exception 'VFIN-01 RPC EXECUTE ACL drift on %', v_rpc_fn
        using errcode = '55000';
    end if;
  end loop;
end;
$check_vfin_01$;

commit;
