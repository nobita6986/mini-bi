-- =============================================================================
-- P3.1-W01B - Personnel catalog backend (#68, append-only).
--
-- Scope: the Admin/Accounting personnel catalog only. Reuses public.recruiters,
-- public.recruiter_provider_memberships, restricted reasons, RPC idempotency and
-- the immutable audit/revision patterns. No team membership, no leader lifecycle,
-- no project guard, no Vendor, no labor type, no account/grant/link, no UI.
--
-- Authority: exactly ONE reusable guard, direct_entry_assert_catalog_operator,
-- accepting either the legacy Full Admin bundle (entry_admin +
-- recruiter_master_manage + team_master_manage) or the narrow
-- catalog_master_manage token, in both cases with an effective 'all' scope.
-- entry_admin@all alone is NOT enough. The guard returns the authority that was
-- actually used so audit never mislabels a catalog operator as entry_admin.
-- personnel_position stays a display/catalog attribute: it never grants authority.
--
-- Every mutation is one transaction with an explicit bounded reason, expected
-- version (create: expected_version = 0), idempotency key, an immutable personnel
-- revision (actor/time/before/after, business fields only) and one audit event.
-- Failures leave zero residue: no partial recruiter, provider membership,
-- revision, audit row or reason is ever committed.
--
-- ACL posture: revisions table forced RLS and revoked from every role; internal
-- helpers SECURITY DEFINER with a fixed search_path and revoked from every role;
-- only the five administration RPCs are granted to service_role.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Append-only personnel revision history.
-- -----------------------------------------------------------------------------
create table public.direct_entry_personnel_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  recruiter_id uuid not null references public.recruiters(recruiter_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (recruiter_id, version)
);

create index direct_entry_personnel_revisions_recruiter_idx
  on public.direct_entry_personnel_revisions (recruiter_id, version desc);

create trigger direct_entry_personnel_revisions_immutable
  before update or delete on public.direct_entry_personnel_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.direct_entry_personnel_revisions enable row level security;
alter table public.direct_entry_personnel_revisions force row level security;
revoke all on table public.direct_entry_personnel_revisions
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_personnel_revisions is
  'P3.1-W01B append-only personnel revision history (business fields + actor + reason + version), written only inside the service-role personnel RPCs. Never updated, never deleted, never backfilled.';
comment on column public.direct_entry_personnel_revisions.version is
  'The public.recruiters.version produced by this mutation. unique (recruiter_id, version) makes the personnel version sequence auditable.';

alter table public.direct_entry_audit_events
  add column personnel_revision_id uuid
    references public.direct_entry_personnel_revisions(revision_id) on delete restrict;

-- -----------------------------------------------------------------------------
-- 2. The single canonical catalog-operator guard.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_catalog_operator(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today date := public.direct_entry_authorization_date();
  v_full_admin boolean;
begin
  -- Actor mapping first: unmapped, mismatched or disabled actors never reach a
  -- capability decision and never see a partial answer.
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_full_admin :=
    public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage');

  if not v_full_admin
     and not public.direct_entry_has_capability(p_app_user_id, 'catalog_master_manage') then
    raise exception 'catalog operator denied' using errcode = '42501';
  end if;

  -- Both paths require an effective all-scope grant. A team or own scope never
  -- substitutes, and a leader/PM capability never reaches this function.
  if not exists (
    select 1 from public.direct_entry_scope_grants s
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'all'
       and s.valid_from <= v_today
       and (s.valid_to is null or v_today < s.valid_to)
  ) then
    raise exception 'catalog operation requires all scope' using errcode = '42501';
  end if;

  -- The authority that was actually exercised, for the audit stream.
  if v_full_admin then
    return 'entry_admin';
  end if;
  return 'catalog_master_manage';
end;
$$;
revoke all on function public.direct_entry_assert_catalog_operator(uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_assert_catalog_operator(uuid, uuid) is
  'P3.1-W01B internal guard: actor mapping + (legacy Full Admin triple OR catalog_master_manage) + effective all scope. Returns the authority actually used (entry_admin or catalog_master_manage) for audit. Revoked from every role; entry_admin@all alone is denied.';

-- -----------------------------------------------------------------------------
-- 3. Internal personnel helpers (lock/OCC, snapshot, revision, version bump).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_lock_personnel(
  p_recruiter_id uuid,
  p_expected_version integer
)
returns public.recruiters
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_recruiter public.recruiters;
begin
  if p_recruiter_id is null then
    raise exception 'personnel required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected personnel version required' using errcode = '22023';
  end if;

  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id
   for update;
  if not found then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;
  if v_recruiter.version <> p_expected_version then
    raise exception 'personnel version conflict' using errcode = '40001';
  end if;
  return v_recruiter;
end;
$$;
revoke all on function public.direct_entry_lock_personnel(uuid, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_lock_personnel(uuid, integer) is
  'P3.1-W01B internal guard: SELECT ... FOR UPDATE on the recruiter row plus fail-closed expected-version check (40001 on mismatch, P0002 when absent). Revoked from every role.';

-- Contract business fields only: identity, catalog attributes, active flag, OCC
-- version and - for create - the HRP provider valid_from that must be proven.
create or replace function public.direct_entry_personnel_snapshot(
  p_recruiter public.recruiters,
  p_hrp_valid_from date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_snapshot jsonb;
begin
  v_snapshot := jsonb_build_object(
    'recruiter_id', p_recruiter.recruiter_id,
    'display_name', p_recruiter.display_name,
    'personnel_code', p_recruiter.personnel_code,
    'personnel_position', p_recruiter.personnel_position,
    'active', p_recruiter.active,
    'version', p_recruiter.version
  );
  if p_hrp_valid_from is not null then
    v_snapshot := v_snapshot || jsonb_build_object('hrp_valid_from', to_jsonb(p_hrp_valid_from));
  end if;
  return v_snapshot;
end;
$$;
revoke all on function public.direct_entry_personnel_snapshot(public.recruiters, date)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_personnel_snapshot(public.recruiters, date) is
  'P3.1-W01B internal projection of one recruiter row: recruiter_id, display_name, personnel_code, personnel_position, active, version (+ hrp_valid_from when supplied). No auth, email, grant, scope or raw reason. Revoked from every role.';

create or replace function public.direct_entry_write_personnel_revision(
  p_recruiter_id uuid,
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
  insert into public.direct_entry_personnel_revisions (
    recruiter_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_recruiter_id, p_version, p_actor_user_id, p_reason_id, p_before_snapshot, p_after_snapshot
  ) returning revision_id into v_revision_id;
  return v_revision_id;
end;
$$;
revoke all on function public.direct_entry_write_personnel_revision(uuid, integer, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_write_personnel_revision(uuid, integer, uuid, uuid, jsonb, jsonb) is
  'P3.1-W01B internal append-only personnel revision writer (mirrors direct_entry_write_project_revision). Revoked from every role.';

create or replace function public.direct_entry_bump_personnel_version(
  p_recruiter_id uuid,
  p_actor_user_id uuid,
  p_reason_id uuid,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb
)
returns table (personnel_version integer, revision_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_version integer;
begin
  update public.recruiters r
     set version = r.version + 1
   where r.recruiter_id = p_recruiter_id
  returning r.version into v_version;
  if v_version is null then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;
  return query
    select v_version,
           public.direct_entry_write_personnel_revision(
             p_recruiter_id, v_version, p_actor_user_id, p_reason_id,
             p_before_snapshot,
             jsonb_set(
               coalesce(p_after_snapshot, '{}'::jsonb),
               '{version}', to_jsonb(v_version), true
             )
           );
end;
$$;
revoke all on function public.direct_entry_bump_personnel_version(uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_bump_personnel_version(uuid, uuid, uuid, jsonb, jsonb) is
  'P3.1-W01B internal: advances public.recruiters.version and appends the before/after personnel revision in the same transaction. Callers must already hold the recruiter row lock. Revoked from every role.';

-- Shared admin projection used by the list and the detail read so the two can
-- never drift. Contract business fields only: no auth_subject, no email, no
-- capability/scope, no app-user id, no raw reason, no storage data.
create or replace function public.direct_entry_personnel_admin_projection(
  p_recruiter public.recruiters,
  p_hrp_valid_from date,
  p_revision_count integer
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'recruiter_id', p_recruiter.recruiter_id,
    'display_name', p_recruiter.display_name,
    'personnel_code', p_recruiter.personnel_code,
    'personnel_position', p_recruiter.personnel_position,
    'active', p_recruiter.active,
    'version', p_recruiter.version,
    'hrp_valid_from', p_hrp_valid_from,
    'revision_count', coalesce(p_revision_count, 0)
  )
$$;
revoke all on function public.direct_entry_personnel_admin_projection(public.recruiters, date, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_personnel_admin_projection(public.recruiters, date, integer) is
  'P3.1-W01B internal admin projection of one personnel row: recruiter_id, display_name, personnel_code, personnel_position, active, version, effective hrp_valid_from, revision_count. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 4. Administration RPCs (service_role only).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_list_personnel_admin(
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
  v_personnel jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid personnel search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.recruiters r
   where (v_include_inactive or r.active)
     and (
       v_search is null
       or r.display_name ilike '%' || v_search || '%'
       or coalesce(r.personnel_code, '') ilike '%' || v_search || '%'
     );

  -- Deterministic order and a hard page bound. No team join at all: personnel
  -- with zero active team membership stay visible in the admin catalog.
  select coalesce(jsonb_agg(t.personnel), '[]'::jsonb)
    into v_personnel
    from (
      select public.direct_entry_personnel_admin_projection(
               r, hrp.valid_from, rev.revision_count
             ) as personnel,
             r.display_name,
             r.recruiter_id
        from public.recruiters r
        left join lateral (
          select m.valid_from
            from public.recruiter_provider_memberships m
           where m.recruiter_id = r.recruiter_id
             and m.provider_type = 'hrp'
             and m.valid_from <= public.direct_entry_authorization_date()
             and (m.valid_to is null
                  or public.direct_entry_authorization_date() < m.valid_to)
           order by m.valid_from desc
           limit 1
        ) hrp on true
        left join lateral (
          select count(*)::int as revision_count
            from public.direct_entry_personnel_revisions v
           where v.recruiter_id = r.recruiter_id
        ) rev on true
       where (v_include_inactive or r.active)
         and (
           v_search is null
           or r.display_name ilike '%' || v_search || '%'
           or coalesce(r.personnel_code, '') ilike '%' || v_search || '%'
         )
       order by r.display_name, r.recruiter_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) t;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'personnel', v_personnel
  );
end;
$$;
revoke all on function public.direct_entry_list_personnel_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_personnel_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;
comment on function public.direct_entry_list_personnel_admin(uuid, uuid, text, boolean, integer, integer) is
  'P3.1-W01B admin read: bounded, deterministically ordered personnel catalog (search by display_name / personnel_code, active filter, page + page_size bounded 1..1000 / 1..100, total count). service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_get_personnel_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_personnel jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
  if p_recruiter_id is null then
    raise exception 'personnel required' using errcode = '22023';
  end if;

  select public.direct_entry_personnel_admin_projection(r, hrp.valid_from, rev.revision_count)
    into v_personnel
    from public.recruiters r
    left join lateral (
      select m.valid_from
        from public.recruiter_provider_memberships m
       where m.recruiter_id = r.recruiter_id
         and m.provider_type = 'hrp'
         and m.valid_from <= public.direct_entry_authorization_date()
         and (m.valid_to is null
              or public.direct_entry_authorization_date() < m.valid_to)
       order by m.valid_from desc
       limit 1
    ) hrp on true
    left join lateral (
      select count(*)::int as revision_count
        from public.direct_entry_personnel_revisions v
       where v.recruiter_id = r.recruiter_id
    ) rev on true
   where r.recruiter_id = p_recruiter_id;

  if v_personnel is null then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;
  return v_personnel;
end;
$$;
revoke all on function public.direct_entry_get_personnel_admin(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_personnel_admin(uuid, uuid, uuid)
  to service_role;
comment on function public.direct_entry_get_personnel_admin(uuid, uuid, uuid) is
  'P3.1-W01B admin read: one personnel row with the same projection as the admin list, or P0002. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_create_personnel(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_personnel_code text,
  p_display_name text,
  p_personnel_position text,
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
  v_code text;
  v_display text;
  v_position text;
  v_valid_from date;
  v_reason_id uuid;
  v_recruiter public.recruiters;
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
  if p_personnel_code is null or btrim(p_personnel_code) = '' then
    raise exception 'personnel code required' using errcode = '22023';
  end if;
  v_code := btrim(p_personnel_code);
  if length(v_code) > 64 or v_code ~ '[[:space:][:cntrl:]]' then
    raise exception 'personnel code is not canonical' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'personnel display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_personnel_position is null or p_personnel_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  v_position := p_personnel_position;
  v_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());
  if v_valid_from > public.direct_entry_authorization_date() then
    raise exception 'provider valid from is in the future' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'personnel_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'personnel_code', v_code,
      'display_name', v_display,
      'personnel_position', v_position,
      'valid_from', v_valid_from
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then
    raise exception 'personnel code already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.recruiters (display_name, personnel_code, personnel_position, active, version)
  values (v_display, v_code, v_position, true, 1)
  returning * into v_recruiter;

  -- Exactly one HRP provider membership with an explicit valid_from. The insert
  -- creates no auth account, no app user, no recruiter link, no team membership,
  -- no capability grant and no scope grant.
  insert into public.recruiter_provider_memberships
    (recruiter_id, provider_type, valid_from, vendor_id)
  values (v_recruiter.recruiter_id, 'hrp', v_valid_from, null);

  v_revision_id := public.direct_entry_write_personnel_revision(
    v_recruiter.recruiter_id, v_recruiter.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_personnel_snapshot(v_recruiter, v_valid_from)
  );

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, personnel_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'personnel_create', v_authority,
     v_recruiter.recruiter_id::text, 'all', 'APPLIED', v_reason_id,
     array['display_name', 'personnel_code', 'personnel_position', 'active'],
     v_revision_id);

  v_result := jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id,
    'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code,
    'personnel_position', v_recruiter.personnel_position,
    'active', v_recruiter.active,
    'version', v_recruiter.version,
    'hrp_valid_from', v_valid_from,
    'revision_id', v_revision_id,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'personnel_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_create_personnel(uuid, uuid, integer, text, text, text, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_personnel(uuid, uuid, integer, text, text, text, date, text, text)
  to service_role;
comment on function public.direct_entry_create_personnel(uuid, uuid, integer, text, text, text, date, text, text) is
  'P3.1-W01B mutation: creates exactly one recruiter row plus exactly one HRP provider membership (explicit valid_from, vendor_id null) with a personnel revision and one audit event. expected_version must be 0. No account, link, team membership, capability or scope is created. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_update_personnel(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid,
  p_expected_version integer,
  p_display_name text,
  p_personnel_code text,
  p_personnel_position text,
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
  v_code text;
  v_display text;
  v_position text;
  v_reason_id uuid;
  v_before public.recruiters;
  v_after public.recruiters;
  v_changed text[];
  v_personnel_version integer;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  -- Authorization first: an actor without catalog authority always gets 42501 and
  -- learns nothing about the shape of the input.
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null then
    raise exception 'personnel required' using errcode = '22023';
  end if;
  if p_personnel_code is null or btrim(p_personnel_code) = '' then
    raise exception 'personnel code required' using errcode = '22023';
  end if;
  v_code := btrim(p_personnel_code);
  if length(v_code) > 64 or v_code ~ '[[:space:][:cntrl:]]' then
    raise exception 'personnel code is not canonical' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'personnel display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_personnel_position is null or p_personnel_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  v_position := p_personnel_position;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'personnel_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'expected_version', p_expected_version,
      'personnel_code', v_code,
      'display_name', v_display,
      'personnel_position', v_position
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_personnel(p_recruiter_id, p_expected_version);

  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and r.recruiter_id <> p_recruiter_id
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then
    raise exception 'personnel code already exists' using errcode = '23505';
  end if;

  v_changed := array_remove(array[
    case when v_before.display_name is distinct from v_display then 'display_name' end,
    case when v_before.personnel_code is distinct from v_code then 'personnel_code' end,
    case when v_before.personnel_position is distinct from v_position then 'personnel_position' end
  ], null);
  if cardinality(v_changed) = 0 then
    raise exception 'personnel update changes nothing' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Only the three catalog attributes are writable. recruiter_id, provider
  -- history, team membership, account links, capability and scope are untouched.
  update public.recruiters
     set display_name = v_display,
         personnel_code = v_code,
         personnel_position = v_position
   where recruiter_id = p_recruiter_id
  returning * into v_after;

  select b.personnel_version, b.revision_id
    into v_personnel_version, v_revision_id
    from public.direct_entry_bump_personnel_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      public.direct_entry_personnel_snapshot(v_before),
      public.direct_entry_personnel_snapshot(v_after)
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, personnel_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'personnel_update', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id,
     v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'display_name', v_after.display_name,
    'personnel_code', v_after.personnel_code,
    'personnel_position', v_after.personnel_position,
    'active', v_after.active,
    'version', v_personnel_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'personnel_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text)
  to service_role;
comment on function public.direct_entry_update_personnel(uuid, uuid, uuid, integer, text, text, text, text, text) is
  'P3.1-W01B mutation: updates display_name / personnel_code / personnel_position only, under recruiter-row OCC, with a personnel revision and one audit event whose changed_fields lists the fields actually changed. provider history, team membership, account links, capability and scope are never touched. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_set_personnel_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid,
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
  v_before public.recruiters;
  v_after public.recruiters;
  v_personnel_version integer;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  -- Authorization first: an actor without catalog authority always gets 42501 and
  -- learns nothing about the shape of the input.
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null then
    raise exception 'personnel required' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'personnel active flag required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'personnel_set_active', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'active', p_active,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_personnel(p_recruiter_id, p_expected_version);
  if v_before.active = p_active then
    raise exception 'personnel active state is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Soft state only: deactivation never deletes the recruiter, its provider
  -- history, its worker references or its reporting attribution.
  update public.recruiters
     set active = p_active
   where recruiter_id = p_recruiter_id
  returning * into v_after;

  select b.personnel_version, b.revision_id
    into v_personnel_version, v_revision_id
    from public.direct_entry_bump_personnel_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      public.direct_entry_personnel_snapshot(v_before),
      public.direct_entry_personnel_snapshot(v_after)
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, personnel_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'personnel_set_active', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id,
     array['active'], v_revision_id);

  v_result := jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'display_name', v_after.display_name,
    'personnel_code', v_after.personnel_code,
    'personnel_position', v_after.personnel_position,
    'active', v_after.active,
    'version', v_personnel_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'personnel_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_set_personnel_active(uuid, uuid, uuid, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_set_personnel_active(uuid, uuid, uuid, boolean, integer, text, text)
  to service_role;
comment on function public.direct_entry_set_personnel_active(uuid, uuid, uuid, boolean, integer, text, text) is
  'P3.1-W01B mutation: activate/deactivate one personnel row under OCC with a personnel revision and one audit event. Never hard-deletes and never rewrites HRP provider history. service_role only; catalog operator + all scope required.';

-- -----------------------------------------------------------------------------
-- 5. Self-check: guard shape, ACL posture, revision immutability, W01A parity.
-- -----------------------------------------------------------------------------
do $$
declare
  v_rpcs text[] := array[
    'public.direct_entry_list_personnel_admin(uuid,uuid,text,boolean,integer,integer)',
    'public.direct_entry_get_personnel_admin(uuid,uuid,uuid)',
    'public.direct_entry_create_personnel(uuid,uuid,integer,text,text,text,date,text,text)',
    'public.direct_entry_update_personnel(uuid,uuid,uuid,integer,text,text,text,text,text)',
    'public.direct_entry_set_personnel_active(uuid,uuid,uuid,boolean,integer,text,text)'
  ];
  v_helpers text[] := array[
    'public.direct_entry_assert_catalog_operator(uuid,uuid)',
    'public.direct_entry_lock_personnel(uuid,integer)',
    'public.direct_entry_personnel_snapshot(public.recruiters,date)',
    'public.direct_entry_personnel_admin_projection(public.recruiters,date,integer)',
    'public.direct_entry_write_personnel_revision(uuid,integer,uuid,uuid,jsonb,jsonb)',
    'public.direct_entry_bump_personnel_version(uuid,uuid,uuid,jsonb,jsonb)'
  ];
  v_name text;
  v_definition text;
  v_secdef boolean;
  v_config text;
  v_check text;
  v_tokens integer;
  v_trigger integer;
  v_rls integer;
  v_audit_column integer;
begin
  -- Guard: SECURITY DEFINER, fixed search_path, both authority paths, all scope.
  select p.prosecdef, array_to_string(p.proconfig, ',')
    into v_secdef, v_config
    from pg_proc p
   where p.oid = 'public.direct_entry_assert_catalog_operator(uuid,uuid)'::regprocedure;
  select pg_get_functiondef('public.direct_entry_assert_catalog_operator(uuid,uuid)'::regprocedure)
    into v_definition;
  if v_definition is null or v_secdef is not true
     or v_config is null or v_config not like '%search_path=pg_catalog, public%' then
    raise exception 'catalog operator guard shape is wrong' using errcode = '55000';
  end if;
  if v_definition not like '%entry_admin%'
     or v_definition not like '%recruiter_master_manage%'
     or v_definition not like '%team_master_manage%'
     or v_definition not like '%catalog_master_manage%'
     or v_definition not like '%scope_kind = ''all''%' then
    raise exception 'catalog operator guard is incomplete' using errcode = '55000';
  end if;

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

  select count(*)::int into v_trigger
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'direct_entry_personnel_revisions'
     and t.tgname = 'direct_entry_personnel_revisions_immutable'
     and not t.tgisinternal;
  if v_trigger <> 1 then
    raise exception 'personnel revisions immutability trigger missing' using errcode = '55000';
  end if;

  select count(*)::int into v_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'direct_entry_personnel_revisions'
     and c.relrowsecurity
     and c.relforcerowsecurity;
  if v_rls <> 1 then
    raise exception 'personnel revisions must enable and force RLS' using errcode = '55000';
  end if;

  select count(*)::int into v_audit_column
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'direct_entry_audit_events'
     and column_name = 'personnel_revision_id';
  if v_audit_column <> 1 then
    raise exception 'audit personnel revision link missing' using errcode = '55000';
  end if;

  -- W01A parity: the canonical capability vocabulary must still be exactly 23.
  select pg_get_constraintdef(c.oid) into v_check
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'direct_entry_capability_grants'
     and c.conname = 'direct_entry_capability_grants_capability_check';
  v_tokens := (length(coalesce(v_check, ''))
    - length(replace(coalesce(v_check, ''), '''::text', ''))) / length('''::text');
  if v_tokens <> 23 then
    raise exception 'capability vocabulary drifted: % tokens', v_tokens using errcode = '55000';
  end if;
end;
$$;

commit;
