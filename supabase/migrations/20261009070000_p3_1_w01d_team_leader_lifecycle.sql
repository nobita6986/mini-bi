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

-- -----------------------------------------------------------------------------
-- 8. Read authority and three bounded leader reads.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_team_leader_read_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today date := public.direct_entry_authorization_date();
  v_scope_count integer;
  v_scope_team_id uuid;
  v_link_count integer;
  v_link_recruiter_id uuid;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_assignment_count integer;
  v_catalog_operator boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  begin
    perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
    v_catalog_operator := true;
  exception
    when insufficient_privilege then
      null;
  end;

  if v_catalog_operator then
    -- A supplied filter remains a filter even when stale, inactive, or reserved:
    -- the RPC query returns no matching business rows rather than widening scope.
    return p_team_id;
  end if;

  if not public.direct_entry_has_capability(p_app_user_id, 'team_manager_assign') then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  select count(*)::int, (array_agg(s.team_id))[1] into v_scope_count, v_scope_team_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_app_user_id
     and s.scope_kind = 'team'
     and s.valid_from <= v_today
     and (s.valid_to is null or v_today < s.valid_to)
     and (s.valid_to is null or s.valid_to > s.valid_from);

  if v_scope_count <> 1 or v_scope_team_id is null then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  if p_team_id is not null and p_team_id <> v_scope_team_id then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.teams t
     where t.team_id = v_scope_team_id
       and t.active
       and t.code <> '__system_vendor__'
  ) then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  select count(*)::int, (array_agg(l.recruiter_id))[1] into v_link_count, v_link_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.valid_from <= v_today
     and (l.valid_to is null or v_today < l.valid_to)
     and (l.valid_to is null or l.valid_to > l.valid_from);

  if v_link_count <> 1 or v_link_recruiter_id is null then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = v_link_recruiter_id
       and r.active
  ) then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  select count(*)::int,
         count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::int
    into v_provider_count, v_hrp_provider_count
    from public.recruiter_provider_memberships m
   where m.recruiter_id = v_link_recruiter_id
     and m.valid_from <= v_today
     and (m.valid_to is null or v_today < m.valid_to)
     and (m.valid_to is null or m.valid_to > m.valid_from);

  if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  select count(*)::int,
         count(*) filter (where m.team_id = v_scope_team_id)::int
    into v_membership_count, v_matching_membership_count
    from public.recruiter_team_memberships m
   where m.recruiter_id = v_link_recruiter_id
     and m.valid_from <= v_today
     and (m.valid_to is null or v_today < m.valid_to)
     and (m.valid_to is null or m.valid_to > m.valid_from);

  if v_membership_count <> 1 or v_matching_membership_count <> 1 then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  select count(*)::int into v_assignment_count
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_app_user_id
     and a.leader_recruiter_id = v_link_recruiter_id
     and a.team_id = v_scope_team_id
     and a.valid_from <= v_today
     and (a.valid_to is null or v_today < a.valid_to)
     and (a.valid_to is null or a.valid_to > a.valid_from);

  if v_assignment_count <> 1 then
    raise exception 'team leader read authority denied' using errcode = '42501';
  end if;

  return v_scope_team_id;
end;
$$;
revoke all on function public.direct_entry_assert_team_leader_read_authority(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_assert_team_leader_read_authority(uuid, uuid, uuid) is
  'P3.1-W01D sole internal read-authority resolver: canonical catalog-operator guard or exact-one effective leader identity, provider, membership, scope and assignment. Revoked from every role.';

create or replace function public.direct_entry_list_team_leaders_current(
  p_auth_subject uuid,
  p_app_user_id uuid,
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
  v_effective_team_id uuid := public.direct_entry_assert_team_leader_read_authority(p_auth_subject, p_app_user_id, p_team_id);
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_leaders jsonb;
begin
  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid team leader search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.direct_entry_team_leader_assignments a
    join public.teams t on t.team_id = a.team_id
    join public.direct_entry_app_users u on u.app_user_id = a.leader_app_user_id
   where t.code <> '__system_vendor__'
     and a.valid_from <= public.direct_entry_authorization_date()
     and (a.valid_to is null or public.direct_entry_authorization_date() < a.valid_to)
     and (a.valid_to is null or a.valid_to > a.valid_from)
     and (v_effective_team_id is null or a.team_id = v_effective_team_id)
     and (p_team_id is null or a.team_id = p_team_id)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
       or u.display_name ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(entry.projection), '[]'::jsonb) into v_leaders
    from (
      select public.direct_entry_team_leader_projection(a, t.display_name, u.display_name) as projection
        from public.direct_entry_team_leader_assignments a
        join public.teams t on t.team_id = a.team_id
        join public.direct_entry_app_users u on u.app_user_id = a.leader_app_user_id
       where t.code <> '__system_vendor__'
         and a.valid_from <= public.direct_entry_authorization_date()
         and (a.valid_to is null or public.direct_entry_authorization_date() < a.valid_to)
         and (a.valid_to is null or a.valid_to > a.valid_from)
         and (v_effective_team_id is null or a.team_id = v_effective_team_id)
         and (p_team_id is null or a.team_id = p_team_id)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
           or u.display_name ilike '%' || v_search || '%'
         )
       order by t.display_name, a.assignment_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) entry;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'leaders', v_leaders
  );
