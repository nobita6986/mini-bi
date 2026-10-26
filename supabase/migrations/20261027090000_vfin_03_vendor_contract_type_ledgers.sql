-- =============================================================================
-- VFIN-03 — Vendor Finance Contract-Type Sub-Ledgers (`SEASONAL` / `OFFICIAL` / `UNCLASSIFIED`)
-- =============================================================================
-- Separates Vendor financial sub-ledgers by contract type (`SEASONAL` = Thời vụ,
-- `OFFICIAL` = Chính thức) within each `(vendor_id, project_id, responsible_accountant_user_id)`
-- scope while preserving pre-existing rows as `UNCLASSIFIED` (Chưa phân loại)
-- and enabling controlled, audited one-time classification of `UNCLASSIFIED`
-- project sub-ledgers into `SEASONAL` or `OFFICIAL`.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Drop replaced VFIN-02 function signatures to prevent PostgREST overloads.
-- -----------------------------------------------------------------------------
drop function if exists public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, integer, integer);
drop function if exists public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text);
drop function if exists public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text);
drop function if exists public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text);
drop function if exists public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, date, text, uuid, text);
drop function if exists public.vendor_finance_preview_opening_batch(uuid, uuid, text, date, jsonb);
drop function if exists public.vendor_finance_apply_opening_batch(uuid, uuid, text, date, jsonb, text, uuid, text);
drop function if exists public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, date, text, text, uuid, text);
drop function if exists public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text);

-- -----------------------------------------------------------------------------
-- 2. Extend schema with `contract_type` and classification audit table.
--    All pre-existing VFIN-01 / VFIN-02 rows default to `'UNCLASSIFIED'`
--    without automatic guessing.
-- -----------------------------------------------------------------------------
alter table public.vendor_finance_opening_batches
  add column if not exists contract_type text not null default 'UNCLASSIFIED';

alter table public.vendor_finance_opening_batches
  drop constraint if exists vendor_finance_opening_batches_contract_type_check;

alter table public.vendor_finance_opening_batches
  add constraint vendor_finance_opening_batches_contract_type_check check (
    contract_type in ('UNCLASSIFIED', 'SEASONAL', 'OFFICIAL')
    and (ledger_scope <> 'LEGACY_UNALLOCATED' or contract_type = 'UNCLASSIFIED')
  );

alter table public.vendor_finance_entries
  add column if not exists contract_type text not null default 'UNCLASSIFIED';

alter table public.vendor_finance_entries
  drop constraint if exists vendor_finance_entries_contract_type_check;

alter table public.vendor_finance_entries
  add constraint vendor_finance_entries_contract_type_check check (
    contract_type in ('UNCLASSIFIED', 'SEASONAL', 'OFFICIAL')
    and (ledger_scope <> 'LEGACY_UNALLOCATED' or contract_type = 'UNCLASSIFIED')
  );

drop index if exists public.vendor_finance_entries_project_acct_seq_uidx;
create unique index vendor_finance_entries_project_acct_seq_uidx
  on public.vendor_finance_entries (
    vendor_id,
    project_id,
    responsible_accountant_user_id,
    contract_type,
    vendor_sequence
  )
  where ledger_scope = 'PROJECT_ACCOUNTANT';

drop index if exists public.vendor_finance_entries_one_opening_project_acct_uidx;
create unique index vendor_finance_entries_one_opening_project_acct_uidx
  on public.vendor_finance_entries (
    vendor_id,
    project_id,
    responsible_accountant_user_id,
    contract_type
  )
  where ledger_scope = 'PROJECT_ACCOUNTANT'
    and entry_type in ('OPENING_PAYABLE', 'OPENING_ADVANCE');

create index if not exists vendor_finance_entries_project_acct_contract_idx
  on public.vendor_finance_entries (
    vendor_id,
    project_id,
    responsible_accountant_user_id,
    contract_type,
    ledger_cursor_seq desc
  )
  where ledger_scope = 'PROJECT_ACCOUNTANT';

alter table public.vendor_finance_reconciliations
  add column if not exists contract_type text not null default 'UNCLASSIFIED';

alter table public.vendor_finance_reconciliations
  drop constraint if exists vendor_finance_reconciliations_contract_type_check;

alter table public.vendor_finance_reconciliations
  add constraint vendor_finance_reconciliations_contract_type_check check (
    contract_type in ('UNCLASSIFIED', 'SEASONAL', 'OFFICIAL')
    and (ledger_scope <> 'LEGACY_UNALLOCATED' or contract_type = 'UNCLASSIFIED')
  );

