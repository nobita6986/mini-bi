begin;

create table public.direct_entry_worker_portrait_stages (
  stage_id uuid primary key,
  created_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'STAGED'
    check (status in ('STAGED', 'CLAIMED', 'ATTACHED', 'CANCELLED')),
  claim_idempotency_key text check (
    claim_idempotency_key is null or length(claim_idempotency_key) between 1 and 128
  ),
  entry_id uuid references public.direct_entries(entry_id) on delete restrict,
  document_id uuid references public.direct_entry_document_versions(document_id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  check (
    (status = 'STAGED' and claim_idempotency_key is null and entry_id is null and document_id is null)
    or (status = 'CLAIMED' and claim_idempotency_key is not null and entry_id is null and document_id is null)
    or (status = 'ATTACHED' and claim_idempotency_key is not null and entry_id is not null and document_id is not null)
    or (status = 'CANCELLED' and entry_id is null and document_id is null)
  )
);

alter table public.direct_entry_worker_portrait_stages enable row level security;
alter table public.direct_entry_worker_portrait_stages force row level security;
revoke all on table public.direct_entry_worker_portrait_stages
  from public, anon, authenticated, service_role;

create function public.direct_entry_create_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $stage$
declare
  v_date date := public.direct_entry_authorization_date();
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability in ('document_upload', 'change_request_create')
       and g.valid_from <= v_date and (g.valid_to is null or v_date < g.valid_to)
  ) then raise exception 'capability denied' using errcode = '42501'; end if;
  if p_mime_type not in ('image/jpeg', 'image/png') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'portrait stage invalid' using errcode = '22023';
  end if;
  insert into public.direct_entry_worker_portrait_stages (
    stage_id, created_by_user_id, mime_type, size_bytes, checksum_sha256
  ) values (
    p_stage_id, p_app_user_id, p_mime_type, p_size_bytes, p_checksum_sha256
  ) returning * into v_stage;
  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
    'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
    'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$stage$;

create function public.direct_entry_claim_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $stage$
declare
  v_date date := public.direct_entry_authorization_date();
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability in ('document_upload', 'change_request_create')
       and g.valid_from <= v_date and (g.valid_to is null or v_date < g.valid_to)
  ) then raise exception 'capability denied' using errcode = '42501'; end if;
  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'portrait stage claim invalid' using errcode = '22023';
  end if;
  if v_stage.status = 'STAGED' then
    update public.direct_entry_worker_portrait_stages
       set status = 'CLAIMED', claim_idempotency_key = p_idempotency_key
     where stage_id = p_stage_id returning * into v_stage;
  elsif v_stage.status not in ('CLAIMED', 'ATTACHED') or
        v_stage.claim_idempotency_key <> p_idempotency_key then
    raise exception 'portrait stage already claimed' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
    'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
    'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$stage$;

create function public.direct_entry_release_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_idempotency_key text
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
  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_stage.status = 'STAGED' then return true; end if;
  if v_stage.status <> 'CLAIMED' or v_stage.claim_idempotency_key <> p_idempotency_key then
    raise exception 'portrait stage release conflict' using errcode = '40001';
  end if;
  update public.direct_entry_worker_portrait_stages
     set status = 'STAGED', claim_idempotency_key = null
   where stage_id = p_stage_id;
  return true;
end;
$stage$;

create function public.direct_entry_complete_worker_portrait_stage(
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
  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_stage.status = 'ATTACHED' then
    if v_stage.claim_idempotency_key = p_idempotency_key and
       v_stage.entry_id = p_entry_id and v_stage.document_id = p_document_id then
      return true;
    end if;
    raise exception 'portrait stage attachment conflict' using errcode = '40001';
  end if;
  if v_stage.status <> 'CLAIMED' or v_stage.claim_idempotency_key <> p_idempotency_key or
     not exists (
       select 1 from public.direct_entries e
       join public.direct_entry_document_versions d on d.candidate_id = e.candidate_id
        where e.entry_id = p_entry_id and d.document_id = p_document_id
          and d.document_type = 'WORKER_PORTRAIT'
          and d.created_by_user_id = p_app_user_id
     ) then
    raise exception 'portrait stage attachment conflict' using errcode = '40001';
  end if;
  update public.direct_entry_worker_portrait_stages
     set status = 'ATTACHED', entry_id = p_entry_id, document_id = p_document_id
   where stage_id = p_stage_id;
  return true;
end;
$stage$;

create function public.direct_entry_cancel_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid
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
  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_stage.status = 'CANCELLED' then return true; end if;
  if v_stage.status <> 'STAGED' then
    raise exception 'portrait stage cannot be cancelled' using errcode = '40001';
  end if;
  update public.direct_entry_worker_portrait_stages
     set status = 'CANCELLED'
   where stage_id = p_stage_id;
  return true;
end;
$stage$;

revoke all on function public.direct_entry_create_worker_portrait_stage(uuid,uuid,uuid,text,bigint,text)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_claim_worker_portrait_stage(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_release_worker_portrait_stage(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_complete_worker_portrait_stage(uuid,uuid,uuid,text,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_cancel_worker_portrait_stage(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_worker_portrait_stage(uuid,uuid,uuid,text,bigint,text)
  to service_role;
grant execute on function public.direct_entry_claim_worker_portrait_stage(uuid,uuid,uuid,text)
  to service_role;
grant execute on function public.direct_entry_release_worker_portrait_stage(uuid,uuid,uuid,text)
  to service_role;
grant execute on function public.direct_entry_complete_worker_portrait_stage(uuid,uuid,uuid,text,uuid,uuid)
  to service_role;
grant execute on function public.direct_entry_cancel_worker_portrait_stage(uuid,uuid,uuid)
  to service_role;

commit;
