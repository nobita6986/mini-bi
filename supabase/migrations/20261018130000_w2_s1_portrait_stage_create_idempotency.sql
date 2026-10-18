begin;

alter table public.direct_entry_worker_portrait_stages
  add column create_idempotency_key text;
alter table public.direct_entry_worker_portrait_stages
  add constraint direct_entry_worker_portrait_stages_create_key_format
  check (
    create_idempotency_key is null or
    create_idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );
create unique index direct_entry_worker_portrait_stages_create_key_uq
  on public.direct_entry_worker_portrait_stages(created_by_user_id, create_idempotency_key)
  where create_idempotency_key is not null;

revoke all on function public.direct_entry_create_worker_portrait_stage(
  uuid,uuid,uuid,text,bigint,text
) from public, anon, authenticated, service_role;

create function public.direct_entry_create_worker_portrait_stage_idempotent(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
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
  ) then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'document_upload'
  );
  if v_key is null or
     v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     p_mime_type not in ('image/jpeg', 'image/png') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'portrait stage invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':portrait-stage:' || v_key, 0)
  );
  select * into v_stage
    from public.direct_entry_worker_portrait_stages
   where created_by_user_id = p_app_user_id
     and create_idempotency_key = v_key
   for update;
  if found then
    if v_stage.mime_type <> p_mime_type or
       v_stage.size_bytes <> p_size_bytes or
       v_stage.checksum_sha256 <> p_checksum_sha256 then
      raise exception 'portrait stage idempotency conflict' using errcode = '40001';
    end if;
    v_replayed := true;
  else
    insert into public.direct_entry_worker_portrait_stages (
      stage_id, created_by_user_id, mime_type, size_bytes, checksum_sha256,
      create_idempotency_key
    ) values (
      p_stage_id, p_app_user_id, p_mime_type, p_size_bytes, p_checksum_sha256, v_key
    ) returning * into v_stage;
  end if;

  return jsonb_build_object(
    'stage', jsonb_build_object(
      'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
      'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
      'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
      'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
    ),
    'replayed', v_replayed
  );
end;
$stage$;
revoke all on function public.direct_entry_create_worker_portrait_stage_idempotent(
  uuid,uuid,uuid,text,bigint,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_worker_portrait_stage_idempotent(
  uuid,uuid,uuid,text,bigint,text,text
) to service_role;

commit;
