-- S04A extends existing RPC projections; it adds no tables or RPC inventory.
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
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) or not exists (
    select 1 from public.direct_entry_capability_grants g
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
    select r.recruiter_id, r.display_name, p.provider_type, t.team_id,
           team.display_name as team_display_name
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
    ), '[]'::jsonb),
    'banks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bank_id', b.bank_id, 'display_name', b.display_name
      ) order by b.display_name, b.bank_id)
        from public.direct_entry_banks b
       where b.active
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.direct_entry_read_projection(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_result jsonb;
  v_pii boolean;
  v_payment boolean;
  v_documents boolean;
begin
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_assert_draft_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date
  );
  v_pii := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'pii_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_payment := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'payment_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_documents := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'document_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_result := jsonb_build_object(
    'entry_id', v_entry.entry_id, 'submission_id', v_entry.submission_id,
    'project_id', v_entry.project_id, 'first_work_date', v_entry.first_work_date,
    'employee_code', v_entry.employee_code,
    'worker_details', case when v_pii then v_entry.worker_details else '{}'::jsonb end,
    'recruiter_id', v_entry.recruiter_id, 'team_id', v_entry.team_id,
    'provider_type', v_entry.provider_type, 'labor_type', v_entry.labor_type,
    'version', v_entry.version, 'scope_kind', v_scope,
    'payment', (
      select case when v_payment then jsonb_build_object(
        'state', p.state, 'account_number', p.account_number, 'bank_id', p.bank_id,
        'account_holder_name', p.account_holder_name, 'version', p.version
      ) else jsonb_build_object(
        'state', p.state,
        'account_number', case when p.account_number is null then null
          else repeat('•', greatest(length(p.account_number) - 4, 0)) ||
            right(p.account_number, 4) end,
        'version', p.version
      ) end
        from public.direct_entry_payments p
       where p.entry_id = p_entry_id
    ),
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date, 'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = p_entry_id
       order by st.version desc
       limit 1
    ),
    'documents', case when v_documents then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'size_bytes', d.size_bytes, 'mime_type', d.mime_type,
        'upload_status', d.upload_status, 'scan_status', d.scan_status
      ) order by d.document_type, d.version), '[]'::jsonb)
        from public.direct_entry_current_documents d
       where d.candidate_id = v_entry.candidate_id
    ) else '[]'::jsonb end
  );
  return v_result;
end;
$$;

revoke all on function public.direct_entry_input_catalog(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_input_catalog(uuid, uuid, date)
  to service_role;
revoke all on function public.direct_entry_read_projection(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_read_projection(uuid, uuid, uuid)
  to service_role;
