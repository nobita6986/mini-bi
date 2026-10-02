create or replace function public.direct_entry_input_catalog(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_effective_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  if p_effective_date is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;
  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) or not exists (
    select 1
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability in ('entry_create', 'entry_own')
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  ) then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  with providers as (
    select m.recruiter_id, count(*) as membership_count, min(m.provider_type) as provider_type
      from public.recruiter_provider_memberships m
     where m.valid_from <= p_effective_date
       and (m.valid_to is null or p_effective_date < m.valid_to)
     group by m.recruiter_id
  ), teams as (
    select m.recruiter_id, count(*) as membership_count,
           min(m.team_id::text)::uuid as team_id
      from public.recruiter_team_memberships m
     where m.valid_from <= p_effective_date
       and (m.valid_to is null or p_effective_date < m.valid_to)
     group by m.recruiter_id
  ), eligible_recruiters as (
    select r.recruiter_id, r.display_name, p.provider_type, t.team_id, team.display_name as team_display_name
      from public.recruiters r
      join providers p on p.recruiter_id = r.recruiter_id and p.membership_count = 1
      join teams t on t.recruiter_id = r.recruiter_id and t.membership_count = 1
      join public.teams team on team.team_id = t.team_id and team.active
     where r.active
  )
  select jsonb_build_object(
    'effective_date', p_effective_date,
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project_id', p.project_id, 'display_name', p.display_name
      ) order by p.display_name, p.project_id)
        from public.direct_entry_projects p
       where p.active
    ), '[]'::jsonb),
    'recruiters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', r.display_name,
        'provider_type', r.provider_type,
        'team_id', r.team_id,
        'team_display_name', r.team_display_name
      ) order by r.display_name, r.recruiter_id)
        from eligible_recruiters r
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.direct_entry_list_own_drafts(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_count integer;
begin
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'entry_own');
  select count(*) into v_count
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where s.state = 'DRAFT'
     and s.created_by_user_id = p_app_user_id
     and e.created_by_user_id = p_app_user_id
     and e.deleted_at is null;
  if v_count > 500 then
    raise exception 'draft list exceeds supported size' using errcode = '54000';
  end if;

  select jsonb_build_object(
    'drafts', coalesce(jsonb_agg(jsonb_build_object(
      'submission_id', s.submission_id,
      'submission_version', s.version,
      'entry_id', e.entry_id,
      'entry_version', e.version,
      'employee_code', e.employee_code,
      'first_work_date', e.first_work_date,
      'worker_display_name', e.worker_details->>'display_name',
      'project_id', e.project_id,
      'project_display_name', p.display_name,
      'recruiter_id', e.recruiter_id,
      'recruiter_display_name', r.display_name,
      'provider_type', e.provider_type,
      'team_id', e.team_id,
      'team_display_name', t.display_name,
      'labor_type', e.labor_type,
      'employment_status', status.status,
      'created_at', e.created_at,
      'updated_at', e.updated_at
    ) order by e.created_at, e.entry_id), '[]'::jsonb)
  ) into v_result
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
    join public.direct_entry_projects p on p.project_id = e.project_id
    join public.recruiters r on r.recruiter_id = e.recruiter_id
    join public.teams t on t.team_id = e.team_id
    left join lateral (
      select st.status
        from public.direct_entry_employment_status_events st
       where st.entry_id = e.entry_id
       order by st.version desc
       limit 1
    ) status on true
   where s.state = 'DRAFT'
     and s.created_by_user_id = p_app_user_id
     and e.created_by_user_id = p_app_user_id
     and e.deleted_at is null;
  return v_result;
end;
$$;

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
  if p_patch ? 'recruiter_id' or p_patch ? 'first_work_date' then
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_new_recruiter_id and m.valid_from <= v_new_work_date
       and (m.valid_to is null or v_new_work_date < m.valid_to);
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_new_recruiter_id and m.valid_from <= v_new_work_date
       and (m.valid_to is null or v_new_work_date < m.valid_to);
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  else
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

revoke all on function public.direct_entry_input_catalog(uuid, uuid, date)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_list_own_drafts(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_input_catalog(uuid, uuid, date)
  to service_role;
grant execute on function public.direct_entry_list_own_drafts(uuid, uuid)
  to service_role;
revoke all on function public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text)
  to service_role;

comment on function public.direct_entry_input_catalog(uuid, uuid, date) is
  'P1.6 S03CD: active project and unambiguous effective-date recruiter catalog; service-role only.';
comment on function public.direct_entry_list_own_drafts(uuid, uuid) is
  'P1.6 S03CD: at most 500 own DRAFT entry projections without restricted fields; service-role only.';
