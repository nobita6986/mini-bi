-- P1.6-W04-S04B-R2A: Cloudflare R2 direct upload lifecycle (forward-only).
-- Retires the worker callback path, records format validation without claiming a
-- malware scan, and adds RPC-only reservation/finalize/context boundaries.

alter table public.direct_entry_document_versions
  alter column checksum_sha256 drop not null;

do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select format('%I.%I', n.nspname, cl.relname) as table_name, c.conname
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
     where c.contype = 'c'
       and c.conrelid in (
         'public.direct_entry_document_versions'::regclass,
         'public.direct_entry_document_events'::regclass
       )
       and pg_get_constraintdef(c.oid) like '%scan_status%'
  loop
    execute format('alter table %s drop constraint %I', v_constraint.table_name, v_constraint.conname);
  end loop;
end;
$$;

alter table public.direct_entry_document_versions
  add constraint direct_entry_document_versions_scan_status_check
  check (scan_status in ('PENDING', 'CLEAN', 'REJECTED', 'NOT_REQUIRED'));

alter table public.direct_entry_document_events
  add constraint direct_entry_document_events_scan_status_check
  check (scan_status in ('PENDING', 'CLEAN', 'REJECTED', 'NOT_REQUIRED'));

alter table public.direct_entry_document_events
  add column validation_status text not null default 'PENDING'
  check (validation_status in ('PENDING', 'VALIDATED', 'REJECTED'));

-- Existing READY+CLEAN events passed the legacy lifecycle; mark them validated once.
alter table public.direct_entry_document_events
  disable trigger direct_entry_document_events_immutable;
update public.direct_entry_document_events
   set validation_status = 'VALIDATED'
 where upload_status in ('READY', 'SUPERSEDED') and scan_status = 'CLEAN';
alter table public.direct_entry_document_events
  enable trigger direct_entry_document_events_immutable;

alter table public.direct_entry_document_events
  add constraint direct_entry_document_events_ready_eligibility_check
  check (
    upload_status <> 'READY'
    or (validation_status = 'VALIDATED' and scan_status in ('CLEAN', 'NOT_REQUIRED'))
  );

create table public.direct_entry_document_objects (
  document_id uuid primary key
    references public.direct_entry_document_versions(document_id) on delete restrict,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  validated_at timestamptz not null default clock_timestamp()
);

alter table public.direct_entry_document_objects enable row level security;
alter table public.direct_entry_document_objects force row level security;
revoke all on table public.direct_entry_document_objects
  from public, anon, authenticated, service_role;
create trigger direct_entry_document_objects_immutable
  before update or delete on public.direct_entry_document_objects
  for each row execute function public.direct_entry_reject_immutable_change();

create or replace view public.direct_entry_current_documents
with (security_invoker = true) as
select document_id, candidate_id, document_type, version, idempotency_key,
       checksum_sha256, size_bytes, mime_type, upload_status, scan_status,
       attempts, created_by_user_id, created_at, supersedes_document_id,
       updated_at, validation_status
  from (
    select eligible_documents.*,
           row_number() over (
             partition by candidate_id, document_type
             order by version desc
           ) as current_rank
      from (
        select d.document_id, d.candidate_id, d.document_type, d.version,
               d.idempotency_key,
               coalesce(o.checksum_sha256, d.checksum_sha256) as checksum_sha256,
               d.size_bytes, d.mime_type,
               latest_event.upload_status, latest_event.scan_status,
               latest_event.attempts, d.created_by_user_id, d.created_at,
               d.supersedes_document_id, latest_event.created_at as updated_at,
               latest_event.validation_status
          from public.direct_entry_document_versions d
          left join public.direct_entry_document_objects o on o.document_id = d.document_id
          join lateral (
            select e.upload_status, e.scan_status, e.attempts, e.created_at,
                   e.validation_status
              from public.direct_entry_document_events e
             where e.document_id = d.document_id
             order by e.version desc
             limit 1
          ) latest_event on true
         where latest_event.upload_status = 'READY'
           and latest_event.validation_status = 'VALIDATED'
           and latest_event.scan_status in ('CLEAN', 'NOT_REQUIRED')
      ) eligible_documents
  ) current_documents
 where current_rank = 1;

