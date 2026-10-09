-- =============================================================================
-- P3.1-W01D - Team leader lifecycle: schema foundation (#71, append-only).
--
-- Scope: open the authority schema for the leader lifecycle without shipping the
-- mutation code. This migration ONLY widens the two scope/capability interval
-- CHECKs, converts their uniqueness to marker-excluding partial indexes, and adds
-- the leader assignment + revision tables, the cancellation-marker guard, the two
-- bounded helpers (fixed eight-key snapshot + shared projection) and the audit
-- link. The designate / replace / revoke RPCs and the legacy transition belong to
-- A1b, which appends them inside this same migration before integration.
--
-- Interval model: half-open [valid_from, valid_to). This migration widens exactly
-- TWO interval CHECKs - direct_entry_scope_grants_check and
-- direct_entry_capability_grants_check - from 'valid_to > valid_from' to
-- 'valid_to >= valid_from', so a ZERO-LENGTH scope/capability interval can exist
-- as a first-class cancellation marker (inert on every date, never deleted, its
-- valid_from never rewritten). recruiter_team_memberships_check keeps the W01C-B
-- '>=' rule and is NOT touched here; the capability vocabulary CHECK is NOT
-- touched. Their uniqueness becomes a partial unique index that ignores markers;
-- only the audited leader mutation RPCs may write a marker (transaction-local
-- flag 'direct_entry.team_leader_marker').
--
-- Aggregate root: public.teams. One leader mutation = exactly one version bump on
-- the locked team row (A1b), one immutable leader revision with the fixed
-- eight-key snapshot, and one audit event bound to that revision.
--
-- ACL posture: the two new tables are forced RLS and revoked from every role;
-- internal helpers are SECURITY DEFINER with a fixed search_path and revoked from
-- every role; no table DML is granted to any role.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Interval cancellation foundation: widen exactly two CHECKs.
-- -----------------------------------------------------------------------------
alter table public.direct_entry_capability_grants
  drop constraint direct_entry_capability_grants_check;
alter table public.direct_entry_capability_grants
  add constraint direct_entry_capability_grants_check
  check (valid_to is null or valid_to >= valid_from);

comment on constraint direct_entry_capability_grants_check on public.direct_entry_capability_grants is
  'P3.1-W01D: half-open [valid_from, valid_to). valid_to = valid_from is a cancellation marker: inert on every date, kept, never re-dated.';

alter table public.direct_entry_scope_grants
  drop constraint direct_entry_scope_grants_check;
alter table public.direct_entry_scope_grants
  add constraint direct_entry_scope_grants_check
  check (valid_to is null or valid_to >= valid_from);

comment on constraint direct_entry_scope_grants_check on public.direct_entry_scope_grants is
  'P3.1-W01D: half-open [valid_from, valid_to). valid_to = valid_from is a cancellation marker: inert on every date, kept, never re-dated.';

-- The membership CHECK keeps the W01C-B rule and the capability vocabulary CHECK
-- keeps its 23 tokens. Re-asserted here so a later drift is caught immediately.
do $$
declare
  v_check text;
begin
  select pg_get_constraintdef(c.oid) into v_check
    from pg_constraint c
   where c.conname = 'recruiter_team_memberships_check'
     and c.conrelid = 'public.recruiter_team_memberships'::regclass;
  if v_check is null or v_check not like '%>=%' then
    raise exception 'membership interval CHECK must stay >='
      using errcode = '55000';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Marker-excluding uniqueness for scope and capability grants.
-- -----------------------------------------------------------------------------
alter table public.direct_entry_capability_grants
  drop constraint direct_entry_capability_grant_app_user_id_capability_valid__key;
create unique index direct_entry_capability_grants_open_start_uidx
  on public.direct_entry_capability_grants (app_user_id, capability, valid_from)
  where valid_to is null or valid_to > valid_from;
comment on index public.direct_entry_capability_grants_open_start_uidx is
  'P3.1-W01D: at most one live capability interval per app user, capability and start date. Zero-length cancellation markers are excluded.';

drop index public.direct_entry_scope_grants_start_uidx;
create unique index direct_entry_scope_grants_start_uidx
  on public.direct_entry_scope_grants (
    app_user_id, scope_kind, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), valid_from
  )
  where valid_to is null or valid_to > valid_from;
comment on index public.direct_entry_scope_grants_start_uidx is
  'P3.1-W01D: at most one live scope interval per app user, scope kind, team and start date. Zero-length cancellation markers are excluded.';

