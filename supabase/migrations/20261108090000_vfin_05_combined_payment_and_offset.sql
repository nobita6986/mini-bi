-- =============================================================================
-- Migration: 20261108090000_vfin_05_combined_payment_and_offset.sql
-- Scope:
--   1. Enforce sub-ledger payable ceiling on `PAYMENT_RECORDED` in
--      `public.vendor_finance_record_entry(...)` (`amount_minor <= balance_after_minor`,
--      raising `23514 VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE`), while
--      leaving `ADJUSTMENT_DECREASE` unchanged.
--   2. Add atomic combined settlement RPC
--      `public.vendor_finance_record_payment_with_offset(...)` that locks the
--      project and vendor in canonical order, validates `payment + offset <= payable`
--      and `offset <= shared_advance`, and atomically records:
--        - `PAYMENT_RECORDED` in `public.vendor_finance_entries`
--        - `ADVANCE_OFFSET_RECORDED` in `public.vendor_finance_entries`
--        - `PROJECT_OFFSET_APPLIED` in `public.vendor_finance_shared_advance_movements`
--   3. Preserve strict SECURITY DEFINER ownership, search_path, and `service_role`-only
--      EXECUTE ACL across all `vendor_finance_*` routines.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Extend idempotency action check for combined payment + offset.
-- -----------------------------------------------------------------------------
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
      'RECORD_PAYMENT_WITH_OFFSET',
      'REVERSE_SHARED_ADVANCE_MOVEMENT'
    )
  );

-- -----------------------------------------------------------------------------
-- 2. Enforce payable ceiling on `PAYMENT_RECORDED` in `vendor_finance_record_entry`.
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

  -- Project sub-ledgers cannot record ADVANCE_RECORDED; all new advances use shared vendor advances.
  if p_entry_type = 'ADVANCE_RECORDED' then
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

  if p_entry_type = 'PAYMENT_RECORDED'
     and (v_prev_balance <= 0 or v_amount > v_prev_balance) then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE'
      using errcode = '23514';
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

