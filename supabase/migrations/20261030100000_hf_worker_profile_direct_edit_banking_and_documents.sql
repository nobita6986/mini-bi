-- Hotfix Worker Profile Direct Edit: allow updating banking fields (payment) in
-- direct_entry_privileged_edit and allow direct-edit actors with document_upload
-- capability to upload or replace worker documents on SUBMITTED entries.

begin;

do $grant_hf_direct_edit_internal$
declare
  v_owner name;
begin
  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure,
       'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)'::regprocedure
     )
  loop
    execute format(
      'grant execute on function public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid) to %I',
      v_owner
    );
    execute format(
      'grant execute on function public.direct_entry_assert_actor_app_user_admin(uuid,uuid) to %I',
      v_owner
    );
    execute format(
      'grant execute on function public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid) to %I',
      v_owner
    );
    execute format(
      'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid,text) to %I',
      v_owner
    );
  end loop;
end;
$grant_hf_direct_edit_internal$;

do $patch_privileged_edit_payment$
declare
  v_signature regprocedure :=
    'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
  v_before_owner oid;
  v_before_acl aclitem[];
  v_before_secdef boolean;
  v_before_config text[];
  v_source text;
  v_definition text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.proowner, p.proacl, p.prosecdef, p.proconfig, p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    into v_before_owner, v_before_acl, v_before_secdef, v_before_config, v_source, v_definition
    from pg_catalog.pg_proc p
   where p.oid = v_signature;

  v_next := replace(v_source, E'\r\n', E'\n');

  if position('v_payment jsonb;' in v_next) = 0 then
    v_old := '  v_status_version integer;';
    v_new := v_old || E'\n  v_payment jsonb;';
    if position(v_old in v_next) = 0 then
      raise exception 'HF direct edit declaration drift in direct_entry_privileged_edit' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    v_old := $old$     or (p_patch - array['project_id','first_work_date','employee_code','worker_details',
                        'recruiter_id','labor_type','employment_status']) <> '{}'::jsonb then$old$;
    v_new := $new$     or (p_patch - array['project_id','first_work_date','employee_code','worker_details',
                        'recruiter_id','labor_type','employment_status','payment']) <> '{}'::jsonb then$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'HF direct edit patch key allowlist drift in direct_entry_privileged_edit' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    v_old := $old$      raise exception 'invalid privileged employment status' using errcode = '22023';
    end if;
  end if;$old$;
    v_new := v_old || E'\n' || $new$  if p_patch ? 'payment' then
    v_payment := p_patch->'payment';
    if jsonb_typeof(v_payment) <> 'object'
       or (v_payment - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb
       or not (v_payment ? 'state' and v_payment ? 'account_number' and v_payment ? 'bank_id' and v_payment ? 'account_holder_name')
       or jsonb_typeof(v_payment->'state') <> 'string'
       or v_payment->>'state' not in ('omitted','unknown','intentionally_blank','provided')
       or (v_payment->>'state' <> 'provided' and (
         jsonb_typeof(v_payment->'account_number') <> 'null'
         or jsonb_typeof(v_payment->'bank_id') <> 'null'
         or jsonb_typeof(v_payment->'account_holder_name') <> 'null'
       ))
       or (v_payment->>'state' = 'provided' and (
         jsonb_typeof(v_payment->'account_number') <> 'string'
         or (v_payment->>'account_number') !~ '^[0-9]{1,64}$'
         or jsonb_typeof(v_payment->'bank_id') <> 'string'
         or (v_payment->>'bank_id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
         or jsonb_typeof(v_payment->'account_holder_name') <> 'string'
         or length(btrim(v_payment->>'account_holder_name')) not between 1 and 256
         or (v_payment->>'account_holder_name') ~ '[[:cntrl:]]'
       )) then
      raise exception 'invalid privileged payment input' using errcode = '22023';
    end if;
  end if;$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'HF direct edit status validation drift in direct_entry_privileged_edit' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    v_old := $old$      v_status_version, p_app_user_id, v_reason_id, null
    );
  end if;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);$old$;
    v_new := $new$      v_status_version, p_app_user_id, v_reason_id, null
    );
  end if;
  if v_payment is not null then
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
    ) values (
      p_entry_id, v_payment->>'state', v_payment->>'account_number',
      v_payment->>'bank_id', null,
      case when v_payment->>'account_holder_name' is null then null else btrim(v_payment->>'account_holder_name') end,
      1
    )
    on conflict (entry_id) do update set
      state = excluded.state,
      account_number = excluded.account_number,
      bank_id = excluded.bank_id,
      bank_name = null,
      account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1,
      updated_at = now();
  end if;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'HF direct edit mutation body drift in direct_entry_privileged_edit' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    execute replace(replace(v_definition, E'\r\n', E'\n'), replace(v_source, E'\r\n', E'\n'), v_next);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = v_signature
       and p.proowner = v_before_owner
       and p.proacl is not distinct from v_before_acl
       and p.prosecdef is not distinct from v_before_secdef
       and p.proconfig is not distinct from v_before_config
  ) then
    raise exception 'HF direct edit changed security metadata on direct_entry_privileged_edit' using errcode = '55000';
  end if;
