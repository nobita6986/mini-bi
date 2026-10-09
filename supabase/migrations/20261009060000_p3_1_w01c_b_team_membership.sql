-- =============================================================================
-- P3.1-W01C-B - Team membership lifecycle backend (#70, append-only).
--
-- Scope: assign / move / unassign a HRP person to a business team, plus the three
-- bounded reads (current, scheduled, history). Leader lifecycle (W01D),
-- project-manager assignment (W02), Vendor lifecycle, labor type, account/grant/link
-- administration and UI are explicitly out of scope and are not touched here.
--
-- Authority reuses the single guard introduced by #68,
-- public.direct_entry_assert_catalog_operator: the legacy Full Admin triple
-- (entry_admin + recruiter_master_manage + team_master_manage) OR
-- catalog_master_manage, both with an effective 'all' scope. No second catalog
-- guard exists, and the guard returns the authority actually used so audit records
-- entry_admin or catalog_master_manage - never a role name, an email or
-- personnel_position.
--
-- Interval model: half-open [valid_from, valid_to). #70 relaxes the three existing
-- interval CHECKs from 'valid_to > valid_from' to 'valid_to >= valid_from' so a
-- ZERO-LENGTH interval can exist as a first-class cancellation marker: it is never
-- effective on any date, it is never deleted and its valid_from is never rewritten.
-- Because an empty daterange never overlaps another range, a marker coexists with
-- the replacement interval that starts the same day; the membership uniqueness
-- constraint therefore becomes a partial unique index that ignores markers.
-- Only the audited mutation RPCs may write a marker (transaction-local flag).
--
-- Aggregate root: public.recruiters. One mutation = exactly one version bump on the
-- locked recruiter row, one immutable membership revision with a fixed six-key
-- snapshot, and one audit event bound to that revision.
--
-- ACL posture: the revision table is forced RLS and revoked from every role;
-- internal helpers are SECURITY DEFINER with a fixed search_path and revoked from
-- every role; only the six administration RPCs are granted to service_role.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Interval cancellation foundation.
-- -----------------------------------------------------------------------------
alter table public.recruiter_team_memberships
  drop constraint recruiter_team_memberships_check;
alter table public.recruiter_team_memberships
  add constraint recruiter_team_memberships_check
  check (valid_to is null or valid_to >= valid_from);

alter table public.direct_entry_scope_grants
  drop constraint direct_entry_scope_grants_check;
alter table public.direct_entry_scope_grants
  add constraint direct_entry_scope_grants_check
  check (valid_to is null or valid_to >= valid_from);

alter table public.direct_entry_capability_grants
  drop constraint direct_entry_capability_grants_check;
alter table public.direct_entry_capability_grants
  add constraint direct_entry_capability_grants_check
  check (valid_to is null or valid_to >= valid_from);

comment on constraint recruiter_team_memberships_check on public.recruiter_team_memberships is
  'P3.1-W01C-B: half-open [valid_from, valid_to). valid_to = valid_from is a cancellation marker: inert on every date, kept, never re-dated.';
comment on constraint direct_entry_scope_grants_check on public.direct_entry_scope_grants is
  'P3.1-W01C-B: valid_to = valid_from is accepted as an inert zero-length interval; every effective-date predicate ignores it. No W01C-B RPC writes scope grants.';
comment on constraint direct_entry_capability_grants_check on public.direct_entry_capability_grants is
  'P3.1-W01C-B: valid_to = valid_from is accepted as an inert zero-length interval; every effective-date predicate ignores it. No W01C-B RPC writes capability grants.';

-- Membership uniqueness must ignore inert markers, otherwise a cancellation
-- marker would block the replacement interval that starts on the same date.
alter table public.recruiter_team_memberships
  drop constraint recruiter_team_memberships_recruiter_id_valid_from_key;
create unique index recruiter_team_memberships_open_start_uidx
  on public.recruiter_team_memberships (recruiter_id, valid_from)
  where valid_to is null or valid_to > valid_from;
comment on index public.recruiter_team_memberships_open_start_uidx is
  'P3.1-W01C-B: at most one live interval per recruiter and start date. Zero-length cancellation markers are excluded so a same-day move can close the outgoing interval and open the incoming one.';

-- -----------------------------------------------------------------------------
-- 2. Append-only membership revision history rooted on the recruiter aggregate.
-- -----------------------------------------------------------------------------
create table public.direct_entry_team_membership_revisions (
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

create index direct_entry_team_membership_revisions_recruiter_idx
  on public.direct_entry_team_membership_revisions (recruiter_id, version desc);

create trigger direct_entry_team_membership_revisions_immutable
  before update or delete on public.direct_entry_team_membership_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.direct_entry_team_membership_revisions enable row level security;
alter table public.direct_entry_team_membership_revisions force row level security;
revoke all on table public.direct_entry_team_membership_revisions
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_team_membership_revisions is
  'P3.1-W01C-B append-only team membership revision history (fixed six-key snapshot + actor + reason + recruiter version), written only inside the service-role membership RPCs. Never updated, never deleted, never backfilled.';
comment on column public.direct_entry_team_membership_revisions.version is
  'The public.recruiters.version produced by this mutation. unique (recruiter_id, version) makes the membership version sequence auditable.';

alter table public.direct_entry_audit_events
  add column team_membership_revision_id uuid
    references public.direct_entry_team_membership_revisions(revision_id) on delete restrict;

-- -----------------------------------------------------------------------------
-- 3. Write guards: cancellation markers and the Vendor provider boundary.
-- -----------------------------------------------------------------------------
-- A zero-length membership interval is a cancellation marker. Only the audited
-- mutation RPCs (reason + OCC + idempotency + revision + audit) may write one; they
-- announce it with a transaction-local flag. Raw DML fails closed.
create or replace function public.direct_entry_guard_membership_cancel_marker()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.valid_to is not null and new.valid_to = new.valid_from
     and coalesce(current_setting('direct_entry.membership_cancel_marker', true), '') <> 'on' then
    raise exception 'membership cancellation marker requires the audited mutation path'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_guard_membership_cancel_marker()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_guard_membership_cancel_marker() is
  'P3.1-W01C-B trigger: rejects a zero-length membership interval written outside the audited mutation RPCs. Revoked from every role.';

create trigger direct_entry_membership_cancel_marker_guard
  before insert or update of valid_from, valid_to on public.recruiter_team_memberships
  for each row execute function public.direct_entry_guard_membership_cancel_marker();

-- F4 defense in depth: a business-team membership may never be written for a
-- recruiter whose provider membership is Vendor at the interval start. Migration
-- #65 keeps its own reserved-team trigger on this table, untouched.
create or replace function public.direct_entry_reject_vendor_provider_team_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
      from public.recruiter_provider_memberships m
     where m.recruiter_id = new.recruiter_id
       and m.provider_type = 'vendor'
       and m.valid_from <= new.valid_from
       and (m.valid_to is null or new.valid_from < m.valid_to)
  ) then
    raise exception 'a Vendor provider recruiter cannot hold a business team membership'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_reject_vendor_provider_team_membership()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_reject_vendor_provider_team_membership() is
  'P3.1-W01C-B trigger (F4): rejects any membership row for a recruiter whose provider membership is Vendor at the interval start, including raw DML. Revoked from every role.';

create trigger direct_entry_no_vendor_provider_team_membership
  before insert or update of recruiter_id, team_id, valid_from on public.recruiter_team_memberships
  for each row execute function public.direct_entry_reject_vendor_provider_team_membership();

-- -----------------------------------------------------------------------------
-- 4. Internal helpers: subject lock/OCC, target validation, attribution guard,
--    fixed snapshot, shared projection, revision writer and version bump.
-- -----------------------------------------------------------------------------
-- A membership subject is exactly a business HRP person: an existing recruiter,
-- active, with a canonical effective HRP provider membership (provider_type 'hrp',
-- vendor_id null). A Vendor recruiter, a recruiter with no provider membership and
-- an expired or not-yet-effective membership are all simply not found, so the three
-- mutations fail closed with P0002 before touching an interval.
create or replace function public.direct_entry_lock_membership_subject(
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
    raise exception 'recruiter required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected recruiter version required' using errcode = '22023';
  end if;

  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id
     and r.active
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and m.valid_from <= public.direct_entry_authorization_date()
          and (m.valid_to is null
               or public.direct_entry_authorization_date() < m.valid_to)
     )
   for update;
  if not found then
    raise exception 'membership subject not found' using errcode = 'P0002';
  end if;
  if v_recruiter.version <> p_expected_version then
    raise exception 'recruiter version conflict' using errcode = '40001';
  end if;
  return v_recruiter;
end;
$$;
revoke all on function public.direct_entry_lock_membership_subject(uuid, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_lock_membership_subject(uuid, integer) is
  'P3.1-W01C-B internal guard: SELECT ... FOR UPDATE on the recruiter aggregate root, active + canonical effective HRP provider membership required (P0002 otherwise), expected-version check (40001 on mismatch). Revoked from every role.';

-- The target team must exist and be active. The reserved Vendor system team passes
-- this check and is then rejected by the #65 trigger with 23514, so the reserved
-- boundary stays a single trigger-owned rule instead of an RPC special case.
create or replace function public.direct_entry_assert_membership_target_team(
  p_team_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_team_id is null then
    raise exception 'target team required' using errcode = '22023';
  end if;
  if exists (select 1 from public.teams t where t.team_id = p_team_id and t.active) then
    return;
  end if;
  if exists (select 1 from public.teams t where t.team_id = p_team_id) then
    raise exception 'target team is inactive' using errcode = '23514';
  end if;
  raise exception 'target team not found' using errcode = 'P0002';
end;
$$;
revoke all on function public.direct_entry_assert_membership_target_team(uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_assert_membership_target_team(uuid) is
  'P3.1-W01C-B internal guard: the assign/move target team must exist (P0002) and be active (23514). Revoked from every role.';

-- Back-dated attribution protection (F5): a membership change that takes effect on
-- p_effective_date must not change the team resolved for a business date already
-- used by an existing direct_entry of the same person. p_target_team_id is the team
-- that would resolve from that date onwards (NULL for unassign/cancel).
create or replace function public.direct_entry_membership_attribution_conflict(
  p_recruiter_id uuid,
  p_effective_date date,
  p_target_team_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.direct_entries e
     where e.recruiter_id = p_recruiter_id
       and e.first_work_date >= p_effective_date
       and e.team_id is distinct from p_target_team_id
  )
$$;
revoke all on function public.direct_entry_membership_attribution_conflict(uuid, date, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_membership_attribution_conflict(uuid, date, uuid) is
  'P3.1-W01C-B internal guard: true when an existing direct_entry of this recruiter, dated on or after the effective date, was attributed to a different team than the change would resolve. Never rewrites the stored entry. Revoked from every role.';

-- One FIXED revision schema: exactly these six keys, for every action.
create or replace function public.direct_entry_team_membership_snapshot(
  p_recruiter_id uuid,
  p_team_id uuid,
  p_valid_from date,
  p_valid_to date,
  p_version integer,
  p_change text
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'team_id', p_team_id,
    'valid_from', to_jsonb(p_valid_from),
    'valid_to', to_jsonb(p_valid_to),
    'version', p_version,
    'change', p_change
  )
$$;
revoke all on function public.direct_entry_team_membership_snapshot(uuid, uuid, date, date, integer, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_team_membership_snapshot(uuid, uuid, date, date, integer, text) is
  'P3.1-W01C-B internal fixed six-key membership snapshot (recruiter_id, team_id, valid_from, valid_to, version, change). No actor mapping, email, app-user id, grant, scope or reason text. Revoked from every role.';

-- Shared bounded projection for the three reads, so current, scheduled and history
-- can never drift. The state is derived from the same predicate that selects the
-- read, and an inert marker is always HISTORY.
create or replace function public.direct_entry_team_membership_projection(
  p_membership public.recruiter_team_memberships,
  p_team_display_name text,
  p_recruiter_version integer
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'membership_id', p_membership.membership_id,
    'recruiter_id', p_membership.recruiter_id,
    'team_id', p_membership.team_id,
    'team_display_name', p_team_display_name,
    'valid_from', to_jsonb(p_membership.valid_from),
    'valid_to', to_jsonb(p_membership.valid_to),
    'recruiter_version', p_recruiter_version,
    'state', case
      when p_membership.valid_to is not null
           and p_membership.valid_to = p_membership.valid_from then 'HISTORY'
      when p_membership.valid_from > public.direct_entry_authorization_date() then 'SCHEDULED'
      when p_membership.valid_to is null
           or public.direct_entry_authorization_date() < p_membership.valid_to then 'CURRENT'
      else 'HISTORY'
    end
  )
$$;
revoke all on function public.direct_entry_team_membership_projection(public.recruiter_team_memberships, text, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_team_membership_projection(public.recruiter_team_memberships, text, integer) is
  'P3.1-W01C-B internal bounded membership projection: membership_id, recruiter_id, team_id, team_display_name, valid_from, valid_to, recruiter_version, state. No auth_subject, email, app-user id, grant, scope or reason text. Revoked from every role.';

create or replace function public.direct_entry_write_team_membership_revision(
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
  insert into public.direct_entry_team_membership_revisions (
    recruiter_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_recruiter_id, p_version, p_actor_user_id, p_reason_id, p_before_snapshot, p_after_snapshot
  ) returning revision_id into v_revision_id;
  return v_revision_id;
end;
$$;
revoke all on function public.direct_entry_write_team_membership_revision(uuid, integer, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_write_team_membership_revision(uuid, integer, uuid, uuid, jsonb, jsonb) is
  'P3.1-W01C-B internal append-only membership revision writer. Revoked from every role.';

-- Advance the recruiter aggregate version and append the matching membership
-- revision in one step, so the stored after-snapshot can never disagree with the
-- version it was written at.
create or replace function public.direct_entry_bump_membership_version(
  p_recruiter_id uuid,
  p_actor_user_id uuid,
  p_reason_id uuid,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb
)
returns table (recruiter_version integer, revision_id uuid)
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
    raise exception 'membership subject not found' using errcode = 'P0002';
  end if;
  return query
    select v_version,
           public.direct_entry_write_team_membership_revision(
             p_recruiter_id, v_version, p_actor_user_id, p_reason_id,
             p_before_snapshot,
             jsonb_set(
               coalesce(p_after_snapshot, '{}'::jsonb),
               '{version}', to_jsonb(v_version), true
             )
           );
end;
$$;
revoke all on function public.direct_entry_bump_membership_version(uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_bump_membership_version(uuid, uuid, uuid, jsonb, jsonb) is
  'P3.1-W01C-B internal: advances public.recruiters.version by exactly one and appends the before/after membership revision in the same transaction. Callers must already hold the recruiter row lock. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 5. Bounded reads: current, scheduled and history are disjoint and together
--    cover every membership row exactly once.
-- -----------------------------------------------------------------------------

create or replace function public.direct_entry_list_team_membership_current(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid default null,
  p_team_id uuid default null,
  p_search text default null,
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
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_memberships jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid membership search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.recruiter_team_memberships m
    join public.teams t on t.team_id = m.team_id
    join public.recruiters r on r.recruiter_id = m.recruiter_id
   where (m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from))
     and (p_recruiter_id is null or m.recruiter_id = p_recruiter_id)
     and (p_team_id is null or m.team_id = p_team_id)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
       or r.display_name ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(entry.projection), '[]'::jsonb)
    into v_memberships
    from (
      select public.direct_entry_team_membership_projection(m, t.display_name, r.version)
               as projection
        from public.recruiter_team_memberships m
        join public.teams t on t.team_id = m.team_id
        join public.recruiters r on r.recruiter_id = m.recruiter_id
       where (m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from))
         and (p_recruiter_id is null or m.recruiter_id = p_recruiter_id)
         and (p_team_id is null or m.team_id = p_team_id)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
           or r.display_name ilike '%' || v_search || '%'
         )
       order by t.display_name, m.membership_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) entry;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'memberships', v_memberships
  );
end;
$$;
revoke all on function public.direct_entry_list_team_membership_current(uuid, uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_team_membership_current(uuid, uuid, uuid, uuid, text, integer, integer)
  to service_role;
comment on function public.direct_entry_list_team_membership_current(uuid, uuid, uuid, uuid, text, integer, integer) is
  'P3.1-W01C-B bounded read: memberships effective at the authorization date. A closed interval and an inert cancellation marker never appear here. service_role only; catalog operator + all scope required.';


create or replace function public.direct_entry_list_team_membership_scheduled(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid default null,
  p_team_id uuid default null,
  p_search text default null,
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
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_memberships jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid membership search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.recruiter_team_memberships m
    join public.teams t on t.team_id = m.team_id
    join public.recruiters r on r.recruiter_id = m.recruiter_id
   where (m.valid_from > public.direct_entry_authorization_date()
       and (m.valid_to is null or m.valid_to > m.valid_from))
     and (p_recruiter_id is null or m.recruiter_id = p_recruiter_id)
     and (p_team_id is null or m.team_id = p_team_id)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
       or r.display_name ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(entry.projection), '[]'::jsonb)
    into v_memberships
    from (
      select public.direct_entry_team_membership_projection(m, t.display_name, r.version)
               as projection
        from public.recruiter_team_memberships m
        join public.teams t on t.team_id = m.team_id
        join public.recruiters r on r.recruiter_id = m.recruiter_id
       where (m.valid_from > public.direct_entry_authorization_date()
       and (m.valid_to is null or m.valid_to > m.valid_from))
         and (p_recruiter_id is null or m.recruiter_id = p_recruiter_id)
         and (p_team_id is null or m.team_id = p_team_id)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
           or r.display_name ilike '%' || v_search || '%'
         )
       order by m.valid_from, m.membership_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) entry;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'memberships', v_memberships
  );
end;
$$;
revoke all on function public.direct_entry_list_team_membership_scheduled(uuid, uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_team_membership_scheduled(uuid, uuid, uuid, uuid, text, integer, integer)
  to service_role;
comment on function public.direct_entry_list_team_membership_scheduled(uuid, uuid, uuid, uuid, text, integer, integer) is
  'P3.1-W01C-B bounded read: not-yet-effective memberships. A cancelled future interval survives as an inert marker and is reported by the history read, never here. service_role only; catalog operator + all scope required.';


create or replace function public.direct_entry_list_team_membership_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid default null,
  p_team_id uuid default null,
  p_search text default null,
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
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_memberships jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid membership search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.recruiter_team_memberships m
    join public.teams t on t.team_id = m.team_id
    join public.recruiters r on r.recruiter_id = m.recruiter_id
   where ((m.valid_to is not null and m.valid_to <= m.valid_from)
       or (m.valid_to is not null and m.valid_to <= public.direct_entry_authorization_date()))
     and (p_recruiter_id is null or m.recruiter_id = p_recruiter_id)
     and (p_team_id is null or m.team_id = p_team_id)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
       or r.display_name ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(entry.projection), '[]'::jsonb)
    into v_memberships
    from (
      select public.direct_entry_team_membership_projection(m, t.display_name, r.version)
               as projection
        from public.recruiter_team_memberships m
        join public.teams t on t.team_id = m.team_id
        join public.recruiters r on r.recruiter_id = m.recruiter_id
       where ((m.valid_to is not null and m.valid_to <= m.valid_from)
       or (m.valid_to is not null and m.valid_to <= public.direct_entry_authorization_date()))
         and (p_recruiter_id is null or m.recruiter_id = p_recruiter_id)
         and (p_team_id is null or m.team_id = p_team_id)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
           or r.display_name ilike '%' || v_search || '%'
         )
       order by m.valid_from desc, m.membership_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) entry;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'memberships', v_memberships
  );
end;
$$;
revoke all on function public.direct_entry_list_team_membership_history(uuid, uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_team_membership_history(uuid, uuid, uuid, uuid, text, integer, integer)
  to service_role;
comment on function public.direct_entry_list_team_membership_history(uuid, uuid, uuid, uuid, text, integer, integer) is
  'P3.1-W01C-B bounded read: closed intervals and inert zero-length cancellation markers, newest first. service_role only; catalog operator + all scope required.';

-- -----------------------------------------------------------------------------
-- 6. Mutations: assign, move, unassign. Each one is a single transaction:
--    guard -> validate -> idempotency begin -> lock recruiter (OCC) -> validate the
--    target team -> attribution guard -> interval write -> version bump -> revision
--    -> audit -> idempotency finish. Any raise unwinds all of it (zero residue).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assign_team_membership(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid,
  p_team_id uuid,
  p_valid_from date,
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
  v_subject public.recruiters;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_changed text[];
  v_prior jsonb;
  v_result jsonb;
begin
  -- Authorization first: an actor without catalog authority always gets 42501 and
  -- learns nothing about the shape of the input.
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null or p_team_id is null then
    raise exception 'recruiter and target team required' using errcode = '22023';
  end if;
  if p_valid_from is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_assign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'team_id', p_team_id,
      'valid_from', p_valid_from,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_subject := public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
  perform public.direct_entry_assert_membership_target_team(p_team_id);

  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_from, p_team_id) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- The overlap trigger is the only authority on "at most one effective
  -- membership": no pre-check here, and the recruiter row is already locked.
  insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)
  values (p_recruiter_id, p_team_id, p_valid_from)
  returning * into v_membership;

  v_changed := array['team_id', 'valid_from'];
  if p_valid_from < public.direct_entry_authorization_date() then
    v_changed := array_append(v_changed, 'backdated');
  end if;

  select b.recruiter_version, b.revision_id
    into v_recruiter_version, v_revision_id
    from public.direct_entry_bump_membership_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      null,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, p_team_id, p_valid_from, null, v_subject.version + 1, 'ASSIGN'
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome,
     reason_id, changed_fields, team_membership_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_membership_assign', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id, v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'membership_id', v_membership.membership_id,
    'recruiter_id', p_recruiter_id,
    'team_id', p_team_id,
    'valid_from', to_jsonb(v_membership.valid_from),
    'valid_to', to_jsonb(v_membership.valid_to),
    'recruiter_version', v_recruiter_version,
    'revision_id', v_revision_id,
    'change', 'ASSIGN'
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_membership_assign', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_assign_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_assign_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_assign_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text) is
  'P3.1-W01C-B mutation: opens one half-open membership interval for an eligible HRP person in an active business team, bumping the recruiter aggregate version once with a membership revision and one audit event. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_move_team_membership(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid,
  p_team_id uuid,
  p_valid_from date,
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
  v_subject public.recruiters;
  v_open public.recruiter_team_memberships;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_changed text[];
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null or p_team_id is null then
    raise exception 'recruiter and target team required' using errcode = '22023';
  end if;
  if p_valid_from is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_move', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'team_id', p_team_id,
      'valid_from', p_valid_from,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_subject := public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
  perform public.direct_entry_assert_membership_target_team(p_team_id);

  select m.* into v_open
    from public.recruiter_team_memberships m
   where m.recruiter_id = p_recruiter_id
     and m.valid_to is null
   order by m.valid_from desc
   limit 1;
  if not found then
    raise exception 'no open membership to move' using errcode = '22023';
  end if;
  if v_open.team_id = p_team_id then
    raise exception 'membership already targets this team' using errcode = '22023';
  end if;
  if p_valid_from < v_open.valid_from then
    raise exception 'move date precedes the open membership' using errcode = '22023';
  end if;
  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_from, p_team_id) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Same-day move collapses the outgoing interval into an inert cancellation
  -- marker; that write is announced so the marker guard accepts it.
  if p_valid_from = v_open.valid_from then
    perform set_config('direct_entry.membership_cancel_marker', 'on', true);
  end if;

  update public.recruiter_team_memberships
     set valid_to = p_valid_from
   where membership_id = v_open.membership_id;

  insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)
  values (p_recruiter_id, p_team_id, p_valid_from)
  returning * into v_membership;

  v_changed := array['team_id', 'valid_to'];
  if p_valid_from = v_open.valid_from then
    v_changed := array_append(v_changed, 'cancellation_marker');
  end if;
  if p_valid_from < public.direct_entry_authorization_date() then
    v_changed := array_append(v_changed, 'backdated');
  end if;

  select b.recruiter_version, b.revision_id
    into v_recruiter_version, v_revision_id
    from public.direct_entry_bump_membership_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, v_open.team_id, v_open.valid_from, v_open.valid_to,
        v_subject.version, 'MOVE'
      ),
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, p_team_id, p_valid_from, null, v_subject.version + 1, 'MOVE'
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome,
     reason_id, changed_fields, team_membership_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_membership_move', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id, v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'membership_id', v_membership.membership_id,
    'recruiter_id', p_recruiter_id,
    'team_id', p_team_id,
    'valid_from', to_jsonb(v_membership.valid_from),
    'valid_to', to_jsonb(v_membership.valid_to),
    'recruiter_version', v_recruiter_version,
    'revision_id', v_revision_id,
    'change', 'MOVE'
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_membership_move', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text) is
  'P3.1-W01C-B mutation: closes the open interval and opens the incoming one on the same date in a single transaction, one version bump, one revision and one audit event. A same-day move leaves the outgoing interval as an inert cancellation marker. service_role only; catalog operator + all scope required.';

