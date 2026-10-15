-- =============================================================================
-- PRE-W2-HF Project <-> Team authority - backend/database foundation (#94, append-only).
--
-- Scope (T1B only): the mapping table, its admin read + grant/revoke RPCs, and the
-- mapping-aware replacement of the existing Team Leader Project Operations guard.
-- No UI, no API route, no client-side authority, no deployment, no DB apply.
--
-- Contract (T0, docs/handoffs/pre-w2-hf-project-team-authority-contract-final.md):
--   * D1 many-to-many Project<->Team; D6 half-open [valid_from, valid_to) with
--     valid_to > valid_from and at most one effective mapping per pair;
--   * D2/D5 grant/revoke are the existing canonical Full Admin triple at effective
--     `all` scope, both requiring reason + expected pair version (OCC, 0 when never
--     mapped) + idempotency + audit; no new capability;
--   * D3/D4 start empty (no backfill/auto-grant), revoke closes the interval and keeps
--     history, PM assignment history is never rewritten;
--   * D7 a Team Leader always keeps the Project menu, but every Project Operations read
--     and mutation on the team_manager_assign path requires an ACTIVE project that is
--     EFFECTIVELY mapped to the leader's team on the canonical authorization date.
--
-- Race handling: assign/unassign/revoke all take locks in one order
--   project row -> mapping row -> leader/team context -> revalidate -> write,
-- so a revoke that commits first denies the leader mutation and a mutation that
-- commits first is followed by the revoke. No mutation trusts a mapping read taken
-- before those locks.
--
-- Interval rule (T0-reviewed narrow amendment of D6): intervals stay half-open
-- [valid_from, valid_to) and the DB check is `valid_to is null or valid_to >= valid_from`.
-- A grant always writes valid_to = NULL, so it can never open a zero-length interval.
-- ONLY the audited revoke RPC may set valid_to = valid_from, which is how a mapping
-- granted today is cancelled today (access removed on the authorization date); that
-- zero-length write is gated by the transaction-local marker
-- 'direct_entry.project_team_scope_marker' and is rejected on any other path.
--
-- ACL posture: the table is forced RLS and revoked from every role; internal helpers
-- are SECURITY DEFINER with a pinned search_path and revoked from every role; only the
-- three new entry points are granted to service_role. `authenticated` never executes
-- a table or RPC directly.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Project <-> Team mapping history (identity + half-open interval + OCC version).
-- -----------------------------------------------------------------------------
create table public.direct_entry_project_team_scopes (
  mapping_id uuid primary key default gen_random_uuid(),
  project_id text not null references public.direct_entry_projects(project_id) on delete restrict,
  team_id uuid not null references public.teams(team_id) on delete restrict,
  valid_from date not null,
  valid_to date,
  version integer not null check (version >= 1),
  granted_by_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  revoked_by_user_id uuid
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason_id uuid not null
    references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  revoke_reason_id uuid
    references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint direct_entry_project_team_scopes_interval_check
    check (valid_to is null or valid_to >= valid_from),
  constraint direct_entry_project_team_scopes_revocation_check
    check (
      (valid_to is null and revoked_at is null
        and revoked_by_user_id is null and revoke_reason_id is null)
      or (valid_to is not null and revoked_at is not null
        and revoked_by_user_id is not null and revoke_reason_id is not null)
    )
);

-- At most ONE open mapping per (project, team); several teams may share a project and
-- several projects may share a team.
create unique index direct_entry_project_team_scopes_open_pair_uidx
  on public.direct_entry_project_team_scopes (project_id, team_id)
  where valid_to is null;

create index direct_entry_project_team_scopes_effective_idx
  on public.direct_entry_project_team_scopes (project_id, team_id, valid_from, valid_to);

create index direct_entry_project_team_scopes_team_idx
  on public.direct_entry_project_team_scopes (team_id, valid_from desc);

alter table public.direct_entry_project_team_scopes enable row level security;
alter table public.direct_entry_project_team_scopes force row level security;
revoke all on table public.direct_entry_project_team_scopes
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_project_team_scopes is
  'PRE-W2-HF Project<->Team mapping history. Half-open [valid_from, valid_to); revoke closes the interval and keeps the row. Runtime authority is fail-closed and is exposed only through the service-role SECURITY DEFINER helpers/RPCs.';
comment on column public.direct_entry_project_team_scopes.version is
  'Monotonic OCC version of the (project_id, team_id) mapping state. 0 means never mapped; each successful grant/revoke advances the pair version.';
comment on column public.direct_entry_project_team_scopes.valid_to is
  'Exclusive end of the mapping interval. NULL = still effective. Closed by revoke (valid_to = valid_from is the audited same-day cancellation marker), never by deleting the row.';

-- -----------------------------------------------------------------------------
-- 2. Interval integrity: no overlap for the same pair, even under concurrency.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_project_team_scopes_no_overlap()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_overlap boolean;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('project-team-scope:' || new.project_id, 0)
  );
  select exists (
    select 1
      from public.direct_entry_project_team_scopes s
     where s.project_id = new.project_id
       and s.team_id = new.team_id
       and s.mapping_id <> new.mapping_id
       and daterange(s.valid_from, s.valid_to, '[)') &&
           daterange(new.valid_from, new.valid_to, '[)')
  ) into v_overlap;
  if v_overlap then
    raise exception
      'project team mapping interval overlaps an existing mapping'
      using errcode = '23P01';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_project_team_scopes_no_overlap()
  from public, anon, authenticated, service_role;

