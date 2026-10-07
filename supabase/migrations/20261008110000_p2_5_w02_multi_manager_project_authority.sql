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
begin
  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
  if p_project_id is not null and not exists (
    select 1 from public.direct_entry_projects p where p.project_id = p_project_id
  ) then
    raise exception 'project not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'assignment_id', a.assignment_id,
      'project_id', a.project_id,
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
   where (p_project_id is null or a.project_id = p_project_id)
     and (p_include_history or a.valid_to is null);

  select count(*)::int into v_active
    from public.direct_entry_project_manager_assignments a
   where (p_project_id is null or a.project_id = p_project_id)
     and a.valid_to is null;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'project_id', p_project_id,
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
  p_expected_active_count integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_valid_from date;
  v_active integer;
  v_assignment_id uuid;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;
  if p_manager_recruiter_id is null then
    raise exception 'project manager required' using errcode = '22023';
  end if;
  if p_expected_active_count is null or p_expected_active_count < 0 then
    raise exception 'expected active assignment count required' using errcode = '22023';
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
      'expected_active_count', p_expected_active_count
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if not exists (
    select 1 from public.direct_entry_projects p
     where p.project_id = p_project_id and p.active
  ) then
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

  perform pg_advisory_xact_lock(
    hashtextextended('project-assignment:' || p_project_id, 0)
  );

  select count(*)::int into v_active
    from public.direct_entry_project_manager_assignments a
   where a.project_id = p_project_id and a.valid_to is null;
  if v_active <> p_expected_active_count then
    raise exception 'project assignment version conflict' using errcode = '40001';
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

  insert into public.direct_entry_project_manager_assignments
    (project_id, manager_recruiter_id, valid_from, valid_to,
     created_by_user_id, reason_id, version)
  values
    (p_project_id, p_manager_recruiter_id, v_valid_from, null,
     p_app_user_id, v_reason_id, 1)
  returning assignment_id into v_assignment_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_assign',
     'entry_admin', v_assignment_id::text, 'all', 'APPLIED', v_reason_id,
     array['project_id', 'manager_recruiter_id', 'valid_from']);

  v_result := jsonb_build_object(
    'assignment_id', v_assignment_id,
    'project_id', p_project_id,
    'manager_recruiter_id', p_manager_recruiter_id,
    'valid_from', v_valid_from,
    'valid_to', null,
    'version', 1,
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
  'P2.5-W02 admin assign: creates one assignment identity with an open interval. Requires entry_admin + all scope, reason, idempotency key and the expected active-assignment count (OCC). A second manager is additive; the same pair cannot be active twice.';

create or replace function public.direct_entry_unassign_project_manager(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
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
  v_assignment public.direct_entry_project_manager_assignments%rowtype;
  v_revoke_to date;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_assignment_id is null then
    raise exception 'assignment required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected version required' using errcode = '22023';
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
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  select * into v_assignment
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id = p_assignment_id
   for update;
  if not found then
    raise exception 'project manager assignment not found' using errcode = 'P0002';
  end if;

  if v_assignment.valid_to is not null then
    -- Already revoked: replay the same outcome instead of failing.
    v_result := jsonb_build_object(
      'assignment_id', v_assignment.assignment_id,
      'project_id', v_assignment.project_id,
      'valid_to', v_assignment.valid_to,
      'version', v_assignment.version,
      'already_unassigned', true
    );
    perform public.direct_entry_idempotency_finish(
      p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key, v_result
    );
    return v_result;
  end if;

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

  update public.direct_entry_project_manager_assignments
     set valid_to = v_revoke_to,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where assignment_id = p_assignment_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_unassign',
     'entry_admin', p_assignment_id::text, 'all', 'APPLIED', v_reason_id,
     array['valid_to', 'revoked_by_user_id', 'revoke_reason_id']);

  v_result := jsonb_build_object(
    'assignment_id', v_assignment.assignment_id,
    'project_id', v_assignment.project_id,
    'valid_to', v_revoke_to,
    'version', v_assignment.version + 1,
    'already_unassigned', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, text, text)
  to service_role;
comment on function public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, text, text) is
  'P2.5-W02 admin unassign: closes the interval (valid_to), records revoked_by/at + revoke reason, bumps the version and keeps the row. Runtime authority is revoked immediately; history, audit and proposals stay.';

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
      'public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, text, text)'
    ])
  loop
    if not has_function_privilege('service_role', v_helper::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_helper::regprocedure, 'EXECUTE')
       or has_function_privilege('authenticated', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'P2.5-W02 RPC % ACL self-check failed', v_helper;
    end if;
  end loop;

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

  raise notice 'P2.5-W02 migration self-check OK (multi-manager assignment history + effective authority helpers)';
end
$$;

commit;
