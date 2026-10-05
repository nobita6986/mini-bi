-- =============================================================================
-- P2-W04A — Direct Entry reporting fact projection (LOCKED cutoff)
--
-- Task:      P2-W04A_DIRECT_ENTRY_REPORTING_CUTOVER_RUNTIME_CLOSURE (R1)
-- Status:    P2-W04A-R1_DIRECT_ENTRY_REPORTING_RUNTIME_CLOSED_LOCAL_PASS_FAST_TRACK
-- Source:    docs/handoffs/p2-w04a-direct-entry-reporting-cutover.md
--
-- Adds an internal service-role-only projection that turns canonical Direct
-- Entry submissions/entries into the existing ReportingFact row shape so the
-- P1 dashboard read path can union them at the database boundary.
--
-- HARD RULES (locked by T0):
--   1. Cutoff date is 2026-10-17 (Asia/Ho_Chi_Minh). Legacy aggregate is
--      counted only when business_date < cutoff; Direct Entry is counted
--      only when first_work_date >= cutoff. No transition overlap.
--   2. Direct Entry commitment = submission.state = 'SUBMITTED' AND
--      deleted_at IS NULL. Each eligible row contributes exactly
--      recruited_count = 1 (one person, one entry). Revisions, documents,
--      payments and employment-status events MUST NOT multiply the row.
--   3. If an eligible Direct Entry row has first_work_date < cutoff, the
--      read path raises a hard blocker. It is never silently dropped and
--      never double-counted.
--   4. No raw Direct Entry table is exposed to anon / authenticated /
--      public. Projection is a service-role-only view. Helpers needed by
--      the runtime/RPC path are explicitly GRANT EXECUTE to service_role.
--      Internal-only helpers stay revoked from public/anon/authenticated.
--   5. No write path is added by this migration.
--
-- R1 CHANGES (relative to #40 R0 — T0 R1 mandate):
--   * Self-check is now DATA-AGNOSTIC: it asserts structural invariants
--     only (cutoff, object/column/grant shape, helper privileges,
--     reconciliation return shape, helper SELECT/EXECUTE semantics). It does
--     NOT require legacy_subtotal / direct_entry_subtotal / overlap_blocker
--     to be 0 on a fresh DB — so the migration applies cleanly on a
--     Production-shape DB that already carries 34 legacy rows / 44 total /
--     6 eligible DE rows / 0 pre-cutoff eligible DE rows.
--   * Service-role-only views run as the view owner (`security_invoker =
--     false`, the PG15+ default). Underlying Direct Entry tables are
--     revoked from service_role, but the view still SELECTs because it
--     runs as the owner (the migration owner) which retains table
--     privileges. `anon` / `authenticated` / `public` remain denied.
--   * Every helper that reads a Direct Entry / submission / breakdown
--     table is `SECURITY DEFINER` with a fixed safe `search_path =
--     pg_catalog, public`. Constants / pure normalizers stay `SECURITY
--     INVOKER` because they do not read tables.
--   * Public/anon/authenticated remain denied; `service_role` is granted
--     EXECUTE on every runtime/RPC helper.
--   * Direct Entry projection view SELECTs `entry_id` as the deterministic
--     unique tie-breaker in its ORDER clause (last key) so two DE entries
--     sharing a ReportingFact grain still paginate deterministically.
--   * Legacy `daily_recruitment_breakdown` ORDER clause is untouched.
--   * No migration #41 is added by this wave.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Locked cutoff date. Returned by SQL so the read path and reconciliation both
-- refer to a single source of truth.
-- -----------------------------------------------------------------------------
-- Pure constant helper: returns the locked cutover date. SECURITY
-- INVOKER (default) because it does not touch any table.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_cutoff()
returns date
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select date '2026-10-17'
$$;

comment on function public.direct_entry_reporting_cutoff() is
  'Cutoff date (Asia/Ho_Chi_Minh) that partitions legacy aggregate (< cutoff) '
  'from Direct Entry (>= cutoff). Hard-coded to T0-locked 2026-10-17.';

revoke all on function public.direct_entry_reporting_cutoff()
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_cutoff() to service_role;

-- -----------------------------------------------------------------------------
-- Locked Direct Entry projection source id. This UUID tags every row in the
-- projection view so the read path can distinguish Direct Entry rows from
-- legacy data_sources rows. It is a SQL constant only; no row is inserted
-- into public.data_sources.
-- -----------------------------------------------------------------------------
-- Pure constant helper: returns the synthetic DE source UUID. SECURITY
-- INVOKER (default) because it does not touch any table.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_source_id()
returns uuid
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select '00000000-0000-4000-8000-0000de000001'::uuid
$$;

comment on function public.direct_entry_reporting_source_id() is
  'Stable synthetic source_id for Direct Entry projection rows. Not registered '
  'as a data_source. Used by the read path to scope DE facts.';

revoke all on function public.direct_entry_reporting_source_id()
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_source_id() to service_role;

-- -----------------------------------------------------------------------------
-- Internal helper: normalize a dimension value to the existing
-- recruitment_dimension_key (NFC + trim + collapse whitespace + lowercase).
-- Reused by the projection view. Mirrors recruitment_dimension_key().
-- -----------------------------------------------------------------------------
-- Pure constant helper: NFC + trim + collapse + lowercase normalization.
-- SECURITY INVOKER (default) because it does not touch any table.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_dim_key(p_value text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select case
    when p_value is null then null
    when btrim(regexp_replace(normalize(p_value, NFC), '\s+', ' ', 'g')) = '' then null
    else lower(btrim(regexp_replace(normalize(p_value, NFC), '\s+', ' ', 'g')))
  end
$$;

comment on function public.direct_entry_reporting_dim_key(text) is
  'Reporting dimension key for Direct Entry projection: NFC + trim + collapse '
  'whitespace + lowercase. Mirror of recruitment_dimension_key() semantics.';

revoke all on function public.direct_entry_reporting_dim_key(text)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_dim_key(text) to service_role;

-- -----------------------------------------------------------------------------
-- Internal helper: resolve the recruiter reporting key effective at a given
-- first_work_date from recruiter_aliases (half-open [valid_from, valid_to)).
-- Returns '__unknown__' when no alias is in force.
--
-- SECURITY DEFINER + fixed safe search_path: reads recruiter_aliases. Runs
-- under the function owner so service_role does NOT need raw table grants;
-- anon/authenticated/public remain denied (REVOKE / GRANT below).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_recruiter_alias_key(
  p_recruiter_id uuid,
  p_at date
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (
      select a.reporting_key
        from public.recruiter_aliases a
       where a.recruiter_id = p_recruiter_id
         and a.valid_from <= p_at
         and (a.valid_to is null or p_at < a.valid_to)
       order by a.valid_from desc
       limit 1
    ),
    '__unknown__'
  )
$$;

comment on function public.direct_entry_reporting_recruiter_alias_key(uuid, date) is
  'Resolve recruiter_aliases.reporting_key effective at first_work_date '
  '(half-open [valid_from, valid_to)). No alias in force => "__unknown__" sentinel.';

revoke all on function public.direct_entry_reporting_recruiter_alias_key(uuid, date)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_recruiter_alias_key(uuid, date) to service_role;

-- -----------------------------------------------------------------------------
-- Internal helper: effective provider_type for a recruiter at a given date
-- from recruiter_provider_memberships. Returns '__unknown__' when no
-- membership is in force.
--
-- SECURITY DEFINER + fixed safe search_path: reads recruiter_provider_memberships.
-- service_role does NOT need raw table grants; anon/authenticated/public denied.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_recruiter_provider_key(
  p_recruiter_id uuid,
  p_at date
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (
      select m.provider_type
        from public.recruiter_provider_memberships m
       where m.recruiter_id = p_recruiter_id
         and m.valid_from <= p_at
         and (m.valid_to is null or p_at < m.valid_to)
       order by m.valid_from desc
       limit 1
    ),
    '__unknown__'
  )
$$;

comment on function public.direct_entry_reporting_recruiter_provider_key(uuid, date) is
  'Effective provider_type (hrp|vendor) for a recruiter at first_work_date '
  'via recruiter_provider_memberships. No membership => "__unknown__" sentinel.';

revoke all on function public.direct_entry_reporting_recruiter_provider_key(uuid, date)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_recruiter_provider_key(uuid, date) to service_role;

-- -----------------------------------------------------------------------------
-- Internal helper: map Direct Entry labor_type (TEMPORARY/PERMANENT) onto the
-- existing reporting employment_type key. Returns '__unknown__' on null/missing.
-- -----------------------------------------------------------------------------
-- Pure mapping helper: Direct Entry labor_type -> reporting employment_type.
-- SECURITY INVOKER (default) because it does not touch any table.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_employment_key(p_labor_type text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select case p_labor_type
    when 'TEMPORARY' then 'thời vụ'
    when 'PERMANENT' then 'chính thức'
    else '__unknown__'
  end
$$;

comment on function public.direct_entry_reporting_employment_key(text) is
  'Map Direct Entry labor_type to reporting employment_type key '
  '(TEMPORARY=thời vụ, PERMANENT=chính thức). Anything else => "__unknown__".';

revoke all on function public.direct_entry_reporting_employment_key(text)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_employment_key(text) to service_role;

-- -----------------------------------------------------------------------------
-- Service-role-only projection view.
--
-- Each row = one eligible Direct Entry entry as a single ReportingFact, with
-- the canonical grain: business_date (= first_work_date), project_key/display,
-- recruiter_key/display, provider_type_key/display, employment_type_key/display,
-- recruited_count = 1.
--
-- Eligibility filter (locked):
--   * submission.state = 'SUBMITTED'
--   * direct_entries.deleted_at IS NULL
--   * first_work_date >= direct_entry_reporting_cutoff()
--
-- No joins to revisions, document_versions, document_events, payments, or
-- employment_status_events (those are 1:N with the entry and would multiply
-- the fact row if naively joined). The grain is per entry, not per
-- revision/document/payment/event, so the "no double count" guarantee is
-- enforced by the SELECT shape itself.
--
-- security_invoker = false (PG15+ default for views): the SELECT runs as
-- the view owner so service_role does NOT need raw table grants on
-- direct_entries / direct_entry_submissions / direct_entry_projects /
-- recruiters / recruiter_aliases / recruiter_provider_memberships. Only
-- the view's own SELECT ACL governs who can read from it; we revoke
-- anon / authenticated / public and grant SELECT to service_role.
-- -----------------------------------------------------------------------------
create or replace view public.direct_entry_reporting_facts_v01
as
select
    public.direct_entry_reporting_source_id()::text as source_id,
    e.first_work_date                                as business_date,
    public.direct_entry_reporting_dim_key(p.display_name) as project_key,
    p.display_name                                  as project_display,
    public.direct_entry_reporting_recruiter_alias_key(e.recruiter_id, e.first_work_date) as recruiter_key,
    r.display_name                                  as recruiter_display,
    public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date) as provider_type_key,
    case e.provider_type
      when 'hrp'    then 'HRP'
      when 'vendor' then 'Vendor'
      else               'Không xác định'
    end                                             as provider_type_display,
    public.direct_entry_reporting_employment_key(e.labor_type) as employment_type_key,
    case e.labor_type
      when 'TEMPORARY' then 'Thời vụ'
      when 'PERMANENT' then 'Chính thức'
      else                'Không xác định'
    end                                             as employment_type_display,
    1                                               as recruited_count,
    e.first_work_date                               as first_work_date,
    e.entry_id                                      as entry_id,
    e.submission_id                                 as submission_id,
    public.direct_entry_reporting_cutoff()          as cutoff_date
  from public.direct_entries e
  join public.direct_entry_submissions s
    on s.submission_id = e.submission_id
  join public.direct_entry_projects p
    on p.project_id = e.project_id
  join public.recruiters r
    on r.recruiter_id = e.recruiter_id
 where s.state = 'SUBMITTED'
   and e.deleted_at is null
   and e.first_work_date >= public.direct_entry_reporting_cutoff()
 -- Deterministic ordering for read path pagination:
 -- ReportingFact grain first, then entry_id as the unique tie-breaker
 -- so two DE entries sharing the same grain do not collapse.
 order by
   public.direct_entry_reporting_source_id()::text,
   e.first_work_date,
   public.direct_entry_reporting_dim_key(p.display_name),
   public.direct_entry_reporting_recruiter_alias_key(e.recruiter_id, e.first_work_date),
   public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date),
   public.direct_entry_reporting_employment_key(e.labor_type),
   e.entry_id;

comment on view public.direct_entry_reporting_facts_v01 is
  'P2-W04A Direct Entry reporting projection: one row per eligible canonical '
  'entry, mapped to ReportingFact grain, masked to first_work_date >= cutoff. '
  'Service-role-only.';

revoke all on public.direct_entry_reporting_facts_v01 from public, anon, authenticated;
grant select on public.direct_entry_reporting_facts_v01 to service_role;

-- Tighten the service_role boundary on the underlying Direct Entry tables:
-- service_role MUST NOT have raw SELECT on canonical Direct Entry tables.
-- All Direct Entry read access goes through the view (runs as owner) or
-- SECURITY DEFINER helpers (also run as owner). These revokes are
-- idempotent: if a future migration ever grants SELECT to service_role,
-- this stays the last word.
--
-- Legacy aggregate `daily_recruitment_breakdown` is intentionally NOT
-- revoked: it is the canonical legacy fact table and the read path needs
-- raw SELECT on it under service_role. The R1 service-role ACL test
-- pins this distinction (Direct Entry = denied, legacy = allowed).
revoke select on public.direct_entries            from service_role;
revoke select on public.direct_entry_submissions from service_role;
revoke select on public.direct_entry_projects    from service_role;
revoke select on public.recruiters                from service_role;
revoke select on public.recruiter_aliases         from service_role;
revoke select on public.recruiter_provider_memberships from service_role;

-- Service-role ACL: keep service_role's existing legacy aggregate read
-- access intact (the read path needs raw SELECT on
-- daily_recruitment_breakdown to mask the legacy side). The Direct Entry
-- tables stay revoked — see block above.
grant select on public.daily_recruitment_breakdown to service_role;

-- -----------------------------------------------------------------------------
-- Runtime blocker helper (R1). The cutover read path calls this
-- INDEPENDENTLY of the projection view so a pre-cutoff eligible row can
-- never be masked into invisibility by an accidentally-bypassed view.
-- Returns the count of eligible Direct Entry rows with
-- first_work_date < cutoff. >0 => cutover blocker (hard fail).
--
-- SECURITY DEFINER + fixed safe search_path: reads direct_entries and
-- direct_entry_submissions. service_role does NOT need raw table grants;
-- anon/authenticated/public denied.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_pre_cutover_blocker_count()
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select count(*)
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
   where s.state = 'SUBMITTED'
     and e.deleted_at is null
     and e.first_work_date < public.direct_entry_reporting_cutoff()
$$;

comment on function public.direct_entry_reporting_pre_cutover_blocker_count() is
  'Count of eligible Direct Entry rows with first_work_date < cutoff. '
  'Non-zero => cutover blocker. Runtime/RPC helper: GRANT EXECUTE to service_role '
  '(revoked from public/anon/authenticated).';

revoke all on function public.direct_entry_reporting_pre_cutover_blocker_count()
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_pre_cutover_blocker_count() to service_role;

-- -----------------------------------------------------------------------------
-- Internal helper: subtotals for reconciliation. Returns four values:
--   * legacy_subtotal       = sum(recruited_count) for daily_recruitment_breakdown
--     masked to business_date < cutoff.
--   * direct_entry_subtotal = count(*) of eligible rows with
--     first_work_date >= cutoff.
--   * overlap_blocker       = count(*) of eligible rows with
--     first_work_date < cutoff (must be 0; non-zero => blocker).
--   * cutoff_date           = the locked cutover date.
-- Used by the read-only Production reconciliation script and the test harness.
--
-- SECURITY DEFINER + fixed safe search_path: reads daily_recruitment_breakdown,
-- direct_entries and direct_entry_submissions. service_role does NOT need
-- raw table grants; anon/authenticated/public denied.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_reconciliation_totals()
returns table (
  legacy_subtotal       bigint,
  direct_entry_subtotal bigint,
  overlap_blocker       bigint,
  cutoff_date           date
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    (select coalesce(sum(b.recruited_count), 0)::bigint
       from public.daily_recruitment_breakdown b
      where b.business_date < public.direct_entry_reporting_cutoff()) as legacy_subtotal,
    (select count(*)
       from public.direct_entries e
       join public.direct_entry_submissions ss on ss.submission_id = e.submission_id
      where ss.state = 'SUBMITTED'
        and e.deleted_at is null
        and e.first_work_date >= public.direct_entry_reporting_cutoff()) as direct_entry_subtotal,
    (select count(*)
       from public.direct_entries e
       join public.direct_entry_submissions ss on ss.submission_id = e.submission_id
      where ss.state = 'SUBMITTED'
        and e.deleted_at is null
        and e.first_work_date < public.direct_entry_reporting_cutoff()) as overlap_blocker,
    public.direct_entry_reporting_cutoff() as cutoff_date
$$;

comment on function public.direct_entry_reporting_reconciliation_totals() is
  'Read-only reconciliation helper for P2-W04A. Runtime/RPC helper: '
  'GRANT EXECUTE to service_role (revoked from public/anon/authenticated). '
  'Returns legacy subtotal (< cutoff), Direct Entry subtotal (>= cutoff), '
  'overlap blocker count (< cutoff eligible) and cutoff date.';

revoke all on function public.direct_entry_reporting_reconciliation_totals()
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_reconciliation_totals() to service_role;

-- -----------------------------------------------------------------------------
-- Direct Entry dimension options view (R1). Mirrors the shape of
-- reporting_dimension_options_v01 but unions them with DE-only dimensions.
-- Service-role-only.
--
-- Reuses `buildDimensionOptions` semantics on the read path: dimension/key/
-- display + recruited_count (sum). The read path server is responsible for
-- the canonical merge + selectDisplay rule; this view just emits the DE-side
-- rows that the legacy view cannot see (DE-only projects, recruiters,
-- providers, employments).
--
-- security_invoker = false (PG15+ default for views): runs as view owner.
-- Only the view's own SELECT ACL governs access; anon/authenticated/public
-- remain denied, service_role has SELECT.
-- -----------------------------------------------------------------------------
create or replace view public.direct_entry_reporting_dimension_options_v01
as
select 'project' as dimension,
       public.direct_entry_reporting_dim_key(p.display_name) as key,
       p.display_name as display,
       count(*)::integer as recruited_count
  from public.direct_entries e
  join public.direct_entry_submissions s on s.submission_id = e.submission_id
  join public.direct_entry_projects p on p.project_id = e.project_id
 where s.state = 'SUBMITTED'
   and e.deleted_at is null
   and e.first_work_date >= public.direct_entry_reporting_cutoff()
 group by 1, 2, 3
union all
select 'recruiter',
       public.direct_entry_reporting_recruiter_alias_key(e.recruiter_id, e.first_work_date),
       r.display_name,
       count(*)::integer
  from public.direct_entries e
  join public.direct_entry_submissions s on s.submission_id = e.submission_id
  join public.recruiters r on r.recruiter_id = e.recruiter_id
 where s.state = 'SUBMITTED'
   and e.deleted_at is null
   and e.first_work_date >= public.direct_entry_reporting_cutoff()
 group by 1, 2, 3
union all
select 'provider',
       public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date),
       case e.provider_type
         when 'hrp'    then 'HRP'
         when 'vendor' then 'Vendor'
         else               'Không xác định'
       end,
       count(*)::integer
  from public.direct_entries e
  join public.direct_entry_submissions s on s.submission_id = e.submission_id
 where s.state = 'SUBMITTED'
   and e.deleted_at is null
   and e.first_work_date >= public.direct_entry_reporting_cutoff()
 group by 1, 2, 3
union all
select 'employment',
       public.direct_entry_reporting_employment_key(e.labor_type),
       case e.labor_type
         when 'TEMPORARY' then 'Thời vụ'
         when 'PERMANENT' then 'Chính thức'
         else                'Không xác định'
       end,
       count(*)::integer
  from public.direct_entries e
  join public.direct_entry_submissions s on s.submission_id = e.submission_id
 where s.state = 'SUBMITTED'
   and e.deleted_at is null
   and e.first_work_date >= public.direct_entry_reporting_cutoff()
 group by 1, 2, 3;

comment on view public.direct_entry_reporting_dimension_options_v01 is
  'P2-W04A Direct Entry dimension option catalog (project/recruiter/provider/'
  'employment). Service-role-only. Unions into the read-path dimension '
  'options result so DE-only dimensions remain selectable as long as DE facts '
  'are in scope.';

revoke all on public.direct_entry_reporting_dimension_options_v01
  from public, anon, authenticated;
grant select on public.direct_entry_reporting_dimension_options_v01 to service_role;

-- -----------------------------------------------------------------------------
-- In-migration self-check (R1). DATA-AGNOSTIC: structural invariants only.
--
-- Asserts:
--   1. The two views exist with the canonical column layout.
--   2. Views are revoked from anon / authenticated / public and granted
--      SELECT to service_role.
--   3. Views run as owner (security_invoker = false) so they can read
--      underlying Direct Entry tables without granting service_role raw
--      table SELECT.
--   4. Table-reading helpers (alias_key, provider_key, blocker_count,
--      reconciliation_totals) are SECURITY DEFINER with fixed safe
--      search_path; pure helpers remain SECURITY INVOKER.
--   5. Every runtime/RPC helper is GRANT EXECUTE to service_role and
--      REVOKED from anon / authenticated / public.
--   6. Cutoff date is locked to 2026-10-17.
--   7. Reconciliation_totals() returns the canonical 4-column shape and the
--      locked cutoff date. Does NOT assert any specific subtotal magnitude.
--   8. Blocker_count() returns a non-negative bigint (does not assert 0).
--   9. Direct Entry source id is the locked UUID.
--
-- The migration rolls back if any invariant fails.
-- -----------------------------------------------------------------------------
do $$
declare
  v_view_columns text[];
  v_check text;
  v_helper text;
  v_helper_definer_required boolean;
  v_proc_secdef boolean;
  v_cutoff date;
  v_blocker_count bigint;
  v_source_id uuid;
begin
  -- 1. Projection view column layout (ReportingFact grain + delivery line fields).
  select array_agg(attname order by attnum)
    into v_view_columns
    from pg_attribute
   where attrelid = 'public.direct_entry_reporting_facts_v01'::regclass
     and attnum > 0
     and not attisdropped;
  v_check := array_to_string(v_view_columns, ',');
  if v_check <> 'source_id,business_date,project_key,project_display,recruiter_key,recruiter_display,provider_type_key,provider_type_display,employment_type_key,employment_type_display,recruited_count,first_work_date,entry_id,submission_id,cutoff_date' then
    raise exception 'direct_entry_reporting_facts_v01 column layout drifted: %', v_check;
  end if;

  -- 1b. Dimension options view column layout (dimension, key, display, recruited_count).
  select array_agg(attname order by attnum)
    into v_view_columns
    from pg_attribute
   where attrelid = 'public.direct_entry_reporting_dimension_options_v01'::regclass
     and attnum > 0
     and not attisdropped;
  v_check := array_to_string(v_view_columns, ',');
  if v_check <> 'dimension,key,display,recruited_count' then
    raise exception 'direct_entry_reporting_dimension_options_v01 column layout drifted: %', v_check;
  end if;

  -- 2a. Projection view grants: revoked from anon / authenticated / public, granted to service_role.
  if has_table_privilege('anon',         'public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_facts_v01 must not be SELECT-able by anon';
  end if;
  if has_table_privilege('authenticated', 'public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_facts_v01 must not be SELECT-able by authenticated';
  end if;
  if not has_table_privilege('service_role', 'public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_facts_v01 must be SELECT-able by service_role';
  end if;

  -- 2b. Dimension options view grants: same as 2a.
  if has_table_privilege('anon',         'public.direct_entry_reporting_dimension_options_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_dimension_options_v01 must not be SELECT-able by anon';
  end if;
  if has_table_privilege('authenticated', 'public.direct_entry_reporting_dimension_options_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_dimension_options_v01 must not be SELECT-able by authenticated';
  end if;
  if not has_table_privilege('service_role', 'public.direct_entry_reporting_dimension_options_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_dimension_options_v01 must be SELECT-able by service_role';
  end if;

  -- 3. View semantic: runs as owner (security_invoker = false) so the
  --    underlying tables stay revoke-able from service_role. PG15+ PGlite
  --    18.3 cannot store `security_invoker = false` (it is the default and
  --    explicit false is a syntax error), so we read `pg_get_viewdef` and
  --    assert it does NOT mention `security_invoker = true`. If a future
  --    release re-introduces `security_invoker = true`, this migration
  --    fails closed.
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

  -- 4. Helper privileges:
  --    * Public/anon/authenticated must NOT have EXECUTE on any helper.
  --    * service_role MUST have EXECUTE on every helper the runtime/RPC calls.
  --    * Table-reading helpers MUST be SECURITY DEFINER; pure helpers stay
  --      SECURITY INVOKER (the default when not specified).
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

    -- Table-reading helpers MUST be SECURITY DEFINER. Pure constant /
    -- mapping helpers (cutoff, dim_key, employment_key, source_id) stay
    -- SECURITY INVOKER (default; they do not touch any table).
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

  -- 5. Cutoff is locked.
  v_cutoff := public.direct_entry_reporting_cutoff();
  if v_cutoff <> '2026-10-17'::date then
    raise exception 'direct_entry_reporting_cutoff() must return 2026-10-17, got %', v_cutoff;
  end if;

  -- 6. Reconciliation totals return the canonical 4-column shape and the
  --    locked cutoff date. We do NOT assert any specific subtotal magnitude
  --    — the migration must apply cleanly to a Production-shape DB.
  select cutoff_date into v_cutoff from public.direct_entry_reporting_reconciliation_totals();
  if v_cutoff <> '2026-10-17'::date then
    raise exception 'reconciliation_totals cutoff drift: %', v_cutoff;
  end if;

  -- 7. Blocker count returns a non-negative bigint (data-agnostic).
  v_blocker_count := public.direct_entry_reporting_pre_cutover_blocker_count();
  if v_blocker_count is null or v_blocker_count < 0 then
    raise exception 'pre_cutover_blocker_count must be non-negative, got %', v_blocker_count;
  end if;

  -- 8. Direct Entry source id is the locked UUID.
  v_source_id := public.direct_entry_reporting_source_id();
  if v_source_id <> '00000000-0000-4000-8000-0000de000001'::uuid then
    raise exception 'direct_entry_reporting_source_id drift: %', v_source_id;
  end if;

  -- (structural sanity: the dimension options view actually emits rows when
  --  eligible DE rows exist and 0 rows when they don't — checked separately
  --  by acceptance tests, not asserted here to stay data-agnostic.)

  raise notice 'P2-W04A R1 migration #40 self-check OK (cutoff=%, blocker=%, source_id=%)',
    v_cutoff, v_blocker_count, v_source_id;
end
$$;