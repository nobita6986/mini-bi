-- =============================================================================
-- VFIN-04 — Shared Vendor Advance Ledger, Advance Offset, Controlled Reset & Export
-- =============================================================================
-- Implements:
--   1. Append-only global per-Vendor Shared Advance movement ledger
--      (`public.vendor_finance_shared_advance_movements`) with movement types
--      `ADVANCE_FUNDED`, `VENDOR_REFUND_RECORDED`, `PROJECT_OFFSET_APPLIED`,
--      and `REVERSAL`.
--   2. Project sub-ledger entry type `ADVANCE_OFFSET_RECORDED` ("Khấu trừ ứng")
--      atomically coupled with `PROJECT_OFFSET_APPLIED` on the Vendor's shared
--      advance ledger under strict lock ordering (`vfin_idem` -> `vfin_project`
--      -> `vfin_vendor` + `vendors FOR UPDATE`).
--   3. Strict authority separation:
--      - Cash-holder roles (`CASH_HOLDER`, `CASH_HOLDER_RECORD_BEHALF`, `full_admin`,
--        `direct_grant_record`) can fund shared vendor advances and record vendor
--        refunds (`can_fund_vendor_advance`, `can_record_vendor_refund`).
--      - Project accountants (`record_scope = 'ASSIGNED_PROJECTS'`) are forbidden
--        at the RPC/DB boundary from creating `ADVANCE_RECORDED` or `OPENING_ADVANCE`
--        (`42501 VENDOR_FINANCE_RECORD_DENIED`), can view global
--        `shared_advance_balance_minor` when actively assigned (`can_view_shared_advance`),
--        and can apply shared advance offsets (`can_apply_vendor_advance`) only to
--        their actively assigned project sub-ledgers (`SEASONAL` / `OFFICIAL`).
--   4. Controlled one-time transactional reset (`vendor_finance__internal_reset_transactional_ledgers`)
--      with fail-closed evidence cleanup verification (`55000 VENDOR_FINANCE_RESET_EVIDENCE_NOT_CLEANED`),
--      preserving all governance tables, `vendor_finance_document_counters`, and
--      governance audit/idempotency records without `TRUNCATE ... CASCADE`.
--   5. Excel export snapshot RPC (`public.vendor_finance_export_vendors`) with
--      identical visibility/filter semantics and a hard 10,000-row cap (`cap + 1`
--      detection raising `P0001 VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED`).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Schema extensions for Shared Vendor Advance & Advance Offset.
-- -----------------------------------------------------------------------------
alter table public.vendor_finance_entries
  drop constraint if exists vendor_finance_entries_entry_type_check;

alter table public.vendor_finance_entries
  add constraint vendor_finance_entries_entry_type_check check (
    entry_type in (
      'OPENING_PAYABLE',
      'OPENING_ADVANCE',
      'DEBT_RECORDED',
      'PAYROLL_RECORDED',
      'PAYMENT_RECORDED',
      'ADVANCE_RECORDED',
      'ADVANCE_OFFSET_RECORDED',
      'ADJUSTMENT_INCREASE',
      'ADJUSTMENT_DECREASE',
      'REVERSAL'
    )
  );

alter table public.vendor_finance_entries
  drop constraint if exists vendor_finance_entries_sign_check;

alter table public.vendor_finance_entries
  add constraint vendor_finance_entries_sign_check check (
    (entry_type in ('OPENING_PAYABLE', 'DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE') and balance_delta_minor = amount_minor)
    or (entry_type in ('OPENING_ADVANCE', 'PAYMENT_RECORDED', 'ADVANCE_RECORDED', 'ADVANCE_OFFSET_RECORDED', 'ADJUSTMENT_DECREASE') and balance_delta_minor = -amount_minor)
    or (entry_type = 'REVERSAL' and pg_catalog.abs(balance_delta_minor) = amount_minor)
  );