-- -----------------------------------------------------------------------------
-- 3. Team leader assignment: one open leader per team and per app user.
-- -----------------------------------------------------------------------------
create table public.direct_entry_team_leader_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(team_id) on delete restrict,
  leader_app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  leader_recruiter_id uuid not null references public.recruiters(recruiter_id) on delete restrict,
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);

create unique index direct_entry_team_leader_assignments_team_open_uidx
  on public.direct_entry_team_leader_assignments (team_id, valid_from)
  where valid_to is null or valid_to > valid_from;
comment on index public.direct_entry_team_leader_assignments_team_open_uidx is
  'P3.1-W01D: at most one live leader interval per team and start date. Zero-length cancellation markers are excluded.';

create unique index direct_entry_team_leader_assignments_leader_open_uidx
  on public.direct_entry_team_leader_assignments (leader_app_user_id, valid_from)
  where valid_to is null or valid_to > valid_from;
comment on index public.direct_entry_team_leader_assignments_leader_open_uidx is
  'P3.1-W01D: at most one live leader interval per app user and start date, so one app user cannot be the open leader of two teams. Zero-length cancellation markers are excluded.';

create index direct_entry_team_leader_assignments_history_idx
  on public.direct_entry_team_leader_assignments (team_id, valid_from desc);

alter table public.direct_entry_team_leader_assignments enable row level security;
alter table public.direct_entry_team_leader_assignments force row level security;
revoke all on table public.direct_entry_team_leader_assignments
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_team_leader_assignments is
  'P3.1-W01D leader assignment history (half-open interval, cancellation markers kept). At most one open leader per team and one open leadership per app user. Written only inside the service-role leader RPCs added by A1b.';

-- -----------------------------------------------------------------------------
-- 4. Write guard: zero-length cancellation markers on the three tables.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_team_leader_marker()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.valid_to is not null and new.valid_to = new.valid_from
     and coalesce(current_setting('direct_entry.team_leader_marker', true), '') <> 'on' then
    raise exception 'team-leader cancellation marker requires the audited mutation path'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_team_leader_marker()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_team_leader_marker() is
  'P3.1-W01D trigger: rejects a zero-length leader/scope/capability interval written outside the audited leader mutation RPCs. Revoked from every role.';

create trigger direct_entry_team_leader_assignment_marker_guard
  before insert or update of valid_from, valid_to on public.direct_entry_team_leader_assignments
  for each row execute function public.direct_entry_team_leader_marker();

create trigger direct_entry_scope_grant_marker_guard
  before insert or update of valid_from, valid_to on public.direct_entry_scope_grants
  for each row execute function public.direct_entry_team_leader_marker();

create trigger direct_entry_capability_grant_marker_guard
  before insert or update of valid_from, valid_to on public.direct_entry_capability_grants
  for each row execute function public.direct_entry_team_leader_marker();

-- -----------------------------------------------------------------------------
-- 5. Append-only leader revision history rooted on the team aggregate.
-- -----------------------------------------------------------------------------
create table public.direct_entry_team_leader_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(team_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  action text not null,
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz not null default now(),
  unique (team_id, version)
);

create index direct_entry_team_leader_revisions_team_idx
  on public.direct_entry_team_leader_revisions (team_id, version desc);

create trigger direct_entry_team_leader_revisions_immutable
  before update or delete on public.direct_entry_team_leader_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.direct_entry_team_leader_revisions enable row level security;
alter table public.direct_entry_team_leader_revisions force row level security;
revoke all on table public.direct_entry_team_leader_revisions
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_team_leader_revisions is
  'P3.1-W01D append-only team leader revision history (fixed eight-key snapshot + actor + action + team version), written only inside the service-role leader RPCs added by A1b. Never updated, never deleted, never backfilled.';
comment on column public.direct_entry_team_leader_revisions.version is
  'The public.teams.version produced by this leader mutation. unique (team_id, version) makes the leader version sequence auditable.';

alter table public.direct_entry_audit_events
  add column leader_revision_id uuid
    references public.direct_entry_team_leader_revisions(revision_id) on delete restrict;

-- -----------------------------------------------------------------------------
-- 6. Internal helpers: fixed snapshot and shared projection.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_team_leader_snapshot(
  p_team_id uuid,
  p_leader_app_user_id uuid,
  p_leader_recruiter_id uuid,
  p_valid_from date,
  p_valid_to date,
  p_previous_leader_recruiter_id uuid,
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
    'team_id', to_jsonb(p_team_id),
    'leader_app_user_id', to_jsonb(p_leader_app_user_id),
    'leader_recruiter_id', to_jsonb(p_leader_recruiter_id),
    'valid_from', to_jsonb(p_valid_from),
    'valid_to', to_jsonb(p_valid_to),
    'previous_leader_recruiter_id', to_jsonb(p_previous_leader_recruiter_id),
    'version', p_version,
    'change', p_change
  )
