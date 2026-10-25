begin;

-- Keep worker-directory pagination ordered by when the entry was recorded.
do $patch_worker_directory_creation_order$
declare
  v_signature regprocedure :=
    'public.direct_entry_list_workers_search(text,uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure;
  v_source text;
  v_definition text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    into v_source, v_definition
    from pg_catalog.pg_proc p
   where p.oid = v_signature;
  if v_source is null then
    raise exception 'worker directory search RPC is missing' using errcode = '55000';
  end if;
  v_next := v_source;

  v_old := '  v_cursor_stamp text;';
  v_new := '  v_cursor_stamp timestamptz;';
  if position(v_old in v_next) = 0 then
    raise exception 'worker directory cursor declaration drift' using errcode = '55000';
  end if;
  v_next := pg_catalog.replace(v_next, v_old, v_new);

  v_old := $old$    if p_cursor !~ '^[0-9]{8}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then$old$;
  v_new := $new$    if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then$new$;
  if position(v_old in v_next) = 0 then
    raise exception 'worker directory cursor validation drift' using errcode = '55000';
  end if;
  v_next := pg_catalog.replace(v_next, v_old, v_new);

  v_old := $old$    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;$old$;
  v_new := $new$    v_cursor_stamp := pg_catalog.split_part(p_cursor, '|', 1)::timestamptz;
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;$new$;
  if position(v_old in v_next) = 0 then
    raise exception 'worker directory cursor parser drift' using errcode = '55000';
  end if;
  v_next := pg_catalog.replace(v_next, v_old, v_new);

  v_old := $old$    select e.entry_id,
           e.version,$old$;
  v_new := $new$    select e.entry_id,
           e.created_at,
           e.version,$new$;
  if position(v_old in v_next) = 0 then
    raise exception 'worker directory candidate projection drift' using errcode = '55000';
  end if;
  v_next := pg_catalog.replace(v_next, v_old, v_new);

  v_old := $old$    select c.*,
           pg_catalog.to_char(c.first_work_date, 'YYYYMMDD') || ':' || c.entry_id::text as cursor
      from candidates c
     where v_cursor_stamp is null
        or (
             pg_catalog.to_char(c.first_work_date, 'YYYYMMDD'),
             c.entry_id::text
           ) < (v_cursor_stamp, v_cursor_id::text)
     order by c.first_work_date desc, c.entry_id desc
     limit v_page_size + 1$old$;
  v_new := $new$    select c.*,
           pg_catalog.to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             || '|' || c.entry_id::text as cursor
      from candidates c
     where v_cursor_stamp is null
        or (c.created_at, c.entry_id) < (v_cursor_stamp, v_cursor_id)
     order by c.created_at desc, c.entry_id desc
     limit v_page_size + 1$new$;
  if position(v_old in v_next) = 0 then
    raise exception 'worker directory keyset ordering drift' using errcode = '55000';
  end if;
  v_next := pg_catalog.replace(v_next, v_old, v_new);

  v_old := 'select * from page order by first_work_date desc, entry_id desc limit v_page_size';
  v_new := 'select * from page order by created_at desc, entry_id desc limit v_page_size';
  if position(v_old in v_next) = 0 then
    raise exception 'worker directory page trim ordering drift' using errcode = '55000';
  end if;
  v_next := pg_catalog.replace(v_next, v_old, v_new);

  v_old := '             ) order by t.first_work_date desc, t.entry_id desc), ''[]''::jsonb)';
  v_new := '             ) order by t.created_at desc, t.entry_id desc), ''[]''::jsonb)';
  if position(v_old in v_next) = 0 then
    raise exception 'worker directory output ordering drift' using errcode = '55000';
  end if;
  v_next := pg_catalog.replace(v_next, v_old, v_new);

  v_old := '       order by t.first_work_date asc, t.entry_id asc';
  v_new := '       order by t.created_at asc, t.entry_id asc';
  if position(v_old in v_next) = 0 then
    raise exception 'worker directory next cursor ordering drift' using errcode = '55000';
  end if;
  v_next := pg_catalog.replace(v_next, v_old, v_new);

  if position('c.first_work_date desc' in v_next) > 0 or
     position('t.first_work_date desc' in v_next) > 0 or
     position('first_work_date asc, t.entry_id asc' in v_next) > 0 then
    raise exception 'worker directory still uses work date for pagination' using errcode = '55000';
  end if;

  execute pg_catalog.replace(v_definition, v_source, v_next);
end;
$patch_worker_directory_creation_order$;

-- The authorized detail projection adds only the entry timestamp and minimal creator identity.
do $patch_worker_entry_creation_audit$
declare
  v_signature regprocedure :=
    'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure;
  v_definition text;
  v_old text := $old$  v_result := jsonb_build_object(
    'entry_id', v_entry.entry_id, 'submission_id', v_entry.submission_id,$old$;
  v_new text := $new$  v_result := jsonb_build_object(
    'created_at', pg_catalog.to_char(v_entry.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_entry.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
    'created_by', (
      select jsonb_build_object(
        'display_name', creator_projection.data->>'display_name',
        'login_id', creator_projection.data->>'login_id'
      )
        from public.direct_entry_app_users creator
        cross join lateral (
          select public.direct_entry_app_user_projection(creator) as data
        ) creator_projection
       where creator.app_user_id = v_entry.created_by_user_id
    ),
    'entry_id', v_entry.entry_id, 'submission_id', v_entry.submission_id,$new$;
  v_before_owner oid;
  v_before_acl aclitem[];
  v_after_owner oid;
  v_after_acl aclitem[];
begin
  select pg_catalog.pg_get_functiondef(p.oid), p.proowner, p.proacl
    into v_definition, v_before_owner, v_before_acl
    from pg_catalog.pg_proc p
   where p.oid = v_signature;
  if v_definition is null or position(v_old in v_definition) = 0 then
    raise exception 'worker entry creation metadata projection drift' using errcode = '55000';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);

  select p.proowner, p.proacl into v_after_owner, v_after_acl
    from pg_catalog.pg_proc p
   where p.oid = v_signature;
  if v_before_owner is distinct from v_after_owner or v_before_acl is distinct from v_after_acl then
    raise exception 'worker entry projection owner or ACL changed' using errcode = '55000';
  end if;
end;
$patch_worker_entry_creation_audit$;

commit;
