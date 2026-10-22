-- Allow the server-side BI bot to read the curated Direct Entry reporting view.
-- Keep browser-facing roles denied and grant only the exact helper signatures
-- referenced by the current view definition.
begin;

revoke all on table public.direct_entry_reporting_facts_v01
  from public, anon, authenticated;
grant select on table public.direct_entry_reporting_facts_v01
  to service_role;

revoke all on function
  public.direct_entry_reporting_source_id(),
  public.direct_entry_reporting_dim_key(text),
  public.direct_entry_reporting_employment_key(text),
  public.direct_entry_reporting_employment_display(text)
from public, anon, authenticated;

grant execute on function
  public.direct_entry_reporting_source_id(),
  public.direct_entry_reporting_dim_key(text),
  public.direct_entry_reporting_employment_key(text),
  public.direct_entry_reporting_employment_display(text)
to service_role;

do $assert_bot_reporting_acl$
begin
  if not pg_catalog.has_table_privilege(
       'service_role',
       'public.direct_entry_reporting_facts_v01'::pg_catalog.regclass,
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'anon',
       'public.direct_entry_reporting_facts_v01'::pg_catalog.regclass,
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.direct_entry_reporting_facts_v01'::pg_catalog.regclass,
       'SELECT'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.direct_entry_reporting_source_id()'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.direct_entry_reporting_dim_key(text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.direct_entry_reporting_employment_key(text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.direct_entry_reporting_employment_display(text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.direct_entry_reporting_source_id()'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.direct_entry_reporting_source_id()'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.direct_entry_reporting_dim_key(text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.direct_entry_reporting_dim_key(text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.direct_entry_reporting_employment_key(text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.direct_entry_reporting_employment_key(text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.direct_entry_reporting_employment_display(text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.direct_entry_reporting_employment_display(text)'::pg_catalog.regprocedure,
       'EXECUTE'
     ) then
    raise exception 'BI bot reporting ACL postcondition failed'
      using errcode = '55000';
  end if;
end;
$assert_bot_reporting_acl$;

commit;
