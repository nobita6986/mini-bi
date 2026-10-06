-- =============================================================================
-- P3-W07A — Catalog bootstrap (personnel code + vendors)
--
-- Task:      P3-W07A_CATALOG_BOOTSTRAP_FAST_TRACK
-- Status:    P3-W07A_CATALOG_BOOTSTRAP_LOCAL_PASS_FAST_TRACK
-- Source:    docs/handoffs/p3-w07a-catalog-bootstrap-fast-track-HANDOFF.md
--
-- Owner workflow: one external XLSX workbook (Projects / Teams / HRP_Personnel /
-- Vendors) is imported via a local operator-only Node script; this migration
-- widens the catalog so the operator importer has a place to land personnel codes,
-- HRP/Vendor role labels and the vendor catalog without touching the canonical
-- `recruiter_id` storage. Direct Entry keeps storing canonical UUIDs.
--
-- HARD RULES (locked by T0):
--   1. Smallest possible schema delta. NO table is dropped, NO migration #1–#40
--      byte is modified, NO capability token is added.
--   2. `recruiter_id` (UUID) remains the canonical stored value. `personnel_code`
--      is a separate, nullable business identifier normalized via the same
--      NFC + trim + collapse + lowercase rule used elsewhere.
--   3. Project catalog stays flat active/inactive text. No effective-date,
--      no manager/team/HRP/Vendor relationship added.
--   4. HRP Sale rows carry exactly one active team membership (existing rule);
--      the new `personnel_position` distinguishes STAFF / TEAM_LEADER but does
--      NOT introduce a role engine. Trưởng nhóm = authenticated app user; the
--      team dashboard and assignment admin stay in P3-W07B.
--   5. Vendor has its own catalog. Vendor recruiters reference a vendor_id via
--      `recruiter_provider_memberships.vendor_id` (nullable, FK to vendors).
--      Vendor rows have no team / leader / project restriction in this release.
--   6. `direct_entry_input_catalog` returns:
--        - projects: unchanged (flat, unfiltered).
--        - HRP recruiters: `label = Họ và tên · personnel_code · Team`,
--          `provider_type = 'hrp'`, `recruiter_id = recruiters.recruiter_id`.
--        - Vendor recruiters: `label = vendor display name`,
--          `provider_type = 'vendor'`, `vendor_id = vendors.vendor_id`.
--      The canonical stored value is still `recruiter_id` (for HRP) or the
--      vendor's `recruiter_id` (for Vendor). Direct Entry input catalog keeps
--      `recruiter_id` as the selection key for both HRP and Vendor rows.
--   7. ACL/RLS unchanged on existing tables. `vendors` is created with the same
--      deny-by-default shape (no DML to anon/authenticated/public/service_role)
--      and only the input-catalog RPC is granted EXECUTE to service_role.
--   8. Vendor direct catalog is reachable only through `direct_entry_input_catalog`;
--      there is no new admin API.
--
-- The migration is data-agnostic: it never touches existing catalog rows. It
-- can apply cleanly on a Production-shape DB that already carries the P1.6
-- catalog bootstrap and on a fresh DB built from #1..#40.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Vendors (new flat active/inactive text list, mirrors `direct_entry_projects`).
-- -----------------------------------------------------------------------------
create table public.vendors (
  vendor_id text primary key check (vendor_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 256),
  active boolean not null default true,
  version integer not null default 1 check (version >= 1)
);

alter table public.vendors enable row level security;
alter table public.vendors force row level security;
revoke all on table public.vendors
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Recruiters: personnel_code + position. Both columns are NULLABLE so the
-- existing rows from the P1.6 catalog bootstrap keep working. Unique index on
-- normalized personnel_code (case-insensitive NFC + trim + collapse).
-- -----------------------------------------------------------------------------
alter table public.recruiters
  add column personnel_code text
    check (personnel_code is null or length(btrim(personnel_code)) between 1 and 64),
  add column personnel_position text
    check (personnel_position is null or personnel_position in ('STAFF','TEAM_LEADER'));

create unique index recruiters_personnel_code_lower_uidx
  on public.recruiters (lower(public.recruitment_dimension_key(personnel_code)))
  where personnel_code is not null;

-- -----------------------------------------------------------------------------
-- recruiter_provider_memberships: vendor_id (nullable FK). HRP rows leave it
-- NULL; Vendor rows point to a row in `vendors`. The existing
-- `recruiter_id, valid_from` unique index is preserved.
-- -----------------------------------------------------------------------------
alter table public.recruiter_provider_memberships
  add column vendor_id text references public.vendors(vendor_id) on delete restrict;

