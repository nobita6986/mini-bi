-- =============================================================================
-- W2S2-WP1 — Salary Advance Request & Evidence Workflow Foundation
--
-- Scope:
--   1. Business tables:
--      - `public.salary_advance_requests` (without any worker PII/profile snapshot columns;
--        links to `public.direct_entries(entry_id)` via `worker_entry_id`).
--      - `public.salary_advance_events` (append-only timeline and evidence version history).
--      - `public.salary_advance_idempotency` (append-only mutation idempotency ledger).
--   2. Independent state machines:
--      - `request_state`: `OPEN` | `NEEDS_INFO` | `APPROVED` | `REJECTED` | `WITHDRAWN` | `HANDLED_EXTERNALLY`
--      - `evidence_review_state`: `NOT_UPLOADED` | `PENDING_REVIEW` | `REVIEWED` | `RETAKE_REQUIRED`
--   3. Strict authority matrix:
--      - `PROJECT_MANAGER`: active assigned project manager (`direct_entry_actor_is_assigned_project_manager`),
--        restricted to own created requests in managed project scope.
--      - `PROJECT_ACCOUNTANT`: active assignment in `vendor_finance_project_accountants` +
--        active `ACCOUNTING` department membership (`org_department__internal_has_active_membership`).
--      - `SUPERVISORY_VIEWER`: canonical Full Admin (`entry_admin` + `recruiter_master_manage` +
--        `team_master_manage` @ `all`) or canonical BoD (`entry_privileged_edit` @ `all` OR
--        (`report_analytics_view` + `report_view` @ `all`)), read-only across all projects.
--      - Never infers BoD from `vendor_finance_view`, `vendor_finance_record`, or
--        `vendor_finance_global_roles` (`GLOBAL_VIEWER`, `GLOBAL_RECONCILER`, `CASH_HOLDER`,
--        `CASH_HOLDER_RECORD_BEHALF`).
--   4. Forced RLS + default-deny on all tables; `SECURITY DEFINER` RPCs with locked
--      `search_path = pg_catalog, public` granted exclusively to `service_role`.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Core tables, constraints & indexes.
-- -----------------------------------------------------------------------------
create table public.salary_advance_requests (
  request_id uuid primary key default gen_random_uuid(),
  project_id text not null
    references public.direct_entry_projects(project_id) on delete restrict
    check (project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  worker_entry_id uuid not null
    references public.direct_entries(entry_id) on delete restrict,
  requested_amount_vnd bigint not null
    constraint salary_advance_requests_amount_positive_chk
    check (requested_amount_vnd > 0),
  initial_content text not null
    constraint salary_advance_requests_initial_content_chk
    check (
      pg_catalog.char_length(pg_catalog.btrim(initial_content)) between 1 and 2000
      and initial_content !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  request_state text not null default 'OPEN'
    constraint salary_advance_requests_request_state_chk
    check (
      request_state in (
        'OPEN',
        'NEEDS_INFO',
        'APPROVED',
        'REJECTED',
        'WITHDRAWN',
        'HANDLED_EXTERNALLY'
      )
    ),
  evidence_review_state text not null default 'NOT_UPLOADED'
    constraint salary_advance_requests_evidence_state_chk
    check (
      evidence_review_state in (
        'NOT_UPLOADED',
        'PENDING_REVIEW',
        'REVIEWED',
        'RETAKE_REQUIRED'
      )
    ),
  version integer not null default 1
    constraint salary_advance_requests_version_chk
    check (version >= 1),
  created_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  decided_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  decided_at timestamptz null,
  decision_note text null
    constraint salary_advance_requests_decision_note_chk
    check (
      decision_note is null
      or (
        pg_catalog.char_length(pg_catalog.btrim(decision_note)) between 1 and 1000
        and decision_note !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  handled_externally_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  handled_externally_at timestamptz null,
  handled_externally_note text null
    constraint salary_advance_requests_handled_note_chk
    check (
      handled_externally_note is null
      or (
        pg_catalog.char_length(pg_catalog.btrim(handled_externally_note)) between 1 and 1000
        and handled_externally_note !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  withdrawn_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  withdrawn_at timestamptz null,
  withdrawn_note text null
    constraint salary_advance_requests_withdrawn_note_chk
    check (
      withdrawn_note is null
      or (
        pg_catalog.char_length(pg_catalog.btrim(withdrawn_note)) between 1 and 1000
        and withdrawn_note !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  current_evidence_version integer not null default 0
    constraint salary_advance_requests_evidence_version_chk
    check (current_evidence_version >= 0),
  current_evidence_event_id uuid null,
  current_evidence_storage_key text null
    constraint salary_advance_requests_evidence_storage_key_chk
    check (
      current_evidence_storage_key is null
      or current_evidence_storage_key ~ '^salary-advance/requests/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/evidence/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  current_evidence_mime_type text null
    constraint salary_advance_requests_evidence_mime_chk
    check (
      current_evidence_mime_type is null
      or current_evidence_mime_type in ('image/jpeg', 'image/png')
    ),
  current_evidence_size_bytes integer null
    constraint salary_advance_requests_evidence_size_chk
    check (
      current_evidence_size_bytes is null
      or current_evidence_size_bytes between 1 and 10485760
    ),
  current_evidence_checksum_sha256 text null
    constraint salary_advance_requests_evidence_checksum_chk
    check (
      current_evidence_checksum_sha256 is null
      or current_evidence_checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
  current_evidence_uploaded_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  current_evidence_uploaded_at timestamptz null,
  evidence_reviewed_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  evidence_reviewed_at timestamptz null,
  evidence_review_note text null
    constraint salary_advance_requests_evidence_review_note_chk
    check (
      evidence_review_note is null
      or (
        pg_catalog.char_length(pg_catalog.btrim(evidence_review_note)) between 1 and 1000
        and evidence_review_note !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  reviewed_worker_portrait_document_id uuid null
    references public.direct_entry_document_versions(document_id) on delete restrict,
  reviewed_worker_portrait_version integer null
    constraint salary_advance_requests_reviewed_portrait_version_chk
    check (
      reviewed_worker_portrait_version is null
      or reviewed_worker_portrait_version >= 1
    ),
  pending_upload_id uuid null,
  pending_upload_storage_key text null
    constraint salary_advance_requests_pending_storage_key_chk
    check (
      pending_upload_storage_key is null
      or pending_upload_storage_key ~ '^salary-advance/requests/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/evidence/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  pending_upload_mime_type text null
    constraint salary_advance_requests_pending_mime_chk
    check (
      pending_upload_mime_type is null
      or pending_upload_mime_type in ('image/jpeg', 'image/png')
    ),
  pending_upload_size_bytes integer null
    constraint salary_advance_requests_pending_size_chk
    check (
      pending_upload_size_bytes is null
      or pending_upload_size_bytes between 1 and 10485760
    ),
  pending_upload_checksum_sha256 text null
    constraint salary_advance_requests_pending_checksum_chk
    check (
      pending_upload_checksum_sha256 is null
      or pending_upload_checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
  pending_upload_caption_note text null
    constraint salary_advance_requests_pending_caption_chk
    check (
      pending_upload_caption_note is null
      or (
        pg_catalog.char_length(pg_catalog.btrim(pending_upload_caption_note)) between 1 and 1000
        and pending_upload_caption_note !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  pending_upload_reserved_by_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  pending_upload_expires_at timestamptz null,
  last_activity_at timestamptz not null default now(),
  last_actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint salary_advance_requests_evidence_consistency_chk check (
    (
      current_evidence_version = 0
      and evidence_review_state = 'NOT_UPLOADED'
      and current_evidence_event_id is null
      and current_evidence_storage_key is null
      and current_evidence_mime_type is null
      and current_evidence_size_bytes is null
      and current_evidence_checksum_sha256 is null
      and current_evidence_uploaded_by_user_id is null
      and current_evidence_uploaded_at is null
      and evidence_reviewed_by_user_id is null
      and evidence_reviewed_at is null
      and evidence_review_note is null
      and reviewed_worker_portrait_document_id is null
      and reviewed_worker_portrait_version is null
    )
    or (
      current_evidence_version >= 1
      and evidence_review_state in ('PENDING_REVIEW', 'REVIEWED', 'RETAKE_REQUIRED')
      and request_state in ('APPROVED', 'HANDLED_EXTERNALLY')
      and current_evidence_event_id is not null
      and current_evidence_storage_key is not null
      and current_evidence_mime_type is not null
      and current_evidence_size_bytes is not null
      and current_evidence_checksum_sha256 is not null
      and current_evidence_uploaded_by_user_id is not null
      and current_evidence_uploaded_at is not null
    )
  ),
  constraint salary_advance_requests_reviewed_portrait_chk check (
    (
      evidence_review_state = 'REVIEWED'
      and evidence_reviewed_by_user_id is not null
      and evidence_reviewed_at is not null
      and reviewed_worker_portrait_document_id is not null
      and reviewed_worker_portrait_version is not null
    )
    or (
      evidence_review_state <> 'REVIEWED'
      and reviewed_worker_portrait_document_id is null
      and reviewed_worker_portrait_version is null
    )
  ),
  constraint salary_advance_requests_pending_upload_chk check (
    (
      pending_upload_id is null
      and pending_upload_storage_key is null
      and pending_upload_mime_type is null
      and pending_upload_size_bytes is null
      and pending_upload_checksum_sha256 is null
      and pending_upload_caption_note is null
      and pending_upload_reserved_by_user_id is null
      and pending_upload_expires_at is null
    )
    or (
      pending_upload_id is not null
      and pending_upload_storage_key is not null
      and pending_upload_mime_type is not null
      and pending_upload_size_bytes is not null
      and pending_upload_checksum_sha256 is not null
      and pending_upload_reserved_by_user_id is not null
      and pending_upload_expires_at is not null
    )
  )
);

create index salary_advance_requests_project_activity_idx
  on public.salary_advance_requests (
    project_id,
    request_state,
    evidence_review_state,
    last_activity_at desc,
    request_id desc
  );

create index salary_advance_requests_creator_activity_idx
  on public.salary_advance_requests (
    created_by_user_id,
    project_id,
    last_activity_at desc,
    request_id desc
  );

create index salary_advance_requests_worker_activity_idx
  on public.salary_advance_requests (
    worker_entry_id,
    last_activity_at desc,
    request_id desc
  );

alter table public.salary_advance_requests enable row level security;
alter table public.salary_advance_requests force row level security;

create table public.salary_advance_events (
  event_id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.salary_advance_requests(request_id) on delete restrict,
  event_seq integer not null
    constraint salary_advance_events_seq_chk
    check (event_seq >= 1),
  event_type text not null
    constraint salary_advance_events_type_chk
    check (
      event_type in (
        'REQUEST_CREATED',
        'MESSAGE_POSTED',
        'INFO_REQUESTED',
        'INFO_PROVIDED',
        'REQUEST_APPROVED',
        'REQUEST_REJECTED',
        'REQUEST_WITHDRAWN',
        'HANDLED_EXTERNALLY_MARKED',
        'EVIDENCE_UPLOADED',
        'EVIDENCE_REVIEWED',
        'EVIDENCE_RETAKE_REQUESTED'
      )
    ),
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  actor_role text not null
    constraint salary_advance_events_actor_role_chk
    check (actor_role in ('PROJECT_MANAGER', 'PROJECT_ACCOUNTANT')),
  from_request_state text null
    constraint salary_advance_events_from_req_state_chk
    check (
      from_request_state is null
      or from_request_state in (
        'OPEN',
        'NEEDS_INFO',
        'APPROVED',
        'REJECTED',
        'WITHDRAWN',
        'HANDLED_EXTERNALLY'
      )
    ),
  to_request_state text not null
    constraint salary_advance_events_to_req_state_chk
    check (
      to_request_state in (
        'OPEN',
        'NEEDS_INFO',
        'APPROVED',
        'REJECTED',
        'WITHDRAWN',
        'HANDLED_EXTERNALLY'
      )
    ),
  from_evidence_review_state text null
    constraint salary_advance_events_from_ev_state_chk
    check (
      from_evidence_review_state is null
      or from_evidence_review_state in (
        'NOT_UPLOADED',
        'PENDING_REVIEW',
        'REVIEWED',
        'RETAKE_REQUIRED'
      )
    ),
  to_evidence_review_state text not null
    constraint salary_advance_events_to_ev_state_chk
    check (
      to_evidence_review_state in (
        'NOT_UPLOADED',
        'PENDING_REVIEW',
        'REVIEWED',
        'RETAKE_REQUIRED'
      )
    ),
  message_text text null
    constraint salary_advance_events_message_chk
    check (
      message_text is null
      or (
        pg_catalog.char_length(pg_catalog.btrim(message_text)) between 1 and 2000
        and message_text !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  evidence_version integer null
    constraint salary_advance_events_evidence_version_chk
    check (evidence_version is null or evidence_version >= 1),
  evidence_storage_key text null
    constraint salary_advance_events_evidence_storage_key_chk
    check (
      evidence_storage_key is null
      or evidence_storage_key ~ '^salary-advance/requests/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/evidence/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  evidence_mime_type text null
    constraint salary_advance_events_evidence_mime_chk
    check (
      evidence_mime_type is null
      or evidence_mime_type in ('image/jpeg', 'image/png')
    ),
  evidence_size_bytes integer null
    constraint salary_advance_events_evidence_size_chk
    check (
      evidence_size_bytes is null
      or evidence_size_bytes between 1 and 10485760
    ),
  evidence_checksum_sha256 text null
    constraint salary_advance_events_evidence_checksum_chk
    check (
      evidence_checksum_sha256 is null
      or evidence_checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
  reviewed_worker_portrait_document_id uuid null
    references public.direct_entry_document_versions(document_id) on delete restrict,
  reviewed_worker_portrait_version integer null
    constraint salary_advance_events_portrait_version_chk
    check (
      reviewed_worker_portrait_version is null
      or reviewed_worker_portrait_version >= 1
    ),
  created_at timestamptz not null default now(),
  constraint salary_advance_events_request_seq_key
    unique (request_id, event_seq),
  constraint salary_advance_events_evidence_payload_chk check (
    (
      event_type = 'EVIDENCE_UPLOADED'
      and evidence_version is not null
      and evidence_storage_key is not null
      and evidence_mime_type is not null
      and evidence_size_bytes is not null
      and evidence_checksum_sha256 is not null
      and reviewed_worker_portrait_document_id is null
      and reviewed_worker_portrait_version is null
    )
    or (
      event_type = 'EVIDENCE_REVIEWED'
      and evidence_version is not null
      and evidence_storage_key is null
      and evidence_mime_type is null
      and evidence_size_bytes is null
      and evidence_checksum_sha256 is null
      and reviewed_worker_portrait_document_id is not null
      and reviewed_worker_portrait_version is not null
    )
    or (
      event_type = 'EVIDENCE_RETAKE_REQUESTED'
      and evidence_version is not null
      and evidence_storage_key is null
      and evidence_mime_type is null
      and evidence_size_bytes is null
      and evidence_checksum_sha256 is null
      and reviewed_worker_portrait_document_id is null
      and reviewed_worker_portrait_version is null
    )
    or (
      event_type not in ('EVIDENCE_UPLOADED', 'EVIDENCE_REVIEWED', 'EVIDENCE_RETAKE_REQUESTED')
      and evidence_version is null
      and evidence_storage_key is null
      and evidence_mime_type is null
      and evidence_size_bytes is null
      and evidence_checksum_sha256 is null
      and reviewed_worker_portrait_document_id is null
      and reviewed_worker_portrait_version is null
    )
  )
);

create unique index salary_advance_events_request_evidence_upload_uidx
  on public.salary_advance_events (request_id, evidence_version)
  where event_type = 'EVIDENCE_UPLOADED';

alter table public.salary_advance_events enable row level security;
alter table public.salary_advance_events force row level security;

create table public.salary_advance_idempotency (
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  idempotency_key text not null
    constraint salary_advance_idempotency_key_chk
    check (
      pg_catalog.char_length(pg_catalog.btrim(idempotency_key)) between 8 and 128
      and idempotency_key !~ '[\x00-\x1F\x7F]'
    ),
  action text not null
    constraint salary_advance_idempotency_action_chk
    check (
      action in (
        'CREATE_REQUEST',
        'POST_MESSAGE',
        'REQUEST_INFO',
        'PROVIDE_INFO',
        'APPROVE_REQUEST',
        'REJECT_REQUEST',
        'WITHDRAW_REQUEST',
        'MARK_HANDLED_EXTERNALLY',
        'RESERVE_EVIDENCE',
        'FINALIZE_EVIDENCE',
        'REVIEW_EVIDENCE'
      )
    ),
  request_fingerprint text not null
    constraint salary_advance_idempotency_fingerprint_chk
    check (pg_catalog.char_length(pg_catalog.btrim(request_fingerprint)) between 16 and 512),
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_user_id, idempotency_key)
);

alter table public.salary_advance_idempotency enable row level security;
alter table public.salary_advance_idempotency force row level security;

-- -----------------------------------------------------------------------------
-- 2. Write-marker & append-only guards.
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_immutable_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'SALARY_ADVANCE_APPEND_ONLY_VIOLATION'
      using errcode = '55000';
  end if;

  if coalesce(pg_catalog.current_setting('salary_advance.write_marker', true), '') <> 'on' then
    raise exception 'SALARY_ADVANCE_DIRECT_WRITE_FORBIDDEN'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

create or replace function public.salary_advance__internal_request_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'SALARY_ADVANCE_REQUEST_DELETE_FORBIDDEN'
      using errcode = '55000';
  end if;

  if coalesce(pg_catalog.current_setting('salary_advance.write_marker', true), '') <> 'on' then
    raise exception 'SALARY_ADVANCE_DIRECT_WRITE_FORBIDDEN'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

create trigger salary_advance_requests_write_guard
  before insert or update or delete on public.salary_advance_requests
  for each row execute function public.salary_advance__internal_request_guard();

create trigger salary_advance_events_immutable_guard
  before insert or update or delete on public.salary_advance_events
  for each row execute function public.salary_advance__internal_immutable_guard();

create trigger salary_advance_idempotency_immutable_guard
  before insert or update or delete on public.salary_advance_idempotency
  for each row execute function public.salary_advance__internal_immutable_guard();

-- -----------------------------------------------------------------------------
-- 3. Internal validation, authority & projection helpers (`salary_advance__internal_*`).
-- -----------------------------------------------------------------------------
create or replace function public.salary_advance__internal_parse_positive_amount(
  p_raw text
)
returns bigint
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_trimmed text;
  v_amount bigint;
begin
  v_trimmed := pg_catalog.btrim(coalesce(p_raw, ''));
  if v_trimmed !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'SALARY_ADVANCE_AMOUNT_INVALID'
      using errcode = '22023';
  end if;

  begin
    v_amount := v_trimmed::bigint;
  exception
    when numeric_value_out_of_range then
      raise exception 'SALARY_ADVANCE_AMOUNT_INVALID'
        using errcode = '22023';
  end;

  if v_amount <= 0 then
    raise exception 'SALARY_ADVANCE_AMOUNT_INVALID'
      using errcode = '22023';
  end if;

  return v_amount;
end;
$function$;

create or replace function public.salary_advance__internal_validate_text(
  p_raw text,
  p_min_len integer,
  p_max_len integer,
  p_allow_null boolean,
  p_error_code text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_trimmed text;
begin
  if p_raw is null then
    if p_allow_null then
      return null;
    end if;
    raise exception '%', p_error_code
      using errcode = '22023';
  end if;

  v_trimmed := pg_catalog.btrim(p_raw);
  if v_trimmed = '' then
    if p_allow_null then
      return null;
    end if;
    raise exception '%', p_error_code
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_trimmed) < p_min_len
     or pg_catalog.char_length(v_trimmed) > p_max_len
     or v_trimmed ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception '%', p_error_code
      using errcode = '22023';
  end if;

  return v_trimmed;
end;
$function$;

create or replace function public.salary_advance__internal_actor_display_name(
  p_user_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(
    (
      select nullif(pg_catalog.btrim(coalesce(u.display_name, '')), '')
        from public.direct_entry_app_users u
       where u.app_user_id = p_user_id
    ),
    'Chưa cập nhật tên'
  );
$function$;

create or replace function public.salary_advance__internal_worker_display_name(
  p_worker_details jsonb
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select case
    when pg_catalog.jsonb_typeof(p_worker_details->'display_name') = 'object' then
      coalesce(
        nullif(pg_catalog.btrim(coalesce(p_worker_details->'display_name'->>'value', '')), ''),
        'Chưa cập nhật tên'
      )
    else
      coalesce(
        nullif(pg_catalog.btrim(coalesce(p_worker_details->>'display_name', '')), ''),
        'Chưa cập nhật tên'
      )
  end;
$function$;

create or replace function public.salary_advance__internal_resolve_worker_portrait(
  p_candidate_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_doc record;
begin
  if p_candidate_id is null then
    return null;
  end if;

  select cd.document_id,
         cd.version,
         cd.mime_type,
         cd.size_bytes,
         cd.checksum_sha256
    into v_doc
    from public.direct_entry_current_documents cd
   where cd.candidate_id = p_candidate_id
     and cd.document_type = 'WORKER_PORTRAIT'
     and cd.upload_status = 'READY'
     and cd.validation_status = 'VALIDATED'
     and cd.scan_status in ('CLEAN', 'NOT_REQUIRED')
   limit 1;

  if not found or v_doc.checksum_sha256 is null then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'document_id', v_doc.document_id,
    'version', v_doc.version,
    'mime_type', v_doc.mime_type,
    'size_bytes', v_doc.size_bytes,
    'checksum_sha256', v_doc.checksum_sha256
  );
end;
$function$;

create or replace function public.salary_advance__internal_resolve_authority(
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
  v_has_all_scope boolean := false;
  v_is_full_admin boolean := false;
  v_is_bod boolean := false;
  v_is_supervisory_viewer boolean := false;
  v_accounting_member boolean := false;
  v_managed_project_ids text[] := array[]::text[];
  v_accountant_project_ids text[] := array[]::text[];
  v_is_project_manager boolean := false;
  v_is_project_accountant boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  v_has_all_scope := public.direct_entry_has_scope(p_app_user_id, 'all');

  -- Canonical Full Admin (`entry_admin` + `recruiter_master_manage` + `team_master_manage` @ `all`).
  v_is_full_admin := v_has_all_scope
    and public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage');

  -- Canonical BoD (`entry_privileged_edit` @ `all` OR (`report_analytics_view` + `report_view` @ `all`)).
  -- Never infer BoD from `vendor_finance_view`, `vendor_finance_record`, or `vendor_finance_global_roles`.
  v_is_bod := v_has_all_scope
    and (
      public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
      or (
        public.direct_entry_has_capability(p_app_user_id, 'report_analytics_view')
        and public.direct_entry_has_capability(p_app_user_id, 'report_view')
      )
    );

  v_is_supervisory_viewer := v_is_full_admin or v_is_bod;

  -- Active assigned Project Manager projects.
  select coalesce(pg_catalog.array_agg(p.project_id order by p.project_id), array[]::text[])
    into v_managed_project_ids
    from public.direct_entry_projects p
   where public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p.project_id);

  -- Active assigned Project Accountant projects (requires active ACCOUNTING department membership).
  v_accounting_member := public.org_department__internal_has_active_membership(
    p_app_user_id,
    'ACCOUNTING',
    v_today
  );

  if v_accounting_member then
    select coalesce(pg_catalog.array_agg(p.project_id order by p.project_id), array[]::text[])
      into v_accountant_project_ids
      from public.direct_entry_projects p
     where coalesce(
             (public.vendor_finance__internal_resolve_active_project_accountant(p.project_id, v_today)->>'accountant_active')::boolean,
             false
           )
       and (public.vendor_finance__internal_resolve_active_project_accountant(p.project_id, v_today)->>'accountant_user_id')::uuid = p_app_user_id;
  end if;

  v_is_project_manager := coalesce(pg_catalog.array_length(v_managed_project_ids, 1), 0) > 0;
  v_is_project_accountant := coalesce(pg_catalog.array_length(v_accountant_project_ids, 1), 0) > 0;

  return pg_catalog.jsonb_build_object(
    'allowed', (v_is_supervisory_viewer or v_is_project_manager or v_is_project_accountant),
    'is_project_manager', v_is_project_manager,
    'is_project_accountant', v_is_project_accountant,
    'is_supervisory_viewer', v_is_supervisory_viewer,
    'is_full_admin', v_is_full_admin,
    'is_bod', v_is_bod,
    'managed_project_ids', pg_catalog.to_jsonb(v_managed_project_ids),
    'accountant_project_ids', pg_catalog.to_jsonb(v_accountant_project_ids),
    'authorization_date', v_today::text
  );
end;
$function$;

create or replace function public.salary_advance__internal_request_access(
  p_auth jsonb,
  p_app_user_id uuid,
  p_req public.salary_advance_requests
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_acct_info jsonb;
  v_is_creator_pm boolean := false;
  v_is_assigned_accountant boolean := false;
  v_is_supervisory boolean := false;
  v_can_view boolean := false;
begin
  v_today := (p_auth->>'authorization_date')::date;
  v_is_supervisory := coalesce((p_auth->>'is_supervisory_viewer')::boolean, false);

  v_is_creator_pm := (p_req.created_by_user_id = p_app_user_id)
    and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_req.project_id);

  v_acct_info := public.vendor_finance__internal_resolve_active_project_accountant(
    p_req.project_id,
    v_today
  );

  v_is_assigned_accountant := coalesce((v_acct_info->>'accountant_active')::boolean, false)
    and (v_acct_info->>'accountant_user_id')::uuid = p_app_user_id;

  v_can_view := v_is_creator_pm or v_is_assigned_accountant or v_is_supervisory;

  return pg_catalog.jsonb_build_object(
    'can_view', v_can_view,
    'is_creator_project_manager', v_is_creator_pm,
    'is_assigned_project_accountant', v_is_assigned_accountant,
    'is_supervisory_viewer', v_is_supervisory,
    'current_project_accountant', case
      when coalesce((v_acct_info->>'accountant_active')::boolean, false) then
        pg_catalog.jsonb_build_object(
          'app_user_id', (v_acct_info->>'accountant_user_id')::uuid,
          'display_name', v_acct_info->>'accountant_display_name'
        )
      else null
    end,
    'allowed_actions', pg_catalog.jsonb_build_object(
      'can_post_message', (
        (v_is_creator_pm or v_is_assigned_accountant)
        and p_req.request_state in ('OPEN', 'NEEDS_INFO', 'APPROVED')
      ),
      'can_provide_info', (
        v_is_creator_pm
        and p_req.request_state = 'NEEDS_INFO'
      ),
      'can_withdraw', (
        v_is_creator_pm
        and p_req.request_state in ('OPEN', 'NEEDS_INFO')
      ),
      'can_upload_evidence', (
        v_is_creator_pm
        and p_req.request_state = 'APPROVED'
        and p_req.evidence_review_state in ('NOT_UPLOADED', 'RETAKE_REQUIRED', 'PENDING_REVIEW')
      ),
      'can_request_info', (
        v_is_assigned_accountant
        and p_req.request_state = 'OPEN'
      ),
      'can_approve', (
        v_is_assigned_accountant
        and p_req.request_state in ('OPEN', 'NEEDS_INFO')
      ),
      'can_reject', (
        v_is_assigned_accountant
        and p_req.request_state in ('OPEN', 'NEEDS_INFO')
      ),
      'can_mark_handled_externally', (
        v_is_assigned_accountant
        and p_req.request_state = 'APPROVED'
      ),
      'can_review_evidence', (
        v_is_assigned_accountant
        and p_req.request_state = 'APPROVED'
        and p_req.evidence_review_state = 'PENDING_REVIEW'
        and p_req.current_evidence_version >= 1
      )
    )
  );
end;
$function$;

create or replace function public.salary_advance__internal_project_request_summary(
  p_req public.salary_advance_requests,
  p_auth jsonb,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_access jsonb;
  v_portrait jsonb;
begin
  select e.*
    into v_entry
    from public.direct_entries e
   where e.entry_id = p_req.worker_entry_id;

  select pr.*
    into v_project
    from public.direct_entry_projects pr
   where pr.project_id = p_req.project_id;

  v_access := public.salary_advance__internal_request_access(p_auth, p_app_user_id, p_req);
  v_portrait := public.salary_advance__internal_resolve_worker_portrait(v_entry.candidate_id);

  return pg_catalog.jsonb_build_object(
    'request_id', p_req.request_id,
    'project_id', p_req.project_id,
    'project_display_name', coalesce(v_project.display_name, p_req.project_id),
    'worker_entry_id', p_req.worker_entry_id,
    'worker_employee_code', v_entry.employee_code,
    'worker_display_name', public.salary_advance__internal_worker_display_name(v_entry.worker_details),
    'worker_portrait', v_portrait,
    'requested_amount_vnd', p_req.requested_amount_vnd::text,
    'initial_content', p_req.initial_content,
    'request_state', p_req.request_state,
    'evidence_review_state', p_req.evidence_review_state,
    'version', p_req.version,
    'created_by_user_id', p_req.created_by_user_id,
    'created_by_display_name', public.salary_advance__internal_actor_display_name(p_req.created_by_user_id),
    'decided_by_user_id', p_req.decided_by_user_id,
    'decided_by_display_name', case
      when p_req.decided_by_user_id is not null
        then public.salary_advance__internal_actor_display_name(p_req.decided_by_user_id)
      else null
    end,
    'decided_at', case
      when p_req.decided_at is not null
        then pg_catalog.to_char(p_req.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      else null
    end,
    'decision_note', p_req.decision_note,
    'handled_externally_by_user_id', p_req.handled_externally_by_user_id,
    'handled_externally_by_display_name', case
      when p_req.handled_externally_by_user_id is not null
        then public.salary_advance__internal_actor_display_name(p_req.handled_externally_by_user_id)
      else null
    end,
    'handled_externally_at', case
      when p_req.handled_externally_at is not null
        then pg_catalog.to_char(p_req.handled_externally_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      else null
    end,
    'handled_externally_note', p_req.handled_externally_note,
    'withdrawn_by_user_id', p_req.withdrawn_by_user_id,
    'withdrawn_by_display_name', case
      when p_req.withdrawn_by_user_id is not null
        then public.salary_advance__internal_actor_display_name(p_req.withdrawn_by_user_id)
      else null
    end,
    'withdrawn_at', case
      when p_req.withdrawn_at is not null
        then pg_catalog.to_char(p_req.withdrawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      else null
    end,
    'withdrawn_note', p_req.withdrawn_note,
    'current_evidence', case
      when p_req.current_evidence_version >= 1 then
        pg_catalog.jsonb_build_object(
          'evidence_version', p_req.current_evidence_version,
          'mime_type', p_req.current_evidence_mime_type,
          'size_bytes', p_req.current_evidence_size_bytes,
          'checksum_sha256', p_req.current_evidence_checksum_sha256,
          'uploaded_by_user_id', p_req.current_evidence_uploaded_by_user_id,
          'uploaded_by_display_name', public.salary_advance__internal_actor_display_name(p_req.current_evidence_uploaded_by_user_id),
          'uploaded_at', pg_catalog.to_char(p_req.current_evidence_uploaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'reviewed_by_user_id', p_req.evidence_reviewed_by_user_id,
          'reviewed_by_display_name', case
            when p_req.evidence_reviewed_by_user_id is not null
              then public.salary_advance__internal_actor_display_name(p_req.evidence_reviewed_by_user_id)
            else null
          end,
          'reviewed_at', case
            when p_req.evidence_reviewed_at is not null
              then pg_catalog.to_char(p_req.evidence_reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            else null
          end,
          'review_note', p_req.evidence_review_note,
          'reviewed_worker_portrait_document_id', p_req.reviewed_worker_portrait_document_id,
          'reviewed_worker_portrait_version', p_req.reviewed_worker_portrait_version
        )
      else null
    end,
    'current_project_accountant', v_access->'current_project_accountant',
    'allowed_actions', v_access->'allowed_actions',
    'last_activity_at', pg_catalog.to_char(p_req.last_activity_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'created_at', pg_catalog.to_char(p_req.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at', pg_catalog.to_char(p_req.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
end;
$function$;

create or replace function public.salary_advance__internal_build_request_detail(
  p_req public.salary_advance_requests,
  p_auth jsonb,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_summary jsonb;
  v_events jsonb;
  v_evidence_versions jsonb;
begin
  v_summary := public.salary_advance__internal_project_request_summary(p_req, p_auth, p_app_user_id);

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'event_id', ev.event_id,
               'event_seq', ev.event_seq,
               'event_type', ev.event_type,
               'actor_user_id', ev.actor_user_id,
               'actor_display_name', public.salary_advance__internal_actor_display_name(ev.actor_user_id),
               'actor_role', ev.actor_role,
               'from_request_state', ev.from_request_state,
               'to_request_state', ev.to_request_state,
               'from_evidence_review_state', ev.from_evidence_review_state,
               'to_evidence_review_state', ev.to_evidence_review_state,
               'message_text', ev.message_text,
               'evidence_version', ev.evidence_version,
               'evidence_mime_type', ev.evidence_mime_type,
               'evidence_size_bytes', ev.evidence_size_bytes,
               'evidence_checksum_sha256', ev.evidence_checksum_sha256,
               'reviewed_worker_portrait_document_id', ev.reviewed_worker_portrait_document_id,
               'reviewed_worker_portrait_version', ev.reviewed_worker_portrait_version,
               'created_at', pg_catalog.to_char(ev.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             )
             order by ev.event_seq asc
           ),
           '[]'::jsonb
         )
    into v_events
    from public.salary_advance_events ev
   where ev.request_id = p_req.request_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'evidence_version', ev.evidence_version,
               'event_id', ev.event_id,
               'mime_type', ev.evidence_mime_type,
               'size_bytes', ev.evidence_size_bytes,
               'checksum_sha256', ev.evidence_checksum_sha256,
               'caption_note', ev.message_text,
               'uploaded_by_user_id', ev.actor_user_id,
               'uploaded_by_display_name', public.salary_advance__internal_actor_display_name(ev.actor_user_id),
               'uploaded_at', pg_catalog.to_char(ev.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             )
             order by ev.evidence_version desc
           ),
           '[]'::jsonb
         )
    into v_evidence_versions
    from public.salary_advance_events ev
   where ev.request_id = p_req.request_id
     and ev.event_type = 'EVIDENCE_UPLOADED';

  return pg_catalog.jsonb_build_object(
    'request', v_summary,
    'events', v_events,
    'evidence_versions', v_evidence_versions
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Public `service_role`-only RPCs (`public.salary_advance_*`).
-- -----------------------------------------------------------------------------

-- 4.1 Actor Context & Permitted Projects
create or replace function public.salary_advance_get_actor_context(
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
  v_managed_ids text[];
  v_accountant_ids text[];
  v_managed_projects jsonb := '[]'::jsonb;
  v_accountant_projects jsonb := '[]'::jsonb;
  v_supervisory_projects jsonb := '[]'::jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  if not coalesce((v_auth->>'allowed')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_today := (v_auth->>'authorization_date')::date;
  v_managed_ids := array(select pg_catalog.jsonb_array_elements_text(v_auth->'managed_project_ids'));
  v_accountant_ids := array(select pg_catalog.jsonb_array_elements_text(v_auth->'accountant_project_ids'));

  if coalesce(pg_catalog.array_length(v_managed_ids, 1), 0) > 0 then
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'project_id', p.project_id,
                 'display_name', p.display_name,
                 'active', p.active,
                 'has_active_accountant', coalesce((acct.info->>'accountant_active')::boolean, false),
                 'accountant_user_id', case
                   when coalesce((acct.info->>'accountant_active')::boolean, false)
                     then (acct.info->>'accountant_user_id')::uuid
                   else null
                 end,
                 'accountant_display_name', case
                   when coalesce((acct.info->>'accountant_active')::boolean, false)
                     then acct.info->>'accountant_display_name'
                   else null
                 end
               )
               order by p.project_id asc
             ),
             '[]'::jsonb
           )
      into v_managed_projects
      from public.direct_entry_projects p
      cross join lateral (
        select public.vendor_finance__internal_resolve_active_project_accountant(p.project_id, v_today) as info
      ) acct
     where p.project_id = any(v_managed_ids);
  end if;

  if coalesce(pg_catalog.array_length(v_accountant_ids, 1), 0) > 0 then
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'project_id', p.project_id,
                 'display_name', p.display_name,
                 'active', p.active
               )
               order by p.project_id asc
             ),
             '[]'::jsonb
           )
      into v_accountant_projects
      from public.direct_entry_projects p
     where p.project_id = any(v_accountant_ids);
  end if;

  if coalesce((v_auth->>'is_supervisory_viewer')::boolean, false) then
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'project_id', p.project_id,
                 'display_name', p.display_name,
                 'active', p.active
               )
               order by p.project_id asc
             ),
             '[]'::jsonb
           )
      into v_supervisory_projects
      from public.direct_entry_projects p;
  end if;

  return pg_catalog.jsonb_build_object(
    'app_user_id', p_app_user_id,
    'display_name', public.salary_advance__internal_actor_display_name(p_app_user_id),
    'is_project_manager', (v_auth->>'is_project_manager')::boolean,
    'is_project_accountant', (v_auth->>'is_project_accountant')::boolean,
    'is_supervisory_viewer', (v_auth->>'is_supervisory_viewer')::boolean,
    'is_full_admin', (v_auth->>'is_full_admin')::boolean,
    'is_bod', (v_auth->>'is_bod')::boolean,
    'managed_projects', v_managed_projects,
    'accountant_projects', v_accountant_projects,
    'supervisory_projects', v_supervisory_projects,
    'authorization_date', v_auth->>'authorization_date'
  );
end;
$function$;

-- 4.2 Scoped Worker Picker for Creating QLDA
create or replace function public.salary_advance_list_project_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_search text default null,
  p_cursor text default null,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_page_size integer;
  v_search text;
  v_cursor_code text := null;
  v_cursor_id uuid := null;
  v_items jsonb := '[]'::jsonb;
  v_total_fetched integer := 0;
  v_next_cursor text := null;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_search := public.salary_advance__internal_validate_text(
    p_search,
    1,
    120,
    true,
    'SALARY_ADVANCE_QUERY_INVALID'
  );

  if p_cursor is not null and pg_catalog.btrim(p_cursor) <> '' then
    if p_cursor !~ '^[^|]+\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_cursor_code := pg_catalog.split_part(p_cursor, '|', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
  end if;

  with eligible as (
    select e.entry_id as worker_entry_id,
           e.employee_code,
           public.salary_advance__internal_worker_display_name(e.worker_details) as display_name,
           pg_catalog.to_char(e.first_work_date, 'YYYY-MM-DD') as first_work_date,
           (public.salary_advance__internal_resolve_worker_portrait(e.candidate_id) is not null) as has_portrait
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
     where e.project_id = p_project_id
       and e.deleted_at is null
       and e.voided_at is null
       and s.state = 'SUBMITTED'
  ),
  filtered as (
    select w.*
      from eligible w
     where (
       v_search is null
       or pg_catalog.lower(w.employee_code) like '%' || pg_catalog.lower(v_search) || '%'
       or pg_catalog.lower(w.display_name) like '%' || pg_catalog.lower(v_search) || '%'
     )
       and (
         v_cursor_code is null
         or (w.employee_code, w.worker_entry_id::text) > (v_cursor_code, v_cursor_id::text)
       )
     order by w.employee_code asc, w.worker_entry_id asc
     limit v_page_size + 1
  ),
  trimmed as (
    select *
      from filtered
     order by employee_code asc, worker_entry_id asc
     limit v_page_size
  )
  select (select count(*)::integer from filtered),
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'worker_entry_id', t.worker_entry_id,
               'employee_code', t.employee_code,
               'display_name', t.display_name,
               'first_work_date', t.first_work_date,
               'has_portrait', t.has_portrait
             )
             order by t.employee_code asc, t.worker_entry_id asc
           ),
           '[]'::jsonb
         ),
         (
           select t2.employee_code || '|' || t2.worker_entry_id::text
             from trimmed t2
            order by t2.employee_code desc, t2.worker_entry_id desc
            limit 1
         )
    into v_total_fetched, v_items, v_next_cursor
    from trimmed t;

  return pg_catalog.jsonb_build_object(
    'project_id', p_project_id,
    'workers', v_items,
    'has_more', (v_total_fetched > v_page_size),
    'next_cursor', case when v_total_fetched > v_page_size then v_next_cursor else null end
  );
end;
$function$;

-- 4.3 List Salary Advance Requests (Scoped by Role & Queue)
create or replace function public.salary_advance_list_requests(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_queue text default null,
  p_project_id text default null,
  p_request_state text default null,
  p_evidence_review_state text default null,
  p_search text default null,
  p_cursor text default null,
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
  v_is_pm boolean;
  v_is_acct boolean;
  v_is_sup boolean;
  v_managed_ids text[];
  v_accountant_ids text[];
  v_queue text;
  v_page_size integer;
  v_search text;
  v_cursor_ts timestamptz := null;
  v_cursor_id uuid := null;
  v_total_fetched integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_next_cursor text := null;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  if not coalesce((v_auth->>'allowed')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_is_pm := (v_auth->>'is_project_manager')::boolean;
  v_is_acct := (v_auth->>'is_project_accountant')::boolean;
  v_is_sup := (v_auth->>'is_supervisory_viewer')::boolean;
  v_managed_ids := array(select pg_catalog.jsonb_array_elements_text(v_auth->'managed_project_ids'));
  v_accountant_ids := array(select pg_catalog.jsonb_array_elements_text(v_auth->'accountant_project_ids'));

  v_queue := coalesce(nullif(pg_catalog.btrim(coalesce(p_queue, '')), ''), 'ALL');
  if v_queue not in ('ALL', 'PM', 'ACCOUNTANT', 'SUPERVISORY') then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if v_queue = 'PM' and not v_is_pm then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;
  if v_queue = 'ACCOUNTANT' and not v_is_acct then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;
  if v_queue = 'SUPERVISORY' and not v_is_sup then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_project_id is not null and pg_catalog.btrim(p_project_id) <> '' then
    if p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
      raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
        using errcode = '22023';
    end if;

    if v_queue = 'PM' and not (p_project_id = any(v_managed_ids)) then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    elsif v_queue = 'ACCOUNTANT' and not (p_project_id = any(v_accountant_ids)) then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    elsif v_queue = 'ALL'
          and not v_is_sup
          and not (p_project_id = any(v_managed_ids))
          and not (p_project_id = any(v_accountant_ids)) then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    end if;
  end if;

  if p_request_state is not null
     and p_request_state not in (
       'OPEN',
       'NEEDS_INFO',
       'APPROVED',
       'REJECTED',
       'WITHDRAWN',
       'HANDLED_EXTERNALLY'
     ) then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_evidence_review_state is not null
     and p_evidence_review_state not in (
       'NOT_UPLOADED',
       'PENDING_REVIEW',
       'REVIEWED',
       'RETAKE_REQUIRED'
     ) then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_search := public.salary_advance__internal_validate_text(
    p_search,
    1,
    120,
    true,
    'SALARY_ADVANCE_QUERY_INVALID'
  );

  if p_cursor is not null and pg_catalog.btrim(p_cursor) <> '' then
    if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_cursor_ts := pg_catalog.split_part(p_cursor, '|', 1)::timestamptz;
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
  end if;

  with visible as (
    select r.*
      from public.salary_advance_requests r
      join public.direct_entries e
        on e.entry_id = r.worker_entry_id
     where (
       (v_queue = 'PM' and r.created_by_user_id = p_app_user_id and r.project_id = any(v_managed_ids))
       or (v_queue = 'ACCOUNTANT' and r.project_id = any(v_accountant_ids))
       or (v_queue = 'SUPERVISORY' and v_is_sup)
       or (
         v_queue = 'ALL'
         and (
           v_is_sup
           or r.project_id = any(v_accountant_ids)
           or (r.created_by_user_id = p_app_user_id and r.project_id = any(v_managed_ids))
         )
       )
     )
       and (p_project_id is null or r.project_id = p_project_id)
       and (p_request_state is null or r.request_state = p_request_state)
       and (p_evidence_review_state is null or r.evidence_review_state = p_evidence_review_state)
       and (
         v_search is null
         or pg_catalog.lower(e.employee_code) like '%' || pg_catalog.lower(v_search) || '%'
         or pg_catalog.lower(public.salary_advance__internal_worker_display_name(e.worker_details))
            like '%' || pg_catalog.lower(v_search) || '%'
       )
       and (
         v_cursor_ts is null
         or (r.last_activity_at, r.request_id::text) < (v_cursor_ts, v_cursor_id::text)
       )
     order by r.last_activity_at desc, r.request_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select *
      from visible
     order by last_activity_at desc, request_id desc
     limit v_page_size
  )
  select (select count(*)::integer from visible),
         coalesce(
           pg_catalog.jsonb_agg(
             public.salary_advance__internal_project_request_summary(t, v_auth, p_app_user_id)
             order by t.last_activity_at desc, t.request_id desc
           ),
           '[]'::jsonb
         ),
         (
           select pg_catalog.to_char(t2.last_activity_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                  || '|' || t2.request_id::text
             from trimmed t2
            order by t2.last_activity_at asc, t2.request_id asc
            limit 1
         )
    into v_total_fetched, v_items, v_next_cursor
    from trimmed t;

  return pg_catalog.jsonb_build_object(
    'requests', v_items,
    'has_more', (v_total_fetched > v_page_size),
    'next_cursor', case when v_total_fetched > v_page_size then v_next_cursor else null end
  );
end;
$function$;

-- 4.4 Get Request Detail & Timeline
create or replace function public.salary_advance_get_request_detail(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  if not coalesce((v_auth->>'allowed')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'can_view')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  return public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);
end;
$function$;

-- 4.5 Create Salary Advance Request (QLDA Only)
create or replace function public.salary_advance_create_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_worker_entry_id uuid,
  p_requested_amount_vnd text,
  p_initial_content text,
  p_idempotency_key text,
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
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_acct_info jsonb;
  v_entry public.direct_entries%rowtype;
  v_amount bigint;
  v_content text;
  v_now timestamptz := now();
  v_req public.salary_advance_requests%rowtype;
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  v_today := (v_auth->>'authorization_date')::date;

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'CREATE_REQUEST'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  select p.*
    into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id;

  if not found then
    raise exception 'SALARY_ADVANCE_PROJECT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not v_project.active then
    raise exception 'SALARY_ADVANCE_PROJECT_INACTIVE'
      using errcode = 'PT409';
  end if;

  v_acct_info := public.vendor_finance__internal_resolve_active_project_accountant(
    p_project_id,
    v_today
  );

  if not coalesce((v_acct_info->>'has_assignment')::boolean, false)
     or not coalesce((v_acct_info->>'accountant_active')::boolean, false) then
    raise exception 'SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED'
      using errcode = 'PT409';
  end if;

  if p_worker_entry_id is null then
    raise exception 'SALARY_ADVANCE_WORKER_INVALID'
      using errcode = '22023';
  end if;

  select e.*
    into v_entry
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
   where e.entry_id = p_worker_entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and s.state = 'SUBMITTED';

  if not found then
    raise exception 'SALARY_ADVANCE_WORKER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_entry.project_id <> p_project_id then
    raise exception 'SALARY_ADVANCE_WORKER_PROJECT_MISMATCH'
      using errcode = '22023';
  end if;

  v_amount := public.salary_advance__internal_parse_positive_amount(p_requested_amount_vnd);
  v_content := public.salary_advance__internal_validate_text(
    p_initial_content,
    1,
    2000,
    false,
    'SALARY_ADVANCE_CONTENT_INVALID'
  );

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  insert into public.salary_advance_requests (
    project_id,
    worker_entry_id,
    requested_amount_vnd,
    initial_content,
    request_state,
    evidence_review_state,
    version,
    created_by_user_id,
    last_activity_at,
    last_actor_user_id,
    created_at,
    updated_at
  ) values (
    p_project_id,
    p_worker_entry_id,
    v_amount,
    v_content,
    'OPEN',
    'NOT_UPLOADED',
    1,
    p_app_user_id,
    v_now,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_req;

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    created_at
  ) values (
    v_req.request_id,
    1,
    'REQUEST_CREATED',
    p_app_user_id,
    'PROJECT_MANAGER',
    null,
    'OPEN',
    null,
    'NOT_UPLOADED',
    v_content,
    v_now
  );

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'CREATE_REQUEST',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- 4.6 Post Message / Reply in Request Timeline
create or replace function public.salary_advance_post_message(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_message_text text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_is_pm boolean;
  v_is_acct boolean;
  v_actor_role text;
  v_message text;
  v_next_seq integer;
  v_new_req_state text;
  v_event_type text;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'POST_MESSAGE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  v_message := public.salary_advance__internal_validate_text(
    p_message_text,
    1,
    2000,
    false,
    'SALARY_ADVANCE_MESSAGE_REQUIRED'
  );

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  v_is_pm := coalesce((v_access->>'is_creator_project_manager')::boolean, false);
  v_is_acct := coalesce((v_access->>'is_assigned_project_accountant')::boolean, false);

  if not v_is_pm and not v_is_acct then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_actor_role := case when v_is_acct then 'PROJECT_ACCOUNTANT' else 'PROJECT_MANAGER' end;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.request_state not in ('OPEN', 'NEEDS_INFO', 'APPROVED') then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.request_state = 'NEEDS_INFO' and v_is_pm then
    v_new_req_state := 'OPEN';
    v_event_type := 'INFO_PROVIDED';
  else
    v_new_req_state := v_req.request_state;
    v_event_type := 'MESSAGE_POSTED';
  end if;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  update public.salary_advance_requests
     set request_state = v_new_req_state,
         version = v_req.version + 1,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
  returning * into v_req;

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    v_event_type,
    p_app_user_id,
    v_actor_role,
    case when v_event_type = 'INFO_PROVIDED' then 'NEEDS_INFO' else v_new_req_state end,
    v_new_req_state,
    v_req.evidence_review_state,
    v_req.evidence_review_state,
    v_message,
    v_now
  );

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'POST_MESSAGE',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- 4.7 Transition Request State (`REQUEST_INFO`, `PROVIDE_INFO`, `APPROVE`, `REJECT`, `WITHDRAW`, `MARK_HANDLED_EXTERNALLY`)
create or replace function public.salary_advance_transition_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_action text,
  p_expected_version integer,
  p_message_text text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_action text;
  v_idem_action text;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_is_pm boolean;
  v_is_acct boolean;
  v_actor_role text;
  v_note text;
  v_from_state text;
  v_to_state text;
  v_event_type text;
  v_next_seq integer;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_action := pg_catalog.upper(pg_catalog.btrim(coalesce(p_action, '')));
  v_idem_action := case v_action
    when 'REQUEST_INFO' then 'REQUEST_INFO'
    when 'PROVIDE_INFO' then 'PROVIDE_INFO'
    when 'APPROVE' then 'APPROVE_REQUEST'
    when 'REJECT' then 'REJECT_REQUEST'
    when 'WITHDRAW' then 'WITHDRAW_REQUEST'
    when 'MARK_HANDLED_EXTERNALLY' then 'MARK_HANDLED_EXTERNALLY'
    else null
  end;

  if v_idem_action is null then
    raise exception 'SALARY_ADVANCE_ACTION_INVALID'
      using errcode = '22023';
  end if;

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> v_idem_action
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  v_is_pm := coalesce((v_access->>'is_creator_project_manager')::boolean, false);
  v_is_acct := coalesce((v_access->>'is_assigned_project_accountant')::boolean, false);

  if v_action in ('REQUEST_INFO', 'APPROVE', 'REJECT', 'MARK_HANDLED_EXTERNALLY') then
    if not v_is_acct then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    v_actor_role := 'PROJECT_ACCOUNTANT';
  else
    if not v_is_pm then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    v_actor_role := 'PROJECT_MANAGER';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_from_state := v_req.request_state;

  if v_action = 'REQUEST_INFO' then
    if v_from_state <> 'OPEN' then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      2000,
      false,
      'SALARY_ADVANCE_MESSAGE_REQUIRED'
    );
    v_to_state := 'NEEDS_INFO';
    v_event_type := 'INFO_REQUESTED';

  elsif v_action = 'PROVIDE_INFO' then
    if v_from_state <> 'NEEDS_INFO' then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      2000,
      false,
      'SALARY_ADVANCE_MESSAGE_REQUIRED'
    );
    v_to_state := 'OPEN';
    v_event_type := 'INFO_PROVIDED';

  elsif v_action = 'APPROVE' then
    if v_from_state not in ('OPEN', 'NEEDS_INFO') then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      true,
      'SALARY_ADVANCE_NOTE_INVALID'
    );
    v_to_state := 'APPROVED';
    v_event_type := 'REQUEST_APPROVED';

  elsif v_action = 'REJECT' then
    if v_from_state not in ('OPEN', 'NEEDS_INFO') then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      false,
      'SALARY_ADVANCE_REASON_REQUIRED'
    );
    v_to_state := 'REJECTED';
    v_event_type := 'REQUEST_REJECTED';

  elsif v_action = 'WITHDRAW' then
    if v_from_state not in ('OPEN', 'NEEDS_INFO') then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      true,
      'SALARY_ADVANCE_NOTE_INVALID'
    );
    v_to_state := 'WITHDRAWN';
    v_event_type := 'REQUEST_WITHDRAWN';

  elsif v_action = 'MARK_HANDLED_EXTERNALLY' then
    if v_from_state <> 'APPROVED' then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      true,
      'SALARY_ADVANCE_NOTE_INVALID'
    );
    v_to_state := 'HANDLED_EXTERNALLY';
    v_event_type := 'HANDLED_EXTERNALLY_MARKED';
  end if;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  update public.salary_advance_requests
     set request_state = v_to_state,
         version = v_req.version + 1,
         decided_by_user_id = case
           when v_action in ('APPROVE', 'REJECT') then p_app_user_id
           else decided_by_user_id
         end,
         decided_at = case
           when v_action in ('APPROVE', 'REJECT') then v_now
           else decided_at
         end,
         decision_note = case
           when v_action in ('APPROVE', 'REJECT') then v_note
           else decision_note
         end,
         handled_externally_by_user_id = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then p_app_user_id
           else handled_externally_by_user_id
         end,
         handled_externally_at = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then v_now
           else handled_externally_at
         end,
         handled_externally_note = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then v_note
           else handled_externally_note
         end,
         withdrawn_by_user_id = case
           when v_action = 'WITHDRAW' then p_app_user_id
           else withdrawn_by_user_id
         end,
         withdrawn_at = case
           when v_action = 'WITHDRAW' then v_now
           else withdrawn_at
         end,
         withdrawn_note = case
           when v_action = 'WITHDRAW' then v_note
           else withdrawn_note
         end,
         pending_upload_id = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_id
         end,
         pending_upload_storage_key = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_storage_key
         end,
         pending_upload_mime_type = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_mime_type
         end,
         pending_upload_size_bytes = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_size_bytes
         end,
         pending_upload_checksum_sha256 = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_checksum_sha256
         end,
         pending_upload_caption_note = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_caption_note
         end,
         pending_upload_reserved_by_user_id = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_reserved_by_user_id
         end,
         pending_upload_expires_at = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_expires_at
         end,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
  returning * into v_req;

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    v_event_type,
    p_app_user_id,
    v_actor_role,
    v_from_state,
    v_to_state,
    v_req.evidence_review_state,
    v_req.evidence_review_state,
    v_note,
    v_now
  );

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    v_idem_action,
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- 4.8 Reserve Cash-Receipt Evidence Upload (Creating QLDA Only, After Approval)
create or replace function public.salary_advance_reserve_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_mime_type text,
  p_size_bytes integer,
  p_checksum_sha256 text,
  p_caption_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_caption text;
  v_checksum text;
  v_upload_id uuid;
  v_storage_key text;
  v_expires_at timestamptz;
  v_superseded_key text;
  v_payload jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'RESERVE_EVIDENCE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object(
      'superseded_storage_key', null,
      'replayed', true
    );
  end if;

  if p_request_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  if p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png') then
    raise exception 'SALARY_ADVANCE_EVIDENCE_MIME_INVALID'
      using errcode = '22023';
  end if;

  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 10485760 then
    raise exception 'SALARY_ADVANCE_EVIDENCE_SIZE_INVALID'
      using errcode = '22023';
  end if;

  v_checksum := pg_catalog.lower(pg_catalog.btrim(coalesce(p_checksum_sha256, '')));
  if v_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID'
      using errcode = '22023';
  end if;

  v_caption := public.salary_advance__internal_validate_text(
    p_caption_note,
    1,
    1000,
    true,
    'SALARY_ADVANCE_NOTE_INVALID'
  );

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'is_creator_project_manager')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_req.request_state <> 'APPROVED'
     or v_req.evidence_review_state not in ('NOT_UPLOADED', 'RETAKE_REQUIRED', 'PENDING_REVIEW') then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_superseded_key := v_req.pending_upload_storage_key;
  v_upload_id := gen_random_uuid();
  v_storage_key := 'salary-advance/requests/' || v_req.request_id::text || '/evidence/' || v_upload_id::text;
  v_expires_at := clock_timestamp() + interval '15 minutes';

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  update public.salary_advance_requests
     set pending_upload_id = v_upload_id,
         pending_upload_storage_key = v_storage_key,
         pending_upload_mime_type = p_mime_type,
         pending_upload_size_bytes = p_size_bytes,
         pending_upload_checksum_sha256 = v_checksum,
         pending_upload_caption_note = v_caption,
         pending_upload_reserved_by_user_id = p_app_user_id,
         pending_upload_expires_at = v_expires_at,
         updated_at = now()
   where request_id = v_req.request_id;

  v_payload := pg_catalog.jsonb_build_object(
    'request_id', v_req.request_id,
    'upload_id', v_upload_id,
    'expected_version', v_req.version,
    'storage_key', v_storage_key,
    'mime_type', p_mime_type,
    'size_bytes', p_size_bytes,
    'checksum_sha256', v_checksum,
    'expires_at', pg_catalog.to_char(v_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'RESERVE_EVIDENCE',
    v_fingerprint,
    v_payload,
    now()
  );

  return v_payload || pg_catalog.jsonb_build_object(
    'superseded_storage_key', v_superseded_key,
    'replayed', false
  );
end;
$function$;

-- 4.9 Get Evidence Finalize Context (Pre-promotion Check + Idempotent Replay)
create or replace function public.salary_advance_get_evidence_finalize_context(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_upload_id uuid,
  p_expected_version integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  if p_request_id is null or p_upload_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'FINALIZE_EVIDENCE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'REPLAYED',
      'result_payload', v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true)
    );
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'is_creator_project_manager')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_req.request_state <> 'APPROVED'
     or v_req.evidence_review_state not in ('NOT_UPLOADED', 'RETAKE_REQUIRED', 'PENDING_REVIEW') then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.pending_upload_id is null or v_req.pending_upload_id <> p_upload_id then
    raise exception 'SALARY_ADVANCE_UPLOAD_SUPERSEDED'
      using errcode = 'PT409';
  end if;

  if v_req.pending_upload_expires_at is null
     or v_req.pending_upload_expires_at <= clock_timestamp() then
    raise exception 'SALARY_ADVANCE_UPLOAD_EXPIRED'
      using errcode = 'PT409';
  end if;

  return pg_catalog.jsonb_build_object(
    'status', 'READY_TO_FINALIZE',
    'request_id', v_req.request_id,
    'upload_id', v_req.pending_upload_id,
    'expected_version', v_req.version,
    'storage_key', v_req.pending_upload_storage_key,
    'mime_type', v_req.pending_upload_mime_type,
    'size_bytes', v_req.pending_upload_size_bytes,
    'checksum_sha256', v_req.pending_upload_checksum_sha256
  );
end;
$function$;

-- 4.10 Finalize Cash-Receipt Evidence Upload (Commits New Version, Keeps `request_state = 'APPROVED'`)
create or replace function public.salary_advance_finalize_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_upload_id uuid,
  p_expected_version integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_next_seq integer;
  v_next_ev_version integer;
  v_from_ev_state text;
  v_event_id uuid;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'FINALIZE_EVIDENCE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null or p_upload_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'is_creator_project_manager')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_req.request_state <> 'APPROVED'
     or v_req.evidence_review_state not in ('NOT_UPLOADED', 'RETAKE_REQUIRED', 'PENDING_REVIEW') then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.pending_upload_id is null or v_req.pending_upload_id <> p_upload_id then
    raise exception 'SALARY_ADVANCE_UPLOAD_SUPERSEDED'
      using errcode = 'PT409';
  end if;

  if v_req.pending_upload_expires_at is null
     or v_req.pending_upload_expires_at <= clock_timestamp() then
    raise exception 'SALARY_ADVANCE_UPLOAD_EXPIRED'
      using errcode = 'PT409';
  end if;

  v_from_ev_state := v_req.evidence_review_state;
  v_next_ev_version := v_req.current_evidence_version + 1;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    evidence_version,
    evidence_storage_key,
    evidence_mime_type,
    evidence_size_bytes,
    evidence_checksum_sha256,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    'EVIDENCE_UPLOADED',
    p_app_user_id,
    'PROJECT_MANAGER',
    v_req.request_state,
    'APPROVED',
    v_from_ev_state,
    'PENDING_REVIEW',
    v_req.pending_upload_caption_note,
    v_next_ev_version,
    v_req.pending_upload_storage_key,
    v_req.pending_upload_mime_type,
    v_req.pending_upload_size_bytes,
    v_req.pending_upload_checksum_sha256,
    v_now
  )
  returning event_id into v_event_id;

  update public.salary_advance_requests
     set evidence_review_state = 'PENDING_REVIEW',
         current_evidence_version = v_next_ev_version,
         current_evidence_event_id = v_event_id,
         current_evidence_storage_key = v_req.pending_upload_storage_key,
         current_evidence_mime_type = v_req.pending_upload_mime_type,
         current_evidence_size_bytes = v_req.pending_upload_size_bytes,
         current_evidence_checksum_sha256 = v_req.pending_upload_checksum_sha256,
         current_evidence_uploaded_by_user_id = p_app_user_id,
         current_evidence_uploaded_at = v_now,
         evidence_reviewed_by_user_id = null,
         evidence_reviewed_at = null,
         evidence_review_note = null,
         reviewed_worker_portrait_document_id = null,
         reviewed_worker_portrait_version = null,
         pending_upload_id = null,
         pending_upload_storage_key = null,
         pending_upload_mime_type = null,
         pending_upload_size_bytes = null,
         pending_upload_checksum_sha256 = null,
         pending_upload_caption_note = null,
         pending_upload_reserved_by_user_id = null,
         pending_upload_expires_at = null,
         version = v_req.version + 1,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
  returning * into v_req;

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'FINALIZE_EVIDENCE',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- 4.11 Review Evidence (`REVIEWED` / `RETAKE_REQUIRED` with 4-Way Portrait OCC Lock)
create or replace function public.salary_advance_review_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_evidence_version integer,
  p_decision text,
  p_expected_worker_portrait_document_id uuid,
  p_expected_worker_portrait_version integer,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_decision text;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_entry public.direct_entries%rowtype;
  v_portrait jsonb;
  v_note text;
  v_next_seq integer;
  v_event_type text;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_decision := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
  if v_decision not in ('REVIEWED', 'RETAKE_REQUIRED') then
    raise exception 'SALARY_ADVANCE_DECISION_INVALID'
      using errcode = '22023';
  end if;

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'REVIEW_EVIDENCE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or p_evidence_version is null
     or p_evidence_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  -- Note is optional for both `REVIEWED` and `RETAKE_REQUIRED`.
  v_note := public.salary_advance__internal_validate_text(
    p_note,
    1,
    1000,
    true,
    'SALARY_ADVANCE_NOTE_INVALID'
  );

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'is_assigned_project_accountant')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_req.request_state <> 'APPROVED'
     or v_req.evidence_review_state <> 'PENDING_REVIEW'
     or v_req.current_evidence_version < 1 then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.current_evidence_version <> p_evidence_version then
    raise exception 'SALARY_ADVANCE_EVIDENCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_decision = 'REVIEWED' then
    if p_expected_worker_portrait_document_id is null
       or p_expected_worker_portrait_version is null
       or p_expected_worker_portrait_version < 1 then
      raise exception 'SALARY_ADVANCE_PORTRAIT_LOCK_INVALID'
        using errcode = '22023';
    end if;

    select e.*
      into v_entry
      from public.direct_entries e
     where e.entry_id = v_req.worker_entry_id;

    v_portrait := public.salary_advance__internal_resolve_worker_portrait(v_entry.candidate_id);
    if v_portrait is null then
      raise exception 'SALARY_ADVANCE_WORKER_PORTRAIT_MISSING'
        using errcode = 'PT409';
    end if;

    if (v_portrait->>'document_id')::uuid <> p_expected_worker_portrait_document_id
       or (v_portrait->>'version')::integer <> p_expected_worker_portrait_version then
      raise exception 'SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;

    v_event_type := 'EVIDENCE_REVIEWED';
  else
    v_event_type := 'EVIDENCE_RETAKE_REQUESTED';
  end if;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  -- `request_state` strictly stays `APPROVED` on both `REVIEWED` and `RETAKE_REQUIRED`.
  update public.salary_advance_requests
     set evidence_review_state = v_decision,
         evidence_reviewed_by_user_id = p_app_user_id,
         evidence_reviewed_at = v_now,
         evidence_review_note = v_note,
         reviewed_worker_portrait_document_id = case
           when v_decision = 'REVIEWED' then p_expected_worker_portrait_document_id
           else null
         end,
         reviewed_worker_portrait_version = case
           when v_decision = 'REVIEWED' then p_expected_worker_portrait_version
           else null
         end,
         version = v_req.version + 1,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
  returning * into v_req;

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    evidence_version,
    reviewed_worker_portrait_document_id,
    reviewed_worker_portrait_version,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    v_event_type,
    p_app_user_id,
    'PROJECT_ACCOUNTANT',
    'APPROVED',
    'APPROVED',
    'PENDING_REVIEW',
    v_decision,
    v_note,
    v_req.current_evidence_version,
    case when v_decision = 'REVIEWED' then p_expected_worker_portrait_document_id else null end,
    case when v_decision = 'REVIEWED' then p_expected_worker_portrait_version else null end,
    v_now
  );

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'REVIEW_EVIDENCE',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

-- 4.12 Server-Only Evidence Preview Context (Streams Committed Evidence Version)
create or replace function public.salary_advance_get_evidence_preview_context(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_evidence_version integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_target_version integer;
  v_ev public.salary_advance_events%rowtype;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  if not coalesce((v_auth->>'allowed')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'can_view')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_target_version := coalesce(p_evidence_version, v_req.current_evidence_version);
  if v_target_version is null or v_target_version < 1 then
    raise exception 'SALARY_ADVANCE_EVIDENCE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select ev.*
    into v_ev
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id
     and ev.event_type = 'EVIDENCE_UPLOADED'
     and ev.evidence_version = v_target_version
   limit 1;

  if not found or v_ev.evidence_storage_key is null then
    raise exception 'SALARY_ADVANCE_EVIDENCE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'request_id', v_req.request_id,
    'evidence_version', v_ev.evidence_version,
    'storage_key', v_ev.evidence_storage_key,
    'mime_type', v_ev.evidence_mime_type,
    'size_bytes', v_ev.evidence_size_bytes,
    'checksum_sha256', v_ev.evidence_checksum_sha256
  );
end;
$function$;

-- 4.13 Server-Only Worker Portrait Context (Strictly `WORKER_PORTRAIT` Only for Request's Worker)
create or replace function public.salary_advance_get_worker_portrait_context(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_document_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_entry public.direct_entries%rowtype;
  v_doc record;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  if not coalesce((v_auth->>'allowed')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'can_view')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  select e.*
    into v_entry
    from public.direct_entries e
   where e.entry_id = v_req.worker_entry_id;

  if not found or v_entry.candidate_id is null then
    raise exception 'SALARY_ADVANCE_WORKER_PORTRAIT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select cd.document_id,
         cd.version,
         dv.storage_key,
         cd.mime_type,
         cd.size_bytes,
         cd.checksum_sha256
    into v_doc
    from public.direct_entry_current_documents cd
    join public.direct_entry_document_versions dv
      on dv.document_id = cd.document_id
     and dv.candidate_id = cd.candidate_id
     and dv.document_type = 'WORKER_PORTRAIT'
   where cd.candidate_id = v_entry.candidate_id
     and cd.document_type = 'WORKER_PORTRAIT'
     and cd.upload_status = 'READY'
     and cd.validation_status = 'VALIDATED'
     and cd.scan_status in ('CLEAN', 'NOT_REQUIRED')
   limit 1;

  if not found or v_doc.storage_key is null or v_doc.checksum_sha256 is null then
    raise exception 'SALARY_ADVANCE_WORKER_PORTRAIT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if p_expected_document_id is not null and v_doc.document_id <> p_expected_document_id then
    raise exception 'SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  return pg_catalog.jsonb_build_object(
    'request_id', v_req.request_id,
    'worker_entry_id', v_req.worker_entry_id,
    'document_id', v_doc.document_id,
    'version', v_doc.version,
    'storage_key', v_doc.storage_key,
    'mime_type', v_doc.mime_type,
    'size_bytes', v_doc.size_bytes,
    'checksum_sha256', v_doc.checksum_sha256
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Owner alignment & internal helper privilege grants.
-- -----------------------------------------------------------------------------
do $align_salary_advance_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_rel_owner_oid oid;
  v_proc_owner_oid oid;
  v_tbl text;
  v_fn pg_catalog.regprocedure;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  foreach v_tbl in array array[
    'salary_advance_requests',
    'salary_advance_events',
    'salary_advance_idempotency'
  ] loop
    select c.relowner
      into v_rel_owner_oid
      from pg_catalog.pg_class c
     where c.oid = pg_catalog.to_regclass('public.' || v_tbl);

    if v_rel_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter table public.%I owner to %I', v_tbl, v_base_owner);
    end if;
  end loop;

  for v_fn, v_proc_owner_oid in
    select p.oid::pg_catalog.regprocedure, p.proowner
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'salary_advance%'
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_base_owner);
    end if;
  end loop;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname like 'salary_advance%'
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
      'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.org_department__internal_has_active_membership(uuid, text, date) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.vendor_finance__internal_resolve_active_project_accountant(text, date) to %I',
      v_owner
    );
  end loop;
end;
$align_salary_advance_owners$;

-- -----------------------------------------------------------------------------
-- 6. Strict table & function ACLs (`PUBLIC`, `anon`, `authenticated`, `service_role`).
-- -----------------------------------------------------------------------------
revoke all on table
  public.salary_advance_requests,
  public.salary_advance_events,
  public.salary_advance_idempotency
from public, anon, authenticated, service_role;

revoke all on function
  public.salary_advance__internal_immutable_guard(),
  public.salary_advance__internal_request_guard(),
  public.salary_advance__internal_parse_positive_amount(text),
  public.salary_advance__internal_validate_text(text, integer, integer, boolean, text),
  public.salary_advance__internal_actor_display_name(uuid),
  public.salary_advance__internal_worker_display_name(jsonb),
  public.salary_advance__internal_resolve_worker_portrait(uuid),
  public.salary_advance__internal_resolve_authority(uuid, uuid),
  public.salary_advance__internal_request_access(jsonb, uuid, public.salary_advance_requests),
  public.salary_advance__internal_project_request_summary(public.salary_advance_requests, jsonb, uuid),
  public.salary_advance__internal_build_request_detail(public.salary_advance_requests, jsonb, uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.salary_advance_get_actor_context(uuid, uuid),
  public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer),
  public.salary_advance_list_requests(uuid, uuid, text, text, text, text, text, text, integer),
  public.salary_advance_get_request_detail(uuid, uuid, uuid),
  public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text),
  public.salary_advance_post_message(uuid, uuid, uuid, integer, text, text, text),
  public.salary_advance_transition_request(uuid, uuid, uuid, text, integer, text, text, text),
  public.salary_advance_reserve_evidence(uuid, uuid, uuid, integer, text, integer, text, text, text, text),
  public.salary_advance_get_evidence_finalize_context(uuid, uuid, uuid, uuid, integer, text, text),
  public.salary_advance_finalize_evidence(uuid, uuid, uuid, uuid, integer, text, text),
  public.salary_advance_review_evidence(uuid, uuid, uuid, integer, integer, text, uuid, integer, text, text, text),
  public.salary_advance_get_evidence_preview_context(uuid, uuid, uuid, integer),
  public.salary_advance_get_worker_portrait_context(uuid, uuid, uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.salary_advance_get_actor_context(uuid, uuid),
  public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer),
  public.salary_advance_list_requests(uuid, uuid, text, text, text, text, text, text, integer),
  public.salary_advance_get_request_detail(uuid, uuid, uuid),
  public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text),
  public.salary_advance_post_message(uuid, uuid, uuid, integer, text, text, text),
  public.salary_advance_transition_request(uuid, uuid, uuid, text, integer, text, text, text),
  public.salary_advance_reserve_evidence(uuid, uuid, uuid, integer, text, integer, text, text, text, text),
  public.salary_advance_get_evidence_finalize_context(uuid, uuid, uuid, uuid, integer, text, text),
  public.salary_advance_finalize_evidence(uuid, uuid, uuid, uuid, integer, text, text),
  public.salary_advance_review_evidence(uuid, uuid, uuid, integer, integer, text, uuid, integer, text, text, text),
  public.salary_advance_get_evidence_preview_context(uuid, uuid, uuid, integer),
  public.salary_advance_get_worker_portrait_context(uuid, uuid, uuid, uuid)
to service_role;

-- -----------------------------------------------------------------------------
-- 7. Install-time fail-closed self-check.
-- -----------------------------------------------------------------------------
do $self_check$
declare
  v_unforced_rls integer;
  v_table_grants integer;
  v_bad_secdef integer;
  v_public_exec integer;
  v_service_exec integer;
  v_forbidden_cols integer;
  v_overload_count integer;
begin
  select count(*)::integer
    into v_unforced_rls
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'salary_advance_requests',
       'salary_advance_events',
       'salary_advance_idempotency'
     )
     and (not c.relrowsecurity or not c.relforcerowsecurity);

  if v_unforced_rls <> 0 then
    raise exception 'SALARY_ADVANCE_WP1_SELF_CHECK_RLS_FAILED (% tables)', v_unforced_rls;
  end if;

  select count(*)::integer
    into v_table_grants
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name like 'salary_advance_%'
     and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role');

  if v_table_grants <> 0 then
    raise exception 'SALARY_ADVANCE_WP1_SELF_CHECK_TABLE_GRANTS_FAILED (% grants)', v_table_grants;
  end if;

  -- Verify zero worker personal profile snapshot columns exist on salary_advance_* tables.
  select count(*)::integer
    into v_forbidden_cols
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('salary_advance_requests', 'salary_advance_events')
     and a.attnum > 0
     and not a.attisdropped
     and (
       a.attname like '%display_name%'
       or a.attname like '%employee_code%'
       or a.attname like '%national_id%'
       or a.attname like '%cccd%'
       or a.attname like '%phone%'
       or a.attname like '%address%'
       or a.attname like '%bank%'
       or a.attname like '%account_number%'
     );

  if v_forbidden_cols <> 0 then
    raise exception 'SALARY_ADVANCE_WP1_SELF_CHECK_FORBIDDEN_PII_COLUMNS (% columns)', v_forbidden_cols;
  end if;

  select count(*)::integer
    into v_bad_secdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'salary_advance%'
     and (
       not p.prosecdef
       or coalesce(pg_catalog.array_to_string(p.proconfig, ','), '') not like '%search_path=pg_catalog, public%'
     );

  if v_bad_secdef <> 0 then
    raise exception 'SALARY_ADVANCE_WP1_SELF_CHECK_SECDEF_FAILED (% functions)', v_bad_secdef;
  end if;

  select count(*)::integer
    into v_public_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'salary_advance%'
     and (
       pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );

  if v_public_exec <> 0 then
    raise exception 'SALARY_ADVANCE_WP1_SELF_CHECK_PUBLIC_EXEC_FAILED (% functions)', v_public_exec;
  end if;

  select count(*)::integer
    into v_service_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'salary_advance_%'
     and p.proname not like 'salary_advance\_\_internal\_%' escape '\'
     and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE');

  if v_service_exec <> 13 then
    raise exception 'SALARY_ADVANCE_WP1_SELF_CHECK_SERVICE_EXEC_FAILED (expected 13, got %)', v_service_exec;
  end if;

  select count(*)::integer
    into v_overload_count
    from (
      select p.proname
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname like 'salary_advance_%'
       group by p.proname
      having count(*) > 1
    ) d;

  if coalesce(v_overload_count, 0) <> 0 then
    raise exception 'SALARY_ADVANCE_WP1_SELF_CHECK_OVERLOAD_FAILED (% names)', v_overload_count;
  end if;
end;
$self_check$;

commit;
