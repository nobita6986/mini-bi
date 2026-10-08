-- P2.5-HF-R3 - worker full-field correction (project manager proposals) and direct
-- correction by Admin / BoD-Accounting on already submitted workers.
--
-- Base: origin/main@1b7fc98, ledger 60. Historical migrations are untouched; #61 re-creates
-- two functions and patches two more through the same verified source-replacement pattern
-- used by #53/#58.
--
-- T0 policy lock (this task) supersedes survey line 379/381 for the project-manager case:
--   (1) a project manager with an effective assignment may PROPOSE every business field of a
--       worker profile - including the fields #53 locked (display_name, employee_code,
--       project_id, first_work_date, recruiter_id, labor_type) - still through reason + OCC +
--       idempotency + approval. No direct write for a manager.
--   (2) Admin (entry_admin + effective all scope) and the BoD/Accounting bundle
--       (entry_privileged_edit + effective all scope) may correct submitted data DIRECTLY,
--       with reason, OCC, revision and immutable audit. #53 made the direct paths DRAFT-only;
--       this migration lets the privileged path target a SUBMITTED entry again while a
--       submission under REVIEW stays locked.
--   (3) Team/provider stay derived from the recruiter memberships; identity keys are stable and
--       no history is deleted. The CCCD rule and the episode invariant are unchanged (#58-#60).

begin;

create function public.direct_entry_hf_r3_replace_proc_source(
  p_signature regprocedure, p_expected text, p_replacement text, p_expected_count integer
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_source text; v_definition text; v_next text; v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'P2.5-HF-R3 invalid source patch specification';
  end if;
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then raise exception 'P2.5-HF-R3 source function not found: %', p_signature; end if;
  v_count := (length(v_source) - length(replace(v_source, p_expected, ''))) / length(p_expected);
  if v_count <> p_expected_count then
    raise exception 'P2.5-HF-R3 expected % exact source fragment(s), found % in %, starting with: %',
      p_expected_count, v_count, p_signature, left(p_expected, 96);
  end if;
  v_next := replace(v_source, p_expected, p_replacement);
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'P2.5-HF-R3 could not reconstruct function definition: %', p_signature;
  end if;
  execute replace(v_definition, v_source, v_next);
  if not exists (
    select 1 from pg_proc p
     where p.oid = p_signature and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then raise exception 'P2.5-HF-R3 changed function security boundary: %', p_signature; end if;
end;
$$;
revoke all on function public.direct_entry_hf_r3_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Proposer side: every business ENTRY_FIELD key is proposable again.
-- ---------------------------------------------------------------------------
select public.direct_entry_hf_r3_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
    if (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') - array[
            'worker_details'
          ]) <> '{}'::jsonb)$old$,
  $new$
    if (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') - array[
            'project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'
          ]) <> '{}'::jsonb)$new$,
  1
);

-- display_name is a normal business field for an authorized proposer: the create-side
-- "unchanged" assertions of #53 are removed (two occurrences in this function).
select public.direct_entry_hf_r3_replace_proc_source(
  'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure,
  $old$
    perform public.direct_entry_w04_assert_display_name_unchanged(
      v_item->'proposal'->'worker_details', v_entry.worker_details
    );
$old$,
  $new$
    -- P2.5-HF-R3: display_name is a normal business field for an authorized proposer.
$new$,
  2
);

