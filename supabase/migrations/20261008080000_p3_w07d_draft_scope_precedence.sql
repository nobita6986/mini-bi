-- =============================================================================
-- P3-W07D - draft scope precedence + historical draft edit decoupling.
--
-- Task:    P3-W07D_DRAFT_SCOPE_PRECEDENCE_HISTORICAL_EDIT_HOTFIX (T1B)
-- Status:  P3-W07D_DRAFT_SCOPE_HISTORICAL_EDIT_LOCAL_PASS_AWAITING_INTEGRATION
-- Slot:    provisional #48 (`20261008080000`). W05A owns the next slot (#47,
--          `20261008070000`); T0 must confirm the slot at Release A integration.
--
-- ROOT CAUSE (Production read-only evidence, counts/booleans only):
--   * direct_entry_assert_draft_access selected count(*), min(scope_kind) and
--     required v_matches = 1. An owner holding both an own and an all grant has
--     TWO matching rows for a row it owns, so the whole list RPC raised 42501
--     ('draft scope/capability denied').
--   * direct_entry_assert_entry_access had the identical exact-one defect, which
--     would deny the same actor again once the submission leaves DRAFT.
--   * direct_entry_update_draft_row re-derived provider/team whenever the patch
--     merely CONTAINED recruiter_id/first_work_date, so the patch SHAPE (a
--     client-controlled input) decided whether the row identity was rewritten,
--     and an undefined Vendor team rule answered with a bare 42501.
--
-- WHAT THIS MIGRATION DOES (delta only):
--   1. Both assert helpers resolve the STRONGEST effective scope
--      (all > team > own) instead of demanding exactly one match. Zero matching
--      scopes still fail closed with 42501; a single match keeps the old answer;
--      the per-scope capability must still be effective.
--   2. direct_entry_update_draft_row compares the incoming recruiter_id AND
--      first_work_date with the PERSISTED row instead of with the patch shape.
--      A patch that only mentions unchanged keys re-derives nothing, and only a
--      real recruiter/date change re-resolves provider/team - at the row's OWN
--      effective work date (v_new_work_date), the same date
--      direct_entry_validate_identity checks, so the derived identity can never
--      disagree with the row invariant. A changed recruiter with no effective
--      team (Vendor) fails closed with a dedicated code because the source
--      defines no team rule for it.
--
-- No capability token, grant bundle, table, RLS posture or Production checksum
-- is changed. Migrations #1-#46 stay byte-identical.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1a. Entry scope precedence (also fixes the post-DRAFT path).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_entry_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text,
  p_entry_owner uuid,
  p_team_id uuid,
  p_effective_date date,
  p_required_scope text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_all boolean;
  v_team boolean;
  v_own boolean;
  v_scope text;
begin
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, p_capability
  );
  -- Multiple effective scopes are legitimate (for example own + all). Resolve
  -- the strongest one instead of demanding exactly one matching grant.
  select
      coalesce(bool_or(g.scope_kind = 'all'), false),
      coalesce(bool_or(g.scope_kind = 'team' and g.team_id = p_team_id), false),
      coalesce(bool_or(g.scope_kind = 'own' and p_entry_owner = p_app_user_id), false)
    into v_all, v_team, v_own
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.valid_from <= p_effective_date
     and (g.valid_to is null or p_effective_date < g.valid_to)
     and (p_required_scope is null or g.scope_kind = p_required_scope);
  v_scope := case
    when v_all then 'all'
    when v_team then 'team'
    when v_own then 'own'
    else null
  end;
  if v_scope is null then
    raise exception 'resource scope denied' using errcode = '42501';
  end if;
  return v_scope;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1b. Draft scope precedence (the helper that failed in Production).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_draft_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_resource_scope_date date,
  p_required_scope text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_all boolean;
  v_team boolean;
  v_own boolean;
  v_scope text;
  v_capability text;
