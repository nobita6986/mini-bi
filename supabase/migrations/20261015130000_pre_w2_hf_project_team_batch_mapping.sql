-- =============================================================================
-- PRE-W2-HF Project <-> Team mapping batch/OCC usability (#97, append-only).
--
-- Preserve the existing routes, Full Admin guard, mapping history, reason,
-- idempotency, audit, and service-role boundary. Grant accepts one team and a
-- bounded project batch; DB locks serialize pair versions and choose today's
-- canonical authorization date. Client-supplied pair versions are retired.
-- =============================================================================

begin;

create or replace function public.direct_entry_grant_project_team_scopes_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_project_ids text[],
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_project_ids text[];
  v_project_id text;
  v_project_count integer;
  v_team public.teams;
  v_effective_from date := public.direct_entry_authorization_date();
  v_current_version integer;
  v_mapping public.direct_entry_project_team_scopes;
  v_reason_id uuid;
  v_created jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_payload_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_project_ids is null or cardinality(p_project_ids) not between 1 and 100
     or array_position(p_project_ids, null) is not null
     or exists (
       select 1 from unnest(p_project_ids) ids(project_id)
        where ids.project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     )
     or (select count(*) from unnest(p_project_ids)) <>
        (select count(distinct ids.project_id) from unnest(p_project_ids) ids(project_id)) then
    raise exception 'project batch is invalid' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  select array_agg(ids.project_id order by ids.project_id)
    into v_project_ids
    from unnest(p_project_ids) ids(project_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'team_id', p_team_id,
    'project_ids', to_jsonb(v_project_ids),
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_batch_grant', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  perform p.project_id
    from public.direct_entry_projects p
   where p.project_id = any(v_project_ids)
   order by p.project_id
   for update;
  select count(*)::int into v_project_count
    from public.direct_entry_projects p
   where p.project_id = any(v_project_ids);
  if v_project_count <> cardinality(v_project_ids) then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.direct_entry_projects p
     where p.project_id = any(v_project_ids) and not p.active
  ) then
    raise exception 'project is not active' using errcode = '22023';
  end if;

  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if not v_team.active or v_team.code = '__system_vendor__' then
    raise exception 'team is not active' using errcode = '22023';
  end if;

  for v_project_id in
    select ids.project_id from unnest(v_project_ids) ids(project_id) order by ids.project_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('project-team-scope:' || v_project_id, 0));
  end loop;

  for v_project_id in select unnest(v_project_ids) order by 1 loop
    select s.* into v_mapping
      from public.direct_entry_project_team_scopes s
     where s.project_id = v_project_id
       and s.team_id = p_team_id
       and s.valid_from <= v_effective_from
       and (s.valid_to is null or v_effective_from < s.valid_to)
     order by s.valid_from desc, s.mapping_id desc
     limit 1;
    if found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'project_id', v_project_id,
        'status', 'ALREADY_EFFECTIVE',
        'mapping_id', v_mapping.mapping_id,
        'version', v_mapping.version
      ));
      continue;
    end if;

    select coalesce(max(s.version), 0)::int into v_current_version
      from public.direct_entry_project_team_scopes s
     where s.project_id = v_project_id and s.team_id = p_team_id;
    if v_reason_id is null then
      v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
    end if;
    insert into public.direct_entry_project_team_scopes (
      project_id, team_id, valid_from, valid_to, version,
      granted_by_user_id, reason_id
    ) values (
      v_project_id, p_team_id, v_effective_from, null, v_current_version + 1,
      p_app_user_id, v_reason_id
    ) returning * into v_mapping;

    insert into public.direct_entry_audit_events
      (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
       outcome, reason_id, changed_fields)
    values
      (p_auth_subject, p_app_user_id, 'project_team_scope_grant', v_authority,
       v_mapping.mapping_id::text, 'all', 'APPLIED', v_reason_id,
       array['project_id', 'team_id', 'valid_from']);

    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'mapping_id', v_mapping.mapping_id,
      'project_id', v_mapping.project_id,
      'team_id', v_mapping.team_id,
      'valid_from', v_mapping.valid_from,
      'valid_to', v_mapping.valid_to,
      'version', v_mapping.version,
      'created', true
    ));
  end loop;

  v_result := jsonb_build_object(
    'team_id', p_team_id,
    'effective_from', v_effective_from,
    'created', v_created,
    'skipped', v_skipped
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_batch_grant', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_grant_project_team_scopes_batch(uuid, uuid, uuid, text[], text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_grant_project_team_scopes_batch(uuid, uuid, uuid, text[], text, text)
  to service_role;
comment on function public.direct_entry_grant_project_team_scopes_batch(uuid, uuid, uuid, text[], text, text) is
  'PRE-W2-HF Full Admin batch grant. One active team + 1..100 active projects, canonical DB authorization date, atomic writes, skip already-effective pairs, DB-owned pair version, reason, per-created-pair immutable audit, and exact idempotent replay. service_role only.';

-- Keep the versioned RPC and its existing ACL intact until the old UI/API caller
-- is retired. The new API uses the batch RPC; deployment still requires T1A coordination.

create or replace function public.direct_entry_revoke_project_team_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_mapping_id uuid,
  p_effective_to date,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_project_id text;
  v_mapping public.direct_entry_project_team_scopes;
  v_revoke_to date;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_result jsonb;
begin
  if p_mapping_id is null then
    raise exception 'mapping required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'mapping_id', p_mapping_id,
    'effective_to', p_effective_to,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_revoke_v2', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  select s.project_id into v_project_id
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id;
  if v_project_id is null then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;

  -- Immutable mapping identity; project then mapping row is the migration #94 lock order.
  perform p.project_id
    from public.direct_entry_projects p
   where p.project_id = v_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  select s.* into v_mapping
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id
   for update;
  if not found then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;
  if v_mapping.valid_to is not null then
    raise exception 'project team mapping is already revoked' using errcode = '22023';
  end if;
  if p_effective_to is not null
     and p_effective_to > public.direct_entry_authorization_date() then
    raise exception 'revoke date must not be in the future' using errcode = '22023';
  end if;
  if p_effective_to is not null and p_effective_to < v_mapping.valid_from then
    raise exception 'revoke date must not precede the mapping start' using errcode = '22023';
  end if;
  v_revoke_to := greatest(
    coalesce(p_effective_to, public.direct_entry_authorization_date()),
    v_mapping.valid_from
  );

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if v_revoke_to = v_mapping.valid_from then
    perform set_config('direct_entry.project_team_scope_marker', 'on', true);
  end if;
  update public.direct_entry_project_team_scopes
     set valid_to = v_revoke_to,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where mapping_id = p_mapping_id
  returning * into v_mapping;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_team_scope_revoke', v_authority,
     p_mapping_id::text, 'all', 'APPLIED', v_reason_id, array['valid_to']);

  v_result := jsonb_build_object(
    'mapping_id', v_mapping.mapping_id,
    'project_id', v_mapping.project_id,
    'team_id', v_mapping.team_id,
    'valid_to', v_mapping.valid_to,
    'version', v_mapping.version,
    'revoked', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_revoke_v2', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, date, text, text)
  to service_role;
comment on function public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, date, text, text) is
  'PRE-W2-HF Full Admin revoke without client OCC version. Locks project then mapping, reads and increments persisted version under lock, retains immediate close, reason, exact v2 idempotency and immutable audit. service_role only.';