create table if not exists public.vendor_finance_shared_advance_movements (
  movement_id uuid primary key default gen_random_uuid(),
  movement_cursor_seq bigint generated always as identity unique,
  vendor_id text not null
    references public.vendors(vendor_id) on delete restrict,
  vendor_display_name_snapshot text not null
    check (pg_catalog.length(pg_catalog.btrim(vendor_display_name_snapshot)) between 1 and 256),
  vendor_advance_sequence bigint not null
    check (vendor_advance_sequence >= 1),
  movement_type text not null
    check (
      movement_type in (
        'ADVANCE_FUNDED',
        'VENDOR_REFUND_RECORDED',
        'PROJECT_OFFSET_APPLIED',
        'REVERSAL'
      )
    ),
  amount_minor bigint not null
    check (amount_minor > 0),
  balance_before_minor bigint not null
    check (balance_before_minor >= 0),
  balance_delta_minor bigint not null,
  balance_after_minor bigint not null
    check (balance_after_minor >= 0),
  effective_date date not null
    check (effective_date >= date '1970-01-01' and effective_date <= date '2999-12-31'),
  reason text not null
    check (
      pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  document_no text not null unique
    check (document_no ~ '^VFIN-[0-9]{4}-[0-9]{6,}$'),
  project_id text null
    references public.direct_entry_projects(project_id) on delete restrict,
  project_display_name_snapshot text null
    check (
      project_display_name_snapshot is null
      or pg_catalog.length(pg_catalog.btrim(project_display_name_snapshot)) between 1 and 256
    ),
  responsible_accountant_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  responsible_accountant_display_name_snapshot text null
    check (
      responsible_accountant_display_name_snapshot is null
      or pg_catalog.length(pg_catalog.btrim(responsible_accountant_display_name_snapshot)) between 1 and 256
    ),
  contract_type text null
    check (contract_type is null or contract_type in ('SEASONAL', 'OFFICIAL')),
  project_entry_id uuid null unique
    references public.vendor_finance_entries(entry_id) on delete restrict,
  reverses_movement_id uuid null unique
    references public.vendor_finance_shared_advance_movements(movement_id) on delete restrict,
  created_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_by_display_name_snapshot text not null
    check (pg_catalog.length(pg_catalog.btrim(created_by_display_name_snapshot)) between 1 and 256),
  created_at timestamptz not null default now(),
  idempotency_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint vendor_finance_shared_advance_movements_vendor_seq_key
    unique (vendor_id, vendor_advance_sequence),
  constraint vendor_finance_shared_advance_movements_sign_check check (
    (movement_type = 'ADVANCE_FUNDED' and balance_delta_minor = amount_minor)
    or (movement_type in ('VENDOR_REFUND_RECORDED', 'PROJECT_OFFSET_APPLIED') and balance_delta_minor = -amount_minor)
    or (movement_type = 'REVERSAL' and pg_catalog.abs(balance_delta_minor) = amount_minor)
  ),
  constraint vendor_finance_shared_advance_movements_balance_math_check check (
    balance_after_minor::numeric = balance_before_minor::numeric + balance_delta_minor::numeric
  ),
  constraint vendor_finance_shared_advance_movements_reversal_check check (
    (movement_type = 'REVERSAL' and reverses_movement_id is not null and reverses_movement_id <> movement_id)
    or (movement_type <> 'REVERSAL' and reverses_movement_id is null)
  ),
  constraint vendor_finance_shared_advance_movements_project_link_check check (
    (
      movement_type in ('ADVANCE_FUNDED', 'VENDOR_REFUND_RECORDED')
      and project_id is null
      and project_display_name_snapshot is null
      and responsible_accountant_user_id is null
      and responsible_accountant_display_name_snapshot is null
      and contract_type is null
      and project_entry_id is null
    )
    or (
      movement_type = 'PROJECT_OFFSET_APPLIED'
      and project_id is not null
      and project_display_name_snapshot is not null
      and responsible_accountant_user_id is not null
      and responsible_accountant_display_name_snapshot is not null
      and contract_type in ('SEASONAL', 'OFFICIAL')
      and project_entry_id is not null
    )
    or (
      movement_type = 'REVERSAL'
      and (
        (
          project_id is null
          and project_display_name_snapshot is null
          and responsible_accountant_user_id is null
          and responsible_accountant_display_name_snapshot is null
          and contract_type is null
          and project_entry_id is null
        )
        or (
          project_id is not null
          and project_display_name_snapshot is not null
          and responsible_accountant_user_id is not null
          and responsible_accountant_display_name_snapshot is not null
          and contract_type in ('SEASONAL', 'OFFICIAL')
          and project_entry_id is not null
        )
      )
    )
  )
);

create index if not exists vendor_finance_shared_advance_movements_vendor_seq_desc_idx
  on public.vendor_finance_shared_advance_movements (vendor_id, vendor_advance_sequence desc);

create index if not exists vendor_finance_shared_advance_movements_vendor_cursor_desc_idx
  on public.vendor_finance_shared_advance_movements (vendor_id, movement_cursor_seq desc);

alter table public.vendor_finance_shared_advance_movements enable row level security;
alter table public.vendor_finance_shared_advance_movements force row level security;

-- Allow controlled reset cleanup to stamp `cleaned_up_at` on any evidence row after R2 object deletion.
alter table public.vendor_finance_evidence
  drop constraint if exists vendor_finance_evidence_status_timestamps_check;

alter table public.vendor_finance_evidence
  add constraint vendor_finance_evidence_status_timestamps_check check (
    expires_at > reserved_at
    and (
      (status = 'RESERVED' and finalized_at is null and failure_code is null)
      or (status = 'READY' and finalized_at is not null and cleanup_after is null and failure_code is null)
      or (status in ('FAILED', 'EXPIRED') and finalized_at is null and cleanup_after is not null)
    )
  );

alter table public.vendor_finance_idempotency
  drop constraint if exists vendor_finance_idempotency_action_check;

alter table public.vendor_finance_idempotency
  add constraint vendor_finance_idempotency_action_check check (
    action in (
      'APPLY_OPENING_BATCH',
      'RECORD_ENTRY',
      'REVERSE_ENTRY',
      'CREATE_RECONCILIATION',
      'RESERVE_EVIDENCE',
      'ASSIGN_PROJECT_ACCOUNTANT',
      'END_PROJECT_ACCOUNTANT',
      'SET_PROJECT_VENDOR_LINK',
      'ASSIGN_GLOBAL_ROLE',
      'END_GLOBAL_ROLE',
      'CLASSIFY_SUBLEDGER_CONTRACT_TYPE',
      'FUND_SHARED_ADVANCE',
      'RECORD_VENDOR_REFUND',
      'APPLY_SHARED_ADVANCE_OFFSET',
      'REVERSE_SHARED_ADVANCE_MOVEMENT'
    )
  );

alter table public.vendor_finance_audit_events
  add column if not exists shared_advance_movement_id uuid null
    references public.vendor_finance_shared_advance_movements(movement_id) on delete restrict;

alter table public.vendor_finance_audit_events
  drop constraint if exists vendor_finance_audit_events_action_check;

alter table public.vendor_finance_audit_events
  add constraint vendor_finance_audit_events_action_check check (
    action in (
      'OPENING_BATCH_APPLIED',
      'ENTRY_RECORDED',
      'ENTRY_REVERSED',
      'RECONCILIATION_CREATED',
      'EVIDENCE_RESERVED',
      'EVIDENCE_FINALIZED',
      'EVIDENCE_READY',
      'EVIDENCE_FAILED',
      'EVIDENCE_EXPIRED',
      'EVIDENCE_CLEANED',
      'PROJECT_ACCOUNTANT_ASSIGNED',
      'PROJECT_ACCOUNTANT_ENDED',
      'PROJECT_VENDOR_LINK_UPDATED',
      'GLOBAL_ROLE_ASSIGNED',
      'GLOBAL_ROLE_ENDED',
      'SUBLEDGER_CONTRACT_TYPE_CLASSIFIED',
      'SHARED_ADVANCE_FUNDED',
      'VENDOR_REFUND_RECORDED',
      'SHARED_ADVANCE_OFFSET_APPLIED',
      'SHARED_ADVANCE_MOVEMENT_REVERSED'
    )
  );

-- -----------------------------------------------------------------------------
-- 2. Guards, Document Metadata & Shared Advance Projection Helpers.
-- -----------------------------------------------------------------------------
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

  if tg_op = 'INSERT' then
    if new.cleaned_up_at is not null then
      raise exception 'VENDOR_FINANCE_EVIDENCE_TRANSITION_INVALID'
        using errcode = '55000';
    end if;
    return new;
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

    if coalesce(pg_catalog.current_setting('vendor_finance.evidence_reset_cleanup', true), '') = 'on' then
      if old.status is distinct from new.status
         or old.finalized_at is distinct from new.finalized_at
         or old.cleanup_after is distinct from new.cleanup_after
         or old.failure_code is distinct from new.failure_code
         or new.cleaned_up_at is null then
        raise exception 'VENDOR_FINANCE_EVIDENCE_TRANSITION_INVALID'
          using errcode = '55000';
      end if;
      return new;
    end if;

    if old.status = 'READY' then
      raise exception 'VENDOR_FINANCE_EVIDENCE_ALREADY_READY'
        using errcode = '55000';
    end if;

    if old.status = 'RESERVED' and new.status not in ('READY', 'FAILED', 'EXPIRED') then
      raise exception 'VENDOR_FINANCE_EVIDENCE_TRANSITION_INVALID'
        using errcode = '55000';
    end if;

    if new.status = 'READY' and new.cleaned_up_at is not null then
      raise exception 'VENDOR_FINANCE_EVIDENCE_TRANSITION_INVALID'
        using errcode = '55000';
    end if;

    if old.status in ('FAILED', 'EXPIRED') then
      if new.status <> old.status
         or old.finalized_at is distinct from new.finalized_at
         or old.cleanup_after is distinct from new.cleanup_after
         or old.failure_code is distinct from new.failure_code
         or (old.cleaned_up_at is not null and old.cleaned_up_at is distinct from new.cleaned_up_at) then
        raise exception 'VENDOR_FINANCE_EVIDENCE_TRANSITION_INVALID'
          using errcode = '55000';
      end if;
    end if;
  end if;

  return new;
end;
$function$;

create or replace function public.vendor_finance__internal_shared_advance_integrity_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_prev_after bigint;
  v_existing_count bigint;
  v_orig public.vendor_finance_shared_advance_movements%rowtype;
begin
  if coalesce(pg_catalog.current_setting('vendor_finance.shared_advance_write_marker', true), '') <> 'on' then
    raise exception 'VENDOR_FINANCE_DIRECT_WRITE_FORBIDDEN'
      using errcode = '42501';
  end if;

  if new.vendor_advance_sequence = 1 then
    if new.balance_before_minor <> 0 then
      raise exception 'VENDOR_FINANCE_LEDGER_INVARIANT_VIOLATION: shared advance sequence 1 must start at balance 0'
        using errcode = '23514';
    end if;

    select count(*)::bigint
      into v_existing_count
      from public.vendor_finance_shared_advance_movements m
     where m.vendor_id = new.vendor_id;

    if coalesce(v_existing_count, 0) <> 0 then
      raise exception 'VENDOR_FINANCE_LEDGER_INVARIANT_VIOLATION: vendor already has shared advance movements'
        using errcode = '23505';
    end if;
  else
    select m.balance_after_minor
      into v_prev_after
      from public.vendor_finance_shared_advance_movements m
     where m.vendor_id = new.vendor_id
       and m.vendor_advance_sequence = new.vendor_advance_sequence - 1;

    if not found or v_prev_after is distinct from new.balance_before_minor then
      raise exception 'VENDOR_FINANCE_LEDGER_INVARIANT_VIOLATION: broken shared advance balance chain on vendor %',
        new.vendor_id
        using errcode = '23514';
    end if;
  end if;

  if new.movement_type = 'REVERSAL' then
    select m.*
      into v_orig
      from public.vendor_finance_shared_advance_movements m
     where m.movement_id = new.reverses_movement_id;

    if not found then
      raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    if v_orig.vendor_id <> new.vendor_id then
      raise exception 'VENDOR_FINANCE_REVERSAL_VENDOR_MISMATCH'
        using errcode = '23514';
    end if;

    if v_orig.movement_type = 'REVERSAL' then
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

create or replace function public.vendor_finance__internal_immutable_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_old_json jsonb;
  v_new_json jsonb;
begin
  if tg_op = 'UPDATE'
     and coalesce(pg_catalog.current_setting('vendor_finance.classify_write_marker', true), '') = 'on'
     and tg_table_name in (
       'vendor_finance_entries',
       'vendor_finance_reconciliations',
       'vendor_finance_opening_batches'
     ) then
    v_old_json := pg_catalog.to_jsonb(old);
    v_new_json := pg_catalog.to_jsonb(new);
    if v_old_json->>'ledger_scope' = 'PROJECT_ACCOUNTANT'
       and v_old_json->>'contract_type' = 'UNCLASSIFIED'
       and (v_new_json->>'contract_type') in ('SEASONAL', 'OFFICIAL')
       and (v_new_json - 'contract_type') = (v_old_json - 'contract_type') then
      return new;
    end if;
  end if;

  raise exception 'VENDOR_FINANCE_IMMUTABLE_RECORD: % is append-only', tg_table_name
    using errcode = '55000';
end;
$function$;

drop trigger if exists vendor_finance_shared_advance_movements_immutable
  on public.vendor_finance_shared_advance_movements;
create trigger vendor_finance_shared_advance_movements_immutable
  before update or delete on public.vendor_finance_shared_advance_movements
  for each row execute function public.vendor_finance__internal_immutable_guard();

drop trigger if exists vendor_finance_shared_advance_movements_integrity_before_insert
  on public.vendor_finance_shared_advance_movements;
create trigger vendor_finance_shared_advance_movements_integrity_before_insert
  before insert on public.vendor_finance_shared_advance_movements
  for each row execute function public.vendor_finance__internal_shared_advance_integrity_guard();

create or replace function public.vendor_finance__internal_document_kind(p_entry_type text)
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
    when 'ADVANCE_OFFSET_RECORDED' then 'ADVANCE_OFFSET_VOUCHER'
    when 'OPENING_PAYABLE' then 'OPENING_BALANCE_VOUCHER'
    when 'OPENING_ADVANCE' then 'OPENING_BALANCE_VOUCHER'
    else 'DEBT_ADJUSTMENT_VOUCHER'
  end;
$function$;

create or replace function public.vendor_finance__internal_document_title_vi(p_entry_type text)
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
    when 'ADVANCE_OFFSET_RECORDED' then 'Phiếu khấu trừ số dư ứng Vendor'
    when 'OPENING_PAYABLE' then 'Phiếu ghi nhận số dư đầu kỳ'
    when 'OPENING_ADVANCE' then 'Phiếu ghi nhận số dư đầu kỳ'
    else 'Phiếu ghi nhận phát sinh/điều chỉnh công nợ'
  end;
$function$;

create or replace function public.vendor_finance__internal_shared_advance_document_kind(p_movement_type text)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select case p_movement_type
    when 'ADVANCE_FUNDED' then 'ADVANCE_VOUCHER'
    when 'VENDOR_REFUND_RECORDED' then 'VENDOR_REFUND_VOUCHER'
    when 'PROJECT_OFFSET_APPLIED' then 'ADVANCE_OFFSET_VOUCHER'
    else 'DEBT_ADJUSTMENT_VOUCHER'
  end;
$function$;

create or replace function public.vendor_finance__internal_shared_advance_document_title_vi(p_movement_type text)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select case p_movement_type
    when 'ADVANCE_FUNDED' then 'Phiếu ghi nhận ứng tiền dùng chung cho Vendor'
    when 'VENDOR_REFUND_RECORDED' then 'Phiếu ghi nhận Vendor hoàn ứng'
    when 'PROJECT_OFFSET_APPLIED' then 'Biên bản khấu trừ số dư ứng Vendor vào công nợ dự án'
    when 'REVERSAL' then 'Biên bản đảo biến động số dư ứng Vendor'
    else 'Chứng từ số dư ứng nội bộ'
  end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Controlled One-Time Transaction Reset & Evidence Cleanup Helpers.
-- -----------------------------------------------------------------------------
create or replace function public.vendor_finance__internal_mark_evidence_cleaned_for_reset(
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

  if v_ev.cleaned_up_at is null then
    perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);
    perform pg_catalog.set_config('vendor_finance.evidence_reset_cleanup', 'on', true);

    update public.vendor_finance_evidence ev
       set cleaned_up_at = now()
     where ev.evidence_id = v_ev.evidence_id
    returning * into v_ev;

    perform pg_catalog.set_config('vendor_finance.evidence_reset_cleanup', '', true);
  end if;

  return pg_catalog.jsonb_build_object(
    'evidence_id', v_ev.evidence_id,
    'storage_key', v_ev.storage_key,
    'status', v_ev.status,
    'cleaned_up_at', pg_catalog.to_jsonb(v_ev.cleaned_up_at),
    'cleaned', true
  );
end;
$function$;

create or replace function public.vendor_finance__internal_reset_transactional_ledgers(
  p_require_evidence_cleaned boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_uncleaned_evidence_count integer := 0;
  v_pre_pa_count integer := 0;
  v_pre_gr_count integer := 0;
  v_pre_pv_count integer := 0;
  v_pre_dc_count integer := 0;
  v_pre_dc_seq_sum bigint := 0;
  v_pre_vendor_count integer := 0;
  v_pre_project_count integer := 0;
  v_pre_user_count integer := 0;
  v_pre_dept_count integer := 0;
  v_pre_gov_audit_count integer := 0;
  v_pre_gov_idem_count integer := 0;
  v_del_audit_count integer := 0;
  v_del_idem_count integer := 0;
  v_del_evidence_count integer := 0;
  v_del_rec_count integer := 0;
  v_del_class_count integer := 0;
  v_del_shared_adv_count integer := 0;
  v_del_entries_count integer := 0;
  v_del_batches_count integer := 0;
  v_post_tx_rows integer := 0;
  v_post_pa_count integer := 0;
  v_post_gr_count integer := 0;
  v_post_pv_count integer := 0;
  v_post_dc_count integer := 0;
  v_post_dc_seq_sum bigint := 0;
  v_post_vendor_count integer := 0;
  v_post_project_count integer := 0;
  v_post_user_count integer := 0;
  v_post_dept_count integer := 0;
  v_post_gov_audit_count integer := 0;
  v_post_gov_idem_count integer := 0;
  v_disabled_trigger_count integer := 0;
begin
  select count(*)::integer
    into v_uncleaned_evidence_count
    from public.vendor_finance_evidence e
   where e.cleaned_up_at is null;

  if coalesce(p_require_evidence_cleaned, true) and v_uncleaned_evidence_count > 0 then
    raise exception 'VENDOR_FINANCE_RESET_EVIDENCE_NOT_CLEANED: % evidence object(s) must be cleaned from storage before reset',
      v_uncleaned_evidence_count
      using errcode = '55000';
  end if;

  select count(*)::integer into v_pre_pa_count from public.vendor_finance_project_accountants;
  select count(*)::integer into v_pre_gr_count from public.vendor_finance_global_roles;
  select count(*)::integer into v_pre_pv_count from public.vendor_finance_project_vendors;
  select count(*)::integer, coalesce(sum(last_seq), 0)::bigint
    into v_pre_dc_count, v_pre_dc_seq_sum
    from public.vendor_finance_document_counters;
  select count(*)::integer into v_pre_vendor_count from public.vendors;
  select count(*)::integer into v_pre_project_count from public.direct_entry_projects;
  select count(*)::integer into v_pre_user_count from public.direct_entry_app_users;
  select count(*)::integer into v_pre_dept_count from public.organization_department_memberships;

  select count(*)::integer
    into v_pre_gov_audit_count
    from public.vendor_finance_audit_events
   where action in (
     'PROJECT_ACCOUNTANT_ASSIGNED',
     'PROJECT_ACCOUNTANT_ENDED',
     'PROJECT_VENDOR_LINK_UPDATED',
     'GLOBAL_ROLE_ASSIGNED',
     'GLOBAL_ROLE_ENDED'
   );

  select count(*)::integer
    into v_pre_gov_idem_count
    from public.vendor_finance_idempotency
   where action in (
     'ASSIGN_PROJECT_ACCOUNTANT',
     'END_PROJECT_ACCOUNTANT',
     'SET_PROJECT_VENDOR_LINK',
     'ASSIGN_GLOBAL_ROLE',
     'END_GLOBAL_ROLE'
   );

  -- Disable ONLY the exact named immutable triggers on transactional/audit/idempotency tables.
  alter table public.vendor_finance_evidence
    disable trigger vendor_finance_evidence_lifecycle_guard;
  alter table public.vendor_finance_reconciliations
    disable trigger vendor_finance_reconciliations_immutable;
  alter table public.vendor_finance_subledger_classifications
    disable trigger vendor_finance_subledger_classifications_immutable;
  alter table public.vendor_finance_shared_advance_movements
    disable trigger vendor_finance_shared_advance_movements_immutable;
  alter table public.vendor_finance_entries
    disable trigger vendor_finance_entries_immutable;
  alter table public.vendor_finance_opening_batches
    disable trigger vendor_finance_opening_batches_immutable;
  alter table public.vendor_finance_audit_events
    disable trigger vendor_finance_audit_events_immutable;
  alter table public.vendor_finance_idempotency
    disable trigger vendor_finance_idempotency_immutable;

  -- Delete transactional rows in strict child -> parent FK order (never TRUNCATE ... CASCADE).
  delete from public.vendor_finance_audit_events
   where action not in (
     'PROJECT_ACCOUNTANT_ASSIGNED',
     'PROJECT_ACCOUNTANT_ENDED',
     'PROJECT_VENDOR_LINK_UPDATED',
     'GLOBAL_ROLE_ASSIGNED',
     'GLOBAL_ROLE_ENDED'
   );
  get diagnostics v_del_audit_count = row_count;

  delete from public.vendor_finance_idempotency
   where action not in (
     'ASSIGN_PROJECT_ACCOUNTANT',
     'END_PROJECT_ACCOUNTANT',
     'SET_PROJECT_VENDOR_LINK',
     'ASSIGN_GLOBAL_ROLE',
     'END_GLOBAL_ROLE'
   );
  get diagnostics v_del_idem_count = row_count;

  delete from public.vendor_finance_evidence;
  get diagnostics v_del_evidence_count = row_count;

  delete from public.vendor_finance_reconciliations;
  get diagnostics v_del_rec_count = row_count;

  delete from public.vendor_finance_subledger_classifications;
  get diagnostics v_del_class_count = row_count;

  delete from public.vendor_finance_shared_advance_movements;
  get diagnostics v_del_shared_adv_count = row_count;

  delete from public.vendor_finance_entries;
  get diagnostics v_del_entries_count = row_count;

  delete from public.vendor_finance_opening_batches;
  get diagnostics v_del_batches_count = row_count;

  -- Immediately re-enable all 8 immutable triggers before assertions & commit.
  alter table public.vendor_finance_evidence
    enable trigger vendor_finance_evidence_lifecycle_guard;
  alter table public.vendor_finance_reconciliations
    enable trigger vendor_finance_reconciliations_immutable;
  alter table public.vendor_finance_subledger_classifications
    enable trigger vendor_finance_subledger_classifications_immutable;
  alter table public.vendor_finance_shared_advance_movements
    enable trigger vendor_finance_shared_advance_movements_immutable;
  alter table public.vendor_finance_entries
    enable trigger vendor_finance_entries_immutable;
  alter table public.vendor_finance_opening_batches
    enable trigger vendor_finance_opening_batches_immutable;
  alter table public.vendor_finance_audit_events
    enable trigger vendor_finance_audit_events_immutable;
  alter table public.vendor_finance_idempotency
    enable trigger vendor_finance_idempotency_immutable;

  -- Post-reset assertions: transactional tables must be empty.
  select (
    (select count(*) from public.vendor_finance_evidence) +
    (select count(*) from public.vendor_finance_reconciliations) +
    (select count(*) from public.vendor_finance_subledger_classifications) +
    (select count(*) from public.vendor_finance_shared_advance_movements) +
    (select count(*) from public.vendor_finance_entries) +
    (select count(*) from public.vendor_finance_opening_batches) +
    (select count(*) from public.vendor_finance_audit_events
      where action not in (
        'PROJECT_ACCOUNTANT_ASSIGNED',
        'PROJECT_ACCOUNTANT_ENDED',
        'PROJECT_VENDOR_LINK_UPDATED',
        'GLOBAL_ROLE_ASSIGNED',
        'GLOBAL_ROLE_ENDED'
      )) +
    (select count(*) from public.vendor_finance_idempotency
      where action not in (
        'ASSIGN_PROJECT_ACCOUNTANT',
        'END_PROJECT_ACCOUNTANT',
        'SET_PROJECT_VENDOR_LINK',
        'ASSIGN_GLOBAL_ROLE',
        'END_GLOBAL_ROLE'
      ))
  )::integer
    into v_post_tx_rows;

  if coalesce(v_post_tx_rows, -1) <> 0 then
    raise exception 'VENDOR_FINANCE_RESET_INVARIANT_FAILED: residual transactional rows = %',
      v_post_tx_rows
      using errcode = '55000';
  end if;

  -- Post-reset assertions: governance tables, master data, and document counters must be untouched.
  select count(*)::integer into v_post_pa_count from public.vendor_finance_project_accountants;
  select count(*)::integer into v_post_gr_count from public.vendor_finance_global_roles;
  select count(*)::integer into v_post_pv_count from public.vendor_finance_project_vendors;
  select count(*)::integer, coalesce(sum(last_seq), 0)::bigint
    into v_post_dc_count, v_post_dc_seq_sum
    from public.vendor_finance_document_counters;
  select count(*)::integer into v_post_vendor_count from public.vendors;
  select count(*)::integer into v_post_project_count from public.direct_entry_projects;
  select count(*)::integer into v_post_user_count from public.direct_entry_app_users;
  select count(*)::integer into v_post_dept_count from public.organization_department_memberships;
  select count(*)::integer into v_post_gov_audit_count from public.vendor_finance_audit_events;
  select count(*)::integer into v_post_gov_idem_count from public.vendor_finance_idempotency;

  if v_post_pa_count <> v_pre_pa_count
     or v_post_gr_count <> v_pre_gr_count
     or v_post_pv_count <> v_pre_pv_count
     or v_post_dc_count <> v_pre_dc_count
     or v_post_dc_seq_sum <> v_pre_dc_seq_sum
     or v_post_vendor_count <> v_pre_vendor_count
     or v_post_project_count <> v_pre_project_count
     or v_post_user_count <> v_pre_user_count
     or v_post_dept_count <> v_pre_dept_count
     or v_post_gov_audit_count <> v_pre_gov_audit_count
     or v_post_gov_idem_count <> v_pre_gov_idem_count then
    raise exception 'VENDOR_FINANCE_RESET_GOVERNANCE_PRESERVATION_FAILED'
      using errcode = '55000';
  end if;

  -- Post-reset assertion: all immutable & integrity triggers are active (`tgenabled = 'O'`).
  select count(*)::integer
    into v_disabled_trigger_count
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname like 'vendor_finance_%'
     and not t.tgisinternal
     and t.tgenabled <> 'O';

  if coalesce(v_disabled_trigger_count, -1) <> 0 then
    raise exception 'VENDOR_FINANCE_RESET_TRIGGER_REENABLE_FAILED: % trigger(s) not enabled',
      v_disabled_trigger_count
      using errcode = '55000';
  end if;

  return pg_catalog.jsonb_build_object(
    'reset_completed', true,
    'deleted', pg_catalog.jsonb_build_object(
      'entries', v_del_entries_count,
      'opening_batches', v_del_batches_count,
      'reconciliations', v_del_rec_count,
      'subledger_classifications', v_del_class_count,
      'shared_advance_movements', v_del_shared_adv_count,
      'evidence', v_del_evidence_count,
      'transactional_audit_events', v_del_audit_count,
      'transactional_idempotency', v_del_idem_count
    ),
    'preserved', pg_catalog.jsonb_build_object(
      'project_accountants', v_post_pa_count,
      'global_roles', v_post_gr_count,
      'project_vendors', v_post_pv_count,
      'document_counters', v_post_dc_count,
      'document_counter_sequence_sum', v_post_dc_seq_sum,
      'governance_audit_events', v_post_gov_audit_count,
      'governance_idempotency', v_post_gov_idem_count
    )
  );
end;
$function$;

-- Execute the controlled one-time transactional reset during VFIN-04 migration apply.
do $run_vfin_04_controlled_reset$
begin
  perform public.vendor_finance__internal_reset_transactional_ledgers(true);
end;
$run_vfin_04_controlled_reset$;

-- -----------------------------------------------------------------------------
-- 4. Authority Resolution & Shared Advance Projection Helpers.
-- -----------------------------------------------------------------------------
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
  v_full_admin boolean := false;
  v_has_all_scope boolean := false;
  v_direct_record boolean := false;
  v_direct_view boolean := false;
  v_accounting_member boolean := false;
  v_global_role text := null;
  v_visibility_scope text := 'NONE';
  v_record_scope text := 'NONE';
  v_reconcile_scope text := 'NONE';
  v_authority_source text := 'none';
  v_assigned_project_count integer := 0;
  v_can_view_shared_advance boolean := false;
  v_can_fund_vendor_advance boolean := false;
  v_can_record_vendor_refund boolean := false;
  v_can_apply_vendor_advance boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  v_has_all_scope := public.direct_entry_has_scope(p_app_user_id, 'all');
  v_full_admin := v_has_all_scope
    and public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage');

  v_direct_record := v_has_all_scope
    and public.direct_entry_has_capability(p_app_user_id, 'vendor_finance_record');
  v_direct_view := v_has_all_scope
    and public.direct_entry_has_capability(p_app_user_id, 'vendor_finance_view');

  v_accounting_member := public.org_department__internal_has_active_membership(
    p_app_user_id,
    'ACCOUNTING',
    v_today
  );

  select gr.role_code
    into v_global_role
    from public.vendor_finance_global_roles gr
   where gr.app_user_id = p_app_user_id
     and gr.valid_from <= v_today
     and (gr.valid_to is null or gr.valid_to > v_today)
     and (gr.valid_to is null or gr.valid_to > gr.valid_from)
   order by gr.valid_from desc, gr.version desc
   limit 1;

  if v_accounting_member then
    select count(*)::integer
      into v_assigned_project_count
      from public.vendor_finance_project_accountants pa
      join public.direct_entry_projects p
        on p.project_id = pa.project_id
       and p.active = true
     where pa.accountant_user_id = p_app_user_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from);
  end if;

  if v_full_admin or v_direct_record or v_direct_view or v_global_role is not null then
    v_visibility_scope := 'ALL';
  elsif v_accounting_member then
    v_visibility_scope := 'PROJECT_SCOPED';
  else
    v_visibility_scope := 'NONE';
  end if;

  if v_full_admin or v_direct_record or v_global_role = 'CASH_HOLDER_RECORD_BEHALF' then
    v_record_scope := 'ALL';
  elsif v_accounting_member then
    v_record_scope := 'ASSIGNED_PROJECTS';
  else
    v_record_scope := 'NONE';
  end if;

  if v_full_admin
     or v_direct_record
     or v_global_role in ('CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF', 'GLOBAL_RECONCILER') then
    v_reconcile_scope := 'ALL';
  elsif v_accounting_member then
    v_reconcile_scope := 'ASSIGNED_PROJECTS';
  else
    v_reconcile_scope := 'NONE';
  end if;

  if v_full_admin then
    v_authority_source := 'full_admin';
  elsif v_global_role = 'CASH_HOLDER_RECORD_BEHALF' then
    v_authority_source := 'cash_holder_record_behalf';
  elsif v_direct_record then
    v_authority_source := 'direct_grant_record';
  elsif v_global_role = 'CASH_HOLDER' then
    v_authority_source := 'cash_holder';
  elsif v_global_role = 'GLOBAL_RECONCILER' then
    v_authority_source := 'global_reconciler';
  elsif v_global_role = 'GLOBAL_VIEWER' or v_direct_view then
    v_authority_source := 'direct_grant_view';
  elsif v_accounting_member then
    v_authority_source := 'accounting_department';
  else
    v_authority_source := 'none';
  end if;

  -- Global shared advance balance & movement visibility:
  -- All global-visibility actors (`ALL`) and any actively assigned project accountant (`active_assigned_project_count > 0`).
  v_can_view_shared_advance := coalesce(
    v_visibility_scope = 'ALL'
    or (v_visibility_scope = 'PROJECT_SCOPED' and v_assigned_project_count > 0),
    false
  );

  -- Cash-holder shared advance funding & vendor refund authority:
  -- `CASH_HOLDER`, `CASH_HOLDER_RECORD_BEHALF`, `full_admin`, `direct_grant_record`.
  v_can_fund_vendor_advance := coalesce(
    v_full_admin
    or v_direct_record
    or v_global_role in ('CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF'),
    false
  );
  v_can_record_vendor_refund := v_can_fund_vendor_advance;

  -- Applying shared advance offset ("Khấu trừ ứng") against a project sub-ledger:
  -- `record_scope = 'ALL'` or actively assigned project accountant (`record_scope = 'ASSIGNED_PROJECTS'` and `v_assigned_project_count > 0`).
  v_can_apply_vendor_advance := coalesce(
    v_record_scope = 'ALL'
    or (v_record_scope = 'ASSIGNED_PROJECTS' and v_assigned_project_count > 0),
    false
  );

  return pg_catalog.jsonb_build_object(
    'allowed', (v_visibility_scope <> 'NONE'),
    'authority_source', v_authority_source,
    'visibility_scope', v_visibility_scope,
    'record_scope', v_record_scope,
    'reconcile_scope', v_reconcile_scope,
    'global_role_code', v_global_role,
    'can_view', (v_visibility_scope <> 'NONE'),
    'can_record', (v_record_scope <> 'NONE'),
    'can_reconcile', (v_reconcile_scope <> 'NONE'),
    'can_manage_project_assignments', v_full_admin,
    'can_view_shared_advance', v_can_view_shared_advance,
    'can_fund_vendor_advance', v_can_fund_vendor_advance,
    'can_record_vendor_refund', v_can_record_vendor_refund,
    'can_apply_vendor_advance', v_can_apply_vendor_advance,
    'active_assigned_project_count', v_assigned_project_count,
    'authorization_date', v_today::text
  );
end;
$function$;

create or replace function public.vendor_finance__internal_assert_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_mode text default 'view'
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

  if p_mode = 'admin' then
    if not coalesce((v_auth->>'can_manage_project_assignments')::boolean, false) then
      raise exception 'VENDOR_FINANCE_ADMIN_DENIED'
        using errcode = '42501';
    end if;
    return v_auth;
  end if;

  if not coalesce((v_auth->>'can_view')::boolean, false) then
    raise exception 'VENDOR_FINANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_mode = 'shared_advance_view' and not coalesce((v_auth->>'can_view_shared_advance')::boolean, false) then
    raise exception 'VENDOR_FINANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_mode = 'shared_advance_fund' and not coalesce((v_auth->>'can_fund_vendor_advance')::boolean, false) then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  if p_mode = 'shared_advance_refund' and not coalesce((v_auth->>'can_record_vendor_refund')::boolean, false) then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  if p_mode = 'shared_advance_apply' and not coalesce((v_auth->>'can_apply_vendor_advance')::boolean, false) then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  if p_mode = 'record' and not coalesce((v_auth->>'can_record')::boolean, false) then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  if p_mode = 'reconcile' and not coalesce((v_auth->>'can_reconcile')::boolean, false) then
    raise exception 'VENDOR_FINANCE_RECONCILE_DENIED'
      using errcode = '42501';
  end if;

  return v_auth || pg_catalog.jsonb_build_object('actor_app_user_id', p_app_user_id::text);
end;
$function$;

create or replace function public.vendor_finance__internal_shared_advance_movement_projection(
  p_movement public.vendor_finance_shared_advance_movements,
  p_auth jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_reverses_doc_no text := null;
  v_reversed_by_id uuid := null;
  v_reversed_by_doc_no text := null;
  v_vendor_active boolean := false;
  v_vis text := coalesce(p_auth->>'visibility_scope', 'NONE');
  v_actor_id uuid := nullif(p_auth->>'actor_app_user_id', '')::uuid;
  v_can_fund boolean := coalesce((p_auth->>'can_fund_vendor_advance')::boolean, false);
  v_can_write_subledger boolean := false;
  v_can_reverse boolean := false;
  v_can_attach_evidence boolean := false;
  v_can_see_project_details boolean := false;
begin
  if p_movement.reverses_movement_id is not null then
    select m.document_no
      into v_reverses_doc_no
      from public.vendor_finance_shared_advance_movements m
     where m.movement_id = p_movement.reverses_movement_id;
  end if;

  select r.movement_id, r.document_no
    into v_reversed_by_id, v_reversed_by_doc_no
    from public.vendor_finance_shared_advance_movements r
   where r.reverses_movement_id = p_movement.movement_id;

  select v.active
    into v_vendor_active
    from public.vendors v
   where v.vendor_id = p_movement.vendor_id;

  if p_movement.project_id is not null and v_actor_id is not null then
    v_can_write_subledger := public.vendor_finance__internal_can_actor_write_subledger(
      p_auth,
      v_actor_id,
      'record',
      'PROJECT_ACCOUNTANT',
      p_movement.project_id,
      p_movement.responsible_accountant_user_id
    );
  elsif p_movement.project_id is not null and coalesce(p_auth->>'record_scope', 'NONE') = 'ALL' then
    v_can_write_subledger := true;
  end if;

  if p_movement.movement_type in ('ADVANCE_FUNDED', 'VENDOR_REFUND_RECORDED') then
    v_can_reverse := (v_can_fund and v_reversed_by_id is null);
    v_can_attach_evidence := v_can_fund;
  elsif p_movement.movement_type = 'PROJECT_OFFSET_APPLIED' then
    v_can_reverse := (v_can_write_subledger and v_reversed_by_id is null);
    v_can_attach_evidence := v_can_write_subledger;
  else
    v_can_reverse := false;
    v_can_attach_evidence := (v_can_fund or v_can_write_subledger);
  end if;

  v_can_see_project_details := (
    v_vis = 'ALL'
    or (
      p_movement.project_id is not null
      and v_actor_id is not null
      and p_movement.responsible_accountant_user_id is not distinct from v_actor_id
    )
  );

  return pg_catalog.jsonb_build_object(
    'movement_id', p_movement.movement_id,
    'vendor_id', p_movement.vendor_id,
    'vendor_display_name_snapshot', p_movement.vendor_display_name_snapshot,
    'vendor_active', coalesce(v_vendor_active, false),
    'vendor_advance_sequence', p_movement.vendor_advance_sequence,
    'cursor_sequence', p_movement.movement_cursor_seq,
    'document_no', p_movement.document_no,
    'document_kind', public.vendor_finance__internal_shared_advance_document_kind(p_movement.movement_type),
    'document_title_vi', public.vendor_finance__internal_shared_advance_document_title_vi(p_movement.movement_type),
    'movement_type', p_movement.movement_type,
    'amount_minor', p_movement.amount_minor::text,
    'balance_before_minor', p_movement.balance_before_minor::text,
    'balance_delta_minor', p_movement.balance_delta_minor::text,
    'balance_after_minor', p_movement.balance_after_minor::text,
    'effective_date', p_movement.effective_date::text,
    'reason', p_movement.reason,
    'project_entry_id', case when v_can_see_project_details then p_movement.project_entry_id else null end,
    'project_id', case when v_can_see_project_details then p_movement.project_id else null end,
    'project_display_name_snapshot', case when v_can_see_project_details then p_movement.project_display_name_snapshot else null end,
    'accountant_ref', case when v_can_see_project_details then p_movement.responsible_accountant_user_id else null end,
    'responsible_accountant_display_name', case when v_can_see_project_details then p_movement.responsible_accountant_display_name_snapshot else null end,
    'contract_type', case when v_can_see_project_details then p_movement.contract_type else null end,
    'reverses_movement_id', p_movement.reverses_movement_id,
    'reverses_document_no', v_reverses_doc_no,
    'reversed_by_movement_id', v_reversed_by_id,
    'reversed_by_document_no', v_reversed_by_doc_no,
    'can_reverse', v_can_reverse,
    'can_attach_evidence', v_can_attach_evidence,
    'evidence', case
      when v_can_see_project_details and p_movement.project_entry_id is not null
        then public.vendor_finance__internal_evidence_projection(p_movement.project_entry_id, null)
      else null
    end,
    'created_by_display_name', p_movement.created_by_display_name_snapshot,
    'created_at', pg_catalog.to_jsonb(p_movement.created_at),
    'internal_disclaimer', public.vendor_finance__internal_disclaimer_vi()
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Read & Export RPCs with Shared Vendor Advance Projections.
-- -----------------------------------------------------------------------------
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

create or replace function public.vendor_finance_list_actor_context_options(
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
  v_auth jsonb;
  v_today date;
  v_vis text;
  v_projects jsonb;
  v_vendors jsonb;
  v_accountants jsonb;
  v_has_legacy boolean := false;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
  v_today := (v_auth->>'authorization_date')::date;
  v_vis := v_auth->>'visibility_scope';

  if v_vis = 'ALL' then
    select exists (
             select 1
               from public.vendor_finance_entries e
              where e.ledger_scope = 'LEGACY_UNALLOCATED'
             union all
             select 1
               from public.vendor_finance_reconciliations r
              where r.ledger_scope = 'LEGACY_UNALLOCATED'
           )
      into v_has_legacy;
  end if;

  with visible_project_ids as (
    select p.project_id
      from public.direct_entry_projects p
     where v_vis = 'ALL'
    union
    select pa.project_id
      from public.vendor_finance_project_accountants pa
     where v_vis = 'PROJECT_SCOPED'
       and pa.accountant_user_id = p_app_user_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
       and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
    union
    select distinct e.project_id
      from public.vendor_finance_entries e
     where v_vis = 'PROJECT_SCOPED'
       and e.ledger_scope = 'PROJECT_ACCOUNTANT'
       and e.responsible_accountant_user_id = p_app_user_id
       and e.project_id is not null
    union
    select distinct r.project_id
      from public.vendor_finance_reconciliations r
     where v_vis = 'PROJECT_SCOPED'
       and r.ledger_scope = 'PROJECT_ACCOUNTANT'
       and r.responsible_accountant_user_id = p_app_user_id
       and r.project_id is not null
  )
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'project_id', p.project_id,
               'display_name', p.display_name,
               'active', p.active,
               'active_accountant_ref', case
                 when v_vis = 'ALL' or (act_info->>'accountant_user_id')::uuid is not distinct from p_app_user_id
                   then act_info->'accountant_user_id'
                 else 'null'::jsonb
               end,
               'active_accountant_display_name', case
                 when v_vis = 'ALL' or (act_info->>'accountant_user_id')::uuid is not distinct from p_app_user_id
                   then act_info->'accountant_display_name'
                 else 'null'::jsonb
               end,
               'has_active_accountant', (
                 coalesce((act_info->>'has_assignment')::boolean, false)
                 and coalesce((act_info->>'accountant_active')::boolean, false)
               ),
               'can_record_for_project', (
                 coalesce((act_info->>'has_assignment')::boolean, false)
                 and coalesce((act_info->>'accountant_active')::boolean, false)
                 and (
                   (v_auth->>'record_scope') = 'ALL'
                   or (
                     (v_auth->>'record_scope') = 'ASSIGNED_PROJECTS'
                     and (act_info->>'accountant_user_id')::uuid is not distinct from p_app_user_id
                   )
                 )
               ),
               'can_reconcile_for_project', (
                 (v_auth->>'reconcile_scope') = 'ALL'
                 or (
                   (v_auth->>'reconcile_scope') = 'ASSIGNED_PROJECTS'
                   and coalesce((act_info->>'has_assignment')::boolean, false)
                   and coalesce((act_info->>'accountant_active')::boolean, false)
                   and (act_info->>'accountant_user_id')::uuid is not distinct from p_app_user_id
                 )
               )
             )
             order by (not p.active) asc, pg_catalog.lower(p.display_name) asc, p.project_id asc
           ),
           '[]'::jsonb
         )
    into v_projects
    from visible_project_ids vp
    join public.direct_entry_projects p on p.project_id = vp.project_id
    cross join lateral (
      select public.vendor_finance__internal_resolve_active_project_accountant(p.project_id, v_today) as act_info
    ) ai;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'vendor_id', v.vendor_id,
               'display_name', v.display_name,
               'active', v.active
             )
             order by (not v.active) asc, pg_catalog.lower(v.display_name) asc, v.vendor_id asc
           ),
           '[]'::jsonb
         )
    into v_vendors
    from public.vendors v
   where v.vendor_id <> '__system_vendor__'
     and (
       v_vis = 'ALL'
       or (v.active = true and exists (
         select 1 from public.vendor_finance_project_accountants pa
         join public.direct_entry_projects p on p.project_id = pa.project_id and p.active = true
         where pa.accountant_user_id = p_app_user_id
           and pa.valid_from <= v_today
           and (pa.valid_to is null or pa.valid_to > v_today)
           and (pa.valid_to is null or pa.valid_to > pa.valid_from)
           and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
       ))
       or exists (select 1 from public.vendor_finance_entries e where e.vendor_id = v.vendor_id
         and e.ledger_scope = 'PROJECT_ACCOUNTANT' and e.responsible_accountant_user_id = p_app_user_id)
       or exists (select 1 from public.vendor_finance_reconciliations r where r.vendor_id = v.vendor_id
         and r.ledger_scope = 'PROJECT_ACCOUNTANT' and r.responsible_accountant_user_id = p_app_user_id)
     );

  with visible_acct_ids as (
    select p_app_user_id as app_user_id
     where v_vis = 'PROJECT_SCOPED'
    union
    select distinct pa.accountant_user_id as app_user_id
      from public.vendor_finance_project_accountants pa
     where v_vis = 'ALL'
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
    union
    select distinct e.responsible_accountant_user_id as app_user_id
      from public.vendor_finance_entries e
     where v_vis = 'ALL'
       and e.ledger_scope = 'PROJECT_ACCOUNTANT'
       and e.responsible_accountant_user_id is not null
  )
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'accountant_ref', va.app_user_id,
               'display_name', public.vendor_finance__internal_actor_display_name(va.app_user_id)
             )
             order by pg_catalog.lower(public.vendor_finance__internal_actor_display_name(va.app_user_id)), va.app_user_id
           ),
           '[]'::jsonb
         )
    into v_accountants
    from visible_acct_ids va;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'allowed_actions', pg_catalog.jsonb_build_object(
      'visibility_scope', v_vis,
      'record_scope', v_auth->>'record_scope',
      'reconcile_scope', v_auth->>'reconcile_scope',
      'can_view', true,
      'can_record', coalesce((v_auth->>'can_record')::boolean, false),
      'can_reconcile', coalesce((v_auth->>'can_reconcile')::boolean, false),
      'can_manage_project_assignments', coalesce((v_auth->>'can_manage_project_assignments')::boolean, false),
      'can_view_shared_advance', coalesce((v_auth->>'can_view_shared_advance')::boolean, false),
      'can_fund_vendor_advance', coalesce((v_auth->>'can_fund_vendor_advance')::boolean, false),
      'can_record_vendor_refund', coalesce((v_auth->>'can_record_vendor_refund')::boolean, false),
      'can_apply_vendor_advance', coalesce((v_auth->>'can_apply_vendor_advance')::boolean, false)
    ),
    'has_legacy_unallocated', v_has_legacy,
    'projects', v_projects,
    'vendors', v_vendors,
    'accountants', v_accountants
  );
