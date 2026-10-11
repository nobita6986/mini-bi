-- =============================================================================
-- P3.1-W02C - Dynamic Labor Type catalog backend (#79, append-only).
--
-- Scope: the canonical labor-type catalog, its Admin/Accounting administration
-- surface, the hard FK cutover on direct_entries.labor_type and the reporting
-- lookup that follows the catalog. The administration contract mirrors the W01B
-- personnel catalog (20261009040000_p3_1_w01b_personnel_catalog.sql) for
-- authority, revisions, idempotency, OCC and ACL posture; it deliberately does
-- NOT mirror the team-leader or team-membership topology.
--
-- Authority: exactly ONE reusable guard, direct_entry_assert_catalog_operator
-- (already on main), accepting either the legacy Full Admin bundle or the narrow
-- catalog_master_manage token, in both cases with an effective 'all' scope. The
-- guard runs BEFORE payload validation on every admin read and every mutation,
-- so a denied actor never learns the payload shape.
--
-- TEMPORARY / PERMANENT / OUTSOURCED are three SEED ROWS ONLY, never a closed
-- set: a fourth type is added through the RPCs with no code or migration change.
-- The key is operator-entered and canonical; display_name, sort_order and active
-- are editable through reason + expected version + idempotency + an immutable
-- revision + one audit event. labor_type_key and reporting_key are immutable and
-- there is no hard delete.
--
-- Storage integrity: direct_entries.labor_type becomes a real foreign key with
-- ON UPDATE RESTRICT / ON DELETE RESTRICT. The migration verifies that every
-- existing value resolves BEFORE the constraint is validated, so a legacy value
-- aborts the switch instead of being orphaned, and it backfills nothing. The FK
-- proves the key EXISTS; a separate write guard proves the key is ACTIVE for
-- every new write. Historical rows stay readable precisely because a catalog row
-- can never be deleted.
--
-- Active projection: direct_entry_labor_type_options() returns only key, display
-- name and sort order for active rows; the admin projection adds active, version
-- and reporting_key. They are consumed by the existing Direct Entry catalog
-- projection, so the runtime keeps receiving active options through
-- getInputCatalog and no parallel /api/direct-entry/labor-types route exists.
--
-- Reporting: direct_entry_reporting_employment_key becomes a catalog lookup of
-- reporting_key and the four duplicated display CASE sites collapse into one
-- display_name lookup. Stored keys and reporting_key never change, so existing
-- rows keep resolving; the unknown fallback stays fail-closed.
--
-- ACL posture: both new tables forced RLS and revoked from every role; internal
-- helpers SECURITY DEFINER with a fixed search_path and revoked from every role;
-- only the five administration RPCs are granted to service_role; no table grant.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. The canonical labor-type catalog.
-- -----------------------------------------------------------------------------
create table public.direct_entry_labor_types (
  labor_type_key text primary key,
  display_name text not null,
  reporting_key text not null,
  sort_order integer not null,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint direct_entry_labor_types_key_check
    check (labor_type_key ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  constraint direct_entry_labor_types_display_check
    check (display_name = btrim(display_name) and length(display_name) between 1 and 256),
  constraint direct_entry_labor_types_reporting_check
    check (reporting_key = btrim(reporting_key) and length(reporting_key) between 1 and 64),
  constraint direct_entry_labor_types_sort_check
    check (sort_order between 0 and 100000),
  constraint direct_entry_labor_types_version_check check (version >= 1),
  constraint direct_entry_labor_types_reporting_uidx unique (reporting_key)
);

create index direct_entry_labor_types_order_idx
  on public.direct_entry_labor_types (sort_order, labor_type_key);

comment on table public.direct_entry_labor_types is
  'P3.1-W02C canonical dynamic labor-type catalog. TEMPORARY/PERMANENT/OUTSOURCED are seed rows only; labor_type_key and reporting_key are immutable; display_name, sort_order and active are versioned through reason + OCC + revision + audit. There is no hard delete, so historical direct_entries rows always resolve.';
comment on column public.direct_entry_labor_types.reporting_key is
  'Immutable reporting dimension key owned by the catalog (TEMPORARY=thời vụ, PERMANENT=chính thức, OUTSOURCED=gia công). Generated server-side on create as lowercase ASCII of the canonical key; a client may never send or override it.';

-- Key and reporting_key are immutable; everything else is versioned.
create or replace function public.direct_entry_labor_types_immutable_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.labor_type_key is distinct from old.labor_type_key then
    raise exception 'labor type key is immutable' using errcode = '55000';
  end if;
  if new.reporting_key is distinct from old.reporting_key then
    raise exception 'labor type reporting key is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_labor_types_immutable_guard()
  from public, anon, authenticated, service_role;

create trigger direct_entry_labor_types_immutable
  before update on public.direct_entry_labor_types
  for each row execute function public.direct_entry_labor_types_immutable_guard();

alter table public.direct_entry_labor_types enable row level security;
alter table public.direct_entry_labor_types force row level security;
revoke all on table public.direct_entry_labor_types
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Append-only labor-type revision history.
-- -----------------------------------------------------------------------------
create table public.direct_entry_labor_type_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  labor_type_key text not null
    references public.direct_entry_labor_types(labor_type_key) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null
    references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (labor_type_key, version)
);

create index direct_entry_labor_type_revisions_key_idx
  on public.direct_entry_labor_type_revisions (labor_type_key, version desc);

create trigger direct_entry_labor_type_revisions_immutable
  before update or delete on public.direct_entry_labor_type_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.direct_entry_labor_type_revisions enable row level security;
alter table public.direct_entry_labor_type_revisions force row level security;
revoke all on table public.direct_entry_labor_type_revisions
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_labor_type_revisions is
  'P3.1-W02C append-only labor-type revision history (business fields + actor + reason + version), written only inside the service-role catalog RPCs. Never updated, never deleted, never backfilled.';

alter table public.direct_entry_audit_events
  add column labor_type_revision_id uuid
    references public.direct_entry_labor_type_revisions(revision_id) on delete restrict;

-- -----------------------------------------------------------------------------
-- 3. Internal helpers (active lookup, projections, lock/OCC, revision, bump).
-- -----------------------------------------------------------------------------
-- The single active-catalog lookup reused by every Direct Entry write path that
-- accepts a labor type. It is the replacement for the retired closed set.
create or replace function public.direct_entry_is_active_labor_type(p_labor_type text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.direct_entry_labor_types t
     where t.labor_type_key = p_labor_type
       and t.active
  )
$$;
revoke all on function public.direct_entry_is_active_labor_type(text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_is_active_labor_type(text) is
  'P3.1-W02C internal helper: true only when the key exists in the catalog AND is active. Replaces the retired TEMPORARY/PERMANENT closed set on every write path. Revoked from every role.';

-- Operational projection: active rows only, bounded to key + display + order.
create or replace function public.direct_entry_labor_type_options()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'labor_type_key', t.labor_type_key,
           'display_name', t.display_name,
           'sort_order', t.sort_order
         ) order by t.sort_order, t.labor_type_key), '[]'::jsonb)
    from public.direct_entry_labor_types t
   where t.active
