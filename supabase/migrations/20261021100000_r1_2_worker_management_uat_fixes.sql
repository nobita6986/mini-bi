-- R1.2: align direct-edit authority across the worker directory and mutation RPC,
-- resolve overlapping current scopes, and add literal database-backed directory search.
begin;

create or replace function public.direct_entry_assert_entry_access(
  p_auth_subject uuid, p_app_user_id uuid, p_capability text, p_entry_owner uuid, p_team_id uuid,
  p_effective_date date, p_required_scope text default null
)
returns text language plpgsql security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope text;
  v_matches integer;
begin
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, p_capability);
  select count(*)::integer, min(g.scope_kind) into v_matches, v_scope
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id and g.is_current
     and (g.scope_kind <> 'team' or exists (
       select 1 from public.teams t where t.team_id = g.team_id and t.active
     ))
     and ((g.scope_kind = 'own' and p_entry_owner = p_app_user_id)
       or (g.scope_kind = 'team' and g.team_id = p_team_id)
       or g.scope_kind = 'all')
     and (p_required_scope is null or g.scope_kind = p_required_scope);
  if v_matches = 0 then
    raise exception 'resource scope denied' using errcode = '42501';
  end if;
  return v_scope;
end;
$function$;

create or replace function public.direct_entry_has_entry_access(
  p_app_user_id uuid, p_capability text, p_entry_owner uuid, p_team_id uuid, p_effective_date date
)
returns boolean language sql security definer
set search_path = pg_catalog, public
as $function$
  select public.direct_entry_has_capability(p_app_user_id, p_capability)
     and exists (
       select 1 from public.direct_entry_scope_grants sg
        where sg.app_user_id = p_app_user_id and sg.is_current
          and (sg.scope_kind <> 'team' or exists (
            select 1 from public.teams t where t.team_id = sg.team_id and t.active
          ))
          and ((sg.scope_kind = 'own' and p_entry_owner = p_app_user_id)
            or (sg.scope_kind = 'team' and p_team_id is not null and sg.team_id = p_team_id)
            or sg.scope_kind = 'all')
     )
$function$;

create or replace function public.direct_entry_resolve_direct_edit_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_project_id text,
  p_is_full_admin boolean,
  p_team_leader_team_id uuid
)
returns text language plpgsql security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope text;
begin
  if p_is_full_admin then return 'admin_all'; end if;

  begin
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit',
      p_entry_owner, p_team_id, null
    );
    return 'privileged_' || v_scope;
  exception when insufficient_privilege then
    null;
  end;

  if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    return 'project_manager';
  end if;
  if p_team_id is not null and p_team_id = p_team_leader_team_id then
    return 'team_leader';
  end if;
  return null;
end;
$function$;

revoke all on function public.direct_entry_resolve_direct_edit_authority(
  uuid, uuid, uuid, uuid, text, boolean, uuid
) from public, anon, authenticated, service_role;

-- Add the same server authority to every directory scope. The old eight-argument RPC
-- remains as a null-search wrapper while new servers send the required ninth argument.
do $patch_worker_directory$
declare
  v_signature regprocedure :=
    'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure;
  v_source text;
  v_definition text;
  v_next text;
  v_helper_definition text;
  v_old text;
  v_new text;