drop index if exists public.vendor_finance_reconciliations_subledger_date_idx;
create index vendor_finance_reconciliations_subledger_date_idx
  on public.vendor_finance_reconciliations (
    vendor_id,
    project_id,
    responsible_accountant_user_id,
    contract_type,
    as_of_date desc,
    created_at desc
  )
  where ledger_scope = 'PROJECT_ACCOUNTANT';

create table if not exists public.vendor_finance_subledger_classifications (
  classification_id uuid primary key default gen_random_uuid(),
  vendor_id text not null references public.vendors(vendor_id) on delete restrict,
  project_id text not null references public.direct_entry_projects(project_id) on delete restrict,
  responsible_accountant_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  source_contract_type text not null default 'UNCLASSIFIED' check (source_contract_type = 'UNCLASSIFIED'),
  target_contract_type text not null check (target_contract_type in ('SEASONAL', 'OFFICIAL')),
  classified_entry_count integer not null check (classified_entry_count >= 1),
  classified_reconciliation_count integer not null default 0 check (classified_reconciliation_count >= 0),
  closing_balance_minor bigint not null,
  reason text not null check (
    pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 4000
    and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
  ),
  classified_by_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  classified_by_display_name_snapshot text not null check (
    pg_catalog.length(pg_catalog.btrim(classified_by_display_name_snapshot)) between 1 and 256
  ),
  idempotency_key uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  classified_at timestamptz not null default now(),
  constraint vendor_finance_subledger_classifications_subledger_key unique (
    vendor_id,
    project_id,
    responsible_accountant_user_id
  )
);

alter table public.vendor_finance_subledger_classifications enable row level security;
alter table public.vendor_finance_subledger_classifications force row level security;

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
      'CLASSIFY_SUBLEDGER_CONTRACT_TYPE'
    )
  );

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
      'SUBLEDGER_CONTRACT_TYPE_CLASSIFIED'
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Guards & Internal Projection Helpers
-- -----------------------------------------------------------------------------
create or replace function public.vendor_finance__internal_immutable_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'UPDATE'
     and coalesce(pg_catalog.current_setting('vendor_finance.classify_write_marker', true), '') = 'on'
     and tg_table_name in (
       'vendor_finance_entries',
       'vendor_finance_reconciliations',
       'vendor_finance_opening_batches'
     )
     and old.ledger_scope = 'PROJECT_ACCOUNTANT'
     and old.contract_type = 'UNCLASSIFIED'
     and new.contract_type in ('SEASONAL', 'OFFICIAL')
     and (pg_catalog.to_jsonb(new) - 'contract_type') = (pg_catalog.to_jsonb(old) - 'contract_type') then
    return new;
  end if;

  raise exception 'VENDOR_FINANCE_IMMUTABLE_RECORD: % is append-only', tg_table_name
    using errcode = '55000';
end;
$function$;

create or replace function public.vendor_finance__internal_classification_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if coalesce(pg_catalog.current_setting('vendor_finance.classify_write_marker', true), '') <> 'on' then
    raise exception 'VENDOR_FINANCE_DIRECT_WRITE_FORBIDDEN'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

drop trigger if exists vendor_finance_subledger_classifications_immutable
  on public.vendor_finance_subledger_classifications;
create trigger vendor_finance_subledger_classifications_immutable
  before update or delete on public.vendor_finance_subledger_classifications
  for each row execute function public.vendor_finance__internal_immutable_guard();

drop trigger if exists vendor_finance_subledger_classifications_insert_guard
  on public.vendor_finance_subledger_classifications;
create trigger vendor_finance_subledger_classifications_insert_guard
  before insert on public.vendor_finance_subledger_classifications
  for each row execute function public.vendor_finance__internal_classification_insert_guard();

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
     where e.vendor_id = new.vendor_id
       and e.ledger_scope = new.ledger_scope
       and e.project_id is not distinct from new.project_id
       and e.responsible_accountant_user_id is not distinct from new.responsible_accountant_user_id
       and e.contract_type = new.contract_type;

    if coalesce(v_existing_count, 0) <> 0 then
      raise exception 'VENDOR_FINANCE_LEDGER_INVARIANT_VIOLATION: sub-ledger already has entries'
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
       and e.ledger_scope = new.ledger_scope
       and e.project_id is not distinct from new.project_id
       and e.responsible_accountant_user_id is not distinct from new.responsible_accountant_user_id
       and e.contract_type = new.contract_type
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

    if v_orig.ledger_scope <> new.ledger_scope
       or v_orig.project_id is distinct from new.project_id
       or v_orig.responsible_accountant_user_id is distinct from new.responsible_accountant_user_id
       or v_orig.contract_type <> new.contract_type then
      raise exception 'VENDOR_FINANCE_REVERSAL_SUBLEDGER_MISMATCH'
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

