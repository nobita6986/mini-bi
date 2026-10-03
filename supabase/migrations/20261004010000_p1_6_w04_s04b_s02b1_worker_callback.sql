create or replace view public.direct_entry_current_documents
with (security_invoker = true) as
select document_id, candidate_id, document_type, version, idempotency_key,
       checksum_sha256, size_bytes, mime_type, upload_status, scan_status,
       attempts, created_by_user_id, created_at, supersedes_document_id,
       updated_at
  from (
    select eligible_documents.*,
           row_number() over (
             partition by candidate_id, document_type
             order by version desc
           ) as current_rank
      from (
        select d.document_id, d.candidate_id, d.document_type, d.version,
               d.idempotency_key, d.checksum_sha256, d.size_bytes, d.mime_type,
               latest_event.upload_status, latest_event.scan_status,
               latest_event.attempts, d.created_by_user_id, d.created_at,
               d.supersedes_document_id, latest_event.created_at as updated_at
          from public.direct_entry_document_versions d
          join lateral (
            select e.upload_status, e.scan_status, e.attempts, e.created_at
              from public.direct_entry_document_events e
             where e.document_id = d.document_id
             order by e.version desc
             limit 1
          ) latest_event on true
         where latest_event.upload_status = 'READY'
           and latest_event.scan_status = 'CLEAN'
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
        'scan_status', latest.scan_status, 'updated_at', latest.created_at
      ) order by d.document_type, d.version)
        from public.direct_entry_document_versions d
        join lateral (
          select ev.upload_status, ev.scan_status, ev.created_at
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
        'created_at', d.created_at, 'updated_at', d.updated_at
      ) order by d.document_type, d.version), '[]'::jsonb)
        from public.direct_entry_current_documents d
       where d.candidate_id = v_entry.candidate_id
    ) else '[]'::jsonb end
  );
  return v_result;
end;
$$;