alter table public.recruiter_provider_memberships enable row level security;
alter table public.recruiter_provider_memberships force row level security;
revoke all on table public.recruiter_provider_memberships
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Re-create `direct_entry_input_catalog` so it exposes:
--   - projects (flat, no effective-date / no team / no HRP / no Vendor filter)
--   - HRP recruiters: label = display_name · personnel_code · team_display_name;
--     only rows with provider_type = 'hrp'.
--   - Vendor recruiters: label = vendor display_name; only rows with
--     provider_type = 'vendor' AND a non-null vendor_id pointing at an active
--     vendor. The recruiter_id of the Vendor recruiter remains the selection
--     key (Direct Entry keeps canonical recruiter_id storage).
-- The function returns `effective_date, projects[], recruiters[], banks[]`
-- with `recruiters[]` including `provider_type` and the new label rule. The
-- projection keeps its existing exact-key contract (project_id, recruiter_id,
-- bank_id are all unique within the response).
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
    -- P1.6 contract: an HRP recruiter is eligible only when they have
    -- exactly one HRP provider membership in force on `effective_date`.
    -- A recruiter with overlapping HRP memberships is excluded; the
    -- overlap guard trigger enforces the same invariant at write time.
    select m.recruiter_id, count(*) as membership_count
      from public.recruiter_provider_memberships m
     where m.provider_type = 'hrp'
       and m.valid_from <= p_effective_date
       and (m.valid_to is null or p_effective_date < m.valid_to)
     group by m.recruiter_id
  ), vendor_memberships as (
    -- P3-W07A: Vendor eligibility is decided by `provider_type = 'vendor'`
    -- membership at `effective_date`. Membership count is NOT a business
    -- rule for Vendor. A Vendor recruiter may carry more than one vendor
    -- membership (e.g. switch vendor during a release window); the catalog
    -- surfaces each membership as its own row, filtered by
    -- `provider_type = 'vendor'`. Vendor has no team / leader / project
    -- restriction in this release.
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
    ), '[]'::jsonb), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.direct_entry_input_catalog(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_input_catalog(uuid, uuid, date)
  to service_role;

comment on table public.vendors is
  'P3-W07A: Vendor catalog. Flat active/inactive text list, no team / leader / '
  'project relationship. Mirrors direct_entry_projects shape.';
comment on column public.recruiters.personnel_code is
  'P3-W07A: business identifier (e.g. vinht.td). Unique when present (NFC + '
  'trim + collapse + lowercase normalization). Distinct from canonical '
  'recruiter_id (UUID).';
comment on column public.recruiter_provider_memberships.vendor_id is
  'P3-W07A: vendor membership target. NULL for HRP rows; required for Vendor '
  'rows (enforced by the input-catalog projection).';

-- P3-W07A-R1: pin the locked UI label mapping for HRP positions.
-- The catalog projection is the only place that maps the canonical enum to
-- the UI label; keep this comment in sync with `personnel_position` so the
-- wiring stays discoverable. UI label mapping is enforced at the live
-- (TypeScript) layer; the migration only carries the canonical enum.
comment on column public.recruiters.personnel_position is
  'P3-W07A: STAFF (UI: Nhân viên) or TEAM_LEADER (UI: Trưởng nhóm). '
  'Identity-only; not a role token. Trưởng nhóm = authenticated app user; '
  'team dashboard and assignment admin live in P3-W07B. W07A does NOT create '
  'accounts, capability grants or team dashboards based on this column.';

-- -----------------------------------------------------------------------------
-- In-migration self-check (data-agnostic; structural invariants only).
-- -----------------------------------------------------------------------------
do $$
declare
  v_columns text[];
  v_check text;
begin
  -- vendors table layout
  select array_agg(attname order by attnum)
    into v_columns
    from pg_attribute
   where attrelid = 'public.vendors'::regclass
     and attnum > 0
     and not attisdropped;
  v_check := array_to_string(v_columns, ',');
  if v_check <> 'vendor_id,display_name,active,version' then
    raise exception 'vendors column layout drifted: %', v_check;
  end if;

  -- recruiters has new columns
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.recruiters'::regclass
       and attnum > 0 and not attisdropped and attname = 'personnel_code'
  ) then
    raise exception 'recruiters.personnel_code missing';
  end if;
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.recruiters'::regclass
       and attnum > 0 and not attisdropped and attname = 'personnel_position'
  ) then
    raise exception 'recruiters.personnel_position missing';
  end if;

  -- recruiter_provider_memberships has new column
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.recruiter_provider_memberships'::regclass
       and attnum > 0 and not attisdropped and attname = 'vendor_id'
  ) then
    raise exception 'recruiter_provider_memberships.vendor_id missing';
  end if;

  -- RLS / grants on vendors
  if not exists (
    select 1 from pg_class c
     where c.oid = 'public.vendors'::regclass
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'vendors must be RLS + FORCE RLS';
  end if;
  if has_table_privilege('service_role', 'public.vendors', 'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'service_role must not have vendors DML';
  end if;
  if has_table_privilege('anon', 'public.vendors', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'anon must not have vendors privs';
  end if;
  if has_table_privilege('authenticated', 'public.vendors', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'authenticated must not have vendors privs';
  end if;

  -- RLS on recruiter_provider_memberships (re-enabled)
  if not exists (
    select 1 from pg_class c
     where c.oid = 'public.recruiter_provider_memberships'::regclass
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'recruiter_provider_memberships must be RLS + FORCE RLS';
  end if;

  -- direct_entry_input_catalog must be SECURITY DEFINER with fixed search_path
  if not (
    select p.prosecdef
      from pg_proc p
     where p.oid = 'public.direct_entry_input_catalog(uuid,uuid,date)'::regprocedure
  ) then
    raise exception 'direct_entry_input_catalog must be SECURITY DEFINER';
  end if;

  -- service_role can EXECUTE; anon/authenticated/public cannot
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
end
$$;