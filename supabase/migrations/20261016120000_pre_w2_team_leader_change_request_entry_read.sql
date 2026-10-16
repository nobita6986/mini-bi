-- PRE-W2-HF #106: allow a team leader to read only submitted entries in requests assigned to their team.
begin;

create or replace function public.direct_entry_resolve_submission_read_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_scope text;
  v_entry public.direct_entries%rowtype;
begin
  v_scope := public.direct_entry_resolve_draft_scope(
    p_auth_subject, p_app_user_id, p_entry_id
  );
  if v_scope is not null then
    return v_scope;
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select e.* into v_entry
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where e.entry_id = p_entry_id
     and e.deleted_at is null
     and s.state = 'SUBMITTED';
  if not found then
    return null;
  end if;

  if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id) then
    return 'project';
  end if;

  if exists (
    select 1
      from public.direct_entry_change_request_items i
      join public.direct_entry_change_requests r on r.request_id = i.request_id
     where i.entry_id = v_entry.entry_id
       and public.direct_entry_team_leader_request_team(p_app_user_id, r.request_id) = v_entry.team_id
  ) then
    return 'team_review';
  end if;

  return null;
end;
$$;

revoke all on function public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

do $$
declare
  v_proc regprocedure := 'public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)'::regprocedure;
  v_source text;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = v_proc;
  if v_source is null
     or position('direct_entry_team_leader_request_team' in v_source) = 0
     or position('return ''team_review''' in v_source) = 0
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_proc p where p.oid = v_proc)
     or has_function_privilege('service_role', v_proc, 'EXECUTE')
     or has_function_privilege('authenticated', v_proc, 'EXECUTE')
     or has_function_privilege('anon', v_proc, 'EXECUTE') then
    raise exception 'team-leader change-request read boundary not installed';
  end if;
end;
$$;

commit;