create or replace function public.direct_entry_reserve_document_upload(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_document_type text,
  p_idempotency_key text,
  p_checksum_sha256 text,
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
  v_result jsonb;
  v_storage_key text;
  v_latest public.direct_entry_document_events%rowtype;
  v_reused boolean;
begin
  select coalesce(i.result is not null, false) into v_reused
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = 'document_metadata_create'
     and i.idempotency_key = p_idempotency_key;
  v_reused := coalesce(v_reused, false);
  v_result := public.direct_entry_create_document_metadata(
    p_auth_subject, p_app_user_id, p_entry_id, p_expected_entry_version,
    p_document_type, p_idempotency_key, p_checksum_sha256, p_size_bytes,
    p_mime_type, p_reason
  );
  select d.storage_key into v_storage_key
    from public.direct_entry_document_versions d
   where d.document_id = (v_result->>'document_id')::uuid;
  select * into v_latest
    from public.direct_entry_document_events e
   where e.document_id = (v_result->>'document_id')::uuid
   order by e.version desc limit 1;
  if v_storage_key is null or v_latest.document_id is null then
    raise exception 'document reservation unavailable' using errcode = 'P0002';
  end if;
  return v_result || jsonb_build_object(
    'storage_key', v_storage_key,
    'upload_status', v_latest.upload_status,
    'scan_status', v_latest.scan_status,
    'event_sequence', v_latest.version,
    'attempts', v_latest.attempts,
    'attempt', case when v_latest.upload_status in ('QUEUED', 'FAILED')
      then v_latest.attempts + 1 else greatest(v_latest.attempts, 1) end,
    'reused', v_reused
  );
end;
$$;

create or replace function public.direct_entry_apply_document_worker_callback(
  p_callback_id uuid,
  p_document_id uuid,
  p_document_version integer,
  p_event_sequence integer,
  p_attempt integer,
  p_storage_object_ref text,
  p_checksum_sha256 text,
  p_size_bytes bigint,
  p_mime_type text,
  p_upload_outcome text,
  p_scan_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_document public.direct_entry_document_versions%rowtype;
  v_entry public.direct_entries%rowtype;
  v_latest public.direct_entry_document_events%rowtype;
  v_latest_event_id uuid;
  v_event_sequence integer;
  v_before jsonb;
  v_after jsonb;
  v_revision_id uuid;
  v_reason_id uuid;
  v_auth_subject uuid;
  v_prior jsonb;
  v_result jsonb;
  v_hash text;
  v_upload_status text;
  v_scan_status text;
  v_uploads text[] := array[]::text[];
  v_scans text[] := array[]::text[];
  v_index integer;
  v_key text;
begin
  if p_callback_id is null or p_document_id is null or
     p_document_version is null or p_document_version < 1 or
     p_event_sequence is null or p_event_sequence < 1 or
     p_attempt is null or p_attempt < 1 or p_attempt > 3 or
     p_storage_object_ref is null or length(p_storage_object_ref) not between 1 and 512 or
     p_checksum_sha256 is null or p_checksum_sha256 !~ '^[a-f0-9]{64}$' or
     p_size_bytes is null or p_size_bytes not between 1 and 10485760 or
     p_mime_type not in ('image/jpeg', 'image/png', 'application/pdf') or
     p_upload_outcome not in ('success', 'transient_failure') or
     p_scan_outcome not in ('pending', 'clean', 'infected', 'suspicious') or
     (p_upload_outcome = 'transient_failure' and p_scan_outcome <> 'pending') then
    raise exception 'invalid document callback' using errcode = '22023';
  end if;

  select * into v_document from public.direct_entry_document_versions d
   where d.document_id = p_document_id for update;
  if not found or v_document.version <> p_document_version or
     v_document.storage_key <> p_storage_object_ref or
     v_document.checksum_sha256 <> p_checksum_sha256 or
     v_document.size_bytes <> p_size_bytes or v_document.mime_type <> p_mime_type then
    raise exception 'document callback does not match reservation' using errcode = '42501';
  end if;
  select * into v_entry from public.direct_entries e
   where e.candidate_id = v_document.candidate_id and e.deleted_at is null
   for update;
  if not found then
    raise exception 'document entry not found' using errcode = 'P0002';
  end if;
  select auth_subject into v_auth_subject from public.direct_entry_app_users
   where app_user_id = v_document.created_by_user_id and enabled;
  if v_auth_subject is null then
    raise exception 'document owner unavailable' using errcode = '42501';
  end if;

  v_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'callback_id', p_callback_id, 'document_id', p_document_id,
    'document_version', p_document_version, 'event_sequence', p_event_sequence,
    'attempt', p_attempt, 'storage_object_ref', p_storage_object_ref,
    'checksum_sha256', p_checksum_sha256, 'size_bytes', p_size_bytes,
    'mime_type', p_mime_type, 'upload_outcome', p_upload_outcome,
    'scan_outcome', p_scan_outcome
  ));
  v_prior := public.direct_entry_idempotency_begin(
    v_document.created_by_user_id, 'document_worker_callback',
    p_callback_id::text, v_hash
  );
  if v_prior is not null then
    return v_prior || jsonb_build_object('reused', true);
  end if;

  select * into v_latest from public.direct_entry_document_events e
   where e.document_id = p_document_id
   order by e.version desc limit 1 for update;
  if not found then
    raise exception 'document event not found' using errcode = 'P0002';
  end if;
  if p_event_sequence <> v_latest.version then
    raise exception 'document event sequence conflict' using errcode = '40001';
  end if;
  if v_latest.upload_status in ('QUEUED', 'FAILED') then
    if v_latest.attempts >= 3 or p_attempt <> v_latest.attempts + 1 then
      raise exception 'document retry limit or attempt conflict' using errcode = '23514';
    end if;
    v_uploads := array_append(v_uploads, 'UPLOADING');
    v_scans := array_append(v_scans, 'PENDING');
    if p_upload_outcome = 'transient_failure' then
      v_uploads := array_append(v_uploads, 'FAILED');
      v_scans := array_append(v_scans, 'PENDING');
    else
      v_uploads := array_append(v_uploads, 'QUARANTINED');
      v_scans := array_append(v_scans, case when p_scan_outcome in ('infected', 'suspicious')
        then 'REJECTED' else 'PENDING' end);
      if p_scan_outcome = 'clean' then
        v_uploads := array_append(v_uploads, 'SCANNING');
        v_scans := array_append(v_scans, 'PENDING');
        v_uploads := array_append(v_uploads, 'READY');
        v_scans := array_append(v_scans, 'CLEAN');
      end if;
    end if;
  elsif v_latest.upload_status = 'QUARANTINED' and v_latest.scan_status = 'PENDING' then
    if p_upload_outcome <> 'success' or p_scan_outcome = 'pending' or
       p_attempt <> v_latest.attempts then
      raise exception 'invalid document scan callback' using errcode = '23514';
    end if;
    if p_scan_outcome = 'clean' then
      v_uploads := array['SCANNING', 'READY'];
      v_scans := array['PENDING', 'CLEAN'];
    else
      v_uploads := array['QUARANTINED'];
      v_scans := array['REJECTED'];
    end if;
  else
    raise exception 'document lifecycle is not awaiting callback' using errcode = '40001';
  end if;

  v_before := public.direct_entry_entry_snapshot(v_entry.entry_id);
  v_reason_id := public.direct_entry_reason(
    v_document.created_by_user_id, 'Trusted document worker lifecycle callback'
  );
  for v_index in 1..cardinality(v_uploads) loop
    v_event_sequence := v_latest.version + v_index;
    v_key := 'worker:' || p_callback_id::text || ':' || v_index::text;
    insert into public.direct_entry_document_events (
      document_id, version, idempotency_key, request_hash,
      upload_status, scan_status, attempts
    ) values (
      p_document_id, v_event_sequence, v_key,
      public.direct_entry_payload_hash(jsonb_build_object(
        'callback_hash', v_hash, 'transition', v_index
      )),
      v_uploads[v_index], v_scans[v_index], p_attempt
    ) returning event_id into v_latest_event_id;
  end loop;
  v_upload_status := v_uploads[cardinality(v_uploads)];
  v_scan_status := v_scans[cardinality(v_scans)];

  update public.direct_entries
     set version = version + 1, updated_at = clock_timestamp()
   where entry_id = v_entry.entry_id;
  v_after := public.direct_entry_entry_snapshot(v_entry.entry_id);
  v_revision_id := public.direct_entry_write_revision(
    v_entry.entry_id, v_document.created_by_user_id, v_reason_id,
    v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    outcome, reason_id, revision_id, changed_fields
  ) values (
    v_auth_subject, v_document.created_by_user_id, 'document_worker_callback',
    'document_upload', v_entry.entry_id::text, 'APPLIED', v_reason_id,
    v_revision_id, array['document_lifecycle']
  );
  v_result := jsonb_build_object(
    'document_id', p_document_id,
    'document_version', p_document_version,
    'entry_version', v_entry.version + 1,
    'event_sequence', v_event_sequence,
    'attempts', p_attempt,
    'upload_status', v_upload_status,
    'scan_status', v_scan_status,
    'reused', false
  );
  perform public.direct_entry_idempotency_finish(
    v_document.created_by_user_id, 'document_worker_callback',
    p_callback_id::text, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.direct_entry_apply_document_worker_callback(
  uuid, uuid, integer, integer, integer, text, text, bigint, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_apply_document_worker_callback(
  uuid, uuid, integer, integer, integer, text, text, bigint, text, text, text
) to service_role;