create or replace function public.direct_entry_entry_snapshot(p_entry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'entry_id', e.entry_id,
    'submission_id', e.submission_id,
    'candidate_id', e.candidate_id,
    'created_by_user_id', e.created_by_user_id,
    'project_id', e.project_id,
    'first_work_date', e.first_work_date,
    'employee_code', e.employee_code,
    'worker_details', e.worker_details,
    'recruiter_id', e.recruiter_id,
    'team_id', e.team_id,
    'provider_type', e.provider_type,
    'labor_type', e.labor_type,
    'version', e.version,
    'deleted_at', e.deleted_at,
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date,
        'leave_date', st.leave_date, 'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = e.entry_id order by st.version desc limit 1
    ),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'size_bytes', d.size_bytes,
        'mime_type', d.mime_type, 'upload_status', latest.upload_status,
        'scan_status', latest.scan_status,
        'validation_status', latest.validation_status,
        'updated_at', latest.created_at
      ) order by d.document_type, d.version)
        from public.direct_entry_document_versions d
        join lateral (
          select ev.upload_status, ev.scan_status, ev.validation_status, ev.created_at
            from public.direct_entry_document_events ev
           where ev.document_id = d.document_id
           order by ev.version desc
           limit 1
        ) latest on true
       where d.candidate_id = e.candidate_id
    ), '[]'::jsonb),
    'payment', case when p.entry_id is null then null else jsonb_build_object(
      'state', p.state, 'account_number', p.account_number, 'bank_id', p.bank_id,
      'account_holder_name', p.account_holder_name, 'version', p.version
    ) end
  )
  from public.direct_entries e
  left join public.direct_entry_payments p on p.entry_id = e.entry_id
  where e.entry_id = p_entry_id
$$;