create or replace function public.direct_entry_unassign_team_membership(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid,
  p_valid_to date,
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
  v_subject public.recruiters;
  v_open public.recruiter_team_memberships;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_change text;
  v_changed text[];
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null then
    raise exception 'recruiter required' using errcode = '22023';
  end if;
  if p_valid_to is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_unassign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'valid_to', p_valid_to,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_subject := public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);

  -- No target-team check on purpose: an existing membership in a team that has
  -- since become inactive stays readable and must remain closable.
  select m.* into v_open
    from public.recruiter_team_memberships m
   where m.recruiter_id = p_recruiter_id
     and m.valid_to is null
   order by m.valid_from desc
   limit 1;
  if not found then
    raise exception 'no open membership to unassign' using errcode = '22023';
  end if;
  if p_valid_to < v_open.valid_from then
    raise exception 'unassign date precedes the open membership' using errcode = '22023';
  end if;
  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_to, null) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_change := case when p_valid_to = v_open.valid_from then 'CANCEL' else 'UNASSIGN' end;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  if v_change = 'CANCEL' then
    perform set_config('direct_entry.membership_cancel_marker', 'on', true);
  end if;

  update public.recruiter_team_memberships
     set valid_to = p_valid_to
   where membership_id = v_open.membership_id
  returning * into v_membership;

  v_changed := array['valid_to'];
  if v_change = 'CANCEL' then
    v_changed := array_append(v_changed, 'cancellation_marker');
  end if;
  if p_valid_to < public.direct_entry_authorization_date() then
    v_changed := array_append(v_changed, 'backdated');
  end if;

  select b.recruiter_version, b.revision_id
    into v_recruiter_version, v_revision_id
    from public.direct_entry_bump_membership_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, v_open.team_id, v_open.valid_from, v_open.valid_to,
        v_subject.version, v_change
      ),
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, v_open.team_id, v_open.valid_from, p_valid_to,
        v_subject.version + 1, v_change
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome,
     reason_id, changed_fields, team_membership_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_membership_unassign', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id, v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'membership_id', v_membership.membership_id,
    'recruiter_id', p_recruiter_id,
    'team_id', v_membership.team_id,
    'valid_from', to_jsonb(v_membership.valid_from),
    'valid_to', to_jsonb(v_membership.valid_to),
    'recruiter_version', v_recruiter_version,
    'revision_id', v_revision_id,
    'change', v_change
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_membership_unassign', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text) is
  'P3.1-W01C-B mutation: closes the open interval without creating a replacement. Closing on the interval start date leaves an inert cancellation marker. service_role only; catalog operator + all scope required.';