end;
$$;
revoke all on function public.direct_entry_list_team_leaders_current(uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_team_leaders_current(uuid, uuid, uuid, text, integer, integer)
  to service_role;
comment on function public.direct_entry_list_team_leaders_current(uuid, uuid, uuid, text, integer, integer) is
  'P3.1-W01D bounded read: leaders effective at the authorization date. service_role only; catalog operator or own-team leader authority required.';

create or replace function public.direct_entry_list_team_leaders_scheduled(
  p_auth_subject uuid,
  p_app_user_id uuid,
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
  v_effective_team_id uuid := public.direct_entry_assert_team_leader_read_authority(p_auth_subject, p_app_user_id, p_team_id);
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_leaders jsonb;
begin
  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid team leader search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.direct_entry_team_leader_assignments a
    join public.teams t on t.team_id = a.team_id
    join public.direct_entry_app_users u on u.app_user_id = a.leader_app_user_id
   where t.code <> '__system_vendor__'
     and a.valid_from > public.direct_entry_authorization_date()
     and (a.valid_to is null or a.valid_to > a.valid_from)
     and (v_effective_team_id is null or a.team_id = v_effective_team_id)
     and (p_team_id is null or a.team_id = p_team_id)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
       or u.display_name ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(entry.projection), '[]'::jsonb) into v_leaders
    from (
      select public.direct_entry_team_leader_projection(a, t.display_name, u.display_name) as projection
        from public.direct_entry_team_leader_assignments a
        join public.teams t on t.team_id = a.team_id
        join public.direct_entry_app_users u on u.app_user_id = a.leader_app_user_id
       where t.code <> '__system_vendor__'
         and a.valid_from > public.direct_entry_authorization_date()
         and (a.valid_to is null or a.valid_to > a.valid_from)
         and (v_effective_team_id is null or a.team_id = v_effective_team_id)
         and (p_team_id is null or a.team_id = p_team_id)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
           or u.display_name ilike '%' || v_search || '%'
         )
       order by a.valid_from, a.assignment_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) entry;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'leaders', v_leaders
  );
end;
$$;
revoke all on function public.direct_entry_list_team_leaders_scheduled(uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_team_leaders_scheduled(uuid, uuid, uuid, text, integer, integer)
  to service_role;
comment on function public.direct_entry_list_team_leaders_scheduled(uuid, uuid, uuid, text, integer, integer) is
  'P3.1-W01D bounded read: leaders scheduled to become effective in the future. service_role only; catalog operator or own-team leader authority required.';

create or replace function public.direct_entry_list_team_leader_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
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
  v_effective_team_id uuid := public.direct_entry_assert_team_leader_read_authority(p_auth_subject, p_app_user_id, p_team_id);
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_leaders jsonb;
begin
  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid team leader search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.direct_entry_team_leader_assignments a
    join public.teams t on t.team_id = a.team_id
    join public.direct_entry_app_users u on u.app_user_id = a.leader_app_user_id
   where t.code <> '__system_vendor__'
     and (
       a.valid_to = a.valid_from
       or a.valid_to is not null and a.valid_to <= public.direct_entry_authorization_date()
     )
     and (v_effective_team_id is null or a.team_id = v_effective_team_id)
     and (p_team_id is null or a.team_id = p_team_id)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
       or u.display_name ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(entry.projection), '[]'::jsonb) into v_leaders
    from (
      select public.direct_entry_team_leader_projection(a, t.display_name, u.display_name) as projection
        from public.direct_entry_team_leader_assignments a
        join public.teams t on t.team_id = a.team_id
        join public.direct_entry_app_users u on u.app_user_id = a.leader_app_user_id
       where t.code <> '__system_vendor__'
         and (
           a.valid_to = a.valid_from
           or a.valid_to is not null and a.valid_to <= public.direct_entry_authorization_date()
         )
         and (v_effective_team_id is null or a.team_id = v_effective_team_id)
         and (p_team_id is null or a.team_id = p_team_id)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
           or u.display_name ilike '%' || v_search || '%'
         )
       order by a.valid_from desc, a.assignment_id desc
       limit v_page_size offset (v_page - 1) * v_page_size
    ) entry;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'leaders', v_leaders
  );
