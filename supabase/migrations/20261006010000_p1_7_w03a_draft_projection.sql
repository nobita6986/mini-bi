begin;

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
  v_pii boolean;
  v_payment_view boolean;
  v_employment_apply boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_pii := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability = 'pii_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_payment_view := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability = 'payment_view'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );
  v_employment_apply := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability = 'employment_status.apply'
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)
  );

  select count(*) into v_count
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where s.state = 'DRAFT'
     and e.deleted_at is null
     and exists (
       select 1
         from public.direct_entry_scope_grants g
         join public.direct_entry_capability_grants c
           on c.app_user_id = g.app_user_id
          and c.capability = case g.scope_kind
            when 'own' then 'entry_own'
            when 'team' then 'entry_team'
            else 'entry_admin'
          end
          and c.valid_from <= public.direct_entry_authorization_date()
          and (c.valid_to is null or public.direct_entry_authorization_date() < c.valid_to)
        where g.app_user_id = p_app_user_id
          and g.valid_from <= e.first_work_date
          and (g.valid_to is null or e.first_work_date < g.valid_to)
          and (
            (g.scope_kind = 'own' and e.created_by_user_id = p_app_user_id) or
            (g.scope_kind = 'team' and g.team_id = e.team_id) or
            g.scope_kind = 'all'
          )
     );
  if v_count > 500 then
    raise exception 'draft list exceeds supported size' using errcode = '54000';
  end if;

  with eligible as materialized (
    select e.*, s.version as submission_version,
           p.display_name as project_display_name,
           r.display_name as recruiter_display_name,
           t.display_name as team_display_name
      from public.direct_entries e
      join public.direct_entry_submissions s on s.submission_id = e.submission_id
      join public.direct_entry_projects p on p.project_id = e.project_id
      join public.recruiters r on r.recruiter_id = e.recruiter_id
      join public.teams t on t.team_id = e.team_id
     where s.state = 'DRAFT'
       and e.deleted_at is null
       and exists (
         select 1
           from public.direct_entry_scope_grants g
           join public.direct_entry_capability_grants c
             on c.app_user_id = g.app_user_id
            and c.capability = case g.scope_kind
              when 'own' then 'entry_own'
              when 'team' then 'entry_team'
              else 'entry_admin'
            end
            and c.valid_from <= public.direct_entry_authorization_date()
            and (c.valid_to is null or public.direct_entry_authorization_date() < c.valid_to)
          where g.app_user_id = p_app_user_id
            and g.valid_from <= e.first_work_date
            and (g.valid_to is null or e.first_work_date < g.valid_to)
            and (
              (g.scope_kind = 'own' and e.created_by_user_id = p_app_user_id) or
              (g.scope_kind = 'team' and g.team_id = e.team_id) or
              g.scope_kind = 'all'
            )
       )
  ),
  authorized as materialized (
    select e.*,
           public.direct_entry_assert_draft_access(
             p_auth_subject, p_app_user_id, e.created_by_user_id, e.team_id, e.first_work_date
           ) as resolved_scope
      from eligible e
  )
  select jsonb_build_object(
    'projection_version', 'direct-entry-draft-list/1',
    'drafts', coalesce(jsonb_agg(jsonb_build_object(
      'submission_id', e.submission_id,
      'submission_version', e.submission_version,
      'entry_id', e.entry_id,
      'entry_version', e.version,
      'employee_code', e.employee_code,
      'first_work_date', e.first_work_date,
      'worker_display_name', case when v_pii then e.worker_details->>'display_name' else '' end,
      'project_id', e.project_id,
      'project_display_name', e.project_display_name,
      'recruiter_id', e.recruiter_id,
      'recruiter_display_name', e.recruiter_display_name,
      'provider_type', e.provider_type,
      'team_id', e.team_id,
      'team_display_name', e.team_display_name,
      'labor_type', e.labor_type,
      'employment_status', status.status,
      'created_at', e.created_at,
      'updated_at', e.updated_at,
      'profile', jsonb_build_object(
        'contract_version', 'worker-profile/1.0',
        'worker_details', jsonb_build_object(
          'display_name', case when v_pii then jsonb_build_object(
            'state', 'provided', 'value', e.worker_details->>'display_name'
          ) else jsonb_build_object('state', 'redacted', 'present', true) end,
          'gender', public.direct_entry_draft_profile_field(e.worker_details->'gender', v_pii),
          'date_of_birth', public.direct_entry_draft_profile_field(e.worker_details->'date_of_birth', v_pii),
          'national_id', public.direct_entry_draft_profile_field(e.worker_details->'national_id', v_pii),
          'national_id_issued_at', public.direct_entry_draft_profile_field(e.worker_details->'national_id_issued_at', v_pii),
          'national_id_issued_place', public.direct_entry_draft_profile_field(e.worker_details->'national_id_issued_place', v_pii),
          'address', public.direct_entry_draft_profile_field(e.worker_details->'address', v_pii),
          'phone', public.direct_entry_draft_profile_field(e.worker_details->'phone', v_pii)
        ),
        'general_note', case
          when e.general_note is null then jsonb_build_object('state', 'omitted')
          when v_pii then jsonb_build_object('state', 'provided', 'value', e.general_note)
          else jsonb_build_object('state', 'redacted', 'present', true)
        end,
        'employment', case when status.version is null then null else jsonb_build_object(
            'status', status.status,
            'effective_date', status.effective_date,
            'version', status.version,
            'leave_date', case
              when status.leave_date is null then jsonb_build_object('state', 'omitted')
              when not v_employment_apply then jsonb_build_object('state', 'omitted')
              when v_pii then jsonb_build_object('state', 'provided', 'value', status.leave_date)
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'leave_reason_text', case
              when status.leave_reason_text is null then jsonb_build_object('state', 'omitted')
              when not v_employment_apply then jsonb_build_object('state', 'omitted')
              when v_pii then jsonb_build_object('state', 'provided', 'value', status.leave_reason_text)
              else jsonb_build_object('state', 'redacted', 'present', true)
            end
          ) end,
        'payment', case when payment.entry_id is null then null else jsonb_build_object(
            'state', payment.state,
            'account_number', case
              when payment.account_number is null then jsonb_build_object('state', 'omitted')
              when v_payment_view then jsonb_build_object(
                'state', 'provided', 'value', payment.account_number
              )
              else jsonb_build_object(
                'state', 'masked',
                'value', repeat('•', greatest(length(payment.account_number) - 4, 0)) ||
                  right(payment.account_number, 4)
              )
            end,
            'bank_name', case
              when payment.bank_name is null then jsonb_build_object('state', 'omitted')
              when v_payment_view then jsonb_build_object(
                'state', 'provided', 'value', payment.bank_name
              )
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'account_holder_name', case
              when payment.account_holder_name is null then jsonb_build_object('state', 'omitted')
              when v_payment_view then jsonb_build_object(
                'state', 'provided', 'value', payment.account_holder_name
              )
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'version', payment.version
          ) end
      )
    ) order by e.created_at, e.entry_id), '[]'::jsonb)
  ) into v_result
    from authorized e
    left join lateral (
      select st.status, st.effective_date, st.version, st.leave_date, st.leave_reason_text
        from public.direct_entry_employment_status_events st
       where st.entry_id = e.entry_id
       order by st.version desc
       limit 1
    ) status on true
    left join public.direct_entry_payments payment on payment.entry_id = e.entry_id
   where e.resolved_scope in ('own', 'team', 'all');

  return v_result;
