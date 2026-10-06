-- =============================================================================
-- P3-W07A-R2 — Catalog runtime contract hotfix
--
-- Task:      P3-W07A-R2_CATALOG_RUNTIME_CONTRACT_HOTFIX_FAST_TRACK
-- Status:    P3-W07A-R2_CATALOG_RUNTIME_CONTRACT_HOTFIX_LOCAL_PASS_FAST_TRACK
-- Base:      origin/main@5e7e5c7
--
-- Root cause:
--   Production /api/direct-entry/catalog returns HTTP 500
--   CATALOG_UNAVAILABLE because the runtime projector `projectDraftCatalog`
--   in src/lib/direct-entry/write-repository.ts requires four exact top-level
--   keys: `effective_date, projects, recruiters, banks`. Migration #41
--   (`20261008000000_p3_w07a_catalog_bootstrap_personnel.sql`) replaced
--   `public.direct_entry_input_catalog` and silently dropped the `banks` key
--   while still emitting Vendor recruiter rows with `team_id = null` and
--   `team_display_name = null`. The TypeScript runtime requires
--   `team_id: string` and `team_display_name: string` on every recruiter.
--   The projector therefore returns null for any Vendor recruiter, the
--   `loadInputCatalog` repository returns `unavailable`, and the API
--   surfaces HTTP 500 CATALOG_UNAVAILABLE.
--
-- This migration (#42) replaces `direct_entry_input_catalog` so the
-- production contract is the locked discriminated contract:
--
--   Top-level keys (exact, four):
--     effective_date, projects, recruiters, banks
--
--   Recruiter keys (exact, eight) for HRP:
--     recruiter_id, display_name, personnel_code, provider_type,
--     vendor_id, team_id, team_display_name, label
--     where:
--       provider_type = 'hrp'
--       vendor_id     = null
--       team_id       is a UUID string
--       team_display_name is a non-empty string
--       label         = `display_name · personnel_code · team_display_name`
--
--   Recruiter keys (exact, eight) for Vendor:
--     recruiter_id, display_name, personnel_code, provider_type,
--     vendor_id, team_id, team_display_name, label
--     where:
--       provider_type = 'vendor'
--       personnel_code = null
--       vendor_id     is a text string or null (legacy)
--       team_id       = null
--       team_display_name = null
--       label         = vendor display name (falls back to recruiter display name
--                       only when vendor_id is null AND the recruiter still
--                       appears under provider_type = 'vendor' as a legacy row)
--
--   Project keys (exact, two):   project_id, display_name
--   Bank    keys (exact, two):   bank_id,    display_name
--
-- Locked T0 invariants this migration preserves:
--   - SECURITY DEFINER with fixed search_path = pg_catalog, public.
--   - service_role EXECUTE only; anon/authenticated/public denied.
--   - actor and capability checks (entry_create OR entry_own) unchanged.
--   - projects remain a flat active/inactive list with NO HRP / Vendor /
--     team / leader / effective-date scope.
--   - HRP and Vendor filtering stays as locked by P3-W07A-R1
--     (HRP uses `membership_count = 1`; Vendor uses `provider_type` only
--     with a vendor_id join).
--   - Vendor rows are not given a synthetic business team. Vendor's
--     `team_id` / `team_display_name` are explicitly null in the catalog
--     projection; the runtime contract accepts null for Vendor and
--     requires a UUID for HRP.
--
-- Out of scope: the `direct_entries.team_id` storage column is unchanged
-- (NOT NULL on the write side; this task only fixes the read-side catalog
-- contract). Vendor write-side hidden reserved-team compatibility is a
-- separate task and is NOT touched here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Re-create `direct_entry_input_catalog` so it always returns the locked
-- four-key top-level shape with eight keys per recruiter and a (possibly
-- empty) `banks` array. Vendor rows have null team fields; HRP rows have
-- null vendor_id. The HRP and Vendor decision logic is unchanged from
-- migration #41 (W07A-R1) and is preserved verbatim.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_input_catalog(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_effective_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  if p_effective_date is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;
  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) or not exists (
    select 1
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability in ('entry_create', 'entry_own')
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  ) then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  with hrp_memberships as (
    -- P1.6 contract (unchanged from #41): an HRP recruiter is eligible only
    -- when they have exactly one HRP provider membership in force on
    -- `effective_date`. Overlapping HRP memberships are excluded.
    select m.recruiter_id, count(*) as membership_count
      from public.recruiter_provider_memberships m
     where m.provider_type = 'hrp'
       and m.valid_from <= p_effective_date
       and (m.valid_to is null or p_effective_date < m.valid_to)
     group by m.recruiter_id
  ), vendor_memberships as (
    -- P3-W07A (unchanged from #41): Vendor eligibility is decided by
    -- `provider_type = 'vendor'` membership at `effective_date`. The
    -- catalog surfaces the active membership; overlapping memberships
    -- are filtered by the effective-date window.
    select m.recruiter_id, m.vendor_id
      from public.recruiter_provider_memberships m
     where m.provider_type = 'vendor'
       and m.valid_from <= p_effective_date
       and (m.valid_to is null or p_effective_date < m.valid_to)
  ), hrp_teams as (
    select m.recruiter_id, count(*) as membership_count,
           min(m.team_id::text)::uuid as team_id
      from public.recruiter_team_memberships m
     where m.valid_from <= p_effective_date
       and (m.valid_to is null or p_effective_date < m.valid_to)
     group by m.recruiter_id
  ), hrp_recruiters as (
    select r.recruiter_id, r.display_name, r.personnel_code, tt.team_id,
           team.display_name as team_display_name
      from public.recruiters r
      join hrp_memberships p on p.recruiter_id = r.recruiter_id
                            and p.membership_count = 1
      join hrp_teams tt on tt.recruiter_id = r.recruiter_id
                        and tt.membership_count = 1
      join public.teams team on team.team_id = tt.team_id and team.active
     where r.active
  ), vendor_recruiters as (
    select r.recruiter_id, r.display_name, vm.vendor_id,
           v.display_name as vendor_display_name
      from public.recruiters r
      join vendor_memberships vm on vm.recruiter_id = r.recruiter_id
      left join public.vendors v on v.vendor_id = vm.vendor_id and v.active
     where r.active
       -- Vendor recruiters without a `vendor_id` on the membership are
       -- legacy P1.6 bootstrap rows; they still appear in the catalog with
       -- the recruiter display_name as the label until the W07A importer
       -- links them to a vendor record.
       and (vm.vendor_id is null or v.vendor_id is not null)
  )
  select jsonb_build_object(
    'effective_date', p_effective_date,
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project_id', p.project_id, 'display_name', p.display_name
      ) order by p.display_name, p.project_id)
        from public.direct_entry_projects p
       where p.active
    ), '[]'::jsonb),
    'recruiters', coalesce((
      select coalesce(jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', r.display_name,
        'personnel_code', r.personnel_code,
        'provider_type', 'hrp',
        'vendor_id', null,
        'team_id', r.team_id,
        'team_display_name', r.team_display_name,
        'label', (
          r.display_name
          || ' · ' || coalesce(r.personnel_code, '—')
          || ' · ' || r.team_display_name
        )
      ) order by r.display_name, r.team_display_name, r.recruiter_id), '[]'::jsonb)
        from hrp_recruiters r
    ) || coalesce((
      select jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', coalesce(r.vendor_display_name, r.display_name),
        'personnel_code', null,
        'provider_type', 'vendor',
        'vendor_id', r.vendor_id,
        'team_id', null,
        'team_display_name', null,
        'label', coalesce(r.vendor_display_name, r.display_name)
      ) order by coalesce(r.vendor_display_name, r.display_name), r.recruiter_id)
        from vendor_recruiters r
    ), '[]'::jsonb), '[]'::jsonb),
    -- P3-W07A-R2: restore the `banks` key that migration #41 dropped.
    -- Active banks only, ordered for determinism, may be empty.
    'banks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bank_id', b.bank_id, 'display_name', b.display_name
      ) order by b.display_name, b.bank_id)
        from public.direct_entry_banks b
       where b.active
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.direct_entry_input_catalog(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_input_catalog(uuid, uuid, date)
  to service_role;

comment on function public.direct_entry_input_catalog(uuid, uuid, date) is
  'P3-W07A-R2: locked four-top-level-key contract (effective_date, projects, '
  'recruiters, banks). Each recruiter carries exactly eight keys; HRP rows '
  'have vendor_id = null and a UUID team_id; Vendor rows have personnel_code '
  '= null and team_id = team_display_name = null.';

-- -----------------------------------------------------------------------------
-- Data-agnostic self-check. Verifies structural invariants only. Does not
-- depend on business data (no team / recruiter / vendor rows are required).
-- -----------------------------------------------------------------------------
do $$
declare
  v_check text;
  v_needed_count integer;
  v_needed_found integer;
begin
  -- The function must still be SECURITY DEFINER with fixed search_path.
  if not (
    select p.prosecdef
      from pg_proc p
     where p.oid = 'public.direct_entry_input_catalog(uuid,uuid,date)'::regprocedure
  ) then
    raise exception 'direct_entry_input_catalog must be SECURITY DEFINER';
  end if;

  -- service_role can EXECUTE; anon / authenticated / public cannot.
  if not has_function_privilege('service_role',
       'public.direct_entry_input_catalog(uuid,uuid,date)'::regprocedure, 'EXECUTE') then
    raise exception 'service_role must EXECUTE direct_entry_input_catalog';
  end if;
  if has_function_privilege('anon',
       'public.direct_entry_input_catalog(uuid,uuid,date)'::regprocedure, 'EXECUTE') then
    raise exception 'anon must not EXECUTE direct_entry_input_catalog';
  end if;
  if has_function_privilege('authenticated',
       'public.direct_entry_input_catalog(uuid,uuid,date)'::regprocedure, 'EXECUTE') then
    raise exception 'authenticated must not EXECUTE direct_entry_input_catalog';
  end if;

  -- Empty catalog must carry the locked four top-level keys (with `banks`
  -- present even when zero rows match — `coalesce` guarantees '[]').
  -- The check is structural: the function's prosrc must mention all four
  -- top-level key literals AND all eight recruiter key literals AND the
  -- 'hrp' / 'vendor' provider type literals. A future refactor that
  -- silently drops one key fails this gate.
  select p.prosrc into v_check
    from pg_proc p
   where p.oid = 'public.direct_entry_input_catalog(uuid,uuid,date)'::regprocedure;
  v_needed_count := 0;
  v_needed_found := 0;
  if position('''effective_date''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''projects''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''recruiters''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''banks''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''recruiter_id''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''display_name''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''personnel_code''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''provider_type''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''vendor_id''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''team_id''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''team_display_name''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''label''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''hrp''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if position('''vendor''' in v_check) > 0 then v_needed_found := v_needed_found + 1; end if; v_needed_count := v_needed_count + 1;
  if v_needed_found <> v_needed_count then
    raise exception 'direct_entry_input_catalog source missing one of the locked top-level / recruiter key literals (found % of %)', v_needed_found, v_needed_count;
  end if;

  -- direct_entry_banks must still exist (we restored reading from it).
  if to_regclass('public.direct_entry_banks') is null then
    raise exception 'public.direct_entry_banks must exist (catalog banks key)';
  end if;
end
$$;
