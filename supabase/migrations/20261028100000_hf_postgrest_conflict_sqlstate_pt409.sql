-- Application-raised 40001 is retried by the current PostgREST version. Use
-- PT409 for application conflicts; native PostgreSQL serialization failures
-- are unaffected because they are not literals in a function body.
begin;

do $prepare_executor$
declare
  v_executor oid;
begin
  if current_user <> session_user then
    raise exception 'PT409 migration requires the migration login role to remain current_user';
  end if;

  select r.oid into v_executor
    from pg_catalog.pg_roles r
   where r.rolname = 'direct_entry_catalog_bootstrap_executor';
  if v_executor is null then
    raise exception 'PT409 migration catalog bootstrap executor role is missing';
  end if;

  perform pg_catalog.set_config('mini_bi.pt409_added_executor_membership', 'false', true);
  perform pg_catalog.set_config('mini_bi.pt409_added_executor_create', 'false', true);
  if not pg_catalog.pg_has_role(session_user, v_executor, 'SET') then
    if exists (
      select 1 from pg_catalog.pg_auth_members m
       where m.member = session_user::regrole
         and m.roleid = v_executor
         and m.grantor = current_user::regrole
    ) then
      raise exception 'PT409 migration cannot temporarily elevate an existing executor membership';
    end if;
    execute pg_catalog.format(
      'GRANT direct_entry_catalog_bootstrap_executor TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
      session_user
    );
    perform pg_catalog.set_config('mini_bi.pt409_added_executor_membership', 'true', true);
  end if;

  if pg_catalog.has_schema_privilege(v_executor, 'public', 'CREATE') then
    raise exception 'PT409 migration executor unexpectedly has CREATE on public';
  end if;
  execute 'GRANT CREATE ON SCHEMA public TO direct_entry_catalog_bootstrap_executor';
  perform pg_catalog.set_config('mini_bi.pt409_added_executor_create', 'true', true);
end
$prepare_executor$;

set local role direct_entry_catalog_bootstrap_executor;

do $rewrite_executor_owned$
declare
  target record;
  v_definition text;
  v_rewritten text;
  v_updated integer := 0;
  v_after_owner oid;
  v_after_acl aclitem[];
  v_after_security_definer boolean;
  v_after_config text[];
begin
  for target in
    select p.oid, p.proowner, p.proacl, p.prosecdef, p.proconfig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_language l on l.oid = p.prolang
     where n.nspname = 'public'
       and l.lanname = 'plpgsql'
       and p.proowner = current_user::regrole
       and p.prosrc ~* 'errcode[[:space:]]*=[[:space:]]*''40001'''
     order by p.oid
  loop
    v_definition := pg_catalog.pg_get_functiondef(target.oid);
    v_rewritten := regexp_replace(
      v_definition,
      'ERRCODE[[:space:]]*=[[:space:]]*''40001''',
      'ERRCODE = ''PT409''',
      'gi'
    );

    if v_rewritten = v_definition
       or v_rewritten ~* 'errcode[[:space:]]*=[[:space:]]*''40001''' then
      raise exception 'Could not safely rewrite application conflict SQLSTATE for %', target.oid::regprocedure;
    end if;

    execute v_rewritten;

    select p.proowner, p.proacl, p.prosecdef, p.proconfig
      into v_after_owner, v_after_acl, v_after_security_definer, v_after_config
      from pg_catalog.pg_proc p
     where p.oid = target.oid;

    if not found
       or v_after_owner is distinct from target.proowner
       or v_after_acl is distinct from target.proacl
       or v_after_security_definer is distinct from target.prosecdef
       or v_after_config is distinct from target.proconfig then
      raise exception 'Conflict SQLSTATE rewrite changed function security metadata for %', target.oid::regprocedure;
    end if;

    v_updated := v_updated + 1;
  end loop;

  perform pg_catalog.set_config('mini_bi.pt409_executor_rewrites', v_updated::text, true);
end
$rewrite_executor_owned$;

reset role;

do $rewrite_remaining$
declare
  target record;
  v_definition text;
  v_rewritten text;
  v_updated integer := 0;
  v_executor_updated integer;
  v_remaining integer;
  v_after_owner oid;
  v_after_acl aclitem[];
  v_after_security_definer boolean;
  v_after_config text[];
begin
  for target in
    select p.oid, p.proowner, p.proacl, p.prosecdef, p.proconfig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_language l on l.oid = p.prolang
     where n.nspname = 'public'
       and l.lanname = 'plpgsql'
       and p.proowner <> 'direct_entry_catalog_bootstrap_executor'::regrole
       and p.prosrc ~* 'errcode[[:space:]]*=[[:space:]]*''40001'''
     order by p.oid
  loop
    v_definition := pg_catalog.pg_get_functiondef(target.oid);
    v_rewritten := regexp_replace(
      v_definition,
      'ERRCODE[[:space:]]*=[[:space:]]*''40001''',
      'ERRCODE = ''PT409''',
      'gi'
    );

    if v_rewritten = v_definition
       or v_rewritten ~* 'errcode[[:space:]]*=[[:space:]]*''40001''' then
      raise exception 'Could not safely rewrite application conflict SQLSTATE for %', target.oid::regprocedure;
    end if;

    execute v_rewritten;

    select p.proowner, p.proacl, p.prosecdef, p.proconfig
      into v_after_owner, v_after_acl, v_after_security_definer, v_after_config
      from pg_catalog.pg_proc p
     where p.oid = target.oid;

    if not found
       or v_after_owner is distinct from target.proowner
       or v_after_acl is distinct from target.proacl
       or v_after_security_definer is distinct from target.prosecdef
       or v_after_config is distinct from target.proconfig then
      raise exception 'Conflict SQLSTATE rewrite changed function security metadata for %', target.oid::regprocedure;
    end if;

    v_updated := v_updated + 1;
  end loop;

  select count(*)
    into v_remaining
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
   where n.nspname = 'public'
     and l.lanname = 'plpgsql'
     and p.prosrc ~* 'errcode[[:space:]]*=[[:space:]]*''40001''';

  v_executor_updated := coalesce(
    nullif(pg_catalog.current_setting('mini_bi.pt409_executor_rewrites', true), '')::integer,
    0
  );
  if v_executor_updated + v_updated = 0 or v_remaining <> 0 then
    raise exception 'Unexpected conflict SQLSTATE migration result: updated %, remaining %',
      v_executor_updated + v_updated, v_remaining;
  end if;

  raise notice 'Rewrote % public PL/pgSQL functions to use PT409 for application conflicts',
    v_executor_updated + v_updated;
end
$rewrite_remaining$;

do $remove_temporary_executor_membership$
declare
  v_executor oid;
begin
  select r.oid into v_executor
    from pg_catalog.pg_roles r
   where r.rolname = 'direct_entry_catalog_bootstrap_executor';

  if pg_catalog.current_setting('mini_bi.pt409_added_executor_create', true) = 'true' then
    execute pg_catalog.format(
      'REVOKE CREATE ON SCHEMA public FROM direct_entry_catalog_bootstrap_executor GRANTED BY %I',
      current_user
    );
  end if;
  if pg_catalog.current_setting('mini_bi.pt409_added_executor_membership', true) = 'true' then
    execute pg_catalog.format(
      'REVOKE direct_entry_catalog_bootstrap_executor FROM %I GRANTED BY %I',
      session_user,
      current_user
    );
  end if;

  if pg_catalog.has_schema_privilege(v_executor, 'public', 'CREATE') then
    raise exception 'PT409 migration executor retained CREATE on public';
  end if;
end
$remove_temporary_executor_membership$;

commit;