create or replace function public.vendor_finance__internal_entry_projection(
  p_entry public.vendor_finance_entries,
  p_auth jsonb
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
  v_actor_id uuid;
  v_can_write boolean := false;
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
  v_actor_id := nullif(p_auth->>'actor_app_user_id', '')::uuid;

  if v_actor_id is not null then
    v_can_write := public.vendor_finance__internal_can_actor_write_subledger(
      p_auth,
      v_actor_id,
      'record',
      p_entry.ledger_scope,
      p_entry.project_id,
      p_entry.responsible_accountant_user_id
    );
  elsif coalesce(p_auth->>'record_scope', 'NONE') = 'ALL' then
    v_can_write := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'entry_id', p_entry.entry_id,
    'vendor_id', p_entry.vendor_id,
    'vendor_display_name_snapshot', p_entry.vendor_display_name_snapshot,
    'vendor_active', coalesce(v_vendor_active, false),
    'ledger_scope', p_entry.ledger_scope,
    'project_id', p_entry.project_id,
    'project_display_name_snapshot', p_entry.project_display_name_snapshot,
    'accountant_ref', p_entry.responsible_accountant_user_id,
    'responsible_accountant_display_name', p_entry.responsible_accountant_display_name_snapshot,
    'contract_type', p_entry.contract_type,
    'vendor_sequence', p_entry.vendor_sequence,
    'cursor_sequence', p_entry.ledger_cursor_seq,
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
      v_can_write
      and p_entry.entry_type <> 'REVERSAL'
      and v_reversed_by_id is null
    ),
    'can_attach_evidence', (
      v_can_write
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
  p_auth jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_evidence jsonb;
  v_actor_id uuid;
  v_can_reconcile boolean := false;
begin
  v_evidence := public.vendor_finance__internal_evidence_projection(null, p_rec.reconciliation_id);
  v_actor_id := nullif(p_auth->>'actor_app_user_id', '')::uuid;

  if v_actor_id is not null then
    v_can_reconcile := public.vendor_finance__internal_can_actor_write_subledger(
      p_auth,
      v_actor_id,
      'reconcile',
      p_rec.ledger_scope,
      p_rec.project_id,
      p_rec.responsible_accountant_user_id
    );
  elsif coalesce(p_auth->>'reconcile_scope', 'NONE') = 'ALL' then
    v_can_reconcile := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'reconciliation_id', p_rec.reconciliation_id,
    'vendor_id', p_rec.vendor_id,
    'ledger_scope', p_rec.ledger_scope,
    'project_id', p_rec.project_id,
    'project_display_name_snapshot', p_rec.project_display_name_snapshot,
    'accountant_ref', p_rec.responsible_accountant_user_id,
    'responsible_accountant_display_name', p_rec.responsible_accountant_display_name_snapshot,
    'contract_type', p_rec.contract_type,
    'as_of_date', p_rec.as_of_date::text,
    'system_balance_minor', p_rec.system_balance_minor::text,
    'confirmed_balance_minor', p_rec.confirmed_balance_minor::text,
    'difference_minor', p_rec.difference_minor::text,
    'ledger_sequence_at_reconciliation', p_rec.ledger_sequence_at_reconciliation,
    'reason', p_rec.reason,
    'can_attach_evidence', (v_can_reconcile and v_evidence is null),
    'evidence', v_evidence,
    'created_by_display_name', p_rec.created_by_display_name_snapshot,
    'created_at', pg_catalog.to_jsonb(p_rec.created_at)
  );
end;
$function$;

