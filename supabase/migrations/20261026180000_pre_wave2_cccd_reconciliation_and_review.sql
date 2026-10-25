-- Pre-Wave-2: CCCD QR reconciliation, worker profile 1.2 contract (CCCD required,
-- personal fields optional for Form/Android while keeping Grid 1.0/1.1 untouched),
-- sequential CCCD_FRONT/CCCD_BACK OCC compatibility after blank-only QR autofill,
-- and scoped CCCD Review queue + direct resolution RPCs.

begin;

alter table public.direct_entry_cccd_qr_extractions
  add column reconciliation_status text not null default 'PENDING'
    check (reconciliation_status in (
      'PENDING',
      'MATCHED_INITIAL',
      'MISMATCH',
      'QR_UNREADABLE',
      'RESOLVED_FROM_QR',
      'RESOLVED_EDITED_CCCD'
    ));

create table public.direct_entry_cccd_reconciliations (
  entry_id uuid primary key
    references public.direct_entries(entry_id) on delete restrict,
  candidate_id uuid not null
    references public.direct_entry_candidates(candidate_id) on delete restrict,
  status text not null
    check (status in (
      'PENDING',
      'MATCHED_INITIAL',
      'MISMATCH',
      'QR_UNREADABLE',
      'RESOLVED_FROM_QR',
      'RESOLVED_EDITED_CCCD'
    )),
  entered_national_id text
    check (entered_national_id is null or entered_national_id ~ '^[0-9]{9,12}$'),
  qr_national_id text
    check (qr_national_id is null or qr_national_id ~ '^[0-9]{12}$'),
  matched_document_id uuid
    references public.direct_entry_document_versions(document_id) on delete set null,
  matched_document_type text
    check (matched_document_type is null or matched_document_type in ('CCCD_FRONT', 'CCCD_BACK')),
  matched_document_version integer
    check (matched_document_version is null or matched_document_version >= 1),
  extracted_fields jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(extracted_fields) = 'object'
      and not (extracted_fields ? 'legacy_national_id')
    ),
  auto_applied_fields text[] not null default '{}'::text[],
  last_error_code text
    check (
      last_error_code is null
      or (
        length(btrim(last_error_code)) between 1 and 64
        and last_error_code ~ '^[A-Z0-9_]+$'
      )
    ),
  last_error_field text
    check (
      last_error_field is null
      or last_error_field in (
        'payload',
        'national_id',
        'display_name',
        'date_of_birth',
        'gender',
        'address',
        'national_id_issued_at'
      )
    ),
  resolved_at timestamptz,
  resolved_by_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  resolution_action text
    check (
      resolution_action is null
      or resolution_action in ('AUTO_MATCHED_INITIAL', 'STANDARDIZE_FROM_QR', 'UPDATE_ENTERED_CCCD')
    ),
  resolution_note text
    check (resolution_note is null or length(btrim(resolution_note)) between 1 and 4000),
  last_idempotency_key text
    check (last_idempotency_key is null or length(btrim(last_idempotency_key)) between 1 and 128),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index direct_entry_cccd_reconciliations_status_updated_idx
  on public.direct_entry_cccd_reconciliations (status, updated_at desc);

alter table public.direct_entry_cccd_reconciliations enable row level security;
alter table public.direct_entry_cccd_reconciliations force row level security;
revoke all on table public.direct_entry_cccd_reconciliations
  from public, anon, authenticated, service_role;

