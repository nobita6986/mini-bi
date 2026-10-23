-- HF: searchable Project <-> Team mapping list.
--
-- The mapping admin screen used to demand an exact project_id and an exact team UUID.
-- This migration adds an OPTIONAL fuzzy `search` over project code/display name and
-- team code/display name so an operator can type "compal" instead of a UUID.
--
-- Boundaries kept exactly as #94/#124/#125:
--   * same Full Admin guard (direct_entry_assert_actor_app_user_admin);
--   * SECURITY DEFINER + pinned search_path;
--   * service_role ONLY; revoked from public/anon/authenticated;
--   * the search predicate is applied BEFORE the total and the pagination LIMIT/OFFSET,
--     so total/has_more/page_size describe the filtered set (no client-side paging).
--
-- Overload note: the existing 7-argument signature is RETAINED as a thin delegate so no
-- current caller (or historical ACL allowlist entry) breaks. The searchable body lives in
-- a new 8-argument signature with NO parameter defaults, so a 7-argument call can only
-- bind to the retained exact signature and an 8-argument call can only bind to the new
-- one. Neither overload is ambiguous and neither is broader than before.
begin;

-- -----------------------------------------------------------------------------
-- 1. Searchable implementation (8 arguments, no defaults).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_list_project_team_scopes_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_team_id uuid,
  p_include_history boolean,
  p_page integer,
  p_page_size integer,
  p_search text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_include_history boolean := coalesce(p_include_history, false);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_offset integer;
  v_total integer;
  v_mappings jsonb;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  if p_project_id is not null and length(btrim(p_project_id)) = 0 then
    raise exception 'project filter is invalid' using errcode = '22023';
  end if;
  if v_search is not null and length(v_search) > 256 then
    raise exception 'search filter is invalid' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  -- Total is computed over the SAME filtered predicate as the page below.
  select count(*)::int into v_total
    from public.direct_entry_project_team_scopes s
    join public.direct_entry_projects p on p.project_id = s.project_id
    join public.teams t on t.team_id = s.team_id
   where (p_project_id is null or s.project_id = p_project_id)
     and (p_team_id is null or s.team_id = p_team_id)
     and (v_include_history or s.valid_to is null)
     and (
       v_search is null
       or pg_catalog.strpos(pg_catalog.lower(s.project_id), pg_catalog.lower(v_search)) > 0
       or pg_catalog.strpos(pg_catalog.lower(p.display_name), pg_catalog.lower(v_search)) > 0
       or pg_catalog.strpos(pg_catalog.lower(coalesce(t.code, '')), pg_catalog.lower(v_search)) > 0
       or pg_catalog.strpos(pg_catalog.lower(t.display_name), pg_catalog.lower(v_search)) > 0
     );

  select coalesce(jsonb_agg(page_rows.projection
      order by page_rows.project_id, page_rows.team_id, page_rows.valid_from desc,
               page_rows.mapping_id), '[]'::jsonb)
    into v_mappings
    from (
      select jsonb_build_object(
          'mapping_id', s.mapping_id,
          'project_id', s.project_id,
          'project_display_name', p.display_name,
          'team_id', s.team_id,
          'team_display_name', t.display_name,
          'team_code', t.code,
          'valid_from', to_jsonb(s.valid_from),
          'valid_to', to_jsonb(s.valid_to),
          'effective', s.is_current,
          'state', case
            when s.is_current then 'CURRENT'
            when s.valid_from > public.direct_entry_authorization_date() then 'SCHEDULED'
            else 'HISTORY'
          end,
          'version', s.version,
          'revoked_at', s.revoked_at,
          'created_at', s.created_at
        ) as projection,
        s.project_id, s.team_id, s.valid_from, s.mapping_id
        from public.direct_entry_project_team_scopes s
        join public.direct_entry_projects p on p.project_id = s.project_id
        join public.teams t on t.team_id = s.team_id
       where (p_project_id is null or s.project_id = p_project_id)
         and (p_team_id is null or s.team_id = p_team_id)
         and (v_include_history or s.valid_to is null)
         and (
           v_search is null
           or pg_catalog.strpos(pg_catalog.lower(s.project_id), pg_catalog.lower(v_search)) > 0
           or pg_catalog.strpos(pg_catalog.lower(p.display_name), pg_catalog.lower(v_search)) > 0
           or pg_catalog.strpos(pg_catalog.lower(coalesce(t.code, '')), pg_catalog.lower(v_search)) > 0
           or pg_catalog.strpos(pg_catalog.lower(t.display_name), pg_catalog.lower(v_search)) > 0
         )
       order by s.project_id, s.team_id, s.valid_from desc, s.mapping_id
       limit v_page_size + 1 offset v_offset
    ) page_rows;

  v_has_more := jsonb_array_length(v_mappings) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(trimmed.value order by trimmed.ord), '[]'::jsonb) into v_mappings
      from jsonb_array_elements(v_mappings) with ordinality as trimmed(value, ord)
     where trimmed.ord <= v_page_size;
  end if;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_history', v_include_history,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'has_more', v_has_more,
    'mappings', v_mappings
  );