end;
$$;
revoke all on function public.direct_entry_list_team_leader_history(uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_team_leader_history(uuid, uuid, uuid, text, integer, integer)
  to service_role;
comment on function public.direct_entry_list_team_leader_history(uuid, uuid, uuid, text, integer, integer) is
  'P3.1-W01D bounded read: historical leader assignments including zero-length cancellation markers. service_role only; catalog operator or own-team leader authority required.';

-- -----------------------------------------------------------------------------
-- 9. Atomic leader designate/replace and revoke mutations.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_apply_team_leader_mutation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_target_leader_app_user_id uuid,
  p_effective_date date,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text,
  p_operation text,
  p_authority text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_team public.teams;
  v_old public.direct_entry_team_leader_assignments%rowtype;
  v_new public.direct_entry_team_leader_assignments%rowtype;
  v_old_count integer := 0;
  v_candidate_user_enabled boolean;
  v_link_count integer;
  v_verified_link_count integer;
  v_recruiter_id uuid;
  v_recruiter_active boolean;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_scope_count integer;
  v_capability_count integer;
  v_scope_grant_id uuid;
  v_capability_grant_id uuid;
  v_idempotency_action text;
  v_prior_hash text;
  v_change text;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_team_version integer;
  v_before jsonb;
  v_after jsonb;
  v_changed_fields text[] := array[
    'team_leader_assignment', 'team_scope', 'team_manager_assign'
  ];
  v_actor_ids uuid[];
  v_lock_key text;
  v_scope_grant_count integer;
  v_capability_grant_count integer;
  v_post_team_assignment_count integer;
  v_post_target_team_assignment_count integer;
  v_post_target_assignment_count integer;
  v_post_scope_count integer;
  v_post_target_team_scope_count integer;
  v_post_capability_count integer;
  v_post_coextensive_scope_count integer;
  v_post_coextensive_capability_count integer;
  v_post_outgoing_assignment_count integer;
  v_post_outgoing_scope_count integer;
  v_post_outgoing_capability_count integer;
  v_post_closed_assignment_count integer;
  v_post_closed_scope_count integer;
  v_post_closed_capability_count integer;
begin
  if p_operation not in ('designate', 'revoke') then
    raise exception 'invalid team leader operation' using errcode = '22023';
  end if;
  if (p_operation = 'designate') <> (p_target_leader_app_user_id is not null) then
    raise exception 'target leader does not match operation' using errcode = '22023';
  end if;
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_effective_date is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected team version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if v_team.code = '__system_vendor__' then
    raise exception 'reserved team cannot have a leader' using errcode = '23514';
  end if;

  v_idempotency_action := case p_operation
    when 'designate' then 'team_leader_designate'
    else 'team_leader_revoke'
  end;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'team_id', p_team_id,
    'target_leader_app_user_id', p_target_leader_app_user_id,
    'effective_date', p_effective_date,
    'expected_version', p_expected_version,
    'reason', p_reason
  ));
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = v_idempotency_action
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_request_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is null then
      raise exception 'completed idempotency result is missing' using errcode = '55000';
    end if;
    return v_prior;
  end if;

  -- The team row is already locked; compare its OCC token before locking any
  -- leader account/grant rows. The read-only idempotency lookup above preserves
  -- exact replay semantics for a request whose original version is now stale.
  if v_team.version <> p_expected_version then
    raise exception 'team version conflict' using errcode = '40001';
  end if;
  if p_operation = 'designate' and not v_team.active then
    raise exception 'target team is inactive' using errcode = '23514';
  end if;

  select count(*)::int into v_old_count
    from public.direct_entry_team_leader_assignments a
   where a.team_id = p_team_id
     and (a.valid_to is null or a.valid_to > a.valid_from)
     and daterange(a.valid_from, a.valid_to, '[)')
         && daterange(p_effective_date, null, '[)');
  if v_old_count > 1 then
    raise exception 'team leader assignment is ambiguous' using errcode = '42501';
  end if;
  if v_old_count = 1 then
    select a.* into v_old
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and daterange(a.valid_from, a.valid_to, '[)')
           && daterange(p_effective_date, null, '[)')
     order by a.valid_from, a.assignment_id
     limit 1;
    if v_old.valid_from > p_effective_date then
      raise exception 'future team leader must be cancelled at its start date'
        using errcode = '23514';
    end if;
  elsif p_operation = 'revoke' then
    raise exception 'no leader assignment to revoke' using errcode = '22023';
  end if;
  if p_operation = 'designate'
     and v_old_count = 1
     and v_old.leader_app_user_id = p_target_leader_app_user_id then
    raise exception 'leader is already assigned to this team' using errcode = '23514';
  end if;

  v_actor_ids := array_remove(array[
    case when v_old_count = 1 then v_old.leader_app_user_id end,
    p_target_leader_app_user_id
  ]::uuid[], null);

  -- App-user and grant row locks follow a stable UUID order after the team OCC root.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_actor_ids)
   order by u.app_user_id
   for update;
  if p_operation = 'designate' then
    select u.enabled into v_candidate_user_enabled
      from public.direct_entry_app_users u
     where u.app_user_id = p_target_leader_app_user_id;
    if not found or not coalesce(v_candidate_user_enabled, false) then
      raise exception 'target leader account is not enabled' using errcode = '42501';
    end if;
  end if;
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = any(v_actor_ids)
     and s.scope_kind = 'team'
   order by s.app_user_id, s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = any(v_actor_ids)
     and g.capability = 'team_manager_assign'
   order by g.app_user_id, g.grant_id
   for update;

  -- Acquire the same interval keys used by the canonical link/scope/capability
  -- overlap trigger, in stable order, before identity validation or interval writes.
  for v_lock_key in
    select distinct key
      from unnest(array[
        case when v_old_count = 1 then
          'capability:' || v_old.leader_app_user_id::text || ':team_manager_assign' end,
        case when v_old_count = 1 then
          'scope:' || v_old.leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when p_operation = 'designate' then
          'capability:' || p_target_leader_app_user_id::text || ':team_manager_assign' end,
        case when p_operation = 'designate' then
          'scope:' || p_target_leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when p_operation = 'designate' then
          'recruiter-link:' || p_target_leader_app_user_id::text end
      ]) as keys(key)
     where key is not null
     order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  if p_operation = 'designate' then
    perform l.link_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_target_leader_app_user_id
     order by l.link_id
     for update;
    select count(*)::int,
           count(*) filter (where l.verified)::int,
           (array_agg(l.recruiter_id order by l.link_id))[1]
      into v_link_count, v_verified_link_count, v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_target_leader_app_user_id
       and l.valid_from <= p_effective_date
       and (l.valid_to is null or p_effective_date < l.valid_to)
       and (l.valid_to is null or l.valid_to > l.valid_from);
    if v_link_count <> 1 or v_verified_link_count <> 1 or v_recruiter_id is null then
      raise exception 'target leader requires exactly one verified recruiter link'
        using errcode = '42501';
    end if;

    select r.active into v_recruiter_active
      from public.recruiters r
     where r.recruiter_id = v_recruiter_id
     for update;
    if not found or not coalesce(v_recruiter_active, false) then
      raise exception 'target recruiter is not active' using errcode = '42501';
    end if;

    for v_lock_key in
      select key
        from unnest(array[
          'provider:' || v_recruiter_id::text,
          'team-membership:' || v_recruiter_id::text
        ]) as keys(key)
       order by key
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
     order by m.membership_id
     for update;
    select count(*)::int,
           count(*) filter (
             where m.provider_type = 'hrp' and m.vendor_id is null
           )::int
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.valid_from <= p_effective_date
       and (m.valid_to is null or p_effective_date < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from);
    if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
      raise exception 'target recruiter requires exactly one effective HRP provider'
        using errcode = '42501';
    end if;

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
     order by m.membership_id
     for update;
    select count(*)::int,
           count(*) filter (where m.team_id = p_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.valid_from <= p_effective_date
       and (m.valid_to is null or p_effective_date < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from);
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'target recruiter must have exactly one effective membership in the target team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_leader_app_user_id
         and a.team_id <> p_team_id
         and (a.valid_to is null or a.valid_to > a.valid_from)
         and daterange(a.valid_from, a.valid_to, '[)')
             && daterange(p_effective_date, null, '[)')
    ) then
      raise exception 'target leader is assigned or scheduled for another team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = p_target_leader_app_user_id
         and s.scope_kind = 'team'
         and (s.valid_to is null or s.valid_to > s.valid_from)
         and daterange(s.valid_from, s.valid_to, '[)')
             && daterange(p_effective_date, null, '[)')
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_target_leader_app_user_id
         and g.capability = 'team_manager_assign'
         and (g.valid_to is null or g.valid_to > g.valid_from)
         and daterange(g.valid_from, g.valid_to, '[)')
             && daterange(p_effective_date, null, '[)')
    ) then
      raise exception 'target leader has pre-existing leader authority intervals'
        using errcode = '42501';
    end if;
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_old_count = 1 then
    perform a.assignment_id
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
     for update;

    select count(*)::int, (array_agg(s.grant_id order by s.grant_id))[1]
      into v_scope_count, v_scope_grant_id
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_old.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = p_team_id
       and s.valid_from = v_old.valid_from
       and s.valid_to is not distinct from v_old.valid_to
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int, (array_agg(g.grant_id order by g.grant_id))[1]
      into v_capability_count, v_capability_grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = v_old.valid_from
       and g.valid_to is not distinct from v_old.valid_to
       and (g.valid_to is null or g.valid_to > g.valid_from);
    if v_scope_count <> 1 or v_capability_count <> 1 then
      raise exception 'legacy leader assignment, scope, and capability intervals do not match'
        using errcode = '42501';
    end if;
    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team'
         and (s.valid_to is null or s.valid_to > s.valid_from)
         and daterange(s.valid_from, s.valid_to, '[)')
             && daterange(p_effective_date, null, '[)')
         and s.grant_id <> v_scope_grant_id
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and (g.valid_to is null or g.valid_to > g.valid_from)
         and daterange(g.valid_from, g.valid_to, '[)')
             && daterange(p_effective_date, null, '[)')
         and g.grant_id <> v_capability_grant_id
    ) then
      raise exception 'outgoing leader has ambiguous future authority intervals'
        using errcode = '42501';
    end if;
  end if;

  if v_old_count = 1 then
    if p_effective_date = v_old.valid_from then
      perform set_config('direct_entry.team_leader_marker', 'on', true);
    end if;
    update public.direct_entry_team_leader_assignments
       set valid_to = p_effective_date
     where assignment_id = v_old.assignment_id;
    update public.direct_entry_scope_grants
       set valid_to = p_effective_date
     where grant_id = v_scope_grant_id;
    update public.direct_entry_capability_grants
       set valid_to = p_effective_date
     where grant_id = v_capability_grant_id;
  end if;

  if p_operation = 'designate' then
    insert into public.direct_entry_team_leader_assignments
      (team_id, leader_app_user_id, leader_recruiter_id, valid_from)
    values
      (p_team_id, p_target_leader_app_user_id, v_recruiter_id, p_effective_date)
    returning * into v_new;
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, team_id, valid_from)
    values
      (p_target_leader_app_user_id, 'team', p_team_id, p_effective_date);
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from)
    values
      (p_target_leader_app_user_id, 'team_manager_assign', p_effective_date);
    v_change := case when v_old_count = 1 then 'replace' else 'designate' end;
  else
    v_new := v_old;
    v_change := 'revoke';
  end if;

  if p_operation = 'designate' then
    select count(*) filter (where a.team_id = p_team_id)::int,
           count(*) filter (
             where a.team_id = p_team_id
               and a.leader_app_user_id = p_target_leader_app_user_id
           )::int,
           count(*) filter (
             where a.leader_app_user_id = p_target_leader_app_user_id
           )::int
      into v_post_team_assignment_count, v_post_target_team_assignment_count,
           v_post_target_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);

    if v_post_team_assignment_count <> 1
       or v_post_target_team_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;
    if v_post_target_assignment_count <> 1
       or v_post_target_team_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    select count(*)::int,
           count(*) filter (where s.team_id = p_team_id)::int
      into v_post_scope_count, v_post_target_team_scope_count
      from public.direct_entry_scope_grants s
     where s.app_user_id = p_target_leader_app_user_id
       and s.scope_kind = 'team'
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_target_leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    select count(*)::int into v_post_coextensive_scope_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_scope_grants s
        on s.app_user_id = a.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = a.team_id
       and s.valid_from = a.valid_from
       and s.valid_to is not distinct from a.valid_to
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_coextensive_capability_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_capability_grants g
        on g.app_user_id = a.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = a.valid_from
       and g.valid_to is not distinct from a.valid_to
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    if v_post_scope_count <> 1 or v_post_target_team_scope_count <> 1
       or v_post_capability_count <> 1
       or v_post_coextensive_scope_count <> 1
       or v_post_coextensive_capability_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    if v_old_count = 1 then
      select count(*)::int into v_post_outgoing_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.leader_app_user_id = v_old.leader_app_user_id
         and a.valid_from <= p_effective_date
         and (a.valid_to is null or p_effective_date < a.valid_to)
         and (a.valid_to is null or a.valid_to > a.valid_from);
      select count(*)::int into v_post_outgoing_scope_count
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team' and s.team_id = p_team_id
         and s.valid_from <= p_effective_date
         and (s.valid_to is null or p_effective_date < s.valid_to)
         and (s.valid_to is null or s.valid_to > s.valid_from);
      select count(*)::int into v_post_outgoing_capability_count
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.valid_from <= p_effective_date
         and (g.valid_to is null or p_effective_date < g.valid_to)
         and (g.valid_to is null or g.valid_to > g.valid_from);
      select count(*)::int into v_post_closed_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_old.assignment_id
         and a.valid_to = p_effective_date;
      select count(*)::int into v_post_closed_scope_count
        from public.direct_entry_scope_grants s
       where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
      select count(*)::int into v_post_closed_capability_count
        from public.direct_entry_capability_grants g
       where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
      if v_post_outgoing_assignment_count <> 0
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    end if;
  else
    select count(*)::int into v_post_team_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);
    select count(*)::int into v_post_outgoing_scope_count
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_old.leader_app_user_id
       and s.scope_kind = 'team' and s.team_id = p_team_id
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_outgoing_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    select count(*)::int into v_post_closed_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
       and a.valid_to = p_effective_date;
    select count(*)::int into v_post_closed_scope_count
      from public.direct_entry_scope_grants s
     where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
    select count(*)::int into v_post_closed_capability_count
      from public.direct_entry_capability_grants g
     where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
    if v_post_team_assignment_count <> 0
       or v_post_outgoing_scope_count <> 0
       or v_post_outgoing_capability_count <> 0
       or v_post_closed_assignment_count <> 1
       or v_post_closed_scope_count <> 1
       or v_post_closed_capability_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;
  end if;

  update public.teams t
     set version = t.version + 1
   where t.team_id = p_team_id
  returning t.version into v_team_version;
  if v_team_version is null then
    raise exception 'team not found' using errcode = 'P0002';
  end if;

  if v_old_count = 1 then
    v_before := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, v_old.valid_to, null, v_team.version, v_change
    );
  end if;
  if p_operation = 'designate' then
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_new.leader_app_user_id, v_new.leader_recruiter_id,
      v_new.valid_from, v_new.valid_to,
      case when v_old_count = 1 then v_old.leader_recruiter_id end,
      v_team_version, v_change
    );
  else
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, p_effective_date, null, v_team_version, v_change
    );
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_team_leader_revisions
    (team_id, version, actor_user_id, action, before_snapshot, after_snapshot)
  values
    (p_team_id, v_team_version, p_app_user_id, v_change, v_before, v_after)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, leader_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_leader_' || v_change, p_authority,
     p_team_id::text, 'all', 'APPLIED', v_reason_id, v_changed_fields, v_revision_id);

  v_result := jsonb_build_object(
    'team_id', p_team_id,
    'assignment_id', v_new.assignment_id,
    'leader_app_user_id', v_new.leader_app_user_id,
    'leader_recruiter_id', v_new.leader_recruiter_id,
    'valid_from', v_new.valid_from,
    'valid_to', case when p_operation = 'revoke' then p_effective_date else v_new.valid_to end,
    'version', v_team_version,
    'revision_id', v_revision_id,
    'change', v_change
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text) is
  'P3.1-W01D internal atomic leader lifecycle implementation. Caller supplies only the authority returned directly by the canonical catalog-operator guard; revoked from every role.';

