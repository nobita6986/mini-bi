-- =============================================================================
-- P2.5-W02 - Multi-manager project authority foundation.
--
-- Owner policy lock implemented here:
--   * a project may have SEVERAL concurrent managers;
--   * every assignment has its own identity and a [valid_from, valid_to) history;
--   * view/propose authority uses the assignment effective AT OPERATION TIME
--     (public.direct_entry_authorization_date(), Asia/Ho_Chi_Minh);
--   * created_by, team membership, recruiter attribution and the worker's
--     first_work_date NEVER grant project authority;
--   * removal revokes runtime authority immediately and keeps history/audit.
--
-- Ordering with P3-W07E (#50, still PENDING on Production):
--   this migration is #51, i.e. it always applies AFTER #50. #50 redefines
--   direct_entry_actor_is_assigned_project_manager / _actor_has_project_assignment
--   without an interval predicate; this file supersedes BOTH definitions with the
--   interval-aware version, so a revoked or future assignment can never keep
--   authority once the ledger reaches #51.
--   T0 additionally locked that #51 must CLOSE #50's creator/team/first_work_date
--   propose fallback, so this file also redefines
--   direct_entry_resolve_change_request_scope with assignment-only authority
--   (section 3b). Applying #50 and #51 therefore never leaves the weak policy in
--   a committed, exploitable state once #51 lands; the exact apply procedure and
--   the reachability proof for the #50..#51 window are in the W02 handoff.
--
-- Reuse, not a second authorization framework: the W07B helper
-- direct_entry_actor_can_access_project keeps its signature and its callers
-- (filtered input catalog + full-profile batch guard) and only swaps the
-- single-row equality for the effective-interval predicate.
--
-- ACL posture is unchanged: the table keeps forced RLS and is revoked from
-- every role; helpers are SECURITY DEFINER with a fixed search_path and are
-- revoked from every role; only the three administration RPCs are granted to
-- service_role.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Expand the single-manager table into an assignment history.
-- -----------------------------------------------------------------------------
-- The W07B primary key on project_id is what made one manager per project
-- possible; it is replaced by an assignment identity. No row is deleted and no
-- historical value is invented: existing rows keep their project/manager pair
-- and are backfilled as an OPEN interval starting at the migration date, with
-- NULL actor/reason because the historical author is genuinely unknown.
alter table public.direct_entry_project_manager_assignments
  drop constraint direct_entry_project_manager_assignments_pkey;

alter table public.direct_entry_project_manager_assignments
  add column assignment_id uuid not null default gen_random_uuid(),
  add column valid_from date not null default public.direct_entry_authorization_date(),
  add column valid_to date,
  add column created_by_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  add column revoked_by_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  add column reason_id uuid
    references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  add column revoke_reason_id uuid
    references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  add column revoked_at timestamptz,
  add column version integer not null default 1;

alter table public.direct_entry_project_manager_assignments
  add constraint direct_entry_project_manager_assignments_pkey
    primary key (assignment_id),
  add constraint direct_entry_pm_assignment_interval_check
    check (valid_to is null or valid_to >= valid_from),
  add constraint direct_entry_pm_assignment_version_check
    check (version >= 1),
  add constraint direct_entry_pm_assignment_revocation_check
    check ((valid_to is null) = (revoked_at is null));

-- At most ONE open assignment per (project, manager) pair, and several
-- different managers may stay open on the same project.
create unique index direct_entry_pm_assignment_active_pair_idx
  on public.direct_entry_project_manager_assignments(project_id, manager_recruiter_id)
  where valid_to is null;

create index direct_entry_pm_assignment_project_effective_idx
  on public.direct_entry_project_manager_assignments(project_id, valid_from, valid_to);

comment on table public.direct_entry_project_manager_assignments is
  'P2.5-W02 multi-manager project assignment history: identity + half-open [valid_from, valid_to) interval. Runtime authority is fail-closed and exposed only through service-role SECURITY DEFINER helpers/RPCs.';
comment on column public.direct_entry_project_manager_assignments.assignment_id is
  'Assignment identity (primary key). Never reused; history is closed by setting valid_to, never by deleting the row.';
comment on column public.direct_entry_project_manager_assignments.valid_from is
  'Inclusive start of the assignment interval (half-open [valid_from, valid_to)).';
comment on column public.direct_entry_project_manager_assignments.valid_to is
  'Exclusive end of the assignment interval. NULL = still assigned. Set by unassign, never by deleting the row.';

-- -----------------------------------------------------------------------------
-- 1b. Project master: revision history + monotonic OCC version.
--
-- public.direct_entry_projects ALREADY carries
--   version integer not null default 1 check (version >= 1)
-- (P1.6 foundation, 20261002170000, table definition ~line 108), so W02 does not
-- add it. What W02 adds is the guarantee that it is actually maintained: from
-- here on EVERY project mutation -- data edit, activate/deactivate AND
-- assignment change -- takes the project row lock, compares the caller's
-- expected version (fail closed with 40001) and advances the version inside the
-- same transaction, appending one before/after project revision.
--
-- Why the assignment path must bump the project version too: a row COUNT cannot
-- see ABA (manager A removed, manager B added leaves the count unchanged), so a
-- request built from a stale snapshot would be accepted. A monotonic project
-- version can see it, and it is the single concurrency token for the whole
-- project aggregate (project data + its manager assignments).
--
-- Revision rows are append-only (same immutable trigger as the other revision
-- tables) and are NEVER backfilled: a project that predates W02 keeps an empty
-- history instead of an invented one, and its version stays 1 until the first
-- audited mutation.
-- -----------------------------------------------------------------------------
create table public.direct_entry_project_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  project_id text not null references public.direct_entry_projects(project_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  before_snapshot jsonb,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);

create index direct_entry_project_revisions_project_idx
  on public.direct_entry_project_revisions (project_id, version desc);

create trigger direct_entry_project_revisions_immutable
  before update or delete on public.direct_entry_project_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.direct_entry_project_revisions enable row level security;
alter table public.direct_entry_project_revisions force row level security;
revoke all on table public.direct_entry_project_revisions
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_project_revisions is
  'P2.5-W02 append-only project revision history (before/after + actor + reason + version), written only inside the service-role project/assignment RPCs. Never updated, never deleted, never backfilled.';
comment on column public.direct_entry_project_revisions.version is
  'The direct_entry_projects.version produced by this mutation. unique (project_id, version) makes the project version sequence auditable.';

-- The audit stream links to the revision it produced, exactly like entry,
-- submission and change-request audit events already do. Nullable and without a
-- default: no existing audit row is rewritten or invented.
alter table public.direct_entry_audit_events
  add column project_revision_id uuid
    references public.direct_entry_project_revisions(revision_id) on delete restrict;

-- -----------------------------------------------------------------------------
-- 2. Interval integrity: the same (project, manager) pair can never overlap
--    itself, and updated_at is always maintained by the database.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_project_assignment_no_overlap()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_overlap boolean;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('project-assignment:' || new.project_id, 0)
  );
  select exists (
    select 1
      from public.direct_entry_project_manager_assignments a
     where a.project_id = new.project_id
       and a.manager_recruiter_id = new.manager_recruiter_id
       and a.assignment_id <> new.assignment_id
       and daterange(a.valid_from, a.valid_to, '[)') &&
           daterange(new.valid_from, new.valid_to, '[)')
  ) into v_overlap;
  if v_overlap then
    raise exception
      'project manager assignment interval overlaps an existing assignment'
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