-- Internal helper: check whether the only revisions between p_expected_version
-- and p_actual_version on p_entry_id were background QR blank-field autofills
-- or sibling CCCD document reservations/finalizations by the same upload flow.
create or replace function public.direct_entry__internal_version_compatible_after_qr_autofill(
  p_entry_id uuid,
  p_expected_version integer,
  p_actual_version integer
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_rev record;
begin
  if p_expected_version is null or p_actual_version is null then
    return false;
  end if;
  if p_expected_version = p_actual_version then
    return true;
  end if;
  if p_expected_version > p_actual_version then
    return false;
  end if;

  for v_rev in
    select r.revision_id, r.version
      from public.direct_entry_revisions r
     where r.entry_id = p_entry_id
       and r.version > p_expected_version
       and r.version <= p_actual_version
     order by r.version asc
  loop
    if not exists (
      select 1
        from public.direct_entry_audit_events a
       where a.revision_id = v_rev.revision_id
         and a.resource_ref = p_entry_id::text
         and a.action = 'cccd_qr_autofill_blank_fields'
    ) then
      return false;
    end if;
  end loop;

  return true;
end;
$function$;

revoke all on function public.direct_entry__internal_version_compatible_after_qr_autofill(
  uuid, integer, integer
) from public, anon, authenticated, service_role;

-- Internal helper: resolve whether an actor can view and act on an entry in the
-- CCCD Review queue. Supports full admin, privileged edit in scope, assigned PM,
-- current team leader for the entry's team, and the entry creator (created_by_user_id).
create or replace function public.direct_entry__internal_resolve_cccd_review_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_project_id text,
  p_is_full_admin boolean,
  p_team_leader_team_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth text;
begin
  v_auth := public.direct_entry_resolve_direct_edit_authority(
    p_auth_subject,
    p_app_user_id,
    p_entry_owner,
    p_team_id,
    p_project_id,
    p_is_full_admin,
    p_team_leader_team_id
  );
  if v_auth is not null then
    return v_auth;
  end if;

  if p_entry_owner = p_app_user_id then
    return 'creator_own';
  end if;

  if public.direct_entry_has_entry_access(
       p_app_user_id, 'entry_admin', p_entry_owner, p_team_id, null
     )
     or public.direct_entry_has_entry_access(
       p_app_user_id, 'change_review', p_entry_owner, p_team_id, null
     ) then
    if public.direct_entry_has_scope(p_app_user_id, 'all') then
      return 'all';
    elsif p_team_id is not null then
      return 'team';
    end if;
  end if;

  return null;
end;
$function$;

revoke all on function public.direct_entry__internal_resolve_cccd_review_authority(
  uuid, uuid, uuid, uuid, text, boolean, uuid
) from public, anon, authenticated, service_role;

-- Internal helper: project an entry-level CCCD reconciliation row.
create or replace function public.direct_entry__internal_project_cccd_reconciliation(
  p_row public.direct_entry_cccd_reconciliations
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if p_row.entry_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'entry_id', p_row.entry_id,
    'status', p_row.status,
    'entered_national_id', p_row.entered_national_id,
    'entered_national_id_masked', case
      when p_row.entered_national_id is not null and length(p_row.entered_national_id) >= 4
        then '••••••••' || right(p_row.entered_national_id, 4)
      else null
    end,
    'qr_national_id', p_row.qr_national_id,
    'qr_national_id_masked', case
      when p_row.qr_national_id is not null and length(p_row.qr_national_id) >= 4
        then '••••••••' || right(p_row.qr_national_id, 4)
      else null
    end,
    'matched_document_id', p_row.matched_document_id,
    'matched_document_type', p_row.matched_document_type,
    'matched_document_version', p_row.matched_document_version,
    'extracted_fields', coalesce(p_row.extracted_fields, '{}'::jsonb),
    'auto_applied_fields', to_jsonb(coalesce(p_row.auto_applied_fields, '{}'::text[])),
    'last_error_code', p_row.last_error_code,
    'last_error_field', p_row.last_error_field,
    'resolved_at', case
      when p_row.resolved_at is null then null
      else to_char(p_row.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    end,
    'resolved_by_user_id', p_row.resolved_by_user_id,
    'resolution_action', p_row.resolution_action,
    'resolution_note', p_row.resolution_note,
    'updated_at', to_char(p_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$function$;

revoke all on function public.direct_entry__internal_project_cccd_reconciliation(
  public.direct_entry_cccd_reconciliations
) from public, anon, authenticated, service_role;

-- Internal helper: recompute entry-level CCCD reconciliation state from the
-- latest current CCCD_FRONT and CCCD_BACK documents and their QR extractions.
-- Prioritizes any current side with SUCCEEDED QR so a non-QR side (NO_QR_FOUND)
-- never overwrites a MATCHED_INITIAL, MISMATCH, or RESOLVED_* state.
create or replace function public.direct_entry__internal_recompute_cccd_reconciliation(
  p_entry_id uuid,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_existing public.direct_entry_cccd_reconciliations%rowtype;
  v_has_existing boolean := false;
  v_entered_cccd text;
  v_best_qr record;
  v_has_best_qr boolean := false;
  v_latest_failed record;
  v_has_latest_failed boolean := false;
  v_current_cccd_count integer := 0;
  v_pending_cccd_count integer := 0;
  v_status text := 'PENDING';
  v_qr_cccd text := null;
  v_matched_doc_id uuid := null;
  v_matched_doc_type text := null;
  v_matched_doc_version integer := null;
  v_extracted_fields jsonb := '{}'::jsonb;
  v_auto_applied text[] := '{}'::text[];
  v_error_code text := null;
  v_error_field text := null;
  v_resolved_at timestamptz := null;
  v_resolved_by uuid := null;
  v_resolution_action text := null;
  v_resolution_note text := null;
begin
  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id
     and e.deleted_at is null;
  if not found then
    return null;
  end if;

  v_entered_cccd := case
    when v_entry.worker_details->'national_id'->>'state' = 'provided'
      then nullif(btrim(coalesce(v_entry.worker_details->'national_id'->>'value', '')), '')
    else null
  end;

  select * into v_existing
    from public.direct_entry_cccd_reconciliations r
   where r.entry_id = p_entry_id
   for update;
  v_has_existing := found;

  select count(*)::integer
    into v_current_cccd_count
    from public.direct_entry_current_documents cd
   where cd.candidate_id = v_entry.candidate_id
     and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
     and cd.mime_type in ('image/jpeg', 'image/png');

  -- Count any current CCCD image that has no completed QR extraction yet, or any
  -- QUEUED CCCD reservation that is newer than the current READY version.
  select (
    (
      select count(*)::integer
        from public.direct_entry_current_documents cd
        left join public.direct_entry_cccd_qr_extractions q
          on q.document_id = cd.document_id
       where cd.candidate_id = v_entry.candidate_id
         and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
         and cd.mime_type in ('image/jpeg', 'image/png')
         and (q.extraction_id is null or q.status = 'PENDING')
    )
    +
    (
      select count(*)::integer
        from public.direct_entry_document_versions d
        join lateral (
          select ev.upload_status
            from public.direct_entry_document_events ev
           where ev.document_id = d.document_id
           order by ev.version desc
           limit 1
        ) latest_ev on true
       where d.candidate_id = v_entry.candidate_id
         and d.document_type in ('CCCD_FRONT', 'CCCD_BACK')
         and d.mime_type in ('image/jpeg', 'image/png')
         and latest_ev.upload_status = 'QUEUED'
         and not exists (
           select 1
             from public.direct_entry_current_documents cd
            where cd.candidate_id = d.candidate_id
              and cd.document_type = d.document_type
              and cd.version > d.version
         )
    )
  ) into v_pending_cccd_count;

  -- Prefer a current CCCD side with SUCCEEDED QR (matching entered_national_id first,
  -- then front before back, then newest version).
  select cd.document_id,
         cd.document_type,
         cd.version as document_version,
         q.candidate_data,
         q.applied_fields,
         q.reconciliation_status
    into v_best_qr
    from public.direct_entry_current_documents cd
    join public.direct_entry_cccd_qr_extractions q
      on q.document_id = cd.document_id
   where cd.candidate_id = v_entry.candidate_id
     and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
     and cd.mime_type in ('image/jpeg', 'image/png')
     and q.status = 'SUCCEEDED'
     and q.candidate_data is not null
   order by
     case
       when v_entered_cccd is not null
        and (q.candidate_data->>'national_id') = v_entered_cccd then 0
       else 1
     end asc,
     case when cd.document_type = 'CCCD_FRONT' then 0 else 1 end asc,
     cd.version desc
   limit 1;
  v_has_best_qr := found;

  if v_has_best_qr then
    v_qr_cccd := nullif(btrim(coalesce(v_best_qr.candidate_data->>'national_id', '')), '');
    v_matched_doc_id := v_best_qr.document_id;
    v_matched_doc_type := v_best_qr.document_type;
    v_matched_doc_version := v_best_qr.document_version;
    v_extracted_fields := v_best_qr.candidate_data - 'legacy_national_id';
    v_auto_applied := coalesce(v_best_qr.applied_fields, '{}'::text[]);

    if v_entered_cccd is not null and v_entered_cccd = v_qr_cccd then
      if v_has_existing
         and v_existing.status in ('RESOLVED_FROM_QR', 'RESOLVED_EDITED_CCCD')
         and v_existing.entered_national_id = v_entered_cccd
         and v_existing.qr_national_id = v_qr_cccd then
        v_status := v_existing.status;
        v_resolved_at := v_existing.resolved_at;
        v_resolved_by := v_existing.resolved_by_user_id;
        v_resolution_action := v_existing.resolution_action;
        v_resolution_note := v_existing.resolution_note;
      else
        v_status := 'MATCHED_INITIAL';
        v_resolved_at := coalesce(v_existing.resolved_at, clock_timestamp());
        v_resolved_by := coalesce(p_actor_user_id, v_existing.resolved_by_user_id);
        v_resolution_action := 'AUTO_MATCHED_INITIAL';
        v_resolution_note := null;
      end if;
    else
      v_status := 'MISMATCH';
      v_resolved_at := null;
      v_resolved_by := null;
      v_resolution_action := null;
      v_resolution_note := null;
    end if;
  elsif v_pending_cccd_count > 0 or v_current_cccd_count = 0 then
    v_status := 'PENDING';
  else
    select cd.document_id,
           cd.document_type,
           cd.version as document_version,
           q.error_code,
           q.error_field
      into v_latest_failed
      from public.direct_entry_current_documents cd
      join public.direct_entry_cccd_qr_extractions q
        on q.document_id = cd.document_id
     where cd.candidate_id = v_entry.candidate_id
       and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
       and cd.mime_type in ('image/jpeg', 'image/png')
       and q.status in ('NO_QR_FOUND', 'INVALID_QR', 'FAILED_RETRYABLE')
     order by
       case when cd.document_type = 'CCCD_FRONT' then 0 else 1 end asc,
       cd.version desc
     limit 1;
    v_has_latest_failed := found;

    if v_has_latest_failed then
      v_status := 'QR_UNREADABLE';
      v_matched_doc_id := v_latest_failed.document_id;
      v_matched_doc_type := v_latest_failed.document_type;
      v_matched_doc_version := v_latest_failed.document_version;
      v_error_code := v_latest_failed.error_code;
      v_error_field := v_latest_failed.error_field;
    else
      v_status := 'PENDING';
    end if;
  end if;

  insert into public.direct_entry_cccd_reconciliations (
    entry_id,
    candidate_id,
    status,
    entered_national_id,
    qr_national_id,
    matched_document_id,
    matched_document_type,
    matched_document_version,
    extracted_fields,
    auto_applied_fields,
    last_error_code,
    last_error_field,
    resolved_at,
    resolved_by_user_id,
    resolution_action,
    resolution_note,
    updated_at
  ) values (
    v_entry.entry_id,
    v_entry.candidate_id,
    v_status,
    v_entered_cccd,
    v_qr_cccd,
    v_matched_doc_id,
    v_matched_doc_type,
    v_matched_doc_version,
    v_extracted_fields,
    v_auto_applied,
    v_error_code,
    v_error_field,
    v_resolved_at,
    v_resolved_by,
    v_resolution_action,
    v_resolution_note,
    clock_timestamp()
  )
  on conflict (entry_id) do update
    set status = excluded.status,
        entered_national_id = excluded.entered_national_id,
        qr_national_id = excluded.qr_national_id,
        matched_document_id = excluded.matched_document_id,
        matched_document_type = excluded.matched_document_type,
        matched_document_version = excluded.matched_document_version,
        extracted_fields = excluded.extracted_fields,
        auto_applied_fields = excluded.auto_applied_fields,
        last_error_code = excluded.last_error_code,
        last_error_field = excluded.last_error_field,
        resolved_at = excluded.resolved_at,
        resolved_by_user_id = excluded.resolved_by_user_id,
        resolution_action = excluded.resolution_action,
        resolution_note = excluded.resolution_note,
        updated_at = clock_timestamp()
  returning * into v_existing;

  return public.direct_entry__internal_project_cccd_reconciliation(v_existing);
end;
$function$;

revoke all on function public.direct_entry__internal_recompute_cccd_reconciliation(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Temporary source patcher to update existing functions while preserving all
-- established substrings, comments, and security attributes.
create function public.direct_entry_pre_wave2_replace_function_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer default 1
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $replace$
declare
  v_definition text;
  v_expected text := replace(replace(p_expected, E'\r\n', E'\n'), E'\r', E'\n');
  v_replacement text := replace(replace(p_replacement, E'\r\n', E'\n'), E'\r', E'\n');
  v_count integer;
begin
  select pg_get_functiondef(p_signature) into v_definition;
  if v_definition is null or v_expected is null or v_expected = '' then
    raise exception 'Pre-Wave-2 function source missing for %', p_signature using errcode = '55000';
  end if;
  v_definition := replace(replace(v_definition, E'\r\n', E'\n'), E'\r', E'\n');
  v_count := (length(v_definition) - length(replace(v_definition, v_expected, '')))
    / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'Pre-Wave-2 source drift for %: expected %, found %',
      p_signature, p_expected_count, v_count using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$replace$;

revoke all on function public.direct_entry_pre_wave2_replace_function_source(
  regprocedure, text, text, integer
) from public, anon, authenticated, service_role;

-- 1. Allow worker_details.display_name to be empty ("") ONLY when a valid 12-digit
--    national_id is provided. Grid contracts (1.0/1.1) still enforce non-empty
--    display_name at their write RPC boundary.
select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_valid_worker_details(jsonb)'::regprocedure,
  $old$     or jsonb_typeof(p_worker->'display_name') <> 'string'
     or length(btrim(p_worker->>'display_name')) not between 1 and 256 then$old$,
  $new$     or jsonb_typeof(p_worker->'display_name') <> 'string'
     or (
       length(btrim(p_worker->>'display_name')) not between 1 and 256
       and not (
         p_worker->>'display_name' = ''
         and jsonb_typeof(p_worker->'national_id') = 'object'
         and p_worker->'national_id'->>'state' = 'provided'
         and coalesce(p_worker->'national_id'->>'value', '') ~ '^[0-9]{12}$'
         and p_worker->'national_id'->>'value' <> '000000000000'
       )
     ) then$new$,
  1
);

-- 2. Extend direct_entry_create_full_profile_batch and v2_unscoped_h03 with
--    contract version 'worker-profile/1.2' for Web Form & Android (requiring 12-digit
--    CCCD, allowing optional display_name, and seeding PENDING CCCD reconciliation),
--    while keeping 'worker-profile/1.0' and 'worker-profile/1.1' (Grid) untouched.
select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$  if p_contract_version is distinct from 'worker-profile/1.0' then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;$old$,
  $new$  if p_contract_version is null
     or p_contract_version not in ('worker-profile/1.0', 'worker-profile/1.2') then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;$new$,
  1
);

select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$    if v_display_name is null or length(btrim(v_display_name)) not between 1 and 256
       or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;$old$,
  $new$    if p_contract_version = 'worker-profile/1.2' then
      if v_row ? 'display_name'
         and jsonb_typeof(v_row->'display_name') not in ('string', 'null') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_display_name := coalesce(btrim(v_display_name, v_trim_chars), '');
      if length(v_display_name) > 256
         or coalesce(v_worker_input->'national_id'->>'state', '') <> 'provided'
         or coalesce(v_worker_input->'national_id'->>'value', '') !~ '^[0-9]{12}$'
         or v_worker_input->'national_id'->>'value' = '000000000000'
         or coalesce(v_row->'employment'->>'initial_status', 'ON') = 'OFF'
         or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
    elsif v_display_name is null or length(btrim(v_display_name)) not between 1 and 256
       or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;$new$,
  1
);

select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$    v_entry_ids := v_entry_ids || jsonb_build_array(v_entry_id);$old$,
  $new$    if p_contract_version = 'worker-profile/1.2' and v_national_id is not null then
      insert into public.direct_entry_cccd_reconciliations (
        entry_id, candidate_id, status, entered_national_id
      ) values (
        v_entry_id, v_candidate_id, 'PENDING', v_national_id
      )
      on conflict (entry_id) do update
        set entered_national_id = excluded.entered_national_id,
            updated_at = clock_timestamp();
    end if;
    v_entry_ids := v_entry_ids || jsonb_build_array(v_entry_id);$new$,
  1
);

select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$  if p_contract_version is distinct from 'worker-profile/1.1' then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;$old$,
  $new$  if p_contract_version is null
     or p_contract_version not in ('worker-profile/1.1', 'worker-profile/1.2') then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;$new$,
  1
);

select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$  v_result := public.direct_entry_create_full_profile_batch(
    p_auth_subject,
    p_app_user_id,
    'worker-profile/1.0',
    v_rows,
    v_inner_key
  );$old$,
  $new$  v_result := public.direct_entry_create_full_profile_batch(
    p_auth_subject,
    p_app_user_id,
    case when p_contract_version = 'worker-profile/1.2' then 'worker-profile/1.2' else 'worker-profile/1.0' end,
    v_rows,
    v_inner_key
  );$new$,
  1
);

