-- =============================================================================
-- P3.1-W03A - Existing app-user lifecycle foundation (#82, append-only).
--
-- Scope: app-user status OCC root, bounded revision/audit linkage, and the
-- enable/disable lifecycle. Capability, scope, link and leader rows are not
-- cascaded or mutated here; W08A resolves the enabled flag at request time.
-- =============================================================================

begin;

alter table public.direct_entry_app_users
  add column version integer not null default 1 check (version >= 1),
  add column updated_at timestamptz not null default now();

create table public.direct_entry_app_user_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  version integer not null check (version >= 1),
  actor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  action text not null check (action in (
    'enable', 'disable', 'capability_grant', 'capability_revoke',
    'scope_grant', 'scope_revoke', 'link_create', 'link_revoke'
  )),
  before_snapshot jsonb,
  after_snapshot jsonb,
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (app_user_id, version)
);

create index direct_entry_app_user_revisions_app_user_idx
  on public.direct_entry_app_user_revisions (app_user_id, version desc);

alter table public.direct_entry_app_user_revisions enable row level security;
alter table public.direct_entry_app_user_revisions force row level security;
revoke all on table public.direct_entry_app_user_revisions
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_app_user_revisions is
  'P3.1-W03A append-only app-user revision history. W03A/B/C use the exact eight-action vocabulary and fixed four-key snapshots.';

create trigger direct_entry_app_user_revisions_immutable
  before update or delete on public.direct_entry_app_user_revisions
  for each row execute function public.direct_entry_reject_immutable_change();

alter table public.direct_entry_audit_events
  add column app_user_revision_id uuid
    references public.direct_entry_app_user_revisions(revision_id) on delete restrict;

-- W03 authority is deliberately narrower than the catalog-operator guard:
-- only the legacy Full Admin triple at effective all scope may change accounts.
create or replace function public.direct_entry_assert_actor_app_user_admin(
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
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if not (
    public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
  ) then
    raise exception 'actor is not a Full Admin' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.direct_entry_scope_grants s
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'all'
       and s.valid_from <= v_today
       and (s.valid_to is null or v_today < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from)
  ) then
    raise exception 'actor is not a Full Admin' using errcode = '42501';
  end if;

  return 'entry_admin';
end;
$$;
revoke all on function public.direct_entry_assert_actor_app_user_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_assert_actor_app_user_admin(uuid, uuid) is
  'P3.1-W03A internal lock-time guard: actor mapping + Full Admin triple + effective all scope. Returns entry_admin; revoked from every role.';

create or replace function public.direct_entry_app_user_snapshot(
  p_target_app_user_id uuid,
  p_enabled boolean,
  p_actor_app_user_id uuid
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'target_app_user_id', p_target_app_user_id,
    'changed', jsonb_build_object('enabled', p_enabled),
    'interval', null::jsonb,
    'actor_app_user_id', p_actor_app_user_id
  )