end;
$function$;

create or replace function public.vendor_finance_list_vendors(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_active_filter text default 'all',
  p_balance_filter text default 'all',
  p_project_id text default null,
  p_accountant_user_id uuid default null,
  p_ledger_scope text default 'all',
  p_contract_type text default 'all',
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
  v_today date;
  v_vis text;
  v_can_view_shared boolean := false;
  v_search text := null;
  v_offset integer;
  v_summary jsonb;
  v_total integer;
  v_vendors jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
  v_today := (v_auth->>'authorization_date')::date;
  v_vis := v_auth->>'visibility_scope';
  v_can_view_shared := coalesce((v_auth->>'can_view_shared_advance')::boolean, false);

  if p_active_filter is null or p_active_filter not in ('all', 'active', 'inactive')
     or p_balance_filter is null or p_balance_filter not in ('all', 'payable', 'advance', 'nonzero', 'uninitialized')
     or p_ledger_scope is null or p_ledger_scope not in ('all', 'PROJECT_ACCOUNTANT', 'LEGACY_UNALLOCATED')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_contract_type is null or p_contract_type not in ('all', 'SEASONAL', 'OFFICIAL', 'UNCLASSIFIED') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = '' or pg_catalog.length(v_search) > 120 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'VENDOR_FINANCE_SEARCH_INVALID'
        using errcode = '22023';
    end if;
  end if;

  if v_vis = 'PROJECT_SCOPED' then
    if p_ledger_scope = 'LEGACY_UNALLOCATED'
       or (p_accountant_user_id is not null and p_accountant_user_id <> p_app_user_id) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    if p_project_id is not null and not exists (
      select 1
        from public.vendor_finance_project_accountants pa
       where pa.project_id = p_project_id
         and pa.accountant_user_id = p_app_user_id
         and pa.valid_from <= v_today
         and (pa.valid_to is null or pa.valid_to > v_today)
         and (pa.valid_to is null or pa.valid_to > pa.valid_from)
      union all
      select 1
        from public.vendor_finance_entries e
       where e.ledger_scope = 'PROJECT_ACCOUNTANT'
         and e.project_id = p_project_id
         and e.responsible_accountant_user_id = p_app_user_id
      union all
      select 1
        from public.vendor_finance_reconciliations r
       where r.ledger_scope = 'PROJECT_ACCOUNTANT'
         and r.project_id = p_project_id
         and r.responsible_accountant_user_id = p_app_user_id
    ) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
  end if;

  v_offset := (p_page - 1) * p_page_size;

  with candidate_subledgers as (
    select v.vendor_id,
           'PROJECT_ACCOUNTANT'::text as ledger_scope,
           p.project_id,
           pa.accountant_user_id as accountant_ref,
           ct.contract_type
      from public.vendors v
      join public.direct_entry_projects p on p.active = true
      join public.vendor_finance_project_accountants pa on pa.project_id = p.project_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
       and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
      cross join (values ('SEASONAL'::text), ('OFFICIAL'::text)) as ct(contract_type)
     where v.vendor_id <> '__system_vendor__'
       and v.active = true
       and p_project_id is not null
       and p.project_id = p_project_id
       and (v_vis = 'ALL' or pa.accountant_user_id = p_app_user_id)
    union
    select distinct e.vendor_id,
           e.ledger_scope,
           e.project_id,
           e.responsible_accountant_user_id as accountant_ref,
           e.contract_type
      from public.vendor_finance_entries e
     where (v_vis = 'ALL' or (e.ledger_scope = 'PROJECT_ACCOUNTANT' and e.responsible_accountant_user_id = p_app_user_id))
    union
    select distinct r.vendor_id,
           r.ledger_scope,
           r.project_id,
           r.responsible_accountant_user_id as accountant_ref,
           r.contract_type
      from public.vendor_finance_reconciliations r
     where (v_vis = 'ALL' or (r.ledger_scope = 'PROJECT_ACCOUNTANT' and r.responsible_accountant_user_id = p_app_user_id))
  ),
  filtered_subledgers as (
    select cs.*
      from candidate_subledgers cs
     where (p_ledger_scope = 'all' or cs.ledger_scope = p_ledger_scope)
       and (p_project_id is null or cs.project_id = p_project_id)
       and (p_accountant_user_id is null or cs.accountant_ref = p_accountant_user_id)
       and (p_contract_type = 'all' or cs.contract_type = p_contract_type)
  ),
  subledger_rollups as (
    select fs.vendor_id,
           fs.ledger_scope,
           fs.project_id,
           p.display_name as project_display_name,
           fs.accountant_ref,
           case
             when fs.accountant_ref is null then null
             else public.vendor_finance__internal_actor_display_name(fs.accountant_ref)
           end as accountant_display_name,
           fs.contract_type,
           coalesce(lat.balance_after_minor, 0)::bigint as current_balance_minor,
           coalesce(stats.entry_count, 0)::integer as entry_count,
           coalesce(stats.has_opening_entry, false) as has_opening_entry,
           stats.last_effective_date,
           stats.last_entry_at,
           rec.last_reconciled_as_of_date
      from filtered_subledgers fs
      left join public.direct_entry_projects p on p.project_id = fs.project_id
      left join lateral (
        select e.balance_after_minor
          from public.vendor_finance_entries e
         where e.vendor_id = fs.vendor_id
           and e.ledger_scope = fs.ledger_scope
           and e.project_id is not distinct from fs.project_id
           and e.responsible_accountant_user_id is not distinct from fs.accountant_ref
           and e.contract_type = fs.contract_type
         order by e.vendor_sequence desc
         limit 1
      ) lat on true
      left join lateral (
        select count(*)::integer as entry_count,
               coalesce(bool_or(e.entry_type in ('OPENING_PAYABLE', 'OPENING_ADVANCE')), false) as has_opening_entry,
               max(e.effective_date) as last_effective_date,
               max(e.created_at) as last_entry_at
          from public.vendor_finance_entries e
         where e.vendor_id = fs.vendor_id
           and e.ledger_scope = fs.ledger_scope
           and e.project_id is not distinct from fs.project_id
           and e.responsible_accountant_user_id is not distinct from fs.accountant_ref
           and e.contract_type = fs.contract_type
      ) stats on true
      left join lateral (
        select r.as_of_date as last_reconciled_as_of_date
          from public.vendor_finance_reconciliations r
         where r.vendor_id = fs.vendor_id
           and r.ledger_scope = fs.ledger_scope
           and r.project_id is not distinct from fs.project_id
           and r.responsible_accountant_user_id is not distinct from fs.accountant_ref
           and r.contract_type = fs.contract_type
         order by r.as_of_date desc, r.created_at desc, r.reconciliation_id desc
         limit 1
      ) rec on true
  ),
  visible_vendors as (
    select v.vendor_id,
           v.display_name,
           v.active
      from public.vendors v
     where v.vendor_id <> '__system_vendor__'
       and (
         exists (select 1 from subledger_rollups sr where sr.vendor_id = v.vendor_id)
         or (
           p_project_id is null
           and p_accountant_user_id is null
           and p_ledger_scope = 'all'
           and p_contract_type = 'all'
           and (
             v_vis = 'ALL'
             or (
               v.active = true
               and exists (
                 select 1
                   from public.vendor_finance_project_accountants pa
                   join public.direct_entry_projects p
                     on p.project_id = pa.project_id
                    and p.active = true
                  where pa.accountant_user_id = p_app_user_id
                    and pa.valid_from <= v_today
                    and (pa.valid_to is null or pa.valid_to > v_today)
                    and (pa.valid_to is null or pa.valid_to > pa.valid_from)
                    and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
               )
             )
           )
         )
       )
  ),
  vendor_rollups as (
    select vv.vendor_id,
           vv.display_name,
           vv.active,
           coalesce(agg.sub_ledger_count, 0)::integer as sub_ledger_count,
           coalesce(agg.payable_total_num, 0::numeric) as payable_total_num,
           coalesce(agg.advance_total_num, 0::numeric) as advance_total_num,
           case
             when v_can_view_shared then coalesce(sh.balance_after_minor, 0)::bigint
             else 0::bigint
           end as shared_advance_balance_minor,
           coalesce(agg.single_balance_minor, 0)::bigint as single_balance_minor,
           coalesce(agg.entry_count, 0)::integer as entry_count,
           coalesce(agg.has_opening_entry, false) as has_opening_entry,
           coalesce(agg.eligible_sub_ledger_count, 0)::integer as eligible_sub_ledger_count,
           agg.last_effective_date,
           agg.last_entry_at,
           agg.last_reconciled_as_of_date,
           coalesce(agg.sub_ledgers_json, '[]'::jsonb) as sub_ledgers_json
      from visible_vendors vv
      left join lateral (
        select m.balance_after_minor
          from public.vendor_finance_shared_advance_movements m
         where m.vendor_id = vv.vendor_id
         order by m.vendor_advance_sequence desc
         limit 1
      ) sh on true
      left join lateral (
        select count(*)::integer as sub_ledger_count,
               coalesce(sum(sr.current_balance_minor::numeric) filter (where sr.current_balance_minor > 0), 0::numeric) as payable_total_num,
               coalesce(sum((-sr.current_balance_minor::numeric)) filter (where sr.current_balance_minor < 0), 0::numeric) as advance_total_num,
               case when count(*) = 1 then max(sr.current_balance_minor) else 0::bigint end as single_balance_minor,
               coalesce(sum(sr.entry_count), 0)::integer as entry_count,
               coalesce(bool_or(sr.has_opening_entry), false) as has_opening_entry,
               count(*) filter (
                 where sr.ledger_scope = 'PROJECT_ACCOUNTANT'
                   and sr.contract_type in ('SEASONAL', 'OFFICIAL')
                   and sr.entry_count = 0
               )::integer as eligible_sub_ledger_count,
               max(sr.last_effective_date) as last_effective_date,
               max(sr.last_entry_at) as last_entry_at,
               max(sr.last_reconciled_as_of_date) as last_reconciled_as_of_date,
               pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'ledger_scope', sr.ledger_scope,
                   'project_id', sr.project_id,
                   'project_display_name', sr.project_display_name,
                   'accountant_ref', sr.accountant_ref,
                   'responsible_accountant_display_name', sr.accountant_display_name,
                   'contract_type', sr.contract_type,
                   'current_balance_minor', sr.current_balance_minor::text,
                   'balance_direction', case
                     when sr.current_balance_minor > 0 then 'PAYABLE'
                     when sr.current_balance_minor < 0 then 'ADVANCE'
                     else 'BALANCED'
                   end,
                   'entry_count', sr.entry_count,
                   'has_opening_entry', sr.has_opening_entry,
                   'eligible_for_opening', (
                     sr.ledger_scope = 'PROJECT_ACCOUNTANT'
                     and sr.contract_type in ('SEASONAL', 'OFFICIAL')
                     and sr.entry_count = 0
                   ),
                   'last_reconciled_as_of_date', case
                     when sr.last_reconciled_as_of_date is null then null
                     else sr.last_reconciled_as_of_date::text
                   end
                 )
                 order by
                   (sr.ledger_scope <> 'PROJECT_ACCOUNTANT') asc,
                   pg_catalog.lower(coalesce(sr.project_display_name, '')) asc,
                   coalesce(sr.project_id, '') asc,
                   pg_catalog.lower(coalesce(sr.accountant_display_name, '')) asc,
                   case sr.contract_type
                     when 'SEASONAL' then 1
                     when 'OFFICIAL' then 2
                     else 3
                   end asc
               ) as sub_ledgers_json
          from subledger_rollups sr
         where sr.vendor_id = vv.vendor_id
      ) agg on true
  ),
  company_summary as (
    select coalesce((
             select sum(sr.current_balance_minor::numeric)
               from subledger_rollups sr
              where sr.current_balance_minor > 0
           ), 0::numeric) as total_payable_num,
           coalesce((
             select sum((-sr.current_balance_minor::numeric))
               from subledger_rollups sr
              where sr.current_balance_minor < 0
           ), 0::numeric) as total_advance_num,
           coalesce(sum(vr.shared_advance_balance_minor::numeric), 0::numeric) as total_shared_advance_num,
           coalesce((
             select sum(sr.current_balance_minor::numeric)
               from subledger_rollups sr
           ), 0::numeric) as net_balance_num,
           count(*) filter (where vr.payable_total_num > 0)::integer as vendors_with_payable_count,
           count(*) filter (where vr.advance_total_num > 0 or vr.shared_advance_balance_minor > 0)::integer as vendors_with_advance_count,
           count(*) filter (where vr.payable_total_num > 0 or vr.advance_total_num > 0 or vr.shared_advance_balance_minor > 0)::integer as vendors_with_nonzero_balance_count,
           count(*)::integer as total_vendor_count,
           count(*) filter (where vr.entry_count = 0 and vr.shared_advance_balance_minor = 0)::integer as uninitialized_vendor_count,
           (select count(*)::integer from subledger_rollups) as active_sub_ledger_count
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
       or (p_balance_filter = 'payable' and vr.payable_total_num > 0)
       or (p_balance_filter = 'advance' and (vr.advance_total_num > 0 or vr.shared_advance_balance_minor > 0))
       or (p_balance_filter = 'nonzero' and (vr.payable_total_num > 0 or vr.advance_total_num > 0 or vr.shared_advance_balance_minor > 0))
       or (p_balance_filter = 'uninitialized' and vr.entry_count = 0 and vr.shared_advance_balance_minor = 0)
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
           'total_shared_advance_minor', pg_catalog.trunc(cs.total_shared_advance_num, 0)::text,
           'net_balance_minor', pg_catalog.trunc(cs.net_balance_num, 0)::text,
           'vendors_with_payable_count', cs.vendors_with_payable_count,
           'vendors_with_advance_count', cs.vendors_with_advance_count,
           'vendors_with_nonzero_balance_count', cs.vendors_with_nonzero_balance_count,
           'total_vendor_count', cs.total_vendor_count,
           'uninitialized_vendor_count', cs.uninitialized_vendor_count,
           'sub_ledger_count', cs.active_sub_ledger_count
         ),
         (select count(*)::integer from filtered),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'vendor_id', page_row.vendor_id,
                        'display_name', page_row.display_name,
                        'active', page_row.active,
                        'sub_ledger_count', page_row.sub_ledger_count,
                        'payable_total_minor', pg_catalog.trunc(page_row.payable_total_num, 0)::text,
                        'advance_total_minor', pg_catalog.trunc(page_row.advance_total_num, 0)::text,
                        'shared_advance_balance_minor', page_row.shared_advance_balance_minor::text,
                        'current_balance_minor', case
                          when page_row.sub_ledger_count = 1 then page_row.single_balance_minor::text
                          when page_row.payable_total_num > 0 and page_row.advance_total_num = 0
                            then pg_catalog.trunc(page_row.payable_total_num, 0)::text
                          when page_row.advance_total_num > 0 and page_row.payable_total_num = 0
                            then ('-' || pg_catalog.trunc(page_row.advance_total_num, 0)::text)
                          else '0'
                        end,
                        'balance_direction', case
                          when page_row.payable_total_num > 0 and page_row.advance_total_num > 0 then 'MULTI_LEDGER'
                          when page_row.payable_total_num > 0 then 'PAYABLE'
                          when page_row.advance_total_num > 0 then 'ADVANCE'
                          else 'BALANCED'
                        end,
                        'entry_count', page_row.entry_count,
                        'has_opening_entry', page_row.has_opening_entry,
                        'eligible_for_opening', (page_row.eligible_sub_ledger_count > 0),
                        'last_effective_date', case
                          when page_row.last_effective_date is null then null
                          else page_row.last_effective_date::text
                        end,
                        'last_entry_at', pg_catalog.to_jsonb(page_row.last_entry_at),
                        'last_reconciled_as_of_date', case
                          when page_row.last_reconciled_as_of_date is null then null
                          else page_row.last_reconciled_as_of_date::text
                        end,
                        'sub_ledgers', page_row.sub_ledgers_json
                      )
                      order by
                        ((page_row.payable_total_num + page_row.advance_total_num + page_row.shared_advance_balance_minor::numeric) = 0) asc,
                        (page_row.payable_total_num + page_row.advance_total_num + page_row.shared_advance_balance_minor::numeric) desc,
                        pg_catalog.lower(page_row.display_name) asc,
                        page_row.vendor_id asc
                    )
               from (
                 select f.*
                   from filtered f
                  order by
                    ((f.payable_total_num + f.advance_total_num + f.shared_advance_balance_minor::numeric) = 0) asc,
                    (f.payable_total_num + f.advance_total_num + f.shared_advance_balance_minor::numeric) desc,
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
      'visibility_scope', v_vis,
      'can_view', true,
      'can_record', coalesce((v_auth->>'can_record')::boolean, false),
      'can_reconcile', coalesce((v_auth->>'can_reconcile')::boolean, false),
      'can_manage_project_assignments', coalesce((v_auth->>'can_manage_project_assignments')::boolean, false),
      'can_view_shared_advance', v_can_view_shared,
      'can_fund_vendor_advance', coalesce((v_auth->>'can_fund_vendor_advance')::boolean, false),
      'can_record_vendor_refund', coalesce((v_auth->>'can_record_vendor_refund')::boolean, false),
      'can_apply_vendor_advance', coalesce((v_auth->>'can_apply_vendor_advance')::boolean, false),
      'active_assigned_project_count', coalesce((v_auth->>'active_assigned_project_count')::integer, 0)
    ),
    'summary', v_summary,
    'filters', pg_catalog.jsonb_build_object(
      'search', v_search,
      'active', p_active_filter,
      'balance_filter', p_balance_filter,
      'project_id', p_project_id,
      'accountant_ref', p_accountant_user_id,
      'ledger_scope', p_ledger_scope,
      'contract_type', p_contract_type
    ),
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'vendors', v_vendors
  );