$$;
revoke all on function public.direct_entry_labor_type_options()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_labor_type_options() is
  'P3.1-W02C internal active labor-type projection: key, display_name and sort_order for ACTIVE rows ordered by sort_order then key. Never exposes inactive rows, reporting_key or the revision payload. Revoked from every role; consumed by direct_entry_input_catalog.';

-- Fixed six-key business snapshot used by every revision.
create or replace function public.direct_entry_labor_type_snapshot(
  p_labor_type public.direct_entry_labor_types
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'labor_type_key', p_labor_type.labor_type_key,
    'display_name', p_labor_type.display_name,
    'reporting_key', p_labor_type.reporting_key,
    'sort_order', p_labor_type.sort_order,
    'active', p_labor_type.active,
    'version', p_labor_type.version
  )
$$;
revoke all on function public.direct_entry_labor_type_snapshot(public.direct_entry_labor_types)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_labor_type_snapshot(public.direct_entry_labor_types) is
  'P3.1-W02C internal fixed six-key labor-type snapshot for revision before/after. Revoked from every role.';

-- Admin projection: adds active, version, reporting_key and the revision count.
create or replace function public.direct_entry_labor_type_admin_projection(
  p_labor_type public.direct_entry_labor_types,
  p_revision_count integer
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'labor_type_key', p_labor_type.labor_type_key,
    'display_name', p_labor_type.display_name,
    'reporting_key', p_labor_type.reporting_key,
    'sort_order', p_labor_type.sort_order,
    'active', p_labor_type.active,
    'version', p_labor_type.version,
    'revision_count', coalesce(p_revision_count, 0)
  )
