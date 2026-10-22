-- Restore the RPC-only boundary before WF-01 verifies it on databases with ACL drift.
begin;

revoke all on table public.direct_entry_employment_status_events
  from public, anon, authenticated, service_role;

commit;
