-- P2-W04D — extend the Direct Entry reporting cutoff to 2000-01-01.
--
-- This changes only the shared cutoff function. Reporting masks already read
-- this function, so Direct Entry eligibility and the legacy partition move
-- together without changing any business record.

do $$
declare
  v_current_cutoff date;
begin
  v_current_cutoff := public.direct_entry_reporting_cutoff();
  if v_current_cutoff is distinct from date '2026-09-30' then
    raise exception
      'P2-W04D migration #89 refused: expected current cutoff 2026-09-30, got %',
      v_current_cutoff;
  end if;
end
$$;

create or replace function public.direct_entry_reporting_cutoff()
returns date
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select date '2000-01-01'
$$;

comment on function public.direct_entry_reporting_cutoff() is
  'Cutoff date that partitions legacy aggregate (< cutoff) from Direct Entry (>= cutoff). P2-W04D rebaseline locked to 2000-01-01.';

do $$
declare
  v_cutoff date;
  v_proc_secdef boolean;
begin
  v_cutoff := public.direct_entry_reporting_cutoff();
  if v_cutoff is distinct from date '2000-01-01' then
    raise exception 'P2-W04D cutoff drift: expected 2000-01-01, got %', v_cutoff;
  end if;

  if has_function_privilege('anon',
       'public.direct_entry_reporting_cutoff()'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.direct_entry_reporting_cutoff()'::regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role',
       'public.direct_entry_reporting_cutoff()'::regprocedure, 'EXECUTE') then
    raise exception 'P2-W04D cutoff helper ACL drift';
  end if;

  select p.prosecdef
    into v_proc_secdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid = 'public.direct_entry_reporting_cutoff()'::regprocedure;
  if v_proc_secdef is null or v_proc_secdef then
    raise exception 'P2-W04D cutoff helper must remain SECURITY INVOKER';
  end if;
end
$$;