end;
$function$;

create or replace function public.vendor_finance_export_vendors(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_active_filter text default 'all',
  p_balance_filter text default 'all',
  p_project_id text default null,
  p_accountant_user_id uuid default null,
  p_ledger_scope text default 'all',
  p_contract_type text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_vis text;
  v_can_view_shared boolean := false;
  v_search text := null;
  v_cap constant integer := 10000;
  v_probe_count integer := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
  v_today := (v_auth->>'authorization_date')::date;
  v_vis := v_auth->>'visibility_scope';
  v_can_view_shared := coalesce((v_auth->>'can_view_shared_advance')::boolean, false);

  if p_active_filter is null or p_active_filter not in ('all', 'active', 'inactive')
     or p_balance_filter is null or p_balance_filter not in ('all', 'payable', 'advance', 'nonzero', 'uninitialized')
     or p_ledger_scope is null or p_ledger_scope not in ('all', 'PROJECT_ACCOUNTANT', 'LEGACY_UNALLOCATED') then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_contract_type is null or p_contract_type not in ('all', 'SEASONAL', 'OFFICIAL', 'UNCLASSIFIED') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = '' or pg_catalog.length(v_search) > 120 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'VENDOR_FINANCE_SEARCH_INVALID'
        using errcode = '22023';
    end if;
  end if;

  if v_vis = 'PROJECT_SCOPED' then
    if p_ledger_scope = 'LEGACY_UNALLOCATED'
       or (p_accountant_user_id is not null and p_accountant_user_id <> p_app_user_id) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    if p_project_id is not null and not exists (
      select 1
        from public.vendor_finance_project_accountants pa
       where pa.project_id = p_project_id
         and pa.accountant_user_id = p_app_user_id
         and pa.valid_from <= v_today
         and (pa.valid_to is null or pa.valid_to > v_today)
         and (pa.valid_to is null or pa.valid_to > pa.valid_from)
      union all
      select 1
        from public.vendor_finance_entries e
       where e.ledger_scope = 'PROJECT_ACCOUNTANT'
         and e.project_id = p_project_id
         and e.responsible_accountant_user_id = p_app_user_id
      union all
      select 1
        from public.vendor_finance_reconciliations r
       where r.ledger_scope = 'PROJECT_ACCOUNTANT'
         and r.project_id = p_project_id
         and r.responsible_accountant_user_id = p_app_user_id
    ) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
  end if;

  with candidate_subledgers as (
    select v.vendor_id,
           'PROJECT_ACCOUNTANT'::text as ledger_scope,
           p.project_id,
           pa.accountant_user_id as accountant_ref,
           ct.contract_type
      from public.vendors v
      join public.direct_entry_projects p on p.active = true
      join public.vendor_finance_project_accountants pa on pa.project_id = p.project_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
       and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
      cross join (values ('SEASONAL'::text), ('OFFICIAL'::text)) as ct(contract_type)
     where v.vendor_id <> '__system_vendor__'
       and v.active = true
       and p_project_id is not null
       and p.project_id = p_project_id
       and (v_vis = 'ALL' or pa.accountant_user_id = p_app_user_id)
    union
    select distinct e.vendor_id,
           e.ledger_scope,
           e.project_id,
           e.responsible_accountant_user_id as accountant_ref,
           e.contract_type
      from public.vendor_finance_entries e
     where (v_vis = 'ALL' or (e.ledger_scope = 'PROJECT_ACCOUNTANT' and e.responsible_accountant_user_id = p_app_user_id))
    union
    select distinct r.vendor_id,
           r.ledger_scope,
           r.project_id,
           r.responsible_accountant_user_id as accountant_ref,
           r.contract_type
      from public.vendor_finance_reconciliations r
     where (v_vis = 'ALL' or (r.ledger_scope = 'PROJECT_ACCOUNTANT' and r.responsible_accountant_user_id = p_app_user_id))
  ),
  filtered_subledgers as (
    select cs.*
      from candidate_subledgers cs
     where (p_ledger_scope = 'all' or cs.ledger_scope = p_ledger_scope)
       and (p_project_id is null or cs.project_id = p_project_id)
       and (p_accountant_user_id is null or cs.accountant_ref = p_accountant_user_id)
       and (p_contract_type = 'all' or cs.contract_type = p_contract_type)
  ),
  subledger_rollups as (
    select fs.vendor_id,
           fs.ledger_scope,
           fs.project_id,
           fs.accountant_ref,
           fs.contract_type,
           coalesce(lat.balance_after_minor, 0)::bigint as current_balance_minor,
           coalesce(stats.entry_count, 0)::integer as entry_count,
           stats.last_effective_date
      from filtered_subledgers fs
      left join lateral (
        select e.balance_after_minor
          from public.vendor_finance_entries e
         where e.vendor_id = fs.vendor_id
           and e.ledger_scope = fs.ledger_scope
           and e.project_id is not distinct from fs.project_id
           and e.responsible_accountant_user_id is not distinct from fs.accountant_ref
           and e.contract_type = fs.contract_type
         order by e.vendor_sequence desc
         limit 1
      ) lat on true
      left join lateral (
        select count(*)::integer as entry_count,
               max(e.effective_date) as last_effective_date
          from public.vendor_finance_entries e
         where e.vendor_id = fs.vendor_id
           and e.ledger_scope = fs.ledger_scope
           and e.project_id is not distinct from fs.project_id
           and e.responsible_accountant_user_id is not distinct from fs.accountant_ref
           and e.contract_type = fs.contract_type
      ) stats on true
  ),
  visible_vendors as (
    select v.vendor_id,
           v.display_name,
           v.active
      from public.vendors v
     where v.vendor_id <> '__system_vendor__'
       and (
         exists (select 1 from subledger_rollups sr where sr.vendor_id = v.vendor_id)
         or (
           p_project_id is null
           and p_accountant_user_id is null
           and p_ledger_scope = 'all'
           and p_contract_type = 'all'
           and (
             v_vis = 'ALL'
             or (
               v.active = true
               and exists (
                 select 1
                   from public.vendor_finance_project_accountants pa
                   join public.direct_entry_projects p
                     on p.project_id = pa.project_id
                    and p.active = true
                  where pa.accountant_user_id = p_app_user_id
                    and pa.valid_from <= v_today
                    and (pa.valid_to is null or pa.valid_to > v_today)
                    and (pa.valid_to is null or pa.valid_to > pa.valid_from)
                    and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
               )
             )
           )
         )
       )
  ),
  vendor_rollups as (
    select vv.vendor_id,
           vv.display_name,
           vv.active,
           coalesce(agg.sub_ledger_count, 0)::integer as sub_ledger_count,
           coalesce(agg.payable_total_num, 0::numeric) as payable_total_num,
           coalesce(agg.advance_total_num, 0::numeric) as advance_total_num,
           case
             when v_can_view_shared then coalesce(sh.balance_after_minor, 0)::bigint
             else 0::bigint
           end as shared_advance_balance_minor,
           coalesce(agg.entry_count, 0)::integer as entry_count,
           agg.last_effective_date
      from visible_vendors vv
      left join lateral (
        select m.balance_after_minor
          from public.vendor_finance_shared_advance_movements m
         where m.vendor_id = vv.vendor_id
         order by m.vendor_advance_sequence desc
         limit 1
      ) sh on true
      left join lateral (
        select count(*)::integer as sub_ledger_count,
               coalesce(sum(sr.current_balance_minor::numeric) filter (where sr.current_balance_minor > 0), 0::numeric) as payable_total_num,
               coalesce(sum((-sr.current_balance_minor::numeric)) filter (where sr.current_balance_minor < 0), 0::numeric) as advance_total_num,
               coalesce(sum(sr.entry_count), 0)::integer as entry_count,
               max(sr.last_effective_date) as last_effective_date
          from subledger_rollups sr
         where sr.vendor_id = vv.vendor_id
      ) agg on true
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
       or (p_balance_filter = 'payable' and vr.payable_total_num > 0)
       or (p_balance_filter = 'advance' and (vr.advance_total_num > 0 or vr.shared_advance_balance_minor > 0))
       or (p_balance_filter = 'nonzero' and (vr.payable_total_num > 0 or vr.advance_total_num > 0 or vr.shared_advance_balance_minor > 0))
       or (p_balance_filter = 'uninitialized' and vr.entry_count = 0 and vr.shared_advance_balance_minor = 0)
     )
       and (
       v_search is null
       or vr.vendor_id ilike '%' || v_search || '%'
       or vr.display_name ilike '%' || v_search || '%'
     )
  ),
  capped as (
    select f.*
      from filtered f
     order by
       ((f.payable_total_num + f.advance_total_num + f.shared_advance_balance_minor::numeric) = 0) asc,
       (f.payable_total_num + f.advance_total_num + f.shared_advance_balance_minor::numeric) desc,
       pg_catalog.lower(f.display_name) asc,
       f.vendor_id asc
     limit (v_cap + 1)
  )
  select count(*)::integer,
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'vendor_id', c.vendor_id,
               'display_name', c.display_name,
               'active', c.active,
               'sub_ledger_count', c.sub_ledger_count,
               'payable_total_minor', pg_catalog.trunc(c.payable_total_num, 0)::text,
               'shared_advance_balance_minor', c.shared_advance_balance_minor::text,
               'last_effective_date', case
                 when c.last_effective_date is null then null
                 else c.last_effective_date::text
               end
             )
             order by
               ((c.payable_total_num + c.advance_total_num + c.shared_advance_balance_minor::numeric) = 0) asc,
               (c.payable_total_num + c.advance_total_num + c.shared_advance_balance_minor::numeric) desc,
               pg_catalog.lower(c.display_name) asc,
               c.vendor_id asc
           ),
           '[]'::jsonb
         )
    into v_probe_count, v_rows
    from capped c;

  if coalesce(v_probe_count, 0) > v_cap then
    raise exception 'VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED'
      using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'filters', pg_catalog.jsonb_build_object(
      'search', v_search,
      'active', p_active_filter,
      'balance_filter', p_balance_filter,
      'project_id', p_project_id,
      'accountant_ref', p_accountant_user_id,
      'ledger_scope', p_ledger_scope,
      'contract_type', p_contract_type
    ),
    'row_cap', v_cap,
    'total', coalesce(v_probe_count, 0),
    'vendors', v_rows
  );
end;
$function$;

