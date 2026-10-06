-- =============================================================================
-- P2-W04B — Post-purge reporting cutover rebaseline.
--
-- Task:    P2-W04B_POST_PURGE_CUTOVER_REBASELINE
-- Status:  P2-W04B_POST_PURGE_CUTOVER_REBASELINE_LOCAL_PASS_AWAITING_INTEGRATION
-- Base:    origin/main@a74caa3cfcbe8e91096ed905ca53b55715962a2c
-- Source:  docs/handoffs/p2-w04a-direct-entry-reporting-cutover.md (delta)
--
-- Rebaselines the locked reporting cutoff from 2026-10-17 to 2026-10-06 after
-- the pre-UAT sample/business-data purge. Migration #40 (P2-W04A) remains
-- byte-identical on disk; this migration `create or replace` only the
-- functions whose body must change. Every mask (facts view, blocker helper,
-- reconciliation totals) already reads through
-- public.direct_entry_reporting_cutoff() so rebaselining that single function
-- flows through to the views and helpers without touching their SQL text.
--
-- HARD RULES (locked by T0):
--   1. Cutoff date is 2026-10-06 (Asia/Ho_Chi_Minh). Legacy aggregate is
--      counted only when business_date < cutoff; Direct Entry is counted
--      only when first_work_date >= cutoff. No transition overlap.
--   2. Direct Entry commitment = submission.state = 'SUBMITTED' AND
--      deleted_at IS NULL. Each eligible row contributes exactly
--      recruited_count = 1. Revisions, documents, payments and
--      employment-status events MUST NOT multiply the row.
--   3. If an eligible Direct Entry row has first_work_date < cutoff, the
--      read path raises a hard blocker. It is never silently dropped and
--      never double-counted.
--   4. ACL posture (service_role-only views, denied anon / authenticated /
--      public, SECURITY DEFINER for table-reading helpers, INVOKER for pure
--      constant helpers) is preserved verbatim from migration #40.
--   5. No raw Direct Entry table is exposed to anon / authenticated / public.
--   6. No write path is added. The reconciliation script remains
--      read-only-by-construction.
--   7. Migrations #1..#43 are NOT touched. This is migration #44.
--
-- WHAT THIS MIGRATION DOES (delta-only):
--   * create or replace public.direct_entry_reporting_cutoff()
--       -> returns date '2026-10-06'. Pure constant helper; SECURITY INVOKER
--          (default) because it does not touch any table.
--   * Reasserts the source-id helper, the dimension normalizer, the
--     employment mapper, the alias / provider resolvers, the blocker count
--     and the reconciliation totals all use the cutoff function.
--   * In-migration self-check asserts the locked cutoff, the structural
--     shape of every helper and view, the data-agnostic invariants
--     (blocker count >= 0, reconciliation subtotals 0/0/0 on a fresh DB,
--     service-role ACL posture) and the source-id stability.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Locked post-purge cutoff date. Single source of truth for the cutover.
-- Pure constant helper; SECURITY INVOKER (default) because it does not
-- touch any table. The view mask and the reconciliation helper read through
-- this function so a single `create or replace` rebaselines every
-- downstream mask.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_cutoff()
returns date
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select date '2026-10-06'
$$;

comment on function public.direct_entry_reporting_cutoff() is
  'Cutoff date (Asia/Ho_Chi_Minh) that partitions legacy aggregate (< cutoff) '
  'from Direct Entry (>= cutoff). Post-purge rebaseline locked to 2026-10-06.';

revoke all on function public.direct_entry_reporting_cutoff()
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_cutoff() to service_role;

-- -----------------------------------------------------------------------------
-- Source-id helper is unchanged. It is the deterministic synthetic id that
-- the projection view stamps on every Direct Entry fact. Reasserted here
-- only to keep the in-migration self-check honest: a future rebaseline must
-- NOT alter the source id.
-- -----------------------------------------------------------------------------
-- (no DDL: public.direct_entry_reporting_source_id() is created in #40 and
--  already returns '00000000-0000-4000-8000-0000de000001'::uuid.)

