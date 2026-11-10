-- =============================================================================
-- Migration: 20261110150000_recruitment_post_list_mine.sql
-- Purpose  : Recruitment Posts hotfix —
--            1. Raise default and max `p_page_size` from 10 to 15 on
--               `public.recruitment_post_list` without changing its signature.
--            2. Add `public.recruitment_post_list_mine` (service_role only)
--               returning the authenticated actor's own recruitment posts
--               (`created_by_app_user_id = p_app_user_id`) across both
--               `PUBLISHED` and `WITHDRAWN` statuses with snapshot/cursor
--               pagination (default/max page_size = 15).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Supporting index for "Tin của tôi" (`created_by_app_user_id`, `status`,
--    `updated_at desc`, `brief_id desc`).
-- -----------------------------------------------------------------------------
create index if not exists recruitment_project_briefs_creator_status_updated_idx
  on public.recruitment_project_briefs (created_by_app_user_id, status, updated_at desc, brief_id desc);

-- -----------------------------------------------------------------------------
-- 1. Update `public.recruitment_post_list` page_size default and max to 15
--    (preserving exact 11-parameter signature).
-- -----------------------------------------------------------------------------
create or replace function public.recruitment_post_list(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text default null,
  p_province_id uuid default null,
  p_industrial_park_id uuid default null,
  p_labor_type_key text default null,
  p_updated_from date default null,
  p_updated_to date default null,
  p_cursor text default null,
  p_snapshot_token text default null,
  p_page_size integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_page_size integer;
  v_project_id text := nullif(pg_catalog.btrim(coalesce(p_project_id, '')), '');
  v_labor_type_key text := nullif(pg_catalog.btrim(coalesce(p_labor_type_key, '')), '');
  v_cursor_raw text := nullif(pg_catalog.btrim(coalesce(p_cursor, '')), '');
  v_token_raw text := nullif(pg_catalog.btrim(coalesce(p_snapshot_token, '')), '');
  v_filter_hash text;
  v_current_max_seq bigint;
  v_snapshot_seq bigint;
  v_token_parts text[];
  v_cursor_parts text[];
  v_cursor_seq bigint;
  v_cursor_micros bigint;
  v_cursor_days integer;
  v_cursor_rem_usec bigint;
  v_cursor_ts timestamptz := null;
  v_cursor_brief_id uuid := null;
  v_rows jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_cursor text := null;
  v_last_micros bigint;
  v_last_brief_id uuid;
  v_rec record;
  v_count integer := 0;
begin
  begin
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  exception
    when sqlstate '42501' then
      raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end;

  if p_page_size is null or p_page_size < 1 or p_page_size > 15 then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;
  v_page_size := p_page_size;

  if v_project_id is not null and v_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if v_labor_type_key is not null and v_labor_type_key !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if p_updated_from is not null and p_updated_to is not null and p_updated_from > p_updated_to then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;

  if p_province_id is not null and p_industrial_park_id is not null then
    if exists (
      select 1
        from public.industrial_parks ip
       where ip.industrial_park_id = p_industrial_park_id
         and ip.province_id <> p_province_id
    ) then
      raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
    end if;
  end if;

  v_filter_hash := public.recruitment_post__internal_filter_hash(
    v_project_id,
    p_province_id,
    p_industrial_park_id,
    v_labor_type_key,
    p_updated_from,
    p_updated_to
  );

  select coalesce(max(r.revision_seq), 0)
    into v_current_max_seq
    from public.recruitment_project_brief_revisions r;

  if v_cursor_raw is not null and v_token_raw is null then
    raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
  end if;

  if v_token_raw is not null then
    v_token_parts := pg_catalog.regexp_match(
      v_token_raw,
      '^S1\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{32})$'
    );
    if v_token_parts is null then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
    begin
      v_snapshot_seq := v_token_parts[1]::bigint;
    exception
      when numeric_value_out_of_range then
        raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end;
    if v_snapshot_seq > v_current_max_seq or v_token_parts[2] <> v_filter_hash then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
  else
    v_snapshot_seq := v_current_max_seq;
  end if;

  if v_cursor_raw is not null then
    v_cursor_parts := pg_catalog.regexp_match(
      v_cursor_raw,
      '^C1\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{32})\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
    );
    if v_cursor_parts is null then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
    begin
      v_cursor_seq := v_cursor_parts[1]::bigint;
      v_cursor_micros := v_cursor_parts[3]::bigint;
      v_cursor_brief_id := v_cursor_parts[4]::uuid;
      v_cursor_days := (v_cursor_micros / 86400000000)::integer;
      v_cursor_rem_usec := v_cursor_micros % 86400000000;
      v_cursor_ts := timestamptz 'epoch'
        + pg_catalog.make_interval(days => v_cursor_days)
        + (v_cursor_rem_usec * interval '1 microsecond');
    exception
      when numeric_value_out_of_range or datetime_field_overflow then
        raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end;
    if v_cursor_seq <> v_snapshot_seq or v_cursor_parts[2] <> v_filter_hash then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
  end if;

  for v_rec in
    select b.brief_id,
           asof.key_updated_at,
           public.recruitment_post__internal_projection(b, p_app_user_id) as item_json
      from public.recruitment_project_briefs b
      join public.industrial_parks ip
        on ip.industrial_park_id = b.industrial_park_id
      cross join lateral (
        select r.revision_seq,
               r.brief_updated_at as key_updated_at,
               r.after_snapshot
          from public.recruitment_project_brief_revisions r
         where r.brief_id = b.brief_id
           and r.revision_seq <= v_snapshot_seq
         order by r.revision_seq desc
         limit 1
      ) asof
     where b.status = 'PUBLISHED'
       and (v_project_id is null or b.project_id = v_project_id)
       and (p_industrial_park_id is null or b.industrial_park_id = p_industrial_park_id)
       and (p_province_id is null or ip.province_id = p_province_id)
       and (
         v_labor_type_key is null
         or pg_catalog.jsonb_exists(asof.after_snapshot->'labor_type_keys', v_labor_type_key)
       )
       and (
         p_updated_from is null
         or asof.key_updated_at >= (p_updated_from::timestamp at time zone 'Asia/Ho_Chi_Minh')
       )
       and (
         p_updated_to is null
         or asof.key_updated_at < ((p_updated_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
       )
       and (
         v_cursor_raw is null
         or (asof.key_updated_at, b.brief_id) < (v_cursor_ts, v_cursor_brief_id)
       )
     order by asof.key_updated_at desc, b.brief_id desc
     limit v_page_size + 1
  loop
    v_count := v_count + 1;
    if v_count <= v_page_size then
      v_rows := v_rows || pg_catalog.jsonb_build_array(v_rec.item_json);
      v_last_micros := (extract(epoch from v_rec.key_updated_at) * 1000000)::bigint;
      v_last_brief_id := v_rec.brief_id;
    else
      v_has_more := true;
    end if;
  end loop;

  if v_has_more then
    v_next_cursor := 'C1.'
      || v_snapshot_seq::text
      || '.'
      || v_filter_hash
      || '.'
      || v_last_micros::text
      || '.'
      || v_last_brief_id::text;
  end if;

  return pg_catalog.jsonb_build_object(
    'items', v_rows,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor', v_next_cursor,
    'snapshot_token', 'S1.' || v_snapshot_seq::text || '.' || v_filter_hash
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 2. New RPC: `public.recruitment_post_list_mine`
--    Lists posts created by `p_app_user_id` across `PUBLISHED` and `WITHDRAWN`.
-- -----------------------------------------------------------------------------
create or replace function public.recruitment_post_list_mine(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_cursor text default null,
  p_snapshot_token text default null,
  p_page_size integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_page_size integer;
  v_cursor_raw text := nullif(pg_catalog.btrim(coalesce(p_cursor, '')), '');
  v_token_raw text := nullif(pg_catalog.btrim(coalesce(p_snapshot_token, '')), '');
  v_filter_hash text;
  v_current_max_seq bigint;
  v_snapshot_seq bigint;
  v_token_parts text[];
  v_cursor_parts text[];
  v_cursor_seq bigint;
  v_cursor_micros bigint;
  v_cursor_days integer;
  v_cursor_rem_usec bigint;
  v_cursor_ts timestamptz := null;
  v_cursor_brief_id uuid := null;
  v_rows jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_cursor text := null;
  v_last_micros bigint;
  v_last_brief_id uuid;
  v_rec record;
  v_count integer := 0;
begin
  begin
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  exception
    when sqlstate '42501' then
      raise exception 'RECRUITMENT_POST_ACCESS_DENIED' using errcode = '42501';
  end;

  if p_page_size is null or p_page_size < 1 or p_page_size > 15 then
    raise exception 'RECRUITMENT_POST_INPUT_INVALID' using errcode = '22023';
  end if;
  v_page_size := p_page_size;

  v_filter_hash := pg_catalog.md5('MINE|' || coalesce(p_app_user_id::text, ''));

  select coalesce(max(r.revision_seq), 0)
    into v_current_max_seq
    from public.recruitment_project_brief_revisions r;

  if v_cursor_raw is not null and v_token_raw is null then
    raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
  end if;

  if v_token_raw is not null then
    v_token_parts := pg_catalog.regexp_match(
      v_token_raw,
      '^S1\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{32})$'
    );
    if v_token_parts is null then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
    begin
      v_snapshot_seq := v_token_parts[1]::bigint;
    exception
      when numeric_value_out_of_range then
        raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end;
    if v_snapshot_seq > v_current_max_seq or v_token_parts[2] <> v_filter_hash then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
  else
    v_snapshot_seq := v_current_max_seq;
  end if;

  if v_cursor_raw is not null then
    v_cursor_parts := pg_catalog.regexp_match(
      v_cursor_raw,
      '^C1\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{32})\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
    );
    if v_cursor_parts is null then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
    begin
      v_cursor_seq := v_cursor_parts[1]::bigint;
      v_cursor_micros := v_cursor_parts[3]::bigint;
      v_cursor_brief_id := v_cursor_parts[4]::uuid;
      v_cursor_days := (v_cursor_micros / 86400000000)::integer;
      v_cursor_rem_usec := v_cursor_micros % 86400000000;
      v_cursor_ts := timestamptz 'epoch'
        + pg_catalog.make_interval(days => v_cursor_days)
        + (v_cursor_rem_usec * interval '1 microsecond');
    exception
      when numeric_value_out_of_range or datetime_field_overflow then
        raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end;
    if v_cursor_seq <> v_snapshot_seq or v_cursor_parts[2] <> v_filter_hash then
      raise exception 'RECRUITMENT_POST_SNAPSHOT_INVALID' using errcode = '22023';
    end if;
  end if;

  for v_rec in
    select b.brief_id,
           asof.key_updated_at,
           public.recruitment_post__internal_projection(b, p_app_user_id) as item_json
      from public.recruitment_project_briefs b
      cross join lateral (
        select r.revision_seq,
               r.brief_updated_at as key_updated_at
          from public.recruitment_project_brief_revisions r
         where r.brief_id = b.brief_id
           and r.revision_seq <= v_snapshot_seq
         order by r.revision_seq desc
         limit 1
      ) asof
     where b.created_by_app_user_id = p_app_user_id
       and b.status in ('PUBLISHED', 'WITHDRAWN')
       and (
         v_cursor_raw is null
         or (asof.key_updated_at, b.brief_id) < (v_cursor_ts, v_cursor_brief_id)
       )
     order by asof.key_updated_at desc, b.brief_id desc
     limit v_page_size + 1
  loop
    v_count := v_count + 1;
    if v_count <= v_page_size then
      v_rows := v_rows || pg_catalog.jsonb_build_array(v_rec.item_json);
      v_last_micros := (extract(epoch from v_rec.key_updated_at) * 1000000)::bigint;
      v_last_brief_id := v_rec.brief_id;
    else
      v_has_more := true;
    end if;
  end loop;

  if v_has_more then
    v_next_cursor := 'C1.'
      || v_snapshot_seq::text
      || '.'
      || v_filter_hash
      || '.'
      || v_last_micros::text
      || '.'
      || v_last_brief_id::text;
  end if;

  return pg_catalog.jsonb_build_object(
    'items', v_rows,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor', v_next_cursor,
    'snapshot_token', 'S1.' || v_snapshot_seq::text || '.' || v_filter_hash
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Align function owners and enforce fail-closed ACL.
-- -----------------------------------------------------------------------------
do $align_recruitment_post_list_mine_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_proc_owner_oid oid;
  v_fn pg_catalog.regprocedure;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  if v_base_owner is null then
    raise exception 'Owner resolution failed for public.direct_entries'
      using errcode = '55000';
  end if;

  foreach v_fn in array array[
    'public.recruitment_post_list(uuid,uuid,text,uuid,uuid,text,date,date,text,text,integer)'::pg_catalog.regprocedure,
    'public.recruitment_post_list_mine(uuid,uuid,text,text,integer)'::pg_catalog.regprocedure
  ] loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_fn;

    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_base_owner);
    end if;
  end loop;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname like 'recruitment_post%'
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_assert_actor_mapping(uuid, uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_scope(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_actor_is_assigned_project_manager(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_payload_hash(jsonb) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_idempotency_begin(uuid, text, text, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_idempotency_finish(uuid, text, text, jsonb) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reject_immutable_change() to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.recruitment_location_is_admin_or_bod(uuid) to %I',
      v_owner
    );
  end loop;
end
$align_recruitment_post_list_mine_owners$;

revoke all on function public.recruitment_post_list(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_post_list_mine(uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;

grant execute on function public.recruitment_post_list(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)
  to service_role;
grant execute on function public.recruitment_post_list_mine(uuid, uuid, text, text, integer)
  to service_role;

-- -----------------------------------------------------------------------------
-- 4. Self-check block verifying SECURITY DEFINER, search_path, owner RLS bypass,
--    and fail-closed ACL across all 7 public RPCs and 10 internal helpers.
-- -----------------------------------------------------------------------------
do $self_check$
declare
  v_public_rpc text;
  v_internal_fn text;
  v_fn_oid oid;
  v_fn_owner_oid oid;
  v_prosecdef boolean;
  v_proconfig text[];
  v_owner_bypasses_rls boolean;
  v_public_rpc_list constant text[] := array[
    'public.recruitment_post_get_context(uuid,uuid)',
    'public.recruitment_post_list(uuid,uuid,text,uuid,uuid,text,date,date,text,text,integer)',
    'public.recruitment_post_list_mine(uuid,uuid,text,text,integer)',
    'public.recruitment_post_get(uuid,uuid,uuid)',
    'public.recruitment_post_create(uuid,uuid,jsonb,text)',
    'public.recruitment_post_update(uuid,uuid,uuid,integer,jsonb,text)',
    'public.recruitment_post_withdraw(uuid,uuid,uuid,integer,text)'
  ];
  v_internal_fn_list constant text[] := array[
    'public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid)',
    'public.recruitment_post__internal_actor_label(uuid)',
    'public.recruitment_post__internal_idempotency_begin(uuid,text,text,text)',
    'public.recruitment_post__internal_filter_hash(text,uuid,uuid,text,date,date)',
    'public.recruitment_post__internal_normalize_payload(text,jsonb)',
    'public.recruitment_post__internal_snapshot(public.recruitment_project_briefs,text[])',
    'public.recruitment_post__internal_projection(public.recruitment_project_briefs,uuid)',
    'public.recruitment_post__internal_briefs_write_guard()',
    'public.recruitment_post__internal_brief_labor_write_guard()',
    'public.recruitment_post__internal_guard_park_province_change()'
  ];
begin
  if pg_catalog.to_regclass('public.recruitment_project_briefs_creator_status_updated_idx') is null then
    raise exception 'Self-check failed: missing index public.recruitment_project_briefs_creator_status_updated_idx'
      using errcode = '55000';
  end if;

  foreach v_public_rpc in array v_public_rpc_list loop
    v_fn_oid := pg_catalog.to_regprocedure(v_public_rpc);
    if v_fn_oid is null then
      raise exception 'Self-check failed: missing public RPC %', v_public_rpc
        using errcode = '55000';
    end if;

    select p.proowner,
           p.prosecdef,
           coalesce(p.proconfig, '{}'::text[]),
           (coalesce(r.rolsuper, false) or coalesce(r.rolbypassrls, false))
      into v_fn_owner_oid, v_prosecdef, v_proconfig, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn_oid;

    if not coalesce(v_prosecdef, false) or not ('search_path=pg_catalog, public' = any(v_proconfig)) then
      raise exception 'Self-check failed: RPC % must be SECURITY DEFINER with search_path=pg_catalog, public', v_public_rpc
        using errcode = '55000';
    end if;

    if not coalesce(v_owner_bypasses_rls, false)
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.recruitment_project_briefs'::pg_catalog.regclass, 'SELECT, INSERT, UPDATE')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.recruitment_project_brief_labor_types'::pg_catalog.regclass, 'SELECT, INSERT, DELETE')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.recruitment_project_brief_revisions'::pg_catalog.regclass, 'SELECT, INSERT')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.industrial_parks'::pg_catalog.regclass, 'SELECT')
       or not pg_catalog.has_table_privilege(v_fn_owner_oid, 'public.administrative_provinces'::pg_catalog.regclass, 'SELECT')
       or not pg_catalog.has_function_privilege(v_fn_owner_oid, v_fn_oid, 'EXECUTE') then
      raise exception 'Self-check failed: owner of RPC % must bypass FORCE RLS and hold required table privileges', v_public_rpc
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_fn_oid, 'EXECUTE') then
      raise exception 'Self-check failed: unexpected ACL on public RPC %', v_public_rpc
        using errcode = '55000';
    end if;
  end loop;

  foreach v_internal_fn in array v_internal_fn_list loop
    v_fn_oid := pg_catalog.to_regprocedure(v_internal_fn);
    if v_fn_oid is null then
      raise exception 'Self-check failed: missing internal helper %', v_internal_fn
        using errcode = '55000';
    end if;

    select p.proowner,
           p.prosecdef,
           coalesce(p.proconfig, '{}'::text[]),
           (coalesce(r.rolsuper, false) or coalesce(r.rolbypassrls, false))
      into v_fn_owner_oid, v_prosecdef, v_proconfig, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn_oid;

    if not coalesce(v_prosecdef, false) or not ('search_path=pg_catalog, public' = any(v_proconfig)) then
      raise exception 'Self-check failed: internal helper % must be SECURITY DEFINER with search_path=pg_catalog, public', v_internal_fn
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn_oid, 'EXECUTE') then
      raise exception 'Self-check failed: internal helper % must have EXECUTE revoked from public, anon, authenticated, and service_role', v_internal_fn
        using errcode = '55000';
    end if;
  end loop;
end
$self_check$;

commit;