$$;
revoke all on function public.direct_entry_app_user_snapshot(uuid, boolean, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_app_user_snapshot(uuid, boolean, uuid) is
  'P3.1-W03A internal fixed four-key app-user snapshot. No auth_subject, email, reason or PII. Revoked from every role.';

create or replace function public.direct_entry_mutate_app_user_status(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_app_user_version integer,
  p_reason text,
  p_idempotency_key text,
  p_enable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_locked_id uuid;
  v_actor public.direct_entry_app_users;
  v_target public.direct_entry_app_users;
  v_action text := case when p_enable then 'enable' else 'disable' end;
  v_payload_hash text;
  v_existing_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null or p_target_app_user_id is null then
    raise exception 'actor and target are required' using errcode = '22023';
  end if;
  if p_expected_app_user_version is null or p_expected_app_user_version < 1 then
    raise exception 'expected app user version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Lock the distinct actor/target set in UUID order. Actor=self therefore locks once.
  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id
     for update
  loop
    null;
  end loop;

  select u.* into v_actor
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id;
  if not found then
    raise exception 'actor identity is not derived from the session' using errcode = '42501';
  end if;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'action', v_action,
    'target_app_user_id', p_target_app_user_id,
    'expected_app_user_version', p_expected_app_user_version,
    'reason', p_reason
  ));

  -- Read an existing result before OCC so an authorized replay is byte-identical.
  select i.request_hash, i.result
    into v_existing_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = 'app_user_' || v_action
     and i.idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
    return v_prior;
  end if;

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_enable and v_target.enabled then
    raise exception 'target app user is already enabled' using errcode = '23514';
  end if;
  if not p_enable and not v_target.enabled then
    raise exception 'target app user is already disabled' using errcode = '23514';
  end if;

  -- The actor/target rows are already locked, so this insert cannot race with another
  -- mutation for the same actor and the helper has been rechecked under those locks.
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, 'app_user_' || v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_app_user_snapshot(
    p_target_app_user_id, v_target.enabled, p_actor_app_user_id
  );
  update public.direct_entry_app_users
     set enabled = p_enable,
         version = version + 1,
         updated_at = now()
   where app_user_id = p_target_app_user_id
   returning * into v_target;
  v_after := public.direct_entry_app_user_snapshot(
    p_target_app_user_id, v_target.enabled, p_actor_app_user_id
  );

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_app_user_revisions
    (app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id)
  values
    (p_target_app_user_id, v_target.version, p_actor_app_user_id, v_action,
     v_before, v_after, v_reason_id)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, app_user_revision_id)
  values
    (p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
     p_target_app_user_id::text, 'all', 'APPLIED', v_reason_id,
     array['enabled'], v_revision_id);

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'change', v_action
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, 'app_user_' || v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_mutate_app_user_status(uuid, uuid, uuid, integer, text, text, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_enable_app_user(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_app_user_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.direct_entry_mutate_app_user_status(
    p_auth_subject, p_actor_app_user_id, p_target_app_user_id,
    p_expected_app_user_version, p_reason, p_idempotency_key, true
  )
$$;
revoke all on function public.direct_entry_enable_app_user(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_enable_app_user(uuid, uuid, uuid, integer, text, text)
  to service_role;
comment on function public.direct_entry_enable_app_user(uuid, uuid, uuid, integer, text, text) is
  'P3.1-W03A Full Admin-only app-user enable mutation with OCC, reason, idempotency and immutable audit.';

create or replace function public.direct_entry_disable_app_user(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_app_user_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.direct_entry_mutate_app_user_status(
    p_auth_subject, p_actor_app_user_id, p_target_app_user_id,
    p_expected_app_user_version, p_reason, p_idempotency_key, false
  )
$$;
revoke all on function public.direct_entry_disable_app_user(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_disable_app_user(uuid, uuid, uuid, integer, text, text)
  to service_role;
comment on function public.direct_entry_disable_app_user(uuid, uuid, uuid, integer, text, text) is
  'P3.1-W03A Full Admin-only app-user disable mutation with OCC, reason, idempotency and immutable audit; child grants/links remain unchanged.';

-- Migration self-check: schema, audit linkage, fixed snapshot shape and ACL are all
-- part of W03A. No privilege is exposed to browser roles or service_role tables.
do $$
declare
  v_definition text;
  v_keys text[];
  v_name text;
  v_count integer;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'direct_entry_app_users'
       and column_name = 'version'
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'direct_entry_app_users'
       and column_name = 'updated_at'
  ) then
    raise exception 'app-user OCC columns are missing' using errcode = '55000';
  end if;

  select array_agg(k order by k) into v_keys
    from jsonb_object_keys(public.direct_entry_app_user_snapshot(null, false, null)) k;
  if v_keys is distinct from array[
    'actor_app_user_id', 'changed', 'interval', 'target_app_user_id'
  ]::text[] then
    raise exception 'app-user snapshot must expose exactly four fixed keys' using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'public.direct_entry_app_user_snapshot(uuid,boolean,uuid)'::regprocedure
  ) into v_definition;
  foreach v_name in array array['auth_subject', 'email', 'reason', 'password', 'phone'] loop
    if v_definition like '%' || v_name || '%' then
      raise exception 'app-user snapshot leaks %', v_name using errcode = '55000';
    end if;
  end loop;

  select count(*)::int into v_count
    from information_schema.columns
   where table_schema = 'public' and table_name = 'direct_entry_audit_events'
     and column_name = 'app_user_revision_id';
  if v_count <> 1 then
    raise exception 'app-user audit revision link is missing' using errcode = '55000';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'direct_entry_app_user_revisions'
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'app-user revisions must enable and force RLS' using errcode = '55000';
  end if;

  if has_table_privilege('public', 'public.direct_entry_app_user_revisions', 'INSERT,UPDATE,DELETE,SELECT')
     or has_table_privilege('anon', 'public.direct_entry_app_user_revisions', 'INSERT,UPDATE,DELETE,SELECT')
     or has_table_privilege('authenticated', 'public.direct_entry_app_user_revisions', 'INSERT,UPDATE,DELETE,SELECT')
     or has_table_privilege('service_role', 'public.direct_entry_app_user_revisions', 'INSERT,UPDATE,DELETE,SELECT') then
    raise exception 'app-user revisions must deny table privileges' using errcode = '55000';
  end if;

  foreach v_name in array array[
    'public.direct_entry_enable_app_user(uuid,uuid,uuid,integer,text,text)',
    'public.direct_entry_disable_app_user(uuid,uuid,uuid,integer,text,text)',
    'public.direct_entry_assert_actor_app_user_admin(uuid,uuid)',
    'public.direct_entry_app_user_snapshot(uuid,boolean,uuid)'
  ] loop
    if has_function_privilege('public', v_name, 'EXECUTE')
       or has_function_privilege('anon', v_name, 'EXECUTE')
       or has_function_privilege('authenticated', v_name, 'EXECUTE') then
      raise exception 'W03A function is exposed: %', v_name using errcode = '55000';
    end if;
  end loop;
  if not has_function_privilege(
    'service_role', 'public.direct_entry_enable_app_user(uuid,uuid,uuid,integer,text,text)', 'EXECUTE'
  ) or not has_function_privilege(
    'service_role', 'public.direct_entry_disable_app_user(uuid,uuid,uuid,integer,text,text)', 'EXECUTE'
  ) then
    raise exception 'W03A RPC execute grant is missing' using errcode = '55000';
  end if;
end;
$$;

commit;