-- -----------------------------------------------------------------------------
-- 7. Self-check: interval foundation, guards, revision contract and ACL.
-- -----------------------------------------------------------------------------
do $$
declare
  v_rpcs text[] := array[
    'public.direct_entry_list_team_membership_current(uuid,uuid,uuid,uuid,text,integer,integer)',
    'public.direct_entry_list_team_membership_scheduled(uuid,uuid,uuid,uuid,text,integer,integer)',
    'public.direct_entry_list_team_membership_history(uuid,uuid,uuid,uuid,text,integer,integer)',
    'public.direct_entry_assign_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)',
    'public.direct_entry_move_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)',
    'public.direct_entry_unassign_team_membership(uuid,uuid,uuid,date,integer,text,text)'
  ];
  v_helpers text[] := array[
    'public.direct_entry_lock_membership_subject(uuid,integer)',
    'public.direct_entry_assert_membership_target_team(uuid)',
    'public.direct_entry_membership_attribution_conflict(uuid,date,uuid)',
    'public.direct_entry_team_membership_snapshot(uuid,uuid,date,date,integer,text)',
    'public.direct_entry_team_membership_projection(public.recruiter_team_memberships,text,integer)',
    'public.direct_entry_write_team_membership_revision(uuid,integer,uuid,uuid,jsonb,jsonb)',
    'public.direct_entry_bump_membership_version(uuid,uuid,uuid,jsonb,jsonb)',
    'public.direct_entry_guard_membership_cancel_marker()',
    'public.direct_entry_reject_vendor_provider_team_membership()'
  ];
  v_name text;
  v_definition text;
  v_count integer;
  v_tokens integer;
  v_check text;
