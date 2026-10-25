-- Stage 1: Asynchronous backend CCCD QR extraction for worker profiles.
-- Preserves Android's record-first worker creation flow, stores QR extraction
-- status and candidate fields privately per CCCD document version, and supports
-- idempotent retry and optional OCC-guarded blank-field auto-fill.

begin;

create table public.direct_entry_cccd_qr_extractions (
  extraction_id uuid primary key default gen_random_uuid(),
  entry_id uuid not null
    references public.direct_entries(entry_id) on delete restrict,
  candidate_id uuid not null
    references public.direct_entry_candidates(candidate_id) on delete restrict,
  document_id uuid not null unique
    references public.direct_entry_document_versions(document_id) on delete restrict,
  document_type text not null
    check (document_type in ('CCCD_FRONT', 'CCCD_BACK')),
  document_version integer not null
    check (document_version >= 1),
  checksum_sha256 text not null
    check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null
    check (status in ('PENDING', 'SUCCEEDED', 'NO_QR_FOUND', 'INVALID_QR', 'FAILED_RETRYABLE')),
  error_code text
    check (
      error_code is null
      or (
        length(btrim(error_code)) between 1 and 64
        and error_code ~ '^[A-Z0-9_]+$'
      )
    ),
  error_field text
    check (
      error_field is null
      or error_field in (
        'payload',
        'national_id',
        'display_name',
        'date_of_birth',
        'gender',
        'address',
        'national_id_issued_at'
      )
    ),
  candidate_data jsonb,
  applied_fields text[] not null default '{}'::text[],
  skipped_fields text[] not null default '{}'::text[],
  attempts integer not null default 0
    check (attempts >= 0),
  last_idempotency_key text
    check (last_idempotency_key is null or length(btrim(last_idempotency_key)) between 1 and 128),
  created_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint direct_entry_cccd_qr_extractions_state_consistency_check check (
    (
      status = 'PENDING'
      and candidate_data is null
      and error_code is null
      and error_field is null
      and completed_at is null
    )
    or (
      status = 'SUCCEEDED'
      and candidate_data is not null
      and jsonb_typeof(candidate_data) = 'object'
      and candidate_data->>'source' = 'CCCD_QR'
      and candidate_data->>'authenticity' = 'UNVERIFIED_QR_TEXT'
      and (candidate_data->>'national_id') ~ '^[0-9]{12}$'
      and not (candidate_data ? 'legacy_national_id')
      and length(btrim(coalesce(candidate_data->>'display_name', ''))) between 1 and 256
      and length(btrim(coalesce(candidate_data->>'date_of_birth', ''))) between 1 and 10
      and (candidate_data->>'gender') in ('MALE', 'FEMALE', 'OTHER')
      and length(btrim(coalesce(candidate_data->>'address', ''))) between 1 and 1024
      and length(btrim(coalesce(candidate_data->>'national_id_issued_at', ''))) between 1 and 10
      and error_code is null
      and error_field is null
      and completed_at is not null
    )
    or (
      status in ('NO_QR_FOUND', 'INVALID_QR', 'FAILED_RETRYABLE')
      and candidate_data is null
      and error_code is not null
      and completed_at is not null
    )
  )
);

create index direct_entry_cccd_qr_extractions_entry_doc_idx
  on public.direct_entry_cccd_qr_extractions (entry_id, document_type, document_version desc);

alter table public.direct_entry_cccd_qr_extractions enable row level security;
alter table public.direct_entry_cccd_qr_extractions force row level security;
revoke all on table public.direct_entry_cccd_qr_extractions
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry__internal_assert_cccd_qr_read_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_scope text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id
     and e.deleted_at is null
     and e.voided_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  begin
    return public.direct_entry_assert_document_upload_access(
      p_auth_subject, p_app_user_id, p_entry_id
    );
  exception when insufficient_privilege then
    null;
  end;

  if not public.direct_entry_has_capability(p_app_user_id, 'document_view') then
    raise exception 'cccd qr read denied' using errcode = '42501';
  end if;

  v_scope := public.direct_entry_resolve_submission_read_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'document_view',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end if;
  if v_scope is null then
    raise exception 'cccd qr read denied' using errcode = '42501';
  end if;

  return v_scope;
