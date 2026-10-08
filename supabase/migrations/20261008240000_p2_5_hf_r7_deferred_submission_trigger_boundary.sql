begin;

-- The non-empty submission invariant is enforced by an INITIALLY DEFERRED
-- constraint trigger. A deferred trigger runs when the outer transaction is
-- committed, after a SECURITY DEFINER RPC has returned and current_user has
-- reverted to service_role. The protected tables deliberately grant no direct
-- DML/SELECT to that role, so the trigger must itself be an internal definer
-- boundary. Otherwise every real commit fails with 42501 even though the RPC
-- body succeeds (rollback-only probes cannot reveal this).
alter function public.direct_entry_require_nonempty_submission() security definer;
alter function public.direct_entry_require_nonempty_submission()
  set search_path = pg_catalog, public;
alter function public.direct_entry_require_nonempty_submission() owner to postgres;

revoke all on function public.direct_entry_require_nonempty_submission()
  from public, anon, authenticated, service_role;

do $p2_5_hf_r7$
declare
  v_trigger_def text;
begin
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname = 'direct_entry_require_nonempty_submission'
       and p.pronargs = 0
       and p.prosecdef
       and r.rolname = 'postgres'
       and p.proconfig @> array['search_path=pg_catalog, public']
  ) then
    raise exception 'P2.5-HF-R7 deferred submission trigger boundary mismatch';
  end if;

  select pg_get_triggerdef(t.oid, true)
    into v_trigger_def
    from pg_trigger t
   where t.tgrelid = 'public.direct_entry_submissions'::regclass
     and t.tgname = 'direct_entry_submission_nonempty'
     and not t.tgisinternal;
  if v_trigger_def is null
     or position('DEFERRABLE INITIALLY DEFERRED' in upper(v_trigger_def)) = 0 then
    raise exception 'P2.5-HF-R7 submission trigger is no longer deferred';
  end if;

  if has_function_privilege('service_role',
       'public.direct_entry_require_nonempty_submission()', 'EXECUTE')
     or has_table_privilege('service_role',
       'public.direct_entry_submissions', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('service_role',
       'public.direct_entries', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'P2.5-HF-R7 deny-by-default boundary widened';
  end if;
end
$p2_5_hf_r7$;

comment on function public.direct_entry_require_nonempty_submission() is
  'P2.5-HF-R7 internal SECURITY DEFINER boundary for the deferred non-empty submission invariant; API roles retain no table access or function EXECUTE.';

commit;