$$;
revoke all on function public.direct_entry_team_leader_snapshot(uuid, uuid, uuid, date, date, uuid, integer, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_team_leader_snapshot(uuid, uuid, uuid, date, date, uuid, integer, text) is
  'P3.1-W01D internal fixed eight-key leader snapshot (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, previous_leader_recruiter_id, version, change). No email, auth_subject, display name, reason or raw grant. Revoked from every role.';

create or replace function public.direct_entry_team_leader_projection(
  p_assignment public.direct_entry_team_leader_assignments,
  p_team_display_name text,
  p_leader_display_name text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'assignment_id', p_assignment.assignment_id,
    'team_id', p_assignment.team_id,
    'team_display_name', p_team_display_name,
    'leader_app_user_id', p_assignment.leader_app_user_id,
    'leader_recruiter_id', p_assignment.leader_recruiter_id,
    'leader_display_name', p_leader_display_name,
    'valid_from', to_jsonb(p_assignment.valid_from),
    'valid_to', to_jsonb(p_assignment.valid_to),
    'state', case
      when p_assignment.valid_to is not null
           and p_assignment.valid_to = p_assignment.valid_from then 'HISTORY'
      when p_assignment.valid_from > public.direct_entry_authorization_date() then 'SCHEDULED'
      when p_assignment.valid_to is null
           or public.direct_entry_authorization_date() < p_assignment.valid_to then 'CURRENT'
      else 'HISTORY'
    end
  )
$$;
revoke all on function public.direct_entry_team_leader_projection(public.direct_entry_team_leader_assignments, text, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_team_leader_projection(public.direct_entry_team_leader_assignments, text, text) is
  'P3.1-W01D internal bounded leader projection: assignment_id, team_id, team_display_name, leader_app_user_id, leader_recruiter_id, leader_display_name, valid_from, valid_to, state. No auth_subject, email, grant id, raw scope/capability rows, reason or audit internals. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 7. Self-check: interval foundation, guards, revision contract and ACL.
-- -----------------------------------------------------------------------------
do $$
declare
  v_helpers text[] := array[
    'public.direct_entry_team_leader_marker()',
    'public.direct_entry_team_leader_snapshot(uuid,uuid,uuid,date,date,uuid,integer,text)',
    'public.direct_entry_team_leader_projection(public.direct_entry_team_leader_assignments,text,text)'
  ];
  v_tables text[] := array[
    'public.direct_entry_team_leader_assignments',
    'public.direct_entry_team_leader_revisions'
  ];
  v_name text;
  v_definition text;
  v_count integer;
  v_tokens integer;
  v_check text;
  v_keys text[];
begin
  -- Interval foundation: scope and capability accept a zero-length interval;
  -- the membership CHECK keeps the W01C-B rule.
  foreach v_name in array array[
    'direct_entry_scope_grants_check',
    'direct_entry_capability_grants_check'
  ] loop
    select pg_get_constraintdef(c.oid) into v_check
      from pg_constraint c
     where c.conname = v_name
       and c.contype = 'c'
       and c.conrelid in (
         'public.direct_entry_scope_grants'::regclass,
         'public.direct_entry_capability_grants'::regclass
       );
    if v_check is null or v_check not like '%>=%' then
      raise exception 'interval check % was not relaxed for the cancellation marker', v_name
        using errcode = '55000';
    end if;
  end loop;

  -- Marker-blocking uniqueness is gone; the replacements are partial.
  select count(*)::int into v_count
    from pg_constraint c
   where c.conname = 'direct_entry_capability_grant_app_user_id_capability_valid__key';
  if v_count <> 0 then
    raise exception 'the marker-blocking capability unique constraint still exists'
      using errcode = '55000';
  end if;
  foreach v_name in array array[
    'direct_entry_capability_grants_open_start_uidx',
    'direct_entry_scope_grants_start_uidx',
    'direct_entry_team_leader_assignments_team_open_uidx',
    'direct_entry_team_leader_assignments_leader_open_uidx'
  ] loop
    select indexdef into v_definition
      from pg_indexes
     where schemaname = 'public' and indexname = v_name;
    if v_definition is null
       or v_definition not like '%WHERE%'
       or v_definition not like '%valid_to > valid_from%' then
      raise exception 'uniqueness index % must be partial and marker-excluding', v_name
        using errcode = '55000';
    end if;
  end loop;

  -- Write guards on the three tables.
  foreach v_name in array array[
    'direct_entry_team_leader_assignment_marker_guard',
    'direct_entry_scope_grant_marker_guard',
    'direct_entry_capability_grant_marker_guard'
  ] loop
    select count(*)::int into v_count
      from pg_trigger tg
     where tg.tgname = v_name and not tg.tgisinternal;
    if v_count <> 1 then
      raise exception 'required marker trigger % is missing', v_name using errcode = '55000';
    end if;
  end loop;

  -- New tables: forced RLS, no privilege to any role, required shape.
  foreach v_name in array v_tables loop
    select count(*)::int into v_count
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = split_part(v_name, '.', 2)
       and c.relrowsecurity and c.relforcerowsecurity;
    if v_count <> 1 then
      raise exception '% must enable and force RLS', v_name using errcode = '55000';
    end if;
    if has_table_privilege('public', v_name, 'INSERT,UPDATE,DELETE,SELECT')
       or has_table_privilege('anon', v_name, 'INSERT,UPDATE,DELETE,SELECT')
       or has_table_privilege('authenticated', v_name, 'INSERT,UPDATE,DELETE,SELECT')
       or has_table_privilege('service_role', v_name, 'INSERT,UPDATE,DELETE,SELECT') then
      raise exception '% must deny every role', v_name using errcode = '55000';
    end if;
  end loop;

  -- Revision contract: unique per team and version, immutable trigger, audit link.
  select count(*)::int into v_count
    from pg_constraint c
   where c.conname = 'direct_entry_team_leader_revisions_team_id_version_key';
  if v_count <> 1 then
    raise exception 'leader revisions must be unique per team and version' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'direct_entry_team_leader_revisions'
     and tg.tgname = 'direct_entry_team_leader_revisions_immutable' and not tg.tgisinternal;
  if v_count <> 1 then
    raise exception 'leader revisions immutability trigger missing' using errcode = '55000';
  end if;
  select count(*)::int into v_count
    from information_schema.columns
   where table_schema = 'public' and table_name = 'direct_entry_audit_events'
     and column_name = 'leader_revision_id';
  if v_count <> 1 then
    raise exception 'audit leader revision link missing' using errcode = '55000';
  end if;

  -- Fixed eight-key snapshot, no extra key, no leaking field.
  select array_agg(k order by k) into v_keys
    from jsonb_object_keys(
      public.direct_entry_team_leader_snapshot(
        null::uuid, null::uuid, null::uuid, null::date, null::date, null::uuid, 1, 'designate'
      )
    ) k;
  if v_keys is distinct from array[
    'change', 'leader_app_user_id', 'leader_recruiter_id',
    'previous_leader_recruiter_id', 'team_id', 'valid_from', 'valid_to', 'version'
  ]::text[] then
    raise exception 'leader snapshot must expose exactly the eight fixed keys'
      using errcode = '55000';
  end if;
  select pg_get_functiondef('public.direct_entry_team_leader_snapshot(uuid,uuid,uuid,date,date,uuid,integer,text)'::regprocedure)
    into v_definition;
  foreach v_name in array array['auth_subject', 'email', 'display_name', 'reason', 'grant_id', 'scope', 'capabilit'] loop
    if v_definition like '%' || v_name || '%' then
      raise exception 'leader snapshot leaks %', v_name using errcode = '55000';
    end if;
  end loop;
  select pg_get_functiondef('public.direct_entry_team_leader_projection(public.direct_entry_team_leader_assignments,text,text)'::regprocedure)
    into v_definition;
  foreach v_name in array array['auth_subject', 'email', 'grant_id', 'reason', 'scope', 'capabilit', 'audit'] loop
    if v_definition like '%' || v_name || '%' then
      raise exception 'leader projection leaks %', v_name using errcode = '55000';
    end if;
  end loop;

  -- ACL: internal helpers are revoked from every role.
  foreach v_name in array v_helpers loop
    if has_function_privilege('public', v_name, 'EXECUTE')
       or has_function_privilege('anon', v_name, 'EXECUTE')
       or has_function_privilege('authenticated', v_name, 'EXECUTE')
       or has_function_privilege('service_role', v_name, 'EXECUTE') then
      raise exception 'internal helper is executable: %', v_name using errcode = '55000';
    end if;
  end loop;

  -- Unchanged capability vocabulary.
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
