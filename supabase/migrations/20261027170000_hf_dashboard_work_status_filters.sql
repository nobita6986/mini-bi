begin;

-- Apply the dashboard's optional as-of work-status filter at the same
-- service-role RPC boundary that already applies actor scope and dimensions.
do $dashboard_facts_status$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)'::regprocedure;
  v_original_source text;
  v_source text;
  v_updated text;
  v_definition text;
  v_old_block constant text := $old$
  v_employment text;
  v_facts jsonb;
$old$;
  v_new_block constant text := $new$
  v_employment text;
  v_status text;
  v_status_as_of date;
  v_facts jsonb;
$new$;
  v_old_predicate constant text := $old$
     and (v_employment is null or f.employment_type_key = v_employment);
$old$;
  v_new_predicate constant text := $new$
     and (v_employment is null or f.employment_type_key = v_employment)
     and (
       v_status is null
       or (
         f.first_work_date <= v_status_as_of
         and coalesce((
           select ev.status
           from public.direct_entry_employment_status_events ev
           where ev.entry_id = f.entry_id
             and ev.effective_date <= v_status_as_of
             and not exists (
               select 1
               from public.direct_entry_employment_status_events replacement
               where replacement.supersedes_event_id = ev.event_id
             )
           order by ev.effective_date desc, ev.version desc
           limit 1
         ), 'UNKNOWN') = v_status
       )
     );
$new$;
  v_old_parse constant text := $old$
  v_employment := nullif(p_filters->>'employment', '');
$old$;
  v_new_parse constant text := $new$
  v_employment := nullif(p_filters->>'employment', '');
  v_status := nullif(p_filters->>'status', '');
  if v_status is not null and v_status not in ('ON', 'OFF', 'UNCONFIRMED') then
    raise exception 'invalid work status filter' using errcode = '22023';
  end if;
  v_status_as_of := coalesce(v_to, public.direct_entry_authorization_date());
$new$;
  v_is_security_definer boolean;
  v_config text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  select p.prosrc into v_original_source from pg_catalog.pg_proc p where p.oid = v_signature;
  if v_original_source is null then
    raise exception 'Dashboard status filter could not find the existing scoped facts RPC';
  end if;
  v_source := v_original_source;
  v_updated := replace(v_source, v_old_block, v_new_block);
  if length(v_source) - length(replace(v_source, v_old_block, '')) <> length(v_old_block) then
    raise exception 'Dashboard status filter expected exactly one facts declaration block';
  end if;
  v_source := v_updated;
  v_updated := replace(v_source, v_old_parse, v_new_parse);
  if length(v_source) - length(replace(v_source, v_old_parse, '')) <> length(v_old_parse) then
    raise exception 'Dashboard status filter expected exactly one facts parse block';
  end if;
  v_source := v_updated;
  v_updated := replace(v_source, v_old_predicate, v_new_predicate);
  if length(v_source) - length(replace(v_source, v_old_predicate, '')) <> length(v_old_predicate) then
    raise exception 'Dashboard status filter expected exactly one facts predicate';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  if length(v_definition) - length(replace(v_definition, v_original_source, ''))
       <> length(v_original_source) then
    raise exception 'Dashboard status filter could not reconstruct the scoped facts RPC';
  end if;
  execute replace(v_definition,
    v_original_source, v_updated);

  select p.prosecdef, p.proconfig,
         has_function_privilege('service_role', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         exists (
           select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
           where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         )
    into v_is_security_definer, v_config, v_service_exec, v_anon_exec,
         v_authenticated_exec, v_public_exec
    from pg_catalog.pg_proc p where p.oid = v_signature;
  if not v_is_security_definer
     or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
     or not v_service_exec or v_anon_exec or v_authenticated_exec or v_public_exec then
    raise exception 'Dashboard status filter changed the scoped facts RPC security boundary';
  end if;
end;
$dashboard_facts_status$;

do $dashboard_workforce_status$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)'::regprocedure;
  v_original_source text;
  v_source text;
  v_updated text;
  v_definition text;
  v_old_declaration constant text := $old$
  v_employment text;
  v_team_bucket text;