create or replace function public.direct_entry_read_projection(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_result jsonb;
  v_pii boolean;
  v_payment boolean;
  v_documents boolean;
begin
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date
  );
  v_pii := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'pii_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_payment := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'payment_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_documents := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'document_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_result := jsonb_build_object(
    'entry_id', v_entry.entry_id, 'submission_id', v_entry.submission_id,
    'project_id', v_entry.project_id, 'first_work_date', v_entry.first_work_date,
    'employee_code', v_entry.employee_code,
    'worker_details', case when v_pii then v_entry.worker_details else '{}'::jsonb end,
    'recruiter_id', v_entry.recruiter_id, 'team_id', v_entry.team_id,
    'provider_type', v_entry.provider_type, 'labor_type', v_entry.labor_type,
    'version', v_entry.version, 'scope_kind', v_scope,
    'payment', (
      select case when v_payment then jsonb_build_object(
        'state', p.state, 'account_number', p.account_number, 'bank_id', p.bank_id,
        'account_holder_name', p.account_holder_name, 'version', p.version
      ) else jsonb_build_object(
        'state', p.state,
        'account_number', case when p.account_number is null then null
          else repeat('•', greatest(length(p.account_number) - 4, 0)) || right(p.account_number, 4) end,
        'version', p.version
      ) end from public.direct_entry_payments p where p.entry_id = p_entry_id
    ),
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date, 'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = p_entry_id order by st.version desc limit 1
    ),
    'documents', case when v_documents then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'size_bytes', d.size_bytes, 'mime_type', d.mime_type,
        'upload_status', d.upload_status, 'scan_status', d.scan_status,
        'validation_status', d.validation_status,
        'created_at', d.created_at, 'updated_at', d.updated_at
      ) order by d.document_type, d.version), '[]'::jsonb)
        from public.direct_entry_current_documents d
       where d.candidate_id = v_entry.candidate_id
    ) else '[]'::jsonb end
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_reserve_document_direct_upload(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_document_type text,
  p_idempotency_key text,
  p_size_bytes bigint,
  p_mime_type text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_submission_state text;
  v_prior jsonb;
  v_document public.direct_entry_document_versions%rowtype;
  v_latest public.direct_entry_document_events%rowtype;
  v_document_id uuid := gen_random_uuid();
  v_version integer;
  v_supersedes uuid;
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_result jsonb;
begin
  if p_document_type not in ('CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT')
     or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_size_bytes is null or p_size_bytes not between 1 and 10485760
     or p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png') then
    raise exception 'invalid document reservation' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_payment_document_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'document_upload'
  );
  select state into v_submission_state from public.direct_entry_submissions
   where submission_id = v_entry.submission_id;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'document_direct_reserve', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'expected_version', p_expected_entry_version,
      'document_type', p_document_type, 'size', p_size_bytes,
      'mime', p_mime_type, 'reason', p_reason
    ))
  );
  if v_prior is not null then
    select * into v_document from public.direct_entry_document_versions d
     where d.document_id = (v_prior->>'document_id')::uuid;
    select * into v_latest from public.direct_entry_document_events e
     where e.document_id = v_document.document_id order by e.version desc limit 1;
    return jsonb_build_object(
      'document_id', v_document.document_id, 'version', v_document.version,
      'entry_version', v_entry.version, 'storage_key', v_document.storage_key,
      'upload_status', v_latest.upload_status, 'scan_status', v_latest.scan_status,
      'validation_status', v_latest.validation_status, 'reused', true
    );
  end if;
  if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  if v_submission_state = 'SUBMITTED' and
     (p_reason is null or length(btrim(p_reason)) not between 1 and 4000) then
    raise exception 'reason required for submitted document edit' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'document:' || v_entry.candidate_id::text || ':' || p_document_type, 0
  ));
  select coalesce(max(d.version), 0) + 1, (array_agg(d.document_id order by d.version desc))[1]
    into v_version, v_supersedes
    from public.direct_entry_document_versions d
   where d.candidate_id = v_entry.candidate_id and d.document_type = p_document_type;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(
    p_app_user_id, coalesce(p_reason, 'Draft document upload reserved')
  );
  insert into public.direct_entry_document_versions (
    document_id, candidate_id, document_type, version, idempotency_key, checksum_sha256,
    size_bytes, mime_type, storage_key, upload_status, scan_status,
    created_by_user_id, supersedes_document_id
  ) values (
    v_document_id, v_entry.candidate_id, p_document_type, v_version, p_idempotency_key, null,
    p_size_bytes, p_mime_type,
    'p1.6/' || v_entry.candidate_id::text || '/' || p_document_type || '/' ||
      v_version::text || '/' || v_document_id::text,
    'QUEUED', 'PENDING', p_app_user_id, v_supersedes
  );
  insert into public.direct_entry_document_events (
    document_id, upload_status, scan_status, attempts
  ) values (v_document_id, 'QUEUED', 'PENDING', 0);
  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'document_direct_reserve', 'document_upload',
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['document_metadata']
  );
  v_result := jsonb_build_object(
    'document_id', v_document_id, 'version', v_version,
    'entry_version', v_entry.version + 1,
    'storage_key', 'p1.6/' || v_entry.candidate_id::text || '/' || p_document_type || '/' ||
      v_version::text || '/' || v_document_id::text,
    'upload_status', 'QUEUED', 'scan_status', 'PENDING',
    'validation_status', 'PENDING', 'reused', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'document_direct_reserve', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_document_direct_context(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_document_id uuid,
  p_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_document public.direct_entry_document_versions%rowtype;
  v_latest public.direct_entry_document_events%rowtype;
begin
  if p_purpose not in ('finalize', 'download') then
    raise exception 'invalid document context purpose' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  if p_purpose = 'finalize' then
    perform public.direct_entry_assert_payment_document_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'document_upload'
    );
  else
    perform public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_entry.team_id, v_entry.first_work_date
    );
    if not exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = p_app_user_id and g.capability = 'document_view'
         and g.valid_from <= public.direct_entry_authorization_date()
         and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
    ) then
      raise exception 'document view denied' using errcode = '42501';
    end if;
  end if;
  select * into v_document from public.direct_entry_document_versions d
   where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  select * into v_latest from public.direct_entry_document_events e
   where e.document_id = p_document_id order by e.version desc limit 1;
  if p_purpose = 'download' and not (
    v_latest.upload_status = 'READY' and v_latest.validation_status = 'VALIDATED'
    and v_latest.scan_status in ('CLEAN', 'NOT_REQUIRED')
  ) then
    raise exception 'document not eligible' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'document_id', v_document.document_id, 'document_type', v_document.document_type,
    'version', v_document.version, 'storage_key', v_document.storage_key,
    'size_bytes', v_document.size_bytes, 'mime_type', v_document.mime_type,
    'upload_status', v_latest.upload_status, 'scan_status', v_latest.scan_status,
    'validation_status', v_latest.validation_status, 'entry_version', v_entry.version
  );
end;
$$;

