-- =============================================================================
-- Dashboard Detailed Recruitment Matrix Catalog RPC (forward-only)
-- =============================================================================
-- Provides a narrow, read-only `service_role` RPC for the global Dashboard
-- "Báo cáo chi tiết" tab (`audience = 'all'` only):
--   - Active business teams (`public.teams` excluding `__system_vendor__`)
--   - Recruiter catalog (`public.recruiters`) with canonical `personnel_code`,
--     `is_active_hrp`, current team memberships (`recruiter_team_memberships`),
--     and `work_start_date` from `public.leave_employee_profiles` (via verified
--     `direct_entry_app_user_recruiter_links`), without exposing leave balances,
--     notes, requests, grants, or account credentials.
-- =============================================================================

begin;

create or replace function public.direct_entry_reporting_detailed_matrix_catalog(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_aud jsonb;
  v_teams jsonb := '[]'::jsonb;
  v_recruiters jsonb := '[]'::jsonb;
begin
  v_aud := public.direct_entry_reporting_resolve_audience(p_auth_subject, p_app_user_id);
  if coalesce(v_aud->>'audience', '') <> 'all' then
    raise exception 'detailed recruitment matrix requires all scope'
      using errcode = '42501';
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'team_id', t.team_id,
               'team_code', t.code,
               'display_name', t.display_name
             )
             order by t.display_name asc, t.team_id asc
           ),
           '[]'::jsonb
         )
    into v_teams
    from public.teams t
   where t.active = true
     and t.code <> '__system_vendor__';

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'recruiter_id', sub.recruiter_id,
               'recruiter_key', sub.recruiter_key,
               'display_name', sub.display_name,
               'personnel_code', sub.personnel_code,
               'active', sub.active,
               'is_active_hrp', sub.is_active_hrp,
               'current_team_ids', sub.current_team_ids,
               'work_start_date', sub.work_start_date
             )
             order by sub.is_active_hrp desc, sub.active desc, sub.display_name asc, sub.recruiter_id asc
           ),
           '[]'::jsonb
         )
    into v_recruiters
    from (
      select r.recruiter_id,
             public.direct_entry_reporting_dim_key(r.display_name) as recruiter_key,
             pg_catalog.btrim(r.display_name) as display_name,
             nullif(pg_catalog.btrim(coalesce(r.personnel_code, '')), '') as personnel_code,
             r.active,
             (
               r.active
               and exists (
                 select 1
                   from public.recruiter_provider_memberships m
                  where m.recruiter_id = r.recruiter_id
                    and m.provider_type = 'hrp'
                    and m.vendor_id is null
                    and m.is_current = true
               )
             ) as is_active_hrp,
             coalesce(
               (
                 select pg_catalog.jsonb_agg(rtm.team_id order by t.display_name asc, rtm.team_id asc)
                   from public.recruiter_team_memberships rtm
                   join public.teams t
                     on t.team_id = rtm.team_id
                    and t.active = true
                    and t.code <> '__system_vendor__'
                  where rtm.recruiter_id = r.recruiter_id
                    and rtm.is_current = true
               ),
               '[]'::jsonb
             ) as current_team_ids,
             (
               select pg_catalog.to_char(lep.work_start_date, 'YYYY-MM-DD')
                 from public.direct_entry_app_user_recruiter_links l
                 join public.leave_employee_profiles lep
                   on lep.app_user_id = l.app_user_id
                where l.recruiter_id = r.recruiter_id
                  and l.verified = true
                  and (l.is_current = true or l.valid_to is null or l.valid_to > l.valid_from)
                  and not coalesce(lep.is_shared_non_employee, false)
                  and coalesce(lep.employment_status, 'UNCONFIGURED') <> 'UNCONFIGURED'
                  and lep.work_start_date is not null
                order by l.is_current desc, l.valid_from desc, l.link_id asc
                limit 1
             ) as work_start_date
        from public.recruiters r
    ) sub;

  return pg_catalog.jsonb_build_object(
    'teams', v_teams,
    'recruiters', v_recruiters
  );
end;
$function$;

comment on function public.direct_entry_reporting_detailed_matrix_catalog(uuid, uuid) is
  'Read-only catalog RPC for Dashboard Báo cáo chi tiết (all-scope only): active business teams, recruiters with canonical personnel_code, current team memberships, and leave work_start_date.';

do $align_detailed_matrix_catalog_owner$
declare
  v_table_owner_oid oid;
  v_table_owner name;
  v_proc_owner_oid oid;
  v_proc_owner name;
begin
  select c.relowner, r.rolname
    into v_table_owner_oid, v_table_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.recruiters'::pg_catalog.regclass;

  select p.proowner, r.rolname
    into v_proc_owner_oid, v_proc_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = 'public.direct_entry_reporting_detailed_matrix_catalog(uuid, uuid)'::pg_catalog.regprocedure;

  if v_proc_owner_oid is distinct from v_table_owner_oid
     and pg_catalog.pg_has_role(current_user, v_table_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter function public.direct_entry_reporting_detailed_matrix_catalog(uuid, uuid) owner to %I',
      v_table_owner
    );
    v_proc_owner_oid := v_table_owner_oid;
    v_proc_owner := v_table_owner;
  end if;

  if v_proc_owner_oid is distinct from v_table_owner_oid then
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reporting_resolve_audience(uuid, uuid) to %I',
      v_proc_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reporting_dim_key(text) to %I',
      v_proc_owner
    );
  end if;
end;
$align_detailed_matrix_catalog_owner$;

revoke all on function public.direct_entry_reporting_detailed_matrix_catalog(uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.direct_entry_reporting_detailed_matrix_catalog(uuid, uuid)
  to service_role;

commit;
