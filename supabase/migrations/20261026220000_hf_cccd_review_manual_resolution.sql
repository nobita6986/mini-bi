begin;

alter table public.direct_entry_cccd_reconciliations
  drop constraint if exists direct_entry_cccd_reconciliations_resolution_action_check;
alter table public.direct_entry_cccd_reconciliations
  add constraint direct_entry_cccd_reconciliations_resolution_action_check
  check (
    resolution_action is null
    or resolution_action in (
      'AUTO_MATCHED_INITIAL', 'STANDARDIZE_FROM_QR', 'UPDATE_ENTERED_CCCD',
      'MANUAL_UPDATE_DETAILS'
    )
  );

do $patch_recompute$
declare
  v_definition text;
  v_expected text := $old$    if v_entered_cccd is not null and v_entered_cccd = v_qr_cccd then$old$;
  v_replacement text := $new$    if v_has_existing
       and v_existing.status = 'RESOLVED_EDITED_CCCD'
       and v_existing.resolution_action = 'MANUAL_UPDATE_DETAILS'
       and v_existing.entered_national_id is not distinct from v_entered_cccd then
      v_status := v_existing.status;
      v_resolved_at := v_existing.resolved_at;
      v_resolved_by := v_existing.resolved_by_user_id;
      v_resolution_action := v_existing.resolution_action;
      v_resolution_note := v_existing.resolution_note;
    elsif v_entered_cccd is not null and v_entered_cccd = v_qr_cccd then$new$;
  v_count integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.direct_entry__internal_recompute_cccd_reconciliation(uuid, uuid)'::regprocedure
  ) into v_definition;
  v_count := (length(v_definition) - length(replace(v_definition, v_expected, '')))
    / length(v_expected);
  if v_count <> 1 then
    raise exception 'CCCD review recompute source drift: expected 1, found %', v_count
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$patch_recompute$;

do $patch_qr_autofill$
declare
  v_definition text;
  v_expected text := $old$  if v_apply and v_existing.status = 'SUCCEEDED' and v_existing.candidate_data is not null then$old$;
  v_replacement text := $new$  if v_apply
     and v_existing.status = 'SUCCEEDED'
     and v_existing.candidate_data is not null
     and not exists (
       select 1
         from public.direct_entry_cccd_reconciliations r
        where r.entry_id = p_entry_id
          and r.status = 'RESOLVED_EDITED_CCCD'
          and r.resolution_action = 'MANUAL_UPDATE_DETAILS'
          and r.entered_national_id is not distinct from v_entered_cccd
     ) then$new$;
  v_count integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.direct_entry_complete_cccd_qr_extraction(uuid, uuid, uuid, uuid, text, text, text, jsonb, boolean, integer, text)'::regprocedure
  ) into v_definition;
  v_count := (length(v_definition) - length(replace(v_definition, v_expected, '')))
    / length(v_expected);
  if v_count <> 1 then
    raise exception 'CCCD QR auto-fill source drift: expected 1, found %', v_count
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$patch_qr_autofill$;