$old$;
  v_new_declaration constant text := $new$
  v_employment text;
  v_status text;
  v_team_bucket text;
$new$;
  v_old_parse constant text := $old$
  v_employment := nullif(btrim(v_filters->>'employment'), '');
$old$;
  v_new_parse constant text := $new$
  v_employment := nullif(btrim(v_filters->>'employment'), '');
  v_status := nullif(btrim(v_filters->>'status'), '');
  if v_status is not null and v_status not in ('ON', 'OFF', 'UNCONFIRMED') then
    raise exception 'invalid work status filter' using errcode = '22023';
  end if;
$new$;
  v_old_predicate constant text := $old$and (v_employment is null or f.employment_type_key = v_employment)
$old$;
  v_new_predicate constant text := $new$and (v_employment is null or f.employment_type_key = v_employment)
        and (
          v_status is null
          or (
            f.first_work_date <= v_as_of
            and coalesce((
              select ev.status
              from public.direct_entry_employment_status_events ev
              where ev.entry_id = f.entry_id
                and ev.effective_date <= v_as_of
                and not exists (
                  select 1
                  from public.direct_entry_employment_status_events replacement
                  where replacement.supersedes_event_id = ev.event_id
                )
                and not exists (
                  select 1
                  from public.direct_entry_employment_status_events later_event
                  where later_event.entry_id = ev.entry_id
                    and later_event.effective_date <= v_as_of
                    and not exists (
                      select 1
                      from public.direct_entry_employment_status_events later_replacement
                      where later_replacement.supersedes_event_id = later_event.event_id
                    )
                    and (later_event.effective_date > ev.effective_date
                      or (later_event.effective_date = ev.effective_date and later_event.version > ev.version))
                )
              order by ev.effective_date desc, ev.version desc
              limit 1
            ), 'UNKNOWN') = v_status
          )
        )
$new$;
  v_is_security_definer boolean;
  v_config text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  select p.prosrc into v_original_source from pg_catalog.pg_proc p where p.oid = v_signature;
  if v_original_source is null then
    raise exception 'Dashboard status filter could not find the existing workforce RPC';
  end if;
  v_source := v_original_source;
  v_updated := replace(v_source, v_old_declaration, v_new_declaration);
  if length(v_source) - length(replace(v_source, v_old_declaration, '')) <> length(v_old_declaration) then
    raise exception 'Dashboard status filter expected exactly one workforce declaration block';
  end if;
  v_source := v_updated;
  v_updated := replace(v_source, v_old_parse, v_new_parse);
  if length(v_source) - length(replace(v_source, v_old_parse, '')) <> length(v_old_parse) then
    raise exception 'Dashboard status filter expected exactly one workforce parse block';
  end if;
  v_source := v_updated;
  v_updated := replace(v_source, v_old_predicate, v_new_predicate);
  if length(v_source) - length(replace(v_source, v_old_predicate, '')) <> length(v_old_predicate) * 2 then
    raise exception 'Dashboard status filter expected exactly two workforce predicates';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  if length(v_definition) - length(replace(v_definition, v_original_source, '')) <> length(v_original_source) then
    raise exception 'Dashboard status filter could not reconstruct the workforce RPC';
  end if;
  execute replace(v_definition, v_original_source, v_updated);

  select p.prosecdef, p.proconfig,
         has_function_privilege('service_role', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         exists (
           select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
           where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         )
    into v_is_security_definer, v_config, v_service_exec, v_anon_exec,
         v_authenticated_exec, v_public_exec
    from pg_catalog.pg_proc p where p.oid = v_signature;
  if not v_is_security_definer
     or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
     or not v_service_exec or v_anon_exec or v_authenticated_exec or v_public_exec then
    raise exception 'Dashboard status filter changed the workforce RPC security boundary';
  end if;
end;
$dashboard_workforce_status$;

commit;