create trigger direct_entry_project_team_scopes_no_overlap
  before insert or update of project_id, team_id, valid_from, valid_to
  on public.direct_entry_project_team_scopes
  for each row execute function public.direct_entry_project_team_scopes_no_overlap();

create or replace function public.direct_entry_project_team_scopes_touch()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.direct_entry_project_team_scopes_touch()
  from public, anon, authenticated, service_role;

create trigger direct_entry_project_team_scopes_touch
  before update on public.direct_entry_project_team_scopes
  for each row execute function public.direct_entry_project_team_scopes_touch();

-- History guard: rows are never deleted, identity is immutable, and the only legal
-- UPDATE is the revoke transition (close the open interval + advance the pair version).
create or replace function public.direct_entry_project_team_scopes_history_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'project team mapping history is append-only' using errcode = '55000';
  end if;
  if new.mapping_id <> old.mapping_id
     or new.project_id <> old.project_id
     or new.team_id <> old.team_id
     or new.valid_from <> old.valid_from
     or new.reason_id <> old.reason_id
     or new.granted_by_user_id <> old.granted_by_user_id
     or new.created_at <> old.created_at then
    raise exception 'project team mapping identity is immutable' using errcode = '55000';
  end if;
  if old.valid_to is not null and new.valid_to is distinct from old.valid_to then
    raise exception 'a revoked project team mapping cannot be reopened' using errcode = '55000';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'project team mapping mutation must advance the pair version'
      using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_project_team_scopes_history_guard()
  from public, anon, authenticated, service_role;

create trigger direct_entry_project_team_scopes_history_guard
  before update or delete on public.direct_entry_project_team_scopes
  for each row execute function public.direct_entry_project_team_scopes_history_guard();

-- Zero-length intervals are a cancellation marker reserved for the audited revoke RPC.
-- A grant always writes valid_to = NULL, so it can never open one; anything else that
-- tries is rejected here.
create or replace function public.direct_entry_project_team_scopes_marker_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.valid_to is not null and new.valid_to = new.valid_from
     and coalesce(
       current_setting('direct_entry.project_team_scope_marker', true), ''
     ) <> 'on' then
    raise exception 'project team mapping cancellation marker requires the audited revoke path'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_project_team_scopes_marker_guard()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_project_team_scopes_marker_guard() is
  'PRE-W2-HF trigger: rejects a zero-length mapping interval written outside the audited revoke RPC. Revoked from every role.';

create trigger direct_entry_project_team_scopes_marker_guard
  before insert or update of valid_from, valid_to on public.direct_entry_project_team_scopes
  for each row execute function public.direct_entry_project_team_scopes_marker_guard();

