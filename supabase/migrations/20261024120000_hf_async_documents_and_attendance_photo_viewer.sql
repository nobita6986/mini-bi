-- HF: keep Android's record-first flow while allowing the record creator to
-- finish private attachment uploads after SUBMITTED, and expose attendance
-- photos only through an Admin/BoD service-role read boundary.

begin;

create or replace function public.direct_entry_assert_document_upload_access(
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
  v_submission_state text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null
   for update;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if v_submission_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  if v_submission_state = 'DRAFT' then
    begin
      perform public.direct_entry_assert_actor(
        p_auth_subject, p_app_user_id, 'document_upload'
      );
      return public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    exception when insufficient_privilege then
      if v_entry.created_by_user_id = p_app_user_id
         and public.direct_entry_actor_can_access_project(
           p_app_user_id, v_entry.project_id
         ) then
        return 'project';
      end if;
      raise;
    end;
  end if;

  if v_submission_state = 'REVIEW' then
    raise exception 'REVIEW submissions are read-only' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'document_upload'
  );

  -- Android persists the entry first and uploads its private attachments in
  -- the background. The creator keeps only their existing effective scope;
  -- every other SUBMITTED-entry uploader still needs privileged edit.
  if v_submission_state = 'SUBMITTED'
     and v_entry.created_by_user_id = p_app_user_id then
    return public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'document_upload',
      v_entry.created_by_user_id, v_entry.team_id,
      v_entry.first_work_date, null
    );
  end if;

  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit'
  );
  return public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'document_upload',
    v_entry.created_by_user_id, v_entry.team_id,
    v_entry.first_work_date, null
  );
end;
$function$;