begin
  -- Interval foundation: the three CHECKs accept a zero-length interval, the old
  -- membership uniqueness constraint is replaced by a marker-excluding index.
  foreach v_name in array array[
    'recruiter_team_memberships_check',
    'direct_entry_scope_grants_check',
    'direct_entry_capability_grants_check'
  ] loop
    select pg_get_constraintdef(c.oid) into v_check
      from pg_constraint c
     where c.conname = v_name
       and c.contype = 'c'
       and c.conrelid in (
         'public.recruiter_team_memberships'::regclass,
         'public.direct_entry_scope_grants'::regclass,
         'public.direct_entry_capability_grants'::regclass
       );
    if v_check is null or v_check not like '%>=%' then
      raise exception 'interval check % was not relaxed for the cancellation marker', v_name
        using errcode = '55000';
    end if;
  end loop;

  select count(*)::int into v_count
    from pg_constraint c
   where c.conname = 'recruiter_team_memberships_recruiter_id_valid_from_key';
  if v_count <> 0 then
    raise exception 'the marker-blocking membership unique constraint still exists' using errcode = '55000';
  end if;
  select indexdef into v_definition
    from pg_indexes
   where schemaname = 'public' and indexname = 'recruiter_team_memberships_open_start_uidx';
  if v_definition is null or v_definition not like '%WHERE%' then
    raise exception 'the membership uniqueness index must be partial and marker-excluding' using errcode = '55000';
  end if;

  -- Write guards.
  foreach v_name in array array[
    'direct_entry_membership_cancel_marker_guard',
    'direct_entry_no_vendor_provider_team_membership',
    'direct_entry_no_vendor_recruiter_team_membership',
    'direct_entry_no_vendor_team_scope'
  ] loop
    select count(*)::int into v_count
      from pg_trigger tg
     where tg.tgname = v_name and not tg.tgisinternal;
    if v_count <> 1 then
      raise exception 'required trigger % is missing', v_name using errcode = '55000';
    end if;
  end loop;

  -- Fixed six-key snapshot, no leaking field.
  select pg_get_functiondef('public.direct_entry_team_membership_snapshot(uuid,uuid,date,date,integer,text)'::regprocedure)
    into v_definition;
  foreach v_name in array array['recruiter_id', 'team_id', 'valid_from', 'valid_to', 'version', 'change'] loop
    if v_definition not like '%' || v_name || '%' then
      raise exception 'membership snapshot is missing key %', v_name using errcode = '55000';
    end if;
  end loop;
  foreach v_name in array array['auth_subject', 'email', 'app_user_id', 'reason', 'capabilit', 'scope'] loop
    if v_definition like '%' || v_name || '%' then
      raise exception 'membership snapshot leaks %', v_name using errcode = '55000';
    end if;
  end loop;

  -- Revision contract.
  select count(*)::int into v_count
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'direct_entry_team_membership_revisions'
     and tg.tgname = 'direct_entry_team_membership_revisions_immutable' and not tg.tgisinternal;
  if v_count <> 1 then
    raise exception 'membership revisions immutability trigger missing' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'direct_entry_team_membership_revisions'
     and c.relrowsecurity and c.relforcerowsecurity;
  if v_count <> 1 then
    raise exception 'membership revisions must enable and force RLS' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from pg_constraint c
   where c.conname = 'direct_entry_team_membership_revisions_recruiter_id_version_key';
  if v_count <> 1 then
    raise exception 'membership revisions must be unique per recruiter and version' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from information_schema.columns
   where table_schema = 'public' and table_name = 'direct_entry_audit_events'
     and column_name = 'team_membership_revision_id';
  if v_count <> 1 then
    raise exception 'audit membership revision link missing' using errcode = '55000';
  end if;

  -- ACL.
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

  -- One catalog guard, unchanged capability vocabulary.
  select count(*)::int into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'direct_entry_assert_catalog_operator';
  if v_count <> 1 then
    raise exception 'the single catalog operator guard is missing or duplicated' using errcode = '55000';
  end if;
  select pg_get_constraintdef(c.oid) into v_check
    from pg_constraint c
   where c.conname = 'direct_entry_capability_grants_capability_check';
  v_tokens := (length(coalesce(v_check, ''))
    - length(replace(coalesce(v_check, ''), '''::text', ''))) / length('''::text');
  if v_tokens <> 23 then
    raise exception 'capability vocabulary drifted: % tokens', v_tokens using errcode = '55000';
  end if;
end;
$$;

commit;