$$;
revoke all on function public.direct_entry_labor_type_admin_projection(public.direct_entry_labor_types, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_labor_type_admin_projection(public.direct_entry_labor_types, integer) is
  'P3.1-W02C internal admin projection of one labor type: key, display_name, reporting_key, sort_order, active, version, revision_count. Revoked from every role.';

-- Lock + OCC, mirroring direct_entry_lock_personnel.
create or replace function public.direct_entry_lock_labor_type(
  p_labor_type_key text,
  p_expected_version integer
)
returns public.direct_entry_labor_types
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_labor_type public.direct_entry_labor_types;
begin
  if p_labor_type_key is null or p_labor_type_key = '' then
    raise exception 'labor type required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected labor type version required' using errcode = '22023';
  end if;

  select t.* into v_labor_type
    from public.direct_entry_labor_types t
   where t.labor_type_key = p_labor_type_key
   for update;
  if not found then
    raise exception 'labor type not found' using errcode = 'P0002';
  end if;
  if v_labor_type.version <> p_expected_version then
    raise exception 'labor type version conflict' using errcode = '40001';
  end if;
  return v_labor_type;
end;
$$;
revoke all on function public.direct_entry_lock_labor_type(text, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_lock_labor_type(text, integer) is
  'P3.1-W02C internal guard: SELECT ... FOR UPDATE on the catalog row plus fail-closed expected-version check (40001 on mismatch, P0002 when absent). Revoked from every role.';

-- Append exactly one immutable revision at an explicit version. Used verbatim by
-- create (version 1, before null) and, through the bump helper below, by update
-- and set-active.
create or replace function public.direct_entry_write_labor_type_revision(
  p_labor_type_key text,
  p_version integer,
  p_actor_user_id uuid,
  p_reason_id uuid,
  p_before jsonb,
  p_after jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_revision_id uuid;
begin
  insert into public.direct_entry_labor_type_revisions
    (labor_type_key, version, actor_user_id, reason_id, before_snapshot, after_snapshot)
  values
    (p_labor_type_key, p_version, p_actor_user_id, p_reason_id, p_before, p_after)
  returning direct_entry_labor_type_revisions.revision_id into v_revision_id;
  return v_revision_id;
end;
$$;
revoke all on function public.direct_entry_write_labor_type_revision(text, integer, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_write_labor_type_revision(text, integer, uuid, uuid, jsonb, jsonb) is
  'P3.1-W02C internal helper: appends exactly one immutable labor-type revision carrying actor, reason and before/after snapshots at an explicit version. Revoked from every role.';

-- One transaction step for update/set-active: bump the row version, then append
-- the matching revision so the (key, version) sequence stays auditable.
create or replace function public.direct_entry_bump_labor_type_version(
  p_labor_type_key text,
  p_actor_user_id uuid,
  p_reason_id uuid,
  p_before jsonb,
  p_after jsonb
)
returns table (labor_type_version integer, revision_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_version integer;
  v_revision_id uuid;
begin
  update public.direct_entry_labor_types
     set version = version + 1,
         updated_at = now()
   where labor_type_key = p_labor_type_key
  returning direct_entry_labor_types.version into v_version;
  if v_version is null then
    raise exception 'labor type not found' using errcode = 'P0002';
  end if;

  -- Mirror the W01B personnel / W02-B vendor convention: the after-snapshot is
  -- stamped with the version the catalog row now carries, so a revision can
  -- never record a version the row does not have.
  v_revision_id := public.direct_entry_write_labor_type_revision(
    p_labor_type_key, v_version, p_actor_user_id, p_reason_id, p_before,
    jsonb_set(coalesce(p_after, '{}'::jsonb), '{version}', to_jsonb(v_version), true)
  );
  return query select v_version, v_revision_id;
end;
$$;
revoke all on function public.direct_entry_bump_labor_type_version(text, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_bump_labor_type_version(text, uuid, uuid, jsonb, jsonb) is
  'P3.1-W02C internal helper: increments the catalog row version and appends exactly one immutable revision carrying actor, reason and before/after snapshots. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 4. Seed rows, legacy verification and the hard FK cutover.
-- -----------------------------------------------------------------------------
insert into public.direct_entry_labor_types
  (labor_type_key, display_name, reporting_key, sort_order, active, version)
values
  ('TEMPORARY',  'Thời vụ',    'thời vụ',    10, true, 1),
  ('PERMANENT',  'Chính thức', 'chính thức', 20, true, 1),
  ('OUTSOURCED', 'Gia công',   'gia công',   30, true, 1);

-- Step (c): every existing direct_entries.labor_type must resolve to a catalog
-- row. A single unresolved legacy value aborts the whole migration and reports
-- the offending entry, so nothing is ever silently orphaned and nothing is
-- backfilled or guessed.
do $$
declare
  v_offending_entry uuid;
  v_offending_value text;
  v_offending_count integer;
begin
  select count(*)::int into v_offending_count
    from public.direct_entries e
   where not exists (
     select 1 from public.direct_entry_labor_types t
      where t.labor_type_key = e.labor_type
   );
  if v_offending_count > 0 then
    select e.entry_id, e.labor_type
      into v_offending_entry, v_offending_value
      from public.direct_entries e
     where not exists (
       select 1 from public.direct_entry_labor_types t
        where t.labor_type_key = e.labor_type
     )
     limit 1;
    raise exception
      'legacy labor_type % on direct entry % does not resolve to the catalog',
      v_offending_value, v_offending_entry
      using errcode = '55000';
  end if;
end;
$$;

-- Step (d): retire the closed-set CHECK. The constraint name is resolved from
-- the catalog so the drop is exact and replay-safe.
do $$
declare
  v_constraint text;
begin
  select c.conname into v_constraint
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'direct_entries'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%labor_type%'
     and pg_get_constraintdef(c.oid) like '%TEMPORARY%';
  if v_constraint is not null then
    execute format('alter table public.direct_entries drop constraint %I', v_constraint);
  end if;
end;
$$;

-- Step (e): the hard FK with restrict semantics on both update and delete.
alter table public.direct_entries
  add constraint direct_entries_labor_type_fkey
  foreign key (labor_type)
  references public.direct_entry_labor_types (labor_type_key)
  on update restrict
  on delete restrict;

comment on constraint direct_entries_labor_type_fkey on public.direct_entries is
  'P3.1-W02C hard labor-type FK. ON UPDATE/DELETE RESTRICT plus a catalog that can never be deleted is what keeps historical rows readable.';

-- The FK proves the key EXISTS; this guard proves the key is ACTIVE for every
-- NEW write. An update that does not actually change the value is untouched, so
-- a historical row whose key was later deactivated stays fully editable.
create or replace function public.direct_entry_labor_type_write_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' and new.labor_type is not distinct from old.labor_type then
    return new;
  end if;
  -- A NULL key is not this guard's concern. The pre-existing entry validation
  -- already rejects it and owns that message, so deferring keeps every
  -- rejection that existed before this migration observably unchanged.
  if new.labor_type is null then
    return new;
  end if;
  if not exists (
    select 1
      from public.direct_entry_labor_types t
     where t.labor_type_key = new.labor_type
       and t.active
  ) then
    raise exception 'labor type is not an active catalog key' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_labor_type_write_guard()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_labor_type_write_guard() is
  'P3.1-W02C active-write guard: rejects an unknown or inactive labor type on every new write (entry create, draft patch, full-profile batch, change-request apply, privileged patch). An update that leaves the value unchanged is not affected, so historical rows stay editable. Revoked from every role.';

create trigger direct_entry_labor_type_active_guard
  before insert or update of labor_type on public.direct_entries
  for each row execute function public.direct_entry_labor_type_write_guard();

-- -----------------------------------------------------------------------------
-- 6. Replace every PL/pgSQL closed set with the ACTIVE catalog lookup.
--
-- Three functions carry the only literal TEMPORARY/PERMANENT closed set left on
-- a write path: direct_entry_create_batch, direct_entry_create_draft_row and
-- direct_entry_create_full_profile_batch. They are deliberately NOT re-emitted.
-- Later migrations patch those same live bodies by source replacement (P1.7-H06
-- employee codes, W07B per-row project authority, W07C-R2 raw dates, W07C-R3
-- issue place, P2.5-HF status default), so a verbatim re-emission from the
-- original foundation source would silently revert every one of those patches.
--
-- Instead the live definition is patched in place with the same mechanism those
-- migrations already use: read pg_get_functiondef, require the exact expected
-- literal to appear exactly the expected number of times, and execute the
-- replaced definition. Source drift in any of the three bodies aborts the whole
-- migration with 55000 rather than dropping the guard silently. Replacing a
-- definition preserves its ownership, ACL and volatility, so no grant is
-- re-issued here.
--
-- The null guard preserves the original three-valued logic exactly: the retired
-- `v_labor_type not in (...)` is NULL-safe (a NULL key never raised there), so
-- the replacement keeps that shape and only widens which NON-NULL keys are
-- refused.
-- -----------------------------------------------------------------------------

create function public.direct_entry_w02c_replace_proc_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_definition text;
  v_count integer;
begin
  select pg_get_functiondef(p_signature) into v_definition;
  if v_definition is null or p_expected is null or p_expected = '' then
    raise exception 'labor type source missing' using errcode = '55000';
  end if;
  v_count := (length(v_definition) - length(replace(v_definition, p_expected, '')))
    / length(p_expected);
  if v_count <> p_expected_count then
    raise exception 'labor type source drift for %: expected %, found %',
      p_signature, p_expected_count, v_count using errcode = '55000';
  end if;
  execute replace(v_definition, p_expected, p_replacement);
end;
$$;
revoke all on function public.direct_entry_w02c_replace_proc_source(regprocedure, text, text, integer)
  from public, anon, authenticated, service_role;

select public.direct_entry_w02c_replace_proc_source(
  'public.direct_entry_create_batch(uuid,uuid,jsonb,text)'::regprocedure,
  'v_labor_type not in (''TEMPORARY'',''PERMANENT'')',
  '(v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type))',
  1
);

select public.direct_entry_w02c_replace_proc_source(
  'public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  'v_labor_type not in (''TEMPORARY'',''PERMANENT'')',
  '(v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type))',
  1
);

select public.direct_entry_w02c_replace_proc_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  'v_labor_type not in (''TEMPORARY'',''PERMANENT'')',
  '(v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type))',
  1
);

create function public.direct_entry_w02c_replace_view_source(
  p_view regclass,
  p_expected text,
  p_replacement text,
  p_expected_count integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_definition text;
  v_count integer;
  v_target text;
begin
  -- `p_view::text` renders unqualified whenever the view already sits on the
  -- search_path, and CREATE VIEW then targets the FIRST schema on the path
  -- (pg_catalog), leaving the real view untouched. Resolve the qualified name
  -- from the catalog instead so the patch always lands on the intended relation.
  select quote_ident(n.nspname) || '.' || quote_ident(c.relname) into v_target
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_view;
  if v_target is null then
    raise exception 'labor type view missing' using errcode = '55000';
  end if;
  select pg_get_viewdef(p_view) into v_definition;
  if v_definition is null or p_expected is null or p_expected = '' then
    raise exception 'labor type view source missing' using errcode = '55000';
  end if;
  v_count := (length(v_definition) - length(replace(v_definition, p_expected, '')))
    / length(p_expected);
  if v_count <> p_expected_count then
    raise exception 'labor type view source drift for %: expected %, found %',
      p_view, p_expected_count, v_count using errcode = '55000';
  end if;
  execute 'create or replace view ' || v_target || ' as '
    || replace(v_definition, p_expected, p_replacement);
end;
$$;
revoke all on function public.direct_entry_w02c_replace_view_source(regclass, text, text, integer)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Administration RPCs (service_role only).
-- -----------------------------------------------------------------------------
-- Every admin read and every mutation runs direct_entry_assert_catalog_operator
-- FIRST, so a denied actor gets 42501 before any payload validation and never
-- observes a page, a filter hint or a field name.
create or replace function public.direct_entry_list_labor_types_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_include_inactive boolean default true,
  p_page integer default 1,
  p_page_size integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 100);
  v_total integer;
  v_items jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(p_search) > 256 then
    raise exception 'invalid labor type search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if p_include_inactive is null then
    raise exception 'include inactive flag required' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  with filtered as (
    select t as row_data,
           (select count(*)::int
              from public.direct_entry_labor_type_revisions rv
             where rv.labor_type_key = t.labor_type_key) as revision_count
      from public.direct_entry_labor_types t
     where (p_include_inactive or t.active)
       and (v_search is null
            or t.labor_type_key ilike '%' || v_search || '%'
            or t.display_name ilike '%' || v_search || '%')
  )
  select
    (select count(*)::int from filtered),
    coalesce((
      select jsonb_agg(
               public.direct_entry_labor_type_admin_projection(f.row_data, f.revision_count)
               order by (f.row_data).sort_order, (f.row_data).labor_type_key
             )
        from (
          select * from filtered
           order by (row_data).sort_order, (row_data).labor_type_key
           offset (v_page - 1) * v_page_size
           limit v_page_size
        ) f
    ), '[]'::jsonb)
    into v_total, v_items;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', p_include_inactive,
    'search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'labor_types', v_items
  );
end;
$$;
revoke all on function public.direct_entry_list_labor_types_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_labor_types_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;
comment on function public.direct_entry_list_labor_types_admin(uuid, uuid, text, boolean, integer, integer) is
  'P3.1-W02C admin read: bounded labor-type page including inactive rows when asked, ordered by sort_order then key. Catalog operator + all scope required; service_role only.';

create or replace function public.direct_entry_get_labor_type_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_labor_type_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_row public.direct_entry_labor_types;
  v_revision_count integer;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_labor_type_key is null or p_labor_type_key = '' then
    raise exception 'labor type required' using errcode = '22023';
  end if;

  select t.* into v_row
    from public.direct_entry_labor_types t
   where t.labor_type_key = p_labor_type_key;
  if not found then
    raise exception 'labor type not found' using errcode = 'P0002';
  end if;

  select count(*)::int into v_revision_count
    from public.direct_entry_labor_type_revisions rv
   where rv.labor_type_key = p_labor_type_key;

  return public.direct_entry_labor_type_admin_projection(v_row, v_revision_count);
end;
$$;
revoke all on function public.direct_entry_get_labor_type_admin(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_labor_type_admin(uuid, uuid, text)
  to service_role;
comment on function public.direct_entry_get_labor_type_admin(uuid, uuid, text) is
  'P3.1-W02C admin read of exactly one labor type including inactive rows. Catalog operator + all scope required; service_role only.';

create or replace function public.direct_entry_create_labor_type(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_labor_type_key text,
  p_display_name text,
  p_sort_order integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_key text;
  v_display text;
  v_reporting text;
  v_sort integer;
  v_reason_id uuid;
  v_row public.direct_entry_labor_types;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  -- create opens a new aggregate: expected_version must be exactly 0.
  if p_expected_version is distinct from 0 then
    raise exception 'create expected version must be zero' using errcode = '22023';
  end if;
  if p_labor_type_key is null or p_labor_type_key = '' then
    raise exception 'labor type key required' using errcode = '22023';
  end if;
  v_key := p_labor_type_key;
  if v_key !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'labor type key is not canonical' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'labor type display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_sort_order is null or p_sort_order < 0 or p_sort_order > 100000 then
    raise exception 'labor type sort order is invalid' using errcode = '22023';
  end if;
  v_sort := p_sort_order;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'labor_type_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'labor_type_key', v_key,
      'display_name', v_display,
      'sort_order', v_sort
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if exists (
    select 1 from public.direct_entry_labor_types t where t.labor_type_key = v_key
  ) then
    raise exception 'labor type key already exists' using errcode = '23505';
  end if;

  -- reporting_key is generated SERVER-SIDE from the canonical key as lowercase
  -- ASCII (PROBATION -> probation) and is never accepted from a client.
  v_reporting := lower(v_key);
  if exists (
    select 1 from public.direct_entry_labor_types t where t.reporting_key = v_reporting
  ) then
    raise exception 'labor type reporting key already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.direct_entry_labor_types
    (labor_type_key, display_name, reporting_key, sort_order, active, version)
  values (v_key, v_display, v_reporting, v_sort, true, 1)
  returning * into v_row;

  v_revision_id := public.direct_entry_write_labor_type_revision(
    v_row.labor_type_key, v_row.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_labor_type_snapshot(v_row)
  );

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, labor_type_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'labor_type_create', v_authority,
     v_row.labor_type_key, 'all', 'APPLIED', v_reason_id,
     array['labor_type_key', 'display_name', 'sort_order', 'active'], v_revision_id);

  v_result := jsonb_build_object(
    'labor_type_key', v_row.labor_type_key,
    'display_name', v_row.display_name,
    'reporting_key', v_row.reporting_key,
    'sort_order', v_row.sort_order,
    'active', v_row.active,
    'version', v_row.version,
    'revision_id', v_revision_id,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'labor_type_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_create_labor_type(uuid, uuid, integer, text, text, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_labor_type(uuid, uuid, integer, text, text, integer, text, text)
  to service_role;
comment on function public.direct_entry_create_labor_type(uuid, uuid, integer, text, text, integer, text, text) is
  'P3.1-W02C mutation: creates exactly one catalog row with a server-generated reporting_key, one immutable revision (version 1, before null) and one audit event. expected_version must be 0 and reporting_key is never an input. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_update_labor_type(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_labor_type_key text,
  p_expected_version integer,
  p_display_name text,
  p_sort_order integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_display text;
  v_sort integer;
  v_reason_id uuid;
  v_before public.direct_entry_labor_types;
  v_after public.direct_entry_labor_types;
  v_version integer;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_labor_type_key is null or p_labor_type_key = '' then
    raise exception 'labor type required' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'labor type display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_sort_order is null or p_sort_order < 0 or p_sort_order > 100000 then
    raise exception 'labor type sort order is invalid' using errcode = '22023';
  end if;
  v_sort := p_sort_order;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'labor_type_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'labor_type_key', p_labor_type_key,
      'display_name', v_display,
      'sort_order', v_sort,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_labor_type(p_labor_type_key, p_expected_version);
  if v_before.display_name = v_display and v_before.sort_order = v_sort then
    raise exception 'labor type update is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Only display_name and sort_order are mutable here: the key and the
  -- reporting_key stay untouched and the active flag has its own RPC.
  update public.direct_entry_labor_types
     set display_name = v_display,
         sort_order = v_sort
   where labor_type_key = p_labor_type_key
  returning * into v_after;

  select b.labor_type_version, b.revision_id
    into v_version, v_revision_id
    from public.direct_entry_bump_labor_type_version(
      p_labor_type_key, p_app_user_id, v_reason_id,
      public.direct_entry_labor_type_snapshot(v_before),
      public.direct_entry_labor_type_snapshot(v_after)
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, labor_type_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'labor_type_update', v_authority,
     p_labor_type_key, 'all', 'APPLIED', v_reason_id,
     array['display_name', 'sort_order'], v_revision_id);

  v_result := jsonb_build_object(
    'labor_type_key', v_after.labor_type_key,
    'display_name', v_after.display_name,
    'reporting_key', v_after.reporting_key,
    'sort_order', v_after.sort_order,
    'active', v_after.active,
    'version', v_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'labor_type_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_update_labor_type(uuid, uuid, text, integer, text, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_labor_type(uuid, uuid, text, integer, text, integer, text, text)
  to service_role;
comment on function public.direct_entry_update_labor_type(uuid, uuid, text, integer, text, integer, text, text) is
  'P3.1-W02C mutation: updates display_name and sort_order under OCC with one immutable revision and one audit event. The key and the reporting_key are immutable and the active flag is owned by set-active. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_set_labor_type_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_labor_type_key text,
  p_active boolean,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authority text;
  v_reason_id uuid;
  v_before public.direct_entry_labor_types;
  v_after public.direct_entry_labor_types;
  v_version integer;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_labor_type_key is null or p_labor_type_key = '' then
    raise exception 'labor type required' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'labor type active flag required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'labor_type_set_active', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'labor_type_key', p_labor_type_key,
      'active', p_active,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_labor_type(p_labor_type_key, p_expected_version);
  if v_before.active = p_active then
    raise exception 'labor type active state is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Soft state only: deactivation never deletes the row, never rewrites
  -- reporting_key and never touches a stored direct_entries value, so every
  -- historical row keeps resolving and keeps rendering.
  update public.direct_entry_labor_types
     set active = p_active
   where labor_type_key = p_labor_type_key
  returning * into v_after;

  select b.labor_type_version, b.revision_id
    into v_version, v_revision_id
    from public.direct_entry_bump_labor_type_version(
      p_labor_type_key, p_app_user_id, v_reason_id,
      public.direct_entry_labor_type_snapshot(v_before),
      public.direct_entry_labor_type_snapshot(v_after)
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, labor_type_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'labor_type_set_active', v_authority,
     p_labor_type_key, 'all', 'APPLIED', v_reason_id,
     array['active'], v_revision_id);

  v_result := jsonb_build_object(
    'labor_type_key', v_after.labor_type_key,
    'display_name', v_after.display_name,
    'reporting_key', v_after.reporting_key,
    'sort_order', v_after.sort_order,
    'active', v_after.active,
    'version', v_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'labor_type_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_set_labor_type_active(uuid, uuid, text, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_set_labor_type_active(uuid, uuid, text, boolean, integer, text, text)
  to service_role;
comment on function public.direct_entry_set_labor_type_active(uuid, uuid, text, boolean, integer, text, text) is
  'P3.1-W02C mutation: activate/deactivate one labor type under OCC with one immutable revision and one audit event. Never hard-deletes, never rewrites reporting_key and never touches stored entry values. service_role only; catalog operator + all scope required.';

-- -----------------------------------------------------------------------------
-- 7. Reporting follows the catalog: one reporting_key lookup, one display lookup.
-- -----------------------------------------------------------------------------
-- The outsourced seed owns its own dimension key (gia công); TEMPORARY keeps
-- thời vụ and PERMANENT keeps chính thức, so existing rows keep resolving. A
-- key absent from the catalog keeps the fail-closed fallback.
create or replace function public.direct_entry_reporting_employment_key(p_labor_type text)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select t.reporting_key
       from public.direct_entry_labor_types t
      where t.labor_type_key = p_labor_type),
    '__unknown__'
  )
$$;

comment on function public.direct_entry_reporting_employment_key(text) is
  'P3.1-W02C: catalog lookup of reporting_key. TEMPORARY=thời vụ, PERMANENT=chính thức, OUTSOURCED=gia công; a key absent from the catalog stays "__unknown__".';

revoke all on function public.direct_entry_reporting_employment_key(text)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_employment_key(text) to service_role;

create or replace function public.direct_entry_reporting_employment_display(p_labor_type text)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select t.display_name
       from public.direct_entry_labor_types t
      where t.labor_type_key = p_labor_type),
    'Không xác định'
  )
$$;

comment on function public.direct_entry_reporting_employment_display(text) is
  'P3.1-W02C: single catalog display_name lookup that replaces the four duplicated label CASE sites. Renaming a display label changes what is shown today; the stored key and reporting_key never change.';

revoke all on function public.direct_entry_reporting_employment_display(text)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_employment_display(text) to service_role;


-- -----------------------------------------------------------------------------
-- 7b. The two reporting views lose their duplicated label map IN PLACE.
--
-- They are patched, never re-emitted: W04B, W04C, W05A, W07A-R3 and W07A-R4 all
-- redefined these views after the W04A cutover, so a verbatim re-emission from the
-- original cutover source would revert every one of those later redefinitions.
-- pg_get_viewdef is read, the duplicated CASE block must appear exactly the
-- expected number of times, and the patched definition is re-executed as
-- "create or replace view", which preserves the columns, owner and grants.
-- -----------------------------------------------------------------------------

select public.direct_entry_w02c_replace_view_source(
  'public.direct_entry_reporting_facts_v01'::regclass,
  E'        CASE e.labor_type
            WHEN ''TEMPORARY''::text THEN ''Thời vụ''::text
            WHEN ''PERMANENT''::text THEN ''Chính thức''::text
            ELSE ''Không xác định''::text
        END',
  E'        public.direct_entry_reporting_employment_display(e.labor_type)',
  1
);

select public.direct_entry_w02c_replace_view_source(
  'public.direct_entry_reporting_dimension_options_v01'::regclass,
  E'        CASE e.labor_type
            WHEN ''TEMPORARY''::text THEN ''Thời vụ''::text
            WHEN ''PERMANENT''::text THEN ''Chính thức''::text
            ELSE ''Không xác định''::text
        END',
  E'        public.direct_entry_reporting_employment_display(e.labor_type)',
  2
);
create or replace function public.direct_entry_reporting_de_options_scoped(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (
  dimension text,
  key text,
  display text,
  recruited_count integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  select 'project'::text,
         public.direct_entry_reporting_dim_key(p.display_name),
         p.display_name,
         count(*)::integer
    from public.direct_entries e
    join public.direct_entry_projects p
      on p.project_id = e.project_id
   where e.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
   group by public.direct_entry_reporting_dim_key(p.display_name), p.display_name;

  return query
  select 'recruiter'::text,
         public.direct_entry_reporting_recruiter_alias_key(
           e.recruiter_id, e.first_work_date
         ),
         r.display_name,
         count(*)::integer
    from public.direct_entries e
    join public.recruiters r
      on r.recruiter_id = e.recruiter_id
   where e.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
   group by public.direct_entry_reporting_recruiter_alias_key(
              e.recruiter_id, e.first_work_date
            ), r.display_name;

  return query
  select 'provider'::text,
         public.direct_entry_reporting_recruiter_provider_key(
           e.recruiter_id, e.first_work_date
         ),
         case e.provider_type
           when 'hrp'    then 'HRP'
           when 'vendor' then 'Vendor'
           else               'Không xác định'
         end,
         count(*)::integer
    from public.direct_entries e
   where e.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
   group by public.direct_entry_reporting_recruiter_provider_key(
              e.recruiter_id, e.first_work_date
            ),
            case e.provider_type
              when 'hrp'    then 'HRP'
              when 'vendor' then 'Vendor'
              else               'Không xác định'
            end;

  return query
  select 'employment'::text,
         public.direct_entry_reporting_employment_key(e.labor_type),
         public.direct_entry_reporting_employment_display(e.labor_type),
         count(*)::integer
    from public.direct_entries e
   where e.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
   group by public.direct_entry_reporting_employment_key(e.labor_type),
            public.direct_entry_reporting_employment_display(e.labor_type);
end;
$$;
revoke all on function public.direct_entry_reporting_de_options_scoped(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_de_options_scoped(uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 7d. The canonical Direct Entry projection gains the active labor types.
--
-- The object is built by direct_entry_input_catalog_unscoped_v42 (W07B), which
-- direct_entry_input_catalog wraps with the per-actor project filter. The wrapper
-- is left untouched so that scope enforcement stays exactly as W07B wrote it, and
-- the builder is patched in place to append the bounded active options. The
-- runtime therefore keeps receiving its labor types through getInputCatalog, and
-- no /api/direct-entry/labor-types route exists.
-- -----------------------------------------------------------------------------

select public.direct_entry_w02c_replace_proc_source(
  'public.direct_entry_input_catalog_unscoped_v42(uuid,uuid,date)'::regprocedure,
  E'    ''effective_date'', p_effective_date,',
  E'    ''effective_date'', p_effective_date,
    ''labor_types'', public.direct_entry_labor_type_options(),',
  1
);
-- -----------------------------------------------------------------------------
-- 7e. Drop both source-patching helpers: they exist only inside this migration,
-- are revoked from every role, and must not survive it.
-- -----------------------------------------------------------------------------

drop function public.direct_entry_w02c_replace_proc_source(regprocedure, text, text, integer);
drop function public.direct_entry_w02c_replace_view_source(regclass, text, text, integer);

-- -----------------------------------------------------------------------------
-- 8. Self-check: seeds, immutability, FK, active guard, reporting and ACL.
-- -----------------------------------------------------------------------------
do $$
declare
  v_rpcs text[] := array[
    'public.direct_entry_list_labor_types_admin(uuid,uuid,text,boolean,integer,integer)',
    'public.direct_entry_get_labor_type_admin(uuid,uuid,text)',
    'public.direct_entry_create_labor_type(uuid,uuid,integer,text,text,integer,text,text)',
    'public.direct_entry_update_labor_type(uuid,uuid,text,integer,text,integer,text,text)',
    'public.direct_entry_set_labor_type_active(uuid,uuid,text,boolean,integer,text,text)'
  ];
  v_helpers text[] := array[
    'public.direct_entry_labor_types_immutable_guard()',
    'public.direct_entry_is_active_labor_type(text)',
    'public.direct_entry_labor_type_options()',
    'public.direct_entry_labor_type_snapshot(public.direct_entry_labor_types)',
    'public.direct_entry_labor_type_admin_projection(public.direct_entry_labor_types,integer)',
    'public.direct_entry_lock_labor_type(text,integer)',
    'public.direct_entry_write_labor_type_revision(text,integer,uuid,uuid,jsonb,jsonb)',
    'public.direct_entry_bump_labor_type_version(text,uuid,uuid,jsonb,jsonb)',
    'public.direct_entry_labor_type_write_guard()'
  ];
  v_name text;
  v_definition text;
  v_count integer;
  v_seed integer;
begin
  foreach v_name in array v_rpcs loop
    if not has_function_privilege('service_role', v_name, 'EXECUTE') then
      raise exception 'service_role execute missing for %', v_name using errcode = '55000';
    end if;
    if has_function_privilege('anon', v_name, 'EXECUTE')
       or has_function_privilege('authenticated', v_name, 'EXECUTE') then
      raise exception 'browser role can execute %', v_name using errcode = '55000';
    end if;
  end loop;

  foreach v_name in array v_helpers loop
    if has_function_privilege('anon', v_name, 'EXECUTE')
       or has_function_privilege('authenticated', v_name, 'EXECUTE')
       or has_function_privilege('service_role', v_name, 'EXECUTE') then
      raise exception 'internal helper is executable: %', v_name using errcode = '55000';
    end if;
  end loop;

  -- Exactly the three seed rows, with the three locked reporting keys.
  select count(*)::int into v_seed from public.direct_entry_labor_types;
  if v_seed <> 3 then
    raise exception 'labor type catalog must start with exactly three seed rows' using errcode = '55000';
  end if;
  select count(*)::int into v_seed
    from public.direct_entry_labor_types t
   where (t.labor_type_key, t.reporting_key) in (
     ('TEMPORARY', 'thời vụ'), ('PERMANENT', 'chính thức'), ('OUTSOURCED', 'gia công')
   )
     and t.active
     and t.version = 1;
  if v_seed <> 3 then
    raise exception 'labor type seeds are wrong' using errcode = '55000';
  end if;

  -- Exactly one catalog guard and no parallel one.
  select count(*)::int into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'direct_entry_assert_catalog_operator';
  if v_count <> 1 then
    raise exception 'the single catalog operator guard is missing' using errcode = '55000';
  end if;

  -- The retired closed set is gone and the hard FK took its place.
  select count(*)::int into v_count
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'direct_entries' and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%labor_type%'
     and pg_get_constraintdef(c.oid) like '%TEMPORARY%';
  if v_count <> 0 then
    raise exception 'the closed-set labor_type CHECK still exists' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'direct_entries' and c.contype = 'f'
     and c.conname = 'direct_entries_labor_type_fkey'
     and pg_get_constraintdef(c.oid) like '%direct_entry_labor_types%'
     and pg_get_constraintdef(c.oid) like '%ON UPDATE RESTRICT%'
     and pg_get_constraintdef(c.oid) like '%ON DELETE RESTRICT%'
     and c.convalidated;
  if v_count <> 1 then
    raise exception 'the validated restrictive labor_type FK is missing' using errcode = '55000';
  end if;

  -- Immutability trigger on the catalog row plus the active-write guard.
  select count(*)::int into v_count
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'direct_entry_labor_types'
     and tg.tgname = 'direct_entry_labor_types_immutable' and not tg.tgisinternal;
  if v_count <> 1 then
    raise exception 'labor type immutability trigger missing' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'direct_entries'
     and tg.tgname = 'direct_entry_labor_type_active_guard' and not tg.tgisinternal;
  if v_count <> 1 then
    raise exception 'labor type active-write guard trigger missing' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'direct_entry_labor_type_revisions'
     and tg.tgname = 'direct_entry_labor_type_revisions_immutable' and not tg.tgisinternal;
  if v_count <> 1 then
    raise exception 'labor type revisions immutability trigger missing' using errcode = '55000';
  end if;

  -- Both new tables are forced-RLS and grant nothing to any role.
  select count(*)::int into v_count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('direct_entry_labor_types', 'direct_entry_labor_type_revisions')
     and c.relrowsecurity and c.relforcerowsecurity;
  if v_count <> 2 then
    raise exception 'labor type tables must enable and force RLS' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join lateral aclexplode(c.relacl) a on true
   where n.nspname = 'public'
     and c.relname in ('direct_entry_labor_types', 'direct_entry_labor_type_revisions')
     and (c.relacl is null or (a.grantee <> c.relowner and a.privilege_type is not null));
  if v_count <> 0 then
    raise exception 'a labor type table is granted to a role' using errcode = '55000';
  end if;

  -- Bounded projections: three operational keys, six snapshot keys, seven admin keys.
  select pg_get_functiondef('public.direct_entry_labor_type_options()'::regprocedure)
    into v_definition;
  if v_definition not like '%labor_type_key%' or v_definition not like '%display_name%'
     or v_definition not like '%sort_order%' or v_definition like '%reporting_key%'
     or v_definition like '%auth_subject%' then
    raise exception 'labor type options projection is not bounded' using errcode = '55000';
  end if;

  -- Reporting follows the catalog: no duplicated label CASE remains anywhere.
  select pg_get_functiondef('public.direct_entry_reporting_employment_key(text)'::regprocedure)
    into v_definition;
  if v_definition not like '%direct_entry_labor_types%'
     or v_definition not like '%reporting_key%' then
    raise exception 'reporting employment key does not read the catalog' using errcode = '55000';
  end if;

  select coalesce(pg_get_viewdef('public.direct_entry_reporting_facts_v01'::regclass), '')
    into v_definition;
  if v_definition like '%Thời vụ%' or v_definition like '%Chính thức%'
     or v_definition like '%TEMPORARY%' then
    raise exception 'facts_v01 still duplicates the labor-type label CASE' using errcode = '55000';
  end if;

  select coalesce(pg_get_viewdef('public.direct_entry_reporting_dimension_options_v01'::regclass), '')
    into v_definition;
  if v_definition like '%Thời vụ%' or v_definition like '%Chính thức%'
     or v_definition like '%TEMPORARY%' then
    raise exception 'dimension options still duplicate the labor-type label CASE' using errcode = '55000';
  end if;

  select pg_get_functiondef('public.direct_entry_reporting_de_options_scoped(uuid,uuid)'::regprocedure)
    into v_definition;
  if v_definition like '%Thời vụ%' or v_definition like '%Chính thức%'
     or v_definition like '%TEMPORARY%' then
    raise exception 'scoped options still duplicate the labor-type label CASE' using errcode = '55000';
  end if;

  -- The Direct Entry runtime keeps receiving active options through the existing
  -- canonical catalog projection - no parallel route and no second label map.
  -- The wrapper is deliberately untouched, so the assertion follows the BUILDER
  -- that direct_entry_input_catalog wraps with the per-actor project filter.
  select pg_get_functiondef(
      'public.direct_entry_input_catalog_unscoped_v42(uuid,uuid,date)'::regprocedure)
    into v_definition;
  if v_definition not like '%labor_types%'
     or v_definition not like '%direct_entry_labor_type_options%' then
    raise exception 'input catalog does not expose the active labor types' using errcode = '55000';
  end if;

  -- No direct_entry function may carry the retired closed set or a duplicated
  -- label literal any more: every write path resolves the catalog and every
  -- display resolves display_name. This is the invariant that stops a later edit
  -- from quietly reintroducing a second vocabulary.
  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'direct_entry_%'
     and (p.prosrc like '%TEMPORARY%' or p.prosrc like '%PERMANENT%'
          or p.prosrc like '%Thời vụ%' or p.prosrc like '%Chính thức%');
  if v_count <> 0 then
    raise exception 'a direct_entry function still carries the retired closed set or label'
      using errcode = '55000';
  end if;
end;
$$;

commit;
