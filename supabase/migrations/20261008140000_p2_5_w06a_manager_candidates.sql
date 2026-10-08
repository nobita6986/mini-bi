-- P2.5-W06A-R2 - Project-manager candidate list (#54).
--
-- One service-role RPC, no schema change. Lists ACTIVE recruiters that have a
-- VERIFIED and currently-effective app-user/recruiter link — the exact
-- eligibility the assign RPC (direct_entry_assign_project_manager) enforces.
-- Authority is entry_admin + effective all scope (direct_entry_assert_project_admin).
-- Never returns auth_subject / app_user_id / any other PII beyond the recruiter
-- identity needed to search and select.

begin;

create or replace function public.direct_entry_list_project_manager_candidates(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_candidates jsonb;
begin
  perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
  select coalesce(jsonb_agg(t.candidate order by t.display_name, t.recruiter_id), '[]'::jsonb)
    into v_candidates
    from (
      select r.display_name, r.recruiter_id, jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', r.display_name,
        'personnel_code', r.personnel_code,
        'personnel_position', r.personnel_position
      ) as candidate
        from public.recruiters r
       where r.active
         and exists (
           select 1
             from public.direct_entry_app_user_recruiter_links l
            where l.recruiter_id = r.recruiter_id
              and l.verified
              and l.valid_from <= public.direct_entry_authorization_date()
              and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
         )
         and (
           p_search is null or btrim(p_search) = ''
           or r.display_name ilike '%' || btrim(p_search) || '%'
           or coalesce(r.personnel_code, '') ilike '%' || btrim(p_search) || '%'
         )
       order by r.display_name, r.recruiter_id
       limit 100
    ) t;
  return jsonb_build_object('candidates', v_candidates);
end;
$$;

revoke all on function public.direct_entry_list_project_manager_candidates(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_project_manager_candidates(uuid, uuid, text)
  to service_role;

comment on function public.direct_entry_list_project_manager_candidates(uuid, uuid, text) is
  'P2.5-W06A-R2: service-role admin read. Active recruiters with a verified effective account link (assign eligibility), searchable by display_name / personnel_code. entry_admin + all scope required.';

commit;
