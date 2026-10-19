begin;

alter table public.direct_entry_worker_portrait_stages
  add column document_type text not null default 'WORKER_PORTRAIT';
alter table public.direct_entry_worker_portrait_stages
  drop constraint direct_entry_worker_portrait_stages_mime_type_check;
alter table public.direct_entry_worker_portrait_stages
  add constraint direct_entry_worker_document_stages_type_check
    check (document_type in ('WORKER_PORTRAIT', 'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT')),
  add constraint direct_entry_worker_document_stages_file_check
    check (
      mime_type in ('image/jpeg', 'image/png', 'application/pdf') and
      (document_type <> 'WORKER_PORTRAIT' or mime_type <> 'application/pdf') and
      size_bytes between 1 and 10485760
    );

create function public.direct_entry_create_worker_document_stage_idempotent(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_document_type text,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $stage$
declare
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
  v_key text := lower(p_idempotency_key);
  v_replayed boolean := false;
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'document_upload');
  if v_key is null or
     v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     p_document_type not in ('WORKER_PORTRAIT', 'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT') or
     p_mime_type not in ('image/jpeg', 'image/png', 'application/pdf') or
     (p_document_type = 'WORKER_PORTRAIT' and p_mime_type = 'application/pdf') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'worker document stage invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':document-stage:' || v_key, 0)
  );
  select * into v_stage
    from public.direct_entry_worker_portrait_stages
   where created_by_user_id = p_app_user_id
     and create_idempotency_key = v_key
   for update;
  if found then
    if v_stage.document_type <> p_document_type or v_stage.mime_type <> p_mime_type or
       v_stage.size_bytes <> p_size_bytes or v_stage.checksum_sha256 <> p_checksum_sha256 then
      raise exception 'worker document stage idempotency conflict' using errcode = '40001';
    end if;
    v_replayed := true;
  else
    insert into public.direct_entry_worker_portrait_stages (
      stage_id, created_by_user_id, document_type, mime_type, size_bytes,
      checksum_sha256, create_idempotency_key
    ) values (
      p_stage_id, p_app_user_id, p_document_type, p_mime_type, p_size_bytes,
      p_checksum_sha256, v_key
    ) returning * into v_stage;
  end if;

  return jsonb_build_object(
    'stage', jsonb_build_object(
      'stage_id', v_stage.stage_id, 'document_type', v_stage.document_type,
      'mime_type', v_stage.mime_type, 'size_bytes', v_stage.size_bytes,
      'checksum_sha256', v_stage.checksum_sha256, 'status', v_stage.status,
      'claim_idempotency_key', v_stage.claim_idempotency_key,
      'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
    ),
    'replayed', v_replayed
  );
end;
$stage$;

create function public.direct_entry_get_worker_document_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $stage$
declare
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;
  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'document_type', v_stage.document_type,
    'mime_type', v_stage.mime_type, 'size_bytes', v_stage.size_bytes,
    'checksum_sha256', v_stage.checksum_sha256, 'status', v_stage.status,
    'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$stage$;

create function public.direct_entry_complete_worker_document_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_idempotency_key text,
  p_entry_id uuid,
  p_document_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $stage$
declare
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'document_upload');
  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_stage.status = 'ATTACHED' then
    if v_stage.claim_idempotency_key = p_idempotency_key and
       v_stage.entry_id = p_entry_id and v_stage.document_id = p_document_id then return true; end if;
    raise exception 'worker document stage attachment conflict' using errcode = '40001';
  end if;
  if v_stage.status <> 'CLAIMED' or v_stage.claim_idempotency_key <> p_idempotency_key or
     not exists (
       select 1 from public.direct_entries e
       join public.direct_entry_document_versions d on d.candidate_id = e.candidate_id
        where e.entry_id = p_entry_id and d.document_id = p_document_id
          and d.document_type = v_stage.document_type
          and d.created_by_user_id = p_app_user_id
          and d.size_bytes = v_stage.size_bytes
          and d.mime_type = v_stage.mime_type
          and coalesce(
            (select o.checksum_sha256 from public.direct_entry_document_objects o
              where o.document_id = d.document_id), d.checksum_sha256
          ) = v_stage.checksum_sha256
          and exists (
            select 1 from public.direct_entry_document_events ev
             where ev.document_id = d.document_id and ev.upload_status = 'READY'
               and ev.validation_status = 'VALIDATED'
               and ev.scan_status in ('CLEAN', 'NOT_REQUIRED')
               and ev.version = (
                 select max(latest.version) from public.direct_entry_document_events latest
                  where latest.document_id = d.document_id
               )
          )
     ) then
    raise exception 'worker document stage attachment conflict' using errcode = '40001';
  end if;
  update public.direct_entry_worker_portrait_stages
     set status = 'ATTACHED', entry_id = p_entry_id, document_id = p_document_id
   where stage_id = p_stage_id;
  return true;
end;
$stage$;

revoke all on function public.direct_entry_create_worker_document_stage_idempotent(
  uuid,uuid,uuid,text,text,bigint,text,text
) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_get_worker_document_stage(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_complete_worker_document_stage(
  uuid,uuid,uuid,text,uuid,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_worker_document_stage_idempotent(
  uuid,uuid,uuid,text,text,bigint,text,text
) to service_role;
grant execute on function public.direct_entry_get_worker_document_stage(uuid,uuid,uuid)
  to service_role;
grant execute on function public.direct_entry_complete_worker_document_stage(
  uuid,uuid,uuid,text,uuid,uuid
) to service_role;

commit;
