-- Leave administration navigation and optional reasons throughout the leave module.

begin;

alter table public.leave_policy_revisions alter column reason drop not null;
alter table public.leave_department_approvers alter column reason drop not null;
alter table public.leave_module_grants alter column reason drop not null;
alter table public.leave_opening_batches alter column reason drop not null;
alter table public.leave_requests alter column reason drop not null;
alter table public.leave_ledger_entries alter column reason drop not null;
alter table public.leave_audit_events alter column reason drop not null;

do $leave_optional_admin_reasons$
declare
  v_signature regprocedure;
  v_source text;
  v_source_optional text;
  v_definition text;
  v_replaced_length integer;
  v_legacy_line constant text :=
    'v_reason := public.leave_management__internal_validate_reason(p_reason, ''LEAVE_REASON_REQUIRED'');';
  v_optional_line constant text := $replacement$v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;$replacement$;
  v_is_security_definer boolean;
  v_search_path text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  foreach v_signature in array array[
    'public.leave_management_update_policy_admin(uuid, uuid, integer, integer, integer, text, text, text)'::regprocedure,
    'public.leave_management_upsert_employee_profile_admin(uuid, uuid, uuid, boolean, text, text, date, date, date, integer, integer, text, text, text)'::regprocedure,
    'public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text)'::regprocedure,
    'public.leave_management_manage_module_grant_admin(uuid, uuid, text, uuid, text, integer, text, text, text)'::regprocedure,
    'public.leave_management_apply_opening_batch(uuid, uuid, integer, jsonb, text, text, text)'::regprocedure
  ] loop
    select p.prosrc
      into v_source
      from pg_catalog.pg_proc p
     where p.oid = v_signature;

    if v_source is null then
      raise exception 'LEAVE_OPTIONAL_ADMIN_REASON_RPC_MISSING: %', v_signature;
    end if;

    v_replaced_length := pg_catalog.length(v_source)
      - pg_catalog.length(pg_catalog.replace(v_source, v_legacy_line, ''));
    if v_replaced_length <> pg_catalog.length(v_legacy_line) then
      raise exception 'LEAVE_OPTIONAL_ADMIN_REASON_EXPECTED_ONE_REQUIRED_VALIDATOR: %', v_signature;
    end if;

    v_source_optional := pg_catalog.replace(v_source, v_legacy_line, v_optional_line);
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    v_replaced_length := pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_source, ''));
    if v_replaced_length <> pg_catalog.length(v_source) then
      raise exception 'LEAVE_OPTIONAL_ADMIN_REASON_FUNCTION_DEFINITION_MISMATCH: %', v_signature;
    end if;

    execute pg_catalog.replace(v_definition, v_source, v_source_optional);

    select p.prosecdef,
           p.proconfig,
           pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'),
           pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'),
           pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           exists (
             select 1
               from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
              where a.grantee = 0
                and a.privilege_type = 'EXECUTE'
           )
      into v_is_security_definer,
           v_search_path,
           v_service_exec,
           v_anon_exec,
           v_authenticated_exec,
           v_public_exec
      from pg_catalog.pg_proc p
     where p.oid = v_signature;

    if not coalesce(v_is_security_definer, false)
       or not coalesce(v_service_exec, false)
       or coalesce(v_anon_exec, false)
       or coalesce(v_authenticated_exec, false)
       or coalesce(v_public_exec, false)
       or not coalesce(v_search_path @> array['search_path=pg_catalog, public'], false) then
      raise exception 'LEAVE_OPTIONAL_ADMIN_REASON_RPC_SECURITY_DRIFT: %', v_signature;
    end if;
  end loop;
end;
$leave_optional_admin_reasons$;

do $leave_optional_request_reasons$
declare
  v_signature regprocedure;
  v_source text;
  v_source_optional text;
  v_definition text;
  v_legacy text;
  v_optional text;
  v_replaced_length integer;
  v_is_security_definer boolean;
  v_search_path text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  foreach v_signature in array array[
    'public.leave_management_create_request(uuid, uuid, jsonb, text, text, text)'::regprocedure,
    'public.leave_management_decide_request(uuid, uuid, uuid, text, integer, text, text, text)'::regprocedure
  ] loop
    select p.prosrc
      into v_source
      from pg_catalog.pg_proc p
     where p.oid = v_signature;

    if v_source is null then
      raise exception 'LEAVE_OPTIONAL_REQUEST_REASON_RPC_MISSING: %', v_signature;
    end if;

    if v_signature = 'public.leave_management_create_request(uuid, uuid, jsonb, text, text, text)'::regprocedure then
      v_legacy := 'v_reason := public.leave_management__internal_validate_reason(p_reason, ''LEAVE_REASON_INVALID'');';
      v_optional := $replacement$v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;$replacement$;
    else
      v_legacy := $legacy$if v_decision in ('REJECT', 'CANCEL_APPROVED') then
    v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_REQUIRED');
  elsif nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is not null then
    v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID');
  end if;$legacy$;
      v_optional := $replacement$v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;$replacement$;
    end if;

    v_replaced_length := pg_catalog.length(v_source)
      - pg_catalog.length(pg_catalog.replace(v_source, v_legacy, ''));
    if v_replaced_length <> pg_catalog.length(v_legacy) then
      raise exception 'LEAVE_OPTIONAL_REQUEST_REASON_EXPECTED_ONE_REQUIRED_VALIDATOR: %', v_signature;
    end if;

    v_source_optional := pg_catalog.replace(v_source, v_legacy, v_optional);
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    v_replaced_length := pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_source, ''));
    if v_replaced_length <> pg_catalog.length(v_source) then
      raise exception 'LEAVE_OPTIONAL_REQUEST_REASON_FUNCTION_DEFINITION_MISMATCH: %', v_signature;
    end if;

    execute pg_catalog.replace(v_definition, v_source, v_source_optional);

    select p.prosecdef,
           p.proconfig,
           pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'),
           pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'),
           pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           exists (
             select 1
               from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
              where a.grantee = 0
                and a.privilege_type = 'EXECUTE'
           )
      into v_is_security_definer,
           v_search_path,
           v_service_exec,
           v_anon_exec,
           v_authenticated_exec,
           v_public_exec
      from pg_catalog.pg_proc p
     where p.oid = v_signature;

    if not coalesce(v_is_security_definer, false)
       or not coalesce(v_service_exec, false)
       or coalesce(v_anon_exec, false)
       or coalesce(v_authenticated_exec, false)
       or coalesce(v_public_exec, false)
       or not coalesce(v_search_path @> array['search_path=pg_catalog, public'], false) then
      raise exception 'LEAVE_OPTIONAL_REQUEST_REASON_RPC_SECURITY_DRIFT: %', v_signature;
    end if;
  end loop;
end;
$leave_optional_request_reasons$;

commit;