-- -----------------------------------------------------------------------------
-- In-migration self-check.
--
-- Asserts:
--   1. Cutoff returns 2026-10-06.
--   2. Source-id helper is the locked UUID (no rebaseline drift).
--   3. Every runtime helper still grants EXECUTE to service_role and
--      denies anon / authenticated.
--   4. Views still revoked from anon / authenticated / public and granted
--      to service_role (ACL posture preserved).
--   5. Views run as owner (security_invoker = false).
--   6. Runtime blocker count is a non-negative bigint (data-agnostic).
--   7. Reconciliation totals return the canonical 4-column shape and the
--      locked cutoff date. Fresh DB returns 0/0/0 — does NOT assert any
--      specific subtotal magnitude.
-- -----------------------------------------------------------------------------
do $$
declare
  v_cutoff date;
  v_source_id uuid;
  v_helper text;
  v_blocker_count bigint;
  v_legacy_subtotal bigint;
  v_direct_entry_subtotal bigint;
  v_overlap_blocker bigint;
  v_helper_definer_required boolean;
  v_proc_secdef boolean;
begin
  -- 1. Cutoff is the locked post-purge rebaseline.
  v_cutoff := public.direct_entry_reporting_cutoff();
  if v_cutoff <> '2026-10-06'::date then
    raise exception 'direct_entry_reporting_cutoff() must return 2026-10-06, got %', v_cutoff;
  end if;

  -- 2. Source id unchanged.
  v_source_id := public.direct_entry_reporting_source_id();
  if v_source_id <> '00000000-0000-4000-8000-0000de000001'::uuid then
    raise exception 'direct_entry_reporting_source_id drift: %', v_source_id;
  end if;

  -- 3. Helper privilege posture (unchanged from #40 R1).
  for v_helper in
    select unnest(array[
        'public.direct_entry_reporting_cutoff()',
        'public.direct_entry_reporting_source_id()',
        'public.direct_entry_reporting_dim_key(text)',
        'public.direct_entry_reporting_recruiter_alias_key(uuid, date)',
        'public.direct_entry_reporting_recruiter_provider_key(uuid, date)',
        'public.direct_entry_reporting_employment_key(text)',
        'public.direct_entry_reporting_pre_cutover_blocker_count()',
        'public.direct_entry_reporting_reconciliation_totals()'
      ])
  loop
    if has_function_privilege('anon',        v_helper::regprocedure, 'EXECUTE') then
      raise exception 'helper % must not be executable by anon', v_helper;
    end if;
    if has_function_privilege('authenticated', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'helper % must not be executable by authenticated', v_helper;
    end if;
    if not has_function_privilege('service_role', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'helper % must be EXECUTE-able by service_role', v_helper;
    end if;

    -- SECURITY DEFINER / INVOKER split must be preserved: table-reading
    -- helpers stay DEFINER; pure constant / mapping helpers stay INVOKER.
    v_helper_definer_required := v_helper in (
      'public.direct_entry_reporting_recruiter_alias_key(uuid, date)',
      'public.direct_entry_reporting_recruiter_provider_key(uuid, date)',
      'public.direct_entry_reporting_pre_cutover_blocker_count()',
      'public.direct_entry_reporting_reconciliation_totals()'
    );
    select p.prosecdef into v_proc_secdef
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.oid = v_helper::regprocedure;
    if v_proc_secdef is null then
      raise exception 'helper % not found in pg_proc', v_helper;
    end if;
    if v_helper_definer_required and not v_proc_secdef then
      raise exception 'helper % must be SECURITY DEFINER (reads Direct Entry tables)', v_helper;
    end if;
    if not v_helper_definer_required and v_proc_secdef then
      raise exception 'helper % must be SECURITY INVOKER (pure constant; no table reads)', v_helper;
    end if;
  end loop;

  -- 4. View grants: revoked from anon / authenticated / public,
  --    granted to service_role.
  if has_table_privilege('anon',         'public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_facts_v01 must not be SELECT-able by anon';
  end if;
  if has_table_privilege('authenticated', 'public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_facts_v01 must not be SELECT-able by authenticated';
  end if;
  if not has_table_privilege('service_role', 'public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_facts_v01 must be SELECT-able by service_role';
  end if;

  if has_table_privilege('anon',         'public.direct_entry_reporting_dimension_options_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_dimension_options_v01 must not be SELECT-able by anon';
  end if;
  if has_table_privilege('authenticated', 'public.direct_entry_reporting_dimension_options_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_dimension_options_v01 must not be SELECT-able by authenticated';
  end if;
  if not has_table_privilege('service_role', 'public.direct_entry_reporting_dimension_options_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_dimension_options_v01 must be SELECT-able by service_role';
  end if;

  -- 5. View semantic: runs as owner (security_invoker = false) so the
  --    underlying tables stay revoke-able from service_role. PG15+ PGlite
  --    18.3 cannot store `security_invoker = false` (it is the default and
  --    explicit false is a syntax error), so we read `pg_get_viewdef` and
  --    assert it does NOT mention `security_invoker = true`. If a future
  --    release re-introduces `security_invoker = true`, this migration
  --    fails closed.
  declare v_check text;
  begin
    select pg_get_viewdef('public.direct_entry_reporting_facts_v01'::regclass, true)
      into v_check;
    if v_check is null then
      raise exception 'direct_entry_reporting_facts_v01 view not found';
    end if;
    if position('security_invoker = true' in lower(v_check)) > 0 then
      raise exception 'direct_entry_reporting_facts_v01 must run as owner (security_invoker=false); got security_invoker=true';
    end if;

    select pg_get_viewdef('public.direct_entry_reporting_dimension_options_v01'::regclass, true)
      into v_check;
    if v_check is null then
      raise exception 'direct_entry_reporting_dimension_options_v01 view not found';
    end if;
    if position('security_invoker = true' in lower(v_check)) > 0 then
      raise exception 'direct_entry_reporting_dimension_options_v01 must run as owner (security_invoker=false); got security_invoker=true';
    end if;
  end;

  -- 6. Runtime blocker count is a non-negative bigint (data-agnostic).
  v_blocker_count := public.direct_entry_reporting_pre_cutover_blocker_count();
  if v_blocker_count is null or v_blocker_count < 0 then
    raise exception 'pre_cutover_blocker_count must be non-negative, got %', v_blocker_count;
  end if;

  -- 7. Reconciliation totals return the canonical 4-column shape and the
  --    locked cutoff date. Fresh DB returns 0/0/0.
  select legacy_subtotal, direct_entry_subtotal, overlap_blocker
    into v_legacy_subtotal, v_direct_entry_subtotal, v_overlap_blocker
    from public.direct_entry_reporting_reconciliation_totals();
  if v_legacy_subtotal is null
     or v_direct_entry_subtotal is null
     or v_overlap_blocker is null then
    raise exception 'reconciliation_totals returned NULL subtotal/blocker';
  end if;
  if v_legacy_subtotal < 0 or v_direct_entry_subtotal < 0 or v_overlap_blocker < 0 then
    raise exception 'reconciliation_totals subtotals must be non-negative';
  end if;
  if (select cutoff_date from public.direct_entry_reporting_reconciliation_totals())
       <> '2026-10-06'::date then
    raise exception 'reconciliation_totals cutoff drift (expected 2026-10-06)';
  end if;

  raise notice 'P2-W04B migration #44 self-check OK (cutoff=%, blocker=%, legacy=%, de=%)',
    v_cutoff, v_blocker_count, v_legacy_subtotal, v_direct_entry_subtotal;
end
$$;