create or replace function public.vendor_finance__internal_classification_projection(
  p_vendor_id text,
  p_project_id text,
  p_accountant_user_id uuid,
  p_contract_type text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_row public.vendor_finance_subledger_classifications%rowtype;
  v_project_display_name text;
  v_accountant_display_name text;
begin
  if p_vendor_id is null
     or p_project_id is null
     or p_accountant_user_id is null
     or p_contract_type is null
     or p_contract_type not in ('SEASONAL', 'OFFICIAL') then
    return null;
  end if;

  select c.*
    into v_row
    from public.vendor_finance_subledger_classifications c
   where c.vendor_id = p_vendor_id
     and c.project_id = p_project_id
     and c.responsible_accountant_user_id = p_accountant_user_id
     and c.target_contract_type = p_contract_type;

  if not found then
    return null;
  end if;

  select p.display_name
    into v_project_display_name
    from public.direct_entry_projects p
   where p.project_id = v_row.project_id;

  v_accountant_display_name := public.vendor_finance__internal_actor_display_name(v_row.responsible_accountant_user_id);

  return pg_catalog.jsonb_build_object(
    'classification_id', v_row.classification_id,
    'vendor_id', v_row.vendor_id,
    'project_id', v_row.project_id,
    'project_display_name_snapshot', coalesce(v_project_display_name, v_row.project_id),
    'accountant_ref', v_row.responsible_accountant_user_id,
    'responsible_accountant_display_name', v_accountant_display_name,
    'source_contract_type', v_row.source_contract_type,
    'target_contract_type', v_row.target_contract_type,
    'classified_entry_count', v_row.classified_entry_count,
    'classified_reconciliation_count', v_row.classified_reconciliation_count,
    'closing_balance_minor', v_row.closing_balance_minor::text,
    'reason', v_row.reason,
    'classified_by_display_name', v_row.classified_by_display_name_snapshot,
    'classified_at', pg_catalog.to_jsonb(v_row.classified_at)
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Read RPCs with Contract-Type Sub-Ledger Separation
-- -----------------------------------------------------------------------------
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
  v_search text := null;
  v_offset integer;
  v_summary jsonb;
  v_total integer;
  v_vendors jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
  v_today := (v_auth->>'authorization_date')::date;
  v_vis := v_auth->>'visibility_scope';

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
           coalesce((
             select sum(sr.current_balance_minor::numeric)
               from subledger_rollups sr
           ), 0::numeric) as net_balance_num,
           count(*) filter (where vr.payable_total_num > 0)::integer as vendors_with_payable_count,
           count(*) filter (where vr.advance_total_num > 0)::integer as vendors_with_advance_count,
           count(*) filter (where vr.payable_total_num > 0 or vr.advance_total_num > 0)::integer as vendors_with_nonzero_balance_count,
           count(*)::integer as total_vendor_count,
           count(*) filter (where vr.entry_count = 0)::integer as uninitialized_vendor_count,
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
       or (p_balance_filter = 'advance' and vr.advance_total_num > 0)
       or (p_balance_filter = 'nonzero' and (vr.payable_total_num > 0 or vr.advance_total_num > 0))
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
                        ((page_row.payable_total_num + page_row.advance_total_num) = 0) asc,
                        (page_row.payable_total_num + page_row.advance_total_num) desc,
                        pg_catalog.lower(page_row.display_name) asc,
                        page_row.vendor_id asc
                    )
               from (
                 select f.*
                   from filtered f
                  order by
                    ((f.payable_total_num + f.advance_total_num) = 0) asc,
                    (f.payable_total_num + f.advance_total_num) desc,
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
  v_vendor public.vendors%rowtype;
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
      v_allowed_entry_types := '["DEBT_RECORDED","PAYROLL_RECORDED","PAYMENT_RECORDED","ADVANCE_RECORDED","ADJUSTMENT_INCREASE","ADJUSTMENT_DECREASE"]'::jsonb;
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
      'allowed_entry_types', v_allowed_entry_types
    ),
    'selected_sub_ledger', v_sel,
    'sub_ledgers', v_sub_ledgers,
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

create or replace function public.vendor_finance_list_vendor_reconciliations(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_page integer default 1,
  p_page_size integer default 25,
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
  v_vis text;
  v_today date;
  v_vendor public.vendors%rowtype;
  v_offset integer;
  v_total integer;
  v_items jsonb;
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

  if p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100
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

  v_offset := (p_page - 1) * p_page_size;

  select count(*)::integer,
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      public.vendor_finance__internal_reconciliation_projection(page_row.rec_row, v_auth)
                      order by page_row.as_of_date desc, page_row.created_at desc, page_row.reconciliation_id desc
                    )
               from (
                 select r as rec_row, r.as_of_date, r.created_at, r.reconciliation_id
                   from public.vendor_finance_reconciliations r
                  where r.vendor_id = v_vendor.vendor_id
                    and (v_vis = 'ALL' or (r.ledger_scope = 'PROJECT_ACCOUNTANT' and r.responsible_accountant_user_id = p_app_user_id))
                    and (p_ledger_scope is null or r.ledger_scope = p_ledger_scope)
                    and (p_project_id is null or r.project_id = p_project_id)
                    and (p_accountant_user_id is null or r.responsible_accountant_user_id = p_accountant_user_id)
                    and (p_contract_type is null or r.contract_type = p_contract_type)
                  order by r.as_of_date desc, r.created_at desc, r.reconciliation_id desc
                  limit p_page_size offset v_offset
               ) page_row
           ),
           '[]'::jsonb
         )
    into v_total, v_items
    from public.vendor_finance_reconciliations r0
   where r0.vendor_id = v_vendor.vendor_id
     and (v_vis = 'ALL' or (r0.ledger_scope = 'PROJECT_ACCOUNTANT' and r0.responsible_accountant_user_id = p_app_user_id))
     and (p_ledger_scope is null or r0.ledger_scope = p_ledger_scope)
     and (p_project_id is null or r0.project_id = p_project_id)
     and (p_accountant_user_id is null or r0.responsible_accountant_user_id = p_accountant_user_id)
     and (p_contract_type is null or r0.contract_type = p_contract_type);

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