end;
$patch_privileged_edit_payment$;

do $patch_document_upload_direct_edit_access$
declare
  v_signature regprocedure :=
    'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)'::regprocedure;
  v_before_owner oid;
  v_before_acl aclitem[];
  v_before_secdef boolean;
  v_before_config text[];
  v_source text;
  v_definition text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.proowner, p.proacl, p.prosecdef, p.proconfig, p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    into v_before_owner, v_before_acl, v_before_secdef, v_before_config, v_source, v_definition
    from pg_catalog.pg_proc p
   where p.oid = v_signature;

  v_next := replace(v_source, E'\r\n', E'\n');

  if position('v_direct_edit_authority text;' in v_next) = 0 then
    v_old := '  v_submission_state text;';
    v_new := v_old || E'\n  v_is_full_admin boolean := false;\n  v_current_team_leader_team_id uuid;\n  v_direct_edit_authority text;';
    if position(v_old in v_next) = 0 then
      raise exception 'HF direct edit declaration drift in direct_entry_assert_document_upload_access' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    v_old := $old$  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit'
  );
  return public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'document_upload',
    v_entry.created_by_user_id, v_entry.team_id,
    v_entry.first_work_date, null
  );$old$;
    v_new := $new$  if v_submission_state = 'SUBMITTED' then
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'document_upload'
    );
    begin
      perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
      v_is_full_admin := true;
    exception when insufficient_privilege then
      null;
    end;
    begin
      v_current_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
        p_auth_subject, p_app_user_id, null
      );
    exception when insufficient_privilege then
      v_current_team_leader_team_id := null;
    end;
    v_direct_edit_authority := public.direct_entry_resolve_direct_edit_authority(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id, v_entry.team_id,
      v_entry.project_id, v_is_full_admin, v_current_team_leader_team_id
    );
    if v_direct_edit_authority is not null then
      perform public.direct_entry_assert_actor(
        p_auth_subject, p_app_user_id, 'document_upload'
      );
      return case
        when v_direct_edit_authority = 'admin_all' then 'all'
        when v_direct_edit_authority = 'team_leader' then 'team'
        when v_direct_edit_authority = 'project_manager' then 'project'
        when v_direct_edit_authority like 'privileged_%'
          then substring(v_direct_edit_authority from 12)
        else 'all'
      end;
    end if;
  end if;

  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit'
  );
  return public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'document_upload',
    v_entry.created_by_user_id, v_entry.team_id,
    v_entry.first_work_date, null
  );$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'HF direct edit authority drift in direct_entry_assert_document_upload_access' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    execute replace(replace(v_definition, E'\r\n', E'\n'), replace(v_source, E'\r\n', E'\n'), v_next);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = v_signature
       and p.proowner = v_before_owner
       and p.proacl is not distinct from v_before_acl
       and p.prosecdef is not distinct from v_before_secdef
       and p.proconfig is not distinct from v_before_config
  ) then
    raise exception 'HF direct edit changed security metadata on direct_entry_assert_document_upload_access' using errcode = '55000';
  end if;
end;
$patch_document_upload_direct_edit_access$;

do $assert_hf_direct_edit_boundary$
declare
  v_edit regprocedure :=
    'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
  v_upload_access regprocedure :=
    'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)'::regprocedure;
begin
  if has_function_privilege('public', v_edit, 'EXECUTE')
     or has_function_privilege('anon', v_edit, 'EXECUTE')
     or has_function_privilege('authenticated', v_edit, 'EXECUTE')
     or not has_function_privilege('service_role', v_edit, 'EXECUTE')
     or has_function_privilege('public', v_upload_access, 'EXECUTE')
     or has_function_privilege('anon', v_upload_access, 'EXECUTE')
     or has_function_privilege('authenticated', v_upload_access, 'EXECUTE')
     or has_function_privilege('service_role', v_upload_access, 'EXECUTE')
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_catalog.pg_proc p where p.oid = v_edit)
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_catalog.pg_proc p where p.oid = v_upload_access)
     or not exists (
       select 1
         from pg_catalog.pg_proc p
        where p.oid = v_upload_access
          and p.prosrc ~* 'if[[:space:]]+v_direct_edit_authority[[:space:]]+is[[:space:]]+not[[:space:]]+null[[:space:]]+then[[:space:]]+perform[[:space:]]+public\.direct_entry_assert_actor\([[:space:]]*p_auth_subject,[[:space:]]*p_app_user_id,[[:space:]]*''document_upload''[[:space:]]*\)'
     )
     or exists (
       select 1
         from pg_catalog.pg_proc p
        where p.oid in (v_edit, v_upload_access)
          and p.prosrc ~* 'errcode[[:space:]]*=[[:space:]]*''40001'''
     ) then
    raise exception 'HF direct edit RPC boundary or PT409 invariant violated' using errcode = '55000';
  end if;
end;
$assert_hf_direct_edit_boundary$;

commit;