end;
$$;

create or replace function public.direct_entry_draft_profile_field(
  p_field jsonb,
  p_pii_view boolean
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when p_field is null or p_field = 'null'::jsonb then jsonb_build_object('state', 'omitted')
    when p_pii_view then p_field
    when p_field->>'state' = 'provided' then jsonb_build_object('state', 'redacted', 'present', true)
    else jsonb_build_object('state', coalesce(p_field->>'state', 'unknown'))
  end
$$;

revoke all on function public.direct_entry_draft_profile_field(jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_list_own_drafts(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_own_drafts(uuid, uuid) to service_role;

comment on function public.direct_entry_list_own_drafts(uuid, uuid) is
  'P1.7-W03A: versioned single-batch draft projection with own/team/all scope and capability redaction; service-role only.';

do $$
begin
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and has_function_privilege(
         'service_role', p.oid, 'EXECUTE'
       )
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1
           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'draft list RPC boundary self-check failed';
  end if;

  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_draft_profile_field(jsonb,boolean)'::regprocedure
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1
           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'draft profile helper boundary self-check failed';
  end if;

  if exists (
    select 1
      from unnest(array['direct_entries', 'direct_entry_payments']) as table_name
      join pg_class c on c.oid = format('public.%I', table_name)::regclass
     where not c.relrowsecurity or not c.relforcerowsecurity
  ) then
    raise exception 'draft projection RLS self-check failed';
  end if;
end;
$$;

commit;