-- ---------------------------------------------------------------------------
-- 2. Apply side: apply the proposed business fields, re-derive team/provider.
-- ---------------------------------------------------------------------------
select public.direct_entry_hf_r3_replace_proc_source(
  'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure,
  $old$
    if (p_proposal - array['worker_details']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb
       or (p_proposal ? 'worker_details'
           and public.direct_entry_w04_worker_details_allowed(p_proposal->'worker_details') is not true) then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;
    perform public.direct_entry_w04_assert_display_name_unchanged(
      p_proposal->'worker_details', p_entry.worker_details
    );$old$,
  $new$
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb
       or (p_proposal ? 'worker_details'
           and public.direct_entry_w04_worker_details_allowed(p_proposal->'worker_details') is not true) then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;$new$,
  1
);

select public.direct_entry_hf_r3_replace_proc_source(
  'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure,
  $old$
    v_recruiter_id := p_entry.recruiter_id;
    v_date := p_entry.first_work_date;
    v_team_id := p_entry.team_id;
    v_provider := p_entry.provider_type;$old$,
  $new$
    v_recruiter_id := case when p_proposal ? 'recruiter_id'
      then (p_proposal->>'recruiter_id')::uuid else p_entry.recruiter_id end;
    v_date := case when p_proposal ? 'first_work_date'
      then (p_proposal->>'first_work_date')::date else p_entry.first_work_date end;
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
       and (m.valid_to is null or v_date < m.valid_to);
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id and m.valid_from <= v_date
       and (m.valid_to is null or v_date < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review',
      p_entry.created_by_user_id, v_team_id, v_date, v_scope
    );$new$,
  1
);

-- ---------------------------------------------------------------------------
-- 3. Admin / BoD-Accounting: direct correction of a submitted worker.
-- ---------------------------------------------------------------------------
create or replace function public.direct_entry_privileged_edit(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_submission_state text;
  v_before jsonb;
  v_after jsonb;
  v_scope text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_fields text[];
  v_team uuid;
  v_provider text;
  v_count integer;
  v_target_date date;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'
     or public.direct_entry_contains_authority(p_patch)
     or (p_patch - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb then
    raise exception 'invalid privileged edit input' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  -- P2.5-HF-R3: a submitted worker may be corrected directly by an authorized actor. A
  -- submission under REVIEW stays locked, and the row lock above serialises with a decision.
  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if v_submission_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission_state not in ('DRAFT', 'SUBMITTED') then
    raise exception 'privileged edit requires a draft or submitted entry' using errcode = '42501';
  end if;
  v_scope := public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit',
    v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'entry_privileged_edit', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'version', p_expected_version, 'patch', p_patch, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if p_expected_version is null or p_expected_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  select count(*), min(m.provider_type) into v_count, v_provider
    from public.recruiter_provider_memberships m
   where m.recruiter_id = case when p_patch ? 'recruiter_id'
          then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
     and m.valid_from <= case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end
     and (m.valid_to is null or case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end < m.valid_to);
  if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
  select count(*), (array_agg(m.team_id))[1] into v_count, v_team
    from public.recruiter_team_memberships m
   where m.recruiter_id = case when p_patch ? 'recruiter_id'
          then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
     and m.valid_from <= case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end
     and (m.valid_to is null or case when p_patch ? 'first_work_date'
          then (p_patch->>'first_work_date')::date else v_entry.first_work_date end < m.valid_to);
  if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  v_target_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  perform public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit',
    v_entry.created_by_user_id, v_team, v_target_date, v_scope
  );
  update public.direct_entries set
    project_id = case when p_patch ? 'project_id' then p_patch->>'project_id' else project_id end,
    first_work_date = case when p_patch ? 'first_work_date' then (p_patch->>'first_work_date')::date else first_work_date end,
    employee_code = case when p_patch ? 'employee_code' then p_patch->>'employee_code' else employee_code end,
    worker_details = case when p_patch ? 'worker_details' then p_patch->'worker_details' else worker_details end,
    recruiter_id = case when p_patch ? 'recruiter_id' then (p_patch->>'recruiter_id')::uuid else recruiter_id end,
    labor_type = case when p_patch ? 'labor_type' then p_patch->>'labor_type' else labor_type end,
    team_id = v_team, provider_type = v_provider, version = version + 1
   where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  select array_agg(key order by key) into v_fields from jsonb_object_keys(p_patch) key;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'entry_privileged_edit', 'entry_privileged_edit',
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_team else null end,
    'APPLIED', v_reason_id, v_revision_id, v_fields
  );
  v_result := jsonb_build_object('entry_id', p_entry_id, 'version', v_entry.version + 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'entry_privileged_edit', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;
revoke all on function public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)
  to service_role;
comment on function public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text) is
  'P2.5-HF-R3: Admin (entry_admin) and the BoD/Accounting bundle (entry_privileged_edit) correct a '
  'DRAFT or SUBMITTED worker directly, with reason, OCC, idempotency, revision and immutable audit. '
  'A submission under REVIEW stays locked. Team/provider stay derived from the recruiter '
  'memberships; identity keys are never deleted and the CMT/CCCD episode invariant is unchanged.';

drop function public.direct_entry_hf_r3_replace_proc_source(regprocedure,text,text,integer);

-- ---------------------------------------------------------------------------
-- 4. Self-check.
-- ---------------------------------------------------------------------------
do $p2_5_hf_r3$
declare
  v_source text;
  v_signature text;
begin
  for v_signature in
    select unnest(array[
      'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)',
      'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'
    ])
  loop
    select p.prosrc into v_source from pg_proc p where p.oid = v_signature::regprocedure;
    if position('direct_entry_w04_assert_display_name_unchanged' in v_source) > 0 then
      raise exception 'P2.5-HF-R3 % still protects display_name from an authorized proposer', v_signature;
    end if;
    if position(chr(39) || 'project_id' || chr(39) || ',' || chr(39) || 'first_work_date' in v_source) = 0 then
      raise exception 'P2.5-HF-R3 % does not accept the full business field set', v_signature;
    end if;
  end loop;

  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'::regprocedure;
  if position('v_provider := p_entry.provider_type;' in v_source) > 0
     or position('recruiter_provider_memberships' in v_source) = 0 then
    raise exception 'P2.5-HF-R3 apply still freezes team/provider instead of re-deriving them';
  end if;

  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
  if position('direct_entry_assert_not_review' in v_source) > 0 then
    raise exception 'P2.5-HF-R3 privileged edit still uses the DRAFT-only guard';
  end if;
  if position('SUBMITTED' in v_source) = 0 or position('DRAFT' in v_source) = 0 then
    raise exception 'P2.5-HF-R3 privileged edit does not accept a submitted entry';
  end if;
  if position('entry_privileged_edit' in v_source) = 0
     or position('p_expected_version' in v_source) = 0
     or position('direct_entry_write_revision' in v_source) = 0
     or position('direct_entry_audit_events' in v_source) = 0
     or position('direct_entry_idempotency_begin' in v_source) = 0 then
    raise exception 'P2.5-HF-R3 privileged edit lost reason/OCC/idempotency/revision/audit';
  end if;
  if position('delete from public.direct_entries' in v_source) > 0
     or position('deleted_at = ' in v_source) > 0 then
    raise exception 'P2.5-HF-R3 privileged edit must never delete or soft-delete an entry';
  end if;
  if not has_function_privilege('service_role',
       'public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)', 'EXECUTE') then
    raise exception 'P2.5-HF-R3 privileged edit ACL self-check failed';
  end if;
  -- The CMT/CCCD rule and the episode guards of #58-#60 stay in force on this path.
  if position('direct_entry_guard_active_episode' in (
       select pg_get_triggerdef(t.oid) from pg_trigger t
        where t.tgname = 'direct_entry_active_episode_guard' and not t.tgisinternal)) = 0 then
    raise exception 'P2.5-HF-R3 the create guard is missing';
  end if;
  if not public.direct_entry_is_canonical_national_id('012345678901') then
    raise exception 'P2.5-HF-R3 the canonical CMT/CCCD rule changed';
  end if;
end;
$p2_5_hf_r3$;

commit;