-- 3. Allow scoped CCCD Review actors with document_upload (or creator on their own
--    entry) to re-upload CCCD images on SUBMITTED entries in the review queue,
--    and allow sequential CCCD_FRONT / CCCD_BACK reserve & finalize to succeed
--    when the only intervening revision was background QR blank-field autofill.
select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)'::regprocedure,
  $old$  if v_submission_state = 'SUBMITTED'
     and v_entry.created_by_user_id = p_app_user_id then
    return public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'document_upload',
      v_entry.created_by_user_id, v_entry.team_id,
      v_entry.first_work_date, null
    );
  end if;$old$,
  $new$  if v_submission_state = 'SUBMITTED'
     and v_entry.created_by_user_id = p_app_user_id then
    return public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'document_upload',
      v_entry.created_by_user_id, v_entry.team_id,
      v_entry.first_work_date, null
    );
  end if;

  if v_submission_state = 'SUBMITTED'
     and exists (
       select 1
         from public.direct_entry_cccd_reconciliations r
        where r.entry_id = v_entry.entry_id
     )
     and public.direct_entry_resolve_submission_read_scope(
       p_auth_subject, p_app_user_id, v_entry.entry_id
     ) is not null then
    return public.direct_entry_resolve_submission_read_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id
    );
  end if;$new$,
  1
);

