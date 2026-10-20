do $s0$
begin
  if to_regclass('public.schema_migrations') is not null then
    execute 'revoke all privileges on table public.schema_migrations'
      || ' from public, anon, authenticated, service_role';
  end if;
end;
$s0$;