begin
  -- The capability for the matching scope kind must still be effective, so the
  -- capability grant stays joined exactly as before; only the exact-one match
  -- requirement is replaced by deterministic precedence.
  select
      coalesce(bool_or(g.scope_kind = 'all'), false),
      coalesce(bool_or(g.scope_kind = 'team' and g.team_id = p_team_id), false),
      coalesce(bool_or(g.scope_kind = 'own' and p_entry_owner = p_app_user_id), false)
    into v_all, v_team, v_own
    from public.direct_entry_scope_grants g
    join public.direct_entry_capability_grants c
      on c.app_user_id = g.app_user_id
     and c.valid_from <= public.direct_entry_authorization_date()
     and (c.valid_to is null or public.direct_entry_authorization_date() < c.valid_to)
     and c.capability = case g.scope_kind
       when 'own' then 'entry_own'
       when 'team' then 'entry_team'
       else 'entry_admin'
     end
   where g.app_user_id = p_app_user_id
     and g.valid_from <= p_resource_scope_date
     and (g.valid_to is null or p_resource_scope_date < g.valid_to)
     and (p_required_scope is null or g.scope_kind = p_required_scope);
  v_scope := case
    when v_all then 'all'
    when v_team then 'team'
    when v_own then 'own'
    else null
  end;
  if v_scope is null then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;
  v_capability := case v_scope
    when 'own' then 'entry_own'
    when 'team' then 'entry_team'
    else 'entry_admin'
  end;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, v_capability
  );
  return v_scope;
end;
$$;

-- ACL posture is restored EXACTLY as migration #3 defined it: the two scope
-- helpers are internal (only callable from other SECURITY DEFINER functions), so
-- they stay revoked from every PostgREST role, service_role included. No grant is
-- added here, which keeps the derived function/service_role inventory unchanged.
revoke all on function public.direct_entry_assert_entry_access(uuid, uuid, text, uuid, uuid, date, text)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_assert_draft_access(uuid, uuid, uuid, uuid, date, text)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_assert_draft_access(uuid, uuid, uuid, uuid, date, text) is
  'P3-W07D: resolve the strongest effective draft scope (all > team > own). Zero matching effective scopes fail closed with 42501; several matching scopes no longer raise. The capability of the winning scope kind must be effective.';

comment on function public.direct_entry_assert_entry_access(uuid, uuid, text, uuid, uuid, date, text) is
  'P3-W07D: resolve the strongest effective entry scope (all > team > own). Zero matching effective scopes fail closed with 42501; several matching scopes no longer raise the post-DRAFT path.';

