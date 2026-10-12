-- =============================================================================
-- P3.1-W03B - Capability and scope grant lifecycle backend (#85, append-only).
--
-- Scope: DB lifecycle only for direct_entry_capability_grants and
-- direct_entry_scope_grants via exactly four service-role RPCs:
--   direct_entry_grant_capability / direct_entry_revoke_capability
--   direct_entry_grant_scope      / direct_entry_revoke_scope
-- No API route, no UI, no read projection lands in this lane.
--
-- Contract source: docs/handoffs/p3-1-w03-s0-r1-access-security-rebaseline.md
--   section A.5 (canonical lock order), C.2 / C.2.1 (W03B mutation contracts),
--   F (assertion matrix), G.0 (error taxonomy); R2/R3 memo confirms W03B is
--   unchanged. Reuses the W03A #82 OCC root + assert_actor_app_user_admin helper,
--   the W01D #71 direct_entry_team_leader_marker() trigger and its transaction-local
--   GUC (one shared marker mechanism, no second framework), the foundation overlap
--   trigger / partial marker-excluding unique indexes, and the foundation reason /
--   idempotency / payload-hash helpers. W03B never writes a leader-bundle row
--   (direct_entry_team_leader_assignments), never writes a recruiter link, never
--   hard-deletes a child row, and never writes a child updated_at column (none exists).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Internal fixed four-key snapshot helpers (no auth_subject, email, or PII).
--    Envelope keys are exactly: target_app_user_id, changed, interval, actor_app_user_id.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_capability_snapshot(
  p_target_app_user_id uuid,
  p_capability text,
  p_valid_from date,
  p_valid_to date,
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
    'changed', jsonb_build_object('capability', p_capability, 'valid_from', p_valid_from),
    'interval', jsonb_build_object('valid_from', p_valid_from, 'valid_to', p_valid_to),
    'actor_app_user_id', p_actor_app_user_id
  )
$$;
revoke all on function public.direct_entry_capability_snapshot(uuid, text, date, date, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_capability_snapshot(uuid, text, date, date, uuid) is
  'P3.1-W03B internal fixed four-key capability snapshot. No auth_subject, email, reason or PII. Revoked from every role.';

create or replace function public.direct_entry_scope_snapshot(
  p_target_app_user_id uuid,
  p_scope_kind text,
  p_team_id uuid,
  p_valid_from date,
  p_valid_to date,
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
    'changed', jsonb_build_object('scope_kind', p_scope_kind, 'team_id', p_team_id, 'valid_from', p_valid_from),
    'interval', jsonb_build_object('valid_from', p_valid_from, 'valid_to', p_valid_to),
    'actor_app_user_id', p_actor_app_user_id
  )
$$;
revoke all on function public.direct_entry_scope_snapshot(uuid, text, uuid, date, date, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_scope_snapshot(uuid, text, uuid, date, date, uuid) is
  'P3.1-W03B internal fixed four-key scope snapshot. No auth_subject, email, reason or PII. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 2. Capability grant. Full Admin triple at effective all scope (actor), OCC on the
--    target app-user version, target must be enabled, team_manager_assign is owned
--    by the W01D leader lifecycle and is always rejected here.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_grant_capability(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_capability text,
  p_valid_from date,
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
  v_locked_id uuid;
  v_lock_key text;
  v_target public.direct_entry_app_users;
  v_action text := 'capability_grant';
  v_payload_hash text;
  v_existing_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_grant_id uuid;
  v_after jsonb;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null or p_target_app_user_id is null then
    raise exception 'actor and target are required' using errcode = '22023';
  end if;
  if p_capability is null or p_valid_from is null then
    raise exception 'capability and valid_from are required' using errcode = '22023';
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

  -- C.2.1 step 2: lock the distinct actor + target app-user rows in UUID order.
  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id
     for update
  loop
    null;
  end loop;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'action', v_action,
    'target_app_user_id', p_target_app_user_id,
    'capability', p_capability,
    'valid_from', p_valid_from,
    'expected_app_user_version', p_expected_app_user_version,
    'reason', p_reason
  ));

  -- Read-only-first idempotency lookup (for update) so an authorized replay is byte-identical.
  select i.request_hash, i.result
    into v_existing_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = v_action
     and i.idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
    return v_prior;
  end if;

  -- C.2.1 step 3: actor scope rows before actor capability rows.
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_actor_app_user_id
   order by s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_actor_app_user_id
   order by g.grant_id
   for update;

  -- C.2.1 step 5: canonical advisory lock in lexical order (same key the overlap trigger uses).
  for v_lock_key in
    select key
      from unnest(array[
        'capability:' || p_target_app_user_id::text || ':' || p_capability
      ]) as k(key)
     where key is not null
     order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  -- C.2.1 step 6: recheck actor authority under the held locks.
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  -- C.2.1 step 7: OCC first, then surface validation.
  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;
  if p_capability = 'team_manager_assign' then
    raise exception 'security mutation is owned by the leader lifecycle RPC' using errcode = '42501';
  end if;
  if not v_target.enabled then
    raise exception 'target app user is not enabled' using errcode = '42501';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  -- The partial marker-excluding unique index raises 23505 on a duplicate open start and the
  -- overlap trigger raises 23P01 on a non-duplicate overlap; both propagate as-is (R5 FIX 7).
  insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
  values (p_target_app_user_id, p_capability, p_valid_from)
  returning grant_id into v_grant_id;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = now()
   where app_user_id = p_target_app_user_id
   returning * into v_target;

  v_after := public.direct_entry_capability_snapshot(
    p_target_app_user_id, p_capability, p_valid_from, null::date, p_actor_app_user_id
  );

  insert into public.direct_entry_app_user_revisions
    (app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id)
  values
    (p_target_app_user_id, v_target.version, p_actor_app_user_id, v_action,
     null::jsonb, v_after, v_reason_id)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, app_user_revision_id)
  values
    (p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
     p_target_app_user_id::text, 'all', 'APPLIED', v_reason_id,
     array['capability', 'valid_from'], v_revision_id);

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'grant_id', v_grant_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'change', v_action
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_grant_capability(uuid, uuid, uuid, text, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_grant_capability(uuid, uuid, uuid, text, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_grant_capability(uuid, uuid, uuid, text, date, integer, text, text) is
  'P3.1-W03B Full Admin-only capability grant with OCC, reason, idempotency, immutable revision/audit; rejects team_manager_assign (leader-owned).';

-- -----------------------------------------------------------------------------
-- 3. Capability revoke. Identified only by the immutable p_grant_id (R6 FIX D); the
--    capability is read from the locked row. Target enabled flag is NOT required
--    (R5 FIX 4 close-only path). Three-branch cancellation (R5 FIX 1): backdate is
--    22023 with zero residue; same-day / scheduled-future is an audited zero-length
--    inert marker via the shared W01D GUC; normal close sets valid_to = effective_date.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_revoke_capability(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_grant_id uuid,
  p_effective_date date,
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
  v_locked_id uuid;
  v_lock_key text;
  v_today date := public.direct_entry_authorization_date();
  v_target public.direct_entry_app_users;
  v_row public.direct_entry_capability_grants;
  v_action text := 'capability_revoke';
  v_payload_hash text;
  v_existing_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_new_valid_to date;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null or p_target_app_user_id is null
     or p_grant_id is null or p_effective_date is null then
    raise exception 'actor, target, grant and effective date are required' using errcode = '22023';
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

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id
     for update
  loop
    null;
  end loop;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'action', v_action,
    'target_app_user_id', p_target_app_user_id,
    'grant_id', p_grant_id,
    'effective_date', p_effective_date,
    'expected_app_user_version', p_expected_app_user_version,
    'reason', p_reason
  ));

  select i.request_hash, i.result
    into v_existing_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = v_action
     and i.idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
    return v_prior;
  end if;

  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_actor_app_user_id
   order by s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_actor_app_user_id
   order by g.grant_id
   for update;

  -- C.2.1 step 4: lock the target child row by immutable id; ownership + closed/marker check.
  select c.* into v_row
    from public.direct_entry_capability_grants c
   where c.grant_id = p_grant_id
   for update;
  if not found or v_row.app_user_id <> p_target_app_user_id then
    raise exception 'target_unavailable' using errcode = 'P0002';
  end if;
  if v_row.valid_to is not null
     and (v_row.valid_to = v_row.valid_from or v_row.valid_to <= v_today) then
    raise exception 'row is already closed' using errcode = '23514';
  end if;

  for v_lock_key in
    select key
      from unnest(array[
        'capability:' || p_target_app_user_id::text || ':' || v_row.capability
      ]) as k(key)
     where key is not null
     order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;
  -- The capability is read from the locked row (R6 FIX D); a leader-bundle row is rejected.
  if v_row.capability = 'team_manager_assign' then
    raise exception 'security mutation is owned by the leader lifecycle RPC' using errcode = '42501';
  end if;
  if p_effective_date < v_row.valid_from then
    raise exception 'effective_date is before valid_from' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  v_before := public.direct_entry_capability_snapshot(
    p_target_app_user_id, v_row.capability, v_row.valid_from, v_row.valid_to, p_actor_app_user_id
  );

  if p_effective_date = v_row.valid_from then
    -- Same-day / scheduled-future cancellation: audited zero-length inert marker. The shared
    -- W01D GUC is enabled only around this close and only for a non-leader row (a leader row
    -- was already rejected above), so the marker path never touches a leader bundle.
    perform set_config('direct_entry.team_leader_marker', 'on', true);
    v_new_valid_to := v_row.valid_from;
  else
    v_new_valid_to := p_effective_date;
  end if;

  -- Revoke only UPDATEs valid_to: no hard delete, no replacement INSERT, no valid_from or
  -- business-key change, and no child updated_at write (no child table has one; R5 FIX 3).
  update public.direct_entry_capability_grants
     set valid_to = v_new_valid_to
   where grant_id = p_grant_id;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = now()
   where app_user_id = p_target_app_user_id
   returning * into v_target;

  v_after := public.direct_entry_capability_snapshot(
    p_target_app_user_id, v_row.capability, v_row.valid_from, v_new_valid_to, p_actor_app_user_id
  );

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
     array['capability', 'valid_from'], v_revision_id);

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'grant_id', p_grant_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'change', v_action
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_revoke_capability(uuid, uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_revoke_capability(uuid, uuid, uuid, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_revoke_capability(uuid, uuid, uuid, uuid, date, integer, text, text) is
  'P3.1-W03B Full Admin-only capability revoke by immutable grant_id with OCC, three-branch cancellation, audited marker reuse, reason, idempotency; never hard-deletes.';

-- -----------------------------------------------------------------------------
-- 4. Scope grant. Separate RPC from capability (takes scope_kind / team_id). Rejects
--    the reserved __system_vendor__ team (23514) and a leader-bundle team scope (42501).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_grant_scope(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_scope_kind text,
  p_team_id uuid,
  p_valid_from date,
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
  v_locked_id uuid;
  v_lock_key text;
  v_today date := public.direct_entry_authorization_date();
  v_target public.direct_entry_app_users;
  v_team_code text;
  v_action text := 'scope_grant';
  v_payload_hash text;
  v_existing_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_grant_id uuid;
  v_after jsonb;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null or p_target_app_user_id is null then
    raise exception 'actor and target are required' using errcode = '22023';
  end if;
  if p_scope_kind is null or p_valid_from is null then
    raise exception 'scope_kind and valid_from are required' using errcode = '22023';
  end if;
  if (p_scope_kind = 'team') and p_team_id is null then
    raise exception 'team_id is required for a team scope' using errcode = '22023';
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

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id
     for update
  loop
    null;
  end loop;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'action', v_action,
    'target_app_user_id', p_target_app_user_id,
    'scope_kind', p_scope_kind,
    'team_id', p_team_id,
    'valid_from', p_valid_from,
    'expected_app_user_version', p_expected_app_user_version,
    'reason', p_reason
  ));

  select i.request_hash, i.result
    into v_existing_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = v_action
     and i.idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
    return v_prior;
  end if;

  -- C.2.1 step 3: actor scope rows before actor capability rows, then the target's
  -- existing scope rows of the same (scope_kind, team_id).
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_actor_app_user_id
   order by s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_actor_app_user_id
   order by g.grant_id
   for update;
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_target_app_user_id
     and s.scope_kind = p_scope_kind
     and s.team_id is not distinct from p_team_id
   order by s.grant_id
   for update;

  for v_lock_key in
    select key
      from unnest(array[
        'scope:' || p_target_app_user_id::text || ':' || p_scope_kind || ':'
          || coalesce(p_team_id::text, p_target_app_user_id::text)
      ]) as k(key)
     where key is not null
     order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;
  if not v_target.enabled then
    raise exception 'target app user is not enabled' using errcode = '42501';
  end if;

  if p_scope_kind = 'team' then
    -- W03 mutations never lock the team aggregate row (A.5 step 1 / R6 FIX F); read only.
    select t.code into v_team_code
      from public.teams t
     where t.team_id = p_team_id;
    if not found then
      raise exception 'target_unavailable' using errcode = 'P0002';
    end if;
    if v_team_code = '__system_vendor__' then
      raise exception 'reserved team cannot receive a generic scope grant' using errcode = '23514';
    end if;
    -- Leader-bundle team scope is owned by the W01D lifecycle (R7 FIX G current-or-scheduled).
    if exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_target_app_user_id
         and g.capability = 'team_manager_assign'
         and (g.valid_to is null or g.valid_to > g.valid_from)
         and (g.valid_to is null or g.valid_to > v_today)
    ) then
      raise exception 'team scope mutation is owned by the leader lifecycle RPC' using errcode = '42501';
    end if;
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from)
  values (p_target_app_user_id, p_scope_kind, p_team_id, p_valid_from)
  returning grant_id into v_grant_id;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = now()
   where app_user_id = p_target_app_user_id
   returning * into v_target;

  v_after := public.direct_entry_scope_snapshot(
    p_target_app_user_id, p_scope_kind, p_team_id, p_valid_from, null::date, p_actor_app_user_id
  );

  insert into public.direct_entry_app_user_revisions
    (app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id)
  values
    (p_target_app_user_id, v_target.version, p_actor_app_user_id, v_action,
     null::jsonb, v_after, v_reason_id)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, app_user_revision_id)
  values
    (p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
     p_target_app_user_id::text, 'all', 'APPLIED', v_reason_id,
     array['scope_kind', 'team_id', 'valid_from'], v_revision_id);

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'grant_id', v_grant_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'change', v_action
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_grant_scope(uuid, uuid, uuid, text, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_grant_scope(uuid, uuid, uuid, text, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_grant_scope(uuid, uuid, uuid, text, uuid, date, integer, text, text) is
  'P3.1-W03B Full Admin-only scope grant with OCC, reason, idempotency, immutable revision/audit; rejects __system_vendor__ (23514) and leader-bundle team scope (42501).';

-- -----------------------------------------------------------------------------
-- 5. Scope revoke. Identified only by the immutable p_grant_id; scope_kind / team_id
--    are read from the locked row. Target enabled flag is NOT required (close-only).
--    A leader-bundle team scope is rejected; three-branch cancellation as in capability.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_revoke_scope(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_grant_id uuid,
  p_effective_date date,
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
  v_locked_id uuid;
  v_lock_key text;
  v_today date := public.direct_entry_authorization_date();
  v_target public.direct_entry_app_users;
  v_row public.direct_entry_scope_grants;
  v_action text := 'scope_revoke';
  v_payload_hash text;
  v_existing_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_new_valid_to date;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null or p_target_app_user_id is null
     or p_grant_id is null or p_effective_date is null then
    raise exception 'actor, target, grant and effective date are required' using errcode = '22023';
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

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id
     for update
  loop
    null;
  end loop;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'action', v_action,
    'target_app_user_id', p_target_app_user_id,
    'grant_id', p_grant_id,
    'effective_date', p_effective_date,
    'expected_app_user_version', p_expected_app_user_version,
    'reason', p_reason
  ));

  select i.request_hash, i.result
    into v_existing_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = v_action
     and i.idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
    return v_prior;
  end if;

  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_actor_app_user_id
   order by s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_actor_app_user_id
   order by g.grant_id
   for update;

  -- C.2.1 step 4: lock the target scope row by immutable id; ownership + closed/marker check.
  select s.* into v_row
    from public.direct_entry_scope_grants s
   where s.grant_id = p_grant_id
   for update;
  if not found or v_row.app_user_id <> p_target_app_user_id then
    raise exception 'target_unavailable' using errcode = 'P0002';
  end if;
  if v_row.valid_to is not null
     and (v_row.valid_to = v_row.valid_from or v_row.valid_to <= v_today) then
    raise exception 'row is already closed' using errcode = '23514';
  end if;

  for v_lock_key in
    select key
      from unnest(array[
        'scope:' || p_target_app_user_id::text || ':' || v_row.scope_kind || ':'
          || coalesce(v_row.team_id::text, p_target_app_user_id::text)
      ]) as k(key)
     where key is not null
     order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;
  -- A leader-bundle team scope is owned by the W01D lifecycle (R7 FIX G current-or-scheduled).
  -- A non-leader team scope (no current/scheduled team_manager_assign) remains W03B-revocable
  -- per the B matrix "Scope grant / revoke (own / team / all): allow" for a Full Admin.
  if v_row.scope_kind = 'team' and exists (
    select 1
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_target_app_user_id
       and g.capability = 'team_manager_assign'
       and (g.valid_to is null or g.valid_to > g.valid_from)
       and (g.valid_to is null or g.valid_to > v_today)
  ) then
    raise exception 'security mutation is owned by the leader lifecycle RPC' using errcode = '42501';
  end if;
  if p_effective_date < v_row.valid_from then
    raise exception 'effective_date is before valid_from' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  v_before := public.direct_entry_scope_snapshot(
    p_target_app_user_id, v_row.scope_kind, v_row.team_id, v_row.valid_from, v_row.valid_to, p_actor_app_user_id
  );

  if p_effective_date = v_row.valid_from then
    perform set_config('direct_entry.team_leader_marker', 'on', true);
    v_new_valid_to := v_row.valid_from;
  else
    v_new_valid_to := p_effective_date;
  end if;

  update public.direct_entry_scope_grants
     set valid_to = v_new_valid_to
   where grant_id = p_grant_id;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = now()
   where app_user_id = p_target_app_user_id
   returning * into v_target;

  v_after := public.direct_entry_scope_snapshot(
    p_target_app_user_id, v_row.scope_kind, v_row.team_id, v_row.valid_from, v_new_valid_to, p_actor_app_user_id
  );

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
     array['scope_kind', 'team_id', 'valid_from'], v_revision_id);

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'grant_id', p_grant_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'change', v_action
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_revoke_scope(uuid, uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_revoke_scope(uuid, uuid, uuid, uuid, date, integer, text, text)
  to service_role;
comment on function public.direct_entry_revoke_scope(uuid, uuid, uuid, uuid, date, integer, text, text) is
  'P3.1-W03B Full Admin-only scope revoke by immutable grant_id with OCC, three-branch cancellation, audited marker reuse, reason, idempotency; rejects a leader-bundle team scope; never hard-deletes.';

-- -----------------------------------------------------------------------------
-- 6. Fail-closed migration self-check: signatures, ACL, search_path, fixed snapshot
--    shape, eight-verb revision vocabulary, marker reuse, child-table shape (no
--    updated_at), and absence of forbidden writes (leader bundle / hard delete).
-- -----------------------------------------------------------------------------
do $$
declare
  v_name text;
  v_definition text;
  v_keys text[];
  v_token text;
  v_count integer;
begin
  -- 6.1 The four public RPCs exist with the exact locked signatures.
  foreach v_name in array array[
    'public.direct_entry_grant_capability(uuid,uuid,uuid,text,date,integer,text,text)',
    'public.direct_entry_revoke_capability(uuid,uuid,uuid,uuid,date,integer,text,text)',
    'public.direct_entry_grant_scope(uuid,uuid,uuid,text,uuid,date,integer,text,text)',
    'public.direct_entry_revoke_scope(uuid,uuid,uuid,uuid,date,integer,text,text)'
  ] loop
    if to_regprocedure(v_name) is null then
      raise exception 'W03B RPC signature is missing: %', v_name using errcode = '55000';
    end if;
    if not has_function_privilege('service_role', v_name, 'EXECUTE') then
      raise exception 'W03B RPC execute grant is missing: %', v_name using errcode = '55000';
    end if;
    if has_function_privilege('public', v_name, 'EXECUTE')
       or has_function_privilege('anon', v_name, 'EXECUTE')
       or has_function_privilege('authenticated', v_name, 'EXECUTE') then
      raise exception 'W03B RPC is exposed to a browser role: %', v_name using errcode = '55000';
    end if;
  end loop;

  -- 6.2 Internal snapshot helpers are revoked from every role and expose exactly four keys.
  foreach v_name in array array[
    'public.direct_entry_capability_snapshot(uuid,text,date,date,uuid)',
    'public.direct_entry_scope_snapshot(uuid,text,uuid,date,date,uuid)'
  ] loop
    if has_function_privilege('public', v_name, 'EXECUTE')
       or has_function_privilege('anon', v_name, 'EXECUTE')
       or has_function_privilege('authenticated', v_name, 'EXECUTE')
       or has_function_privilege('service_role', v_name, 'EXECUTE') then
      raise exception 'W03B internal helper is exposed: %', v_name using errcode = '55000';
    end if;
  end loop;

  select array_agg(k order by k) into v_keys
    from jsonb_object_keys(public.direct_entry_capability_snapshot(null, null, null, null, null)) k;
  if v_keys is distinct from array['actor_app_user_id', 'changed', 'interval', 'target_app_user_id']::text[] then
    raise exception 'capability snapshot must expose exactly four fixed keys' using errcode = '55000';
  end if;
  select array_agg(k order by k) into v_keys
    from jsonb_object_keys(public.direct_entry_scope_snapshot(null, null, null, null, null, null)) k;
  if v_keys is distinct from array['actor_app_user_id', 'changed', 'interval', 'target_app_user_id']::text[] then
    raise exception 'scope snapshot must expose exactly four fixed keys' using errcode = '55000';
  end if;

  foreach v_name in array array[
    'public.direct_entry_capability_snapshot(uuid,text,date,date,uuid)',
    'public.direct_entry_scope_snapshot(uuid,text,uuid,date,date,uuid)'
  ] loop
    select pg_get_functiondef(v_name::regprocedure) into v_definition;
    foreach v_token in array array['auth_subject', 'email', 'password', 'phone'] loop
      if v_definition like '%' || v_token || '%' then
        raise exception 'W03B snapshot leaks %', v_token using errcode = '55000';
      end if;
    end loop;
  end loop;

  -- 6.3 Every new function is SECURITY DEFINER with a pinned search_path.
  foreach v_name in array array[
    'public.direct_entry_grant_capability(uuid,uuid,uuid,text,date,integer,text,text)',
    'public.direct_entry_revoke_capability(uuid,uuid,uuid,uuid,date,integer,text,text)',
    'public.direct_entry_grant_scope(uuid,uuid,uuid,text,uuid,date,integer,text,text)',
    'public.direct_entry_revoke_scope(uuid,uuid,uuid,uuid,date,integer,text,text)',
    'public.direct_entry_capability_snapshot(uuid,text,date,date,uuid)',
    'public.direct_entry_scope_snapshot(uuid,text,uuid,date,date,uuid)'
  ] loop
    select count(*)::int into v_count
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.oid = v_name::regprocedure
       and p.prosecdef
       and 'search_path=pg_catalog, public' = any(p.proconfig);
    if v_count <> 1 then
      raise exception 'W03B function is not SECURITY DEFINER with pinned search_path: %', v_name
        using errcode = '55000';
    end if;
  end loop;

  -- 6.4 The eight-verb app-user revision vocabulary is unchanged (no ninth verb).
  select count(*)::int into v_count
    from pg_constraint c
   where c.conrelid = 'public.direct_entry_app_user_revisions'::regclass
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%action%';
  if v_count <> 1 then
    raise exception 'app-user revision action CHECK is missing' using errcode = '55000';
  end if;
  select pg_get_constraintdef(c.oid) into v_definition
    from pg_constraint c
   where c.conrelid = 'public.direct_entry_app_user_revisions'::regclass
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%action%';
  foreach v_name in array array[
    'enable', 'disable', 'capability_grant', 'capability_revoke',
    'scope_grant', 'scope_revoke', 'link_create', 'link_revoke'
  ] loop
    if v_definition not like '%''' || v_name || '''%' then
      raise exception 'app-user revision vocabulary lost %', v_name using errcode = '55000';
    end if;
  end loop;
  if v_definition like '%''create''%' or v_definition like '%''app_user_%' then
    raise exception 'app-user revision vocabulary gained a forbidden verb' using errcode = '55000';
  end if;

  -- 6.5 Marker mechanism reuse: the single W01D trigger function still exists and each
  --     revoke RPC enables the shared GUC only around its own audited close.
  if to_regprocedure('public.direct_entry_team_leader_marker()') is null then
    raise exception 'shared W01D marker trigger function is missing' using errcode = '55000';
  end if;
  foreach v_name in array array[
    'public.direct_entry_revoke_capability(uuid,uuid,uuid,uuid,date,integer,text,text)',
    'public.direct_entry_revoke_scope(uuid,uuid,uuid,uuid,date,integer,text,text)'
  ] loop
    select pg_get_functiondef(v_name::regprocedure) into v_definition;
    if v_definition not like '%set_config(''direct_entry.team_leader_marker'', ''on'', true)%' then
      raise exception 'W03B revoke does not reuse the shared marker GUC: %', v_name
        using errcode = '55000';
    end if;
  end loop;

  -- 6.6 No child table gained an updated_at column (R5 FIX 3: only the OCC root is bumped).
  select count(*)::int into v_count
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('direct_entry_capability_grants', 'direct_entry_scope_grants')
     and column_name = 'updated_at';
  if v_count <> 0 then
    raise exception 'a W03B child table gained an updated_at column' using errcode = '55000';
  end if;

  -- 6.7 Absence of forbidden writes: no leader-bundle table reference and no hard delete
  --     of a capability / scope row in any W03B RPC body.
  foreach v_name in array array[
    'public.direct_entry_grant_capability(uuid,uuid,uuid,text,date,integer,text,text)',
    'public.direct_entry_revoke_capability(uuid,uuid,uuid,uuid,date,integer,text,text)',
    'public.direct_entry_grant_scope(uuid,uuid,uuid,text,uuid,date,integer,text,text)',
    'public.direct_entry_revoke_scope(uuid,uuid,uuid,uuid,date,integer,text,text)'
  ] loop
    select pg_get_functiondef(v_name::regprocedure) into v_definition;
    if v_definition like '%direct_entry_team_leader_assignments%' then
      raise exception 'W03B RPC references the leader-bundle table: %', v_name using errcode = '55000';
    end if;
    if v_definition like '%direct_entry_app_user_recruiter_links%' then
      raise exception 'W03B RPC references the recruiter-link table: %', v_name using errcode = '55000';
    end if;
    if v_definition like '%delete from public.direct_entry_capability_grants%'
       or v_definition like '%delete from public.direct_entry_scope_grants%' then
      raise exception 'W03B RPC hard-deletes a child row: %', v_name using errcode = '55000';
    end if;
  end loop;
end;
$$;

commit;
