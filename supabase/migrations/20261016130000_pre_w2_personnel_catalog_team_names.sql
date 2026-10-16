-- PRE-W2-HF #107: include effective team names in the admin personnel projection.
begin;

create or replace function public.direct_entry_personnel_admin_projection(
  p_recruiter public.recruiters,
  p_hrp_valid_from date,
  p_revision_count integer
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'recruiter_id', p_recruiter.recruiter_id,
    'display_name', p_recruiter.display_name,
    'personnel_code', p_recruiter.personnel_code,
    'personnel_position', p_recruiter.personnel_position,
    'active', p_recruiter.active,
    'version', p_recruiter.version,
    'hrp_valid_from', p_hrp_valid_from,
    'revision_count', coalesce(p_revision_count, 0),
    'team_names', coalesce((
      select jsonb_agg(t.display_name order by t.display_name)
        from public.recruiter_team_memberships m
        join public.teams t on t.team_id = m.team_id
       where m.recruiter_id = p_recruiter.recruiter_id
         and m.valid_from <= public.direct_entry_authorization_date()
         and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
         and (m.valid_to is null or m.valid_to > m.valid_from)
    ), '[]'::jsonb)
  )
$$;
revoke all on function public.direct_entry_personnel_admin_projection(public.recruiters, date, integer)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_personnel_admin_projection(public.recruiters, date, integer) is
  'PRE-W2-HF #107 internal admin projection: personnel business fields plus names of currently effective teams; no identity, grant, scope, reason or storage data. Revoked from every role.';

do $$
declare
  v_sig regprocedure := 'public.direct_entry_personnel_admin_projection(public.recruiters,date,integer)'::regprocedure;
  v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = v_sig;
  if v_src is null
     or position('team_names' in v_src) = 0
     or position('recruiter_team_memberships' in v_src) = 0
     or position('direct_entry_authorization_date' in v_src) = 0
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_proc p where p.oid = v_sig)
     or has_function_privilege('service_role', v_sig, 'EXECUTE')
     or has_function_privilege('authenticated', v_sig, 'EXECUTE')
     or has_function_privilege('anon', v_sig, 'EXECUTE') then
    raise exception 'personnel team-name projection boundary not installed';
  end if;
end;
$$;

commit;
