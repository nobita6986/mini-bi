-- =============================================================================
-- PRE-W2-HF-D3-A - Account/Personnel DB foundation (#92, append-only).
--
-- SQL/database foundation only: durable account-operation intents, the narrow
-- Postgres RPCs that D3-B (server + Auth saga) and D3-C (personnel-from-account)
-- will call, the symmetric 1:1 account<->recruiter link guard, the app-user
-- revision action extension, the eligible-account read model and the retention /
-- reclassification entry point. No Supabase Auth call, no API route, no UI, no cron.
--
-- Authority: the canonical Full Admin triple (entry_admin + recruiter_master_manage
-- + team_master_manage) with an effective `all` scope, reusing the W03A guard
-- direct_entry_assert_actor_app_user_admin. catalog_master_manage / entry_privileged
-- edit / any role or email label never grants access. Every mutation is
-- SECURITY DEFINER with a pinned search_path, revoked from every role and (for the
-- service-role entry points) granted to service_role only.
--
-- No password or password hash is ever stored, logged or projected.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Canonical login_id predicate (mirrors the existing TS parser
--    /^[a-z0-9][a-z0-9._-]{0,63}$/ used to map HR Partner IDs to @hrpartner.vn).
-- -----------------------------------------------------------------------------
create function public.direct_entry_is_canonical_login_id(p_login_id text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select p_login_id is not null
     and p_login_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
$$;
revoke all on function public.direct_entry_is_canonical_login_id(text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_is_canonical_login_id(text) is
  'PRE-W2-HF-D3-A internal canonical login_id predicate: lowercase ascii, 1..64 chars, matching the existing HR Partner ID parser. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 2. Durable account-operation intent. No password/hash column, ever.
-- -----------------------------------------------------------------------------
create table public.direct_entry_account_operation_intents (
  intent_id uuid primary key default gen_random_uuid(),
  intent_token uuid not null default gen_random_uuid(),
  kind text not null check (kind in ('CREATE_ACCOUNT', 'RESET_PASSWORD')),
  state text not null check (state in (
    'PENDING', 'IN_FLIGHT', 'APPLIED', 'FAILED',
    'INDETERMINATE', 'BLOCKED', 'CONFLICT', 'EXPIRED'
  )),
  login_id text check (login_id is null or public.direct_entry_is_canonical_login_id(login_id)),
  display_name text check (
    display_name is null or (display_name = btrim(display_name) and length(display_name) between 1 and 256)
  ),
  account_ref uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  auth_subject uuid references auth.users(id) on delete restrict,
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz,
  resolved_at timestamptz,
  pii_purged_at timestamptz,
  tombstone_until timestamptz,
  check (kind = 'RESET_PASSWORD' or login_id is not null),
  check (kind = 'CREATE_ACCOUNT' or account_ref is not null)
);

-- Unique live-login guard: at most one unresolved CREATE_ACCOUNT intent per canonical
-- login_id. Unresolved = PENDING / IN_FLIGHT / INDETERMINATE / BLOCKED / CONFLICT, so a
-- timed-out, blocked or conflicting create cannot be re-run into a second Auth saga.
create unique index direct_entry_account_operation_intents_live_login_uniq
  on public.direct_entry_account_operation_intents (login_id)
  where kind = 'CREATE_ACCOUNT'
    and state in ('PENDING', 'IN_FLIGHT', 'INDETERMINATE', 'BLOCKED', 'CONFLICT');

alter table public.direct_entry_account_operation_intents enable row level security;
alter table public.direct_entry_account_operation_intents force row level security;
revoke all on table public.direct_entry_account_operation_intents
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_account_operation_intents is
  'PRE-W2-HF-D3-A durable account-operation intent for the two Auth-crossing operations (CREATE_ACCOUNT, RESET_PASSWORD). No password or hash is ever stored. login_id and display_name are PII and are purged per the retention contract; auth_subject and account_ref are pseudonymous identifiers.';
comment on column public.direct_entry_account_operation_intents.intent_token is
  'PRE-W2-HF-D3-A provenance marker recorded as app_metadata.account_intent by the Auth call. It is not a secret and is never trusted from the JWT/client.';

-- -----------------------------------------------------------------------------
-- 3. App-user revision action extension (meaningful action vocabulary).
-- -----------------------------------------------------------------------------
alter table public.direct_entry_app_user_revisions
  drop constraint direct_entry_app_user_revisions_action_check;

alter table public.direct_entry_app_user_revisions
  add constraint direct_entry_app_user_revisions_action_check
  check (action in (
    'enable', 'disable', 'capability_grant', 'capability_revoke',
    'scope_grant', 'scope_revoke', 'link_create', 'link_revoke',
    'account_created', 'display_name_update'
  ));

-- -----------------------------------------------------------------------------
-- 4. Symmetric 1:1 cardinality on the verified account<->recruiter link.
--    The existing direct_entry_recruiter_link_no_overlap already enforces "one
--    app_user -> one verified link"; this adds "one recruiter -> one verified link".
-- -----------------------------------------------------------------------------
create function public.direct_entry_guard_recruiter_link_recruiter_overlap()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_overlap boolean;
begin
  if new.verified then
    perform pg_advisory_xact_lock(hashtextextended('recruiter-link-recruiter:' || new.recruiter_id::text, 0));
    select exists (
      select 1
        from public.direct_entry_app_user_recruiter_links l
       where l.recruiter_id = new.recruiter_id
         and l.verified
         and l.link_id <> coalesce(new.link_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and daterange(l.valid_from, l.valid_to, '[)') &&
             daterange(new.valid_from, new.valid_to, '[)')
    ) into v_overlap;
    if v_overlap then
      raise exception 'effective recruiter link overlaps an existing verified account link'
        using errcode = '23P01';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_guard_recruiter_link_recruiter_overlap()
  from public, anon, authenticated, service_role;

create trigger direct_entry_recruiter_link_no_overlap_by_recruiter
  before insert or update of recruiter_id, verified, valid_from, valid_to
  on public.direct_entry_app_user_recruiter_links
  for each row execute function public.direct_entry_guard_recruiter_link_recruiter_overlap();

-- -----------------------------------------------------------------------------
-- 5. Internal helpers.
-- -----------------------------------------------------------------------------
create function public.direct_entry_lock_account_operation(p_intent_id uuid)
returns public.direct_entry_account_operation_intents
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_intent public.direct_entry_account_operation_intents;
begin
  if p_intent_id is null then
    raise exception 'intent required' using errcode = '22023';
  end if;
  select i.* into v_intent
    from public.direct_entry_account_operation_intents i
   where i.intent_id = p_intent_id
   for update;
  if not found then
    raise exception 'account operation intent not found' using errcode = 'P0002';
  end if;
  return v_intent;
end;
$$;
revoke all on function public.direct_entry_lock_account_operation(uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Intent lifecycle RPCs (service_role entry points).
-- -----------------------------------------------------------------------------

-- 6a. begin: write the intent first (no password). Idempotent per key; the idempotency
--     claim happens before any reason/intent write so a concurrent replay can never
--     leave an orphan intent. RESET_PASSWORD stores the target auth_subject.
create function public.direct_entry_account_operation_begin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_kind text,
  p_login_id text,
  p_display_name text,
  p_account_ref uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_action text := 'account_operation_begin';
  v_login_id text := lower(btrim(p_login_id));
  v_display_name text := btrim(p_display_name);
  v_account_ref uuid := p_account_ref;
  v_auth_subject uuid;
  v_reason_id uuid;
  v_payload_hash text;
  v_prior jsonb;
  v_intent public.direct_entry_account_operation_intents;
begin
  if p_kind is null or p_kind not in ('CREATE_ACCOUNT', 'RESET_PASSWORD') then
    raise exception 'account operation kind invalid' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if p_kind = 'CREATE_ACCOUNT' then
    if v_login_id is null or not public.direct_entry_is_canonical_login_id(v_login_id) then
      raise exception 'login id invalid' using errcode = '22023';
    end if;
    if v_display_name is null or length(v_display_name) not between 1 and 256 then
      raise exception 'display name invalid' using errcode = '22023';
    end if;
    v_account_ref := null;
  else
    if v_account_ref is null then
      raise exception 'account ref required' using errcode = '22023';
    end if;
    v_login_id := null;
    v_display_name := null;
  end if;

  -- Authority before any target read, so an unauthorized actor learns nothing.
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_kind = 'RESET_PASSWORD' then
    -- Read the target auth_subject under lock and store it on the intent.
    select u.auth_subject into v_auth_subject
      from public.direct_entry_app_users u
     where u.app_user_id = v_account_ref
     for update;
    if not found then
      raise exception 'account not found' using errcode = 'P0002';
    end if;
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'kind', p_kind, 'login_id', v_login_id, 'display_name', v_display_name,
    'account_ref', v_account_ref, 'reason', p_reason
  ));

  -- Atomic idempotency claim + hash check before any write.
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_account_operation_intents (
    kind, state, login_id, display_name, account_ref, auth_subject, idempotency_key, reason_id
  ) values (
    p_kind, 'PENDING', nullif(v_login_id, ''), nullif(v_display_name, ''), v_account_ref,
    v_auth_subject, p_idempotency_key, v_reason_id
  ) returning * into v_intent;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    v_intent.intent_id::text, 'all', 'APPLIED', v_reason_id
  );

  v_prior := jsonb_build_object(
    'intent_id', v_intent.intent_id,
    'intent_token', v_intent.intent_token,
    'kind', v_intent.kind,
    'state', v_intent.state
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_prior
  );
  return v_prior;
end;
$$;
revoke all on function public.direct_entry_account_operation_begin(uuid, uuid, text, text, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_begin(uuid, uuid, text, text, text, uuid, text, text)
  to service_role;

-- 6b. claim: the one atomic conditional update. Only the winner (PENDING -> IN_FLIGHT)
--     may proceed to call Auth.
create function public.direct_entry_account_operation_claim(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_intent_id uuid,
  p_intent_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_intent public.direct_entry_account_operation_intents;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  if p_intent_id is null or p_intent_token is null then
    raise exception 'intent and token required' using errcode = '22023';
  end if;

  update public.direct_entry_account_operation_intents
     set state = 'IN_FLIGHT',
         claimed_at = now(),
         updated_at = now()
   where intent_id = p_intent_id
     and intent_token = p_intent_token
     and state = 'PENDING'
  returning * into v_intent;

  if v_intent is null then
    select i.* into v_intent
      from public.direct_entry_account_operation_intents i
     where i.intent_id = p_intent_id;
    if v_intent is null then
      raise exception 'account operation intent not found' using errcode = 'P0002';
    end if;
    return jsonb_build_object(
      'intent_id', v_intent.intent_id,
      'intent_token', v_intent.intent_token,
      'kind', v_intent.kind,
      'state', v_intent.state,
      'claimed', false
    );
  end if;

  return jsonb_build_object(
    'intent_id', v_intent.intent_id,
    'intent_token', v_intent.intent_token,
    'kind', v_intent.kind,
    'state', v_intent.state,
    'claimed', true
  );
end;
$$;
revoke all on function public.direct_entry_account_operation_claim(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_claim(uuid, uuid, uuid, uuid)
  to service_role;

-- 6c. read: bounded read for reconcile/list.
create function public.direct_entry_account_operation_read(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_intent_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_intent public.direct_entry_account_operation_intents;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  select i.* into v_intent
    from public.direct_entry_account_operation_intents i
   where i.intent_id = p_intent_id;
  if not found then
    raise exception 'account operation intent not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'intent_id', v_intent.intent_id,
    'intent_token', v_intent.intent_token,
    'kind', v_intent.kind,
    'state', v_intent.state,
    'login_id', v_intent.login_id,
    'display_name', v_intent.display_name,
    'account_ref', v_intent.account_ref,
    'auth_subject', v_intent.auth_subject,
    'created_at', v_intent.created_at,
    'claimed_at', v_intent.claimed_at,
    'resolved_at', v_intent.resolved_at
  );
end;
$$;
revoke all on function public.direct_entry_account_operation_read(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_read(uuid, uuid, uuid)
  to service_role;

-- 6d. finish: record an explicitly observed terminal outcome with a sanitized
--     failure code. Locked transition matrix: only from IN_FLIGHT; RESET may reach
--     APPLIED/FAILED/INDETERMINATE, CREATE only FAILED/INDETERMINATE/CONFLICT (CREATE
--     APPLIED/BLOCKED are finalize-only); terminal states are immutable.
create function public.direct_entry_account_operation_finish(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_intent_id uuid,
  p_outcome text,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_intent public.direct_entry_account_operation_intents;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  if p_outcome is null then
    raise exception 'account operation outcome required' using errcode = '22023';
  end if;
  if p_failure_code is not null and p_failure_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'account operation failure code invalid' using errcode = '22023';
  end if;

  v_intent := public.direct_entry_lock_account_operation(p_intent_id);

  if v_intent.kind = 'RESET_PASSWORD' then
    if p_outcome not in ('APPLIED', 'FAILED', 'INDETERMINATE') then
      raise exception 'reset outcome invalid' using errcode = '22023';
    end if;
  else
    if p_outcome not in ('FAILED', 'INDETERMINATE', 'CONFLICT') then
      raise exception 'create outcome invalid (APPLIED is finalize-only)' using errcode = '22023';
    end if;
  end if;

  if v_intent.state in ('APPLIED', 'FAILED', 'EXPIRED', 'BLOCKED', 'CONFLICT') then
    raise exception 'account operation is terminal' using errcode = '22023';
  end if;
  if v_intent.state <> 'IN_FLIGHT' then
    raise exception 'account operation is not in flight' using errcode = '22023';
  end if;

  update public.direct_entry_account_operation_intents
     set state = p_outcome,
         resolved_at = now(),
         updated_at = now()
   where intent_id = p_intent_id
  returning * into v_intent;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, denial_code, reason_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'account_operation_finish', 'entry_admin',
    p_intent_id::text, 'all',
    case when p_outcome = 'APPLIED' then 'APPLIED' else 'REJECTED' end,
    case when p_outcome = 'APPLIED' then null else coalesce(p_failure_code, lower(p_outcome)) end,
    v_intent.reason_id
  );

  return jsonb_build_object(
    'intent_id', v_intent.intent_id, 'state', v_intent.state, 'resolved_at', v_intent.resolved_at
  );
end;
$$;
revoke all on function public.direct_entry_account_operation_finish(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_finish(uuid, uuid, uuid, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 7. finalize create: after Auth create is verified (server reads Admin API and the
--    app_metadata.account_intent marker), create the app user and mark APPLIED. It
--    accepts IN_FLIGHT or INDETERMINATE (reconcile); terminal states are immutable and
--    checked before provenance so a wrong token can never flip APPLIED to BLOCKED.
-- -----------------------------------------------------------------------------
create function public.direct_entry_account_operation_finalize_create(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_intent_id uuid,
  p_intent_token uuid,
  p_created_auth_subject uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_action text := 'account_created';
  v_intent public.direct_entry_account_operation_intents;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_app_user public.direct_entry_app_users;
  v_revision_id uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_created_auth_subject is null or p_intent_id is null or p_intent_token is null then
    raise exception 'intent, token and auth subject required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'intent_id', p_intent_id, 'intent_token', p_intent_token,
    'auth_subject', p_created_auth_subject
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_intent := public.direct_entry_lock_account_operation(p_intent_id);
  if v_intent.kind <> 'CREATE_ACCOUNT' then
    raise exception 'account operation kind mismatch' using errcode = '22023';
  end if;

  -- Terminal first: APPLIED/FAILED/EXPIRED/BLOCKED/CONFLICT are immutable and a wrong
  -- token can never rewrite them.
  if v_intent.state in ('APPLIED', 'FAILED', 'EXPIRED', 'BLOCKED', 'CONFLICT') then
    return jsonb_build_object(
      'intent_id', v_intent.intent_id, 'intent_state', v_intent.state
    );
  end if;
  if v_intent.state not in ('IN_FLIGHT', 'INDETERMINATE') then
    raise exception 'account operation is not claimable' using errcode = '22023';
  end if;

  if v_intent.intent_token <> p_intent_token then
    update public.direct_entry_account_operation_intents
       set state = 'BLOCKED', resolved_at = now(), updated_at = now()
     where intent_id = p_intent_id;
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, denial_code, reason_id
    ) values (
      p_auth_subject, p_actor_app_user_id, 'account_operation_finish', 'entry_admin',
      p_intent_id::text, 'all', 'REJECTED', 'provenance_mismatch', v_intent.reason_id
    );
    return jsonb_build_object('intent_id', p_intent_id, 'intent_state', 'BLOCKED');
  end if;

  v_reason_id := v_intent.reason_id;
  insert into public.direct_entry_app_users (auth_subject, enabled, display_name)
  values (p_created_auth_subject, true, v_intent.display_name)
  returning * into v_app_user;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    v_app_user.app_user_id, v_app_user.version, p_actor_app_user_id, v_action,
    null, jsonb_build_object('display_name', v_app_user.display_name, 'enabled', true), v_reason_id
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    v_app_user.app_user_id::text, 'all', 'APPLIED', v_reason_id,
    array['auth_subject', 'enabled', 'display_name'], v_revision_id
  );

  update public.direct_entry_account_operation_intents
     set state = 'APPLIED', resolved_at = now(), updated_at = now(),
         auth_subject = p_created_auth_subject
   where intent_id = p_intent_id;

  v_prior := jsonb_build_object(
    'app_user_id', v_app_user.app_user_id,
    'auth_subject', v_app_user.auth_subject,
    'display_name', v_app_user.display_name,
    'version', v_app_user.version,
    'revision_id', v_revision_id,
    'intent_id', p_intent_id,
    'intent_state', 'APPLIED'
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_prior
  );
  return v_prior;
end;
$$;
revoke all on function public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 8. update display name: app user + effective linked recruiter in one transaction.
--    Authority is checked before any target lookup/lock.
-- -----------------------------------------------------------------------------
create function public.direct_entry_account_operation_update_display_name(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_display_name text,
  p_expected_app_user_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_action text := 'display_name_update';
  v_display_name text := btrim(p_display_name);
  v_locked_id uuid;
  v_target public.direct_entry_app_users;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_linked_recruiter_id uuid;
  v_recruiter_before public.recruiters;
  v_recruiter_after public.recruiters;
  v_recruiter_version integer;
  v_recruiter_revision_id uuid;
  v_result jsonb;
begin
  if p_display_name is null or length(v_display_name) not between 1 and 256 then
    raise exception 'display name invalid' using errcode = '22023';
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

  -- Authority first: an unauthorized actor is denied before any target lookup/lock.
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'target_app_user_id', p_target_app_user_id, 'display_name', v_display_name,
    'expected_app_user_version', p_expected_app_user_version, 'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  for v_locked_id in
    select u.app_user_id from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id for update
  loop null; end loop;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;

  -- Resolve the effective verified link by app_user_id only; never by name/email.
  select l.recruiter_id into v_linked_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_target_app_user_id
     and l.verified
     and l.valid_from <= public.direct_entry_authorization_date()
     and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
   order by l.valid_from desc, l.link_id desc
   limit 1;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  v_before := jsonb_build_object('display_name', v_target.display_name);
  update public.direct_entry_app_users
     set display_name = v_display_name, version = version + 1, updated_at = now()
   where app_user_id = p_target_app_user_id
  returning * into v_target;
  v_after := jsonb_build_object('display_name', v_target.display_name);

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_target_app_user_id, v_target.version, p_actor_app_user_id, v_action, v_before, v_after, v_reason_id
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    p_target_app_user_id::text, 'all', 'APPLIED', v_reason_id,
    array['display_name'], v_revision_id
  );

  -- Sync the effective linked recruiter display_name in the same transaction.
  v_recruiter_version := null;
  v_recruiter_revision_id := null;
  if v_linked_recruiter_id is not null then
    select r.* into v_recruiter_before
      from public.recruiters r
     where r.recruiter_id = v_linked_recruiter_id
     for update;
    if found then
      update public.recruiters
         set display_name = v_display_name
       where recruiter_id = v_linked_recruiter_id
      returning * into v_recruiter_after;
      select b.personnel_version, b.revision_id
        into v_recruiter_version, v_recruiter_revision_id
        from public.direct_entry_bump_personnel_version(
          v_linked_recruiter_id, p_actor_app_user_id, v_reason_id,
          public.direct_entry_personnel_snapshot(v_recruiter_before),
          public.direct_entry_personnel_snapshot(v_recruiter_after)
        ) b;
    end if;
  end if;

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'recruiter_id', v_linked_recruiter_id,
    'recruiter_version', v_recruiter_version,
    'recruiter_revision_id', v_recruiter_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_account_operation_update_display_name(uuid, uuid, uuid, text, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_update_display_name(uuid, uuid, uuid, text, integer, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 9. create personnel from account: recruiter + HRP membership + verified link
--    atomically, display_name always server-side from the account. It also bumps the
--    account version, writes an app-user `link_create` revision + audit and a personnel
--    revision, all in one transaction.
-- -----------------------------------------------------------------------------
create function public.direct_entry_account_operation_create_personnel(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_account_ref uuid,
  p_expected_account_version integer,
  p_personnel_code text,
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
  v_action text := 'personnel_created';
  v_code text := btrim(p_personnel_code);
  v_position text := p_personnel_position;
  v_account public.direct_entry_app_users;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_recruiter public.recruiters;
  v_membership_id uuid;
  v_link_id uuid;
  v_personnel_revision_id uuid;
  v_app_user_revision_id uuid;
  v_result jsonb;
begin
  if p_account_ref is null then
    raise exception 'account ref required' using errcode = '22023';
  end if;
  if p_expected_account_version is null or p_expected_account_version < 1 then
    raise exception 'expected account version required' using errcode = '22023';
  end if;
  if v_code is null or v_code = '' or length(v_code) > 64 or v_code ~ '[[:space:][:cntrl:]]' then
    raise exception 'personnel code is not canonical' using errcode = '22023';
  end if;
  if v_position is null or v_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  if p_valid_from is null then
    raise exception 'provider valid from required' using errcode = '22023';
  end if;
  if p_valid_from > public.direct_entry_authorization_date() then
    raise exception 'provider valid from is in the future' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Authority first: an unauthorized actor is denied before any target lookup/lock.
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'account_ref', p_account_ref, 'expected_account_version', p_expected_account_version,
    'personnel_code', v_code, 'personnel_position', v_position,
    'valid_from', p_valid_from, 'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref
   for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if not v_account.enabled then
    raise exception 'account is not enabled' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref
       and l.verified
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
  ) then
    raise exception 'account already has an effective recruiter link' using errcode = '23514';
  end if;
  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;

  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then
    raise exception 'personnel code already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  -- Atomic create: recruiter + HRP provider membership + verified/effective link.
  insert into public.recruiters (display_name, personnel_code, personnel_position, active, version)
  values (v_account.display_name, v_code, v_position, true, 1)
  returning * into v_recruiter;

  insert into public.recruiter_provider_memberships
    (recruiter_id, provider_type, valid_from, vendor_id)
  values (v_recruiter.recruiter_id, 'hrp', p_valid_from, null)
  returning membership_id into v_membership_id;

  insert into public.direct_entry_app_user_recruiter_links (
    app_user_id, recruiter_id, verified, valid_from
  ) values (
    p_account_ref, v_recruiter.recruiter_id, true, p_valid_from
  ) returning link_id into v_link_id;

  -- Account lifecycle: bump version + link_create revision + audit.
  update public.direct_entry_app_users
     set version = version + 1, updated_at = now()
   where app_user_id = p_account_ref
  returning version into v_account.version;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref, v_account.version, p_actor_app_user_id, 'link_create',
    jsonb_build_object('recruiter_id', null),
    jsonb_build_object('recruiter_id', v_recruiter.recruiter_id),
    v_reason_id
  ) returning revision_id into v_app_user_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'link_create', 'entry_admin',
    p_account_ref::text, 'all', 'APPLIED', v_reason_id,
    array['recruiter_link'], v_app_user_revision_id
  );

  -- Personnel revision + audit.
  v_personnel_revision_id := public.direct_entry_write_personnel_revision(
    v_recruiter.recruiter_id, v_recruiter.version, p_actor_app_user_id, v_reason_id,
    null, public.direct_entry_personnel_snapshot(v_recruiter)
  );

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, personnel_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    v_recruiter.recruiter_id::text, 'all', 'APPLIED', v_reason_id,
    array['display_name', 'personnel_code', 'personnel_position', 'active'], v_personnel_revision_id
  );

  v_result := jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id,
    'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code,
    'personnel_position', v_recruiter.personnel_position,
    'version', v_recruiter.version,
    'link_id', v_link_id,
    'membership_id', v_membership_id,
    'app_user_version', v_account.version,
    'app_user_revision_id', v_app_user_revision_id,
    'personnel_revision_id', v_personnel_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 10. eligible accounts read-model: bounded list of enabled accounts with no
--     effective verified recruiter link, for the personnel-from-account UI. Never
--     exposes auth_subject, email or internal link ids.
-- -----------------------------------------------------------------------------
create function public.direct_entry_account_operation_list_eligible_accounts(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
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
  v_offset integer;
  v_total integer;
  v_rows jsonb;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  if v_page < 1 or v_page > 1000 then
    raise exception 'account list page invalid' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'account list page size invalid' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  select count(*)::int into v_total
    from public.direct_entry_app_users u
   where u.enabled
     and not exists (
       select 1 from public.direct_entry_app_user_recruiter_links l
        where l.app_user_id = u.app_user_id
          and l.verified
          and l.valid_from <= public.direct_entry_authorization_date()
          and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
     );

  select coalesce(jsonb_agg(a.row_json order by a.display_name, a.app_user_id), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'app_user_id', u.app_user_id,
               'display_name', u.display_name
             ) as row_json,
             u.display_name, u.app_user_id
        from public.direct_entry_app_users u
       where u.enabled
         and not exists (
           select 1 from public.direct_entry_app_user_recruiter_links l
            where l.app_user_id = u.app_user_id
              and l.verified
              and l.valid_from <= public.direct_entry_authorization_date()
              and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
         )
       order by u.display_name, u.app_user_id
       limit v_page_size + 1
      offset v_offset
    ) a;

  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb) into v_rows
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
     where t.ord <= v_page_size;
  end if;

  return jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'has_more', v_has_more,
    'accounts', v_rows
  );
end;
$$;
revoke all on function public.direct_entry_account_operation_list_eligible_accounts(uuid, uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_list_eligible_accounts(uuid, uuid, integer, integer)
  to service_role;

-- -----------------------------------------------------------------------------
-- 11. reclassify: retention per the locked contract. No cron; Full Admin triggers.
-- -----------------------------------------------------------------------------
create function public.direct_entry_account_operation_reclassify(
  p_auth_subject uuid,
  p_actor_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer := 0;
  v_reclassified integer := 0;
  v_purged integer := 0;
  v_deleted integer := 0;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  update public.direct_entry_account_operation_intents
     set state = 'EXPIRED', resolved_at = now(), updated_at = now()
   where state = 'PENDING'
     and created_at < now() - interval '15 minutes';
  get diagnostics v_count = row_count;
  v_reclassified := v_reclassified + v_count;

  update public.direct_entry_account_operation_intents
     set state = 'INDETERMINATE', resolved_at = now(), updated_at = now()
   where state = 'IN_FLIGHT'
     and claimed_at < now() - interval '15 minutes';
  get diagnostics v_count = row_count;
  v_reclassified := v_reclassified + v_count;

  update public.direct_entry_account_operation_intents
     set login_id = null,
         display_name = null,
         pii_purged_at = now(),
         tombstone_until = now() + interval '60 days',
         updated_at = now()
   where state in ('APPLIED', 'FAILED', 'EXPIRED')
     and resolved_at < now() - interval '30 days'
     and pii_purged_at is null
     and (login_id is not null or display_name is not null);
  get diagnostics v_count = row_count;
  v_purged := v_purged + v_count;

  update public.direct_entry_account_operation_intents
     set login_id = null,
         display_name = null,
         pii_purged_at = now(),
         tombstone_until = now() + interval '60 days',
         updated_at = now()
   where state = 'INDETERMINATE'
     and kind = 'RESET_PASSWORD'
     and resolved_at < now() - interval '30 days'
     and pii_purged_at is null
     and (login_id is not null or display_name is not null);
  get diagnostics v_count = row_count;
  v_purged := v_purged + v_count;

  delete from public.direct_entry_account_operation_intents
   where tombstone_until is not null
     and tombstone_until < now();
  get diagnostics v_deleted = row_count;

  return jsonb_build_object(
    'reclassified', v_reclassified, 'purged', v_purged, 'deleted', v_deleted
  );
end;
$$;
revoke all on function public.direct_entry_account_operation_reclassify(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_reclassify(uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 12. Install-time self-check (data free).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_source text;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'direct_entry_account_operation_intents'
       and column_name ~* 'password|secret|hash'
  ) then
    raise exception 'PRE-W2-HF-D3-A intent table must not store a password or hash';
  end if;

  if not exists (
    select 1 from pg_index i
     where i.indexrelid = 'public.direct_entry_account_operation_intents_live_login_uniq'::regclass
  ) then
    raise exception 'PRE-W2-HF-D3-A live-login unique guard is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.direct_entry_app_user_revisions'::regclass
       and conname = 'direct_entry_app_user_revisions_action_check'
  ) then
    raise exception 'PRE-W2-HF-D3-A app-user revision action check is missing';
  end if;

  if (select count(*) from pg_trigger
       where tgname = 'direct_entry_recruiter_link_no_overlap_by_recruiter' and not tgisinternal) <> 1 then
    raise exception 'PRE-W2-HF-D3-A symmetric recruiter-link guard is missing';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links a
      join public.direct_entry_app_user_recruiter_links b
        on b.recruiter_id = a.recruiter_id
       and b.verified and a.verified
       and b.link_id <> a.link_id
       and daterange(a.valid_from, a.valid_to, '[)') && daterange(b.valid_from, b.valid_to, '[)')
  ) then
    raise exception 'PRE-W2-HF-D3-A existing data violates the 1:1 recruiter-link cardinality';
  end if;

  foreach v_source in array array[
    'public.direct_entry_account_operation_begin(uuid,uuid,text,text,text,uuid,text,text)',
    'public.direct_entry_account_operation_claim(uuid,uuid,uuid,uuid)',
    'public.direct_entry_account_operation_read(uuid,uuid,uuid)',
    'public.direct_entry_account_operation_finish(uuid,uuid,uuid,text,text)',
    'public.direct_entry_account_operation_finalize_create(uuid,uuid,uuid,uuid,uuid,text)',
    'public.direct_entry_account_operation_update_display_name(uuid,uuid,uuid,text,integer,text,text)',
    'public.direct_entry_account_operation_create_personnel(uuid,uuid,uuid,integer,text,text,date,text,text)',
    'public.direct_entry_account_operation_list_eligible_accounts(uuid,uuid,integer,integer)',
    'public.direct_entry_account_operation_reclassify(uuid,uuid)'
  ] loop
    if not exists (
      select 1 from pg_proc p
       where p.oid = v_source::regprocedure
         and p.prosecdef
         and p.proconfig @> array['search_path=pg_catalog, public']
         and not has_function_privilege('anon', p.oid, 'EXECUTE')
         and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
         and has_function_privilege('service_role', p.oid, 'EXECUTE')
         and not exists (
           select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         )
    ) then
      raise exception 'PRE-W2-HF-D3-A RPC boundary wrong for %', v_source;
    end if;
  end loop;

  foreach v_source in array array[
    'public.direct_entry_lock_account_operation(uuid)',
    'public.direct_entry_guard_recruiter_link_recruiter_overlap()',
    'public.direct_entry_is_canonical_login_id(text)'
  ] loop
    if has_function_privilege('anon', v_source, 'EXECUTE')
       or has_function_privilege('authenticated', v_source, 'EXECUTE')
       or has_function_privilege('service_role', v_source, 'EXECUTE') then
      raise exception 'PRE-W2-HF-D3-A internal helper exposed: %', v_source;
    end if;
  end loop;

  raise notice 'PRE-W2-HF-D3-A migration self-check OK (account/personnel DB foundation)';
end;
$check$;

commit;
