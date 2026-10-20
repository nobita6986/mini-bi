-- R1.1: use one strict, current-state Team Leader authority for reads and writes.
-- The catalog-operator exception remains isolated to the existing general read helper.
begin;

create or replace function public.direct_entry_assert_team_leader_current_team(
  p_auth_subject uuid, p_app_user_id uuid, p_team_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_count integer;
  v_scope_team_id uuid;
  v_link_count integer;
  v_link_recruiter_id uuid;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_assignment_count integer;
  v_matching_assignment_count integer;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_has_capability(p_app_user_id, 'team_manager_assign') then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int, (array_agg(s.team_id))[1]
    into v_scope_count, v_scope_team_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_app_user_id and s.scope_kind = 'team' and s.is_current;
  if v_scope_count <> 1 or v_scope_team_id is null
     or (p_team_id is not null and p_team_id <> v_scope_team_id) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.teams t
     where t.team_id = v_scope_team_id and t.active and t.code <> '__system_vendor__'
  ) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int, (array_agg(l.recruiter_id))[1]
    into v_link_count, v_link_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id and l.verified and l.is_current;
  if v_link_count <> 1 or v_link_recruiter_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = v_link_recruiter_id and r.active
  ) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int,
         count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::int
    into v_provider_count, v_hrp_provider_count
    from public.recruiter_provider_memberships m
   where m.recruiter_id = v_link_recruiter_id and m.is_current;
  if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int, count(*) filter (where m.team_id = v_scope_team_id)::int
    into v_membership_count, v_matching_membership_count
    from public.recruiter_team_memberships m
   where m.recruiter_id = v_link_recruiter_id and m.is_current;
  if v_membership_count <> 1 or v_matching_membership_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int,
         count(*) filter (where a.leader_recruiter_id = v_link_recruiter_id
                            and a.team_id = v_scope_team_id)::int
    into v_assignment_count, v_matching_assignment_count
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_app_user_id and a.is_current;
  if v_assignment_count <> 1 or v_matching_assignment_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;
  return v_scope_team_id;
end;
$function$;

revoke all on function public.direct_entry_assert_team_leader_current_team(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_assert_team_leader_current_team(uuid, uuid, uuid) is
  'Internal strict Team Leader predicate: actor mapping, one current team scope/link/HRP membership/assignment; no catalog-operator bypass.';

create or replace function public.direct_entry_assert_team_leader_read_authority(
  p_auth_subject uuid, p_app_user_id uuid, p_team_id uuid default null
)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  begin
    perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
    return p_team_id;
  exception when insufficient_privilege then
    return public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, p_team_id
    );
  end;
end;
$function$;

