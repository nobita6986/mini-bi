-- PRE-W2-HF-F: allow the existing privileged correction path to append one
-- employment-status transition in the same OCC/audit transaction as profile edits.

begin;

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
  v_status jsonb;
  v_latest_status public.direct_entry_employment_status_events%rowtype;
  v_status_version integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'
     or public.direct_entry_contains_authority(p_patch)
     or (p_patch - array['project_id','first_work_date','employee_code','worker_details',
                        'recruiter_id','labor_type','employment_status']) <> '{}'::jsonb then
    raise exception 'invalid privileged edit input' using errcode = '22023';
  end if;
  if p_patch ? 'employment_status' then
    v_status := p_patch->'employment_status';
    if jsonb_typeof(v_status) <> 'object'
       or (v_status - array['status','effective_date','leave_reason']) <> '{}'::jsonb
       or jsonb_typeof(v_status->'status') <> 'string'
       or v_status->>'status' not in ('UNCONFIRMED','ON','OFF')
       or jsonb_typeof(v_status->'effective_date') <> 'string'
       or (v_status->>'status' = 'OFF' and (
         jsonb_typeof(v_status->'leave_reason') <> 'string'
         or length(btrim(v_status->>'leave_reason')) not between 1 and 4000
       ))
       or (v_status->>'status' <> 'OFF' and v_status ? 'leave_reason') then
      raise exception 'invalid privileged employment status' using errcode = '22023';
    end if;
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
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
  if v_provider = 'vendor' then
    v_team := public.direct_entry_system_vendor_team_id();
  else
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = case when p_patch ? 'recruiter_id'
            then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
       and m.valid_from <= case when p_patch ? 'first_work_date'
            then (p_patch->>'first_work_date')::date else v_entry.first_work_date end
       and (m.valid_to is null or case when p_patch ? 'first_work_date'
            then (p_patch->>'first_work_date')::date else v_entry.first_work_date end < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  end if;
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
  if v_status is not null then
    select * into v_latest_status
      from public.direct_entry_employment_status_events
     where entry_id = p_entry_id
     order by version desc limit 1 for update;
    if not found then
      raise exception 'employment status not found' using errcode = '23514';
    end if;
    v_status_version := v_latest_status.version + 1;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, leave_date, leave_reason_text,
      version, actor_user_id, reason_id, supersedes_event_id
    ) values (
      p_entry_id, v_status->>'status', (v_status->>'effective_date')::date,
      case when v_status->>'status' = 'OFF' then (v_status->>'effective_date')::date else null end,
      case when v_status->>'status' = 'OFF' then btrim(v_status->>'leave_reason') else null end,
      v_status_version, p_app_user_id, v_reason_id, null
    );
  end if;
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
  'PRE-W2-HF-F: Admin and the BoD/Accounting privileged bundle may atomically correct profile '
  'fields and append a valid employment-status transition with OCC, reason, revision and audit.';

do $$
declare
  v_source text;
begin
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
  if v_source not like '%employment_status%'
     or v_source not like '%direct_entry_employment_status_events%'
     or not exists (
       select 1 from pg_proc p
        where p.oid = 'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure
          and p.prosecdef
          and p.proconfig @> array['search_path=pg_catalog, public']
     )
     or not has_function_privilege(
       'service_role',
       'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)', 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)', 'EXECUTE'
     ) then
    raise exception 'PRE-W2-HF-F privileged status self-check failed' using errcode = '55000';
  end if;
end;
$$;

commit;
