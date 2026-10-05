-- =============================================================================
-- P2-W04A — Direct Entry reporting fact projection (LOCKED cutoff)
--
-- Task:      P2-W04A_DIRECT_ENTRY_REPORTING_CUTOVER
-- Status:    P2-W04A_DIRECT_ENTRY_REPORTING_CUTOVER_LOCAL_PASS_FAST_TRACK
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
--   2. Direct Entry eligibility = submission.state = 'SUBMITTED' AND
--      deleted_at IS NULL. Each eligible row contributes exactly
--      recruited_count = 1 (one person, one entry). Revisions, documents,
--      payments and employment-status events MUST NOT multiply the row.
--   3. If an eligible Direct Entry row has first_work_date < cutoff, the
--      read path raises a hard blocker. It is never silently dropped and
--      never double-counted.
--   4. No raw Direct Entry table is exposed to anon / authenticated /
--      public. Projection is a service-role-only view.
--   5. No write path is added by this migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Locked cutoff date. Returned by SQL so the read path and reconciliation both
-- refer to a single source of truth.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_cutoff()
returns date
language sql
immutable
set search_path = pg_catalog
as $$
  select date '2026-10-17'
$$;

comment on function public.direct_entry_reporting_cutoff() is
  'Cutoff date (Asia/Ho_Chi_Minh) that partitions legacy aggregate (< cutoff) '
  'from Direct Entry (>= cutoff). Hard-coded to T0-locked 2026-10-17.';

revoke all on function public.direct_entry_reporting_cutoff()
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Locked Direct Entry projection source id. This UUID tags every row in the
-- projection view so the read path can distinguish Direct Entry rows from
-- legacy data_sources rows. It is a SQL constant only; no row is inserted
-- into public.data_sources.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_source_id()
returns uuid
language sql
immutable
set search_path = pg_catalog
as $$
  select '00000000-0000-4000-8000-0000de000001'::uuid
$$;

comment on function public.direct_entry_reporting_source_id() is
  'Stable synthetic source_id for Direct Entry projection rows. Not registered '
  'as a data_source. Used by the read path to scope DE facts.';

revoke all on function public.direct_entry_reporting_source_id()
  from public, anon, authenticated;

revoke all on function public.direct_entry_reporting_cutoff()
  from public, anon, authenticated;
revoke all on function public.direct_entry_reporting_source_id()
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Internal helper: normalize a dimension value to the existing
-- recruitment_dimension_key (NFC + trim + collapse whitespace + lowercase).
-- Reused by the projection view.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_dim_key(p_value text)
returns text
language sql
immutable
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

-- -----------------------------------------------------------------------------
-- Internal helper: resolve the recruiter reporting key effective at a given
-- first_work_date from recruiter_aliases (half-open [valid_from, valid_to)).
-- Returns '__unknown__' when no alias is in force.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_recruiter_alias_key(
  p_recruiter_id uuid,
  p_at date
)
returns text
language sql
stable
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

-- -----------------------------------------------------------------------------
-- Internal helper: effective provider_type for a recruiter at a given date
-- from recruiter_provider_memberships. Returns '__unknown__' when no
-- membership is in force.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_recruiter_provider_key(
  p_recruiter_id uuid,
  p_at date
)
returns text
language sql
stable
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

-- -----------------------------------------------------------------------------
-- Internal helper: map Direct Entry labor_type (TEMPORARY/PERMANENT) onto the
-- existing reporting employment_type key. Returns '__unknown__' on null/missing.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_employment_key(p_labor_type text)
returns text
language sql
immutable
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
-- security_invoker = true: RLS of the underlying tables applies to the
-- caller. service_role bypasses RLS + has SELECT grant. anon / authenticated
-- / public are revoked.
-- -----------------------------------------------------------------------------
create or replace view public.direct_entry_reporting_facts_v01
with (security_invoker = true)
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
   and e.first_work_date >= public.direct_entry_reporting_cutoff();