revoke all on function public.direct_entry_assert_document_upload_access(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

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
as $function$
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
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_document_type not in (
       'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT', 'WORKER_PORTRAIT'
     )
     or (p_document_type = 'WORKER_PORTRAIT' and p_mime_type = 'application/pdf')
     or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_size_bytes is null or p_size_bytes not between 1 and 10485760
     or p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png') then
    raise exception 'invalid document reservation' using errcode = '22023';
  end if;

  select * into v_entry
    from public.direct_entries
   where entry_id = p_entry_id
   for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  v_scope := public.direct_entry_assert_document_upload_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );
  select state into v_submission_state
    from public.direct_entry_submissions
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
    select * into v_document
      from public.direct_entry_document_versions d
     where d.document_id = (v_prior->>'document_id')::uuid;
    select * into v_latest
      from public.direct_entry_document_events e
     where e.document_id = v_document.document_id
     order by e.version desc
     limit 1;
    return jsonb_build_object(
      'document_id', v_document.document_id, 'version', v_document.version,
      'entry_version', v_entry.version, 'storage_key', v_document.storage_key,
      'upload_status', v_latest.upload_status, 'scan_status', v_latest.scan_status,
      'validation_status', v_latest.validation_status, 'reused', true
    );
  end if;

  if p_expected_entry_version is null
     or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'document:' || v_entry.candidate_id::text || ':' || p_document_type, 0
  ));
  select coalesce(max(d.version), 0) + 1,
         (array_agg(d.document_id order by d.version desc))[1]
    into v_version, v_supersedes
    from public.direct_entry_document_versions d
   where d.candidate_id = v_entry.candidate_id
     and d.document_type = p_document_type;

  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(
    p_app_user_id,
    coalesce(
      p_reason,
      case
        when v_submission_state = 'SUBMITTED'
         and v_entry.created_by_user_id = p_app_user_id
          then 'Android background attachment upload'
      end
    )
  );

  insert into public.direct_entry_document_versions (
    document_id, candidate_id, document_type, version, idempotency_key,
    checksum_sha256, size_bytes, mime_type, storage_key, upload_status,
    scan_status, created_by_user_id, supersedes_document_id
  ) values (
    v_document_id, v_entry.candidate_id, p_document_type, v_version,
    p_idempotency_key, null, p_size_bytes, p_mime_type,
    'p1.6/' || v_entry.candidate_id::text || '/' || p_document_type || '/' ||
      v_version::text || '/' || v_document_id::text,
    'QUEUED', 'PENDING', p_app_user_id, v_supersedes
  );
  insert into public.direct_entry_document_events (
    document_id, upload_status, scan_status, attempts
  ) values (v_document_id, 'QUEUED', 'PENDING', 0);

  update public.direct_entries
     set version = version + 1
   where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id,
    v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'document_direct_reserve', 'document_upload',
    p_entry_id::text, v_scope,
    case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['document_metadata']
  );

  v_result := jsonb_build_object(
    'document_id', v_document_id, 'version', v_version,
    'entry_version', v_entry.version + 1,
    'storage_key', 'p1.6/' || v_entry.candidate_id::text || '/' ||
      p_document_type || '/' || v_version::text || '/' || v_document_id::text,
    'upload_status', 'QUEUED', 'scan_status', 'PENDING',
    'validation_status', 'PENDING', 'reused', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'document_direct_reserve', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

-- The direct-upload RPC already belongs to the reviewed service-role allowlist.
revoke all on function public.direct_entry_reserve_document_direct_upload(
  uuid, uuid, uuid, integer, text, text, bigint, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_reserve_document_direct_upload(
  uuid, uuid, uuid, integer, text, text, bigint, text, text
) to service_role;

create or replace function public.attendance_admin_checkin_photo(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_checkin_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_storage_key text;
begin
  perform public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if p_checkin_id is null then
    raise exception 'ATTENDANCE_REPORT_QUERY_INVALID' using errcode = '22023';
  end if;

  select c.photo_storage_key
    into v_storage_key
    from public.attendance_checkins c
   where c.checkin_id = p_checkin_id;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'photo_storage_key', v_storage_key
  );
end;
$function$;

comment on function public.attendance_admin_checkin_photo(uuid, uuid, uuid) is
  'Service-role-only resolver for a private attendance-photo R2 key after the canonical Admin/BoD report-reader authority check.';

do $align_attendance_photo_owner$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_photo_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  select p.proowner
    into v_photo_owner_oid
    from pg_catalog.pg_proc p
   where p.oid = 'public.attendance_admin_checkin_photo(uuid,uuid,uuid)'::pg_catalog.regprocedure;

  if v_photo_owner_oid is distinct from v_base_owner_oid
     and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter function public.attendance_admin_checkin_photo(uuid,uuid,uuid) owner to %I',
      v_base_owner
    );
  end if;
end;
$align_attendance_photo_owner$;

revoke all on function public.attendance_admin_checkin_photo(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_admin_checkin_photo(uuid, uuid, uuid)
  to service_role;

do $check_hf_async_documents_and_attendance_photo$
declare
  v_upload_guard pg_catalog.regprocedure :=
    'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)'::pg_catalog.regprocedure;
  v_reserve pg_catalog.regprocedure :=
    'public.direct_entry_reserve_document_direct_upload(uuid,uuid,uuid,integer,text,text,bigint,text,text)'::pg_catalog.regprocedure;
  v_photo_rpc pg_catalog.regprocedure :=
    'public.attendance_admin_checkin_photo(uuid,uuid,uuid)'::pg_catalog.regprocedure;
  v_guard_source text;
  v_reserve_source text;
  v_secdef boolean;
  v_config text;
  v_volatility "char";
begin
  select p.prosrc into v_guard_source
    from pg_catalog.pg_proc p where p.oid = v_upload_guard;
  select p.prosrc into v_reserve_source
    from pg_catalog.pg_proc p where p.oid = v_reserve;

  if pg_catalog.strpos(
       v_guard_source, 'v_submission_state = ''SUBMITTED'''
     ) = 0
     or pg_catalog.strpos(
       v_guard_source, 'v_entry.created_by_user_id = p_app_user_id'
     ) = 0
     or pg_catalog.strpos(
       v_reserve_source, 'Android background attachment upload'
     ) = 0 then
    raise exception 'Android background document-upload boundary drift'
      using errcode = '55000';
  end if;

  select p.prosecdef,
         coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
         p.provolatile
    into v_secdef, v_config, v_volatility
    from pg_catalog.pg_proc p
   where p.oid = v_photo_rpc;

  if not coalesce(v_secdef, false)
     or v_config <> 'search_path=pg_catalog, public'
     or v_volatility <> 's'
     or pg_catalog.has_function_privilege('public', v_photo_rpc, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_photo_rpc, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_photo_rpc, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_photo_rpc, 'EXECUTE') then
    raise exception 'Attendance photo RPC boundary drift'
      using errcode = '55000';
  end if;
end;
$check_hf_async_documents_and_attendance_photo$;

commit;