select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_reserve_document_direct_upload(uuid,uuid,uuid,integer,text,text,bigint,text,text)'::regprocedure,
  $old$  if p_expected_entry_version is null
     or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;$old$,
  $new$  if p_expected_entry_version is null
     or not public.direct_entry__internal_version_compatible_after_qr_autofill(
       p_entry_id, p_expected_entry_version, v_entry.version
     ) then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;$new$,
  1
);

select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_finalize_document_direct_upload(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,text)'::regprocedure,
  $old$  if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;$old$,
  $new$  if p_expected_entry_version is null
     or not public.direct_entry__internal_version_compatible_after_qr_autofill(
       p_entry_id, p_expected_entry_version, v_entry.version
     ) then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;$new$,
  1
);

select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_finalize_document_direct_upload(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,text)'::regprocedure,
  $old$  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'document_direct_finalize', p_idempotency_key, v_result
  );$old$,
  $new$  if p_outcome = 'validated' and v_document.document_type in ('CCCD_FRONT', 'CCCD_BACK') then
    perform public.direct_entry__internal_recompute_cccd_reconciliation(
      p_entry_id, p_app_user_id
    );
  end if;
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'document_direct_finalize', p_idempotency_key, v_result
  );$new$,
  1
);

-- Allow creator of a reconciled entry to preview their own CCCD image in Review.
select public.direct_entry_pre_wave2_replace_function_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'document_view',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;$old$,
  $new$      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null and v_entry.created_by_user_id = p_app_user_id
         and exists (
           select 1
             from public.direct_entry_cccd_reconciliations r
            where r.entry_id = v_entry.entry_id
         ) then
        v_scope := 'own';
      end if;
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'document_view',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;$new$,
  1
);

drop function public.direct_entry_pre_wave2_replace_function_source(
  regprocedure, text, text, integer
);