end;
$function$;

revoke all on function public.direct_entry__internal_assert_cccd_qr_read_access(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry__internal_project_cccd_qr_extraction(
  p_row public.direct_entry_cccd_qr_extractions,
  p_worker_details jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_preview jsonb := null;
  v_worker jsonb := coalesce(p_worker_details, '{}'::jsonb);
begin
  if p_row.status = 'SUCCEEDED' and p_row.candidate_data is not null then
    v_preview := jsonb_build_object(
      'display_name', 'kept_existing',
      'national_id', case
        when 'national_id' = any(p_row.applied_fields) then 'applied_to_blank'
        when coalesce(v_worker->'national_id'->>'state', 'omitted') in ('omitted', 'unknown')
          then 'eligible_blank'
        else 'kept_existing'
      end,
      'date_of_birth', case
        when 'date_of_birth' = any(p_row.applied_fields) then 'applied_to_blank'
        when coalesce(v_worker->'date_of_birth'->>'state', 'omitted') in ('omitted', 'unknown')
          then 'eligible_blank'
        else 'kept_existing'
      end,
      'gender', case
        when 'gender' = any(p_row.applied_fields) then 'applied_to_blank'
        when coalesce(v_worker->'gender'->>'state', 'omitted') in ('omitted', 'unknown')
          then 'eligible_blank'
        else 'kept_existing'
      end,
      'address', case
        when 'address' = any(p_row.applied_fields) then 'applied_to_blank'
        when coalesce(v_worker->'address'->>'state', 'omitted') in ('omitted', 'unknown')
          then 'eligible_blank'
        else 'kept_existing'
      end,
      'national_id_issued_at', case
        when 'national_id_issued_at' = any(p_row.applied_fields) then 'applied_to_blank'
        when coalesce(v_worker->'national_id_issued_at'->>'state', 'omitted') in ('omitted', 'unknown')
          then 'eligible_blank'
        else 'kept_existing'
      end
    );
  end if;

  return jsonb_build_object(
    'extraction_id', p_row.extraction_id,
    'entry_id', p_row.entry_id,
    'document_id', p_row.document_id,
    'document_type', p_row.document_type,
    'document_version', p_row.document_version,
    'status', p_row.status,
    'error_code', p_row.error_code,
    'error_field', p_row.error_field,
    'candidate_data', p_row.candidate_data,
    'field_merge_preview', v_preview,
    'applied_fields', to_jsonb(coalesce(p_row.applied_fields, '{}'::text[])),
    'skipped_fields', to_jsonb(coalesce(p_row.skipped_fields, '{}'::text[])),
    'attempts', p_row.attempts,
    'created_at', to_char(p_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', to_char(p_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'completed_at', case
      when p_row.completed_at is null then null
      else to_char(p_row.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    end
  );
end;
$function$;

revoke all on function public.direct_entry__internal_project_cccd_qr_extraction(
  public.direct_entry_cccd_qr_extractions, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.direct_entry_prepare_cccd_qr_extraction(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_document_id uuid default null,
  p_document_type text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_document public.direct_entry_document_versions%rowtype;
  v_latest public.direct_entry_document_events%rowtype;
  v_obj public.direct_entry_document_objects%rowtype;
  v_extraction public.direct_entry_cccd_qr_extractions%rowtype;
begin
  if p_entry_id is null then
    raise exception 'entry required' using errcode = '22023';
  end if;
  if p_document_type is not null and p_document_type not in ('CCCD_FRONT', 'CCCD_BACK') then
    raise exception 'invalid cccd document type' using errcode = '22023';
  end if;

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id
     and e.deleted_at is null
     and e.voided_at is null
   for update;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  perform public.direct_entry_assert_document_upload_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );

  if p_document_id is not null then
    select * into v_document
      from public.direct_entry_document_versions d
     where d.document_id = p_document_id
       and d.candidate_id = v_entry.candidate_id
       and (p_document_type is null or d.document_type = p_document_type)
     for update;
  else
    select d.* into v_document
      from public.direct_entry_document_versions d
      join public.direct_entry_current_documents cd on cd.document_id = d.document_id
     where d.candidate_id = v_entry.candidate_id
       and d.document_type in ('CCCD_FRONT', 'CCCD_BACK')
       and (p_document_type is null or d.document_type = p_document_type)
       and d.mime_type in ('image/jpeg', 'image/png')
     order by
       case when d.document_type = 'CCCD_FRONT' then 0 else 1 end asc,
       d.version desc
     limit 1
     for update of d;
  end if;

  if not found or v_document.document_type not in ('CCCD_FRONT', 'CCCD_BACK') then
    raise exception 'cccd document not found' using errcode = 'P0002';
  end if;

  if v_document.mime_type not in ('image/jpeg', 'image/png') then
    raise exception 'cccd qr requires image document' using errcode = '22023';
  end if;

  select * into v_latest
    from public.direct_entry_document_events ev
   where ev.document_id = v_document.document_id
   order by ev.version desc
   limit 1;
  if not found
     or v_latest.upload_status <> 'READY'
     or v_latest.validation_status <> 'VALIDATED'
     or v_latest.scan_status not in ('CLEAN', 'NOT_REQUIRED') then
    raise exception 'cccd document not ready' using errcode = 'P0002';
  end if;

  select * into v_obj
    from public.direct_entry_document_objects o
   where o.document_id = v_document.document_id;
  if not found then
    raise exception 'cccd document object not found' using errcode = 'P0002';
  end if;

  select * into v_extraction
    from public.direct_entry_cccd_qr_extractions q
   where q.document_id = v_document.document_id
   for update;

  if not found then
    insert into public.direct_entry_cccd_qr_extractions (
      entry_id,
      candidate_id,
      document_id,
      document_type,
      document_version,
      checksum_sha256,
      status,
      error_code,
      error_field,
      candidate_data,
      applied_fields,
      skipped_fields,
      attempts,
      created_by_user_id
    ) values (
      v_entry.entry_id,
      v_entry.candidate_id,
      v_document.document_id,
      v_document.document_type,
      v_document.version,
      v_obj.checksum_sha256,
      'PENDING',
      null,
      null,
      null,
      '{}'::text[],
      '{}'::text[],
      0,
      p_app_user_id
    )
    returning * into v_extraction;
  end if;

  return jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'entry_version', v_entry.version,
    'document_id', v_document.document_id,
    'document_type', v_document.document_type,
    'document_version', v_document.version,
    'storage_key', v_document.storage_key,
    'mime_type', v_obj.mime_type,
    'size_bytes', v_obj.size_bytes,
    'checksum_sha256', v_obj.checksum_sha256,
    'extraction', public.direct_entry__internal_project_cccd_qr_extraction(
      v_extraction, v_entry.worker_details
    )
  );
end;
$function$;

revoke all on function public.direct_entry_prepare_cccd_qr_extraction(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_prepare_cccd_qr_extraction(uuid, uuid, uuid, uuid, text)
  to service_role;

create or replace function public.direct_entry_complete_cccd_qr_extraction(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_document_id uuid,
  p_status text,
  p_error_code text,
  p_error_field text,
  p_candidate_data jsonb,
  p_apply_blank_fields boolean default false,
  p_expected_entry_version integer default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_document public.direct_entry_document_versions%rowtype;
  v_latest public.direct_entry_document_events%rowtype;
  v_obj public.direct_entry_document_objects%rowtype;
  v_existing public.direct_entry_cccd_qr_extractions%rowtype;
  v_has_existing boolean := false;
  v_reused boolean := false;
  v_apply boolean := coalesce(p_apply_blank_fields, false);
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_candidate jsonb;
  v_next_worker jsonb;
  v_field text;
  v_field_state text;
  v_applied_fields text[] := '{}'::text[];
  v_skipped_fields text[] := '{}'::text[];
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
begin
  if p_entry_id is null or p_document_id is null then
    raise exception 'entry and document required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('SUCCEEDED', 'NO_QR_FOUND', 'INVALID_QR', 'FAILED_RETRYABLE') then
    raise exception 'invalid cccd qr status' using errcode = '22023';
  end if;
  if v_key is not null and length(v_key) > 128 then
    raise exception 'idempotency key too long' using errcode = '22023';
  end if;

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id
     and e.deleted_at is null
     and e.voided_at is null
   for update;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  v_scope := public.direct_entry_assert_document_upload_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );

  select * into v_document
    from public.direct_entry_document_versions d
   where d.document_id = p_document_id
     and d.candidate_id = v_entry.candidate_id
   for update;
  if not found or v_document.document_type not in ('CCCD_FRONT', 'CCCD_BACK') then
    raise exception 'cccd document not found' using errcode = 'P0002';
  end if;

  select * into v_latest
    from public.direct_entry_document_events ev
   where ev.document_id = v_document.document_id
   order by ev.version desc
   limit 1;
  if not found
     or v_latest.upload_status <> 'READY'
     or v_latest.validation_status <> 'VALIDATED'
     or v_latest.scan_status not in ('CLEAN', 'NOT_REQUIRED') then
    raise exception 'cccd document not ready' using errcode = 'P0002';
  end if;

  select * into v_obj
    from public.direct_entry_document_objects o
   where o.document_id = v_document.document_id;
  if not found then
    raise exception 'cccd document object not found' using errcode = 'P0002';
  end if;

  select * into v_existing
    from public.direct_entry_cccd_qr_extractions q
   where q.document_id = v_document.document_id
   for update;
  v_has_existing := found;

  -- Idempotent replay when the same idempotency key already completed this document
  if v_has_existing
     and v_existing.status in ('SUCCEEDED', 'NO_QR_FOUND', 'INVALID_QR')
     and v_existing.checksum_sha256 = v_obj.checksum_sha256
     and (
       not v_apply
       or (v_key is not null and v_existing.last_idempotency_key = v_key)
     ) then
    return jsonb_build_object(
      'entry_id', v_entry.entry_id,
      'entry_version', v_entry.version,
      'reused', true,
      'extraction', public.direct_entry__internal_project_cccd_qr_extraction(
        v_existing, v_entry.worker_details
      )
    );
  end if;

  -- Record or update extraction result unless already terminal with identical checksum
  if not v_has_existing
     or v_existing.status in ('PENDING', 'FAILED_RETRYABLE')
     or v_existing.checksum_sha256 <> v_obj.checksum_sha256 then

    if p_status = 'SUCCEEDED' then
      if p_candidate_data is null
         or jsonb_typeof(p_candidate_data) <> 'object'
         or p_candidate_data->>'source' <> 'CCCD_QR'
         or p_candidate_data->>'authenticity' <> 'UNVERIFIED_QR_TEXT'
         or coalesce(p_candidate_data->>'national_id', '') !~ '^[0-9]{12}$'
         or p_candidate_data ? 'legacy_national_id'
         or length(btrim(coalesce(p_candidate_data->>'display_name', ''))) not between 1 and 256
         or length(btrim(coalesce(p_candidate_data->>'date_of_birth', ''))) not between 1 and 10
         or coalesce(p_candidate_data->>'gender', '') not in ('MALE', 'FEMALE', 'OTHER')
         or length(btrim(coalesce(p_candidate_data->>'address', ''))) not between 1 and 1024
         or length(btrim(coalesce(p_candidate_data->>'national_id_issued_at', ''))) not between 1 and 10 then
        raise exception 'invalid cccd qr candidate payload' using errcode = '22023';
      end if;
    else
      if p_error_code is null
         or length(btrim(p_error_code)) not between 1 and 64
         or p_error_code !~ '^[A-Z0-9_]+$' then
        raise exception 'invalid cccd qr error code' using errcode = '22023';
      end if;
    end if;

    if not v_has_existing then
      insert into public.direct_entry_cccd_qr_extractions (
        entry_id,
        candidate_id,
        document_id,
        document_type,
        document_version,
        checksum_sha256,
        status,
        error_code,
        error_field,
        candidate_data,
        applied_fields,
        skipped_fields,
        attempts,
        last_idempotency_key,
        created_by_user_id,
        completed_at
      ) values (
        v_entry.entry_id,
        v_entry.candidate_id,
        v_document.document_id,
        v_document.document_type,
        v_document.version,
        v_obj.checksum_sha256,
        p_status,
        case when p_status = 'SUCCEEDED' then null else p_error_code end,
        case when p_status = 'SUCCEEDED' then null else p_error_field end,
        case when p_status = 'SUCCEEDED' then p_candidate_data else null end,
        '{}'::text[],
        case when p_status = 'SUCCEEDED' then array['display_name'] else '{}'::text[] end,
        1,
        v_key,
        p_app_user_id,
        clock_timestamp()
      )
      returning * into v_existing;
    else
      update public.direct_entry_cccd_qr_extractions
         set document_version = v_document.version,
             checksum_sha256 = v_obj.checksum_sha256,
             status = p_status,
             error_code = case when p_status = 'SUCCEEDED' then null else p_error_code end,
             error_field = case when p_status = 'SUCCEEDED' then null else p_error_field end,
             candidate_data = case when p_status = 'SUCCEEDED' then p_candidate_data else null end,
             skipped_fields = case
               when p_status = 'SUCCEEDED' and cardinality(skipped_fields) = 0
                 then array['display_name']
               else skipped_fields
             end,
             attempts = v_existing.attempts + 1,
             last_idempotency_key = coalesce(v_key, v_existing.last_idempotency_key),
             updated_at = clock_timestamp(),
             completed_at = clock_timestamp()
       where extraction_id = v_existing.extraction_id
       returning * into v_existing;
    end if;
  else
    v_reused := true;
  end if;

  -- Optional OCC-guarded blank-only auto-fill into direct_entries.worker_details
  if v_apply and v_existing.status = 'SUCCEEDED' and v_existing.candidate_data is not null then
    if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
      raise exception 'entry version conflict' using errcode = '40001';
    end if;

    v_candidate := v_existing.candidate_data;
    v_next_worker := v_entry.worker_details;
    v_skipped_fields := array['display_name'];

    foreach v_field in array array[
      'national_id',
      'date_of_birth',
      'gender',
      'address',
      'national_id_issued_at'
    ] loop
      v_field_state := coalesce(v_next_worker->v_field->>'state', 'omitted');
      if v_field_state in ('omitted', 'unknown')
         and v_candidate ? v_field
         and jsonb_typeof(v_candidate->v_field) = 'string'
         and length(btrim(v_candidate->>v_field)) > 0 then
        v_next_worker := jsonb_set(
          v_next_worker,
          array[v_field],
          jsonb_build_object('state', 'provided', 'value', v_candidate->>v_field),
          true
        );
        v_applied_fields := array_append(v_applied_fields, v_field);
      else
        v_skipped_fields := array_append(v_skipped_fields, v_field);
      end if;
    end loop;

    if cardinality(v_applied_fields) > 0 then
      if not public.direct_entry_valid_worker_details(v_next_worker) then
        raise exception 'invalid worker details after qr blank fill' using errcode = '22023';
      end if;

      v_before := public.direct_entry_entry_snapshot(p_entry_id);
      v_reason_id := public.direct_entry_reason(
        p_app_user_id, 'Auto-filled blank worker fields from CCCD QR'
      );

      update public.direct_entries
         set worker_details = v_next_worker,
             version = version + 1
       where entry_id = p_entry_id
       returning * into v_entry;

      v_after := public.direct_entry_entry_snapshot(p_entry_id);
      v_revision_id := public.direct_entry_write_revision(
        p_entry_id, p_app_user_id, v_reason_id,
        v_before, v_after, v_entry.version
      );
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
        scope_team_id, outcome, reason_id, revision_id, changed_fields
      ) values (
        p_auth_subject, p_app_user_id, 'cccd_qr_autofill_blank_fields', 'document_upload',
        p_entry_id::text, v_scope,
        case when v_scope = 'team' then v_entry.team_id else null end,
        'APPLIED', v_reason_id, v_revision_id, v_applied_fields
      );
      v_reused := false;
    end if;

    update public.direct_entry_cccd_qr_extractions
       set applied_fields = (
             select coalesce(array_agg(distinct f order by f), '{}'::text[])
               from unnest(v_existing.applied_fields || v_applied_fields) as f
           ),
           skipped_fields = v_skipped_fields,
           last_idempotency_key = coalesce(v_key, v_existing.last_idempotency_key),
           updated_at = clock_timestamp()
     where extraction_id = v_existing.extraction_id
     returning * into v_existing;
  end if;

  return jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'entry_version', v_entry.version,
    'reused', v_reused,
    'extraction', public.direct_entry__internal_project_cccd_qr_extraction(
      v_existing, v_entry.worker_details
    )
  );
end;
$function$;

revoke all on function public.direct_entry_complete_cccd_qr_extraction(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, boolean, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_complete_cccd_qr_extraction(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, boolean, integer, text
) to service_role;

create or replace function public.direct_entry_get_cccd_qr_extractions(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_document_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_extractions jsonb;
  v_latest jsonb;
  v_eligible jsonb;
begin
  if p_entry_id is null then
    raise exception 'entry required' using errcode = '22023';
  end if;

  perform public.direct_entry__internal_assert_cccd_qr_read_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id
     and e.deleted_at is null
     and e.voided_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  if p_document_id is not null and not exists (
    select 1
      from public.direct_entry_document_versions d
     where d.document_id = p_document_id
       and d.candidate_id = v_entry.candidate_id
       and d.document_type in ('CCCD_FRONT', 'CCCD_BACK')
  ) then
    raise exception 'cccd document not found' using errcode = 'P0002';
  end if;

  select coalesce(
           jsonb_agg(
             public.direct_entry__internal_project_cccd_qr_extraction(q, v_entry.worker_details)
             order by
               case when q.document_type = 'CCCD_FRONT' then 0 else 1 end asc,
               q.document_version desc
           ),
           '[]'::jsonb
         )
    into v_extractions
    from public.direct_entry_cccd_qr_extractions q
   where q.entry_id = v_entry.entry_id
     and (
       p_document_id is not null and q.document_id = p_document_id
       or (
         p_document_id is null
         and exists (
           select 1
             from public.direct_entry_current_documents cd
            where cd.document_id = q.document_id
              and cd.candidate_id = v_entry.candidate_id
         )
       )
     );

  v_latest := case
    when jsonb_array_length(v_extractions) > 0 then v_extractions->0
    else null
  end;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'document_id', cd.document_id,
               'document_type', cd.document_type,
               'document_version', cd.version,
               'mime_type', cd.mime_type
             )
             order by
               case when cd.document_type = 'CCCD_FRONT' then 0 else 1 end asc,
               cd.version desc
           ),
           '[]'::jsonb
         )
    into v_eligible
    from public.direct_entry_current_documents cd
   where cd.candidate_id = v_entry.candidate_id
     and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
     and cd.mime_type in ('image/jpeg', 'image/png')
     and (p_document_id is null or cd.document_id = p_document_id);

  return jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'entry_version', v_entry.version,
    'latest', v_latest,
    'extractions', v_extractions,
    'eligible_documents', v_eligible
  );
end;
$function$;

revoke all on function public.direct_entry_get_cccd_qr_extractions(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_cccd_qr_extractions(uuid, uuid, uuid, uuid)
  to service_role;

do $align_cccd_qr_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_proc record;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner_oid is not null
     and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter table public.direct_entry_cccd_qr_extractions owner to %I',
      v_base_owner
    );

    for v_proc in
      select p.oid::pg_catalog.regprocedure::text as sig
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in (
           'direct_entry__internal_assert_cccd_qr_read_access',
           'direct_entry__internal_project_cccd_qr_extraction',
           'direct_entry_prepare_cccd_qr_extraction',
           'direct_entry_complete_cccd_qr_extraction',
           'direct_entry_get_cccd_qr_extractions'
         )
    loop
      execute pg_catalog.format('alter function %s owner to %I', v_proc.sig, v_base_owner);
    end loop;
  end if;
end;
$align_cccd_qr_owners$;

revoke all on table public.direct_entry_cccd_qr_extractions
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry__internal_assert_cccd_qr_read_access(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry__internal_project_cccd_qr_extraction(
  public.direct_entry_cccd_qr_extractions, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_prepare_cccd_qr_extraction(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_prepare_cccd_qr_extraction(uuid, uuid, uuid, uuid, text)
  to service_role;
revoke all on function public.direct_entry_complete_cccd_qr_extraction(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, boolean, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_complete_cccd_qr_extraction(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, boolean, integer, text
) to service_role;
revoke all on function public.direct_entry_get_cccd_qr_extractions(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_cccd_qr_extractions(uuid, uuid, uuid, uuid)
  to service_role;

do $verify_cccd_qr_async_stage1$
declare
  v_table_oid oid := 'public.direct_entry_cccd_qr_extractions'::pg_catalog.regclass;
  v_rls boolean;
  v_force_rls boolean;
  v_policy_count integer;
  v_sig text;
  v_proc oid;
  v_secdef boolean;
  v_config text[];
begin
  select c.relrowsecurity, c.relforcerowsecurity
    into v_rls, v_force_rls
    from pg_catalog.pg_class c
   where c.oid = v_table_oid;
  select count(*)::integer
    into v_policy_count
    from pg_catalog.pg_policy pol
   where pol.polrelid = v_table_oid;

  if not coalesce(v_rls, false)
     or not coalesce(v_force_rls, false)
     or v_policy_count <> 0
     or pg_catalog.has_table_privilege('public', v_table_oid, 'SELECT,INSERT,UPDATE,DELETE')
     or pg_catalog.has_table_privilege('anon', v_table_oid, 'SELECT,INSERT,UPDATE,DELETE')
     or pg_catalog.has_table_privilege('authenticated', v_table_oid, 'SELECT,INSERT,UPDATE,DELETE')
     or pg_catalog.has_table_privilege('service_role', v_table_oid, 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'CCCD QR extractions table RLS/ACL boundary drift'
      using errcode = '55000';
  end if;

  foreach v_sig in array array[
    'public.direct_entry__internal_assert_cccd_qr_read_access(uuid, uuid, uuid)',
    'public.direct_entry__internal_project_cccd_qr_extraction(public.direct_entry_cccd_qr_extractions, jsonb)'
  ] loop
    v_proc := pg_catalog.to_regprocedure(v_sig);
    select p.prosecdef, p.proconfig into v_secdef, v_config
      from pg_catalog.pg_proc p where p.oid = v_proc;
    if v_proc is null
       or not coalesce(v_secdef, false)
       or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
       or pg_catalog.has_function_privilege('public', v_proc, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_proc, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_proc, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_proc, 'EXECUTE') then
      raise exception 'CCCD QR internal function boundary drift: %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array array[
    'public.direct_entry_prepare_cccd_qr_extraction(uuid, uuid, uuid, uuid, text)',
    'public.direct_entry_complete_cccd_qr_extraction(uuid, uuid, uuid, uuid, text, text, text, jsonb, boolean, integer, text)',
    'public.direct_entry_get_cccd_qr_extractions(uuid, uuid, uuid, uuid)'
  ] loop
    v_proc := pg_catalog.to_regprocedure(v_sig);
    select p.prosecdef, p.proconfig into v_secdef, v_config
      from pg_catalog.pg_proc p where p.oid = v_proc;
    if v_proc is null
       or not coalesce(v_secdef, false)
       or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
       or pg_catalog.has_function_privilege('public', v_proc, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_proc, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_proc, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_proc, 'EXECUTE') then
      raise exception 'CCCD QR service RPC boundary drift: %', v_sig
        using errcode = '55000';
    end if;
  end loop;
end;
$verify_cccd_qr_async_stage1$;

commit;
