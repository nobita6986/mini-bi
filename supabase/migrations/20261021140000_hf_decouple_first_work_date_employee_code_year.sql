-- Hotfix after R2.2: Allow correcting first_work_date across calendar years
-- without rekeying employee_code.
--
-- Business contract:
-- 1. employee_code is the stable identifier of the entry; its 4-digit year segment
--    represents the year the code was issued, not a mandatory equality constraint
--    with first_work_date.
-- 2. Drops ONLY the year-matching CHECK constraint on public.direct_entries
--    (direct_entries_check: substring(employee_code from 5 for 4) = to_char(first_work_date, 'YYYY')).
-- 3. Preserves canonical format CHECK (^hrp-[0-9]{4}-[0-9]{6}$), UNIQUE (employee_code),
--    primary/foreign keys, version >= 1 guard, worker_details validation, void metadata
--    consistency, RLS, table ownership, ACLs, and SECURITY DEFINER RPC grants.

begin;

do $$
declare
  v_table_oid oid;
  v_rls_enabled boolean;
  v_owner_before oid;
  v_acl_before aclitem[];
  v_before_count integer;
  v_after_count integer;
  v_year_constraints text[];
  v_target_def text;
begin
  v_table_oid := pg_catalog.to_regclass('public.direct_entries');
  if v_table_oid is null then
    raise exception 'Precondition failed: public.direct_entries does not exist';
  end if;

  select c.relrowsecurity, c.relowner, c.relacl
    into v_rls_enabled, v_owner_before, v_acl_before
    from pg_catalog.pg_class c
   where c.oid = v_table_oid;

  if not coalesce(v_rls_enabled, false) then
    raise exception 'Precondition failed: RLS must be enabled on public.direct_entries';
  end if;

  -- Precondition: verify all non-target invariants exist before dropping the year-matching CHECK.
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'c'
       and c.conname = 'direct_entries_employee_code_check'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%employee_code ~ ''^hrp-[0-9]{4}-[0-9]{6}$''%'
  ) then
    raise exception 'Precondition failed: canonical employee_code format CHECK (direct_entries_employee_code_check) is missing or drifted';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'u'
       and c.conname = 'direct_entries_employee_code_key'
       and pg_catalog.pg_get_constraintdef(c.oid) = 'UNIQUE (employee_code)'
  ) then
    raise exception 'Precondition failed: UNIQUE (employee_code) constraint (direct_entries_employee_code_key) is missing or drifted';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'p'
       and c.conname = 'direct_entries_pkey'
       and pg_catalog.pg_get_constraintdef(c.oid) = 'PRIMARY KEY (entry_id)'
  ) then
    raise exception 'Precondition failed: PRIMARY KEY (direct_entries_pkey) is missing or drifted';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'c'
       and c.conname = 'direct_entries_version_check'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%version >= 1%'
  ) then
    raise exception 'Precondition failed: version guard CHECK (direct_entries_version_check) is missing or drifted';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'c'
       and c.conname = 'direct_entries_worker_details_check'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%direct_entry_valid_worker_details(worker_details)%'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%32768%'
  ) then
    raise exception 'Precondition failed: worker_details CHECK (direct_entries_worker_details_check) is missing or drifted';
  end if;

  if (
    select count(*)::integer
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'f'
  ) < 9 then
    raise exception 'Precondition failed: expected at least 9 foreign key constraints on public.direct_entries';
  end if;

  -- Locate the exact year-matching CHECK constraint by both name and definition.
  select array_agg(c.conname order by c.conname)
    into v_year_constraints
    from pg_catalog.pg_constraint c
   where c.conrelid = v_table_oid
     and c.contype = 'c'
     and pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid)) like '%substring(employee_code from 5 for 4)%'
     and pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid)) like '%to_char(%first_work_date%yyyy%';

  if coalesce(array_length(v_year_constraints, 1), 0) <> 1
     or v_year_constraints[1] <> 'direct_entries_check' then
    raise exception 'Precondition failed: expected exactly one year-matching CHECK constraint named direct_entries_check on public.direct_entries, found %',
      coalesce(array_to_string(v_year_constraints, ', '), 'none');
  end if;

  select pg_catalog.pg_get_constraintdef(c.oid)
    into v_target_def
    from pg_catalog.pg_constraint c
   where c.conrelid = v_table_oid
     and c.conname = 'direct_entries_check';

  if pg_catalog.lower(coalesce(v_target_def, '')) not like '%substring(employee_code from 5 for 4)%'
     or pg_catalog.lower(coalesce(v_target_def, '')) not like '%to_char(%first_work_date%yyyy%' then
    raise exception 'Precondition failed: direct_entries_check definition does not match employee_code/first_work_date year comparison: %',
      coalesce(v_target_def, 'null');
  end if;

  select count(*)::integer
    into v_before_count
    from pg_catalog.pg_constraint c
   where c.conrelid = v_table_oid;

  -- Drop ONLY the employee_code/first_work_date year-matching CHECK constraint.
  alter table public.direct_entries
    drop constraint direct_entries_check;

  -- Postconditions: verify only direct_entries_check was removed and all other constraints/RLS/ACL remain intact.
  select count(*)::integer
    into v_after_count
    from pg_catalog.pg_constraint c
   where c.conrelid = v_table_oid;

  if v_after_count <> v_before_count - 1 then
    raise exception 'Postcondition failed: expected constraint count on public.direct_entries to decrease by 1 (before=%, after=%)',
      v_before_count, v_after_count;
  end if;

  if exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and (
         c.conname = 'direct_entries_check'
         or (
           c.contype = 'c'
           and pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid)) like '%substring(employee_code%'
         )
       )
  ) then
    raise exception 'Postcondition failed: year-matching CHECK constraint still present on public.direct_entries';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'c'
       and c.conname = 'direct_entries_employee_code_check'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%employee_code ~ ''^hrp-[0-9]{4}-[0-9]{6}$''%'
  ) then
    raise exception 'Postcondition failed: canonical employee_code format CHECK was lost or altered';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'u'
       and c.conname = 'direct_entries_employee_code_key'
       and pg_catalog.pg_get_constraintdef(c.oid) = 'UNIQUE (employee_code)'
  ) then
    raise exception 'Postcondition failed: UNIQUE (employee_code) constraint was lost or altered';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'p'
       and c.conname = 'direct_entries_pkey'
  ) then
    raise exception 'Postcondition failed: PRIMARY KEY (direct_entries_pkey) was lost';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'c'
       and c.conname = 'direct_entries_version_check'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%version >= 1%'
  ) then
    raise exception 'Postcondition failed: version guard CHECK was lost or altered';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'c'
       and c.conname = 'direct_entries_worker_details_check'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%direct_entry_valid_worker_details(worker_details)%'
  ) then
    raise exception 'Postcondition failed: worker_details CHECK was lost or altered';
  end if;

  if (
    select count(*)::integer
      from pg_catalog.pg_constraint c
     where c.conrelid = v_table_oid
       and c.contype = 'f'
  ) < 9 then
    raise exception 'Postcondition failed: foreign key constraints on public.direct_entries were lost';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = v_table_oid
       and c.relrowsecurity = true
       and c.relowner = v_owner_before
       and c.relacl is not distinct from v_acl_before
  ) then
    raise exception 'Postcondition failed: public.direct_entries RLS, owner, or ACL changed unexpectedly';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure
       and p.prosecdef = true
       and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
       and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception 'Postcondition failed: direct_entry_privileged_edit SECURITY DEFINER or ACL invariant violated';
  end if;
end;
$$;

commit;