do $check$
declare
  v_signature text;
  v_source text;
  v_prosecdef boolean;
  v_config text;
begin
  foreach v_signature in array array[
    'public.direct_entry_grant_project_team_scopes_batch(uuid,uuid,uuid,text[],text,text)',
    'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,date,text,text)'
  ] loop
    select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''), pg_get_functiondef(p.oid)
      into v_prosecdef, v_config, v_source
      from pg_proc p where p.oid = to_regprocedure(v_signature);
    if not coalesce(v_prosecdef, false) or v_config <> 'search_path=pg_catalog, public'
       or has_function_privilege('public', v_signature, 'EXECUTE')
       or has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'PRE-W2-HF batch mapping RPC boundary wrong: %', v_signature
        using errcode = '55000';
    end if;
  end loop;

  foreach v_signature in array array[
    'public.direct_entry_grant_project_team_scope(uuid,uuid,text,uuid,integer,date,text,text)',
    'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,integer,date,text,text)'
  ] loop
    if has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'PRE-W2-HF legacy mapping RPC rollout boundary wrong: %', v_signature
        using errcode = '55000';
    end if;
  end loop;

  if not has_function_privilege(
       'service_role',
       'public.direct_entry_grant_project_team_scope(uuid,uuid,text,uuid,integer,date,text,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,integer,date,text,text)',
       'EXECUTE'
     ) then
    raise exception 'PRE-W2-HF legacy versioned mapping RPCs must remain available for rollout'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'public.direct_entry_grant_project_team_scopes_batch(uuid,uuid,uuid,text[],text,text)'::regprocedure
  ) into v_source;
  if v_source not like '%direct_entry_assert_actor_app_user_admin%'
     or v_source not like '%direct_entry_authorization_date%'
     or v_source not like '%for update%'
     or v_source not like '%pg_advisory_xact_lock%'
     or v_source not like '%direct_entry_idempotency_begin%'
     or v_source not like '%direct_entry_idempotency_finish%'
     or v_source not like '%project_team_scope_grant%' then
    raise exception 'PRE-W2-HF atomic batch grant self-check failed'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,date,text,text)'::regprocedure
  ) into v_source;
  if v_source not like '%direct_entry_assert_actor_app_user_admin%'
     or v_source not like '%where s.mapping_id = p_mapping_id%for update%'
     or v_source not like '%version = version + 1%'
     or v_source not like '%direct_entry_idempotency_begin%'
     or v_source not like '%direct_entry_idempotency_finish%' then
    raise exception 'PRE-W2-HF DB-owned revoke OCC self-check failed'
      using errcode = '55000';
  end if;
end
$check$;

commit;
