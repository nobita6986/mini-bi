-- =============================================================================
-- P3.1-W01C-A - Team master catalog backend (#69, append-only).
--
-- Scope: team master administration ONLY - list/get/create/update/set-active over
-- the existing canonical public.teams table. Membership, personnel assignment,
-- leader designation/revocation, team scope and capability grants, project-manager
-- assignment, Vendor lifecycle, labor type, accounts/links and UI are explicitly
-- out of scope and are not touched anywhere in this file.
--
-- Authority reuses the single guard introduced by #68,
-- public.direct_entry_assert_catalog_operator: the legacy Full Admin triple
-- (entry_admin + recruiter_master_manage + team_master_manage) OR
-- catalog_master_manage, both with an effective 'all' scope. No second catalog
-- guard exists, and the guard returns the authority actually used so audit never
-- mislabels an operator as entry_admin.
--
-- Reserved Vendor system team: the team whose code is '__system_vendor__' is not a
-- business team. It is excluded from list, count and detail, it can never be
-- created, renamed, activated or deactivated through this catalog, and no
-- membership or team scope may reference it (the #65 triggers keep that true).
-- The boundary is expressed through the canonical reserved CODE, never a
-- hard-coded team UUID, and no read path calls the writing helper
-- direct_entry_system_vendor_team_id().
--
-- Every mutation is one transaction with an explicit bounded reason, an expected
-- version (create: 0), an idempotency key, an immutable team revision whose
-- snapshot has one fixed five-key shape, and one audit event bound to the revision
-- it produced. Any failure leaves zero residue.
--
-- ACL posture: the revision table is force-RLS and revoked from every role;
-- internal helpers are SECURITY DEFINER with a fixed search_path and revoked from
-- every role; only the five administration RPCs are granted to service_role.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Append-only team revision history.
-- -----------------------------------------------------------------------------
create table public.direct_entry_team_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(team_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (team_id, version)
);

create index direct_entry_team_revisions_team_idx
  on public.direct_entry_team_revisions (team_id, version desc);

create trigger direct_entry_team_revisions_immutable
  before update or delete on public.direct_entry_team_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.direct_entry_team_revisions enable row level security;
alter table public.direct_entry_team_revisions force row level security;
revoke all on table public.direct_entry_team_revisions
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_team_revisions is
  'P3.1-W01C-A append-only team revision history (team_id, code, display_name, active, version + actor + reason), written only inside the service-role team RPCs. Never updated, never deleted, never backfilled.';
comment on column public.direct_entry_team_revisions.version is
  'The public.teams.version produced by this mutation. unique (team_id, version) makes the team version sequence auditable.';

alter table public.direct_entry_audit_events
  add column team_revision_id uuid
    references public.direct_entry_team_revisions(revision_id) on delete restrict;

-- -----------------------------------------------------------------------------
-- 2. Internal helpers: fixed snapshot, reserved-team read boundary, lock/OCC,
--    revision writer and version bump.
-- -----------------------------------------------------------------------------
-- One FIXED revision schema: exactly these five keys, for every action, so
-- create/update/set-active revisions are comparable key-by-key.
create or replace function public.direct_entry_team_snapshot(
  p_team public.teams
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'team_id', p_team.team_id,
    'code', p_team.code,
    'display_name', p_team.display_name,
    'active', p_team.active,
    'version', p_team.version
  )
$$;
revoke all on function public.direct_entry_team_snapshot(public.teams)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_team_snapshot(public.teams) is
  'P3.1-W01C-A internal projection of one team row: exactly team_id, code, display_name, active and version. No membership, scope, capability, account, email or raw reason. Revoked from every role.';

-- Row lock + fail-closed OCC on the team, and the reserved-team boundary: the
-- reserved Vendor system team is simply not found here, so update and set-active
-- fail closed with P0002 instead of touching a system row.
create or replace function public.direct_entry_lock_team(
  p_team_id uuid,
  p_expected_version integer
)
returns public.teams
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_team public.teams;
begin
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected team version required' using errcode = '22023';
  end if;

  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
     and t.code <> '__system_vendor__'
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if v_team.version <> p_expected_version then
    raise exception 'team version conflict' using errcode = '40001';
  end if;
  return v_team;
end;
$$;
revoke all on function public.direct_entry_lock_team(uuid, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_lock_team(uuid, integer) is
  'P3.1-W01C-A internal guard: SELECT ... FOR UPDATE on the team row plus fail-closed expected-version check (40001 on mismatch, P0002 when absent). It also enforces the reserved-team boundary: the __system_vendor__ team is never lockable, so it can never be renamed, activated or deactivated. Revoked from every role.';

create or replace function public.direct_entry_write_team_revision(
  p_team_id uuid,
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
  insert into public.direct_entry_team_revisions (
    team_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_team_id, p_version, p_actor_user_id, p_reason_id, p_before_snapshot, p_after_snapshot
  ) returning revision_id into v_revision_id;
  return v_revision_id;
end;
$$;
revoke all on function public.direct_entry_write_team_revision(uuid, integer, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_write_team_revision(uuid, integer, uuid, uuid, jsonb, jsonb) is
  'P3.1-W01C-A internal append-only team revision writer (mirrors direct_entry_write_project_revision). Revoked from every role.';

create or replace function public.direct_entry_bump_team_version(
  p_team_id uuid,
  p_actor_user_id uuid,
  p_reason_id uuid,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb
)
returns table (team_version integer, revision_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_version integer;
begin
  update public.teams t
     set version = t.version + 1
   where t.team_id = p_team_id
  returning t.version into v_version;
  if v_version is null then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  return query
    select v_version,
           public.direct_entry_write_team_revision(
             p_team_id, v_version, p_actor_user_id, p_reason_id,
             p_before_snapshot,
             jsonb_set(
               coalesce(p_after_snapshot, '{}'::jsonb),
               '{version}', to_jsonb(v_version), true
             )
           );
end;
$$;
revoke all on function public.direct_entry_bump_team_version(uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_bump_team_version(uuid, uuid, uuid, jsonb, jsonb) is
  'P3.1-W01C-A internal: advances public.teams.version and appends the before/after team revision in the same transaction. Callers must already hold the team row lock. Revoked from every role.';

-- Shared admin projection used by the list and the detail read so the two can
-- never drift. Contract business fields only.
create or replace function public.direct_entry_team_admin_projection(
  p_team public.teams,
  p_revision_count integer
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'team_id', p_team.team_id,
    'code', p_team.code,
    'display_name', p_team.display_name,
    'active', p_team.active,
    'version', p_team.version,
    'revision_count', coalesce(p_revision_count, 0)
  )
$$;
revoke all on function public.direct_entry_team_admin_projection(public.teams, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_team_admin_projection(public.teams, integer) is
  'P3.1-W01C-A internal admin projection of one team row: team_id, code, display_name, active, version, revision_count. No membership, scope, capability, account, email or raw reason. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 3. Administration RPCs (service_role only).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_list_teams_admin(
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
  v_teams jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid team search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  -- Reserved Vendor system team: never counted, never listed. The boundary is the
  -- canonical reserved code, not a hard-coded UUID, and no read path invokes the
  -- lazy system-vendor writer helper.
  select count(*)::int into v_total
    from public.teams t
   where t.code <> '__system_vendor__'
     and (v_include_inactive or t.active)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(t.projection order by t.display_name, t.team_id), '[]'::jsonb)
    into v_teams
    from (
      select public.direct_entry_team_admin_projection(t, rev.revision_count) as projection,
             t.display_name,
             t.team_id
        from public.teams t
        left join lateral (
          select count(*)::int as revision_count
            from public.direct_entry_team_revisions r
           where r.team_id = t.team_id
        ) rev on true
       where t.code <> '__system_vendor__'
         and (v_include_inactive or t.active)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
         )
       order by t.display_name, t.team_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) t;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'teams', v_teams
  );
end;
$$;
revoke all on function public.direct_entry_list_teams_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_teams_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;
comment on function public.direct_entry_list_teams_admin(uuid, uuid, text, boolean, integer, integer) is
  'P3.1-W01C-A admin read: bounded, deterministically ordered business team catalog (search by display_name / code, active filter, page + page_size bounded 1..1000 / 1..100, total count) with the reserved __system_vendor__ team excluded. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_get_team_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_team jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;

  select public.direct_entry_team_admin_projection(t, rev.revision_count)
    into v_team
    from public.teams t
    left join lateral (
      select count(*)::int as revision_count
        from public.direct_entry_team_revisions r
       where r.team_id = t.team_id
    ) rev on true
   where t.team_id = p_team_id
     and t.code <> '__system_vendor__';

  if v_team is null then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  return v_team;
end;
$$;
revoke all on function public.direct_entry_get_team_admin(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_team_admin(uuid, uuid, uuid)
  to service_role;
comment on function public.direct_entry_get_team_admin(uuid, uuid, uuid) is
  'P3.1-W01C-A admin read: one business team row with the same projection as the admin list, or P0002 for an unknown team and for the reserved __system_vendor__ team. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_create_team(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_code text,
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
  v_code text;
  v_display text;
  v_reason_id uuid;
  v_team public.teams;
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
  if p_code is null or btrim(p_code) = '' then
    raise exception 'team code required' using errcode = '22023';
  end if;
  v_code := btrim(p_code);
  if length(v_code) > 128 or v_code ~ '[[:space:][:cntrl:]]' then
    raise exception 'team code is not canonical' using errcode = '22023';
  end if;
  -- The reserved Vendor system team is not a business team and can never be
  -- created through this catalog.
  if v_code = '__system_vendor__' then
    raise exception 'team code is reserved' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'team display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'code', v_code,
      'display_name', v_display
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if exists (select 1 from public.teams t where t.code = v_code) then
    raise exception 'team code already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.teams (code, display_name, active, version)
  values (v_code, v_display, true, 1)
  returning * into v_team;

  v_revision_id := public.direct_entry_write_team_revision(
    v_team.team_id, v_team.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_team_snapshot(v_team)
  );

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, team_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_create', v_authority,
     v_team.team_id::text, 'all', 'APPLIED', v_reason_id,
     array['code', 'display_name', 'active'], v_revision_id);

  v_result := jsonb_build_object(
    'team_id', v_team.team_id,
    'code', v_team.code,
    'display_name', v_team.display_name,
    'active', v_team.active,
    'version', v_team.version,
    'revision_id', v_revision_id,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text)
  to service_role;
comment on function public.direct_entry_create_team(uuid, uuid, integer, text, text, text, text) is
  'P3.1-W01C-A mutation: creates exactly one public.teams row (active, version 1) with a canonical immutable code, a team revision and one audit event. expected_version must be 0 and the reserved __system_vendor__ code is rejected. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_update_team(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
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
  v_before public.teams;
  v_after public.teams;
  v_team_version integer;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'team display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'team_id', p_team_id,
      'expected_version', p_expected_version,
      'display_name', v_display
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_team(p_team_id, p_expected_version);
  if v_before.display_name is not distinct from v_display then
    raise exception 'team update changes nothing' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Only display_name is writable. code is immutable after create, and active has
  -- its own dedicated mutation path, so neither can be reached from here.
  update public.teams
     set display_name = v_display
   where team_id = p_team_id
  returning * into v_after;

  select b.team_version, b.revision_id
    into v_team_version, v_revision_id
    from public.direct_entry_bump_team_version(
      p_team_id, p_app_user_id, v_reason_id,
      public.direct_entry_team_snapshot(v_before),
      public.direct_entry_team_snapshot(v_after)
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, team_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_update', v_authority,
     p_team_id::text, 'all', 'APPLIED', v_reason_id,
     array['display_name'], v_revision_id);

  v_result := jsonb_build_object(
    'team_id', p_team_id,
    'code', v_after.code,
    'display_name', v_after.display_name,
    'active', v_after.active,
    'version', v_team_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_update_team(uuid, uuid, uuid, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_team(uuid, uuid, uuid, integer, text, text, text)
  to service_role;
comment on function public.direct_entry_update_team(uuid, uuid, uuid, integer, text, text, text) is
  'P3.1-W01C-A mutation: updates display_name only, under team-row OCC, with a team revision and one audit event. code, active and identity are never writable here, and the reserved __system_vendor__ team is P0002. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_set_team_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
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
  v_before public.teams;
  v_after public.teams;
  v_team_version integer;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'team active flag required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_set_active', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'team_id', p_team_id,
      'active', p_active,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_team(p_team_id, p_expected_version);
  if v_before.active = p_active then
    raise exception 'team active state is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Soft state only: no membership, scope, fact or history row is written, closed
  -- or deleted by this mutation.
  update public.teams
     set active = p_active
   where team_id = p_team_id
  returning * into v_after;

  select b.team_version, b.revision_id
    into v_team_version, v_revision_id
    from public.direct_entry_bump_team_version(
      p_team_id, p_app_user_id, v_reason_id,
      public.direct_entry_team_snapshot(v_before),
      public.direct_entry_team_snapshot(v_after)
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, team_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_set_active', v_authority,
     p_team_id::text, 'all', 'APPLIED', v_reason_id,
     array['active'], v_revision_id);

  v_result := jsonb_build_object(
    'team_id', p_team_id,
    'code', v_after.code,
    'display_name', v_after.display_name,
    'active', v_after.active,
    'version', v_team_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_set_team_active(uuid, uuid, uuid, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_set_team_active(uuid, uuid, uuid, boolean, integer, text, text)
  to service_role;
comment on function public.direct_entry_set_team_active(uuid, uuid, uuid, boolean, integer, text, text) is
  'P3.1-W01C-A mutation: activate/deactivate one business team under OCC with a team revision and one audit event. Never hard-deletes, never touches membership, scope or history, and the reserved __system_vendor__ team is P0002. service_role only; catalog operator + all scope required.';

-- -----------------------------------------------------------------------------
-- 4. Self-check: reserved-team invariant, revision shape/immutability, ACL.
-- -----------------------------------------------------------------------------
do $$
declare
  v_rpcs text[] := array[
    'public.direct_entry_list_teams_admin(uuid,uuid,text,boolean,integer,integer)',
    'public.direct_entry_get_team_admin(uuid,uuid,uuid)',
    'public.direct_entry_create_team(uuid,uuid,integer,text,text,text,text)',
    'public.direct_entry_update_team(uuid,uuid,uuid,integer,text,text,text)',
    'public.direct_entry_set_team_active(uuid,uuid,uuid,boolean,integer,text,text)'
  ];
  v_helpers text[] := array[
    'public.direct_entry_team_snapshot(public.teams)',
    'public.direct_entry_team_admin_projection(public.teams,integer)',
    'public.direct_entry_lock_team(uuid,integer)',
    'public.direct_entry_write_team_revision(uuid,integer,uuid,uuid,jsonb,jsonb)',
    'public.direct_entry_bump_team_version(uuid,uuid,uuid,jsonb,jsonb)'
  ];
  v_name text;
  v_definition text;
  v_count integer;
  v_tokens integer;
  v_check text;
begin
  -- The reserved Vendor system team stays a non-business row: no membership and no
  -- team scope may reference it, exactly the invariant migration #65 installed.
  select count(*)::int into v_count
    from public.recruiter_team_memberships m
    join public.teams t on t.team_id = m.team_id
   where t.code = '__system_vendor__';
  if v_count <> 0 then
    raise exception 'reserved Vendor team gained a business membership' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from public.direct_entry_scope_grants g
    join public.teams t on t.team_id = g.team_id
   where g.scope_kind = 'team' and t.code = '__system_vendor__';
  if v_count <> 0 then
    raise exception 'reserved Vendor team gained a team scope' using errcode = '55000';
  end if;

  -- Read paths and the lock must express the boundary through the reserved code and
  -- must never invoke the writing helper (which lazily creates or validates the row
  -- and would make a read mutate the catalog).
  foreach v_name in array array[
    'direct_entry_list_teams_admin',
    'direct_entry_get_team_admin',
    'direct_entry_lock_team'
  ] loop
    select pg_get_functiondef(p.oid) into v_definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;
    if v_definition is null or v_definition not like '%__system_vendor__%' then
      raise exception 'reserved team boundary missing in %', v_name using errcode = '55000';
    end if;
    if v_definition like '%direct_entry_system_vendor_team_id%' then
      raise exception 'read path % must not call the writing system-vendor helper', v_name
        using errcode = '55000';
    end if;
  end loop;
  select pg_get_functiondef('public.direct_entry_create_team(uuid,uuid,integer,text,text,text,text)'::regprocedure)
    into v_definition;
  if v_definition is null or v_definition not like '%team code is reserved%' then
    raise exception 'create must reject the reserved team code' using errcode = '55000';
  end if;

  -- Revision contract: one fixed five-key snapshot, unique (team_id, version),
  -- immutability trigger and forced RLS.
  select pg_get_functiondef('public.direct_entry_team_snapshot(public.teams)'::regprocedure)
    into v_definition;
  if v_definition is null then
    raise exception 'team snapshot missing' using errcode = '55000';
  end if;
  if v_definition not like '%team_id%' or v_definition not like '%code%'
     or v_definition not like '%display_name%' or v_definition not like '%active%'
     or v_definition not like '%version%' then
    raise exception 'team snapshot shape is incomplete' using errcode = '55000';
  end if;
  if v_definition like '%membership%' or v_definition like '%scope%'
     or v_definition like '%capabilit%' or v_definition like '%reason%' then
    raise exception 'team snapshot leaks a non-contract field' using errcode = '55000';
  end if;

  select count(*)::int into v_count
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'direct_entry_team_revisions'
     and tg.tgname = 'direct_entry_team_revisions_immutable' and not tg.tgisinternal;
  if v_count <> 1 then
    raise exception 'team revisions immutability trigger missing' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'direct_entry_team_revisions'
     and c.relrowsecurity and c.relforcerowsecurity;
  if v_count <> 1 then
    raise exception 'team revisions must enable and force RLS' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from information_schema.columns
   where table_schema = 'public' and table_name = 'direct_entry_audit_events'
     and column_name = 'team_revision_id';
  if v_count <> 1 then
    raise exception 'audit team revision link missing' using errcode = '55000';
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

  -- The team catalog reuses the #68 guard; no parallel catalog guard is created and
  -- the W01A capability vocabulary is untouched.
  select count(*)::int into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'direct_entry_assert_catalog_operator';
  if v_count <> 1 then
    raise exception 'the single catalog operator guard is missing or duplicated' using errcode = '55000';
  end if;
  select pg_get_constraintdef(c.oid) into v_check
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'direct_entry_capability_grants'
     and c.conname = 'direct_entry_capability_grants_capability_check';
  v_tokens := (length(coalesce(v_check, ''))
    - length(replace(coalesce(v_check, ''), '''::text', ''))) / length('''::text');
  if v_tokens <> 23 then
    raise exception 'capability vocabulary drifted: % tokens', v_tokens using errcode = '55000';
  end if;
end;
$$;

commit;