-- -----------------------------------------------------------------------------
-- 3. Internal helpers: the single effective-mapping predicate and the row lock.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_project_team_scope_effective(
  p_project_id text,
  p_team_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- Single source of truth for the mapping gate: the project must be ACTIVE and an
  -- effective [valid_from, valid_to) mapping must exist for this project and team on
  -- the canonical authorization date. A revoked, expired, scheduled or foreign-team
  -- mapping never satisfies it.
  select p_project_id is not null
     and p_team_id is not null
     and exists (
       select 1
         from public.direct_entry_project_team_scopes s
         join public.direct_entry_projects p
           on p.project_id = s.project_id
          and p.active
        where s.project_id = p_project_id
          and s.team_id = p_team_id
          and s.valid_from <= public.direct_entry_authorization_date()
          and (s.valid_to is null
               or public.direct_entry_authorization_date() < s.valid_to)
     )
$$;
revoke all on function public.direct_entry_project_team_scope_effective(text, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_project_team_scope_effective(text, uuid) is
  'PRE-W2-HF internal predicate: true only while the project is active and an effective mapping exists for this project and team. Revoked from every role.';

create or replace function public.direct_entry_lock_project_team_scope(
  p_project_id text,
  p_team_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_mapping_id uuid;
begin
  if p_project_id is null or p_team_id is null then
    raise exception 'project and team required' using errcode = '22023';
  end if;
  -- Lock and re-read the effective mapping row; the caller must revalidate with
  -- direct_entry_project_team_scope_effective() after every other lock is held.
  select s.mapping_id into v_mapping_id
    from public.direct_entry_project_team_scopes s
   where s.project_id = p_project_id
     and s.team_id = p_team_id
     and s.valid_from <= public.direct_entry_authorization_date()
     and (s.valid_to is null
          or public.direct_entry_authorization_date() < s.valid_to)
   order by s.valid_from desc, s.mapping_id desc
   limit 1
   for update;
  return v_mapping_id is not null;
end;
$$;
revoke all on function public.direct_entry_lock_project_team_scope(text, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_lock_project_team_scope(text, uuid) is
  'PRE-W2-HF internal lock for the leader Project Operations path: SELECT ... FOR UPDATE on the effective mapping row, returning whether one exists. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 4. Admin mapping RPCs: bounded read, grant, revoke.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_list_project_team_scopes_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text default null,
  p_team_id uuid default null,
  p_include_history boolean default false,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_include_history boolean := coalesce(p_include_history, false);
  v_offset integer;
  v_total integer;
  v_mappings jsonb;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  if p_project_id is not null and length(btrim(p_project_id)) = 0 then
    raise exception 'project filter is invalid' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  select count(*)::int into v_total
    from public.direct_entry_project_team_scopes s
   where (p_project_id is null or s.project_id = p_project_id)
     and (p_team_id is null or s.team_id = p_team_id)
     and (v_include_history or s.valid_to is null);

  select coalesce(jsonb_agg(page_rows.projection
      order by page_rows.project_id, page_rows.team_id, page_rows.valid_from desc,
               page_rows.mapping_id), '[]'::jsonb)
    into v_mappings
    from (
      select jsonb_build_object(
          'mapping_id', s.mapping_id,
          'project_id', s.project_id,
          'project_display_name', p.display_name,
          'team_id', s.team_id,
          'team_display_name', t.display_name,
          'team_code', t.code,
          'valid_from', to_jsonb(s.valid_from),
          'valid_to', to_jsonb(s.valid_to),
          'effective', s.valid_from <= public.direct_entry_authorization_date()
            and (s.valid_to is null
                 or public.direct_entry_authorization_date() < s.valid_to),
          'state', case
            when s.valid_from > public.direct_entry_authorization_date() then 'SCHEDULED'
            when s.valid_to is null
              or public.direct_entry_authorization_date() < s.valid_to then 'CURRENT'
            else 'HISTORY'
          end,
          'version', s.version,
          'revoked_at', s.revoked_at,
          'created_at', s.created_at
        ) as projection,
        s.project_id, s.team_id, s.valid_from, s.mapping_id
        from public.direct_entry_project_team_scopes s
        join public.direct_entry_projects p on p.project_id = s.project_id
        join public.teams t on t.team_id = s.team_id
       where (p_project_id is null or s.project_id = p_project_id)
         and (p_team_id is null or s.team_id = p_team_id)
         and (v_include_history or s.valid_to is null)
       order by s.project_id, s.team_id, s.valid_from desc, s.mapping_id
       limit v_page_size + 1 offset v_offset
    ) page_rows;

  v_has_more := jsonb_array_length(v_mappings) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(trimmed.value order by trimmed.ord), '[]'::jsonb) into v_mappings
      from jsonb_array_elements(v_mappings) with ordinality as trimmed(value, ord)
     where trimmed.ord <= v_page_size;
  end if;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_history', v_include_history,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'has_more', v_has_more,
    'mappings', v_mappings
  );
end;
$$;
revoke all on function public.direct_entry_list_project_team_scopes_admin(uuid, uuid, text, uuid, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_project_team_scopes_admin(uuid, uuid, text, uuid, boolean, integer, integer)
  to service_role;
comment on function public.direct_entry_list_project_team_scopes_admin(uuid, uuid, text, uuid, boolean, integer, integer) is
  'PRE-W2-HF bound/paginated Full Admin mapping read. service_role only; bounded projection of the mapping identity, interval, OCC version and effective state.';

create or replace function public.direct_entry_grant_project_team_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_team_id uuid,
  p_expected_pair_version integer,
  p_effective_from date,
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
  v_project public.direct_entry_projects;
  v_team public.teams;
  v_effective_from date;
  v_current_version integer;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_mapping public.direct_entry_project_team_scopes;
  v_result jsonb;
begin
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_expected_pair_version is null or p_expected_pair_version < 0 then
    raise exception 'expected mapping version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Canonical Full Admin triple at effective all scope; resolved server-side only.
  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_effective_from := coalesce(p_effective_from, public.direct_entry_authorization_date());

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'project_id', p_project_id,
    'team_id', p_team_id,
    'expected_pair_version', p_expected_pair_version,
    'valid_from', v_effective_from,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_grant', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Lock order: project row first, then the target team row.
  select p.* into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  if not v_project.active then
    raise exception 'project is not active' using errcode = '22023';
  end if;

  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if not v_team.active or v_team.code = '__system_vendor__' then
    raise exception 'team is not active' using errcode = '22023';
  end if;

  select coalesce(max(s.version), 0)::int into v_current_version
    from public.direct_entry_project_team_scopes s
   where s.project_id = p_project_id
     and s.team_id = p_team_id;
  if v_current_version <> p_expected_pair_version then
    raise exception 'project team mapping version conflict' using errcode = '40001';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_project_team_scopes (
    project_id, team_id, valid_from, valid_to, version,
    granted_by_user_id, reason_id
  ) values (
    p_project_id, p_team_id, v_effective_from, null, v_current_version + 1,
    p_app_user_id, v_reason_id
  ) returning * into v_mapping;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_team_scope_grant', v_authority,
     v_mapping.mapping_id::text, 'all', 'APPLIED', v_reason_id,
     array['project_id', 'team_id', 'valid_from']);

  v_result := jsonb_build_object(
    'mapping_id', v_mapping.mapping_id,
    'project_id', v_mapping.project_id,
    'team_id', v_mapping.team_id,
    'valid_from', v_mapping.valid_from,
    'valid_to', v_mapping.valid_to,
    'version', v_mapping.version,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_grant', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_grant_project_team_scope(uuid, uuid, text, uuid, integer, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_grant_project_team_scope(uuid, uuid, text, uuid, integer, date, text, text)
  to service_role;
comment on function public.direct_entry_grant_project_team_scope(uuid, uuid, text, uuid, integer, date, text, text) is
  'PRE-W2-HF Full Admin-only grant: opens one mapping interval for (project, team) under pair-version OCC (0 = never mapped), reason, idempotency and immutable audit. Stale versions and overlapping intervals fail without writes. service_role only.';

create or replace function public.direct_entry_revoke_project_team_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_mapping_id uuid,
  p_expected_pair_version integer,
  p_effective_to date,
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
  v_project_id text;
  v_project public.direct_entry_projects;
  v_mapping public.direct_entry_project_team_scopes;
  v_revoke_to date;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_result jsonb;
begin
  if p_mapping_id is null then
    raise exception 'mapping required' using errcode = '22023';
  end if;
  if p_expected_pair_version is null or p_expected_pair_version < 1 then
    raise exception 'expected mapping version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Canonical Full Admin triple at effective all scope; resolved server-side only.
  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'mapping_id', p_mapping_id,
    'expected_pair_version', p_expected_pair_version,
    'effective_to', p_effective_to,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_revoke', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Mapping identity is immutable: this unlocked read discovers only the project.
  -- Lock order is always project row first, mapping row second.
  select s.project_id into v_project_id
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id;
  if v_project_id is null then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;

  select p.* into v_project
    from public.direct_entry_projects p
   where p.project_id = v_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;

  select s.* into v_mapping
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id
   for update;
  if not found then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;
  if v_mapping.valid_to is not null then
    raise exception 'project team mapping is already revoked' using errcode = '22023';
  end if;
  if v_mapping.version <> p_expected_pair_version then
    raise exception 'project team mapping version conflict' using errcode = '40001';
  end if;

  -- Authority must end at or before the authorization date when no explicit end date is
  -- supplied, so a revoke removes leader access immediately on that date. valid_to =
  -- valid_from is the audited same-day cancellation marker and is only armed here.
  if p_effective_to is not null and p_effective_to < v_mapping.valid_from then
    raise exception 'revoke date must not precede the mapping start' using errcode = '22023';
  end if;
  v_revoke_to := greatest(
    coalesce(p_effective_to, public.direct_entry_authorization_date()),
    v_mapping.valid_from
  );

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if v_revoke_to = v_mapping.valid_from then
    perform set_config('direct_entry.project_team_scope_marker', 'on', true);
  end if;
  update public.direct_entry_project_team_scopes
     set valid_to = v_revoke_to,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where mapping_id = p_mapping_id
  returning * into v_mapping;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_team_scope_revoke', v_authority,
     p_mapping_id::text, 'all', 'APPLIED', v_reason_id, array['valid_to']);

  v_result := jsonb_build_object(
    'mapping_id', v_mapping.mapping_id,
    'project_id', v_mapping.project_id,
    'team_id', v_mapping.team_id,
    'valid_to', v_mapping.valid_to,
    'version', v_mapping.version,
    'revoked', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_revoke', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, integer, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, integer, date, text, text)
  to service_role;
comment on function public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, integer, date, text, text) is
  'PRE-W2-HF Full Admin-only revoke: closes the open mapping interval under pair-version OCC, reason, idempotency and immutable audit; never deletes or rewrites mapping or PM assignment history. service_role only.';

-- -----------------------------------------------------------------------------
-- 5. Mapping-aware Team Leader Project Operations (signatures/envelopes unchanged).
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
  v_authority text;
  v_team_id uuid;
  v_include_inactive boolean := coalesce(p_include_inactive, false);
  v_projects jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if v_authority = 'team_manager_assign' then
    v_include_inactive := false;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'project_id', p.project_id,
      'display_name', p.display_name,
      'active', p.active,
      'version', p.version,
      'created_at', rev.first_revision_at,
      'updated_at', rev.last_revision_at,
      'revision_count', coalesce(rev.revision_count, 0),
      'active_assignment_count', coalesce(asg.active_count, 0),
      'can_manage_project_master', v_authority <> 'team_manager_assign',
      'can_assign_managers',
        v_authority <> 'team_manager_assign'
        or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
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
   where (v_include_inactive or p.active)
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
     );

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'projects', v_projects
  );