begin
  select p.prosrc, pg_get_functiondef(p.oid)
    into v_source, v_definition from pg_catalog.pg_proc p where p.oid = v_signature;
  v_next := v_source;

  v_old := '  v_view_payment boolean;';
  v_new := v_old || E'\n  v_is_full_admin boolean := false;\n  v_team_leader_team_id uuid;';
  if position(v_old in v_next) = 0 then
    raise exception 'R1.2 worker directory declaration drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := '  v_scope := v_audience->>''scope'';';
  v_new := $new$  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    null;
  end;
  begin
    v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_team_leader_team_id := null;
  end;
  v_scope := v_audience->>'scope';$new$;
  if position(v_old in v_next) = 0 then
    raise exception 'R1.2 worker directory audience drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := '  with candidates as (';
  v_new := $new$  p_search := nullif(btrim(p_search), '');
  if p_search is not null and
     (char_length(p_search) > 100 or p_search ~ '[[:cntrl:]]') then
    raise exception 'invalid worker search' using errcode = '22023';
  end if;

  with candidates as ($new$;
  if position(v_old in v_next) = 0 then
    raise exception 'R1.2 worker directory candidates drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := '       and (p_employment_status is null or st.status = p_employment_status)';
  v_new := v_old || E'\n        and (p_search is null\n          or pg_catalog.strpos(pg_catalog.lower(coalesce(e.worker_details->>''display_name'', '''')), pg_catalog.lower(p_search)) > 0\n          or pg_catalog.strpos(pg_catalog.lower(coalesce(e.employee_code, '''')), pg_catalog.lower(p_search)) > 0)';
  if position(v_old in v_next) = 0 then
    raise exception 'R1.2 worker directory filter drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := $old$                 'direct_edit', case
                   when v_scope = 'team' then t.team_id = v_team_id
                   else public.direct_entry_has_entry_access(
                     p_app_user_id, 'entry_privileged_edit', t.created_by_user_id,
                     t.team_id, t.first_work_date
                   )
                 end,$old$;
  v_new := $new$                 'direct_edit', public.direct_entry_resolve_direct_edit_authority(
                   p_auth_subject, p_app_user_id, t.created_by_user_id, t.team_id,
                   t.project_id, v_is_full_admin, v_team_leader_team_id
                 ) is not null,$new$;
  if position(v_old in v_next) = 0 then
    raise exception 'R1.2 worker directory action projection drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);

  v_helper_definition := replace(v_definition, v_source, v_next);
  v_helper_definition := replace(
    v_helper_definition,
    'public.direct_entry_list_workers(',
    'public.direct_entry_list_workers_search(p_search text,'
  );
  if v_helper_definition = v_definition then
    raise exception 'R1.2 worker directory helper signature drift' using errcode = '55000';
  end if;
  execute v_helper_definition;
  execute format(
    'alter function public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer) owner to %I',
    pg_catalog.pg_get_userbyid((select p.proowner from pg_catalog.pg_proc p where p.oid = v_signature))
  );
end;
$patch_worker_directory$;

revoke all on function public.direct_entry_list_workers_search(
  text, uuid, uuid, text, text, uuid, text, text, integer
) from public, anon, authenticated, service_role;

create or replace function public.direct_entry_list_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text default null::text,
  p_recruiter_id uuid default null::uuid,
  p_employment_status text default null::text,
  p_cursor text default null::text,
  p_page_size integer default null::integer
)
returns jsonb language sql security definer
set search_path = pg_catalog, public
as $function$
  select public.direct_entry_list_workers_search(
    null::text, p_auth_subject, p_app_user_id, p_scope, p_project_id,
    p_recruiter_id, p_employment_status, p_cursor, p_page_size
  )
$function$;

create or replace function public.direct_entry_list_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text,
  p_recruiter_id uuid,
  p_employment_status text,
  p_cursor text,
  p_page_size integer,
  p_search text
)
returns jsonb language sql security definer
set search_path = pg_catalog, public
as $function$
  select public.direct_entry_list_workers_search(
    p_search, p_auth_subject, p_app_user_id, p_scope, p_project_id,
    p_recruiter_id, p_employment_status, p_cursor, p_page_size
  )
$function$;

do $align_worker_rpc_owner$
declare
  v_owner name;
begin
  select r.rolname into v_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = 'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure;
  execute format(
    'alter function public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer,text) owner to %I',
    v_owner
  );
end;
$align_worker_rpc_owner$;