-- 4. Update CCCD QR projection and completion RPCs with exact CCCD comparison,
--    blank-only auto-fill on MATCHED_INITIAL (including display_name when blank),
--    zero auto-fill on MISMATCH, and stale-document-version protection.
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
      'display_name', case
        when 'display_name' = any(p_row.applied_fields) then 'applied_to_blank'
        when length(btrim(coalesce(v_worker->>'display_name', ''))) = 0
          then 'eligible_blank'
        else 'kept_existing'
      end,
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
    'reconciliation_status', p_row.reconciliation_status,
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
  v_is_current_doc boolean := false;
  v_reused boolean := false;
  v_apply boolean := coalesce(p_apply_blank_fields, false);
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_entered_cccd text;
  v_qr_cccd text;
  v_doc_reconciliation_status text := 'PENDING';
  v_reconciliation jsonb;
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

  v_is_current_doc := exists (
    select 1
      from public.direct_entry_current_documents cd
     where cd.document_id = v_document.document_id
       and cd.candidate_id = v_entry.candidate_id
  );

  v_entered_cccd := case
    when v_entry.worker_details->'national_id'->>'state' = 'provided'
      then nullif(btrim(coalesce(v_entry.worker_details->'national_id'->>'value', '')), '')
    else null
  end;

  select * into v_existing
    from public.direct_entry_cccd_qr_extractions q
   where q.document_id = v_document.document_id
   for update;
  v_has_existing := found;

  -- Idempotent replay when the same idempotency key already completed this document,
  -- or when blank fields were already applied (or not requested) on a terminal extraction.
  if v_has_existing
     and v_existing.status in ('SUCCEEDED', 'NO_QR_FOUND', 'INVALID_QR')
     and v_existing.checksum_sha256 = v_obj.checksum_sha256
     and (
       not v_apply
       or cardinality(v_existing.applied_fields) > 0
       or (v_key is not null and v_existing.last_idempotency_key = v_key)
     ) then
    v_reconciliation := public.direct_entry__internal_recompute_cccd_reconciliation(
      p_entry_id, p_app_user_id
    );
    return jsonb_build_object(
      'entry_id', v_entry.entry_id,
      'entry_version', v_entry.version,
      'reused', true,
      'reconciliation', v_reconciliation,
      'extraction', public.direct_entry__internal_project_cccd_qr_extraction(
        v_existing, v_entry.worker_details
      )
    );
  end if;

  -- Validate candidate payload or error code before writing or mutating
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
    v_qr_cccd := btrim(p_candidate_data->>'national_id');
    if v_entered_cccd is not null and v_entered_cccd = v_qr_cccd then
      v_doc_reconciliation_status := 'MATCHED_INITIAL';
    else
      v_doc_reconciliation_status := 'MISMATCH';
    end if;
  else
    if p_error_code is null
       or length(btrim(p_error_code)) not between 1 and 64
       or p_error_code !~ '^[A-Z0-9_]+$' then
      raise exception 'invalid cccd qr error code' using errcode = '22023';
    end if;
    v_doc_reconciliation_status := 'QR_UNREADABLE';
  end if;

  if not v_has_existing
     or v_existing.status in ('PENDING', 'FAILED_RETRYABLE')
     or v_existing.checksum_sha256 <> v_obj.checksum_sha256 then

    if not v_has_existing then
      insert into public.direct_entry_cccd_qr_extractions (
        entry_id,
        candidate_id,
        document_id,
        document_type,
        document_version,
        checksum_sha256,
        status,
        reconciliation_status,
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
        v_doc_reconciliation_status,
        case when p_status = 'SUCCEEDED' then null else p_error_code end,
        case when p_status = 'SUCCEEDED' then null else p_error_field end,
        case when p_status = 'SUCCEEDED' then p_candidate_data else null end,
        '{}'::text[],
        case
          when p_status = 'SUCCEEDED'
           and length(btrim(coalesce(v_entry.worker_details->>'display_name', ''))) > 0
            then array['display_name']
          else '{}'::text[]
        end,
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
             reconciliation_status = v_doc_reconciliation_status,
             error_code = case when p_status = 'SUCCEEDED' then null else p_error_code end,
             error_field = case when p_status = 'SUCCEEDED' then null else p_error_field end,
             candidate_data = case when p_status = 'SUCCEEDED' then p_candidate_data else null end,
             skipped_fields = case
               when p_status = 'SUCCEEDED'
                and cardinality(skipped_fields) = 0
                and length(btrim(coalesce(v_entry.worker_details->>'display_name', ''))) > 0
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

  -- Blank-only auto-fill into direct_entries.worker_details ONLY when:
  --   1. p_apply_blank_fields = true;
  --   2. extraction SUCCEEDED on the current non-superseded document version;
  --   3. entered CCCD matches QR CCCD exactly (MATCHED_INITIAL). Never auto-fill on MISMATCH!
  if v_apply and v_existing.status = 'SUCCEEDED' and v_existing.candidate_data is not null then
    if p_expected_entry_version is not null and p_expected_entry_version <> v_entry.version then
      raise exception 'entry version conflict' using errcode = '40001';
    end if;

    v_candidate := v_existing.candidate_data;
    v_qr_cccd := nullif(btrim(coalesce(v_candidate->>'national_id', '')), '');

    if v_is_current_doc and v_entered_cccd is not null and v_entered_cccd = v_qr_cccd then
      v_next_worker := v_entry.worker_details;
      v_skipped_fields := '{}'::text[];

      -- Auto-fill display_name ONLY when currently blank ("")
      if length(btrim(coalesce(v_next_worker->>'display_name', ''))) = 0
         and length(btrim(coalesce(v_candidate->>'display_name', ''))) between 1 and 256 then
        v_next_worker := jsonb_set(
          v_next_worker,
          array['display_name'],
          to_jsonb(btrim(v_candidate->>'display_name')),
          true
        );
        v_applied_fields := array_append(v_applied_fields, 'display_name');
      else
        v_skipped_fields := array_append(v_skipped_fields, 'display_name');
      end if;

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
             reconciliation_status = 'MATCHED_INITIAL',
             last_idempotency_key = coalesce(v_key, v_existing.last_idempotency_key),
             updated_at = clock_timestamp()
       where extraction_id = v_existing.extraction_id
       returning * into v_existing;
    else
      -- MISMATCH or stale document version: never auto-apply fields from QR
      v_skipped_fields := array[
        'display_name',
        'national_id',
        'date_of_birth',
        'gender',
        'address',
        'national_id_issued_at'
      ];
      update public.direct_entry_cccd_qr_extractions
         set skipped_fields = v_skipped_fields,
             reconciliation_status = case
               when v_entered_cccd is not null and v_entered_cccd = v_qr_cccd
                 then 'MATCHED_INITIAL'
               else 'MISMATCH'
             end,
             last_idempotency_key = coalesce(v_key, v_existing.last_idempotency_key),
             updated_at = clock_timestamp()
       where extraction_id = v_existing.extraction_id
       returning * into v_existing;
    end if;
  end if;

  v_reconciliation := public.direct_entry__internal_recompute_cccd_reconciliation(
    p_entry_id, p_app_user_id
  );

  return jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'entry_version', v_entry.version,
    'reused', v_reused,
    'reconciliation', v_reconciliation,
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
  v_rec public.direct_entry_cccd_reconciliations%rowtype;
  v_rec_json jsonb := null;
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
               case when q.status = 'SUCCEEDED' then 0 else 1 end asc,
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

  select * into v_rec
    from public.direct_entry_cccd_reconciliations r
   where r.entry_id = v_entry.entry_id;
  if found then
    v_rec_json := public.direct_entry__internal_project_cccd_reconciliation(v_rec);
  end if;

  return jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'entry_version', v_entry.version,
    'reconciliation', v_rec_json,
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

-- 5. Service-role RPCs for the "Review thông tin NLĐ" dashboard tab:
--    - direct_entry_list_cccd_review_queue
--    - direct_entry_resolve_cccd_review
create or replace function public.direct_entry_list_cccd_review_queue(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_status_filter text default 'NEEDS_REVIEW',
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
  v_filter text := coalesce(nullif(btrim(p_status_filter), ''), 'NEEDS_REVIEW');
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_is_full_admin boolean := false;
  v_team_leader_team_id uuid := null;
  v_has_any_role boolean := false;
  v_counts jsonb;
  v_total integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
begin
  if v_filter not in ('NEEDS_REVIEW', 'MISMATCH', 'QR_UNREADABLE', 'PENDING', 'RESOLVED', 'ALL') then
    raise exception 'invalid cccd review status filter' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid cccd review page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid cccd review page size' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    v_is_full_admin := false;
  end;

  begin
    v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_team_leader_team_id := null;
  end;

  v_has_any_role := v_is_full_admin
    or v_team_leader_team_id is not null
    or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_app_user_id
         and g.is_current
         and g.capability in (
           'entry_create',
           'entry_own',
           'submission_create',
           'document_upload',
           'document_view',
           'pii_view',
           'entry_privileged_edit',
           'entry_admin',
           'change_review',
           'change_request_create'
         )
    )
    or exists (
      select 1
        from public.direct_entry_app_user_recruiter_links l
        join public.direct_entry_project_manager_assignments pma
          on pma.manager_recruiter_id = l.recruiter_id
         and pma.is_current
       where l.app_user_id = p_app_user_id
         and l.verified
         and l.is_current
    );

  if not v_has_any_role then
    raise exception 'cccd review queue denied' using errcode = '42501';
  end if;

  with scoped as (
    select r.*,
           e.version as entry_version,
           e.submission_id,
           e.project_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.recruiter_id,
           e.team_id,
           e.provider_type,
           e.labor_type,
           e.created_by_user_id,
           public.direct_entry__internal_resolve_cccd_review_authority(
             p_auth_subject,
             p_app_user_id,
             e.created_by_user_id,
             e.team_id,
             e.project_id,
             v_is_full_admin,
             v_team_leader_team_id
           ) as actor_authority
      from public.direct_entry_cccd_reconciliations r
      join public.direct_entries e
        on e.entry_id = r.entry_id
     where e.deleted_at is null
       and e.voided_at is null
  ),
  authorized as (
    select s.*
      from scoped s
     where s.actor_authority is not null
  ),
  filtered as (
    select a.*
      from authorized a
     where (
       (v_filter = 'NEEDS_REVIEW' and a.status in ('MISMATCH', 'QR_UNREADABLE'))
       or (v_filter = 'MISMATCH' and a.status = 'MISMATCH')
       or (v_filter = 'QR_UNREADABLE' and a.status = 'QR_UNREADABLE')
       or (v_filter = 'PENDING' and a.status = 'PENDING')
       or (v_filter = 'RESOLVED' and a.status in ('MATCHED_INITIAL', 'RESOLVED_FROM_QR', 'RESOLVED_EDITED_CCCD'))
       or v_filter = 'ALL'
     )
  ),
  paged as (
    select f.*
      from filtered f
     order by
       case f.status
         when 'MISMATCH' then 0
         when 'QR_UNREADABLE' then 1
         when 'PENDING' then 2
         else 3
       end asc,
       f.updated_at desc,
       f.entry_id asc
     limit v_page_size + 1
    offset v_offset
  )
  select jsonb_build_object(
           'needs_review', count(*) filter (where a.status in ('MISMATCH', 'QR_UNREADABLE'))::int,
           'mismatch', count(*) filter (where a.status = 'MISMATCH')::int,
           'qr_unreadable', count(*) filter (where a.status = 'QR_UNREADABLE')::int,
           'pending', count(*) filter (where a.status = 'PENDING')::int,
           'resolved', count(*) filter (where a.status in ('MATCHED_INITIAL', 'RESOLVED_FROM_QR', 'RESOLVED_EDITED_CCCD'))::int,
           'all', count(*)::int
         ),
         coalesce((select count(*)::int from filtered), 0),
         coalesce((
           select jsonb_agg(item_row.item_json order by item_row.ord)
             from (
               select row_number() over (
                        order by
                          case p.status
                            when 'MISMATCH' then 0
                            when 'QR_UNREADABLE' then 1
                            when 'PENDING' then 2
                            else 3
                          end asc,
                          p.updated_at desc,
                          p.entry_id asc
                      ) as ord,
                      jsonb_build_object(
                        'entry_id', p.entry_id,
                        'entry_version', p.entry_version,
                        'submission_state', coalesce(sub.state, 'DRAFT'),
                        'employee_code', p.employee_code,
                        'project_id', p.project_id,
                        'project_display', coalesce(pj.display_name, p.project_id),
                        'recruiter_id', p.recruiter_id,
                        'recruiter_display', coalesce(rec.display_name, ''),
                        'team_id', case when p.provider_type = 'vendor' then null else p.team_id end,
                        'team_display', case
                          when p.provider_type = 'vendor' then 'Không áp dụng'
                          else coalesce(tm.display_name, '')
                        end,
                        'provider_type', p.provider_type,
                        'labor_type', p.labor_type,
                        'first_work_date', to_char(p.first_work_date, 'YYYY-MM-DD'),
                        'created_by_user_id', p.created_by_user_id,
                        'created_by_display', coalesce(creator.display_name, ''),
                        'actor_authority', p.actor_authority,
                        'reconciliation_status', p.status,
                        'entered_national_id', p.entered_national_id,
                        'entered_national_id_masked', case
                          when p.entered_national_id is not null and length(p.entered_national_id) >= 4
                            then '••••••••' || right(p.entered_national_id, 4)
                          else null
                        end,
                        'qr_national_id', p.qr_national_id,
                        'qr_national_id_masked', case
                          when p.qr_national_id is not null and length(p.qr_national_id) >= 4
                            then '••••••••' || right(p.qr_national_id, 4)
                          else null
                        end,
                        'worker_details', jsonb_build_object(
                          'display_name', coalesce(p.worker_details->>'display_name', ''),
                          'date_of_birth', coalesce(p.worker_details->'date_of_birth', '{"state":"omitted"}'::jsonb),
                          'gender', coalesce(p.worker_details->'gender', '{"state":"omitted"}'::jsonb),
                          'address', coalesce(p.worker_details->'address', '{"state":"omitted"}'::jsonb),
                          'phone', coalesce(p.worker_details->'phone', '{"state":"omitted"}'::jsonb),
                          'national_id_issued_at', coalesce(p.worker_details->'national_id_issued_at', '{"state":"omitted"}'::jsonb),
                          'national_id_issued_place', coalesce(p.worker_details->'national_id_issued_place', '{"state":"omitted"}'::jsonb)
                        ),
                        'extracted_fields', coalesce(p.extracted_fields, '{}'::jsonb),
                        'auto_applied_fields', to_jsonb(coalesce(p.auto_applied_fields, '{}'::text[])),
                        'matched_document_id', p.matched_document_id,
                        'matched_document_type', p.matched_document_type,
                        'matched_document_version', p.matched_document_version,
                        'last_error_code', p.last_error_code,
                        'last_error_field', p.last_error_field,
                        'resolved_at', case
                          when p.resolved_at is null then null
                          else to_char(p.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                        end,
                        'resolved_by_user_id', p.resolved_by_user_id,
                        'resolved_by_display', resolver.display_name,
                        'resolution_action', p.resolution_action,
                        'resolution_note', p.resolution_note,
                        'updated_at', to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        'documents', coalesce((
                          select jsonb_agg(
                                   jsonb_build_object(
                                     'document_id', cd.document_id,
                                     'document_type', cd.document_type,
                                     'document_version', cd.version,
                                     'mime_type', cd.mime_type,
                                     'size_bytes', cd.size_bytes,
                                     'qr_status', q.status,
                                     'qr_reconciliation_status', q.reconciliation_status,
                                     'qr_error_code', q.error_code,
                                     'qr_error_field', q.error_field,
                                     'qr_candidate_data', q.candidate_data
                                   )
                                   order by
                                     case when cd.document_type = 'CCCD_FRONT' then 0 else 1 end asc,
                                     cd.version desc
                                 )
                            from public.direct_entry_current_documents cd
                            left join public.direct_entry_cccd_qr_extractions q
                              on q.document_id = cd.document_id
                           where cd.candidate_id = p.candidate_id
                             and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
                             and cd.mime_type in ('image/jpeg', 'image/png')
                        ), '[]'::jsonb)
                      ) as item_json
                 from paged p
                 left join public.direct_entry_submissions sub on sub.submission_id = p.submission_id
                 left join public.direct_entry_projects pj on pj.project_id = p.project_id
                 left join public.recruiters rec on rec.recruiter_id = p.recruiter_id
                 left join public.teams tm on tm.team_id = p.team_id
                 left join public.direct_entry_app_users creator on creator.app_user_id = p.created_by_user_id
                 left join public.direct_entry_app_users resolver on resolver.app_user_id = p.resolved_by_user_id
             ) item_row
         ), '[]'::jsonb)
    into v_counts, v_total, v_rows
    from authorized a;

  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb)
      into v_items
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
     where t.ord <= v_page_size;
  else
    v_items := v_rows;
  end if;

  return jsonb_build_object(
    'status_filter', v_filter,
    'page', v_page,
    'page_size', v_page_size,
    'total_items', v_total,
    'has_more', v_has_more,
    'counts', v_counts,
    'items', v_items
  );
end;
$function$;

revoke all on function public.direct_entry_list_cccd_review_queue(uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_cccd_review_queue(uuid, uuid, text, integer, integer)
  to service_role;

create or replace function public.direct_entry_resolve_cccd_review(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_action text,
  p_payload jsonb default '{}'::jsonb,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_rec public.direct_entry_cccd_reconciliations%rowtype;
  v_has_rec boolean := false;
  v_is_full_admin boolean := false;
  v_team_leader_team_id uuid := null;
  v_authority text;
  v_scope_kind text;
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_note text;
  v_new_cccd text;
  v_apply_blank boolean := true;
  v_overwrite_existing boolean := true;
  v_best_qr record;
  v_has_best_qr boolean := false;
  v_qr_cccd text := null;
  v_qr_data jsonb := null;
  v_requested_fields text[] := '{}'::text[];
  v_field text;
  v_field_state text;
  v_next_worker jsonb;
  v_changed_fields text[] := '{}'::text[];
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_next_status text;
  v_resolution_action text := null;
  v_resolved_at timestamptz := null;
  v_resolved_by uuid := null;
begin
  if p_entry_id is null or p_expected_entry_version is null or p_expected_entry_version < 1 then
    raise exception 'entry and expected version required' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('UPDATE_ENTERED_CCCD', 'STANDARDIZE_FROM_QR') then
    raise exception 'invalid cccd review action' using errcode = '22023';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'invalid cccd review payload' using errcode = '22023';
  end if;
  if v_key is not null and length(v_key) > 128 then
    raise exception 'idempotency key too long' using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(v_payload->>'note', '')), '');
  if v_note is not null and length(v_note) > 4000 then
    raise exception 'note too long' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    v_is_full_admin := false;
  end;

  begin
    v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_team_leader_team_id := null;
  end;

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id
     and e.deleted_at is null
     and e.voided_at is null
   for update;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  v_authority := public.direct_entry__internal_resolve_cccd_review_authority(
    p_auth_subject,
    p_app_user_id,
    v_entry.created_by_user_id,
    v_entry.team_id,
    v_entry.project_id,
    v_is_full_admin,
    v_team_leader_team_id
  );
  if v_authority is null then
    raise exception 'cccd review resolve denied' using errcode = '42501';
  end if;

  v_scope_kind := case
    when v_authority in ('admin_all', 'privileged_all', 'all') then 'all'
    when v_authority in ('privileged_team', 'team_leader', 'team') then 'team'
    when v_authority = 'project_manager' then 'project'
    else 'own'
  end;

  select * into v_rec
    from public.direct_entry_cccd_reconciliations r
   where r.entry_id = p_entry_id
   for update;
  v_has_rec := found;

  if v_has_rec and v_key is not null and v_rec.last_idempotency_key = v_key then
    return jsonb_build_object(
      'entry_id', v_entry.entry_id,
      'entry_version', v_entry.version,
      'reused', true,
      'changed_fields', '[]'::jsonb,
      'reconciliation', public.direct_entry__internal_project_cccd_reconciliation(v_rec),
      'worker_details', v_entry.worker_details
    );
  end if;

  if v_entry.version <> p_expected_entry_version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;

  -- Locate current SUCCEEDED QR extraction if one exists
  select cd.document_id,
         cd.document_type,
         cd.version as document_version,
         q.extraction_id,
         q.candidate_data,
         q.applied_fields
    into v_best_qr
    from public.direct_entry_current_documents cd
    join public.direct_entry_cccd_qr_extractions q
      on q.document_id = cd.document_id
   where cd.candidate_id = v_entry.candidate_id
     and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
     and cd.mime_type in ('image/jpeg', 'image/png')
     and q.status = 'SUCCEEDED'
     and q.candidate_data is not null
   order by
     case when cd.document_type = 'CCCD_FRONT' then 0 else 1 end asc,
     cd.version desc
   limit 1;
  v_has_best_qr := found;

  if v_has_best_qr then
    v_qr_data := v_best_qr.candidate_data;
    v_qr_cccd := nullif(btrim(coalesce(v_qr_data->>'national_id', '')), '');
  end if;

  v_next_worker := v_entry.worker_details;

  if p_action = 'UPDATE_ENTERED_CCCD' then
    v_new_cccd := nullif(btrim(coalesce(v_payload->>'national_id', '')), '');
    if v_new_cccd is null or v_new_cccd !~ '^[0-9]{12}$' or v_new_cccd = '000000000000' then
      raise exception 'invalid entered national_id' using errcode = '22023';
    end if;

    if v_payload ? 'apply_blank_fields_from_qr'
       and jsonb_typeof(v_payload->'apply_blank_fields_from_qr') = 'boolean' then
      v_apply_blank := (v_payload->>'apply_blank_fields_from_qr')::boolean;
    end if;

    if coalesce(v_next_worker->'national_id'->>'value', '') is distinct from v_new_cccd
       or coalesce(v_next_worker->'national_id'->>'state', 'omitted') <> 'provided' then
      v_next_worker := jsonb_set(
        v_next_worker,
        array['national_id'],
        jsonb_build_object('state', 'provided', 'value', v_new_cccd),
        true
      );
      v_changed_fields := array_append(v_changed_fields, 'national_id');
    end if;

    -- If the updated CCCD now matches the QR CCCD, optionally fill blank fields
    -- and mark RESOLVED_EDITED_CCCD. If it still differs from QR, keep MISMATCH!
    if v_has_best_qr and v_qr_cccd = v_new_cccd then
      if v_apply_blank then
        if length(btrim(coalesce(v_next_worker->>'display_name', ''))) = 0
           and length(btrim(coalesce(v_qr_data->>'display_name', ''))) between 1 and 256 then
          v_next_worker := jsonb_set(
            v_next_worker,
            array['display_name'],
            to_jsonb(btrim(v_qr_data->>'display_name')),
            true
          );
          v_changed_fields := array_append(v_changed_fields, 'display_name');
        end if;

        foreach v_field in array array[
          'date_of_birth',
          'gender',
          'address',
          'national_id_issued_at'
        ] loop
          v_field_state := coalesce(v_next_worker->v_field->>'state', 'omitted');
          if v_field_state in ('omitted', 'unknown')
             and v_qr_data ? v_field
             and jsonb_typeof(v_qr_data->v_field) = 'string'
             and length(btrim(v_qr_data->>v_field)) > 0 then
            v_next_worker := jsonb_set(
              v_next_worker,
              array[v_field],
              jsonb_build_object('state', 'provided', 'value', v_qr_data->>v_field),
              true
            );
            v_changed_fields := array_append(v_changed_fields, v_field);
          end if;
        end loop;
      end if;

      v_next_status := 'RESOLVED_EDITED_CCCD';
      v_resolution_action := 'UPDATE_ENTERED_CCCD';
      v_resolved_at := clock_timestamp();
      v_resolved_by := p_app_user_id;

      update public.direct_entry_cccd_qr_extractions
         set reconciliation_status = 'RESOLVED_EDITED_CCCD',
             updated_at = clock_timestamp()
       where extraction_id = v_best_qr.extraction_id;
    elsif v_has_best_qr and v_qr_cccd <> v_new_cccd then
      v_next_status := 'MISMATCH';
      v_resolution_action := null;
      v_resolved_at := null;
      v_resolved_by := null;
    else
      v_next_status := coalesce(v_rec.status, 'PENDING');
      v_resolution_action := null;
      v_resolved_at := null;
      v_resolved_by := null;
    end if;

  elsif p_action = 'STANDARDIZE_FROM_QR' then
    if not v_has_best_qr or v_qr_data is null or v_qr_cccd is null then
      raise exception 'cannot standardize from qr without succeeded extraction' using errcode = '22023';
    end if;

    if v_payload ? 'overwrite_existing'
       and jsonb_typeof(v_payload->'overwrite_existing') = 'boolean' then
      v_overwrite_existing := (v_payload->>'overwrite_existing')::boolean;
    end if;

    if v_payload ? 'fields' and jsonb_typeof(v_payload->'fields') = 'array' then
      select coalesce(array_agg(value::text), '{}'::text[])
        into v_requested_fields
        from jsonb_array_elements_text(v_payload->'fields') as value;
    else
      v_requested_fields := array[
        'national_id',
        'display_name',
        'date_of_birth',
        'gender',
        'address',
        'national_id_issued_at'
      ];
    end if;

    if exists (
      select 1
        from unnest(v_requested_fields) as f
       where f not in (
         'national_id',
         'display_name',
         'date_of_birth',
         'gender',
         'address',
         'national_id_issued_at'
       )
    ) then
      raise exception 'unsupported field in standardize_from_qr' using errcode = '22023';
    end if;

    -- Honest provenance: cannot resolve a CCCD mismatch without standardizing
    -- national_id to match the QR national_id.
    if coalesce(v_next_worker->'national_id'->>'value', '') is distinct from v_qr_cccd then
      if not ('national_id' = any(v_requested_fields)) then
        raise exception 'national_id must be standardized to resolve cccd mismatch' using errcode = '22023';
      end if;
      v_next_worker := jsonb_set(
        v_next_worker,
        array['national_id'],
        jsonb_build_object('state', 'provided', 'value', v_qr_cccd),
        true
      );
      v_changed_fields := array_append(v_changed_fields, 'national_id');
    end if;

    if 'display_name' = any(v_requested_fields)
       and length(btrim(coalesce(v_qr_data->>'display_name', ''))) between 1 and 256 then
      if v_overwrite_existing or length(btrim(coalesce(v_next_worker->>'display_name', ''))) = 0 then
        if coalesce(v_next_worker->>'display_name', '') is distinct from btrim(v_qr_data->>'display_name') then
          v_next_worker := jsonb_set(
            v_next_worker,
            array['display_name'],
            to_jsonb(btrim(v_qr_data->>'display_name')),
            true
          );
          v_changed_fields := array_append(v_changed_fields, 'display_name');
        end if;
      end if;
    end if;

    foreach v_field in array array[
      'date_of_birth',
      'gender',
      'address',
      'national_id_issued_at'
    ] loop
      if v_field = any(v_requested_fields)
         and v_qr_data ? v_field
         and jsonb_typeof(v_qr_data->v_field) = 'string'
         and length(btrim(v_qr_data->>v_field)) > 0 then
        v_field_state := coalesce(v_next_worker->v_field->>'state', 'omitted');
        if v_overwrite_existing or v_field_state in ('omitted', 'unknown') then
          if v_field_state <> 'provided'
             or coalesce(v_next_worker->v_field->>'value', '') is distinct from (v_qr_data->>v_field) then
            v_next_worker := jsonb_set(
              v_next_worker,
              array[v_field],
              jsonb_build_object('state', 'provided', 'value', v_qr_data->>v_field),
              true
            );
            v_changed_fields := array_append(v_changed_fields, v_field);
          end if;
        end if;
      end if;
    end loop;

    v_next_status := 'RESOLVED_FROM_QR';
    v_resolution_action := 'STANDARDIZE_FROM_QR';
    v_resolved_at := clock_timestamp();
    v_resolved_by := p_app_user_id;

    update public.direct_entry_cccd_qr_extractions
       set reconciliation_status = 'RESOLVED_FROM_QR',
           applied_fields = (
             select coalesce(array_agg(distinct f order by f), '{}'::text[])
               from unnest(v_best_qr.applied_fields || v_changed_fields) as f
           ),
           updated_at = clock_timestamp()
     where extraction_id = v_best_qr.extraction_id;
  end if;

  if not public.direct_entry_valid_worker_details(v_next_worker) then
    raise exception 'invalid worker details after cccd review resolution' using errcode = '22023';
  end if;

  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(
    p_app_user_id,
    coalesce(v_note, 'CCCD review action: ' || p_action)
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
    p_auth_subject,
    p_app_user_id,
    case
      when p_action = 'UPDATE_ENTERED_CCCD' then 'cccd_review_update_entered_cccd'
      else 'cccd_review_standardize_from_qr'
    end,
    'entry_create',
    p_entry_id::text,
    v_scope_kind,
    case when v_scope_kind = 'team' then v_entry.team_id else null end,
    'APPLIED',
    v_reason_id,
    v_revision_id,
    case
      when cardinality(v_changed_fields) > 0 then v_changed_fields
      else array['cccd_reconciliation_status']
    end
  );

  insert into public.direct_entry_cccd_reconciliations (
    entry_id,
    candidate_id,
    status,
    entered_national_id,
    qr_national_id,
    matched_document_id,
    matched_document_type,
    matched_document_version,
    extracted_fields,
    auto_applied_fields,
    last_error_code,
    last_error_field,
    resolved_at,
    resolved_by_user_id,
    resolution_action,
    resolution_note,
    last_idempotency_key,
    updated_at
  ) values (
    v_entry.entry_id,
    v_entry.candidate_id,
    v_next_status,
    v_next_worker->'national_id'->>'value',
    v_qr_cccd,
    case when v_has_best_qr then v_best_qr.document_id else v_rec.matched_document_id end,
    case when v_has_best_qr then v_best_qr.document_type else v_rec.matched_document_type end,
    case when v_has_best_qr then v_best_qr.document_version else v_rec.matched_document_version end,
    case when v_has_best_qr then v_qr_data - 'legacy_national_id' else coalesce(v_rec.extracted_fields, '{}'::jsonb) end,
    case
      when v_has_rec then (
        select coalesce(array_agg(distinct f order by f), '{}'::text[])
          from unnest(v_rec.auto_applied_fields || v_changed_fields) as f
      )
      else v_changed_fields
    end,
    case when v_has_best_qr then null else v_rec.last_error_code end,
    case when v_has_best_qr then null else v_rec.last_error_field end,
    v_resolved_at,
    v_resolved_by,
    v_resolution_action,
    v_note,
    v_key,
    clock_timestamp()
  )
  on conflict (entry_id) do update
    set status = excluded.status,
        entered_national_id = excluded.entered_national_id,
        qr_national_id = excluded.qr_national_id,
        matched_document_id = excluded.matched_document_id,
        matched_document_type = excluded.matched_document_type,
        matched_document_version = excluded.matched_document_version,
        extracted_fields = excluded.extracted_fields,
        auto_applied_fields = excluded.auto_applied_fields,
        last_error_code = excluded.last_error_code,
        last_error_field = excluded.last_error_field,
        resolved_at = excluded.resolved_at,
        resolved_by_user_id = excluded.resolved_by_user_id,
        resolution_action = excluded.resolution_action,
        resolution_note = excluded.resolution_note,
        last_idempotency_key = coalesce(excluded.last_idempotency_key, public.direct_entry_cccd_reconciliations.last_idempotency_key),
        updated_at = clock_timestamp()
  returning * into v_rec;

  return jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'entry_version', v_entry.version,
    'reused', false,
    'changed_fields', to_jsonb(v_changed_fields),
    'reconciliation', public.direct_entry__internal_project_cccd_reconciliation(v_rec),
    'worker_details', v_entry.worker_details
  );