revoke all on function public.direct_entry_assert_team_leader_read_authority(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_team_leader_request_team(
  p_app_user_id uuid, p_request_id uuid
)
returns uuid language plpgsql stable security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth_subject uuid;
  v_team_id uuid;
begin
  select u.auth_subject into v_auth_subject
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id and u.enabled and u.auth_subject is not null;
  if v_auth_subject is null or p_request_id is null then return null; end if;
  begin
    v_team_id := public.direct_entry_assert_team_leader_current_team(
      v_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    return null;
  end;
  return (
    select (array_agg(e.team_id))[1]
      from public.direct_entry_change_request_items i
      join public.direct_entries e on e.entry_id = i.entry_id
     where i.request_id = p_request_id and e.team_id = v_team_id
     group by i.request_id
    having count(*) = (
             select count(*) from public.direct_entry_change_request_items x
              where x.request_id = p_request_id
           )
       and count(distinct e.team_id) = 1
  );
end;
$function$;

revoke all on function public.direct_entry_team_leader_request_team(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Add a server-validated `team` directory audience; a catalog operator cannot use it.
create or replace function public.direct_entry_worker_directory_audience(
  p_auth_subject uuid, p_app_user_id uuid, p_scope text, p_project_id text
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $function$
declare
  v_link_count integer;
  v_recruiter_id uuid;
  v_project_ids jsonb;
  v_team_id uuid;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if p_scope is null or p_scope not in ('recruited', 'managed', 'team', 'all') then
    raise exception 'invalid worker directory scope' using errcode = '22023';
  end if;
  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'invalid project filter' using errcode = '22023';
  end if;

  if p_scope = 'team' then
    v_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
    return jsonb_build_object('scope', 'team', 'team_id', v_team_id,
      'recruiter_ids', '[]'::jsonb, 'project_ids', '[]'::jsonb,
      'view_pii', true, 'view_payment', true);
  end if;

  if p_scope = 'recruited' then
    select count(*)::int into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id and l.verified and l.is_current;
    if v_link_count <> 1 then
      raise exception 'worker directory recruiter link unavailable or ambiguous' using errcode = '42501';
    end if;
    select l.recruiter_id into v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
     where l.app_user_id = p_app_user_id and l.verified and l.is_current;
    if v_recruiter_id is null then
      raise exception 'worker directory recruiter unavailable' using errcode = '42501';
    end if;
    return jsonb_build_object('scope', 'recruited', 'recruiter_ids', jsonb_build_array(v_recruiter_id),
      'project_ids', '[]'::jsonb, 'view_pii', true, 'view_payment', true);
  end if;

  if p_scope = 'managed' then
    if not public.direct_entry_actor_has_project_assignment(p_app_user_id) then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;
    select coalesce(jsonb_agg(distinct a.project_id), '[]'::jsonb) into v_project_ids
      from public.direct_entry_project_manager_assignments a
      join public.direct_entry_app_user_recruiter_links l
        on l.recruiter_id = a.manager_recruiter_id
       and l.app_user_id = p_app_user_id and l.verified and l.is_current
     where a.is_current and a.revoked_at is null;
    if jsonb_array_length(v_project_ids) = 0 then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;
    if p_project_id is not null and not (v_project_ids ? p_project_id) then
      raise exception 'worker directory project is out of scope' using errcode = '42501';
    end if;
    return jsonb_build_object('scope', 'managed', 'recruiter_ids', '[]'::jsonb,
      'project_ids', v_project_ids, 'view_pii', true, 'view_payment', true);
  end if;

  if not public.direct_entry_has_scope(p_app_user_id, 'all')
     or not (public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
          or public.direct_entry_has_capability(p_app_user_id, 'change_review')) then
    raise exception 'worker directory requires all scope' using errcode = '42501';
  end if;
  return jsonb_build_object('scope', 'all', 'recruiter_ids', '[]'::jsonb,
    'project_ids', '[]'::jsonb, 'view_pii', true, 'view_payment', true);
end;
$function$;

-- Keep the existing directory query and add only the team filter and row-level hint.
do $patch_worker_directory$
declare
  v_sig regprocedure := 'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure;
  v_def text;
  v_src text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.prosrc, pg_get_functiondef(p.oid) into v_src, v_def
    from pg_proc p where p.oid = v_sig;
  v_next := v_src;

  v_old := '  v_summary jsonb;';
  v_new := v_old || E'\n  v_team_id uuid;';
  if position(v_old in v_next) = 0 then raise exception 'worker directory declaration drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := '  v_scope := v_audience->>''scope'';';
  v_new := v_old || E'\n  v_team_id := nullif(v_audience->>''team_id'', '''')::uuid;';
  if position(v_old in v_next) = 0 then raise exception 'worker directory audience drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := '           e.project_id,';
  v_new := v_old || E'\n           e.team_id,\n           e.created_by_user_id,';
  if position(v_old in v_next) = 0 then raise exception 'worker directory row source drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := '         or (v_scope = ''managed'' and e.project_id = any(v_project_ids))';
  v_new := v_old || E'\n         or (v_scope = ''team'' and e.team_id = v_team_id)';
  if position(v_old in v_next) = 0 then raise exception 'worker directory scope filter drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := '                 ''view_payment'', v_view_payment,';
  v_new := v_old || E'\n                 ''direct_edit'', case\n                   when v_scope = ''team'' then t.team_id = v_team_id\n                   else public.direct_entry_has_entry_access(\n                     p_app_user_id, ''entry_privileged_edit'', t.created_by_user_id,\n                     t.team_id, t.first_work_date\n                   )\n                 end,';
  if position(v_old in v_next) = 0 then raise exception 'worker directory action projection drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  execute replace(v_def, v_src, v_next);
end;
$patch_worker_directory$;

-- Row reads use the same strict predicate; the catalog-operator read exception is not inherited.
do $patch_submission_read_scope$
declare
  v_sig regprocedure := 'public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)'::regprocedure;
  v_def text;
  v_src text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.prosrc, pg_get_functiondef(p.oid) into v_src, v_def
    from pg_proc p where p.oid = v_sig;
  v_next := v_src;
  v_old := '  v_recruiter_link_count integer;';
  v_new := v_old || E'\n  v_team_leader_team_id uuid;';
  if position(v_old in v_next) = 0 then raise exception 'submission read declaration drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);
  v_old := '  if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id,v_entry.project_id) then return ''project''; end if;';
  v_new := v_old || E'\n  if v_entry.team_id is not null then\n    begin\n      v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(\n        p_auth_subject, p_app_user_id, v_entry.team_id\n      );\n      return ''team'';\n    exception when insufficient_privilege then\n      null;\n    end;\n  end if;';
  if position(v_old in v_next) = 0 then raise exception 'submission read authority location drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);
  execute replace(v_def, v_src, v_next);
end;
$patch_submission_read_scope$;

-- Extend only the existing Team Leader path; the original all-scope privileged-edit path is unchanged.
do $patch_privileged_edit$
declare
  v_sig regprocedure := 'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
  v_def text;
  v_src text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.prosrc, pg_get_functiondef(p.oid) into v_src, v_def
    from pg_proc p where p.oid = v_sig;
  v_next := v_src;

  v_old := '  v_status_version integer;';
  v_new := v_old || E'\n  v_team_leader_team_id uuid;\n  v_target_project_id text;';
  if position(v_old in v_next) = 0 then raise exception 'privileged edit declaration drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := $old$  v_scope := public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit',
    v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
  );$old$;
  v_new := $new$  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
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
  end if;$new$;
  if position(v_old in v_next) = 0 then raise exception 'privileged edit initial authority drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := $old$  v_target_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  perform public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit',
    v_entry.created_by_user_id, v_team, v_target_date, v_scope
  );$old$;
  v_new := $new$  v_target_date := case when p_patch ? 'first_work_date'
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
  end if;$new$;
  if position(v_old in v_next) = 0 then raise exception 'privileged edit target authority drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);
  execute replace(v_def, v_src, v_next);
end;
$patch_privileged_edit$;

-- Export uses the same current audience so view and export scopes remain aligned.
do $patch_worker_export$
declare
  v_sig regprocedure := 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)'::regprocedure;
  v_def text;
  v_src text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.prosrc, pg_get_functiondef(p.oid) into v_src, v_def
    from pg_proc p where p.oid = v_sig;
  v_next := v_src;
  v_old := '  v_rows jsonb;';
  v_new := v_old || E'\n  v_team_id uuid;';
  if position(v_old in v_next) = 0 then raise exception 'worker export declaration drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := 'p_scope not in (''recruited'', ''managed'', ''all'')';
  v_new := 'p_scope not in (''recruited'', ''managed'', ''team'', ''all'')';
  if position(v_old in v_next) = 0 then raise exception 'worker export scope validation drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := '  v_scope := v_audience->>''scope'';';
  v_new := v_old || E'\n  v_team_id := nullif(v_audience->>''team_id'', '''')::uuid;';
  if position(v_old in v_next) = 0 then raise exception 'worker export audience drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := E'         or (v_scope = ''managed'' and e.project_id = any(v_project_ids))\n         or (v_scope = ''all'')';
  v_new := E'         or (v_scope = ''managed'' and e.project_id = any(v_project_ids))\n         or (v_scope = ''team'' and e.team_id = v_team_id)\n         or (v_scope = ''all'')';
  if position(v_old in v_next) = 0 then raise exception 'worker export row filter drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);

  v_old := E'    when p_scope = ''managed'' then ''project''\n    else ''all''';
  v_new := E'    when p_scope = ''managed'' then ''project''\n    when p_scope = ''team'' then ''team''\n    else ''all''';
  if position(v_old in v_next) = 0 then raise exception 'worker export audit scope drift' using errcode = '55000'; end if;
  v_next := replace(v_next, v_old, v_new);
  execute replace(v_def, v_src, v_next);
end;
$patch_worker_export$;

-- The existing directory projection and RPC ACL are preserved; only the internal helper is new.
do $assert_r1_1_boundary$
declare
  v_internal regprocedure := 'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)'::regprocedure;
  v_read_authority regprocedure := 'public.direct_entry_assert_team_leader_read_authority(uuid,uuid,uuid)'::regprocedure;
  v_request_team regprocedure := 'public.direct_entry_team_leader_request_team(uuid,uuid)'::regprocedure;
  v_list regprocedure := 'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure;
  v_edit regprocedure := 'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
  v_export regprocedure := 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)'::regprocedure;
begin
  if not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
            from pg_proc p where p.oid = v_internal)
     or has_function_privilege('public', v_internal, 'EXECUTE')
     or has_function_privilege('anon', v_internal, 'EXECUTE')
     or has_function_privilege('authenticated', v_internal, 'EXECUTE')
     or has_function_privilege('service_role', v_internal, 'EXECUTE')
     or has_function_privilege('public', v_read_authority, 'EXECUTE')
     or has_function_privilege('anon', v_read_authority, 'EXECUTE')
     or has_function_privilege('authenticated', v_read_authority, 'EXECUTE')
     or has_function_privilege('service_role', v_read_authority, 'EXECUTE')
     or has_function_privilege('public', v_request_team, 'EXECUTE')
     or has_function_privilege('anon', v_request_team, 'EXECUTE')
     or has_function_privilege('authenticated', v_request_team, 'EXECUTE')
     or has_function_privilege('service_role', v_request_team, 'EXECUTE')
     or not has_function_privilege('service_role', v_list, 'EXECUTE')
     or not has_function_privilege('service_role', v_edit, 'EXECUTE')
     or not has_function_privilege('service_role', v_export, 'EXECUTE')
     or has_function_privilege('anon', v_list, 'EXECUTE')
     or has_function_privilege('authenticated', v_list, 'EXECUTE')
     or has_function_privilege('anon', v_edit, 'EXECUTE')
     or has_function_privilege('authenticated', v_edit, 'EXECUTE')
     or has_function_privilege('anon', v_export, 'EXECUTE')
     or has_function_privilege('authenticated', v_export, 'EXECUTE') then
    raise exception 'R1.1 Team Leader RPC ACL boundary drift' using errcode = '55000';
  end if;
end;
$assert_r1_1_boundary$;

commit;