-- -----------------------------------------------------------------------------
-- 2. Draft update: only a REAL recruiter change re-resolves the derived
--    provider/team, and it resolves them against the current HCM date.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_update_draft_row(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_submission public.direct_entry_submissions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_patch_fields text[];
  v_scope text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_new_recruiter_id uuid;
  v_new_work_date date;
  v_provider text;
  v_team uuid;
  v_count integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or public.direct_entry_contains_authority(p_patch)
     or exists (
       select 1 from jsonb_object_keys(p_patch) as patch_key(key)
        where patch_key.key not in (
          'project_id', 'first_work_date', 'employee_code', 'worker_details',
          'recruiter_id', 'labor_type'
        )
     ) then
    raise exception 'invalid draft patch' using errcode = '22023';
  end if;
  if p_patch ? 'worker_details' then
    if jsonb_typeof(p_patch->'worker_details') <> 'object' then
      raise exception 'invalid draft worker patch' using errcode = '22023';
    end if;
    if jsonb_typeof(p_patch->'worker_details'->'display_name') <> 'string' then
      raise exception 'invalid draft worker patch' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_object_keys(p_patch->'worker_details') as worker_key(key)
       where worker_key.key <> 'display_name'
    ) then
      raise exception 'invalid draft worker patch' using errcode = '22023';
    end if;
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_row_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'expected_version', p_expected_version, 'patch', p_patch
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if v_entry.deleted_at is not null then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  select * into v_submission from public.direct_entry_submissions
   where submission_id = v_entry.submission_id for update;
  if v_submission.state <> 'DRAFT' then
    raise exception 'draft submission is not editable' using errcode = '42501';
  end if;
  if p_expected_version is null or p_expected_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_new_recruiter_id := case when p_patch ? 'recruiter_id'
    then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end;
  v_new_work_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  -- P3-W07D: the patch is compared with the PERSISTED row at the DB boundary,
  -- never with the shape of the client patch. Only a real recruiter change or a
  -- real first_work_date change re-derives provider/team, and both resolve at
  -- v_new_work_date - the same effective date direct_entry_validate_identity
  -- checks - so a derived identity can never disagree with the row invariant.
  -- A name/employee-code-only edit (the historical edit case) never touches the
  -- derived identity at all.
  if v_new_recruiter_id is distinct from v_entry.recruiter_id
     or v_new_work_date is distinct from v_entry.first_work_date then
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_new_recruiter_id
       and m.valid_from <= v_new_work_date
       and (m.valid_to is null or v_new_work_date < m.valid_to);
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_new_recruiter_id
       and m.valid_from <= v_new_work_date
       and (m.valid_to is null or v_new_work_date < m.valid_to);
    if v_count <> 1 then
      -- A Vendor recruiter can carry no business team while
      -- direct_entries.team_id is NOT NULL. Assigning one needs a T0-locked rule
      -- the current source does not define, so fail closed with a dedicated code
      -- instead of guessing a team.
      raise exception 'draft identity change needs an explicit team rule'
        using errcode = 'P0001';
    end if;
  else
    -- No identity change requested: keep the stored identity verbatim.
    v_provider := v_entry.provider_type;
    v_team := v_entry.team_id;
  end if;
  if not exists (
    select 1 from public.recruiters r where r.recruiter_id = v_new_recruiter_id and r.active
  ) or not exists (
    select 1 from public.direct_entry_projects p
     where p.project_id = coalesce(p_patch->>'project_id', v_entry.project_id) and p.active
  ) or not exists (
    select 1 from public.teams t where t.team_id = v_team and t.active
  ) then
    raise exception 'inactive draft master' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_team, v_new_work_date, v_scope
  );
  update public.direct_entries set
    project_id = case when p_patch ? 'project_id' then p_patch->>'project_id' else project_id end,
    first_work_date = case when p_patch ? 'first_work_date' then (p_patch->>'first_work_date')::date else first_work_date end,
    employee_code = case when p_patch ? 'employee_code' then p_patch->>'employee_code' else employee_code end,
    worker_details = case when p_patch ? 'worker_details'
      then v_entry.worker_details || (p_patch->'worker_details') else worker_details end,
    recruiter_id = case when p_patch ? 'recruiter_id' then (p_patch->>'recruiter_id')::uuid else recruiter_id end,
    labor_type = case when p_patch ? 'labor_type' then p_patch->>'labor_type' else labor_type end,
    team_id = v_team,
    provider_type = v_provider,
    version = version + 1
   where entry_id = p_entry_id;
  update public.direct_entry_submissions set version = version + 1
   where submission_id = v_entry.submission_id;
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Draft row update');
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_entry.submission_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state','DRAFT','version',v_submission.version,
      'entry_count',(select count(*) from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    jsonb_build_object('state','DRAFT','version',v_submission.version + 1,
      'entry_count',(select count(*) from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    v_submission.version + 1
  );
  select array_agg(key order by key) into v_patch_fields from jsonb_object_keys(p_patch) key;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id,
    submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_row_update',
    case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end,
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, v_submission_revision_id, v_patch_fields
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'version', v_entry.version + 1,
    'submission_version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_row_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text)
  to service_role;

comment on function public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text) is
  'P3-W07D: draft PATCH. The persisted row, not the patch shape, decides whether provider/team are re-derived: a real recruiter or first_work_date change re-resolves them at the row own effective work date, and a patch that only mentions unchanged keys keeps the stored recruiter_id/team_id/provider_type. A changed Vendor recruiter fails closed with P0001 because no team rule is defined for it.';

-- -----------------------------------------------------------------------------
-- In-migration self-check (structural, data-agnostic).
-- -----------------------------------------------------------------------------
do $$
declare
  v_helper text;
  v_internal boolean;
  v_secdef boolean;
begin
  for v_helper, v_internal in
    select signature, internal
      from (values
        ('public.direct_entry_assert_entry_access(uuid, uuid, text, uuid, uuid, date, text)', true),
        ('public.direct_entry_assert_draft_access(uuid, uuid, uuid, uuid, date, text)', true),
        ('public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text)', false)
      ) as expected(signature, internal)
  loop
    select p.prosecdef into v_secdef
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.oid = v_helper::regprocedure;
    if v_secdef is null then
      raise exception 'W07D helper % not found in pg_proc', v_helper;
    end if;
    if not v_secdef then
      raise exception 'W07D helper % must be SECURITY DEFINER', v_helper;
    end if;
    if has_function_privilege('anon', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'W07D helper % must not be EXECUTE-able by anon', v_helper;
    end if;
    if has_function_privilege('authenticated', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'W07D helper % must not be EXECUTE-able by authenticated', v_helper;
    end if;
    if v_internal then
      -- Internal scope helper: same revoke-only posture as migration #3, so the
      -- derived service_role inventory must not change.
      if has_function_privilege('service_role', v_helper::regprocedure, 'EXECUTE') then
        raise exception 'W07D internal helper % must stay revoke-only', v_helper;
      end if;
    elsif not has_function_privilege('service_role', v_helper::regprocedure, 'EXECUTE') then
      raise exception 'W07D RPC % must be EXECUTE-able by service_role', v_helper;
    end if;
  end loop;

  raise notice 'P3-W07D migration self-check OK (scope precedence + draft edit decoupling)';
end
$$;

commit;