end;
$function$;

revoke all on function public.direct_entry_list_project_team_scopes_admin(
  uuid, uuid, text, uuid, boolean, integer, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_project_team_scopes_admin(
  uuid, uuid, text, uuid, boolean, integer, integer, text
) to service_role;
comment on function public.direct_entry_list_project_team_scopes_admin(
  uuid, uuid, text, uuid, boolean, integer, integer, text
) is
  'HF searchable Full Admin mapping read: exact project/team filters are preserved, and an optional p_search matches a case-insensitive substring of project_id, project display name, team code or team display name. Filtering happens before total/pagination. service_role only.';

-- -----------------------------------------------------------------------------
-- 2. Retained exact 7-argument signature: delegates with no search.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_list_project_team_scopes_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text default null,
  p_team_id uuid default null,
  p_include_history boolean default false,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  return public.direct_entry_list_project_team_scopes_admin(
    p_auth_subject, p_app_user_id, p_project_id, p_team_id,
    p_include_history, p_page, p_page_size, null::text
  );
end;
$function$;

revoke all on function public.direct_entry_list_project_team_scopes_admin(
  uuid, uuid, text, uuid, boolean, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_project_team_scopes_admin(
  uuid, uuid, text, uuid, boolean, integer, integer
) to service_role;
comment on function public.direct_entry_list_project_team_scopes_admin(
  uuid, uuid, text, uuid, boolean, integer, integer
) is
  'PRE-W2-HF bound/paginated Full Admin mapping read (retained exact signature): delegates to the searchable implementation with no search term. service_role only.';

-- -----------------------------------------------------------------------------
-- 3. Install-time self-check (data free).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_source text;
  v_prosecdef boolean;
  v_config text;
  v_public_exec boolean;
  v_anon_exec boolean;
  v_auth_exec boolean;
  v_svc_exec boolean;
begin
  -- The searchable implementation must exist, stay SECURITY DEFINER, keep the pinned
  -- search_path, apply its search with a case-insensitive substring, and remain a
  -- service_role-only entry point.
  select p.prosrc, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''),
         has_function_privilege('public', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('service_role', p.oid, 'EXECUTE')
    into v_source, v_prosecdef, v_config, v_public_exec, v_anon_exec, v_auth_exec, v_svc_exec
    from pg_proc p
   where p.oid = 'public.direct_entry_list_project_team_scopes_admin(uuid,uuid,text,uuid,boolean,integer,integer,text)'::regprocedure;
  if v_source is null
     or not v_prosecdef
     or v_config <> 'search_path=pg_catalog, public'
     or v_public_exec or v_anon_exec or v_auth_exec or not v_svc_exec then
    raise exception 'HF mapping search RPC boundary wrong' using errcode = '55000';
  end if;
  if position('p_search' in v_source) = 0
     or position('strpos(' in v_source) = 0
     or position('lower(' in v_source) = 0
     or position('direct_entry_assert_actor_app_user_admin' in v_source) = 0 then
    raise exception 'HF mapping search RPC lost its search or authority contract'
      using errcode = '55000';
  end if;

  -- The retained exact signature must still resolve, stay service_role-only, and be a
  -- pure delegate (no second copy of the mapping read).
  select p.prosrc, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''),
         has_function_privilege('public', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('service_role', p.oid, 'EXECUTE')
    into v_source, v_prosecdef, v_config, v_public_exec, v_anon_exec, v_auth_exec, v_svc_exec
    from pg_proc p
   where p.oid = 'public.direct_entry_list_project_team_scopes_admin(uuid,uuid,text,uuid,boolean,integer,integer)'::regprocedure;
  if v_source is null
     or not v_prosecdef
     or v_config <> 'search_path=pg_catalog, public'
     or v_public_exec or v_anon_exec or v_auth_exec or not v_svc_exec then
    raise exception 'HF mapping retained exact RPC boundary wrong' using errcode = '55000';
  end if;
  if position('null::text' in v_source) = 0
     or position('direct_entry_project_team_scopes' in v_source) > 0 then
    raise exception 'HF mapping retained exact RPC must remain a delegate'
      using errcode = '55000';
  end if;

  raise notice 'HF migration self-check OK (searchable Project <-> Team mapping read)';
end;
$check$;

commit;