-- -----------------------------------------------------------------------------
-- 3. Atomic combined payment + shared advance offset RPC.
-- -----------------------------------------------------------------------------
create or replace function public.vendor_finance_record_payment_with_offset(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_contract_type text,
  p_payment_amount_minor text,
  p_offset_amount_minor text,
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
  v_payment_amount bigint;
  v_offset_amount bigint;
  v_total_settlement bigint;
  v_payment_delta bigint;
  v_offset_delta bigint;
  v_reason text;
  v_actor_name text;
  v_shared_prev_seq bigint;
  v_shared_prev_balance bigint;
  v_shared_next_seq bigint;
  v_shared_after_balance bigint;
  v_sub_prev_seq bigint;
  v_sub_prev_balance bigint;
  v_payment_seq bigint;
  v_after_payment_balance bigint;
  v_offset_seq bigint;
  v_after_offset_balance bigint;
  v_payment_doc_no text;
  v_offset_entry_doc_no text;
  v_mov_doc_no text;
  v_offset_entry_idem_key uuid;
  v_payment_entry public.vendor_finance_entries%rowtype;
  v_offset_entry public.vendor_finance_entries%rowtype;
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
    if v_existing_idem.action <> 'RECORD_PAYMENT_WITH_OFFSET'
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

  v_payment_amount := public.vendor_finance__internal_parse_positive_minor(p_payment_amount_minor);
  v_offset_amount := public.vendor_finance__internal_parse_positive_minor(p_offset_amount_minor);
  v_total_settlement := public.vendor_finance__internal_checked_add_minor(v_payment_amount, v_offset_amount);
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

  if v_sub_prev_balance <= 0 or v_total_settlement > v_sub_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE'
      using errcode = '23514';
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

  if v_shared_prev_balance <= 0 or v_offset_amount > v_shared_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE'
      using errcode = '23514';
  end if;

  v_payment_delta := -v_payment_amount;
  v_offset_delta := -v_offset_amount;

  v_payment_seq := v_sub_prev_seq + 1;
  v_after_payment_balance := public.vendor_finance__internal_checked_add_minor(
    v_sub_prev_balance,
    v_payment_delta
  );

  v_offset_seq := v_sub_prev_seq + 2;
  v_after_offset_balance := public.vendor_finance__internal_checked_add_minor(
    v_after_payment_balance,
    v_offset_delta
  );

  v_shared_next_seq := v_shared_prev_seq + 1;
  v_shared_after_balance := public.vendor_finance__internal_checked_add_minor(
    v_shared_prev_balance,
    v_offset_delta
  );

  v_payment_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);
  v_offset_entry_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);
  v_mov_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  v_offset_entry_idem_key := pg_catalog.md5('vfin_05_offset_entry:' || p_idempotency_key::text)::uuid;
  if v_offset_entry_idem_key = p_idempotency_key then
    v_offset_entry_idem_key := pg_catalog.md5('vfin_05_offset_entry_alt:' || p_idempotency_key::text)::uuid;
  end if;

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
    v_payment_seq,
    'PAYMENT_RECORDED',
    v_payment_amount,
    v_payment_delta,
    v_sub_prev_balance,
    v_after_payment_balance,
    p_effective_date,
    v_reason,
    v_payment_doc_no,
    v_vendor.display_name,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_payment_entry;

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
    v_offset_seq,
    'ADVANCE_OFFSET_RECORDED',
    v_offset_amount,
    v_offset_delta,
    v_after_payment_balance,
    v_after_offset_balance,
    p_effective_date,
    v_reason,
    v_offset_entry_doc_no,
    v_vendor.display_name,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    v_offset_entry_idem_key,
    p_request_fingerprint
  )
  returning * into v_offset_entry;

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
    v_offset_amount,
    v_offset_delta,
    v_shared_prev_balance,
    v_shared_after_balance,
    p_effective_date,
    v_reason,
    v_mov_doc_no,
    v_offset_entry.entry_id,
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
    v_payment_entry.entry_id,
    p_app_user_id,
    v_authority_source,
    'ENTRY_RECORDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'document_no', v_payment_entry.document_no,
      'project_id', v_payment_entry.project_id,
      'responsible_accountant_user_id', v_payment_entry.responsible_accountant_user_id,
      'contract_type', v_payment_entry.contract_type,
      'entry_type', v_payment_entry.entry_type,
      'amount_minor', v_payment_entry.amount_minor::text,
      'balance_before_minor', v_payment_entry.balance_before_minor::text,
      'balance_delta_minor', v_payment_entry.balance_delta_minor::text,
      'balance_after_minor', v_payment_entry.balance_after_minor::text,
      'effective_date', v_payment_entry.effective_date::text
    ),
    p_idempotency_key
  );

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    shared_advance_movement_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_offset_entry.entry_id,
    v_inserted_mov.movement_id,
    p_app_user_id,
    v_authority_source,
    'SHARED_ADVANCE_OFFSET_APPLIED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted_mov.movement_id,
      'movement_document_no', v_inserted_mov.document_no,
      'entry_id', v_offset_entry.entry_id,
      'entry_document_no', v_offset_entry.document_no,
      'project_id', v_offset_entry.project_id,
      'responsible_accountant_user_id', v_offset_entry.responsible_accountant_user_id,
      'contract_type', v_offset_entry.contract_type,
      'amount_minor', v_offset_entry.amount_minor::text,
      'subledger_balance_before_minor', v_offset_entry.balance_before_minor::text,
      'subledger_balance_after_minor', v_offset_entry.balance_after_minor::text,
      'shared_advance_before_minor', v_inserted_mov.balance_before_minor::text,
      'shared_advance_after_minor', v_inserted_mov.balance_after_minor::text,
      'effective_date', v_offset_entry.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'payment_entry', public.vendor_finance__internal_entry_projection(v_payment_entry, v_auth),
    'offset_entry', public.vendor_finance__internal_entry_projection(v_offset_entry, v_auth),
    'movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted_mov, v_auth),
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
    'RECORD_PAYMENT_WITH_OFFSET',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Owner alignment & strict function ACLs (`service_role` only).
-- -----------------------------------------------------------------------------
do $align_vfin_05_owners$
declare
  v_base_owner name;
  v_base_owner_oid oid;
  v_sig text;
  v_proc_owner_oid oid;
  v_owner name;
begin
  select r.rolname, r.oid
    into v_base_owner, v_base_owner_oid
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where n.nspname = 'public'
     and c.relname = 'direct_entry_app_users';

  if v_base_owner is null then
    raise exception 'VFIN-05 prerequisite missing: public.direct_entry_app_users not found'
      using errcode = '55000';
  end if;

  foreach v_sig in array array[
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_record_payment_with_offset(uuid, uuid, text, text, text, text, text, date, text, uuid, text)'
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
$align_vfin_05_owners$;

revoke all on function public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  to service_role;

revoke all on function public.vendor_finance_record_payment_with_offset(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_record_payment_with_offset(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 5. Data-free install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $check_vfin_05$
declare
  v_rpc_fn pg_catalog.regprocedure;
  v_secdef boolean;
  v_config text;
  v_owner_bypasses_rls boolean;
  v_overload_count integer;
begin
  foreach v_rpc_fn in array array[
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_record_payment_with_offset(uuid, uuid, text, text, text, text, text, date, text, uuid, text)'::pg_catalog.regprocedure
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
      raise exception 'VFIN-05 RPC security definer owner/RLS/search_path drift on %', v_rpc_fn
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
      raise exception 'VFIN-05 RPC EXECUTE ACL drift on %', v_rpc_fn
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
    raise exception 'VFIN-05 overloaded vendor_finance_* functions detected (% names)', v_overload_count
      using errcode = '55000';
  end if;
end;
$check_vfin_05$;

commit;