create trigger direct_entry_pm_assignment_no_overlap
  before insert or update of project_id, manager_recruiter_id, valid_from, valid_to
  on public.direct_entry_project_manager_assignments
  for each row execute function public.direct_entry_project_assignment_no_overlap();

create or replace function public.direct_entry_project_assignment_touch()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger direct_entry_pm_assignment_touch
  before update on public.direct_entry_project_manager_assignments
  for each row execute function public.direct_entry_project_assignment_touch();

-- Trigger functions are internal plumbing: keep them unreachable through
-- PostgREST exactly like the other internal helpers.
revoke all on function public.direct_entry_project_assignment_no_overlap()
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_project_assignment_touch()
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Authority helpers (fail-closed, effective interval only).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_project_assignment_effective(
  p_app_user_id uuid,
  p_project_id text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- Single source of truth for project authority: a VERIFIED app-user/recruiter
  -- link plus an assignment that is effective at the authorization date.
  -- created_by, team membership, recruiter attribution and first_work_date are
  -- deliberately absent from this predicate.
  select exists (
    select 1
      from public.direct_entry_project_manager_assignments a
      join public.direct_entry_app_user_recruiter_links l
        on l.recruiter_id = a.manager_recruiter_id
       and l.app_user_id = p_app_user_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
     where p_app_user_id is not null
       and (p_project_id is null or a.project_id = p_project_id)
       and a.valid_from <= public.direct_entry_authorization_date()
       and (a.valid_to is null or public.direct_entry_authorization_date() < a.valid_to)
  )
$$;

revoke all on function public.direct_entry_project_assignment_effective(uuid, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_project_assignment_effective(uuid, text) is
  'P2.5-W02 internal predicate: verified recruiter link + project manager assignment effective at the authorization date. p_project_id NULL means "any project". Revoked from every role.';

create or replace function public.direct_entry_actor_is_assigned_project_manager(
  p_app_user_id uuid,
  p_project_id text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_app_user_id is not null
     and p_project_id is not null
     and public.direct_entry_project_assignment_effective(p_app_user_id, p_project_id)
$$;

revoke all on function public.direct_entry_actor_is_assigned_project_manager(uuid, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_actor_is_assigned_project_manager(uuid, text) is
  'P2.5-W02: true only while an assignment for this project is effective at the authorization date. Supersedes the #50 definition (which had no interval predicate).';

create or replace function public.direct_entry_actor_has_project_assignment(
  p_app_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_app_user_id is not null
     and public.direct_entry_project_assignment_effective(p_app_user_id, null)
$$;

revoke all on function public.direct_entry_actor_has_project_assignment(uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_actor_has_project_assignment(uuid) is
  'P2.5-W02: true only while at least one assignment is effective at the authorization date. Supersedes the #50 definition.';

create or replace function public.direct_entry_actor_can_access_project(
  p_app_user_id uuid,
  p_project_id text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- W07B contract preserved: entry_admin + all scope bypass, otherwise the
  -- EFFECTIVE project manager assignment decides. Same signature, same callers
  -- (filtered input catalog, full-profile batch guard, draft/submission scope).
  select
    exists (
      select 1
        from public.direct_entry_capability_grants c
        join public.direct_entry_scope_grants s
          on s.app_user_id = c.app_user_id
         and s.scope_kind = 'all'
         and s.valid_from <= public.direct_entry_authorization_date()
         and (s.valid_to is null or public.direct_entry_authorization_date() < s.valid_to)
       where c.app_user_id = p_app_user_id
         and c.capability = 'entry_admin'
         and c.valid_from <= public.direct_entry_authorization_date()
         and (c.valid_to is null or public.direct_entry_authorization_date() < c.valid_to)
    )
    or public.direct_entry_project_assignment_effective(p_app_user_id, p_project_id)
$$;

revoke all on function public.direct_entry_actor_can_access_project(uuid, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_actor_can_access_project(uuid, text) is
  'P2.5-W02 fail-closed project access: entry_admin+all bypass, otherwise a verified current app-user/recruiter link must match an EFFECTIVE project manager assignment.';
-- -----------------------------------------------------------------------------
-- 3b. Close the P3-W07E (#50) proposer fallback (T0 lock).
--
-- #50 resolves a change-request scope by first calling
-- direct_entry_assert_entry_access(..., 'change_request_create',
-- created_by_user_id, team_id, first_work_date), i.e. the creator, a team member
-- or a work-date match could propose changes to submitted workers WITHOUT being
-- the project manager. That fallback is closed here: the ONLY propose authority
-- is an assignment effective at operation time, on a SUBMITTED entry, for a
-- non-DOCUMENT target. Everything else fails closed with 42501.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_resolve_change_request_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_target_kind text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
begin
  select e.* into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if p_target_kind = 'DOCUMENT' then
    raise exception 'project document change requests are not supported'
      using errcode = '42501';
  end if;

  -- No created_by, team or first_work_date fallback: a project manager is a
  -- CURRENT EFFECTIVE ASSIGNMENT, nothing else.
  if not exists (
       select 1 from public.direct_entry_submissions s
        where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
     ) or not public.direct_entry_actor_is_assigned_project_manager(
       p_app_user_id, v_entry.project_id
     ) then
    raise exception 'project change request access denied' using errcode = '42501';
  end if;
  return 'project';
end;
$$;
revoke all on function public.direct_entry_resolve_change_request_scope(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_resolve_change_request_scope(uuid, uuid, uuid, text) is
  'P2.5-W02: proposer authority is the ONLY effective project-manager assignment (SUBMITTED entries, DOCUMENT targets rejected). The P3-W07E #50 creator/team/first_work_date fallback is removed.';

-- -----------------------------------------------------------------------------
-- 4. Minimal administration RPCs: list / assign / unassign.
--
-- Every RPC requires: actor mapping, the explicit entry_admin capability, an
-- effective `all` scope grant, a non-empty reason, an idempotency key and (for
-- mutations) the expected version. Each mutation writes a restricted reason and
-- an immutable audit event. History is closed by setting valid_to; nothing is
-- deleted.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_project_admin(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'entry_admin');
  if not exists (
    select 1 from public.direct_entry_scope_grants s
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'all'
       and s.valid_from <= public.direct_entry_authorization_date()
       and (s.valid_to is null or public.direct_entry_authorization_date() < s.valid_to)
  ) then
    raise exception 'project administration requires all scope' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.direct_entry_assert_project_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_assert_project_admin(uuid, uuid) is
  'P2.5-W02 internal guard: actor mapping + entry_admin capability + effective all scope. Revoked from every role.';

-- Row lock + fail-closed OCC on the project. Every project mutation and every
-- assignment mutation goes through this function, so a stale snapshot can never
-- mutate the project aggregate, and no mutation is last-write-wins.
create or replace function public.direct_entry_lock_project(
  p_project_id text,
  p_expected_version integer
)
returns public.direct_entry_projects
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_project public.direct_entry_projects;
begin
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected project version required' using errcode = '22023';
  end if;

  select p.* into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  if v_project.version <> p_expected_version then
    raise exception 'project version conflict' using errcode = '40001';
  end if;
  return v_project;
end;
$$;
revoke all on function public.direct_entry_lock_project(text, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_lock_project(text, integer) is
  'P2.5-W02 internal guard: SELECT ... FOR UPDATE on the project row plus fail-closed expected-version check (40001 on mismatch, P0002 when absent). Revoked from every role.';

-- Single source of truth for the project projection used by the revision
-- snapshots and the admin reads. Adding a project column means touching exactly
-- this function.
create or replace function public.direct_entry_project_snapshot(
  p_project public.direct_entry_projects
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'project_id', p_project.project_id,
    'display_name', p_project.display_name,
    'active', p_project.active,
    'version', p_project.version
  )
$$;
revoke all on function public.direct_entry_project_snapshot(public.direct_entry_projects)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_project_snapshot(public.direct_entry_projects) is
  'P2.5-W02 internal projection of one project row (identity, display name, active flag, version). Revoked from every role.';

create or replace function public.direct_entry_write_project_revision(
  p_project_id text,
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
  insert into public.direct_entry_project_revisions (
    project_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_project_id, p_version, p_actor_user_id, p_reason_id, p_before_snapshot, p_after_snapshot
  ) returning revision_id into v_revision_id;
  return v_revision_id;
end;
$$;
revoke all on function public.direct_entry_write_project_revision(text, integer, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_write_project_revision(text, integer, uuid, uuid, jsonb, jsonb) is
  'P2.5-W02 internal append-only project revision writer (mirrors direct_entry_write_revision). Revoked from every role.';

-- Advance the project version and append the matching revision in one step. The
-- stored after-snapshot can never disagree with direct_entry_projects.version:
-- this function stamps the authoritative version into it.
create or replace function public.direct_entry_bump_project_version(
  p_project_id text,
  p_actor_user_id uuid,
  p_reason_id uuid,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb
)
returns table (project_version integer, revision_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_version integer;
begin
  update public.direct_entry_projects p
     set version = p.version + 1
   where p.project_id = p_project_id
  returning p.version into v_version;
  if v_version is null then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  return query
    select v_version,
           public.direct_entry_write_project_revision(
             p_project_id, v_version, p_actor_user_id, p_reason_id,
             p_before_snapshot,
             jsonb_set(
               coalesce(p_after_snapshot, '{}'::jsonb),
               '{version}', to_jsonb(v_version), true
             )
           );
end;
$$;
revoke all on function public.direct_entry_bump_project_version(text, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_bump_project_version(text, uuid, uuid, jsonb, jsonb) is
  'P2.5-W02 internal: advances direct_entry_projects.version and appends the before/after project revision in the same transaction. Callers must already hold the project row lock. Revoked from every role.';

create or replace function public.direct_entry_list_project_manager_assignments(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text default null,
  p_include_history boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_assignments jsonb;
  v_active integer;
  v_project_version integer;
  v_project_active boolean;
begin
  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
  if p_project_id is not null then
    select p.version, p.active into v_project_version, v_project_active
      from public.direct_entry_projects p
     where p.project_id = p_project_id;
    if v_project_version is null then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'assignment_id', a.assignment_id,
      'project_id', a.project_id,
      'project_version', p.version,
      'manager_recruiter_id', a.manager_recruiter_id,
      'valid_from', a.valid_from,
      'valid_to', a.valid_to,
      'effective', a.valid_from <= public.direct_entry_authorization_date()
        and (a.valid_to is null or public.direct_entry_authorization_date() < a.valid_to),
      'version', a.version,
      'revoked_at', a.revoked_at,
      'created_at', a.created_at,
      'updated_at', a.updated_at
    ) order by a.project_id, a.valid_from, a.assignment_id), '[]'::jsonb)
    into v_assignments
    from public.direct_entry_project_manager_assignments a
    join public.direct_entry_projects p on p.project_id = a.project_id
   where (p_project_id is null or a.project_id = p_project_id)
     and (p_include_history or a.valid_to is null);

  select count(*)::int into v_active
    from public.direct_entry_project_manager_assignments a
   where (p_project_id is null or a.project_id = p_project_id)
     and a.valid_to is null;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'project_id', p_project_id,
    -- The project OCC token the caller must send back on assign/unassign/update.
    'project_version', v_project_version,
    'project_active', v_project_active,
    'include_history', p_include_history,
    'active_assignment_count', v_active,
    'assignments', v_assignments
  );
end;
$$;
revoke all on function public.direct_entry_list_project_manager_assignments(uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_project_manager_assignments(uuid, uuid, text, boolean)
  to service_role;
comment on function public.direct_entry_list_project_manager_assignments(uuid, uuid, text, boolean) is
  'P2.5-W02 admin read: assignment history (identity, interval, version, effective flag) for one project or all projects. service_role only, entry_admin + all scope required.';

create or replace function public.direct_entry_assign_project_manager(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_manager_recruiter_id uuid,
  p_valid_from date,
  p_expected_project_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_project public.direct_entry_projects;
  v_valid_from date;
  v_assignment_id uuid;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;
  if p_manager_recruiter_id is null then
    raise exception 'project manager required' using errcode = '22023';
  end if;
  if p_expected_project_version is null or p_expected_project_version < 1 then
    raise exception 'expected project version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
  v_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_manager_assignment_assign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'manager_recruiter_id', p_manager_recruiter_id,
      'valid_from', v_valid_from,
      'expected_project_version', p_expected_project_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Row lock + fail-closed OCC on the PROJECT version. A count of active rows
  -- cannot detect ABA (A removed + B added keeps the count); the version can.
  v_project := public.direct_entry_lock_project(p_project_id, p_expected_project_version);
  if not v_project.active then
    raise exception 'project is not active' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = p_manager_recruiter_id and r.active
  ) then
    raise exception 'project manager recruiter is not active' using errcode = '22023';
  end if;
  -- Authority can only ever be exercised through a verified account link, so an
  -- assignment without one would be dead weight (and must not be created).
  if not exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
  ) then
    raise exception 'project manager has no verified account link' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.direct_entry_project_manager_assignments a
     where a.project_id = p_project_id
       and a.manager_recruiter_id = p_manager_recruiter_id
       and a.valid_to is null
  ) then
    raise exception 'project manager is already assigned to this project'
      using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);

  insert into public.direct_entry_project_manager_assignments
    (project_id, manager_recruiter_id, valid_from, valid_to,
     created_by_user_id, reason_id, version)
  values
    (p_project_id, p_manager_recruiter_id, v_valid_from, null,
     p_app_user_id, v_reason_id, 1)
  returning assignment_id into v_assignment_id;

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      p_project_id, p_app_user_id, v_reason_id, v_before,
      jsonb_build_object(
        'assignment_id', v_assignment_id,
        'manager_recruiter_id', p_manager_recruiter_id,
        'valid_from', v_valid_from,
        'valid_to', null,
        'change', 'ASSIGN'
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_assign',
     'entry_admin', v_assignment_id::text, 'all', 'APPLIED', v_reason_id,
     array['project_id', 'manager_recruiter_id', 'valid_from'], v_revision_id);

  v_result := jsonb_build_object(
    'assignment_id', v_assignment_id,
    'project_id', p_project_id,
    'manager_recruiter_id', p_manager_recruiter_id,
    'valid_from', v_valid_from,
    'valid_to', null,
    'version', 1,
    'project_version', v_project_version,
    'already_assigned', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_manager_assignment_assign', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text) is
  'P2.5-W02 admin assign: creates one assignment identity with an open interval. Requires entry_admin + all scope, reason, idempotency key and the expected PROJECT version (row-locked OCC, 40001 when stale). Advances the project version and appends a project revision in the same transaction. A second manager is additive; the same pair cannot be active twice.';

create or replace function public.direct_entry_unassign_project_manager(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_expected_project_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_assignment public.direct_entry_project_manager_assignments%rowtype;
  v_project public.direct_entry_projects;
  v_project_id text;
  v_revoke_to date;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_assignment_id is null then
    raise exception 'assignment required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected version required' using errcode = '22023';
  end if;
  if p_expected_project_version is null or p_expected_project_version < 1 then
    raise exception 'expected project version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'assignment_id', p_assignment_id,
      'expected_version', p_expected_version,
      'expected_project_version', p_expected_project_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Unlocked read, only to discover the project: the (assignment, project) pair
  -- is immutable, and this keeps ONE global lock order -- project row first,
  -- assignment row second -- for every RPC in this file.
  select a.project_id into v_project_id
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id = p_assignment_id;
  if v_project_id is null then
    raise exception 'project manager assignment not found' using errcode = 'P0002';
  end if;

  -- Tier 1 OCC: the project version (assignment membership changed => stale).
  v_project := public.direct_entry_lock_project(v_project_id, p_expected_project_version);

  select * into v_assignment
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id = p_assignment_id
   for update;
  if not found then
    raise exception 'project manager assignment not found' using errcode = 'P0002';
  end if;

  if v_assignment.valid_to is not null then
    -- Already revoked: replay the same outcome instead of failing. No version is
    -- advanced and no revision is appended, because nothing was mutated.
    v_result := jsonb_build_object(
      'assignment_id', v_assignment.assignment_id,
      'project_id', v_assignment.project_id,
      'valid_to', v_assignment.valid_to,
      'version', v_assignment.version,
      'project_version', v_project.version,
      'already_unassigned', true
    );
    perform public.direct_entry_idempotency_finish(
      p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key, v_result
    );
    return v_result;
  end if;

  -- Tier 2 OCC: the assignment row itself.
  if p_expected_version <> v_assignment.version then
    raise exception 'project assignment version conflict' using errcode = '40001';
  end if;

  -- Half-open interval: valid_to = today removes authority immediately. A
  -- future-dated assignment collapses to an empty interval instead of becoming
  -- retroactively effective.
  v_revoke_to := greatest(
    public.direct_entry_authorization_date(), v_assignment.valid_from
  );
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);

  update public.direct_entry_project_manager_assignments
     set valid_to = v_revoke_to,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where assignment_id = p_assignment_id;

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      v_project_id, p_app_user_id, v_reason_id, v_before,
      jsonb_build_object(
        'assignment_id', p_assignment_id,
        'manager_recruiter_id', v_assignment.manager_recruiter_id,
        'valid_to', v_revoke_to,
        'change', 'UNASSIGN'
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_unassign',
     'entry_admin', p_assignment_id::text, 'all', 'APPLIED', v_reason_id,
     array['valid_to', 'revoked_by_user_id', 'revoke_reason_id'], v_revision_id);

  v_result := jsonb_build_object(
    'assignment_id', v_assignment.assignment_id,
    'project_id', v_assignment.project_id,
    'valid_to', v_revoke_to,
    'version', v_assignment.version + 1,
    'project_version', v_project_version,
    'already_unassigned', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text)
  to service_role;
comment on function public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text) is
  'P2.5-W02 admin unassign: two-tier OCC (expected project version + expected assignment version), then closes the interval (valid_to), records revoked_by/at + revoke reason, bumps the assignment version and the project version, appends a project revision and keeps every row. Runtime authority is revoked immediately; history, audit and proposals stay.';

-- -----------------------------------------------------------------------------
-- 4b. Minimal project master RPCs (W02 scope, not the P3.1 generic admin).
--
-- create / update / list / get / activate-deactivate only. There is deliberately
-- NO hard delete: a project that was ever referenced by a worker, a report or an
-- assignment is never removable, and deactivation is the soft delete
-- (P2.5 section 2.5). Every mutation takes the actor mapping, entry_admin + an
-- effective all scope, a reason, an idempotency key and the expected project
-- version, then advances the project version and appends one project revision.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_list_projects_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_include_inactive boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_projects jsonb;
begin
  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);

  select coalesce(jsonb_agg(jsonb_build_object(
      'project_id', p.project_id,
      'display_name', p.display_name,
      'active', p.active,
      'version', p.version,
      -- Derived from the append-only revision history: created_at is the first
      -- audited mutation and updated_at the last one. A project that predates
      -- W02 has no revision, so both stay NULL instead of inventing a timestamp.
      'created_at', rev.first_revision_at,
      'updated_at', rev.last_revision_at,
      'revision_count', coalesce(rev.revision_count, 0),
      'active_assignment_count', coalesce(asg.active_count, 0)
    ) order by p.display_name, p.project_id), '[]'::jsonb)
    into v_projects
    from public.direct_entry_projects p
    left join lateral (
      select min(r.created_at) as first_revision_at,
             max(r.created_at) as last_revision_at,
             count(*)::int as revision_count
        from public.direct_entry_project_revisions r
       where r.project_id = p.project_id
    ) rev on true
    left join lateral (
      select count(*)::int as active_count
        from public.direct_entry_project_manager_assignments a
       where a.project_id = p.project_id and a.valid_to is null
    ) asg on true
   where p_include_inactive or p.active;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', p_include_inactive,
    'projects', v_projects
  );
end;
$$;
revoke all on function public.direct_entry_list_projects_admin(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_projects_admin(uuid, uuid, boolean)
  to service_role;
comment on function public.direct_entry_list_projects_admin(uuid, uuid, boolean) is
  'P2.5-W02 admin read: project master projection (identity, display name, active flag, OCC version, derived revision timestamps, active manager count). service_role only, entry_admin + all scope required.';

create or replace function public.direct_entry_get_project_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_project jsonb;
begin
  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;

  select jsonb_build_object(
      'project_id', p.project_id,
      'display_name', p.display_name,
      'active', p.active,
      'version', p.version,
      'created_at', rev.first_revision_at,
      'updated_at', rev.last_revision_at,
      'revision_count', coalesce(rev.revision_count, 0),
      'active_assignment_count', coalesce(asg.active_count, 0)
    )
    into v_project
    from public.direct_entry_projects p
    left join lateral (
      select min(r.created_at) as first_revision_at,
             max(r.created_at) as last_revision_at,
             count(*)::int as revision_count
        from public.direct_entry_project_revisions r
       where r.project_id = p.project_id
    ) rev on true
    left join lateral (
      select count(*)::int as active_count
        from public.direct_entry_project_manager_assignments a
       where a.project_id = p.project_id and a.valid_to is null
    ) asg on true
   where p.project_id = p_project_id;
  if v_project is null then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  return v_project;
end;
$$;
revoke all on function public.direct_entry_get_project_admin(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_project_admin(uuid, uuid, text)
  to service_role;
comment on function public.direct_entry_get_project_admin(uuid, uuid, text) is
  'P2.5-W02 admin read: one project master row (same projection as the admin list) or P0002. service_role only, entry_admin + all scope required.';

create or replace function public.direct_entry_create_project(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
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
  v_project public.direct_entry_projects;
  v_reason_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_project_id is null
     or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'project identifier is invalid' using errcode = '22023';
  end if;
  if p_display_name is null
     or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'project display name required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'display_name', btrim(p_display_name)
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if exists (
    select 1 from public.direct_entry_projects p where p.project_id = p_project_id
  ) then
    raise exception 'project already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.direct_entry_projects (project_id, display_name, active, version)
  values (p_project_id, btrim(p_display_name), true, 1)
  returning * into v_project;

  v_revision_id := public.direct_entry_write_project_revision(
    p_project_id, v_project.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_project_snapshot(v_project)
  );

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_create', 'entry_admin',
     p_project_id, 'all', 'APPLIED', v_reason_id,
     array['project_id', 'display_name', 'active'], v_revision_id);

  v_result := jsonb_build_object(
    'project_id', v_project.project_id,
    'display_name', v_project.display_name,
    'active', v_project.active,
    'version', v_project.version,
    'revision_id', v_revision_id,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_create_project(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_project(uuid, uuid, text, text, text, text)
  to service_role;
comment on function public.direct_entry_create_project(uuid, uuid, text, text, text, text) is
  'P2.5-W02 admin create: one new project at version 1 with an appended project revision and audit event. Requires entry_admin + all scope, reason and idempotency key. An existing identifier fails closed with 23505.';

create or replace function public.direct_entry_update_project(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
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
  v_project public.direct_entry_projects;
  v_display_name text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_after jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_display_name is null
     or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'project display name required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
  v_display_name := btrim(p_display_name);

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'expected_version', p_expected_version,
      'display_name', v_display_name
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_project := public.direct_entry_lock_project(p_project_id, p_expected_version);
  if v_project.display_name = v_display_name then
    raise exception 'project display name is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);

  update public.direct_entry_projects
     set display_name = v_display_name
   where project_id = p_project_id;

  v_after := jsonb_set(v_before, '{display_name}', to_jsonb(v_display_name), true);

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      p_project_id, p_app_user_id, v_reason_id, v_before, v_after
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_update', 'entry_admin',
     p_project_id, 'all', 'APPLIED', v_reason_id,
     array['display_name'], v_revision_id);

  v_result := jsonb_build_object(
    'project_id', p_project_id,
    'display_name', v_display_name,
    'active', v_project.active,
    'version', v_project_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text)
  to service_role;
comment on function public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text) is
  'P2.5-W02 admin update: rewrites the project display name under row-locked OCC (40001 on a stale expected version), advances the version and appends a before/after project revision plus an audit event. A no-op edit is refused with 22023 instead of writing a false revision.';

create or replace function public.direct_entry_set_project_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
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
  v_project public.direct_entry_projects;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_after jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_active is null then
    raise exception 'project active flag required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_set_active', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'active', p_active,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_project := public.direct_entry_lock_project(p_project_id, p_expected_version);
  if v_project.active = p_active then
    raise exception 'project active state is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);

  -- Soft delete only: deactivation never deletes the project, its assignments,
  -- its worker references or its reporting history.
  update public.direct_entry_projects
     set active = p_active
   where project_id = p_project_id;

  v_after := jsonb_set(v_before, '{active}', to_jsonb(p_active), true);

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      p_project_id, p_app_user_id, v_reason_id, v_before, v_after
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_set_active', 'entry_admin',
     p_project_id, 'all', 'APPLIED', v_reason_id,
     array['active'], v_revision_id);

  v_result := jsonb_build_object(
    'project_id', p_project_id,
    'display_name', v_project.display_name,
    'active', p_active,
    'version', v_project_version,
    'revision_id', v_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text)
  to service_role;
comment on function public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text) is
  'P2.5-W02 admin activate/deactivate (the plan name direct_entry_deactivate_project is covered by p_active=false). Row-locked OCC, version advance, before/after project revision and audit event. Soft delete only: the row, its assignments and all worker/report history stay.';

-- -----------------------------------------------------------------------------
-- 5. Structural, ACL and backfill self-check (data-agnostic).
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_helper text;
  v_secdef boolean;
  v_rows integer;
begin
  select string_agg(column_name, ', ') into v_missing
    from unnest(array[
      'assignment_id', 'project_id', 'manager_recruiter_id', 'valid_from',
      'valid_to', 'created_by_user_id', 'revoked_by_user_id', 'reason_id',
      'revoke_reason_id', 'revoked_at', 'version'
    ]) as expected(column_name)
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'direct_entry_project_manager_assignments'
        and c.column_name = expected.column_name
   );
  if v_missing is not null then
    raise exception 'P2.5-W02 assignment columns missing: %', v_missing;
  end if;

  if not exists (
    select 1 from pg_indexes i
     where i.schemaname = 'public'
       and i.indexname = 'direct_entry_pm_assignment_active_pair_idx'
       and i.indexdef like '%UNIQUE%'
  ) then
    raise exception 'P2.5-W02 active-pair unique index missing';
  end if;

  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.direct_entry_project_manager_assignments'::regclass
       and c.conname = 'direct_entry_pm_assignment_interval_check'
  ) then
    raise exception 'P2.5-W02 interval check missing';
  end if;

  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.direct_entry_project_manager_assignments'::regclass
       and t.tgname = 'direct_entry_pm_assignment_no_overlap'
       and not t.tgisinternal
  ) then
    raise exception 'P2.5-W02 overlap guard trigger missing';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'direct_entry_project_manager_assignments'
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'P2.5-W02 assignment RLS self-check failed';
  end if;

  if has_table_privilege('service_role',
       'public.direct_entry_project_manager_assignments',
       'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('anon',
       'public.direct_entry_project_manager_assignments', 'SELECT')
     or has_table_privilege('authenticated',
       'public.direct_entry_project_manager_assignments', 'SELECT') then
    raise exception 'P2.5-W02 assignment table ACL self-check failed';
  end if;

  for v_helper in
    select unnest(array[
      'public.direct_entry_project_assignment_effective(uuid, text)',
      'public.direct_entry_actor_is_assigned_project_manager(uuid, text)',
      'public.direct_entry_actor_has_project_assignment(uuid)',
      'public.direct_entry_actor_can_access_project(uuid, text)',
      'public.direct_entry_assert_project_admin(uuid, uuid)',
      'public.direct_entry_lock_project(text, integer)',
      'public.direct_entry_project_snapshot(public.direct_entry_projects)',
      'public.direct_entry_write_project_revision(text, integer, uuid, uuid, jsonb, jsonb)',
      'public.direct_entry_bump_project_version(text, uuid, uuid, jsonb, jsonb)',
      'public.direct_entry_resolve_change_request_scope(uuid, uuid, uuid, text)'
    ])
  loop
    select p.prosecdef into v_secdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.oid = v_helper::regprocedure
       and p.proconfig @> array['search_path=pg_catalog, public'];
    if v_secdef is null or not v_secdef then
      raise exception 'P2.5-W02 helper % must be SECURITY DEFINER with a fixed search_path', v_helper;
    end if;
    if has_function_privilege('anon', v_helper::regprocedure, 'EXECUTE')
       or has_function_privilege('authenticated', v_helper::regprocedure, 'EXECUTE')
       or has_function_privilege('service_role', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'P2.5-W02 helper % must stay revoked from every role', v_helper;
    end if;
  end loop;

  -- Trigger plumbing: not SECURITY DEFINER by design, but still unreachable.
  for v_helper in
    select unnest(array[
      'public.direct_entry_project_assignment_no_overlap()',
      'public.direct_entry_project_assignment_touch()'
    ])
  loop
    if has_function_privilege('anon', v_helper::regprocedure, 'EXECUTE')
       or has_function_privilege('authenticated', v_helper::regprocedure, 'EXECUTE')
       or has_function_privilege('service_role', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'P2.5-W02 trigger function % must stay revoked from every role', v_helper;
    end if;
  end loop;

  for v_helper in
    select unnest(array[
      'public.direct_entry_list_project_manager_assignments(uuid, uuid, text, boolean)',
      'public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text)',
      'public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text)',
      'public.direct_entry_list_projects_admin(uuid, uuid, boolean)',
      'public.direct_entry_get_project_admin(uuid, uuid, text)',
      'public.direct_entry_create_project(uuid, uuid, text, text, text, text)',
      'public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text)',
      'public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text)'
    ])
  loop
    if not has_function_privilege('service_role', v_helper::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_helper::regprocedure, 'EXECUTE')
       or has_function_privilege('authenticated', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'P2.5-W02 RPC % ACL self-check failed', v_helper;
    end if;
  end loop;

  -- Project master: the OCC column W02 relies on must really exist, the revision
  -- table must be as locked down as every other revision table, and the audit
  -- stream must be able to point at the revision it produced.
  if not exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = 'direct_entry_projects'
       and c.column_name = 'version'
       and c.is_nullable = 'NO'
  ) then
    raise exception 'P2.5-W02 project version column missing';
  end if;

  if not exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = 'direct_entry_audit_events'
       and c.column_name = 'project_revision_id'
  ) then
    raise exception 'P2.5-W02 audit project revision link missing';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'direct_entry_project_revisions'
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'P2.5-W02 project revision RLS self-check failed';
  end if;

  if has_table_privilege('service_role',
       'public.direct_entry_project_revisions',
       'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('anon',
       'public.direct_entry_project_revisions', 'SELECT')
     or has_table_privilege('authenticated',
       'public.direct_entry_project_revisions', 'SELECT') then
    raise exception 'P2.5-W02 project revision table ACL self-check failed';
  end if;

  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.direct_entry_project_revisions'::regclass
       and t.tgname = 'direct_entry_project_revisions_immutable'
       and not t.tgisinternal
  ) then
    raise exception 'P2.5-W02 project revision immutability trigger missing';
  end if;

  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.direct_entry_project_revisions'::regclass
       and c.contype = 'u'
  ) then
    raise exception 'P2.5-W02 project revision (project_id, version) uniqueness missing';
  end if;

  -- Backfill invariants: every pre-existing row became an OPEN assignment with an
  -- identity, and no row claims a revocation it cannot prove.
  select count(*)::int into v_rows
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id is null
      or (a.valid_to is not null and a.revoked_at is null)
      or (a.valid_to is null and a.revoked_at is not null)
      or a.valid_to < a.valid_from;
  if v_rows <> 0 then
    raise exception 'P2.5-W02 assignment backfill invariant failed on % row(s)', v_rows;
  end if;

  -- Project revisions are only ever backfilled by an audited mutation, so at
  -- migration time the table must be empty, and any row that exists later must
  -- describe the version it claims to describe.
  select count(*)::int into v_rows
    from public.direct_entry_project_revisions r
   where r.after_snapshot->>'project_id' is distinct from r.project_id
      or (r.after_snapshot->>'version')::int is distinct from r.version;
  if v_rows <> 0 then
    raise exception 'P2.5-W02 project revision invariant failed on % row(s)', v_rows;
  end if;

  raise notice 'P2.5-W02 migration self-check OK (multi-manager assignment history + project master OCC/revisions + effective authority helpers)';
end
$$;

commit;
