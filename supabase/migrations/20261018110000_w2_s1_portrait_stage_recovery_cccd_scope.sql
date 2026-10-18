begin;

create function public.direct_entry_w2s1_r2_replace_function_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
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
    raise exception 'W2S1 R2 function source missing' using errcode = '55000';
  end if;
  v_definition := replace(replace(v_definition, E'\r\n', E'\n'), E'\r', E'\n');
  v_count := (length(v_definition) - length(replace(v_definition, v_expected, '')))
    / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'W2S1 R2 source drift for %: expected %, found %',
      p_signature, p_expected_count, v_count using errcode = '55000';
  end if;
  execute replace(v_definition, v_expected, v_replacement);
end;
$replace$;
revoke all on function public.direct_entry_w2s1_r2_replace_function_source(
  regprocedure, text, text, integer
) from public, anon, authenticated, service_role;

select public.direct_entry_w2s1_r2_replace_function_source(
  'public.direct_entry_create_worker_portrait_stage(uuid,uuid,uuid,text,bigint,text)'::regprocedure,
  $old$g.capability in ('document_upload', 'change_request_create')$old$,
  $new$g.capability = 'document_upload'$new$,
  1
);
select public.direct_entry_w2s1_r2_replace_function_source(
  'public.direct_entry_claim_worker_portrait_stage(uuid,uuid,uuid,text)'::regprocedure,
  $old$g.capability in ('document_upload', 'change_request_create')$old$,
  $new$g.capability = 'document_upload'$new$,
  1
);

select public.direct_entry_w2s1_r2_replace_function_source(
  'public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'full_profile_batch_create_v2', p_idempotency_key, v_hash
  );$old$,
  $new$  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':' || p_idempotency_key, 0)
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'full_profile_batch_create_v2', p_idempotency_key, v_hash
  );$new$,
  1
);

select public.direct_entry_w2s1_r2_replace_function_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$if p_purpose not in ('finalize', 'download', 'preview') then$old$,
  $new$if p_purpose not in ('finalize', 'download', 'preview', 'cccd_preview') then$new$,
  1
);
select public.direct_entry_w2s1_r2_replace_function_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$    if p_purpose = 'download' then
      perform public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    else
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found then
        raise exception 'document not found' using errcode = 'P0002';
      end if;
      if v_document.document_type <> 'WORKER_PORTRAIT' then
        raise exception 'private preview is portrait-only' using errcode = 'P0002';
      end if;
      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'entry_privileged_edit',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    end if;$old$,
  $new$    if p_purpose = 'download' then
      perform public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    elsif p_purpose = 'cccd_preview' then
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found or v_document.document_type not in ('CCCD_FRONT', 'CCCD_BACK') then
        raise exception 'document is not a CCCD image' using errcode = 'P0002';
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
    else
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found then
        raise exception 'document not found' using errcode = 'P0002';
      end if;
      if v_document.document_type <> 'WORKER_PORTRAIT' then
        raise exception 'private preview is portrait-only' using errcode = 'P0002';
      end if;
      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'entry_privileged_edit',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    end if;$new$,
  1
);
select public.direct_entry_w2s1_r2_replace_function_source(
  'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure,
  $old$if p_purpose in ('download', 'preview') and not ($old$,
  $new$if p_purpose in ('download', 'preview', 'cccd_preview') and not ($new$,
  1
);

create function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_contract_version text,
  p_rows jsonb,
  p_idempotency_key text,
  p_stage_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $batch$
declare
  v_stage_id uuid;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'document_upload'
  );
  if p_idempotency_key is null or
     p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_stage_ids is null or cardinality(p_stage_ids) not between 1 and 100
     or exists (select 1 from unnest(p_stage_ids) id where id is null)
     or (select count(distinct id) from unnest(p_stage_ids) id) <> cardinality(p_stage_ids) then
    raise exception 'portrait stage batch invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':' || p_idempotency_key, 0)
  );
  for v_stage_id in select id from unnest(p_stage_ids) id order by id loop
    select * into v_stage
      from public.direct_entry_worker_portrait_stages
     where stage_id = v_stage_id and created_by_user_id = p_app_user_id
     for update;
    if not found then
      raise exception 'portrait stage not found' using errcode = '42501';
    end if;
    if v_stage.status <> 'CLAIMED' or v_stage.claim_idempotency_key <> p_idempotency_key then
      raise exception 'portrait stage claim conflict' using errcode = '40001';
    end if;
  end loop;

  return public.direct_entry_create_full_profile_batch_v2(
    p_auth_subject, p_app_user_id, p_contract_version, p_rows, p_idempotency_key
  );