create or replace function public.direct_entry_apply_cccd_manual_resolution(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_payload jsonb,
  p_idempotency_key text
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
  v_note text;
  v_national_id text;
  v_display_name text;
  v_dob text;
  v_gender text;
  v_address text;
  v_issued_at text;
  v_field text;
  v_field_value text;
  v_next_worker jsonb;
  v_changed_fields text[] := '{}'::text[];
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_best_qr record;
  v_has_best_qr boolean := false;
  v_qr_national_id text;
begin
  if p_entry_id is null or p_expected_entry_version is null or p_expected_entry_version < 1
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or not (p_payload ?& array['national_id', 'display_name'])
     or p_payload - array[
       'national_id', 'display_name', 'date_of_birth', 'gender', 'address',
       'national_id_issued_at', 'reason', 'note'
     ] <> '{}'::jsonb
     or v_key is null or length(v_key) > 128 then
    raise exception 'invalid manual cccd review request' using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload->'national_id') <> 'string'
     or jsonb_typeof(p_payload->'display_name') <> 'string'
     or (p_payload ? 'date_of_birth' and jsonb_typeof(p_payload->'date_of_birth') not in ('string', 'null'))
     or (p_payload ? 'gender' and jsonb_typeof(p_payload->'gender') not in ('string', 'null'))
     or (p_payload ? 'address' and jsonb_typeof(p_payload->'address') not in ('string', 'null'))
     or (p_payload ? 'national_id_issued_at' and jsonb_typeof(p_payload->'national_id_issued_at') not in ('string', 'null')) then
    raise exception 'invalid manual cccd review fields' using errcode = '22023';
  end if;

  v_national_id := btrim(p_payload->>'national_id');
  v_display_name := btrim(p_payload->>'display_name');
  v_dob := nullif(btrim(coalesce(p_payload->>'date_of_birth', '')), '');
  v_gender := nullif(btrim(coalesce(p_payload->>'gender', '')), '');
  v_address := nullif(btrim(coalesce(p_payload->>'address', '')), '');
  v_issued_at := nullif(btrim(coalesce(p_payload->>'national_id_issued_at', '')), '');
  v_note := nullif(btrim(coalesce(p_payload->>'reason', p_payload->>'note', '')), '');

  if v_national_id !~ '^[0-9]{12}$' or v_national_id = '000000000000'
     or length(v_display_name) > 256
     or v_display_name ~ '[[:cntrl:]]'
     or (v_dob is not null and length(v_dob) > 10)
     or (v_gender is not null and v_gender not in ('MALE', 'FEMALE', 'OTHER'))
     or (v_address is not null and (length(v_address) > 1024 or v_address ~ '[[:cntrl:]]'))
     or (v_issued_at is not null and length(v_issued_at) > 10)
     or (v_note is not null and length(v_note) > 4000) then
    raise exception 'invalid manual cccd review value' using errcode = '22023';
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
   where e.entry_id = p_entry_id and e.deleted_at is null and e.voided_at is null
   for update;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  v_authority := public.direct_entry__internal_resolve_cccd_review_authority(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id, v_entry.team_id,
    v_entry.project_id, v_is_full_admin, v_team_leader_team_id
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
  if v_has_rec and v_rec.last_idempotency_key = v_key then
    return jsonb_build_object(
      'entry_id', v_entry.entry_id,
      'entry_version', v_entry.version,
      'reused', true,
      'action', 'MANUAL_UPDATE_DETAILS',
      'changed_fields', '[]'::jsonb,
      'reconciliation', public.direct_entry__internal_project_cccd_reconciliation(v_rec)
    );
  end if;
  if v_entry.version <> p_expected_entry_version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;

  select cd.document_id, cd.document_type, cd.version as document_version,
         q.candidate_data, q.extraction_id
    into v_best_qr
    from public.direct_entry_current_documents cd
    join public.direct_entry_cccd_qr_extractions q on q.document_id = cd.document_id
   where cd.candidate_id = v_entry.candidate_id
     and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
     and cd.mime_type in ('image/jpeg', 'image/png')
     and q.status = 'SUCCEEDED' and q.candidate_data is not null
   order by case when cd.document_type = 'CCCD_FRONT' then 0 else 1 end, cd.version desc
   limit 1;
  v_has_best_qr := found;
  if v_has_best_qr then
    v_qr_national_id := nullif(btrim(v_best_qr.candidate_data->>'national_id'), '');
  end if;

  v_next_worker := v_entry.worker_details;
  if v_next_worker->>'display_name' is distinct from v_display_name then
    v_next_worker := jsonb_set(v_next_worker, '{display_name}', to_jsonb(v_display_name), true);
    v_changed_fields := array_append(v_changed_fields, 'display_name');
  end if;
  if v_next_worker->'national_id'->>'value' is distinct from v_national_id
     or coalesce(v_next_worker->'national_id'->>'state', 'omitted') <> 'provided' then
    v_next_worker := jsonb_set(v_next_worker, '{national_id}',
      jsonb_build_object('state', 'provided', 'value', v_national_id), true);
    v_changed_fields := array_append(v_changed_fields, 'national_id');
  end if;

  foreach v_field in array array['date_of_birth', 'gender', 'address', 'national_id_issued_at'] loop
    v_field_value := case v_field
      when 'date_of_birth' then v_dob
      when 'gender' then nullif(btrim(coalesce(p_payload->>'gender', '')), '')
      when 'address' then v_address
      else v_issued_at
    end;
    if v_field_value is null then
      if coalesce(v_next_worker->v_field->>'state', 'omitted') <> 'omitted'
         or v_next_worker->v_field ? 'value' then
        v_next_worker := jsonb_set(v_next_worker, array[v_field], '{"state":"omitted"}'::jsonb, true);
        v_changed_fields := array_append(v_changed_fields, v_field);
      end if;
    elsif coalesce(v_next_worker->v_field->>'state', 'omitted') <> 'provided'
       or v_next_worker->v_field->>'value' is distinct from v_field_value then
      v_next_worker := jsonb_set(v_next_worker, array[v_field],
        jsonb_build_object('state', 'provided', 'value', v_field_value), true);
      v_changed_fields := array_append(v_changed_fields, v_field);
    end if;
  end loop;

  if not public.direct_entry_valid_worker_details(v_next_worker) then
    raise exception 'invalid worker details after manual cccd review' using errcode = '22023';
  end if;

  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(
    p_app_user_id, coalesce(v_note, 'CCCD review action: MANUAL_UPDATE_DETAILS')
  );
  update public.direct_entries
     set worker_details = v_next_worker, version = version + 1
   where entry_id = p_entry_id
   returning * into v_entry;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version
  );

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'cccd_review_manual_update_worker_details', 'entry_create',
    p_entry_id::text, v_scope_kind,
    case when v_scope_kind = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id,
    case when cardinality(v_changed_fields) > 0 then v_changed_fields
      else array['cccd_reconciliation_status'] end
  );

  if v_has_best_qr then
    update public.direct_entry_cccd_qr_extractions
       set reconciliation_status = 'RESOLVED_EDITED_CCCD', updated_at = clock_timestamp()
     where extraction_id in (
       select q.extraction_id
         from public.direct_entry_current_documents cd
         join public.direct_entry_cccd_qr_extractions q on q.document_id = cd.document_id
        where cd.candidate_id = v_entry.candidate_id
          and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK') and q.status = 'SUCCEEDED'
     );
  end if;

  insert into public.direct_entry_cccd_reconciliations (
    entry_id, candidate_id, status, entered_national_id, qr_national_id,
    matched_document_id, matched_document_type, matched_document_version,
    extracted_fields, auto_applied_fields, last_error_code, last_error_field,
    resolved_at, resolved_by_user_id, resolution_action, resolution_note,
    last_idempotency_key, updated_at
  ) values (
    v_entry.entry_id, v_entry.candidate_id, 'RESOLVED_EDITED_CCCD', v_national_id,
    v_qr_national_id,
    case when v_has_best_qr then v_best_qr.document_id else v_rec.matched_document_id end,
    case when v_has_best_qr then v_best_qr.document_type else v_rec.matched_document_type end,
    case when v_has_best_qr then v_best_qr.document_version else v_rec.matched_document_version end,
    case when v_has_best_qr then v_best_qr.candidate_data - 'legacy_national_id'
      else coalesce(v_rec.extracted_fields, '{}'::jsonb) end,
    coalesce(v_rec.auto_applied_fields, '{}'::text[]), null, null,
    clock_timestamp(), p_app_user_id, 'MANUAL_UPDATE_DETAILS', v_note, v_key,
    clock_timestamp()
  )
  on conflict (entry_id) do update set
    status = excluded.status,
    entered_national_id = excluded.entered_national_id,
    qr_national_id = excluded.qr_national_id,
    matched_document_id = excluded.matched_document_id,
    matched_document_type = excluded.matched_document_type,
    matched_document_version = excluded.matched_document_version,
    extracted_fields = excluded.extracted_fields,
    last_error_code = null,
    last_error_field = null,
    resolved_at = excluded.resolved_at,
    resolved_by_user_id = excluded.resolved_by_user_id,
    resolution_action = excluded.resolution_action,
    resolution_note = excluded.resolution_note,
    last_idempotency_key = excluded.last_idempotency_key,
    updated_at = excluded.updated_at
  returning * into v_rec;

  return jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'entry_version', v_entry.version,
    'reused', false,
    'action', 'MANUAL_UPDATE_DETAILS',
    'changed_fields', to_jsonb(v_changed_fields),
    'reconciliation', public.direct_entry__internal_project_cccd_reconciliation(v_rec)
  );
end;
$function$;

revoke all on function public.direct_entry_apply_cccd_manual_resolution(
  uuid, uuid, uuid, integer, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_apply_cccd_manual_resolution(
  uuid, uuid, uuid, integer, jsonb, text
) to service_role;

do $owner_align$
declare
  v_base_owner_oid oid;
  v_base_owner name;
begin
  select c.relowner, r.rolname into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;
  if v_base_owner_oid is not null
     and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter function public.direct_entry_apply_cccd_manual_resolution(uuid, uuid, uuid, integer, jsonb, text) owner to %I',
      v_base_owner
    );
  end if;
end;
$owner_align$;

commit;