create or replace function public.vendor_finance_get_vendor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text default null,
  p_accountant_user_id uuid default null,
  p_ledger_scope text default null,
  p_contract_type text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_vis text;
  v_record_scope text;
  v_can_view_shared boolean := false;
  v_vendor public.vendors%rowtype;
  v_shared_balance bigint := 0;
  v_shared_seq bigint := 0;
  v_shared_count integer := 0;
  v_sub_ledgers jsonb := '[]'::jsonb;
  v_sel jsonb := null;
  v_sel_scope text := null;
  v_sel_project_id text := null;
  v_sel_acct_id uuid := null;
  v_sel_contract_type text := null;
  v_sel_can_record boolean := false;
  v_sel_can_reconcile boolean := false;
  v_sel_project_active boolean := false;
  v_current_balance bigint := 0;
  v_latest_seq bigint := 0;
  v_entry_count integer := 0;
  v_has_opening boolean := false;
  v_totals jsonb;
  v_latest_rec jsonb := null;
  v_recent_recs jsonb := '[]'::jsonb;
  v_allowed_entry_types jsonb := '[]'::jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
  v_today := (v_auth->>'authorization_date')::date;
  v_vis := v_auth->>'visibility_scope';
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
  v_can_view_shared := coalesce((v_auth->>'can_view_shared_advance')::boolean, false);

  if p_vendor_id is null
     or p_vendor_id = '__system_vendor__'
     or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
      using errcode = '22023';
  end if;

  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if p_ledger_scope is not null and p_ledger_scope not in ('PROJECT_ACCOUNTANT', 'LEGACY_UNALLOCATED') then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_contract_type is not null and p_contract_type not in ('SEASONAL', 'OFFICIAL', 'UNCLASSIFIED') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if v_vis = 'PROJECT_SCOPED' and (
    p_ledger_scope = 'LEGACY_UNALLOCATED'
    or (p_accountant_user_id is not null and p_accountant_user_id <> p_app_user_id)
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
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

  if v_can_view_shared then
    select coalesce(lat.balance_after_minor, 0)::bigint,
           coalesce(lat.vendor_advance_sequence, 0)::bigint,
           coalesce(cnt.cnt, 0)::integer
      into v_shared_balance, v_shared_seq, v_shared_count
      from (select 1) d
      left join lateral (
        select m.balance_after_minor, m.vendor_advance_sequence
          from public.vendor_finance_shared_advance_movements m
         where m.vendor_id = v_vendor.vendor_id
         order by m.vendor_advance_sequence desc
         limit 1
      ) lat on true
      left join lateral (
        select count(*)::integer as cnt
          from public.vendor_finance_shared_advance_movements m
         where m.vendor_id = v_vendor.vendor_id
      ) cnt on true;
  end if;

  with candidate_books as (
    select 'PROJECT_ACCOUNTANT'::text as ledger_scope,
           p.project_id,
           pa.accountant_user_id as accountant_ref,
           ct.contract_type
      from public.direct_entry_projects p
      join public.vendor_finance_project_accountants pa on pa.project_id = p.project_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
       and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
      cross join (values ('SEASONAL'::text), ('OFFICIAL'::text)) as ct(contract_type)
     where p.active = true
       and v_vendor.active = true
       and (p_project_id is not null or v_vis = 'PROJECT_SCOPED')
       and (p_project_id is null or p.project_id = p_project_id)
       and (v_vis = 'ALL' or pa.accountant_user_id = p_app_user_id)
    union
    select distinct e.ledger_scope,
           e.project_id,
           e.responsible_accountant_user_id as accountant_ref,
           e.contract_type
      from public.vendor_finance_entries e
     where e.vendor_id = v_vendor.vendor_id
       and (v_vis = 'ALL' or (e.ledger_scope = 'PROJECT_ACCOUNTANT' and e.responsible_accountant_user_id = p_app_user_id))
    union
    select distinct r.ledger_scope,
           r.project_id,
           r.responsible_accountant_user_id as accountant_ref,
           r.contract_type
      from public.vendor_finance_reconciliations r
     where r.vendor_id = v_vendor.vendor_id
       and (v_vis = 'ALL' or (r.ledger_scope = 'PROJECT_ACCOUNTANT' and r.responsible_accountant_user_id = p_app_user_id))
  ),
  enriched as (
    select cb.ledger_scope,
           cb.project_id,
           p.display_name as project_display_name,
           coalesce(p.active, false) as project_active,
           cb.accountant_ref,
           case
             when cb.accountant_ref is null then null
             else public.vendor_finance__internal_actor_display_name(cb.accountant_ref)
           end as accountant_display_name,
           cb.contract_type,
           (
             cb.ledger_scope = 'PROJECT_ACCOUNTANT'
             and exists (
               select 1
                 from public.vendor_finance_project_accountants pa
                where pa.project_id = cb.project_id
                  and pa.accountant_user_id = cb.accountant_ref
                  and pa.valid_from <= v_today
                  and (pa.valid_to is null or pa.valid_to > v_today)
                  and (pa.valid_to is null or pa.valid_to > pa.valid_from)
                  and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
             )
           ) as is_active_assignment,
           coalesce(lat.balance_after_minor, 0)::bigint as current_balance_minor,
           coalesce(lat.vendor_sequence, 0)::bigint as latest_sequence,
           coalesce(cnt.entry_count, 0)::integer as entry_count,
           coalesce(cnt.has_opening, false) as has_opening_entry
      from candidate_books cb
      left join public.direct_entry_projects p on p.project_id = cb.project_id
      left join lateral (
        select e.balance_after_minor, e.vendor_sequence
          from public.vendor_finance_entries e
         where e.vendor_id = v_vendor.vendor_id
           and e.ledger_scope = cb.ledger_scope
           and e.project_id is not distinct from cb.project_id
           and e.responsible_accountant_user_id is not distinct from cb.accountant_ref
           and e.contract_type = cb.contract_type
         order by e.vendor_sequence desc
         limit 1
      ) lat on true
      left join lateral (
        select count(*)::integer as entry_count,
               coalesce(bool_or(e.entry_type in ('OPENING_PAYABLE', 'OPENING_ADVANCE')), false) as has_opening
          from public.vendor_finance_entries e
         where e.vendor_id = v_vendor.vendor_id
           and e.ledger_scope = cb.ledger_scope
           and e.project_id is not distinct from cb.project_id
           and e.responsible_accountant_user_id is not distinct from cb.accountant_ref
           and e.contract_type = cb.contract_type
      ) cnt on true
  )
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'ledger_scope', en.ledger_scope,
               'project_id', en.project_id,
               'project_display_name', en.project_display_name,
               'project_active', en.project_active,
               'accountant_ref', en.accountant_ref,
               'responsible_accountant_display_name', en.accountant_display_name,
               'contract_type', en.contract_type,
               'is_active_assignment', en.is_active_assignment,
               'current_balance_minor', en.current_balance_minor::text,
               'balance_direction', case
                 when en.current_balance_minor > 0 then 'PAYABLE'
                 when en.current_balance_minor < 0 then 'ADVANCE'
                 else 'BALANCED'
               end,
               'latest_sequence', en.latest_sequence,
               'entry_count', en.entry_count,
               'has_opening_entry', en.has_opening_entry,
               'eligible_for_opening', (
                 en.ledger_scope = 'PROJECT_ACCOUNTANT'
                 and en.contract_type in ('SEASONAL', 'OFFICIAL')
                 and en.is_active_assignment
                 and en.project_active and v_vendor.active and en.entry_count = 0
                 and not exists (
                   select 1
                     from public.vendor_finance_reconciliations r
                    where r.vendor_id = v_vendor.vendor_id
                      and r.ledger_scope = en.ledger_scope
                      and r.project_id is not distinct from en.project_id
                      and r.responsible_accountant_user_id is not distinct from en.accountant_ref
                      and r.contract_type = en.contract_type
                 )
               ),
               'can_record_entry', (
                 en.ledger_scope = 'PROJECT_ACCOUNTANT'
                 and en.contract_type in ('SEASONAL', 'OFFICIAL')
                 and en.is_active_assignment
                 and (en.entry_count > 0 or (v_vendor.active and en.project_active))
                 and public.vendor_finance__internal_can_actor_write_subledger(
                   v_auth, p_app_user_id, 'record', en.ledger_scope, en.project_id, en.accountant_ref
                 )
               ),
               'can_reconcile', (
                 en.ledger_scope = 'PROJECT_ACCOUNTANT'
                 and (
                   en.entry_count > 0
                   or (en.contract_type in ('SEASONAL', 'OFFICIAL') and v_vendor.active and en.project_active and en.is_active_assignment)
                   or exists (
                     select 1
                       from public.vendor_finance_reconciliations r
                      where r.vendor_id = v_vendor.vendor_id
                        and r.ledger_scope = en.ledger_scope
                        and r.project_id is not distinct from en.project_id
                        and r.responsible_accountant_user_id is not distinct from en.accountant_ref
                        and r.contract_type = en.contract_type
                   )
                 )
                 and public.vendor_finance__internal_can_actor_write_subledger(
                   v_auth, p_app_user_id, 'reconcile', en.ledger_scope, en.project_id, en.accountant_ref
                 )
               ),
               'can_classify_contract_type', (
                 en.ledger_scope = 'PROJECT_ACCOUNTANT'
                 and en.contract_type = 'UNCLASSIFIED'
                 and en.entry_count > 0
                 and public.vendor_finance__internal_can_actor_write_subledger(
                   v_auth, p_app_user_id, 'record', en.ledger_scope, en.project_id, en.accountant_ref
                 )
                 and not exists (
                   select 1
                     from public.vendor_finance_subledger_classifications c
                    where c.vendor_id = v_vendor.vendor_id
                      and c.project_id = en.project_id
                      and c.responsible_accountant_user_id = en.accountant_ref
                 )
               ),
               'classification', public.vendor_finance__internal_classification_projection(
                 v_vendor.vendor_id,
                 en.project_id,
                 en.accountant_ref,
                 en.contract_type
               )
             )
             order by
               (en.ledger_scope <> 'PROJECT_ACCOUNTANT') asc,
               (not en.is_active_assignment) asc,
               (en.entry_count = 0) asc,
               pg_catalog.lower(coalesce(en.project_display_name, '')) asc,
               coalesce(en.project_id, '') asc,
               pg_catalog.lower(coalesce(en.accountant_display_name, '')) asc,
               case en.contract_type
                 when 'SEASONAL' then 1
                 when 'OFFICIAL' then 2
                 else 3
               end asc
           ),
           '[]'::jsonb
         )
    into v_sub_ledgers
    from enriched en;

  if v_vis = 'PROJECT_SCOPED' and pg_catalog.jsonb_array_length(v_sub_ledgers) = 0 then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_ledger_scope is not null
     or p_project_id is not null
     or p_accountant_user_id is not null
     or p_contract_type is not null then
    select item
      into v_sel
      from pg_catalog.jsonb_array_elements(v_sub_ledgers) as item
     where (p_ledger_scope is null or (item->>'ledger_scope') = p_ledger_scope)
       and (p_project_id is null or (item->>'project_id') = p_project_id)
       and (
         p_accountant_user_id is null
         or nullif(item->>'accountant_ref', '')::uuid = p_accountant_user_id
       )
       and (p_contract_type is null or (item->>'contract_type') = p_contract_type)
     limit 1;

    if v_sel is null then
      if v_vis = 'PROJECT_SCOPED' then
        raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
          using errcode = '42501';
      end if;
      raise exception 'VENDOR_FINANCE_SUBLEDGER_NOT_FOUND'
        using errcode = 'P0002';
    end if;
  elsif pg_catalog.jsonb_array_length(v_sub_ledgers) > 0 then
    v_sel := v_sub_ledgers->0;
  end if;

  if v_sel is not null then
    v_sel_scope := v_sel->>'ledger_scope';
    v_sel_project_id := v_sel->>'project_id';
    v_sel_acct_id := nullif(v_sel->>'accountant_ref', '')::uuid;
    v_sel_contract_type := v_sel->>'contract_type';
    v_sel_can_record := coalesce((v_sel->>'can_record_entry')::boolean, false);
    v_sel_can_reconcile := coalesce((v_sel->>'can_reconcile')::boolean, false);
    v_sel_project_active := coalesce((v_sel->>'project_active')::boolean, false);
    v_current_balance := (v_sel->>'current_balance_minor')::bigint;
    v_latest_seq := (v_sel->>'latest_sequence')::bigint;

    with entry_rows as (
      select e.*,
             exists (
               select 1
                 from public.vendor_finance_entries rev
                where rev.reverses_entry_id = e.entry_id
             ) as is_reversed
        from public.vendor_finance_entries e
       where e.vendor_id = v_vendor.vendor_id
         and e.ledger_scope = v_sel_scope
         and e.project_id is not distinct from v_sel_project_id
         and e.responsible_accountant_user_id is not distinct from v_sel_acct_id
         and e.contract_type = v_sel_contract_type
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
             'advance_offset_recorded_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'ADVANCE_OFFSET_RECORDED' and not er.is_reversed), 0::numeric), 0)::text,
             'adjustment_increase_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'ADJUSTMENT_INCREASE' and not er.is_reversed), 0::numeric), 0)::text,
             'adjustment_decrease_minor', pg_catalog.trunc(coalesce(sum(er.amount_minor::numeric) filter (where er.entry_type = 'ADJUSTMENT_DECREASE' and not er.is_reversed), 0::numeric), 0)::text,
             'reversed_entry_count', count(*) filter (where er.entry_type = 'REVERSAL')::integer
           )
      into v_entry_count, v_has_opening, v_totals
      from entry_rows er;

    select coalesce(
             pg_catalog.jsonb_agg(
               public.vendor_finance__internal_reconciliation_projection(page_rec.rec_row, v_auth)
               order by page_rec.as_of_date desc, page_rec.created_at desc, page_rec.reconciliation_id desc
             ),
             '[]'::jsonb
           )
      into v_recent_recs
      from (
        select r as rec_row, r.as_of_date, r.created_at, r.reconciliation_id
          from public.vendor_finance_reconciliations r
         where r.vendor_id = v_vendor.vendor_id
           and r.ledger_scope = v_sel_scope
           and r.project_id is not distinct from v_sel_project_id
           and r.responsible_accountant_user_id is not distinct from v_sel_acct_id
           and r.contract_type = v_sel_contract_type
         order by r.as_of_date desc, r.created_at desc, r.reconciliation_id desc
         limit 10
      ) page_rec;

    if pg_catalog.jsonb_array_length(v_recent_recs) > 0 then
      v_latest_rec := v_recent_recs->0;
    end if;

    if not v_sel_can_record then
      v_allowed_entry_types := '[]'::jsonb;
    elsif v_vendor.active and v_sel_project_active then
      if v_record_scope = 'ALL' then
        v_allowed_entry_types := '["DEBT_RECORDED","PAYROLL_RECORDED","PAYMENT_RECORDED","ADVANCE_RECORDED","ADJUSTMENT_INCREASE","ADJUSTMENT_DECREASE"]'::jsonb;
      else
        v_allowed_entry_types := '["DEBT_RECORDED","PAYROLL_RECORDED","PAYMENT_RECORDED","ADJUSTMENT_INCREASE","ADJUSTMENT_DECREASE"]'::jsonb;
      end if;
    else
      v_allowed_entry_types := '["PAYMENT_RECORDED","ADJUSTMENT_INCREASE","ADJUSTMENT_DECREASE"]'::jsonb;
    end if;
  else
    v_totals := pg_catalog.jsonb_build_object(
      'opening_payable_minor', '0',
      'opening_advance_minor', '0',
      'debt_recorded_minor', '0',
      'payroll_recorded_minor', '0',
      'payment_recorded_minor', '0',
      'advance_recorded_minor', '0',
      'advance_offset_recorded_minor', '0',
      'adjustment_increase_minor', '0',
      'adjustment_decrease_minor', '0',
      'reversed_entry_count', 0
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'allowed_actions', pg_catalog.jsonb_build_object(
      'visibility_scope', v_vis,
      'can_view', true,
      'can_record', v_sel_can_record,
      'can_reconcile', v_sel_can_reconcile,
      'can_manage_project_assignments', coalesce((v_auth->>'can_manage_project_assignments')::boolean, false),
      'can_view_shared_advance', v_can_view_shared,
      'can_fund_vendor_advance', coalesce((v_auth->>'can_fund_vendor_advance')::boolean, false),
      'can_record_vendor_refund', coalesce((v_auth->>'can_record_vendor_refund')::boolean, false),
      'can_apply_vendor_advance', (
        v_sel_can_record
        and coalesce((v_auth->>'can_apply_vendor_advance')::boolean, false)
      ),
      'allowed_entry_types', v_allowed_entry_types
    ),
    'selected_sub_ledger', v_sel,
    'sub_ledgers', v_sub_ledgers,
    'vendor', pg_catalog.jsonb_build_object(
      'vendor_id', v_vendor.vendor_id,
      'display_name', v_vendor.display_name,
      'active', v_vendor.active,
      'shared_advance_balance_minor', v_shared_balance::text,
      'shared_advance_latest_sequence', v_shared_seq,
      'shared_advance_movement_count', v_shared_count,
      'current_balance_minor', v_current_balance::text,
      'balance_direction', case
        when v_current_balance > 0 then 'PAYABLE'
        when v_current_balance < 0 then 'ADVANCE'
        else 'BALANCED'
      end,
      'latest_sequence', v_latest_seq,
      'entry_count', coalesce(v_entry_count, 0),
      'has_opening_entry', coalesce(v_has_opening, false),
      'eligible_for_opening', coalesce((v_sel->>'eligible_for_opening')::boolean, false),
      'totals', v_totals,
      'latest_reconciliation', v_latest_rec,
      'recent_reconciliations', v_recent_recs
    )
  );
end;
$function$;

create or replace function public.vendor_finance_list_vendor_entries(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_before_sequence bigint default null,
  p_entry_type text default null,
  p_page_size integer default 25,
  p_project_id text default null,
  p_accountant_user_id uuid default null,
  p_ledger_scope text default null,
  p_month text default null,
  p_contract_type text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_vis text;
  v_today date;
  v_vendor public.vendors%rowtype;
  v_month_start date := null;
  v_month_end date := null;
  v_entries jsonb;
  v_has_more boolean := false;
  v_next_before_sequence bigint := null;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
  v_vis := v_auth->>'visibility_scope';
  v_today := (v_auth->>'authorization_date')::date;

  if p_vendor_id is null
     or p_vendor_id = '__system_vendor__'
     or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
      using errcode = '22023';
  end if;

  if p_page_size is null or p_page_size < 1 or p_page_size > 100
     or (p_before_sequence is not null and p_before_sequence < 1)
     or (p_ledger_scope is not null and p_ledger_scope not in ('PROJECT_ACCOUNTANT', 'LEGACY_UNALLOCATED')) then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_contract_type is not null and p_contract_type not in ('SEASONAL', 'OFFICIAL', 'UNCLASSIFIED') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if p_month is not null then
    if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception 'VENDOR_FINANCE_DATE_INVALID'
        using errcode = '22023';
    end if;
    v_month_start := pg_catalog.to_date(p_month || '-01', 'YYYY-MM-DD');
    if pg_catalog.date_part('year', v_month_start)::integer not between 1970 and 2999 then
      raise exception 'VENDOR_FINANCE_DATE_INVALID'
        using errcode = '22023';
    end if;
    v_month_end := (v_month_start + interval '1 month')::date;
  end if;

  if p_entry_type is not null and p_entry_type not in (
    'OPENING_PAYABLE',
    'OPENING_ADVANCE',
    'DEBT_RECORDED',
    'PAYROLL_RECORDED',
    'PAYMENT_RECORDED',
    'ADVANCE_RECORDED',
    'ADVANCE_OFFSET_RECORDED',
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

  if v_vis = 'PROJECT_SCOPED' then
    if p_ledger_scope = 'LEGACY_UNALLOCATED'
       or (p_accountant_user_id is not null and p_accountant_user_id <> p_app_user_id) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    if not exists (
      select 1
        from public.vendor_finance_project_accountants pa
        join public.direct_entry_projects p on p.project_id = pa.project_id and p.active = true
       where pa.valid_from <= v_today and (pa.valid_to is null or pa.valid_to > v_today)
         and (pa.valid_to is null or pa.valid_to > pa.valid_from)
         and pa.accountant_user_id = p_app_user_id
         and (p_project_id is null or pa.project_id = p_project_id)
      union all
      select 1
        from public.vendor_finance_entries e
       where e.vendor_id = v_vendor.vendor_id
         and e.ledger_scope = 'PROJECT_ACCOUNTANT'
         and e.responsible_accountant_user_id = p_app_user_id
         and (p_project_id is null or e.project_id = p_project_id)
      union all
      select 1
        from public.vendor_finance_reconciliations r
       where r.vendor_id = v_vendor.vendor_id
         and r.ledger_scope = 'PROJECT_ACCOUNTANT'
         and r.responsible_accountant_user_id = p_app_user_id
         and (p_project_id is null or r.project_id = p_project_id)
    ) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
  end if;

  with fetched as (
    select e as entry_row,
           e.ledger_cursor_seq,
           pg_catalog.row_number() over (order by e.ledger_cursor_seq desc) as rn
      from public.vendor_finance_entries e
     where e.vendor_id = v_vendor.vendor_id
       and (v_vis = 'ALL' or (e.ledger_scope = 'PROJECT_ACCOUNTANT' and e.responsible_accountant_user_id = p_app_user_id))
       and (p_ledger_scope is null or e.ledger_scope = p_ledger_scope)
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_accountant_user_id is null or e.responsible_accountant_user_id = p_accountant_user_id)
       and (p_contract_type is null or e.contract_type = p_contract_type)
       and (v_month_start is null or (e.effective_date >= v_month_start and e.effective_date < v_month_end))
       and (p_before_sequence is null or e.ledger_cursor_seq < p_before_sequence)
       and (p_entry_type is null or e.entry_type = p_entry_type)
     order by e.ledger_cursor_seq desc
     limit (p_page_size + 1)
  )
  select exists (select 1 from fetched where rn > p_page_size),
         (select min(ledger_cursor_seq) from fetched where rn <= p_page_size),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      public.vendor_finance__internal_entry_projection(f.entry_row, v_auth)
                      order by f.ledger_cursor_seq desc
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

create or replace function public.vendor_finance_list_shared_advance_movements(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_before_sequence bigint default null,
  p_movement_type text default null,
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
  v_vendor public.vendors%rowtype;
  v_shared_balance bigint := 0;
  v_shared_seq bigint := 0;
  v_movements jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_before_sequence bigint := null;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'shared_advance_view');

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

  if p_movement_type is not null and p_movement_type not in (
    'ADVANCE_FUNDED',
    'VENDOR_REFUND_RECORDED',
    'PROJECT_OFFSET_APPLIED',
    'REVERSAL'
  ) then
    raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_TYPE_INVALID'
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

  select coalesce(m.balance_after_minor, 0)::bigint,
         coalesce(m.vendor_advance_sequence, 0)::bigint
    into v_shared_balance, v_shared_seq
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  if not found then
    v_shared_balance := 0;
    v_shared_seq := 0;
  end if;

  with fetched as (
    select m as movement_row,
           m.movement_cursor_seq,
           pg_catalog.row_number() over (order by m.movement_cursor_seq desc) as rn
      from public.vendor_finance_shared_advance_movements m
     where m.vendor_id = v_vendor.vendor_id
       and (p_before_sequence is null or m.movement_cursor_seq < p_before_sequence)
       and (p_movement_type is null or m.movement_type = p_movement_type)
     order by m.movement_cursor_seq desc
     limit (p_page_size + 1)
  )
  select exists (select 1 from fetched where rn > p_page_size),
         (select min(movement_cursor_seq) from fetched where rn <= p_page_size),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      public.vendor_finance__internal_shared_advance_movement_projection(f.movement_row, v_auth)
                      order by f.movement_cursor_seq desc
                    )
               from fetched f
              where f.rn <= p_page_size
           ),
           '[]'::jsonb
         )
    into v_has_more, v_next_before_sequence, v_movements;

  if not v_has_more then
    v_next_before_sequence := null;
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'vendor_id', v_vendor.vendor_id,
    'shared_advance_balance_minor', v_shared_balance::text,
    'shared_advance_latest_sequence', v_shared_seq,
    'page_size', p_page_size,
    'has_more', coalesce(v_has_more, false),
    'next_before_sequence', v_next_before_sequence,
    'movements', v_movements
  );
