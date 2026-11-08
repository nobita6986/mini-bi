-- Keep the employment event table owner-only before the WF-04 performance migration.
begin;

revoke all privileges on table public.direct_entry_employment_status_events
  from public, anon, authenticated, service_role;

do $assert_status_event_table_acl$
begin
  if has_table_privilege('anon', 'public.direct_entry_employment_status_events', 'SELECT')
     or has_table_privilege('authenticated', 'public.direct_entry_employment_status_events', 'SELECT')
     or has_table_privilege('service_role', 'public.direct_entry_employment_status_events', 'SELECT') then
    raise exception 'WF-04 status event table must remain owner-only'
      using errcode = '55000';
  end if;
end;
$assert_status_event_table_acl$;

commit;