end;
$$;
revoke all on function public.direct_entry_list_projects_admin(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_projects_admin(uuid, uuid, boolean)
  to service_role;
comment on function public.direct_entry_list_projects_admin(uuid, uuid, boolean) is
  'P3.1-W02A project read (PRE-W2-HF mapping-aware): Admin/Accounting receive their requested project catalog; team leaders receive active projects that are effectively mapped to their own team only. service_role only.';

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
  v_authority text;
  v_team_id uuid;
  v_project jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
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
      'active_assignment_count', coalesce(asg.active_count, 0),
      'can_manage_project_master', v_authority <> 'team_manager_assign',
      'can_assign_managers',
        v_authority <> 'team_manager_assign'
        or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
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
   where p.project_id = p_project_id
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
     );
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
  'P3.1-W02A project read (PRE-W2-HF mapping-aware): Admin/Accounting may read any project; team leaders may read only active projects effectively mapped to their own team. service_role only.';

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
  v_authority text;
  v_team_id uuid;
  v_assignments jsonb;
  v_active integer;
  v_project_version integer;
  v_project_active boolean;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;

  if p_project_id is not null then
    select p.version, p.active into v_project_version, v_project_active
      from public.direct_entry_projects p
     where p.project_id = p_project_id;
    if v_project_version is null then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    if v_authority = 'team_manager_assign'
       and (not v_project_active
            or not public.direct_entry_project_team_scope_effective(p_project_id, v_team_id)) then
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
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(a.project_id, v_team_id)
     )
     and (p_include_history or a.valid_to is null)
     and (
       v_authority <> 'team_manager_assign'
       or (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.valid_from <= public.direct_entry_authorization_date()
            and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
            and (m.valid_to is null or m.valid_to > m.valid_from)
       ) = 1
     )
     and (
       v_authority <> 'team_manager_assign'
       or exists (
         select 1
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.team_id = v_team_id
            and m.valid_from <= public.direct_entry_authorization_date()
            and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
            and (m.valid_to is null or m.valid_to > m.valid_from)
       )
     );

  select count(*)::int into v_active
    from public.direct_entry_project_manager_assignments a
   where (p_project_id is null or a.project_id = p_project_id)
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(a.project_id, v_team_id)
     )
     and a.valid_to is null
     and (
       v_authority <> 'team_manager_assign'
       or (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.valid_from <= public.direct_entry_authorization_date()
            and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
            and (m.valid_to is null or m.valid_to > m.valid_from)
       ) = 1
     )
     and (
       v_authority <> 'team_manager_assign'
       or exists (
         select 1
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.team_id = v_team_id
            and m.valid_from <= public.direct_entry_authorization_date()
            and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
            and (m.valid_to is null or m.valid_to > m.valid_from)
       )
     );

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'project_id', p_project_id,
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
  'P3.1-W02A assignment read (PRE-W2-HF mapping-aware): Admin/Accounting see all; team leaders see only assignments on active projects effectively mapped to their own team whose manager is an unambiguous current member of that team. service_role only.';

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
  v_authority text;
  v_team_id uuid;
  v_project public.direct_entry_projects;
  v_valid_from date;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_link_count integer;
  v_enabled_link_count integer;
  v_provider_count integer;
  v_hrp_provider_count integer;
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

  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
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

  -- Lock project first, then the effective mapping, then the canonical leader/team and
  -- target-recruiter authority aggregates in the same order as W01C/W01D before
  -- validating; the mapping is re-read AFTER every lock is held.
  v_project := public.direct_entry_lock_project(p_project_id, p_expected_project_version);
  if not v_project.active then
    raise exception 'project is not active' using errcode = '22023';
  end if;
  if v_authority = 'team_manager_assign' then
    if not public.direct_entry_lock_project_team_scope(p_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
    perform public.direct_entry_lock_project_team_manager_context(
      p_auth_subject, p_app_user_id, v_team_id, p_manager_recruiter_id
    );
    if not public.direct_entry_project_team_scope_effective(p_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
    select count(*)::int,
           count(*) filter (where m.team_id = v_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = p_manager_recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from);
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
    select count(*)::int
      into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to);
    select count(*)::int
      into v_enabled_link_count
      from public.direct_entry_app_user_recruiter_links l
      join public.direct_entry_app_users au on au.app_user_id = l.app_user_id
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
       and au.enabled
       and au.auth_subject is not null;
    select count(*)::int,
           count(*) filter (
             where m.provider_type = 'hrp' and m.vendor_id is null
           )::int
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = p_manager_recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);
    if v_link_count <> 1 or v_enabled_link_count <> 1
       or v_provider_count <> 1 or v_hrp_provider_count <> 1
       or not exists (
         select 1 from public.recruiters r
          where r.recruiter_id = p_manager_recruiter_id and r.active
       ) then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
  end if;
  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = p_manager_recruiter_id and r.active
  ) then
    raise exception 'project manager recruiter is not active' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
       and (l.valid_to is null or l.valid_to > l.valid_from)
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
      jsonb_set(
        public.direct_entry_project_snapshot(v_project),
        '{assignment_change}',
        jsonb_build_object(
          'change', 'ASSIGN',
          'assignment_id', v_assignment_id,
          'manager_recruiter_id', p_manager_recruiter_id,
          'valid_from', v_valid_from,
          'valid_to', null
        ),
        true
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     scope_team_id, outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_assign',
     v_authority, v_assignment_id::text,
     case when v_authority = 'team_manager_assign' then 'team' else 'all' end,
     case when v_authority = 'team_manager_assign' then v_team_id else null end,
     'APPLIED', v_reason_id,
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
  'P3.1-W02A assignment mutation (PRE-W2-HF mapping-aware): Admin/Accounting may assign any eligible manager; team leaders may assign only an eligible current member of their own team on an active project effectively mapped to that team. All use the P2.5 project OCC, idempotency, revision and audit chain.';

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
  v_authority text;
  v_team_id uuid;
  v_assignment public.direct_entry_project_manager_assignments%rowtype;
  v_project public.direct_entry_projects;
  v_project_id text;
  v_membership_count integer;
  v_matching_membership_count integer;
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

  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;

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

  -- Assignment identity is immutable: this unlocked lookup discovers only the
  -- project. Lock order is always project first, then the effective mapping for a
  -- leader, then the assignment row, then the leader/team context.
  select a.project_id into v_project_id
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id = p_assignment_id;
  if v_project_id is null then
    raise exception 'project manager assignment not found' using errcode = 'P0002';
  end if;

  v_project := public.direct_entry_lock_project(v_project_id, p_expected_project_version);
  if v_authority = 'team_manager_assign' then
    if not public.direct_entry_lock_project_team_scope(v_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
  end if;
  select * into v_assignment
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id = p_assignment_id
   for update;
  if not found then
    raise exception 'project manager assignment not found' using errcode = 'P0002';
  end if;

  if v_authority = 'team_manager_assign' then
    perform public.direct_entry_lock_project_team_manager_context(
      p_auth_subject, p_app_user_id, v_team_id, v_assignment.manager_recruiter_id
    );
    if not public.direct_entry_project_team_scope_effective(v_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
    select count(*)::int,
           count(*) filter (where m.team_id = v_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_assignment.manager_recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from);
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
  end if;

  if v_assignment.valid_to is not null then
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

  if p_expected_version <> v_assignment.version then
    raise exception 'project assignment version conflict' using errcode = '40001';
  end if;

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
      jsonb_set(
        public.direct_entry_project_snapshot(v_project),
        '{assignment_change}',
        jsonb_build_object(
          'change', 'UNASSIGN',
          'assignment_id', p_assignment_id,
          'manager_recruiter_id', v_assignment.manager_recruiter_id,
          'valid_to', v_revoke_to
        ),
        true
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     scope_team_id, outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_unassign',
     v_authority, p_assignment_id::text,
     case when v_authority = 'team_manager_assign' then 'team' else 'all' end,
     case when v_authority = 'team_manager_assign' then v_team_id else null end,
     'APPLIED', v_reason_id,
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
  'P3.1-W02A assignment mutation (PRE-W2-HF mapping-aware): Admin/Accounting may unassign any assignment; team leaders may unassign only current members of their own team on an active project effectively mapped to their team. Project is locked before the mapping and assignment; the mapping is re-read after every lock.';

-- -----------------------------------------------------------------------------
-- 6. Install-time self-check (data free).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_signature text;
  v_source text;
  v_prosecdef boolean;
  v_config text;
  v_public_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_service_exec boolean;
  v_missing text;
begin
  select string_agg(column_name, ', ') into v_missing
    from unnest(array[
      'mapping_id', 'project_id', 'team_id', 'valid_from', 'valid_to', 'version',
      'granted_by_user_id', 'revoked_by_user_id', 'reason_id', 'revoke_reason_id',
      'revoked_at', 'created_at', 'updated_at'
    ]) as expected(column_name)
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'direct_entry_project_team_scopes'
        and c.column_name = expected.column_name
   );
  if v_missing is not null then
    raise exception 'PRE-W2-HF mapping columns missing: %', v_missing using errcode = '55000';
  end if;

  if not exists (
    select 1 from pg_indexes i
     where i.schemaname = 'public'
       and i.indexname = 'direct_entry_project_team_scopes_open_pair_uidx'
       and i.indexdef like '%UNIQUE%'
       and i.indexdef like '%WHERE%'
  ) then
    raise exception 'PRE-W2-HF open-pair unique index missing' using errcode = '55000';
  end if;

  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.direct_entry_project_team_scopes'::regclass
       and c.conname = 'direct_entry_project_team_scopes_interval_check'
       and pg_get_constraintdef(c.oid) like '%>=%'
  ) then
    raise exception 'PRE-W2-HF mapping interval check missing' using errcode = '55000';
  end if;

  foreach v_signature in array array[
    'direct_entry_project_team_scopes_no_overlap',
    'direct_entry_project_team_scopes_history_guard',
    'direct_entry_project_team_scopes_marker_guard'
  ] loop
    if not exists (
      select 1 from pg_trigger t
       where t.tgrelid = 'public.direct_entry_project_team_scopes'::regclass
         and t.tgname = v_signature
         and not t.tgisinternal
    ) then
      raise exception 'PRE-W2-HF mapping trigger missing: %', v_signature using errcode = '55000';
    end if;
  end loop;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'direct_entry_project_team_scopes'
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'PRE-W2-HF mapping RLS self-check failed' using errcode = '55000';
  end if;

  if has_table_privilege('service_role',
       'public.direct_entry_project_team_scopes', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('anon',
       'public.direct_entry_project_team_scopes', 'SELECT')
     or has_table_privilege('authenticated',
       'public.direct_entry_project_team_scopes', 'SELECT') then
    raise exception 'PRE-W2-HF mapping table ACL self-check failed' using errcode = '55000';
  end if;

  -- A second Full Admin resolver must not be introduced: the mapping RPCs reuse the
  -- existing canonical guard direct_entry_assert_actor_app_user_admin.
  if to_regprocedure('public.direct_entry_assert_project_team_admin(uuid,uuid)') is not null then
    raise exception 'PRE-W2-HF must reuse the canonical Full Admin guard'
      using errcode = '55000';
  end if;

  foreach v_signature in array array[
    'public.direct_entry_project_team_scope_effective(text,uuid)',
    'public.direct_entry_lock_project_team_scope(text,uuid)',
    'public.direct_entry_project_team_scopes_no_overlap()',
    'public.direct_entry_project_team_scopes_touch()',
    'public.direct_entry_project_team_scopes_history_guard()',
    'public.direct_entry_project_team_scopes_marker_guard()'
  ] loop
    if has_function_privilege('public', v_signature, 'EXECUTE')
       or has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'PRE-W2-HF internal helper must stay revoked: %', v_signature
        using errcode = '55000';
    end if;
  end loop;

  foreach v_signature in array array[
    'public.direct_entry_list_project_team_scopes_admin(uuid,uuid,text,uuid,boolean,integer,integer)',
    'public.direct_entry_grant_project_team_scope(uuid,uuid,text,uuid,integer,date,text,text)',
    'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,integer,date,text,text)',
    'public.direct_entry_list_projects_admin(uuid,uuid,boolean)',
    'public.direct_entry_get_project_admin(uuid,uuid,text)',
    'public.direct_entry_list_project_manager_assignments(uuid,uuid,text,boolean)',
    'public.direct_entry_assign_project_manager(uuid,uuid,text,uuid,date,integer,text,text)',
    'public.direct_entry_unassign_project_manager(uuid,uuid,uuid,integer,integer,text,text)'
  ] loop
    select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''),
           has_function_privilege('public', p.oid, 'EXECUTE'),
           has_function_privilege('anon', p.oid, 'EXECUTE'),
           has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           has_function_privilege('service_role', p.oid, 'EXECUTE')
      into v_prosecdef, v_config, v_public_exec, v_anon_exec,
           v_authenticated_exec, v_service_exec
      from pg_proc p
     where p.oid = to_regprocedure(v_signature);
    if not coalesce(v_prosecdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or v_public_exec or v_anon_exec or v_authenticated_exec or not v_service_exec then
      raise exception 'PRE-W2-HF RPC boundary wrong for %', v_signature using errcode = '55000';
    end if;
  end loop;

  -- The leader path must require an effective mapping and revalidate after the locks.
  select pg_get_functiondef(
    'public.direct_entry_assign_project_manager(uuid,uuid,text,uuid,date,integer,text,text)'::regprocedure
  ) into v_source;
  if position('direct_entry_lock_project' in v_source) = 0
     or position('direct_entry_lock_project_team_scope' in v_source) = 0
     or position('direct_entry_lock_project_team_manager_context' in v_source) = 0
     or position('direct_entry_project_team_scope_effective' in v_source) = 0 then
    raise exception 'PRE-W2-HF assignment mapping/lock recheck self-check failed'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'public.direct_entry_unassign_project_manager(uuid,uuid,uuid,integer,integer,text,text)'::regprocedure
  ) into v_source;
  if position('direct_entry_lock_project_team_scope' in v_source) = 0
     or position('direct_entry_project_team_scope_effective' in v_source) = 0 then
    raise exception 'PRE-W2-HF unassignment mapping/lock recheck self-check failed'
      using errcode = '55000';
  end if;

  -- The zero-length cancellation marker belongs ONLY to the audited revoke path: the
  -- grant always inserts valid_to = NULL and must never arm the marker.
  select pg_get_functiondef(
    'public.direct_entry_grant_project_team_scope(uuid,uuid,text,uuid,integer,date,text,text)'::regprocedure
  ) into v_source;
  if position('project_team_scope_marker' in v_source) <> 0
     or position('v_current_version + 1' in v_source) = 0 then
    raise exception 'PRE-W2-HF grant must never open a zero-length interval'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,integer,date,text,text)'::regprocedure
  ) into v_source;
  if position('project_team_scope_marker' in v_source) = 0
     or position('for update' in v_source) = 0 then
    raise exception 'PRE-W2-HF revoke must own the cancellation marker and lock the mapping row'
      using errcode = '55000';
  end if;

  raise notice 'PRE-W2-HF migration self-check OK (Project <-> Team mapping, admin grant/revoke, mapping-aware leader operations)';
end;
$check$;

commit;
