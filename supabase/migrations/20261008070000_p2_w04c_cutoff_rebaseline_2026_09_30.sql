-- =============================================================================
-- P2-W04C — Reporting cutoff rebaseline to 2026-09-30.
--
-- This append-only migration moves the shared reporting partition boundary:
--   legacy aggregate: business_date < 2026-09-30
--   Direct Entry:     first_work_date >= 2026-09-30
--
-- Every reporting mask already calls public.direct_entry_reporting_cutoff(),
-- so replacing this pure constant function updates the projection, blocker and
-- reconciliation helper together. The migration is applied transactionally by
-- scripts/apply-migrations.mjs and fails closed before changing the function.
-- =============================================================================

-- Pre-apply hard stop. Do not rebaseline over legacy data, an active legacy
-- source, an unexpected current cutoff, or an eligible Direct Entry row that
-- would still fall before the proposed boundary.
do $$
declare
  v_current_cutoff date;
  v_legacy_rows bigint;
  v_legacy_subtotal bigint;
  v_active_non_test_sources bigint;
  v_de_before_candidate bigint;
begin
  v_current_cutoff := public.direct_entry_reporting_cutoff();
  if v_current_cutoff <> date '2026-10-06' then
    raise exception
      'P2-W04C migration #47 refused: expected current cutoff 2026-10-06, got %',
      v_current_cutoff;
  end if;

  select count(*)::bigint, coalesce(sum(recruited_count), 0)::bigint
    into v_legacy_rows, v_legacy_subtotal
    from public.daily_recruitment_breakdown;
  if v_legacy_rows <> 0 or v_legacy_subtotal <> 0 then
    raise exception
      'P2-W04C migration #47 refused: legacy aggregate must be empty (rows=%, subtotal=%)',
      v_legacy_rows, v_legacy_subtotal;
  end if;

  select count(*)::bigint
    into v_active_non_test_sources
    from public.data_sources
   where active = true
     and is_test = false;
  if v_active_non_test_sources <> 0 then
    raise exception
      'P2-W04C migration #47 refused: active non-test sources must be 0, got %',
      v_active_non_test_sources;
  end if;

  select count(*)::bigint
    into v_de_before_candidate
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where s.state = 'SUBMITTED'
     and e.deleted_at is null
     and e.first_work_date < date '2026-09-30';
  if v_de_before_candidate <> 0 then
    raise exception
      'P2-W04C migration #47 refused: eligible Direct Entry rows with first_work_date < 2026-09-30 = %',
      v_de_before_candidate;
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
  select date '2026-09-30'
$$;

comment on function public.direct_entry_reporting_cutoff() is
  'Cutoff date (Asia/Ho_Chi_Minh) that partitions legacy aggregate (< cutoff) '
  'from Direct Entry (>= cutoff). P2-W04C rebaseline locked to 2026-09-30.';

revoke all on function public.direct_entry_reporting_cutoff()
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_cutoff() to service_role;

-- Post-change reconciliation and security self-check. No production-specific
-- row count is hard-coded: projection count/sum must agree with the canonical
-- helper for whatever eligible Direct Entry data exists at apply time.
do $$
declare
  v_cutoff date;
  v_legacy_subtotal bigint;
  v_direct_entry_subtotal bigint;
  v_overlap_blocker bigint;
  v_projection_count bigint;
  v_projection_sum bigint;
  v_proc_secdef boolean;
begin
  v_cutoff := public.direct_entry_reporting_cutoff();
  if v_cutoff <> date '2026-09-30' then
    raise exception 'P2-W04C cutoff drift: expected 2026-09-30, got %', v_cutoff;
  end if;

  select legacy_subtotal, direct_entry_subtotal, overlap_blocker
    into v_legacy_subtotal, v_direct_entry_subtotal, v_overlap_blocker
    from public.direct_entry_reporting_reconciliation_totals();

  if v_legacy_subtotal <> 0 then
    raise exception 'P2-W04C legacy subtotal must remain 0, got %', v_legacy_subtotal;
  end if;
  if v_overlap_blocker <> 0 then
    raise exception 'P2-W04C overlap blocker must be 0, got %', v_overlap_blocker;
  end if;

  select count(*)::bigint, coalesce(sum(recruited_count), 0)::bigint
    into v_projection_count, v_projection_sum
    from public.direct_entry_reporting_facts_v01;
  if v_projection_count <> v_direct_entry_subtotal
     or v_projection_sum <> v_direct_entry_subtotal then
    raise exception
      'P2-W04C projection mismatch: count=%, sum=%, helper=%',
      v_projection_count, v_projection_sum, v_direct_entry_subtotal;
  end if;

  if has_function_privilege('anon',
       'public.direct_entry_reporting_cutoff()'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.direct_entry_reporting_cutoff()'::regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role',
       'public.direct_entry_reporting_cutoff()'::regprocedure, 'EXECUTE') then
    raise exception 'P2-W04C cutoff helper ACL drift';
  end if;

  select p.prosecdef
    into v_proc_secdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid = 'public.direct_entry_reporting_cutoff()'::regprocedure;
  if v_proc_secdef is null or v_proc_secdef then
    raise exception 'P2-W04C cutoff helper must remain SECURITY INVOKER';
  end if;

  raise notice
    'P2-W04C migration #47 self-check OK (cutoff=%, legacy=%, de=%, blocker=%)',
    v_cutoff, v_legacy_subtotal, v_direct_entry_subtotal, v_overlap_blocker;
end
$$;