comment on view public.direct_entry_reporting_facts_v01 is
  'P2-W04A Direct Entry reporting projection: one row per eligible canonical '
  'entry, mapped to ReportingFact grain, masked to first_work_date >= cutoff. '
  'Service-role-only.';

revoke all on public.direct_entry_reporting_facts_v01 from public, anon, authenticated;
grant select on public.direct_entry_reporting_facts_v01 to service_role;

-- -----------------------------------------------------------------------------
-- Internal helper: count of eligible Direct Entry rows that would land on the
-- legacy side of the cutoff (first_work_date < cutoff). When non-zero, the
-- read path MUST raise a cutover blocker. Not exposed to anon/authenticated/public.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_pre_cutover_blocker_count()
returns bigint
language sql
stable
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
  'Non-zero => cutover blocker. service-role-only (no grant to anon/auth).';

revoke all on function public.direct_entry_reporting_pre_cutover_blocker_count()
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Internal helper: subtotals for reconciliation. Returns three counts:
--   * legacy_subtotal = sum(recruited_count) for daily_recruitment_breakdown
--     masked to business_date < cutoff.
--   * direct_entry_subtotal = count(*) of eligible rows with
--     first_work_date >= cutoff.
--   * overlap_blocker = count(*) of eligible rows with
--     first_work_date < cutoff (must be 0; non-zero => blocker).
-- Used by the read-only Production reconciliation script and the test harness.
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
  'Read-only Reconciliation helper for P2-W04A. Service-role-only (no grant '
  'to anon/auth). Returns legacy subtotal (< cutoff), Direct Entry subtotal '
  '(>= cutoff), overlap blocker count (< cutoff eligible) and cutoff date.';

revoke all on function public.direct_entry_reporting_reconciliation_totals()
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- In-migration self-check (assertions; raises on any violation). Runs in the
-- same transaction as the create statements above so an aborted check rolls
-- back the whole migration.
-- -----------------------------------------------------------------------------
do $$
declare
  v_view_columns text[];
  v_helper text;
  v_check text;
  v_legacy_subtotal bigint;
  v_de_subtotal bigint;
  v_overlap_blocker bigint;
  v_cutoff date;
begin
  -- 1. View exists with the canonical ReportingFact columns.
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

  -- 2. View is revoked from anon / authenticated / public and granted to service_role only.
  if has_table_privilege('anon',        'public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_facts_v01 must not be SELECT-able by anon';
  end if;
  if has_table_privilege('authenticated','public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_facts_v01 must not be SELECT-able by authenticated';
  end if;
  if not has_table_privilege('service_role', 'public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'direct_entry_reporting_facts_v01 must be SELECT-able by service_role';
  end if;

  -- 3. Helpers are non-executable for anon / authenticated / public.
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
  end loop;

  -- 4. Cutoff date is locked to 2026-10-17.
  if (select public.direct_entry_reporting_cutoff()) <> '2026-10-17'::date then
    raise exception 'direct_entry_reporting_cutoff() must return 2026-10-17';
  end if;

  -- 5. Identity check on a freshly migrated empty DB.
  select legacy_subtotal, direct_entry_subtotal, overlap_blocker, cutoff_date
    into v_legacy_subtotal, v_de_subtotal, v_overlap_blocker, v_cutoff
    from public.direct_entry_reporting_reconciliation_totals();
  if v_legacy_subtotal <> 0 or v_de_subtotal <> 0 or v_overlap_blocker <> 0 then
    raise exception 'fresh DB must have all reconciliation totals = 0 (legacy=%, de=%, overlap=%)',
      v_legacy_subtotal, v_de_subtotal, v_overlap_blocker;
  end if;
  if v_cutoff <> '2026-10-17'::date then
    raise exception 'reconciliation_totals cutoff drift: %', v_cutoff;
  end if;

  raise notice 'P2-W04A migration #40 self-check OK (cutoff=%, legacy=%, de=%, overlap=%)',
    v_cutoff, v_legacy_subtotal, v_de_subtotal, v_overlap_blocker;
end
$$;