create or replace function public.direct_entry_designate_team_leader(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_leader_app_user_id uuid,
  p_effective_date date,
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
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
  return public.direct_entry_apply_team_leader_mutation(
    p_auth_subject, p_app_user_id, p_team_id, p_leader_app_user_id,
    p_effective_date, p_expected_version, p_reason, p_idempotency_key,
    'designate', v_authority
  );
end;
$$;
revoke all on function public.direct_entry_designate_team_leader(uuid, uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_designate_team_leader(uuid, uuid, uuid, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_designate_team_leader(uuid, uuid, uuid, uuid, date, integer, text, text) is
  'P3.1-W01D service-role mutation: designate or atomically replace a validated HRP team leader, team scope and team_manager_assign capability using team-version OCC, reason, idempotency, revision and immutable audit.';

create or replace function public.direct_entry_revoke_team_leader(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_effective_date date,
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
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
  return public.direct_entry_apply_team_leader_mutation(
    p_auth_subject, p_app_user_id, p_team_id, null,
    p_effective_date, p_expected_version, p_reason, p_idempotency_key,
    'revoke', v_authority
  );
end;
$$;
revoke all on function public.direct_entry_revoke_team_leader(uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_revoke_team_leader(uuid, uuid, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_revoke_team_leader(uuid, uuid, uuid, date, integer, text, text) is
  'P3.1-W01D service-role mutation: close the current or scheduled leader, matching team scope and team_manager_assign capability, including on inactive teams, using team-version OCC, reason, idempotency, revision and immutable audit.';

-- Extend the self-check to cover the sole authority resolver and three read RPCs.
do $$
declare
  v_signature text;
  v_source text;
  v_count integer;
  v_resolver_count integer;
  v_prosecdef boolean;
  v_config text;
  v_public_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_service_exec boolean;
begin
  if to_regprocedure('public.direct_entry_assert_team_leader_authority(uuid,uuid,uuid)') is not null then
    raise exception 'duplicate team-leader authority alias exists' using errcode = '55000';
  end if;
  select count(*)::int into v_resolver_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'direct_entry_assert_team_leader%';
  if v_resolver_count <> 1 then
    raise exception 'exactly one team-leader authority resolver must exist'
      using errcode = '55000';
  end if;

  foreach v_signature in array array[
    'public.direct_entry_assert_team_leader_read_authority(uuid,uuid,uuid)',
    'public.direct_entry_list_team_leaders_current(uuid,uuid,uuid,text,integer,integer)',
    'public.direct_entry_list_team_leaders_scheduled(uuid,uuid,uuid,text,integer,integer)',
    'public.direct_entry_list_team_leader_history(uuid,uuid,uuid,text,integer,integer)'
  ] loop
    select count(*)::int into v_count from pg_proc p where p.oid = v_signature::regprocedure;
    if v_count <> 1 then
      raise exception 'missing team-leader read function %', v_signature using errcode = '55000';
    end if;
    select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''),
           has_function_privilege('public', p.oid, 'EXECUTE'),
           has_function_privilege('anon', p.oid, 'EXECUTE'),
           has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           has_function_privilege('service_role', p.oid, 'EXECUTE'),
           pg_get_functiondef(p.oid)
      into v_prosecdef, v_config, v_public_exec, v_anon_exec,
           v_authenticated_exec, v_service_exec, v_source
      from pg_proc p where p.oid = v_signature::regprocedure;
    if v_source like '%direct_entry_system_vendor_team_id%' then
      raise exception 'reserved-team creator reference is forbidden in team-leader functions'
        using errcode = '55000';
    end if;
    if not v_prosecdef or v_config <> 'search_path=pg_catalog, public' then
      raise exception 'team-leader function definer/search_path drift: %', v_signature
        using errcode = '55000';
    end if;

    if v_signature = 'public.direct_entry_assert_team_leader_read_authority(uuid,uuid,uuid)' then
      if v_public_exec or v_anon_exec or v_authenticated_exec or v_service_exec then
        raise exception 'team leader resolver must be revoked from every role'
          using errcode = '55000';
      end if;
      if v_source like '%personnel_position%' then
        raise exception 'team leader resolver must not read personnel_position'
          using errcode = '55000';
      end if;
    else
      if v_public_exec or v_anon_exec or v_authenticated_exec or not v_service_exec then
        raise exception 'team-leader read RPC must be service-role-only: %', v_signature
          using errcode = '55000';
      end if;
      if v_source not like '%__system_vendor__%' then
        raise exception 'reserved-team filter missing from %', v_signature
          using errcode = '55000';
      end if;
      if v_source like '%direct_entry_system_vendor_team_id%' then
        raise exception 'reserved-team creator must not be called by read RPC %', v_signature
          using errcode = '55000';
      end if;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_signature text;
  v_source text;
  v_count integer;
  v_prosecdef boolean;
  v_config text;
  v_public_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_service_exec boolean;
  v_guard_position integer;
  v_validation_position integer;
begin
  foreach v_signature in array array[
    'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)',
    'public.direct_entry_designate_team_leader(uuid,uuid,uuid,uuid,date,integer,text,text)',
    'public.direct_entry_revoke_team_leader(uuid,uuid,uuid,date,integer,text,text)'
  ] loop
    select count(*)::int into v_count from pg_proc p where p.oid = v_signature::regprocedure;
    if v_count <> 1 then
      raise exception 'missing team-leader mutation function %', v_signature using errcode = '55000';
    end if;
    select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''),
           has_function_privilege('public', p.oid, 'EXECUTE'),
           has_function_privilege('anon', p.oid, 'EXECUTE'),
           has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           has_function_privilege('service_role', p.oid, 'EXECUTE'),
           pg_get_functiondef(p.oid)
      into v_prosecdef, v_config, v_public_exec, v_anon_exec,
           v_authenticated_exec, v_service_exec, v_source
      from pg_proc p where p.oid = v_signature::regprocedure;
    if v_source like '%direct_entry_system_vendor_team_id%' then
      raise exception 'reserved-team creator reference is forbidden in team-leader functions'
        using errcode = '55000';
    end if;
    if not v_prosecdef or v_config <> 'search_path=pg_catalog, public' then
      raise exception 'team-leader mutation definer/search_path drift: %', v_signature
        using errcode = '55000';
    end if;
    if v_signature = 'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)' then
      if v_public_exec or v_anon_exec or v_authenticated_exec or v_service_exec then
        raise exception 'internal team-leader mutation must be revoked from every role'
          using errcode = '55000';
      end if;
    else
      if v_public_exec or v_anon_exec or v_authenticated_exec or not v_service_exec then
        raise exception 'team-leader mutation RPC must be service-role-only: %', v_signature
          using errcode = '55000';
      end if;
      if v_source not like '%direct_entry_assert_catalog_operator%' then
        raise exception 'team-leader mutation RPC must call canonical catalog guard: %', v_signature
          using errcode = '55000';
      end if;
      v_guard_position := position('direct_entry_assert_catalog_operator' in v_source);
      v_validation_position := position('direct_entry_apply_team_leader_mutation' in v_source);
      if v_guard_position = 0 or v_validation_position = 0
         or v_guard_position >= v_validation_position then
        raise exception 'team-leader mutation authorization must precede input validation: %', v_signature
          using errcode = '55000';
      end if;
    end if;
    if v_source like '%personnel_position%' then
      raise exception 'team-leader mutation authority must not read personnel_position: %', v_signature
        using errcode = '55000';
    end if;
  end loop;

  if to_regprocedure('public.direct_entry_assert_team_leader_authority(uuid,uuid,uuid)') is not null then
    raise exception 'second team-leader authority resolver is forbidden' using errcode = '55000';
  end if;
end;
$$;

commit;