end;
$function$;

revoke all on function public.direct_entry_resolve_cccd_review(
  uuid, uuid, uuid, integer, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_cccd_review(
  uuid, uuid, uuid, integer, text, jsonb, text
) to service_role;

do $align_pre_wave2_cccd_review_owners$
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
      'alter table public.direct_entry_cccd_reconciliations owner to %I',
      v_base_owner
    );

    for v_proc in
      select p.oid::pg_catalog.regprocedure::text as sig
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in (
           'direct_entry__internal_version_compatible_after_qr_autofill',
           'direct_entry__internal_resolve_cccd_review_authority',
           'direct_entry__internal_project_cccd_reconciliation',
           'direct_entry__internal_recompute_cccd_reconciliation',
           'direct_entry__internal_project_cccd_qr_extraction',
           'direct_entry_complete_cccd_qr_extraction',
           'direct_entry_get_cccd_qr_extractions',
           'direct_entry_list_cccd_review_queue',
           'direct_entry_resolve_cccd_review'
         )
    loop
      execute pg_catalog.format('alter function %s owner to %I', v_proc.sig, v_base_owner);
    end loop;
  end if;
end;
$align_pre_wave2_cccd_review_owners$;

revoke all on table public.direct_entry_cccd_reconciliations
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry__internal_version_compatible_after_qr_autofill(uuid, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry__internal_resolve_cccd_review_authority(uuid, uuid, uuid, uuid, text, boolean, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry__internal_project_cccd_reconciliation(public.direct_entry_cccd_reconciliations)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry__internal_recompute_cccd_reconciliation(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry__internal_project_cccd_qr_extraction(
  public.direct_entry_cccd_qr_extractions, jsonb
) from public, anon, authenticated, service_role;
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
revoke all on function public.direct_entry_list_cccd_review_queue(uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_cccd_review_queue(uuid, uuid, text, integer, integer)
  to service_role;
revoke all on function public.direct_entry_resolve_cccd_review(uuid, uuid, uuid, integer, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_cccd_review(uuid, uuid, uuid, integer, text, jsonb, text)
  to service_role;

do $verify_pre_wave2_cccd_review$
declare
  v_table_oid oid := 'public.direct_entry_cccd_reconciliations'::pg_catalog.regclass;
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
    raise exception 'CCCD reconciliations table RLS/ACL boundary drift'
      using errcode = '55000';
  end if;

  foreach v_sig in array array[
    'public.direct_entry__internal_version_compatible_after_qr_autofill(uuid, integer, integer)',
    'public.direct_entry__internal_resolve_cccd_review_authority(uuid, uuid, uuid, uuid, text, boolean, uuid)',
    'public.direct_entry__internal_project_cccd_reconciliation(public.direct_entry_cccd_reconciliations)',
    'public.direct_entry__internal_recompute_cccd_reconciliation(uuid, uuid)',
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
      raise exception 'CCCD review internal function boundary drift: %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array array[
    'public.direct_entry_list_cccd_review_queue(uuid, uuid, text, integer, integer)',
    'public.direct_entry_resolve_cccd_review(uuid, uuid, uuid, integer, text, jsonb, text)'
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
      raise exception 'CCCD review service RPC boundary drift: %', v_sig
        using errcode = '55000';
    end if;
  end loop;
end;
$verify_pre_wave2_cccd_review$;

commit;