end;
$batch$;
revoke all on function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  uuid,uuid,text,jsonb,text,uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  uuid,uuid,text,jsonb,text,uuid[]
) to service_role;

create function public.direct_entry_recover_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $recover$
declare
  v_initial_status text;
  v_initial_key text;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
  v_result jsonb;
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;

  select status, claim_idempotency_key into v_initial_status, v_initial_key
    from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_initial_status = 'CLAIMED' and v_initial_key is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(p_app_user_id::text || ':' || v_initial_key, 0)
    );
  end if;

  select * into v_stage
    from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id
   for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_stage.status <> v_initial_status or
     v_stage.claim_idempotency_key is distinct from v_initial_key then
    raise exception 'portrait stage changed during recovery' using errcode = '40001';
  end if;

  if v_stage.status = 'CLAIMED' then
    select result into v_result
      from public.direct_entry_rpc_idempotency
     where app_user_id = p_app_user_id
       and action = 'full_profile_batch_create_v2'
       and idempotency_key = v_stage.claim_idempotency_key;
    if found then
      if v_result is null then
        raise exception 'portrait batch result is incomplete' using errcode = '40001';
      end if;
    else
      update public.direct_entry_worker_portrait_stages
         set status = 'STAGED', claim_idempotency_key = null
       where stage_id = p_stage_id returning * into v_stage;
    end if;
  end if;

  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
    'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
    'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$recover$;
revoke all on function public.direct_entry_recover_worker_portrait_stage(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_recover_worker_portrait_stage(uuid,uuid,uuid)
  to service_role;

select public.direct_entry_w2s1_r2_replace_function_source(
  'public.direct_entry_complete_worker_portrait_stage(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure,
  $old$  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;
  select * into v_stage from public.direct_entry_worker_portrait_stages$old$,
  $new$  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'document_upload'
  );
  select * into v_stage from public.direct_entry_worker_portrait_stages$new$,
  1
);
select public.direct_entry_w2s1_r2_replace_function_source(
  'public.direct_entry_complete_worker_portrait_stage(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure,
  $old$          and d.document_type = 'WORKER_PORTRAIT'
          and d.created_by_user_id = p_app_user_id$old$,
  $new$          and d.document_type = 'WORKER_PORTRAIT'
          and d.created_by_user_id = p_app_user_id
          and d.size_bytes = v_stage.size_bytes
          and d.mime_type = v_stage.mime_type
          and coalesce(
            (select o.checksum_sha256 from public.direct_entry_document_objects o
              where o.document_id = d.document_id),
            d.checksum_sha256
          ) = v_stage.checksum_sha256
          and exists (
            select 1 from public.direct_entry_document_events ev
             where ev.document_id = d.document_id
               and ev.upload_status = 'READY'
               and ev.validation_status = 'VALIDATED'
               and ev.scan_status in ('CLEAN', 'NOT_REQUIRED')
               and ev.version = (
                 select max(latest.version) from public.direct_entry_document_events latest
                  where latest.document_id = d.document_id
               )
          )$new$,
  1
);

drop function public.direct_entry_w2s1_r2_replace_function_source(
  regprocedure, text, text, integer
);

commit;