revoke all on function public.direct_entry_list_workers(
  uuid, uuid, text, text, uuid, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_workers(
  uuid, uuid, text, text, uuid, text, text, integer, text
) to service_role;
comment on function public.direct_entry_list_workers(
  uuid, uuid, text, text, uuid, text, text, integer, text
) is 'R1.2 worker directory. Actor, scope, literal search, filters and page are validated server-side.';

-- The new private helpers are called only from SECURITY DEFINER functions. Grant
-- their owners the needed EXECUTE rights even when the migration operator differs
-- from the owners of the existing RPCs.
do $grant_r1_2_internal$
declare
  v_owner name;
begin
  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)'::regprocedure,
       'public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
       'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
       'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer,text)'::regprocedure,
       'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure
     )
  loop
    execute format(
      'grant execute on function public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid) to %I',
      v_owner
    );
    execute format(
      'grant execute on function public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer) to %I',
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
  end loop;

  select r.rolname into v_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = 'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)'::regprocedure;
  execute format(
    'grant execute on function public.direct_entry_assert_entry_access(uuid,uuid,text,uuid,uuid,date,text) to %I',
    v_owner
  );
  execute format(
    'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid,text) to %I',
    v_owner
  );
end;
$grant_r1_2_internal$;

-- Keep the existing mutation contract, OCC, idempotency, state guards and audit.
-- Only replace the authority decision at the source and target row.
do $patch_privileged_edit$
declare
  v_signature regprocedure :=
    'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
  v_source text;
  v_definition text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.prosrc, pg_get_functiondef(p.oid)
    into v_source, v_definition from pg_catalog.pg_proc p where p.oid = v_signature;
  v_next := v_source;

  v_old := '  v_target_project_id text;';
  v_new := v_old || E'\n  v_is_full_admin boolean := false;\n  v_current_team_leader_team_id uuid;\n  v_direct_edit_authority text;\n  v_target_direct_edit_authority text;';
  if position(v_old in v_next) = 0 then
    raise exception 'R1.2 privileged edit declaration drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := $old$  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  begin
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  exception when insufficient_privilege then
    v_scope := null;
  end;
  if v_scope is null then
    v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, v_entry.team_id
    );
    v_scope := 'team';
  end if;$old$;
  v_new := $new$  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
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
  if v_direct_edit_authority is null then
    raise exception 'entry scope/capability denied' using errcode = '42501';
  end if;
  v_scope := case
    when v_direct_edit_authority = 'admin_all' then 'all'
    when v_direct_edit_authority = 'team_leader' then 'team'
    when v_direct_edit_authority = 'project_manager' then 'project'
    when v_direct_edit_authority like 'privileged_%'
      then substring(v_direct_edit_authority from 12)
    else null
  end;
  v_team_leader_team_id := case when v_direct_edit_authority = 'team_leader'
    then v_current_team_leader_team_id else null end;$new$;
  if position(v_old in v_next) = 0 then
    raise exception 'R1.2 privileged edit source authority drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := $old$  v_target_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  v_target_project_id := case when p_patch ? 'project_id'
    then p_patch->>'project_id' else v_entry.project_id end;
  if v_team_leader_team_id is not null then
    if v_entry.team_id is distinct from v_team_leader_team_id
       or v_team is distinct from v_team_leader_team_id then
      raise exception 'team leader edit target denied' using errcode = '42501';
    end if;
    if (p_patch ? 'recruiter_id' or p_patch ? 'project_id' or p_patch ? 'first_work_date')
       and (not public.direct_entry_project_team_scope_effective(v_entry.project_id, v_team_leader_team_id)
         or not public.direct_entry_project_team_scope_effective(v_target_project_id, v_team_leader_team_id)) then
      raise exception 'team leader project scope denied' using errcode = '42501';
    end if;
    perform public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, v_team
    );
  else
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit',
      v_entry.created_by_user_id, v_team, v_target_date, v_scope
    );
  end if;$old$;
  v_new := $new$  v_target_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  v_target_project_id := case when p_patch ? 'project_id'
    then p_patch->>'project_id' else v_entry.project_id end;
  v_is_full_admin := false;
  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    null;
  end;
  v_current_team_leader_team_id := null;
  begin
    v_current_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    null;
  end;
  v_target_direct_edit_authority := public.direct_entry_resolve_direct_edit_authority(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id, v_team,
    v_target_project_id, v_is_full_admin, v_current_team_leader_team_id
  );
  if v_target_direct_edit_authority is null then
    raise exception 'direct edit target scope denied' using errcode = '42501';
  end if;
  if v_team_leader_team_id is not null then
    if v_entry.team_id is distinct from v_team_leader_team_id
       or v_team is distinct from v_team_leader_team_id then
      raise exception 'team leader edit target denied' using errcode = '42501';
    end if;
    if (p_patch ? 'recruiter_id' or p_patch ? 'project_id' or p_patch ? 'first_work_date')
       and (not public.direct_entry_project_team_scope_effective(v_entry.project_id, v_team_leader_team_id)
         or not public.direct_entry_project_team_scope_effective(v_target_project_id, v_team_leader_team_id)) then
      raise exception 'team leader project scope denied' using errcode = '42501';
    end if;
    perform public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, v_team_leader_team_id
    );
  end if;$new$;
  if position(v_old in v_next) = 0 then
    raise exception 'R1.2 privileged edit target authority drift' using errcode = '55000';
  end if;
  v_next := replace(v_next, v_old, v_new);
  execute replace(v_definition, v_source, v_next);
end;
$patch_privileged_edit$;

do $assert_r1_2_boundary$
declare
  v_resolver regprocedure :=
    'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)'::regprocedure;
  v_search_helper regprocedure :=
    'public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure;
  v_search_rpc regprocedure :=
    'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer,text)'::regprocedure;
  v_legacy_rpc regprocedure :=
    'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure;
  v_edit regprocedure :=
    'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
begin
  if has_function_privilege('public', v_resolver, 'EXECUTE')
     or has_function_privilege('anon', v_resolver, 'EXECUTE')
     or has_function_privilege('authenticated', v_resolver, 'EXECUTE')
     or has_function_privilege('service_role', v_resolver, 'EXECUTE')
     or has_function_privilege('public', v_search_helper, 'EXECUTE')
     or has_function_privilege('anon', v_search_helper, 'EXECUTE')
     or has_function_privilege('authenticated', v_search_helper, 'EXECUTE')
     or has_function_privilege('service_role', v_search_helper, 'EXECUTE')
     or has_function_privilege('public', v_search_rpc, 'EXECUTE')
     or has_function_privilege('anon', v_search_rpc, 'EXECUTE')
     or has_function_privilege('authenticated', v_search_rpc, 'EXECUTE')
     or not has_function_privilege('service_role', v_search_rpc, 'EXECUTE')
     or not has_function_privilege('service_role', v_legacy_rpc, 'EXECUTE')
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_catalog.pg_proc p where p.oid = v_search_rpc)
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_catalog.pg_proc p where p.oid = v_edit) then
    raise exception 'R1.2 direct edit/search RPC boundary drift' using errcode = '55000';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_search_rpc)
     <> (select p.proowner from pg_catalog.pg_proc p where p.oid = v_legacy_rpc) then
    raise exception 'R1.2 worker directory RPC owner drift' using errcode = '55000';
  end if;
end;
$assert_r1_2_boundary$;

commit;
