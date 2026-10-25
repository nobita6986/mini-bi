-- =============================================================================
-- PRE-W2-HF: Fix stage submission guard (full_profile_batch_create_v2 action),
-- stage replay idempotency, and SECURITY DEFINER function/table owner alignment
-- for Direct Entry full-profile batch save and post-save document uploads.
-- =============================================================================

create or replace function public.direct_entry_worker_document_stage_submission_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $stage$
declare
  v_submission_id uuid;
begin
  if new.status = 'ATTACHED' then
    select e.submission_id into v_submission_id
      from public.direct_entries e
     where e.entry_id = new.entry_id;
    if not found or (new.submission_id is not null and new.submission_id <> v_submission_id) then
      raise exception 'worker document stage submission mismatch' using errcode = '40001';
    end if;
    new.submission_id := v_submission_id;
  elsif new.submission_id is not null and not exists (
    select 1
      from public.direct_entry_rpc_idempotency i
     where i.app_user_id = new.created_by_user_id
       and i.action in ('full_profile_batch_create', 'full_profile_batch_create_v2')
       and i.idempotency_key = new.claim_idempotency_key
       and i.result->>'submission_id' = new.submission_id::text
  ) then
    raise exception 'worker document stage submission mismatch' using errcode = '40001';
  end if;
  if old.submission_id is not null and new.submission_id is distinct from old.submission_id then
    raise exception 'worker document stage submission immutable' using errcode = '40001';
  end if;
  return new;
end;
$stage$;

update public.direct_entry_worker_portrait_stages s
   set submission_id = (i.result->>'submission_id')::uuid
  from public.direct_entry_rpc_idempotency i
 where s.status = 'CLAIMED'
   and s.submission_id is null
   and s.created_by_user_id = i.app_user_id
   and s.claim_idempotency_key = i.idempotency_key
   and i.action in ('full_profile_batch_create', 'full_profile_batch_create_v2')
   and i.result->>'submission_id' ~*
     '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

create or replace function public.direct_entry_create_full_profile_batch_with_portrait_stages(
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
  v_result jsonb;
  v_submission_id uuid;
  v_linked integer;
begin
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'document_upload'
  );
  if p_idempotency_key is null or
     p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_stage_ids is null or cardinality(p_stage_ids) not between 1 and 400
     or exists (select 1 from unnest(p_stage_ids) id where id is null)
     or (select count(distinct id) from unnest(p_stage_ids) id) <> cardinality(p_stage_ids) then
    raise exception 'worker document stage batch invalid' using errcode = '22023';
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
      raise exception 'worker document stage not found' using errcode = '42501';
    end if;
    if v_stage.status not in ('CLAIMED', 'ATTACHED')
       or v_stage.claim_idempotency_key <> p_idempotency_key then
      raise exception 'worker document stage claim conflict' using errcode = '40001';
    end if;
  end loop;

  v_result := public.direct_entry_create_full_profile_batch_v2(
    p_auth_subject, p_app_user_id, p_contract_version, p_rows, p_idempotency_key
  );
  v_submission_id := (v_result->>'submission_id')::uuid;

  update public.direct_entry_worker_portrait_stages s
     set submission_id = v_submission_id
   where s.stage_id = any(p_stage_ids)
     and s.created_by_user_id = p_app_user_id
     and s.claim_idempotency_key = p_idempotency_key
     and (s.submission_id is null or s.submission_id = v_submission_id)
     and (
       s.status = 'CLAIMED'
       or (s.status = 'ATTACHED' and exists (
         select 1 from public.direct_entries e
          where e.entry_id = s.entry_id and e.submission_id = v_submission_id
       ))
     );
  get diagnostics v_linked = row_count;
  if v_linked <> cardinality(p_stage_ids) then
    raise exception 'worker document stage submission mismatch' using errcode = '40001';
  end if;

  return v_result;
end;
$batch$;

do $owner_align$
declare
  v_base_owner name;
  v_fn regprocedure;
  v_rel record;
begin
  select pg_catalog.pg_get_userbyid(c.relowner)
    into v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'direct_entry_app_users';

  if v_base_owner is null then
    return;
  end if;

  for v_rel in
    select c.oid::regclass as tbl
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relname in (
         'direct_entries',
         'direct_entry_submissions',
         'direct_entry_worker_portrait_stages',
         'direct_entry_document_versions',
         'direct_entry_document_events',
         'direct_entry_cccd_qr_extractions',
         'direct_entry_cccd_reconciliations'
       )
  loop
    execute pg_catalog.format('alter table %s owner to %I', v_rel.tbl, v_base_owner);
    execute pg_catalog.format('grant select, insert, update, delete on table %s to %I', v_rel.tbl, v_base_owner);
  end loop;

  for v_fn in
    select p.oid::regprocedure
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'direct_entry_valid_worker_details',
         'direct_entry_create_full_profile_batch',
         'direct_entry_create_full_profile_batch_v2',
         'direct_entry_create_full_profile_batch_v2_unscoped_h03',
         'direct_entry_create_full_profile_batch_with_portrait_stages',
         'direct_entry_update_draft_row_full_profile',
         'direct_entry_assert_document_upload_access',
         'direct_entry_reserve_document_direct_upload',
         'direct_entry_finalize_document_direct_upload',
         'direct_entry_document_direct_context',
         'direct_entry__internal_normalize_cccd_digits',
         'direct_entry__internal_version_compatible_after_qr_autofill',
         'direct_entry__internal_recompute_cccd_reconciliation',
         'direct_entry_prepare_cccd_qr_extraction',
         'direct_entry_complete_cccd_qr_extraction',
         'direct_entry_get_entry_cccd_reconciliation',
         'direct_entry_list_cccd_review_queue',
         'direct_entry_resolve_cccd_review'
       )
  loop
    execute pg_catalog.format('alter function %s owner to %I', v_fn, v_base_owner);
    execute pg_catalog.format('grant execute on function %s to %I', v_fn, v_base_owner);
  end loop;
end;
$owner_align$;

revoke all on function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  uuid, uuid, text, jsonb, text, uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  uuid, uuid, text, jsonb, text, uuid[]
) to service_role;