-- -----------------------------------------------------------------------------
-- 5. Write RPCs with Explicit Contract-Type Sub-Ledger Isolation
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
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'record');
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

create or replace function public.vendor_finance_create_reconciliation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_accountant_user_id uuid,
  p_contract_type text,
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
  v_today date;
  v_reconcile_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_vendor public.vendors%rowtype;
  v_proj_acct jsonb;
  v_target_acct_id uuid;
  v_target_acct_name text;
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
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'reconcile');
  v_today := (v_auth->>'authorization_date')::date;
  v_reconcile_scope := coalesce(v_auth->>'reconcile_scope', 'NONE');
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

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL', 'UNCLASSIFIED') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_as_of_date is null
     or pg_catalog.date_part('year', p_as_of_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_confirmed := public.vendor_finance__internal_parse_signed_minor(p_confirmed_balance_minor);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  -- Lock order: ALWAYS project first, then vendor.
  v_project := public.vendor_finance__internal_lock_project(p_project_id);
  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if p_accountant_user_id is null then
    if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
      if v_reconcile_scope = 'ASSIGNED_PROJECTS' then
        raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
          using errcode = '42501';
      end if;
      raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
        using errcode = '40900';
    end if;

    v_target_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
    v_target_acct_name := v_proj_acct->>'accountant_display_name';
  else
    v_target_acct_id := p_accountant_user_id;
    if v_reconcile_scope = 'ASSIGNED_PROJECTS' and v_target_acct_id <> p_app_user_id then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    if not exists (
      select 1
        from public.vendor_finance_project_accountants pa
       where pa.project_id = v_project.project_id
         and pa.accountant_user_id = v_target_acct_id
      union all
      select 1
        from public.vendor_finance_entries e
       where e.vendor_id = v_vendor.vendor_id
         and e.ledger_scope = 'PROJECT_ACCOUNTANT'
         and e.project_id = v_project.project_id
         and e.responsible_accountant_user_id = v_target_acct_id
    ) then
      raise exception 'VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE'
        using errcode = '42200';
    end if;

    v_target_acct_name := public.vendor_finance__internal_actor_display_name(v_target_acct_id);
  end if;

  if not public.vendor_finance__internal_can_actor_write_subledger(
    v_auth,
    p_app_user_id,
    'reconcile',
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_target_acct_id
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_reconcile_scope = 'ASSIGNED_PROJECTS'
     and not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if not exists (
    select 1 from public.vendor_finance_entries e
     where e.vendor_id = v_vendor.vendor_id
       and e.ledger_scope = 'PROJECT_ACCOUNTANT'
       and e.project_id = v_project.project_id
       and e.responsible_accountant_user_id = v_target_acct_id
       and e.contract_type = p_contract_type
    union all
    select 1 from public.vendor_finance_reconciliations r
     where r.vendor_id = v_vendor.vendor_id
       and r.ledger_scope = 'PROJECT_ACCOUNTANT'
       and r.project_id = v_project.project_id
       and r.responsible_accountant_user_id = v_target_acct_id
       and r.contract_type = p_contract_type
    union all
    select 1 from public.vendor_finance_project_accountants pa
     where p_contract_type in ('SEASONAL', 'OFFICIAL')
       and v_vendor.active = true
       and v_project.active = true
       and coalesce((v_proj_acct->>'has_assignment')::boolean, false)
       and coalesce((v_proj_acct->>'accountant_active')::boolean, false)
       and pa.project_id = v_project.project_id
       and pa.accountant_user_id = v_target_acct_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
  ) then
    raise exception 'VENDOR_FINANCE_SUBLEDGER_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(sum(e.balance_delta_minor::numeric) filter (where e.effective_date <= p_as_of_date), 0::numeric),
         coalesce(max(e.vendor_sequence), 0)::bigint
    into v_system_num, v_latest_seq
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_target_acct_id
     and e.contract_type = p_contract_type;

  if v_system_num < (-9223372036854775808)::numeric
     or v_system_num > 9223372036854775807::numeric then
    raise exception 'VENDOR_FINANCE_AMOUNT_OVERFLOW'
      using errcode = '22003';
  end if;

  v_system := v_system_num::bigint;
  v_diff := public.vendor_finance__internal_checked_sub_minor(v_confirmed, v_system);

  insert into public.vendor_finance_reconciliations (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
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
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_target_acct_id,
    v_target_acct_name,
    p_contract_type,
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
    project_id,
    reconciliation_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_inserted.reconciliation_id,
    p_app_user_id,
    v_authority_source,
    'RECONCILIATION_CREATED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'project_id', v_inserted.project_id,
      'responsible_accountant_user_id', v_inserted.responsible_accountant_user_id,
      'contract_type', v_inserted.contract_type,
      'as_of_date', v_inserted.as_of_date::text,
      'system_balance_minor', v_inserted.system_balance_minor::text,
      'confirmed_balance_minor', v_inserted.confirmed_balance_minor::text,
      'difference_minor', v_inserted.difference_minor::text,
      'ledger_sequence_at_reconciliation', v_inserted.ledger_sequence_at_reconciliation
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'reconciliation', public.vendor_finance__internal_reconciliation_projection(v_inserted, v_auth)
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

-- Controlled one-time classification of an `UNCLASSIFIED` project sub-ledger
-- into `SEASONAL` or `OFFICIAL`, preserving exact amounts, dates, document numbers,
-- and recording an immutable classification audit trail.
create or replace function public.vendor_finance_classify_unclassified_subledger(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_accountant_user_id uuid,
  p_target_contract_type text,
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
  v_target_acct_id uuid;
  v_target_acct_name text;
  v_reason text;
  v_actor_name text;
  v_entry_count integer;
  v_rec_count integer;
  v_closing_balance bigint;
  v_target_busy boolean;
  v_inserted public.vendor_finance_subledger_classifications%rowtype;
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
    if v_existing_idem.action <> 'CLASSIFY_SUBLEDGER_CONTRACT_TYPE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_target_contract_type is null or p_target_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  -- Lock order: ALWAYS project first, then vendor.
  v_project := public.vendor_finance__internal_lock_project(p_project_id);
  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if p_accountant_user_id is null then
    if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
      if v_record_scope = 'ASSIGNED_PROJECTS' then
        raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
          using errcode = '42501';
      end if;
      raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
        using errcode = '40900';
    end if;
    v_target_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  else
    v_target_acct_id := p_accountant_user_id;
    if v_record_scope = 'ASSIGNED_PROJECTS' and v_target_acct_id <> p_app_user_id then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
  end if;

  if not public.vendor_finance__internal_can_actor_write_subledger(
    v_auth,
    p_app_user_id,
    'record',
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_target_acct_id
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_record_scope = 'ASSIGNED_PROJECTS'
     and not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if exists (
    select 1
      from public.vendor_finance_subledger_classifications c
     where c.vendor_id = v_vendor.vendor_id
       and c.project_id = v_project.project_id
       and c.responsible_accountant_user_id = v_target_acct_id
  ) then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED'
      using errcode = '23505';
  end if;

  select count(*)::integer
    into v_entry_count
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_target_acct_id
     and e.contract_type = 'UNCLASSIFIED';

  if coalesce(v_entry_count, 0) = 0 then
    raise exception 'VENDOR_FINANCE_SUBLEDGER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select count(*)::integer
    into v_rec_count
    from public.vendor_finance_reconciliations r
   where r.vendor_id = v_vendor.vendor_id
     and r.ledger_scope = 'PROJECT_ACCOUNTANT'
     and r.project_id = v_project.project_id
     and r.responsible_accountant_user_id = v_target_acct_id
     and r.contract_type = 'UNCLASSIFIED';

  select e.balance_after_minor
    into v_closing_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_target_acct_id
     and e.contract_type = 'UNCLASSIFIED'
   order by e.vendor_sequence desc
   limit 1;

  select exists (
           select 1
             from public.vendor_finance_entries e
            where e.vendor_id = v_vendor.vendor_id
              and e.ledger_scope = 'PROJECT_ACCOUNTANT'
              and e.project_id = v_project.project_id
              and e.responsible_accountant_user_id = v_target_acct_id
              and e.contract_type = p_target_contract_type
           union all
           select 1
             from public.vendor_finance_reconciliations r
            where r.vendor_id = v_vendor.vendor_id
              and r.ledger_scope = 'PROJECT_ACCOUNTANT'
              and r.project_id = v_project.project_id
              and r.responsible_accountant_user_id = v_target_acct_id
              and r.contract_type = p_target_contract_type
         )
    into v_target_busy;

  if v_target_busy then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY'
      using errcode = '23505';
  end if;

  v_target_acct_name := public.vendor_finance__internal_actor_display_name(v_target_acct_id);

  perform pg_catalog.set_config('vendor_finance.classify_write_marker', 'on', true);

  update public.vendor_finance_entries e
     set contract_type = p_target_contract_type
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_target_acct_id
     and e.contract_type = 'UNCLASSIFIED';

  update public.vendor_finance_reconciliations r
     set contract_type = p_target_contract_type
   where r.vendor_id = v_vendor.vendor_id
     and r.ledger_scope = 'PROJECT_ACCOUNTANT'
     and r.project_id = v_project.project_id
     and r.responsible_accountant_user_id = v_target_acct_id
     and r.contract_type = 'UNCLASSIFIED';

  update public.vendor_finance_opening_batches b
     set contract_type = p_target_contract_type
   where b.ledger_scope = 'PROJECT_ACCOUNTANT'
     and b.project_id = v_project.project_id
     and b.responsible_accountant_user_id = v_target_acct_id
     and b.contract_type = 'UNCLASSIFIED'
     and exists (
       select 1
         from public.vendor_finance_entries e
        where e.opening_batch_id = b.batch_id
          and e.vendor_id = v_vendor.vendor_id
          and e.contract_type = p_target_contract_type
     )
     and not exists (
       select 1
         from public.vendor_finance_entries e2
        where e2.opening_batch_id = b.batch_id
          and e2.contract_type <> p_target_contract_type
     );

  insert into public.vendor_finance_subledger_classifications (
    vendor_id,
    project_id,
    responsible_accountant_user_id,
    source_contract_type,
    target_contract_type,
    classified_entry_count,
    classified_reconciliation_count,
    closing_balance_minor,
    reason,
    classified_by_user_id,
    classified_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_target_acct_id,
    'UNCLASSIFIED',
    p_target_contract_type,
    v_entry_count,
    coalesce(v_rec_count, 0),
    coalesce(v_closing_balance, 0),
    v_reason,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  perform pg_catalog.set_config('vendor_finance.classify_write_marker', '', true);

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    p_app_user_id,
    v_authority_source,
    'SUBLEDGER_CONTRACT_TYPE_CLASSIFIED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'classification_id', v_inserted.classification_id,
      'project_id', v_inserted.project_id,
      'responsible_accountant_user_id', v_inserted.responsible_accountant_user_id,
      'source_contract_type', v_inserted.source_contract_type,
      'target_contract_type', v_inserted.target_contract_type,
      'classified_entry_count', v_inserted.classified_entry_count,
      'classified_reconciliation_count', v_inserted.classified_reconciliation_count,
      'closing_balance_minor', v_inserted.closing_balance_minor::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'classification', pg_catalog.jsonb_build_object(
      'classification_id', v_inserted.classification_id,
      'vendor_id', v_inserted.vendor_id,
      'project_id', v_inserted.project_id,
      'project_display_name_snapshot', v_project.display_name,
      'accountant_ref', v_inserted.responsible_accountant_user_id,
      'responsible_accountant_display_name', v_target_acct_name,
      'source_contract_type', v_inserted.source_contract_type,
      'target_contract_type', v_inserted.target_contract_type,
      'classified_entry_count', v_inserted.classified_entry_count,
      'classified_reconciliation_count', v_inserted.classified_reconciliation_count,
      'closing_balance_minor', v_inserted.closing_balance_minor::text,
      'reason', v_inserted.reason,
      'classified_by_display_name', v_inserted.classified_by_display_name_snapshot,
      'classified_at', pg_catalog.to_jsonb(v_inserted.classified_at)
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
    'CLASSIFY_SUBLEDGER_CONTRACT_TYPE',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- -----------------------------------------------------------------------------
-- 6. Monthly Project & Contract-Type Debt Report (`vendor_finance_get_monthly_report`)
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
      'can_manage_project_assignments', coalesce((v_auth->>'can_manage_project_assignments')::boolean, false)
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
-- 7. Owner alignment & helper EXECUTE privileges (`s0_t1c_runner` & `postgres` safe).
-- -----------------------------------------------------------------------------
do $align_vfin_03_owners$
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
    'public.vendor_finance_subledger_classifications'
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
    'public.vendor_finance__internal_lock_project(text)',
    'public.vendor_finance__internal_resolve_authority(uuid, uuid)',
    'public.vendor_finance__internal_assert_authority(uuid, uuid, text)',
    'public.vendor_finance__internal_resolve_active_project_accountant(text, date)',
    'public.vendor_finance__internal_can_actor_write_subledger(jsonb, uuid, text, text, text, uuid)',
    'public.vendor_finance__internal_entry_projection(public.vendor_finance_entries, jsonb)',
    'public.vendor_finance__internal_reconciliation_projection(public.vendor_finance_reconciliations, jsonb)',
    'public.vendor_finance__internal_classification_projection(text, text, uuid, text)',
    'public.vendor_finance_get_actor_access(uuid, uuid)',
    'public.vendor_finance_list_actor_context_options(uuid, uuid)',
    'public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, text, integer, integer)',
    'public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)',
    'public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)',
    'public.vendor_finance_get_entry(uuid, uuid, uuid)',
    'public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text, text)',
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)',
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
$align_vfin_03_owners$;

-- -----------------------------------------------------------------------------
-- 8. Strict table & function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on table public.vendor_finance_subledger_classifications
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_immutable_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_classification_insert_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_entry_integrity_guard()
  from public, anon, authenticated, service_role;

revoke all on function public.vendor_finance__internal_entry_projection(public.vendor_finance_entries, jsonb)
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

revoke all on function public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)
  to service_role;

revoke all on function public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)
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

revoke all on function public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)
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
-- 9. Data-free install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $check_vfin_03$
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
    'public.vendor_finance_subledger_classifications'::pg_catalog.regclass
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
      raise exception 'VFIN-03 table RLS/ACL boundary drift on %', v_tbl
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
    'public.vendor_finance__internal_lock_vendor(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_lock_project(text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_resolve_authority(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_assert_authority(uuid, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_resolve_active_project_accountant(text, date)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_can_actor_write_subledger(jsonb, uuid, text, text, text, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_evidence_projection(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance__internal_entry_projection(public.vendor_finance_entries, jsonb)'::pg_catalog.regprocedure,
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
      raise exception 'VFIN-03 internal routine security definer/owner/search_path drift on %', v_internal_fn
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
      raise exception 'VFIN-03 internal routine must stay revoked from all runtime roles: %', v_internal_fn
        using errcode = '55000';
    end if;
  end loop;

  foreach v_rpc_fn in array array[
    'public.vendor_finance_get_actor_access(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_actor_context_options(uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, text, integer, integer)'::pg_catalog.regprocedure,
    'public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_get_entry(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)'::pg_catalog.regprocedure,
    'public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)'::pg_catalog.regprocedure,
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
      raise exception 'VFIN-03 RPC security definer owner/RLS/search_path drift on %', v_rpc_fn
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
      raise exception 'VFIN-03 RPC EXECUTE ACL drift on %', v_rpc_fn
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
    raise exception 'VFIN-03 overloaded vendor_finance_* functions detected (% names)', v_overload_count
      using errcode = '55000';
  end if;
end;
$check_vfin_03$;

commit;
