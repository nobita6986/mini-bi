-- =============================================================================
-- P3.1-W02-B - Vendor catalog lifecycle backend (#75, append-only).
--
-- Scope: Vendor master administration ONLY - list/get/create/update/set-active
-- over the existing canonical public.vendors table. Personnel, teams, team
-- membership, team leader, team scope, project operations, labor types,
-- accounts/grants/links and UI are out of scope and are not touched here.
--
-- Authority reuses the single guard introduced by #68,
-- public.direct_entry_assert_catalog_operator: the legacy Full Admin triple
-- (entry_admin + recruiter_master_manage + team_master_manage) OR
-- catalog_master_manage, both with an effective 'all' scope. No second catalog
-- guard exists, and the guard returns the authority actually used so audit never
-- mislabels an operator as entry_admin. A team_manager_assign/team leader actor
-- never reaches these RPCs.
--
-- Create is ONE transaction that produces the canonical Vendor aggregate:
--   1. exactly one public.vendors row (vendor_id is a canonical immutable text
--      business key, matching the #41 check shape);
--   2. exactly one public.recruiters row: the Vendor Direct Entry representation;
--   3. exactly one public.recruiter_provider_memberships row with
--      provider_type = 'vendor' and vendor_id set to the new Vendor, valid_from
--      exactly as supplied by the operator (never coalesced);
--   4. one immutable vendor revision and one audit event.
-- It never creates a recruiter_team_memberships row, a team, a team scope, an
-- app user, a capability grant or a scope grant, and it never writes the
-- reserved __system_vendor__ team.
--
-- Reserved system Vendor: the reserved, non-business team whose code is
-- '__system_vendor__' (created by #65 and used as the compatibility team for
-- Vendor Direct Entry rows) is not part of this catalog. No vendor_id in that
-- namespace can be created here, no read path resolves a team UUID, and no
-- helper of this migration calls direct_entry_system_vendor_team_id().
--
-- Deactivation handles its dependency safely and fails closed: the Vendor row is
-- soft-deactivated AND the Vendor's canonical Direct Entry representation
-- recruiter(s) - the recruiters whose ONLY provider membership is this Vendor's
-- vendor membership - are deactivated in the same transaction, so new Direct
-- Entry writes for a deactivated Vendor are rejected by the existing
-- public.direct_entry_validate_new_entry() trigger ('recruiter is not active',
-- 23514) and disappear from direct_entry_input_catalog. Nothing is deleted, the
-- provider membership interval and every historical Direct Entry fact stay
-- resolvable, and reactivation restores exactly the same representation rows.
--
-- Every mutation is one transaction with an explicit bounded reason, an expected
-- version (create: 0), an idempotency key, an immutable vendor revision whose
-- snapshot has one fixed four-key shape, and one audit event bound to the
-- revision it produced. Any failure leaves zero residue.
--
-- ACL posture: the revision table is force-RLS and revoked from every role;
-- internal helpers are SECURITY DEFINER with a fixed search_path and revoked from
-- every role; only the five administration RPCs are granted to service_role.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Append-only vendor revision history.
-- -----------------------------------------------------------------------------
create table public.direct_entry_vendor_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  vendor_id text not null references public.vendors(vendor_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (vendor_id, version)
);

create index direct_entry_vendor_revisions_vendor_idx
  on public.direct_entry_vendor_revisions (vendor_id, version desc);

create trigger direct_entry_vendor_revisions_immutable
  before update or delete on public.direct_entry_vendor_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.direct_entry_vendor_revisions enable row level security;
alter table public.direct_entry_vendor_revisions force row level security;
revoke all on table public.direct_entry_vendor_revisions
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_vendor_revisions is
  'P3.1-W02-B append-only vendor revision history (vendor_id, display_name, active, version + actor + reason), written only inside the service-role vendor RPCs. Never updated, never deleted, never backfilled.';
comment on column public.direct_entry_vendor_revisions.version is
  'The public.vendors.version produced by this mutation. unique (vendor_id, version) makes the vendor version sequence auditable.';

alter table public.direct_entry_audit_events
  add column vendor_revision_id uuid
    references public.direct_entry_vendor_revisions(revision_id) on delete restrict;

-- -----------------------------------------------------------------------------
-- 2. Internal helpers: fixed snapshot, canonical representation resolver,
--    admin projection, lock/OCC, revision writer and version bump.
-- -----------------------------------------------------------------------------
-- One FIXED revision schema: exactly these four keys, for every action, so
-- create/update/set-active revisions are comparable key-by-key. The canonical
-- representation recruiter_id is deliberately NOT part of the revision: this
-- history records the Vendor business row only.
create or replace function public.direct_entry_vendor_snapshot(
  p_vendor public.vendors
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'vendor_id', p_vendor.vendor_id,
    'display_name', p_vendor.display_name,
    'active', p_vendor.active,
    'version', p_vendor.version
  )
$$;
revoke all on function public.direct_entry_vendor_snapshot(public.vendors)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_vendor_snapshot(public.vendors) is
  'P3.1-W02-B internal projection of one vendor row: exactly vendor_id, display_name, active and version. No recruiter, membership, team, scope, capability, account, email or raw reason. Revoked from every role.';

-- The canonical Direct Entry representation of a Vendor: a recruiter whose ONLY
-- provider membership is a vendor membership pointing at this vendor and in force
-- today. Membership count is read from the DB, never assumed, and the result is
-- deterministic (created_at, recruiter_id). Returns NULL when the vendor has no
-- canonical representation (legacy operator-imported rows may have none).
create or replace function public.direct_entry_vendor_representation_recruiter(
  p_vendor_id text
)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.recruiter_id
    from public.recruiters r
    join public.recruiter_provider_memberships m
      on m.recruiter_id = r.recruiter_id
   where m.provider_type = 'vendor'
     and m.vendor_id = p_vendor_id
     and m.valid_from <= public.direct_entry_authorization_date()
     and (m.valid_to is null
          or public.direct_entry_authorization_date() < m.valid_to)
     and (
       select count(*)
         from public.recruiter_provider_memberships x
        where x.recruiter_id = r.recruiter_id
     ) = 1
   order by r.created_at, r.recruiter_id
   limit 1
$$;
revoke all on function public.direct_entry_vendor_representation_recruiter(text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_vendor_representation_recruiter(text) is
  'P3.1-W02-B internal read: the canonical Vendor Direct Entry representation recruiter (its only provider membership is this vendor membership, in force today), or NULL. Deterministic and DB-derived; never a hard-coded UUID. Revoked from every role.';

-- Shared admin projection used by the list and the detail read so the two can
-- never drift. Contract business fields plus the canonical representation
-- recruiter id.
create or replace function public.direct_entry_vendor_admin_projection(
  p_vendor public.vendors,
  p_revision_count integer,
  p_recruiter_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'vendor_id', p_vendor.vendor_id,
    'display_name', p_vendor.display_name,
    'active', p_vendor.active,
    'version', p_vendor.version,
    'revision_count', coalesce(p_revision_count, 0),
    'recruiter_id', p_recruiter_id
  )
$$;
revoke all on function public.direct_entry_vendor_admin_projection(public.vendors, integer, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_vendor_admin_projection(public.vendors, integer, uuid) is
  'P3.1-W02-B internal shared admin projection: the contract business fields (vendor_id, display_name, active, version) plus revision_count and the canonical representation recruiter_id, so the list and the detail read can never drift. Revoked from every role.';
-- Row lock + fail-closed OCC on the vendor. The reserved system namespace is not
-- a business vendor and is therefore never lockable.
create or replace function public.direct_entry_lock_vendor(
  p_vendor_id text,
  p_expected_version integer
)
returns public.vendors
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_vendor public.vendors;
begin
  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected vendor version required' using errcode = '22023';
  end if;

  select v.* into v_vendor
    from public.vendors v
   where v.vendor_id = p_vendor_id
     and v.vendor_id <> '__system_vendor__'
   for update;
  if not found then
    raise exception 'vendor not found' using errcode = 'P0002';
  end if;
  if v_vendor.version <> p_expected_version then
    raise exception 'vendor version conflict' using errcode = '40001';
  end if;
  return v_vendor;
end;
$$;
revoke all on function public.direct_entry_lock_vendor(text, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_lock_vendor(text, integer) is
  'P3.1-W02-B internal guard: SELECT ... FOR UPDATE on the vendor row plus fail-closed expected-version check (40001 on mismatch, P0002 when absent or reserved). Revoked from every role.';

create or replace function public.direct_entry_write_vendor_revision(
  p_vendor_id text,
  p_version integer,
  p_actor_user_id uuid,
  p_reason_id uuid,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_revision_id uuid;
begin
  insert into public.direct_entry_vendor_revisions (
    vendor_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_vendor_id, p_version, p_actor_user_id, p_reason_id,
    p_before_snapshot, p_after_snapshot
  ) returning revision_id into v_revision_id;
  return v_revision_id;
end;
$$;
revoke all on function public.direct_entry_write_vendor_revision(text, integer, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_write_vendor_revision(text, integer, uuid, uuid, jsonb, jsonb) is
  'P3.1-W02-B internal: appends one immutable vendor revision bound to the actor, the restricted reason and the version it produced. Revoked from every role.';

create or replace function public.direct_entry_bump_vendor_version(
  p_vendor_id text,
  p_actor_user_id uuid,
  p_reason_id uuid,
  p_before_snapshot jsonb
)
returns table (vendor_version integer, revision_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_vendor public.vendors;
begin
  update public.vendors
     set version = version + 1
   where vendor_id = p_vendor_id
  returning * into v_vendor;
  if v_vendor.vendor_id is null then
    raise exception 'vendor not found' using errcode = 'P0002';
  end if;
  -- The after snapshot is derived from the bumped row itself, so a revision can
  -- never record a version the vendor row does not carry.
  vendor_version := v_vendor.version;
  revision_id := public.direct_entry_write_vendor_revision(
    p_vendor_id, v_vendor.version, p_actor_user_id, p_reason_id,
    p_before_snapshot, public.direct_entry_vendor_snapshot(v_vendor)
  );
  return next;
end;
$$;
revoke all on function public.direct_entry_bump_vendor_version(text, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_bump_vendor_version(text, uuid, uuid, jsonb) is
  'P3.1-W02-B internal: bumps public.vendors.version by exactly one, snapshots the bumped row and appends the revision bound to it, inside the caller transaction. The vendor_id is never written. Revoked from every role.';
-- -----------------------------------------------------------------------------
-- 3. Administration RPCs (service_role only).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_list_vendors_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_include_inactive boolean default true,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_search text;
  v_include_inactive boolean := coalesce(p_include_inactive, true);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_vendors jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid vendor search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  -- The reserved system namespace is never a business vendor and is never
  -- counted or listed. Bounded search (max 256 characters), hard page bound and a
  -- deterministic order (display_name, vendor_id).
  select count(*)::int into v_total
    from public.vendors v
   where v.vendor_id <> '__system_vendor__'
     and (v_include_inactive or v.active)
     and (
       v_search is null
       or v.display_name ilike '%' || v_search || '%'
       or v.vendor_id ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(t.projection order by t.display_name, t.vendor_id), '[]'::jsonb)
    into v_vendors
    from (
      select public.direct_entry_vendor_admin_projection(
               v, rev.revision_count,
               public.direct_entry_vendor_representation_recruiter(v.vendor_id)
             ) as projection,
             v.display_name,
             v.vendor_id
        from public.vendors v
        left join lateral (
          select count(*)::int as revision_count
            from public.direct_entry_vendor_revisions r
           where r.vendor_id = v.vendor_id
        ) rev on true
       where v.vendor_id <> '__system_vendor__'
         and (v_include_inactive or v.active)
         and (
           v_search is null
           or v.display_name ilike '%' || v_search || '%'
           or v.vendor_id ilike '%' || v_search || '%'
         )
       order by v.display_name, v.vendor_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) t;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'vendors', v_vendors
  );
end;
$$;
revoke all on function public.direct_entry_list_vendors_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_vendors_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;
comment on function public.direct_entry_list_vendors_admin(uuid, uuid, text, boolean, integer, integer) is
  'P3.1-W02-B admin read: bounded, deterministically ordered Vendor catalog (search by display_name / vendor_id, active filter, page + page_size bounded 1..1000 / 1..100, total count) with the reserved system namespace excluded. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_get_vendor_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_vendor jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;

  select public.direct_entry_vendor_admin_projection(
           v, rev.revision_count,
           public.direct_entry_vendor_representation_recruiter(v.vendor_id)
         )
    into v_vendor
    from public.vendors v
    left join lateral (
      select count(*)::int as revision_count
        from public.direct_entry_vendor_revisions r
       where r.vendor_id = v.vendor_id
    ) rev on true
   where v.vendor_id = p_vendor_id
     and v.vendor_id <> '__system_vendor__';

  if v_vendor is null then
    raise exception 'vendor not found' using errcode = 'P0002';
  end if;
  return v_vendor;
end;
$$;
revoke all on function public.direct_entry_get_vendor_admin(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_vendor_admin(uuid, uuid, text)
  to service_role;
comment on function public.direct_entry_get_vendor_admin(uuid, uuid, text) is
  'P3.1-W02-B admin read: one Vendor detail (contract fields + revision_count + canonical representation recruiter_id) with the reserved system namespace excluded. service_role only; catalog operator with all scope required.';
create or replace function public.direct_entry_create_vendor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_vendor_id text,
  p_display_name text,
  p_valid_from date,
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
  v_vendor_id text;
  v_display text;
  v_reason_id uuid;
  v_vendor public.vendors;
  v_recruiter_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  -- Authorization first: an actor without catalog authority always gets 42501 and
  -- learns nothing about the shape of the input.
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  -- create opens a new aggregate: expected_version must be exactly 0.
  if p_expected_version is distinct from 0 then
    raise exception 'create expected version must be zero' using errcode = '22023';
  end if;
  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;
  v_vendor_id := btrim(p_vendor_id);
  -- The reserved system namespace is not a business vendor. It is rejected before
  -- the shape check so the boundary is explicit and not an accident of the #41
  -- check constraint (which rejects a leading underscore anyway).
  if v_vendor_id = '__system_vendor__' then
    raise exception 'vendor id is reserved' using errcode = '22023';
  end if;
  -- The canonical Vendor business key mirrors the public.vendors check exactly,
  -- so a malformed key is a bounded 22023 instead of a raw 23514.
  if length(v_vendor_id) > 128
     or v_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'vendor id is not canonical' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'vendor display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  -- The representation membership interval is explicit and is never coalesced to
  -- the authorization date.
  if p_valid_from is null then
    raise exception 'vendor valid from required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'vendor_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'vendor_id', v_vendor_id,
      'display_name', v_display,
      'valid_from', p_valid_from
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if exists (select 1 from public.vendors v where v.vendor_id = v_vendor_id) then
    raise exception 'vendor already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.vendors (vendor_id, display_name, active, version)
  values (v_vendor_id, v_display, true, 1)
  returning * into v_vendor;

  -- The canonical Vendor Direct Entry representation: exactly one recruiter row...
  insert into public.recruiters (display_name, active, version)
  values (v_display, true, 1)
  returning recruiter_id into v_recruiter_id;

  -- ...plus exactly one provider membership of provider_type 'vendor' that points
  -- at the new vendor. No team membership, no team and no scope is created.
  insert into public.recruiter_provider_memberships
    (recruiter_id, provider_type, vendor_id, valid_from)
  values
    (v_recruiter_id, 'vendor', v_vendor.vendor_id, p_valid_from);

  v_revision_id := public.direct_entry_write_vendor_revision(
    v_vendor.vendor_id, v_vendor.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_vendor_snapshot(v_vendor)
  );

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, vendor_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'vendor_create', v_authority,
     v_vendor.vendor_id, 'all', 'APPLIED', v_reason_id,
     array['vendor_id', 'display_name', 'active'], v_revision_id);

  v_result := jsonb_build_object(
    'vendor_id', v_vendor.vendor_id,
    'display_name', v_vendor.display_name,
    'active', v_vendor.active,
    'version', v_vendor.version,
    'revision_id', v_revision_id,
    'recruiter_id', v_recruiter_id,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'vendor_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_create_vendor(uuid, uuid, integer, text, text, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_vendor(uuid, uuid, integer, text, text, date, text, text)
  to service_role;
comment on function public.direct_entry_create_vendor(uuid, uuid, integer, text, text, date, text, text) is
  'P3.1-W02-B admin write: one atomic canonical Vendor create - one vendors row, one representation recruiter, one vendor provider membership with the operator supplied valid_from, one immutable revision and one audit event, and never a team, team membership, scope, capability, account or link. expected_version must be 0. service_role only; catalog operator with all scope, a bounded reason and an idempotency key are required.';
create or replace function public.direct_entry_update_vendor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_expected_version integer,
  p_display_name text,
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
  v_reason_id uuid;
  v_before public.vendors;
  v_after public.vendors;
  v_vendor_version integer;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'vendor display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'vendor_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'vendor_id', btrim(p_vendor_id),
      'expected_version', p_expected_version,
      'display_name', v_display
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_vendor(btrim(p_vendor_id), p_expected_version);
  if v_before.display_name = v_display then
    raise exception 'vendor display name is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- display_name only: vendor_id is an immutable identity/FK and active has its
  -- own mutation, so neither is writable through this RPC.
  update public.vendors
     set display_name = v_display
   where vendor_id = v_before.vendor_id
  returning * into v_after;

  select b.vendor_version, b.revision_id
    into v_vendor_version, v_revision_id
    from public.direct_entry_bump_vendor_version(
      v_after.vendor_id, p_app_user_id, v_reason_id,
      public.direct_entry_vendor_snapshot(v_before)
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, vendor_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'vendor_update', v_authority,
     v_after.vendor_id, 'all', 'APPLIED', v_reason_id,
     array['display_name'], v_revision_id);

  v_result := jsonb_build_object(
    'vendor_id', v_after.vendor_id,
    'display_name', v_after.display_name,
    'active', v_after.active,
    'version', v_vendor_version,
    'revision_id', v_revision_id,
    'recruiter_id', public.direct_entry_vendor_representation_recruiter(v_after.vendor_id)
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'vendor_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_update_vendor(uuid, uuid, text, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_vendor(uuid, uuid, text, integer, text, text, text)
  to service_role;
comment on function public.direct_entry_update_vendor(uuid, uuid, text, integer, text, text, text) is
  'P3.1-W02-B admin write: display_name only Vendor update under optimistic concurrency; vendor_id is immutable and active has its own mutation. One immutable revision and one audit event per applied change. service_role only; catalog operator with all scope, a bounded reason and an idempotency key are required.';
create or replace function public.direct_entry_set_vendor_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
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
  v_before public.vendors;
  v_after public.vendors;
  v_vendor_version integer;
  v_revision_id uuid;
  v_recruiters integer := 0;
  v_changed text[];
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'vendor active flag required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'vendor_set_active', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'vendor_id', btrim(p_vendor_id),
      'active', p_active,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_vendor(btrim(p_vendor_id), p_expected_version);
  if v_before.active = p_active then
    raise exception 'vendor active state is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Soft state only on the canonical Vendor row: it is never deleted and its
  -- provider membership history is never rewritten.
  update public.vendors
     set active = p_active
   where vendor_id = v_before.vendor_id
  returning * into v_after;

  -- Dependency handling, fail closed: the Vendor's canonical Direct Entry
  -- representation recruiter(s) - the recruiters whose ONLY provider membership is
  -- this Vendor's vendor membership - follow the Vendor state in the same
  -- transaction. A deactivated Vendor therefore cannot be used for a new Direct
  -- Entry row (public.direct_entry_validate_new_entry raises 23514 'recruiter is
  -- not active' and direct_entry_input_catalog stops offering it), while every
  -- stored fact, membership interval and revision stays intact and resolvable.
  update public.recruiters r
     set active = p_active,
         version = r.version + 1
   where r.active <> p_active
     and r.recruiter_id in (
       select m.recruiter_id
         from public.recruiter_provider_memberships m
        where m.provider_type = 'vendor'
          and m.vendor_id = v_before.vendor_id
          and m.valid_from <= public.direct_entry_authorization_date()
          and (m.valid_to is null
               or public.direct_entry_authorization_date() < m.valid_to)
          and (
            select count(*)
              from public.recruiter_provider_memberships x
             where x.recruiter_id = m.recruiter_id
          ) = 1
     );
  get diagnostics v_recruiters = row_count;

  select b.vendor_version, b.revision_id
    into v_vendor_version, v_revision_id
    from public.direct_entry_bump_vendor_version(
      v_after.vendor_id, p_app_user_id, v_reason_id,
      public.direct_entry_vendor_snapshot(v_before)
    ) b;

  v_changed := case
    when v_recruiters > 0 then array['active', 'representation_recruiter_active']
    else array['active']
  end;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, vendor_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'vendor_set_active', v_authority,
     v_after.vendor_id, 'all', 'APPLIED', v_reason_id,
     v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'vendor_id', v_after.vendor_id,
    'display_name', v_after.display_name,
    'active', v_after.active,
    'version', v_vendor_version,
    'revision_id', v_revision_id,
    'recruiter_id', public.direct_entry_vendor_representation_recruiter(v_after.vendor_id)
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'vendor_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_set_vendor_active(uuid, uuid, text, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_set_vendor_active(uuid, uuid, text, boolean, integer, text, text)
  to service_role;
comment on function public.direct_entry_set_vendor_active(uuid, uuid, text, boolean, integer, text, text) is
  'P3.1-W02-B admin write: fail closed Vendor activation/deactivation. The canonical representation recruiter(s) follow the Vendor active flag in the same transaction so a deactivated Vendor is no longer offered, while nothing is deleted and every stored fact stays resolvable. service_role only; catalog operator with all scope, a bounded reason and an idempotency key are required.';
-- -----------------------------------------------------------------------------
-- 4. Self-check: ACL posture, revision shape/immutability, boundary invariants.
-- -----------------------------------------------------------------------------
do $$
declare
  v_rpcs text[] := array[
    'public.direct_entry_list_vendors_admin(uuid,uuid,text,boolean,integer,integer)',
    'public.direct_entry_get_vendor_admin(uuid,uuid,text)',
    'public.direct_entry_create_vendor(uuid,uuid,integer,text,text,date,text,text)',
    'public.direct_entry_update_vendor(uuid,uuid,text,integer,text,text,text)',
    'public.direct_entry_set_vendor_active(uuid,uuid,text,boolean,integer,text,text)'
  ];
  v_helpers text[] := array[
    'public.direct_entry_vendor_snapshot(public.vendors)',
    'public.direct_entry_vendor_representation_recruiter(text)',
    'public.direct_entry_vendor_admin_projection(public.vendors,integer,uuid)',
    'public.direct_entry_lock_vendor(text,integer)',
    'public.direct_entry_write_vendor_revision(text,integer,uuid,uuid,jsonb,jsonb)',
    'public.direct_entry_bump_vendor_version(text,uuid,uuid,jsonb)'
  ];
  v_name text;
  v_definition text;
  v_config text;
  v_secdef boolean;
  v_count integer;
  v_check text;
begin
  -- The vendors table keeps its #41 shape: this migration adds no column.
  select array_to_string(array_agg(attname order by attnum), ',')
    into v_check
    from pg_attribute
   where attrelid = 'public.vendors'::regclass
     and attnum > 0
     and not attisdropped;
  if v_check <> 'vendor_id,display_name,active,version' then
    raise exception 'vendors column layout drifted: %', v_check using errcode = '55000';
  end if;

  -- Every administration RPC is SECURITY DEFINER with a fixed search_path and is
  -- granted to service_role only.
  foreach v_name in array v_rpcs loop
    select p.prosecdef, array_to_string(p.proconfig, ',')
      into v_secdef, v_config
      from pg_proc p
     where p.oid = v_name::regprocedure;
    if v_secdef is not true or v_config is null
       or v_config not like '%search_path=pg_catalog, public%' then
      raise exception 'vendor rpc shape is wrong: %', v_name using errcode = '55000';
    end if;
    if not has_function_privilege('service_role', v_name, 'EXECUTE') then
      raise exception 'service_role execute missing for %', v_name using errcode = '55000';
    end if;
    foreach v_check in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_check, v_name, 'EXECUTE') then
        raise exception '% must not execute %', v_check, v_name using errcode = '55000';
      end if;
    end loop;
  end loop;

  -- Internal helpers are never executable by any application role.
  foreach v_name in array v_helpers loop
    foreach v_check in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_check, v_name, 'EXECUTE') then
        raise exception '% must not execute helper %', v_check, v_name using errcode = '55000';
      end if;
    end loop;
  end loop;

  -- The single catalog-operator guard from #68 is reused, never redefined or
  -- replaced by a second guard.
  select pg_get_functiondef(p.oid) into v_definition
    from pg_proc p
   where p.oid = 'public.direct_entry_assert_catalog_operator(uuid,uuid)'::regprocedure;
  if v_definition is null
     or v_definition not like '%catalog_master_manage%'
     or v_definition not like '%recruiter_master_manage%'
     or v_definition not like '%team_master_manage%' then
    raise exception 'catalog operator guard is missing or incomplete' using errcode = '55000';
  end if;

  -- Vendor writes never touch a team, a team membership or the reserved writer.
  foreach v_name in array array[
    'direct_entry_create_vendor',
    'direct_entry_update_vendor',
    'direct_entry_set_vendor_active'
  ] loop
    select pg_get_functiondef(p.oid) into v_definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;
    if v_definition is null then
      raise exception 'vendor rpc source missing: %', v_name using errcode = '55000';
    end if;
    if v_definition like '%recruiter_team_memberships%'
       or v_definition like '%insert into public.teams%'
       or v_definition like '%direct_entry_system_vendor_team_id%'
       or v_definition like '%direct_entry_scope_grants%'
       or v_definition like '%direct_entry_capability_grants%'
       or v_definition like '%direct_entry_app_user_recruiter_links%' then
      raise exception 'vendor rpc % crosses the catalog boundary', v_name using errcode = '55000';
    end if;
  end loop;

  -- Reserved system namespace: create rejects it and the lock/read paths exclude
  -- it by the canonical code, never by a hard-coded UUID.
  select pg_get_functiondef(p.oid) into v_definition
    from pg_proc p
   where p.oid = 'public.direct_entry_create_vendor(uuid,uuid,integer,text,text,date,text,text)'::regprocedure;
  if v_definition not like '%vendor id is reserved%' then
    raise exception 'create must reject the reserved vendor id' using errcode = '55000';
  end if;
  foreach v_name in array array['direct_entry_get_vendor_admin', 'direct_entry_lock_vendor'] loop
    select pg_get_functiondef(p.oid) into v_definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;
    if v_definition is null or v_definition not like '%__system_vendor__%' then
      raise exception 'reserved vendor boundary missing in %', v_name using errcode = '55000';
    end if;
  end loop;

  -- Revision contract: one fixed four-key snapshot, unique (vendor_id, version),
  -- immutability trigger, forced RLS and no application-role access.
  select pg_get_functiondef(p.oid) into v_definition
    from pg_proc p
   where p.oid = 'public.direct_entry_vendor_snapshot(public.vendors)'::regprocedure;
  if v_definition is null
     or v_definition not like '%vendor_id%'
     or v_definition not like '%display_name%'
     or v_definition not like '%active%'
     or v_definition not like '%version%' then
    raise exception 'vendor snapshot shape is incomplete' using errcode = '55000';
  end if;
  if v_definition like '%recruiter%' or v_definition like '%team%'
     or v_definition like '%membership%' or v_definition like '%scope%'
     or v_definition like '%capabilit%' or v_definition like '%reason%' then
    raise exception 'vendor snapshot leaks a non-contract field' using errcode = '55000';
  end if;

  select count(*)::int into v_count
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'direct_entry_vendor_revisions'
     and tg.tgname = 'direct_entry_vendor_revisions_immutable' and not tg.tgisinternal;
  if v_count <> 1 then
    raise exception 'vendor revisions immutability trigger missing' using errcode = '55000';
  end if;

  select count(*)::int into v_count
    from pg_class c
   where c.oid = 'public.direct_entry_vendor_revisions'::regclass
     and c.relrowsecurity and c.relforcerowsecurity;
  if v_count <> 1 then
    raise exception 'vendor revisions must be RLS + FORCE RLS' using errcode = '55000';
  end if;
  if has_table_privilege('service_role', 'public.direct_entry_vendor_revisions', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('anon', 'public.direct_entry_vendor_revisions', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated', 'public.direct_entry_vendor_revisions', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'vendor revisions must be revoked from every role' using errcode = '55000';
  end if;

  select count(*)::int into v_count
    from pg_constraint c
   where c.conrelid = 'public.direct_entry_vendor_revisions'::regclass
     and c.contype = 'u';
  if v_count < 1 then
    raise exception 'vendor revisions must keep unique (vendor_id, version)' using errcode = '55000';
  end if;

  -- service_role gets no direct DML on the vendor catalog tables.
  if has_table_privilege('service_role', 'public.vendors', 'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'service_role must not have vendors DML' using errcode = '55000';
  end if;

  -- The audit binding column exists and points at the vendor revision history.
  select count(*)::int into v_count
    from pg_attribute a
    join pg_constraint c on c.conrelid = a.attrelid and c.contype = 'f'
   where a.attrelid = 'public.direct_entry_audit_events'::regclass
     and a.attname = 'vendor_revision_id'
     and a.attnum > 0 and not a.attisdropped
     and a.attnum = any (c.conkey)
     and c.confrelid = 'public.direct_entry_vendor_revisions'::regclass;
  if v_count <> 1 then
    raise exception 'audit vendor_revision_id binding is missing' using errcode = '55000';
  end if;
end
$$;

commit;
