begin;

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
    if v_stage.status <> 'CLAIMED' or v_stage.claim_idempotency_key <> p_idempotency_key then
      raise exception 'worker document stage claim conflict' using errcode = '40001';
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

commit;