create or replace function public.direct_entry_finalize_document_direct_upload(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_document_id uuid,
  p_expected_entry_version integer,
  p_idempotency_key text,
  p_outcome text,
  p_checksum_sha256 text,
  p_size_bytes bigint,
  p_mime_type text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_document public.direct_entry_document_versions%rowtype;
  v_latest public.direct_entry_document_events%rowtype;
  v_scope text;
  v_prior jsonb;
  v_hash text;
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_upload_status text;
  v_validation_status text;
  v_result jsonb;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_outcome not in ('validated', 'rejected')
     or (p_outcome = 'validated' and (
       p_checksum_sha256 is null or p_checksum_sha256 !~ '^[a-f0-9]{64}$'
       or p_size_bytes is null or p_size_bytes not between 1 and 10485760
       or p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png')
     )) then
    raise exception 'invalid document finalize' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_payment_document_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'document_upload'
  );
  select * into v_document from public.direct_entry_document_versions d
   where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id for update;
  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  v_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'entry_id', p_entry_id, 'document_id', p_document_id,
    'expected_version', p_expected_entry_version, 'outcome', p_outcome,
    'checksum', p_checksum_sha256, 'size', p_size_bytes, 'mime', p_mime_type
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'document_direct_finalize', p_idempotency_key, v_hash
  );
  if v_prior is not null then
    select * into v_latest from public.direct_entry_document_events e
     where e.document_id = p_document_id order by e.version desc limit 1;
    return v_prior || jsonb_build_object(
      'entry_version', v_entry.version, 'upload_status', v_latest.upload_status,
      'scan_status', v_latest.scan_status,
      'validation_status', v_latest.validation_status, 'reused', true
    );
  end if;
  select * into v_latest from public.direct_entry_document_events e
   where e.document_id = p_document_id order by e.version desc limit 1 for update;
  if v_latest.upload_status <> 'QUEUED' then
    raise exception 'document is not awaiting finalize' using errcode = '40001';
  end if;
  if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  if p_outcome = 'validated' and (
    v_document.size_bytes <> p_size_bytes or v_document.mime_type <> p_mime_type
  ) then
    raise exception 'document content does not match reservation' using errcode = '22023';
  end if;

  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(
    p_app_user_id, 'Direct document upload finalized'
  );
  if p_outcome = 'validated' then
    insert into public.direct_entry_document_objects (
      document_id, checksum_sha256, size_bytes, mime_type
    ) values (p_document_id, p_checksum_sha256, p_size_bytes, p_mime_type);
    v_upload_status := 'READY';
    v_validation_status := 'VALIDATED';
  else
    v_upload_status := 'FAILED';
    v_validation_status := 'REJECTED';
  end if;
  insert into public.direct_entry_document_events (
    document_id, version, idempotency_key, request_hash,
    upload_status, scan_status, attempts, validation_status
  ) values (
    p_document_id, v_latest.version + 1, 'finalize:' || p_idempotency_key, v_hash,
    v_upload_status, 'NOT_REQUIRED', v_latest.attempts, v_validation_status
  );
  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'document_direct_finalize', 'document_upload',
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['document_lifecycle']
  );
  v_result := jsonb_build_object(
    'document_id', p_document_id, 'version', v_document.version,
    'entry_version', v_entry.version + 1, 'upload_status', v_upload_status,
    'scan_status', 'NOT_REQUIRED', 'validation_status', v_validation_status,
    'reused', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'document_direct_finalize', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

-- Legacy worker/callback surface is retired; history stays intact.
drop function if exists public.direct_entry_apply_document_worker_callback(
  uuid, uuid, integer, integer, integer, text, text, bigint, text, text, text
);
revoke all on function public.direct_entry_reserve_document_upload(
  uuid, uuid, uuid, integer, text, text, text, bigint, text, text
) from public, anon, authenticated, service_role;

revoke all on function public.direct_entry_reserve_document_direct_upload(
  uuid, uuid, uuid, integer, text, text, bigint, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_document_direct_context(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_finalize_document_direct_upload(
  uuid, uuid, uuid, uuid, integer, text, text, text, bigint, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_reserve_document_direct_upload(
  uuid, uuid, uuid, integer, text, text, bigint, text, text
) to service_role;
grant execute on function public.direct_entry_document_direct_context(
  uuid, uuid, uuid, uuid, text
) to service_role;
grant execute on function public.direct_entry_finalize_document_direct_upload(
  uuid, uuid, uuid, uuid, integer, text, text, text, bigint, text
) to service_role;