end;
$function$;


-- -----------------------------------------------------------------------------
-- 6. Write RPCs (Project Sub-Ledger Entry Restrictions + Shared Advance RPCs)
-- -----------------------------------------------------------------------------
create or replace function public.vendor_finance_record_entry(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_contract_type text,
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
  v_today date;
  v_record_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_vendor public.vendors%rowtype;
  v_proj_acct jsonb;
  v_active_acct_id uuid;
  v_active_acct_name text;
  v_has_entries boolean;
  v_amount bigint;
  v_delta bigint;
  v_reason text;
  v_actor_name text;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_entries%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'record');
  v_today := (v_auth->>'authorization_date')::date;
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
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

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
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

  -- Project accountants (record_scope <> 'ALL') cannot record ADVANCE_RECORDED.
  if p_entry_type = 'ADVANCE_RECORDED' and v_record_scope <> 'ALL' then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  if p_effective_date is null
     or pg_catalog.date_part('year', p_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_amount := public.vendor_finance__internal_parse_positive_minor(p_amount_minor);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  -- Lock order: ALWAYS project first, then vendor.
  v_project := public.vendor_finance__internal_lock_project(p_project_id);
  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
    if v_record_scope = 'ASSIGNED_PROJECTS' then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
      using errcode = '40900';
  end if;

  v_active_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  v_active_acct_name := v_proj_acct->>'accountant_display_name';

  if v_record_scope = 'ASSIGNED_PROJECTS' and v_active_acct_id <> p_app_user_id then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if not v_vendor.active or not v_project.active then
    select exists (
             select 1
               from public.vendor_finance_entries e
              where e.vendor_id = v_vendor.vendor_id
                and e.ledger_scope = 'PROJECT_ACCOUNTANT'
                and e.project_id = v_project.project_id
                and e.responsible_accountant_user_id = v_active_acct_id
                and e.contract_type = p_contract_type
           )
      into v_has_entries;

    if not v_has_entries then
      if not v_project.active then
        raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
          using errcode = '42200';
      end if;
      raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN'
        using errcode = '23514';
    end if;

    if p_entry_type not in ('PAYMENT_RECORDED', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE') then
      if not v_project.active then
        raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
          using errcode = '42200';
      end if;
      raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN'
        using errcode = '23514';
    end if;
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
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_active_acct_id
     and e.contract_type = p_contract_type
   order by e.vendor_sequence desc
   limit 1;

  if not found then
    v_prev_seq := 0;
    v_prev_balance := 0;
  end if;

  v_next_seq := v_prev_seq + 1;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(v_prev_balance, v_delta);
  v_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

  insert into public.vendor_finance_entries (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
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
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
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
    project_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_inserted.entry_id,
    p_app_user_id,
    v_authority_source,
    'ENTRY_RECORDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'document_no', v_inserted.document_no,
      'project_id', v_inserted.project_id,
      'responsible_accountant_user_id', v_inserted.responsible_accountant_user_id,
      'contract_type', v_inserted.contract_type,
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
    'entry', public.vendor_finance__internal_entry_projection(v_inserted, v_auth)
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

create or replace function public.vendor_finance_preview_opening_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_contract_type text,
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
  v_today date;
  v_record_scope text;
  v_proj_acct jsonb;
  v_active_acct_id uuid;
  v_active_acct_name text;
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
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'record');
  v_today := (v_auth->>'authorization_date')::date;
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(p_project_id, v_today);

  if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
    if v_record_scope = 'ASSIGNED_PROJECTS' then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
      using errcode = '40900';
  end if;

  v_active_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  v_active_acct_name := v_proj_acct->>'accountant_display_name';

  if v_record_scope = 'ASSIGNED_PROJECTS' and v_active_acct_id <> p_app_user_id then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if not coalesce((v_proj_acct->>'project_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
      using errcode = '42200';
  end if;

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

    if v_entry_type = 'OPENING_ADVANCE' and v_record_scope <> 'ALL' then
      raise exception 'VENDOR_FINANCE_RECORD_DENIED'
        using errcode = '42501';
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

    if not v_vendor.active then
      raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN'
        using errcode = '23514';
    end if;

    if v_amount = 0 then
      v_skipped_zero := v_skipped_zero + 1;
      continue;
    end if;

    select exists (
             select 1
               from public.vendor_finance_entries e
              where e.vendor_id = v_vendor.vendor_id
                and e.ledger_scope = 'PROJECT_ACCOUNTANT'
                and e.project_id = (v_proj_acct->>'project_id')
                and e.responsible_accountant_user_id = v_active_acct_id
                and e.contract_type = p_contract_type
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
    'project_id', v_proj_acct->>'project_id',
    'project_display_name', v_proj_acct->>'project_display_name',
    'accountant_ref', v_active_acct_id,
    'responsible_accountant_display_name', v_active_acct_name,
    'contract_type', p_contract_type,
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

create or replace function public.vendor_finance_apply_opening_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_contract_type text,
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
  v_today date;
  v_record_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_proj_acct jsonb;
  v_active_acct_id uuid;
  v_active_acct_name text;
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
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'record');
  v_today := (v_auth->>'authorization_date')::date;
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
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

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
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

  -- Lock project FIRST before locking any canonical vendor rows.
  v_project := public.vendor_finance__internal_lock_project(p_project_id);
  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
    if v_record_scope = 'ASSIGNED_PROJECTS' then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
      using errcode = '40900';
  end if;

  v_active_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  v_active_acct_name := v_proj_acct->>'accountant_display_name';

  if v_record_scope = 'ASSIGNED_PROJECTS' and v_active_acct_id <> p_app_user_id then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if not v_project.active then
    raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
      using errcode = '42200';
  end if;

  -- Pass 1: validate input syntax, uniqueness, authority for OPENING_ADVANCE, and non-zero totals.
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

    if v_entry_type = 'OPENING_ADVANCE' and v_record_scope <> 'ALL' then
      raise exception 'VENDOR_FINANCE_RECORD_DENIED'
        using errcode = '42501';
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

  -- Pass 2: lock ALL referenced canonical vendors in deterministic ascending vendor_id order.
  for v_sorted_vendor_id in
    select u.vid
      from pg_catalog.unnest(v_all_vendor_ids) as u(vid)
     order by u.vid asc
  loop
    perform public.vendor_finance__internal_lock_vendor(v_sorted_vendor_id);
  end loop;

  -- Pass 3: verify active Vendors and uninitialized books for `p_contract_type` under Vendor locks.
  for v_idx in 0..(v_len - 1) loop
    v_item := p_items->v_idx;
    v_vendor_id := v_item->>'vendor_id';
    v_amount := public.vendor_finance__internal_parse_non_negative_minor(v_item->>'amount_minor');

    select v.* into v_vendor from public.vendors v
     where v.vendor_id = v_vendor_id and v.vendor_id <> '__system_vendor__';

    if not found then
      raise exception 'VENDOR_FINANCE_VENDOR_NOT_FOUND' using errcode = 'P0002';
    end if;
    if not v_vendor.active then
      raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN' using errcode = '23514';
    end if;

    if v_amount = 0 then
      continue;
    end if;

    select exists (
             select 1
               from public.vendor_finance_entries e
              where e.vendor_id = v_vendor_id
                and e.ledger_scope = 'PROJECT_ACCOUNTANT'
                and e.project_id = v_project.project_id
                and e.responsible_accountant_user_id = v_active_acct_id
                and e.contract_type = p_contract_type
           )
      into v_has_entries;

    if v_has_entries then
      raise exception 'VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED'
        using errcode = '23505';
    end if;
  end loop;

  v_net := public.vendor_finance__internal_checked_sub_minor(v_total_payable, v_total_advance);

  insert into public.vendor_finance_opening_batches (
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
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
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
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
      ledger_scope,
      project_id,
      project_display_name_snapshot,
      responsible_accountant_user_id,
      responsible_accountant_display_name_snapshot,
      contract_type,
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
      'PROJECT_ACCOUNTANT',
      v_project.project_id,
      v_project.display_name,
      v_active_acct_id,
      v_active_acct_name,
      p_contract_type,
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
      public.vendor_finance__internal_entry_projection(v_inserted, v_auth)
    );
  end loop;

  insert into public.vendor_finance_audit_events (
    project_id,
    opening_batch_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_project.project_id,
    v_batch.batch_id,
    p_app_user_id,
    v_authority_source,
    'OPENING_BATCH_APPLIED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'project_id', v_batch.project_id,
      'responsible_accountant_user_id', v_batch.responsible_accountant_user_id,
      'contract_type', v_batch.contract_type,
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
      'ledger_scope', v_batch.ledger_scope,
      'project_id', v_batch.project_id,
      'project_display_name_snapshot', v_batch.project_display_name_snapshot,
      'accountant_ref', v_batch.responsible_accountant_user_id,
      'responsible_accountant_display_name', v_batch.responsible_accountant_display_name_snapshot,
      'contract_type', v_batch.contract_type,
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


create or replace function public.vendor_finance_fund_shared_advance(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
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
  v_reason text;
  v_actor_name text;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_shared_advance_movements%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_fund'
  );
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
    if v_existing_idem.action <> 'FUND_SHARED_ADVANCE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
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

  if not v_vendor.active then
    raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN'
      using errcode = '23514';
  end if;

  select m.vendor_advance_sequence, m.balance_after_minor
    into v_prev_seq, v_prev_balance
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  if not found then
    v_prev_seq := 0;
    v_prev_balance := 0;
  end if;

  v_next_seq := v_prev_seq + 1;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(v_prev_balance, v_amount);
  v_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

  insert into public.vendor_finance_shared_advance_movements (
    vendor_id,
    vendor_display_name_snapshot,
    vendor_advance_sequence,
    movement_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    project_entry_id,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    reverses_movement_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_vendor.display_name,
    v_next_seq,
    'ADVANCE_FUNDED',
    v_amount,
    v_amount,
    v_prev_balance,
    v_after_balance,
    p_effective_date,
    v_reason,
    v_doc_no,
    null,
    null,
    null,
    null,
    null,
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
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    p_app_user_id,
    v_authority_source,
    'SHARED_ADVANCE_FUNDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted.movement_id,
      'document_no', v_inserted.document_no,
      'movement_type', v_inserted.movement_type,
      'amount_minor', v_inserted.amount_minor::text,
      'balance_before_minor', v_inserted.balance_before_minor::text,
      'balance_delta_minor', v_inserted.balance_delta_minor::text,
      'balance_after_minor', v_inserted.balance_after_minor::text,
      'effective_date', v_inserted.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted, v_auth),
    'shared_advance_balance_minor', v_inserted.balance_after_minor::text
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
    'FUND_SHARED_ADVANCE',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.vendor_finance_record_vendor_refund(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
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
  v_actor_name text;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_shared_advance_movements%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_refund'
  );
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
    if v_existing_idem.action <> 'RECORD_VENDOR_REFUND'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
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

  select m.vendor_advance_sequence, m.balance_after_minor
    into v_prev_seq, v_prev_balance
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  if not found then
    v_prev_seq := 0;
    v_prev_balance := 0;
  end if;

  if v_amount > v_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE'
      using errcode = '23514';
  end if;

  v_next_seq := v_prev_seq + 1;
  v_delta := -v_amount;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(v_prev_balance, v_delta);
  v_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

  insert into public.vendor_finance_shared_advance_movements (
    vendor_id,
    vendor_display_name_snapshot,
    vendor_advance_sequence,
    movement_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    project_entry_id,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    reverses_movement_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_vendor.display_name,
    v_next_seq,
    'VENDOR_REFUND_RECORDED',
    v_amount,
    v_delta,
    v_prev_balance,
    v_after_balance,
    p_effective_date,
    v_reason,
    v_doc_no,
    null,
    null,
    null,
    null,
    null,
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
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    p_app_user_id,
    v_authority_source,
    'VENDOR_REFUND_RECORDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted.movement_id,
      'document_no', v_inserted.document_no,
      'movement_type', v_inserted.movement_type,
      'amount_minor', v_inserted.amount_minor::text,
      'balance_before_minor', v_inserted.balance_before_minor::text,
      'balance_delta_minor', v_inserted.balance_delta_minor::text,
      'balance_after_minor', v_inserted.balance_after_minor::text,
      'effective_date', v_inserted.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted, v_auth),
    'shared_advance_balance_minor', v_inserted.balance_after_minor::text
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
    'RECORD_VENDOR_REFUND',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.vendor_finance_apply_shared_advance_offset(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_contract_type text,
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
  v_today date;
  v_record_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_vendor public.vendors%rowtype;
  v_proj_acct jsonb;
  v_active_acct_id uuid;
  v_active_acct_name text;
  v_amount bigint;
  v_delta bigint;
  v_reason text;
  v_actor_name text;
  v_shared_prev_seq bigint;
  v_shared_prev_balance bigint;
  v_shared_next_seq bigint;
  v_shared_after_balance bigint;
  v_sub_prev_seq bigint;
  v_sub_prev_balance bigint;
  v_sub_next_seq bigint;
  v_sub_after_balance bigint;
  v_entry_doc_no text;
  v_mov_doc_no text;
  v_inserted_entry public.vendor_finance_entries%rowtype;
  v_inserted_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_apply'
  );
  v_today := (v_auth->>'authorization_date')::date;
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
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
    if v_existing_idem.action <> 'APPLY_SHARED_ADVANCE_OFFSET'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
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

  -- Lock order: ALWAYS project first, then vendor.
  v_project := public.vendor_finance__internal_lock_project(p_project_id);
  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
    if v_record_scope = 'ASSIGNED_PROJECTS' then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
      using errcode = '40900';
  end if;

  v_active_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  v_active_acct_name := v_proj_acct->>'accountant_display_name';

  if v_record_scope = 'ASSIGNED_PROJECTS' and v_active_acct_id <> p_app_user_id then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  select m.vendor_advance_sequence, m.balance_after_minor
    into v_shared_prev_seq, v_shared_prev_balance
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  if not found then
    v_shared_prev_seq := 0;
    v_shared_prev_balance := 0;
  end if;

  if v_shared_prev_balance <= 0 or v_amount > v_shared_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE'
      using errcode = '23514';
  end if;

  select e.vendor_sequence, e.balance_after_minor
    into v_sub_prev_seq, v_sub_prev_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_active_acct_id
     and e.contract_type = p_contract_type
   order by e.vendor_sequence desc
   limit 1;

  if not found then
    v_sub_prev_seq := 0;
    v_sub_prev_balance := 0;
  end if;

  if v_sub_prev_balance <= 0 or v_amount > v_sub_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE'
      using errcode = '23514';
  end if;

  v_delta := -v_amount;
  v_sub_next_seq := v_sub_prev_seq + 1;
  v_sub_after_balance := public.vendor_finance__internal_checked_add_minor(v_sub_prev_balance, v_delta);

  v_shared_next_seq := v_shared_prev_seq + 1;
  v_shared_after_balance := public.vendor_finance__internal_checked_add_minor(v_shared_prev_balance, v_delta);

  v_entry_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);
  v_mov_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);
  perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

  insert into public.vendor_finance_entries (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
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
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
    v_sub_next_seq,
    'ADVANCE_OFFSET_RECORDED',
    v_amount,
    v_delta,
    v_sub_prev_balance,
    v_sub_after_balance,
    p_effective_date,
    v_reason,
    v_entry_doc_no,
    v_vendor.display_name,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted_entry;

  insert into public.vendor_finance_shared_advance_movements (
    vendor_id,
    vendor_display_name_snapshot,
    vendor_advance_sequence,
    movement_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    project_entry_id,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    reverses_movement_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_vendor.display_name,
    v_shared_next_seq,
    'PROJECT_OFFSET_APPLIED',
    v_amount,
    v_delta,
    v_shared_prev_balance,
    v_shared_after_balance,
    p_effective_date,
    v_reason,
    v_mov_doc_no,
    v_inserted_entry.entry_id,
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted_mov;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_inserted_entry.entry_id,
    p_app_user_id,
    v_authority_source,
    'SHARED_ADVANCE_OFFSET_APPLIED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted_mov.movement_id,
      'movement_document_no', v_inserted_mov.document_no,
      'entry_id', v_inserted_entry.entry_id,
      'entry_document_no', v_inserted_entry.document_no,
      'project_id', v_inserted_entry.project_id,
      'responsible_accountant_user_id', v_inserted_entry.responsible_accountant_user_id,
      'contract_type', v_inserted_entry.contract_type,
      'amount_minor', v_inserted_entry.amount_minor::text,
      'subledger_balance_before_minor', v_inserted_entry.balance_before_minor::text,
      'subledger_balance_after_minor', v_inserted_entry.balance_after_minor::text,
      'shared_advance_before_minor', v_inserted_mov.balance_before_minor::text,
      'shared_advance_after_minor', v_inserted_mov.balance_after_minor::text,
      'effective_date', v_inserted_entry.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted_mov, v_auth),
    'entry', public.vendor_finance__internal_entry_projection(v_inserted_entry, v_auth),
    'shared_advance_balance_minor', v_inserted_mov.balance_after_minor::text
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
    'APPLY_SHARED_ADVANCE_OFFSET',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

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
  v_record_scope text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_orig public.vendor_finance_entries%rowtype;
  v_orig_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_has_orig_mov boolean := false;
  v_vendor public.vendors%rowtype;
  v_effective_date date;
  v_reason text;
  v_actor_name text;
  v_existing_rev uuid;
  v_existing_mov_rev uuid;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_delta bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_entries%rowtype;
  v_mov_prev_seq bigint;
  v_mov_prev_balance bigint;
  v_mov_next_seq bigint;
  v_mov_delta bigint;
  v_mov_after_balance bigint;
  v_mov_doc_no text;
  v_inserted_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'record');
  v_authority_source := v_auth->>'authority_source';
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');

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

  v_effective_date := coalesce(p_effective_date, (v_auth->>'authorization_date')::date);
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

  if v_orig.entry_type in ('ADVANCE_RECORDED', 'OPENING_ADVANCE') and v_record_scope <> 'ALL' then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  if v_orig.project_id is not null then
    perform public.vendor_finance__internal_lock_project(v_orig.project_id);
  end if;
  v_vendor := public.vendor_finance__internal_lock_vendor(v_orig.vendor_id);

  if not public.vendor_finance__internal_can_actor_write_subledger(
    v_auth,
    p_app_user_id,
    'record',
    v_orig.ledger_scope,
    v_orig.project_id,
    v_orig.responsible_accountant_user_id
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

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

  if v_orig.entry_type = 'ADVANCE_OFFSET_RECORDED' then
    select m.*
      into v_orig_mov
      from public.vendor_finance_shared_advance_movements m
     where m.project_entry_id = v_orig.entry_id
       and m.movement_type = 'PROJECT_OFFSET_APPLIED';

    if not found then
      raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    v_has_orig_mov := true;

    select rm.movement_id
      into v_existing_mov_rev
      from public.vendor_finance_shared_advance_movements rm
     where rm.reverses_movement_id = v_orig_mov.movement_id;

    if found then
      raise exception 'VENDOR_FINANCE_ENTRY_ALREADY_REVERSED'
        using errcode = '23505';
    end if;
  end if;

  v_delta := -v_orig.balance_delta_minor;

  select e.vendor_sequence, e.balance_after_minor
    into v_prev_seq, v_prev_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_orig.vendor_id
     and e.ledger_scope = v_orig.ledger_scope
     and e.project_id is not distinct from v_orig.project_id
     and e.responsible_accountant_user_id is not distinct from v_orig.responsible_accountant_user_id
     and e.contract_type = v_orig.contract_type
   order by e.vendor_sequence desc
   limit 1;

  v_next_seq := coalesce(v_prev_seq, 0) + 1;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(coalesce(v_prev_balance, 0), v_delta);
  v_doc_no := public.vendor_finance__internal_next_document_no(v_effective_date);

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

  insert into public.vendor_finance_entries (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
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
    v_orig.ledger_scope,
    v_orig.project_id,
    v_orig.project_display_name_snapshot,
    v_orig.responsible_accountant_user_id,
    v_orig.responsible_accountant_display_name_snapshot,
    v_orig.contract_type,
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

  if v_has_orig_mov then
    select m.vendor_advance_sequence, m.balance_after_minor
      into v_mov_prev_seq, v_mov_prev_balance
      from public.vendor_finance_shared_advance_movements m
     where m.vendor_id = v_vendor.vendor_id
     order by m.vendor_advance_sequence desc
     limit 1;

    v_mov_next_seq := coalesce(v_mov_prev_seq, 0) + 1;
    v_mov_delta := -v_orig_mov.balance_delta_minor;
    v_mov_after_balance := public.vendor_finance__internal_checked_add_minor(
      coalesce(v_mov_prev_balance, 0),
      v_mov_delta
    );
    v_mov_doc_no := public.vendor_finance__internal_next_document_no(v_effective_date);

    perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

    insert into public.vendor_finance_shared_advance_movements (
      vendor_id,
      vendor_display_name_snapshot,
      vendor_advance_sequence,
      movement_type,
      amount_minor,
      balance_delta_minor,
      balance_before_minor,
      balance_after_minor,
      effective_date,
      reason,
      document_no,
      project_entry_id,
      project_id,
      project_display_name_snapshot,
      responsible_accountant_user_id,
      responsible_accountant_display_name_snapshot,
      contract_type,
      reverses_movement_id,
      created_by_user_id,
      created_by_display_name_snapshot,
      idempotency_key,
      request_fingerprint
    ) values (
      v_vendor.vendor_id,
      v_vendor.display_name,
      v_mov_next_seq,
      'REVERSAL',
      v_orig_mov.amount_minor,
      v_mov_delta,
      coalesce(v_mov_prev_balance, 0),
      v_mov_after_balance,
      v_effective_date,
      v_reason,
      v_mov_doc_no,
      v_inserted.entry_id,
      v_orig.project_id,
      v_orig.project_display_name_snapshot,
      v_orig.responsible_accountant_user_id,
      v_orig.responsible_accountant_display_name_snapshot,
      v_orig.contract_type,
      v_orig_mov.movement_id,
      p_app_user_id,
      v_actor_name,
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_inserted_mov;

    select m.*
      into v_orig_mov
      from public.vendor_finance_shared_advance_movements m
     where m.movement_id = v_orig_mov.movement_id;
  end if;

  select e.* into v_orig from public.vendor_finance_entries e where e.entry_id = v_orig.entry_id;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_orig.project_id,
    v_inserted.entry_id,
    p_app_user_id,
    v_authority_source,
    'ENTRY_REVERSED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'document_no', v_inserted.document_no,
      'project_id', v_inserted.project_id,
      'responsible_accountant_user_id', v_inserted.responsible_accountant_user_id,
      'contract_type', v_inserted.contract_type,
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
    'reversal_entry', public.vendor_finance__internal_entry_projection(v_inserted, v_auth),
    'reversed_entry', public.vendor_finance__internal_entry_projection(v_orig, v_auth)
  );

  if v_has_orig_mov then
    v_base_payload := v_base_payload || pg_catalog.jsonb_build_object(
      'reversal_movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted_mov, v_auth),
      'reversed_movement', public.vendor_finance__internal_shared_advance_movement_projection(v_orig_mov, v_auth),
      'shared_advance_balance_minor', v_inserted_mov.balance_after_minor::text
    );
  end if;

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

create or replace function public.vendor_finance_reverse_shared_advance_movement(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_movement_id uuid,
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
  v_orig_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_orig_entry public.vendor_finance_entries%rowtype;
  v_has_orig_entry boolean := false;
  v_vendor public.vendors%rowtype;
  v_effective_date date;
  v_reason text;
  v_actor_name text;
  v_existing_mov_rev uuid;
  v_existing_entry_rev uuid;
  v_mov_prev_seq bigint;
  v_mov_prev_balance bigint;
  v_mov_next_seq bigint;
  v_mov_delta bigint;
  v_mov_after_balance bigint;
  v_mov_doc_no text;
  v_inserted_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_entry_prev_seq bigint;
  v_entry_prev_balance bigint;
  v_entry_next_seq bigint;
  v_entry_delta bigint;
  v_entry_after_balance bigint;
  v_entry_doc_no text;
  v_inserted_entry public.vendor_finance_entries%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
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
    if v_existing_idem.action <> 'REVERSE_SHARED_ADVANCE_MOVEMENT'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_movement_id is null then
    raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID'
      using errcode = '22023';
  end if;

  v_effective_date := coalesce(p_effective_date, (v_auth->>'authorization_date')::date);
  if pg_catalog.date_part('year', v_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  select m.*
    into v_orig_mov
    from public.vendor_finance_shared_advance_movements m
   where m.movement_id = p_movement_id;

  if not found then
    raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_orig_mov.movement_type = 'REVERSAL' then
    raise exception 'VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL'
      using errcode = '23514';
  end if;

  if v_orig_mov.movement_type in ('ADVANCE_FUNDED', 'VENDOR_REFUND_RECORDED') then
    if not coalesce((v_auth->>'can_fund_vendor_advance')::boolean, false) then
      raise exception 'VENDOR_FINANCE_RECORD_DENIED'
        using errcode = '42501';
    end if;
    v_vendor := public.vendor_finance__internal_lock_vendor(v_orig_mov.vendor_id);
  elsif v_orig_mov.movement_type = 'PROJECT_OFFSET_APPLIED' then
    if not coalesce((v_auth->>'can_apply_vendor_advance')::boolean, false) then
      raise exception 'VENDOR_FINANCE_RECORD_DENIED'
        using errcode = '42501';
    end if;
    perform public.vendor_finance__internal_lock_project(v_orig_mov.project_id);
    v_vendor := public.vendor_finance__internal_lock_vendor(v_orig_mov.vendor_id);

    if not public.vendor_finance__internal_can_actor_write_subledger(
      v_auth,
      p_app_user_id,
      'record',
      'PROJECT_ACCOUNTANT',
      v_orig_mov.project_id,
      v_orig_mov.responsible_accountant_user_id
    ) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    select e.*
      into v_orig_entry
      from public.vendor_finance_entries e
     where e.entry_id = v_orig_mov.project_entry_id;

    if not found then
      raise exception 'VENDOR_FINANCE_ENTRY_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    v_has_orig_entry := true;
  else
    raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID'
      using errcode = '22023';
  end if;

  select rm.movement_id
    into v_existing_mov_rev
    from public.vendor_finance_shared_advance_movements rm
   where rm.reverses_movement_id = v_orig_mov.movement_id;

  if found then
    raise exception 'VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED'
      using errcode = '23505';
  end if;

  if v_has_orig_entry then
    select re.entry_id
      into v_existing_entry_rev
      from public.vendor_finance_entries re
     where re.reverses_entry_id = v_orig_entry.entry_id;

    if found then
      raise exception 'VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED'
        using errcode = '23505';
    end if;
  end if;

  select m.vendor_advance_sequence, m.balance_after_minor
    into v_mov_prev_seq, v_mov_prev_balance
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  v_mov_next_seq := coalesce(v_mov_prev_seq, 0) + 1;
  v_mov_delta := -v_orig_mov.balance_delta_minor;
  v_mov_after_balance := public.vendor_finance__internal_checked_add_minor(
    coalesce(v_mov_prev_balance, 0),
    v_mov_delta
  );

  if v_mov_after_balance < 0 then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE'
      using errcode = '23514';
  end if;

  if v_has_orig_entry then
    v_entry_delta := -v_orig_entry.balance_delta_minor;

    select e.vendor_sequence, e.balance_after_minor
      into v_entry_prev_seq, v_entry_prev_balance
      from public.vendor_finance_entries e
     where e.vendor_id = v_orig_entry.vendor_id
       and e.ledger_scope = v_orig_entry.ledger_scope
       and e.project_id is not distinct from v_orig_entry.project_id
       and e.responsible_accountant_user_id is not distinct from v_orig_entry.responsible_accountant_user_id
       and e.contract_type = v_orig_entry.contract_type
     order by e.vendor_sequence desc
     limit 1;

    v_entry_next_seq := coalesce(v_entry_prev_seq, 0) + 1;
    v_entry_after_balance := public.vendor_finance__internal_checked_add_minor(
      coalesce(v_entry_prev_balance, 0),
      v_entry_delta
    );
    v_entry_doc_no := public.vendor_finance__internal_next_document_no(v_effective_date);

    perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

    insert into public.vendor_finance_entries (
      vendor_id,
      ledger_scope,
      project_id,
      project_display_name_snapshot,
      responsible_accountant_user_id,
      responsible_accountant_display_name_snapshot,
      contract_type,
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
      v_orig_entry.ledger_scope,
      v_orig_entry.project_id,
      v_orig_entry.project_display_name_snapshot,
      v_orig_entry.responsible_accountant_user_id,
      v_orig_entry.responsible_accountant_display_name_snapshot,
      v_orig_entry.contract_type,
      v_entry_next_seq,
      'REVERSAL',
      v_orig_entry.amount_minor,
      v_entry_delta,
      coalesce(v_entry_prev_balance, 0),
      v_entry_after_balance,
      v_effective_date,
      v_reason,
      v_entry_doc_no,
      v_vendor.display_name,
      null,
      v_orig_entry.entry_id,
      p_app_user_id,
      v_actor_name,
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_inserted_entry;
  end if;

  v_mov_doc_no := public.vendor_finance__internal_next_document_no(v_effective_date);

  perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

  insert into public.vendor_finance_shared_advance_movements (
    vendor_id,
    vendor_display_name_snapshot,
    vendor_advance_sequence,
    movement_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    project_entry_id,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    reverses_movement_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_vendor.display_name,
    v_mov_next_seq,
    'REVERSAL',
    v_orig_mov.amount_minor,
    v_mov_delta,
    coalesce(v_mov_prev_balance, 0),
    v_mov_after_balance,
    v_effective_date,
    v_reason,
    v_mov_doc_no,
    case when v_has_orig_entry then v_inserted_entry.entry_id else null end,
    v_orig_mov.project_id,
    v_orig_mov.project_display_name_snapshot,
    v_orig_mov.responsible_accountant_user_id,
    v_orig_mov.responsible_accountant_display_name_snapshot,
    v_orig_mov.contract_type,
    v_orig_mov.movement_id,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted_mov;

  select m.*
    into v_orig_mov
    from public.vendor_finance_shared_advance_movements m
   where m.movement_id = v_orig_mov.movement_id;

  if v_has_orig_entry then
    select e.*
      into v_orig_entry
      from public.vendor_finance_entries e
     where e.entry_id = v_orig_entry.entry_id;
  end if;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_orig_mov.project_id,
    case when v_has_orig_entry then v_inserted_entry.entry_id else null end,
    p_app_user_id,
    v_authority_source,
    'SHARED_ADVANCE_MOVEMENT_REVERSED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted_mov.movement_id,
      'document_no', v_inserted_mov.document_no,
      'reverses_movement_id', v_orig_mov.movement_id,
      'reverses_document_no', v_orig_mov.document_no,
      'amount_minor', v_inserted_mov.amount_minor::text,
      'balance_before_minor', v_inserted_mov.balance_before_minor::text,
      'balance_delta_minor', v_inserted_mov.balance_delta_minor::text,
      'balance_after_minor', v_inserted_mov.balance_after_minor::text,
      'effective_date', v_inserted_mov.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'reversal_movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted_mov, v_auth),
    'reversed_movement', public.vendor_finance__internal_shared_advance_movement_projection(v_orig_mov, v_auth),
    'shared_advance_balance_minor', v_inserted_mov.balance_after_minor::text
  );

  if v_has_orig_entry then
    v_base_payload := v_base_payload || pg_catalog.jsonb_build_object(
      'reversal_entry', public.vendor_finance__internal_entry_projection(v_inserted_entry, v_auth),
      'reversed_entry', public.vendor_finance__internal_entry_projection(v_orig_entry, v_auth)
    );
  end if;

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'REVERSE_SHARED_ADVANCE_MOVEMENT',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;


-- -----------------------------------------------------------------------------
-- 7. Monthly Report RPC with Separate Advance Offset (`advance_offset_in_month_minor`)
-- -----------------------------------------------------------------------------
create or replace function public.vendor_finance_get_monthly_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_month text,
  p_project_id text default null,
  p_accountant_user_id uuid default null,
  p_vendor_id text default null,
  p_contract_type text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_vis text;
  v_today date;
  v_month_start date;
  v_month_end date;
  v_totals jsonb;
  v_project_summaries jsonb;
  v_rows jsonb;
  v_legacy_rows jsonb := '[]'::jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
  v_vis := v_auth->>'visibility_scope';
  v_today := (v_auth->>'authorization_date')::date;

  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_contract_type is null or p_contract_type not in ('all', 'SEASONAL', 'OFFICIAL', 'UNCLASSIFIED') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := pg_catalog.to_date(p_month || '-01', 'YYYY-MM-DD');
  if pg_catalog.date_part('year', v_month_start)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;
  v_month_end := (v_month_start + interval '1 month')::date;

  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if p_vendor_id is not null and (
    p_vendor_id = '__system_vendor__'
    or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
  ) then
    raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
      using errcode = '22023';
  end if;

  if v_vis = 'PROJECT_SCOPED' then
    if p_accountant_user_id is not null and p_accountant_user_id <> p_app_user_id then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    if p_project_id is not null and not exists (
      select 1
        from public.vendor_finance_project_accountants pa
       where pa.project_id = p_project_id
         and pa.accountant_user_id = p_app_user_id
         and pa.valid_from <= v_today
         and (pa.valid_to is null or pa.valid_to > v_today)
         and (pa.valid_to is null or pa.valid_to > pa.valid_from)
      union all
      select 1
        from public.vendor_finance_entries e
       where e.ledger_scope = 'PROJECT_ACCOUNTANT'
         and e.project_id = p_project_id
         and e.responsible_accountant_user_id = p_app_user_id
      union all
      select 1
        from public.vendor_finance_reconciliations r
       where r.ledger_scope = 'PROJECT_ACCOUNTANT'
         and r.project_id = p_project_id
         and r.responsible_accountant_user_id = p_app_user_id
    ) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
  end if;

  with active_assignments as (
    select pa.project_id,
           pa.accountant_user_id
      from public.vendor_finance_project_accountants pa
     where pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
  ),
  candidate_books as (
    select distinct
           src.project_id,
           src.accountant_user_id,
           src.vendor_id,
           src.contract_type
      from (
        select e.project_id,
               e.responsible_accountant_user_id as accountant_user_id,
               e.vendor_id,
               e.contract_type
          from public.vendor_finance_entries e
         where e.ledger_scope = 'PROJECT_ACCOUNTANT'
        union
        select r.project_id,
               r.responsible_accountant_user_id as accountant_user_id,
               r.vendor_id,
               r.contract_type
          from public.vendor_finance_reconciliations r
         where r.ledger_scope = 'PROJECT_ACCOUNTANT'
      ) src
     where (v_vis = 'ALL' or src.accountant_user_id = p_app_user_id)
       and (p_project_id is null or src.project_id = p_project_id)
       and (p_accountant_user_id is null or src.accountant_user_id = p_accountant_user_id)
       and (p_vendor_id is null or src.vendor_id = p_vendor_id)
       and (p_contract_type = 'all' or src.contract_type = p_contract_type)
  ),
  entry_flags as (
    select e.*,
           exists (
             select 1
               from public.vendor_finance_entries rev
              where rev.reverses_entry_id = e.entry_id
           ) as is_reversed
      from public.vendor_finance_entries e
     where e.ledger_scope = 'PROJECT_ACCOUNTANT'
       and (v_vis = 'ALL' or e.responsible_accountant_user_id = p_app_user_id)
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_accountant_user_id is null or e.responsible_accountant_user_id = p_accountant_user_id)
       and (p_vendor_id is null or e.vendor_id = p_vendor_id)
       and (p_contract_type = 'all' or e.contract_type = p_contract_type)
  ),
  book_metrics as (
    select cb.project_id,
           p.display_name as project_display_name,
           p.active as project_active,
           cb.accountant_user_id,
           public.vendor_finance__internal_actor_display_name(cb.accountant_user_id) as accountant_display_name,
           coalesce(aa.accountant_user_id = cb.accountant_user_id, false) as is_currently_assigned,
           cb.vendor_id,
           v.display_name as vendor_display_name,
           v.active as vendor_active,
           cb.contract_type,
           coalesce(sum(ef.balance_delta_minor::numeric) filter (where ef.effective_date < v_month_start), 0::numeric) as before_month_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'OPENING_PAYABLE'
               and not ef.is_reversed
           ), 0::numeric) as opening_payable_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'OPENING_ADVANCE'
               and not ef.is_reversed
           ), 0::numeric) as opening_advance_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type in ('DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE')
               and not ef.is_reversed
           ), 0::numeric) as obligations_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type in ('PAYMENT_RECORDED', 'ADJUSTMENT_DECREASE')
               and not ef.is_reversed
           ), 0::numeric) as paid_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'ADVANCE_RECORDED'
               and not ef.is_reversed
           ), 0::numeric) as advanced_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'ADVANCE_OFFSET_RECORDED'
               and not ef.is_reversed
           ), 0::numeric) as advance_offset_num,
           coalesce(sum(ef.balance_delta_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
           ), 0::numeric) as net_change_num,
           coalesce(sum(ef.balance_delta_minor::numeric) filter (
             where ef.effective_date < v_month_end
           ), 0::numeric) as closing_num,
           coalesce(sum(ef.balance_delta_minor::numeric), 0::numeric) as current_num,
           count(ef.entry_id) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
           )::integer as in_month_entry_count,
           count(ef.entry_id)::integer as total_entry_count
      from candidate_books cb
      join public.direct_entry_projects p on p.project_id = cb.project_id
      join public.vendors v on v.vendor_id = cb.vendor_id
      left join active_assignments aa on aa.project_id = cb.project_id
      left join entry_flags ef
        on ef.project_id = cb.project_id
       and ef.responsible_accountant_user_id = cb.accountant_user_id
       and ef.vendor_id = cb.vendor_id
       and ef.contract_type = cb.contract_type
     group by cb.project_id, p.display_name, p.active,
              cb.accountant_user_id, aa.accountant_user_id,
              cb.vendor_id, v.display_name, v.active,
              cb.contract_type
  ),
  book_metrics_enriched as (
    select bm.*,
           (bm.paid_num + bm.advanced_num) as paid_and_advanced_num,
           greatest(bm.closing_num, 0::numeric) as closing_payable_num,
           greatest(-bm.closing_num, 0::numeric) as closing_advance_num
      from book_metrics bm
  ),
  pa_groups as (
    select bme.project_id,
           bme.project_display_name,
           bme.project_active,
           bme.accountant_user_id,
           bme.accountant_display_name,
           bme.is_currently_assigned,
           bme.contract_type,
           count(*)::integer as vendor_count,
           coalesce(sum(bme.obligations_num), 0::numeric) as obligations_num,
           coalesce(sum(bme.paid_num), 0::numeric) as paid_num,
           coalesce(sum(bme.advanced_num), 0::numeric) as advanced_num,
           coalesce(sum(bme.advance_offset_num), 0::numeric) as advance_offset_num,
           coalesce(sum(bme.paid_and_advanced_num), 0::numeric) as paid_and_advanced_num,
           coalesce(sum(bme.closing_payable_num), 0::numeric) as closing_payable_num,
           coalesce(sum(bme.closing_advance_num), 0::numeric) as closing_advance_num,
           coalesce(sum(bme.in_month_entry_count), 0)::integer as in_month_entry_count
      from book_metrics_enriched bme
     group by bme.project_id, bme.project_display_name, bme.project_active,
              bme.accountant_user_id, bme.accountant_display_name, bme.is_currently_assigned,
              bme.contract_type
  )
  select pg_catalog.jsonb_build_object(
           'project_revenue_status', 'MISSING_CANONICAL_SOURCE',
           'project_revenue_minor', null,
           'project_accountant_book_count', (select count(*)::integer from pa_groups),
           'sub_ledger_count', (select count(*)::integer from book_metrics_enriched),
           'obligations_in_month_minor', pg_catalog.trunc(coalesce((select sum(obligations_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'paid_in_month_minor', pg_catalog.trunc(coalesce((select sum(paid_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'advanced_in_month_minor', pg_catalog.trunc(coalesce((select sum(advanced_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'advance_offset_in_month_minor', pg_catalog.trunc(coalesce((select sum(advance_offset_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'paid_and_advanced_in_month_minor', pg_catalog.trunc(coalesce((select sum(paid_and_advanced_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'closing_payable_minor', pg_catalog.trunc(coalesce((select sum(closing_payable_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'closing_advance_minor', pg_catalog.trunc(coalesce((select sum(closing_advance_num) from book_metrics_enriched), 0::numeric), 0)::text
         ),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'project_id', pg.project_id,
                        'project_display_name', pg.project_display_name,
                        'project_active', pg.project_active,
                        'accountant_ref', pg.accountant_user_id,
                        'responsible_accountant_display_name', pg.accountant_display_name,
                        'is_currently_assigned', pg.is_currently_assigned,
                        'contract_type', pg.contract_type,
                        'project_revenue_status', 'MISSING_CANONICAL_SOURCE',
                        'project_revenue_minor', null,
                        'vendor_count', pg.vendor_count,
                        'obligations_in_month_minor', pg_catalog.trunc(pg.obligations_num, 0)::text,
                        'paid_in_month_minor', pg_catalog.trunc(pg.paid_num, 0)::text,
                        'advanced_in_month_minor', pg_catalog.trunc(pg.advanced_num, 0)::text,
                        'advance_offset_in_month_minor', pg_catalog.trunc(pg.advance_offset_num, 0)::text,
                        'paid_and_advanced_in_month_minor', pg_catalog.trunc(pg.paid_and_advanced_num, 0)::text,
                        'closing_payable_minor', pg_catalog.trunc(pg.closing_payable_num, 0)::text,
                        'closing_advance_minor', pg_catalog.trunc(pg.closing_advance_num, 0)::text,
                        'in_month_entry_count', pg.in_month_entry_count
                      )
                      order by
                        (not pg.is_currently_assigned) asc,
                        pg_catalog.lower(pg.project_display_name) asc,
                        pg.project_id asc,
                        pg_catalog.lower(pg.accountant_display_name) asc,
                        case pg.contract_type
                          when 'SEASONAL' then 1
                          when 'OFFICIAL' then 2
                          else 3
                        end asc
                    )
               from pa_groups pg
           ),
           '[]'::jsonb
         ),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'project_id', r.project_id,
                        'project_display_name', r.project_display_name,
                        'project_active', r.project_active,
                        'accountant_ref', r.accountant_user_id,
                        'responsible_accountant_display_name', r.accountant_display_name,
                        'is_currently_assigned', r.is_currently_assigned,
                        'vendor_id', r.vendor_id,
                        'vendor_display_name', r.vendor_display_name,
                        'vendor_active', r.vendor_active,
                        'contract_type', r.contract_type,
                        'project_revenue_status', 'MISSING_CANONICAL_SOURCE',
                        'project_revenue_minor', null,
                        'balance_before_month_minor', pg_catalog.trunc(r.before_month_num, 0)::text,
                        'opening_payable_in_month_minor', pg_catalog.trunc(r.opening_payable_num, 0)::text,
                        'opening_advance_in_month_minor', pg_catalog.trunc(r.opening_advance_num, 0)::text,
                        'obligations_in_month_minor', pg_catalog.trunc(r.obligations_num, 0)::text,
                        'paid_in_month_minor', pg_catalog.trunc(r.paid_num, 0)::text,
                        'advanced_in_month_minor', pg_catalog.trunc(r.advanced_num, 0)::text,
                        'advance_offset_in_month_minor', pg_catalog.trunc(r.advance_offset_num, 0)::text,
                        'paid_and_advanced_in_month_minor', pg_catalog.trunc(r.paid_and_advanced_num, 0)::text,
                        'net_change_in_month_minor', pg_catalog.trunc(r.net_change_num, 0)::text,
                        'closing_balance_minor', pg_catalog.trunc(r.closing_num, 0)::text,
                        'closing_direction', case
                          when r.closing_num > 0 then 'PAYABLE'
                          when r.closing_num < 0 then 'ADVANCE'
                          else 'BALANCED'
                        end,
                        'closing_payable_minor', pg_catalog.trunc(r.closing_payable_num, 0)::text,
                        'closing_advance_minor', pg_catalog.trunc(r.closing_advance_num, 0)::text,
                        'current_balance_minor', pg_catalog.trunc(r.current_num, 0)::text,
                        'in_month_entry_count', r.in_month_entry_count,
                        'total_entry_count', r.total_entry_count
                      )
                      order by
                        (not r.is_currently_assigned) asc,
                        pg_catalog.lower(r.project_display_name) asc,
                        r.project_id asc,
                        pg_catalog.lower(r.accountant_display_name) asc,
                        case r.contract_type
                          when 'SEASONAL' then 1
                          when 'OFFICIAL' then 2
                          else 3
                        end asc,
                        pg_catalog.abs(r.closing_num) desc,
                        pg_catalog.lower(r.vendor_display_name) asc,
                        r.vendor_id asc
                    )
               from book_metrics_enriched r
           ),
           '[]'::jsonb
         )
    into v_totals, v_project_summaries, v_rows;

  if v_vis = 'ALL'
     and p_project_id is null
     and p_accountant_user_id is null
     and p_contract_type in ('all', 'UNCLASSIFIED') then
    with legacy_flags as (
      select e.*,
             exists (
               select 1
                 from public.vendor_finance_entries rev
                where rev.reverses_entry_id = e.entry_id
             ) as is_reversed
        from public.vendor_finance_entries e
       where e.ledger_scope = 'LEGACY_UNALLOCATED'
         and (p_vendor_id is null or e.vendor_id = p_vendor_id)
    ),
    legacy_books as (
      select lf.vendor_id,
             v.display_name as vendor_display_name,
             v.active as vendor_active,
             coalesce(sum(lf.balance_delta_minor::numeric) filter (where lf.effective_date < v_month_start), 0::numeric) as before_month_num,
             coalesce(sum(lf.amount_minor::numeric) filter (
               where lf.effective_date >= v_month_start
                 and lf.effective_date < v_month_end
                 and lf.entry_type in ('DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE')
                 and not lf.is_reversed
             ), 0::numeric) as obligations_num,
             coalesce(sum(lf.amount_minor::numeric) filter (
               where lf.effective_date >= v_month_start
                 and lf.effective_date < v_month_end
                 and lf.entry_type in ('PAYMENT_RECORDED', 'ADVANCE_RECORDED', 'ADJUSTMENT_DECREASE')
                 and not lf.is_reversed
             ), 0::numeric) as paid_and_advanced_num,
             coalesce(sum(lf.balance_delta_minor::numeric) filter (where lf.effective_date < v_month_end), 0::numeric) as closing_num,
             count(*) filter (where lf.effective_date >= v_month_start and lf.effective_date < v_month_end)::integer as in_month_entry_count
        from legacy_flags lf
        join public.vendors v on v.vendor_id = lf.vendor_id
       group by lf.vendor_id, v.display_name, v.active
    )
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'vendor_id', lb.vendor_id,
                 'vendor_display_name', lb.vendor_display_name,
                 'vendor_active', lb.vendor_active,
                 'balance_before_month_minor', pg_catalog.trunc(lb.before_month_num, 0)::text,
                 'obligations_in_month_minor', pg_catalog.trunc(lb.obligations_num, 0)::text,
                 'paid_and_advanced_in_month_minor', pg_catalog.trunc(lb.paid_and_advanced_num, 0)::text,
                 'closing_balance_minor', pg_catalog.trunc(lb.closing_num, 0)::text,
                 'closing_direction', case
                   when lb.closing_num > 0 then 'PAYABLE'
                   when lb.closing_num < 0 then 'ADVANCE'
                   else 'BALANCED'
                 end,
                 'in_month_entry_count', lb.in_month_entry_count
               )
               order by pg_catalog.abs(lb.closing_num) desc, pg_catalog.lower(lb.vendor_display_name) asc, lb.vendor_id asc
             ),
             '[]'::jsonb
           )
      into v_legacy_rows
      from legacy_books lb;
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'allowed_actions', pg_catalog.jsonb_build_object(
      'visibility_scope', v_vis,
      'can_view', true,
      'can_record', coalesce((v_auth->>'can_record')::boolean, false),
      'can_reconcile', coalesce((v_auth->>'can_reconcile')::boolean, false),
      'can_manage_project_assignments', coalesce((v_auth->>'can_manage_project_assignments')::boolean, false),
      'can_view_shared_advance', coalesce((v_auth->>'can_view_shared_advance')::boolean, false),
      'can_fund_vendor_advance', coalesce((v_auth->>'can_fund_vendor_advance')::boolean, false),
      'can_record_vendor_refund', coalesce((v_auth->>'can_record_vendor_refund')::boolean, false),
      'can_apply_vendor_advance', coalesce((v_auth->>'can_apply_vendor_advance')::boolean, false),
      'active_assigned_project_count', coalesce((v_auth->>'active_assigned_project_count')::integer, 0)
    ),
    'filters', pg_catalog.jsonb_build_object(
      'month', p_month,
      'project_id', p_project_id,
      'accountant_ref', p_accountant_user_id,
      'vendor_id', p_vendor_id,
      'contract_type', p_contract_type
    ),
    'totals', v_totals,
    'project_accountant_summaries', v_project_summaries,
    'rows', v_rows,
    'legacy_unallocated_rows', v_legacy_rows
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 8. Owner alignment & helper EXECUTE privileges (`s0_t1c_runner` & `postgres` safe).
-- -----------------------------------------------------------------------------
do $align_vfin_04_owners$
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
    'public.vendor_finance_audit_events',
    'public.vendor_finance_project_accountants',
    'public.vendor_finance_project_vendors',
    'public.vendor_finance_global_roles',
    'public.vendor_finance_subledger_classifications',
    'public.vendor_finance_shared_advance_movements'
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
    'public.vendor_finance__internal_classification_insert_guard()',
    'public.vendor_finance__internal_project_accountant_guard()',
    'public.vendor_finance__internal_project_vendor_guard()',
    'public.vendor_finance__internal_global_role_guard()',
    'public.vendor_finance__internal_entry_integrity_guard()',
    'public.vendor_finance__internal_shared_advance_integrity_guard()',
    'public.vendor_finance__internal_evidence_lifecycle_guard()',
    'public.vendor_finance__internal_mark_evidence_cleaned_for_reset(uuid)',
    'public.vendor_finance__internal_reset_transactional_ledgers(boolean)',
    'public.vendor_finance__internal_document_kind(text)',
    'public.vendor_finance__internal_document_title_vi(text)',
    'public.vendor_finance__internal_shared_advance_document_kind(text)',
    'public.vendor_finance__internal_shared_advance_document_title_vi(text)',
    'public.vendor_finance__internal_lock_project(text)',
    'public.vendor_finance__internal_resolve_authority(uuid, uuid)',
    'public.vendor_finance__internal_assert_authority(uuid, uuid, text)',
    'public.vendor_finance__internal_resolve_active_project_accountant(text, date)',
    'public.vendor_finance__internal_can_actor_write_subledger(jsonb, uuid, text, text, text, uuid)',
    'public.vendor_finance__internal_entry_projection(public.vendor_finance_entries, jsonb)',
    'public.vendor_finance__internal_shared_advance_movement_projection(public.vendor_finance_shared_advance_movements, jsonb)',
    'public.vendor_finance__internal_reconciliation_projection(public.vendor_finance_reconciliations, jsonb)',
    'public.vendor_finance__internal_classification_projection(text, text, uuid, text)',
    'public.vendor_finance_get_actor_access(uuid, uuid)',
    'public.vendor_finance_list_actor_context_options(uuid, uuid)',
    'public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, text, integer, integer)',
    'public.vendor_finance_export_vendors(uuid, uuid, text, text, text, text, uuid, text, text)',
    'public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)',
    'public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)',
    'public.vendor_finance_list_shared_advance_movements(uuid, uuid, text, bigint, text, integer)',
    'public.vendor_finance_get_entry(uuid, uuid, uuid)',
    'public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text, text)',
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_fund_shared_advance(uuid, uuid, text, text, date, text, uuid, text)',
    'public.vendor_finance_record_vendor_refund(uuid, uuid, text, text, date, text, uuid, text)',
    'public.vendor_finance_apply_shared_advance_offset(uuid, uuid, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)',
    'public.vendor_finance_reverse_shared_advance_movement(uuid, uuid, uuid, date, text, uuid, text)',
    'public.vendor_finance_preview_opening_batch(uuid, uuid, text, text, date, jsonb)',
    'public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)',
    'public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)',
    'public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)',
    'public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)',
    'public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)',
    'public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)',
    'public.vendor_finance_get_evidence_download(uuid, uuid, uuid)',
    'public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)',
    'public.vendor_finance_list_project_accountants_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text)',
    'public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.vendor_finance_list_global_roles_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text)',
    'public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text)'
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
      'grant execute on function public.direct_entry_assert_actor_app_user_admin(uuid, uuid) to %I',
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
    execute pg_catalog.format(
      'grant execute on function public.org_department__internal_account_summary(uuid) to %I',
      v_owner
    );
  end loop;
end;
$align_vfin_04_owners$;

-- -----------------------------------------------------------------------------
-- 9. Strict table & function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on table public.vendor_finance_shared_advance_movements
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_immutable_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_classification_insert_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_entry_integrity_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_shared_advance_integrity_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_evidence_lifecycle_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_mark_evidence_cleaned_for_reset(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_reset_transactional_ledgers(boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_document_kind(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_document_title_vi(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_shared_advance_document_kind(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_shared_advance_document_title_vi(text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_resolve_authority(uuid, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_assert_authority(uuid, uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_entry_projection(public.vendor_finance_entries, jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_shared_advance_movement_projection(public.vendor_finance_shared_advance_movements, jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_reconciliation_projection(public.vendor_finance_reconciliations, jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_classification_projection(text, text, uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance_get_actor_access(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_actor_access(uuid, uuid)
  to service_role;

revoke all on function public.vendor_finance_list_actor_context_options(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_actor_context_options(uuid, uuid)
  to service_role;

revoke all on function public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, text, integer, integer)
  to service_role;

revoke all on function public.vendor_finance_export_vendors(uuid, uuid, text, text, text, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_export_vendors(uuid, uuid, text, text, text, text, uuid, text, text)
  to service_role;

revoke all on function public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)
  to service_role;

revoke all on function public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)
  to service_role;

revoke all on function public.vendor_finance_list_shared_advance_movements(uuid, uuid, text, bigint, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_shared_advance_movements(uuid, uuid, text, bigint, text, integer)
  to service_role;

revoke all on function public.vendor_finance_get_entry(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_entry(uuid, uuid, uuid)
  to service_role;

revoke all on function public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text, text)
  to service_role;

revoke all on function public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_fund_shared_advance(uuid, uuid, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_fund_shared_advance(uuid, uuid, text, text, date, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_record_vendor_refund(uuid, uuid, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_record_vendor_refund(uuid, uuid, text, text, date, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_apply_shared_advance_offset(uuid, uuid, text, text, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_apply_shared_advance_offset(uuid, uuid, text, text, text, text, date, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_reverse_shared_advance_movement(uuid, uuid, uuid, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_reverse_shared_advance_movement(uuid, uuid, uuid, date, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_preview_opening_batch(uuid, uuid, text, text, date, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_preview_opening_batch(uuid, uuid, text, text, date, jsonb)
  to service_role;

revoke all on function public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 10. Data-free install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $check_vfin_04$
declare
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
  v_overload_count integer;
begin
  foreach v_tbl in array array[
    'public.vendor_finance_document_counters'::pg_catalog.regclass,
    'public.vendor_finance_opening_batches'::pg_catalog.regclass,
    'public.vendor_finance_entries'::pg_catalog.regclass,
    'public.vendor_finance_reconciliations'::pg_catalog.regclass,
    'public.vendor_finance_evidence'::pg_catalog.regclass,
    'public.vendor_finance_idempotency'::pg_catalog.regclass,
    'public.vendor_finance_audit_events'::pg_catalog.regclass,
    'public.vendor_finance_project_accountants'::pg_catalog.regclass,
    'public.vendor_finance_project_vendors'::pg_catalog.regclass,
    'public.vendor_finance_global_roles'::pg_catalog.regclass,
    'public.vendor_finance_subledger_classifications'::pg_catalog.regclass,
    'public.vendor_finance_shared_advance_movements'::pg_catalog.regclass
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
      raise exception 'VFIN-04 table RLS/ACL boundary drift on %', v_tbl
        using errcode = '55000';
    end if;
  end loop;

  foreach v_internal_fn in array array[
    'public.vendor_finance__internal_immutable_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_classification_insert_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_project_accountant_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_project_vendor_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_global_role_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_entry_integrity_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_shared_advance_integrity_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_evidence_lifecycle_guard()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_mark_evidence_cleaned_for_reset(uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_reset_transactional_ledgers(boolean)'::pg_catalog.regprocedure,
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
    'public.vendor_finance__internal_shared_advance_document_kind(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_shared_advance_document_title_vi(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_disclaimer_vi()'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_lock_vendor(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_lock_project(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_resolve_authority(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_assert_authority(uuid, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_resolve_active_project_accountant(text, date)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_can_actor_write_subledger(jsonb, uuid, text, text, text, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_evidence_projection(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_entry_projection(public.vendor_finance_entries, jsonb)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_shared_advance_movement_projection(public.vendor_finance_shared_advance_movements, jsonb)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_reconciliation_projection(public.vendor_finance_reconciliations, jsonb)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_classification_projection(text, text, uuid, text)'::pg_catalog.regprocedure
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
      raise exception 'VFIN-04 internal routine security definer/owner/search_path drift on %', v_internal_fn
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
      raise exception 'VFIN-04 internal routine must stay revoked from all runtime roles: %', v_internal_fn
        using errcode = '55000';
    end if;
  end loop;

  foreach v_rpc_fn in array array[
    'public.vendor_finance_get_actor_access(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_actor_context_options(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, text, integer, integer)'::pg_catalog.regprocedure,
    'public.vendor_finance_export_vendors(uuid, uuid, text, text, text, text, uuid, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_shared_advance_movements(uuid, uuid, text, bigint, text, integer)'::pg_catalog.regprocedure,
    'public.vendor_finance_get_entry(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_fund_shared_advance(uuid, uuid, text, text, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_record_vendor_refund(uuid, uuid, text, text, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_apply_shared_advance_offset(uuid, uuid, text, text, text, text, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_reverse_shared_advance_movement(uuid, uuid, uuid, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_preview_opening_batch(uuid, uuid, text, text, date, jsonb)'::pg_catalog.regprocedure,
    'public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_get_evidence_download(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_project_accountants_admin(uuid, uuid, text, boolean, integer, integer)'::pg_catalog.regprocedure,
    'public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_global_roles_admin(uuid, uuid, text, boolean, integer, integer)'::pg_catalog.regprocedure,
    'public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text)'::pg_catalog.regprocedure
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
      raise exception 'VFIN-04 RPC security definer owner/RLS/search_path drift on %', v_rpc_fn
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
      raise exception 'VFIN-04 RPC EXECUTE ACL drift on %', v_rpc_fn
        using errcode = '55000';
    end if;
  end loop;

  select count(*)::integer
    into v_overload_count
    from (
      select p.proname
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname like 'vendor_finance_%'
       group by p.proname
      having count(*) > 1
    ) d;

  if coalesce(v_overload_count, 0) <> 0 then
    raise exception 'VFIN-04 overloaded vendor_finance_* functions detected (% names)', v_overload_count
      using errcode = '55000';
  end if;
end;
$check_vfin_04$;

commit;
