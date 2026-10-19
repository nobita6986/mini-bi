-- W2-S1: allow the worker detail projection for the same bounded audiences as
-- the worker directory. Field-level pii/payment/document gates remain separate.
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
  v_today date := public.direct_entry_authorization_date();
  v_recruiter_link_count integer;
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

  -- Match the worker directory's recruited audience: exactly one current
  -- verified recruiter link, and the active recruiter must match this entry.
  select count(*)::integer into v_recruiter_link_count
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.valid_from <= v_today
     and (l.valid_to is null or v_today < l.valid_to);
  if v_recruiter_link_count = 1 and exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
     where l.app_user_id = p_app_user_id
       and l.recruiter_id = v_entry.recruiter_id
       and l.verified
       and l.valid_from <= v_today
       and (l.valid_to is null or v_today < l.valid_to)
  ) then
    return 'recruited';
  end if;

  -- Match the directory's all audience. This only opens the base projection;
  -- pii_view, payment_view and document_view continue to gate their own fields.
  if exists (
    select 1
      from public.direct_entry_scope_grants s
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'all'
       and s.valid_from <= v_today
       and (s.valid_to is null or v_today < s.valid_to)
  ) and (
    public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    or public.direct_entry_has_capability(p_app_user_id, 'change_review')
  ) then
    return 'all';
  end if;

  return null;
end;
$$;

revoke all on function public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

do $checks$
declare
  v_proc regprocedure :=
    'public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)'::regprocedure;
  v_source text;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = v_proc;
  if v_source is null
     or position('direct_entry_actor_is_assigned_project_manager' in v_source) = 0
     or position('direct_entry_team_leader_request_team' in v_source) = 0
     or position('v_recruiter_link_count = 1' in v_source) = 0
     or position('direct_entry_has_capability(p_app_user_id, ''change_review'')' in v_source) = 0
     or not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
               from pg_proc p where p.oid = v_proc)
     or has_function_privilege('service_role', v_proc, 'EXECUTE')
     or has_function_privilege('authenticated', v_proc, 'EXECUTE')
     or has_function_privilege('anon', v_proc, 'EXECUTE') then
    raise exception 'W2-S1 worker-directory detail scope contract drift' using errcode = '55000';
  end if;
end;
$checks$;

commit;
