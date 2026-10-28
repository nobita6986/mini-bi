-- Filter leave administration profiles by direct-entry account activity.
create or replace function public.leave_management_get_admin_overview(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_search text,
  p_limit integer,
  p_offset integer,
  p_account_status text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_search text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, ''))), '');
  v_account_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_account_status, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 300));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_dept_approvers jsonb := '[]'::jsonb;
  v_module_grants jsonb := '[]'::jsonb;
  v_employees jsonb := '[]'::jsonb;
  v_total_employees integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_account_status not in ('ACTIVE', 'INACTIVE', 'ALL') then
    raise exception 'LEAVE_FILTER_INVALID'
      using errcode = '22023';
  end if;

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'approver_assignment_id', da.approver_assignment_id,
               'unit_kind', da.unit_kind,
               'approver_app_user_id', da.approver_app_user_id,
               'approver', public.leave_management__internal_account_summary(da.approver_app_user_id),
               'valid_from', da.valid_from,
               'valid_to', da.valid_to,
               'is_current', da.is_current,
               'reason', da.reason,
               'row_version', da.row_version
             )
             order by da.unit_kind asc
           ),
           '[]'::jsonb
         )
    into v_dept_approvers
    from public.leave_department_approvers da
   where da.is_current = true;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'grant_id', g.grant_id,
               'app_user_id', g.app_user_id,
               'account', public.leave_management__internal_account_summary(g.app_user_id),
               'role_code', g.role_code,
               'valid_from', g.valid_from,
               'valid_to', g.valid_to,
               'is_current', g.is_current,
               'reason', g.reason,
               'row_version', g.row_version
             )
             order by g.role_code asc, g.created_at desc
           ),
           '[]'::jsonb
         )
    into v_module_grants
    from public.leave_module_grants g
   where g.is_current = true;

  select count(*)::integer
    into v_total_employees
    from public.direct_entry_app_users u
    left join public.direct_entry_app_user_recruiter_links l
      on l.app_user_id = u.app_user_id
     and l.verified = true
     and l.is_current = true
    left join public.recruiters r
      on r.recruiter_id = l.recruiter_id
   where (
     v_account_status = 'ALL'
     or (v_account_status = 'ACTIVE' and u.enabled = true)
     or (v_account_status = 'INACTIVE' and u.enabled = false)
   )
     and (
     v_search is null
     or pg_catalog.lower(coalesce(r.display_name, u.display_name, '')) like '%' || v_search || '%'
     or pg_catalog.lower(coalesce(r.personnel_code, '')) like '%' || v_search || '%'
   );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'account', public.leave_management__internal_account_summary(sub.app_user_id),
               'profile', case
                 when sub.profile_found then
                   pg_catalog.jsonb_build_object(
                     'app_user_id', sub.app_user_id,
                     'is_shared_non_employee', sub.is_shared_non_employee,
                     'employment_status', sub.employment_status,
                     'unit_kind', sub.unit_kind,
                     'work_start_date', sub.work_start_date,
                     'official_effective_date', sub.official_effective_date,
                     'next_seniority_effective_date', sub.next_seniority_effective_date,
                     'next_seniority_units', sub.next_seniority_units,
                     'notes', sub.notes,
                     'row_version', sub.row_version
                   )
                 else
                   pg_catalog.jsonb_build_object(
                     'app_user_id', sub.app_user_id,
                     'is_shared_non_employee', false,
                     'employment_status', 'UNCONFIGURED',
                     'unit_kind', 'UNCLASSIFIED',
                     'work_start_date', null,
                     'official_effective_date', null,
                     'next_seniority_effective_date', null,
                     'next_seniority_units', 0,
                     'notes', null,
                     'row_version', 0
                   )
               end,
               'routing', public.leave_management__internal_resolve_routing(sub.app_user_id, v_today),
               'balance', public.leave_management__internal_compute_balance_summary(sub.app_user_id, v_year, v_today)
             )
             order by sub.sort_name asc, sub.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_employees
    from (
      select u.app_user_id,
             coalesce(r.display_name, u.display_name) as sort_name,
             (p.app_user_id is not null) as profile_found,
             coalesce(p.is_shared_non_employee, false) as is_shared_non_employee,
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             coalesce(p.unit_kind, 'UNCLASSIFIED') as unit_kind,
             p.work_start_date,
             p.official_effective_date,
             p.next_seniority_effective_date,
             coalesce(p.next_seniority_units, 0) as next_seniority_units,
             p.notes,
             coalesce(p.row_version, 0) as row_version
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p
          on p.app_user_id = u.app_user_id
        left join public.direct_entry_app_user_recruiter_links l
          on l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
        left join public.recruiters r
          on r.recruiter_id = l.recruiter_id
       where (
         v_account_status = 'ALL'
         or (v_account_status = 'ACTIVE' and u.enabled = true)
         or (v_account_status = 'INACTIVE' and u.enabled = false)
       )
         and (
         v_search is null
         or pg_catalog.lower(coalesce(r.display_name, u.display_name, '')) like '%' || v_search || '%'
         or pg_catalog.lower(coalesce(r.personnel_code, '')) like '%' || v_search || '%'
       )
       order by coalesce(r.display_name, u.display_name) asc, u.app_user_id asc
       limit v_limit
      offset v_offset
    ) sub;

  return pg_catalog.jsonb_build_object(
    'as_of_date', v_today,
    'leave_year', v_year,
    'authority', v_auth,
    'policy', pg_catalog.jsonb_build_object(
      'annual_base_units', v_policy.annual_base_units,
      'monthly_accrual_units', v_policy.monthly_accrual_units,
      'default_seniority_years', v_policy.default_seniority_years,
      'default_seniority_step_units', v_policy.default_seniority_step_units,
      'carry_over_expiry_month', v_policy.carry_over_expiry_month,
      'carry_over_expiry_day', v_policy.carry_over_expiry_day,
      'carry_over_expires_after_date', v_carry_over_expiry,
      'row_version', v_policy.row_version
    ),
    'department_approvers', v_dept_approvers,
    'module_grants', v_module_grants,
    'total_employees', v_total_employees,
    'account_status', v_account_status,
    'limit', v_limit,
    'offset', v_offset,
    'employees', v_employees
  );
end;
$function$;

revoke all on function public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text) to service_role;
