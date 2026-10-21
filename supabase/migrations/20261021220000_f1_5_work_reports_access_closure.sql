-- F1.5 access closure: canonical Full Admin authority includes all four
-- Work Reports capabilities currently available in F1/F1.5.

begin;

create or replace function public.work_report_assert_actor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then
    raise exception 'WORK_REPORT_ACTOR_DENIED' using errcode = '42501';
  end if;
  if p_capability is not null
     and not public.direct_entry_has_capability(p_app_user_id, p_capability)
     and not (
       p_capability in ('report_form_manage', 'report_assign', 'report_view', 'report_analytics_view')
       and public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
       and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
       and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
       and public.direct_entry_has_scope(p_app_user_id, 'all')
     ) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
end;
$function$;

create or replace function public.work_report_assert_scope(
  p_app_user_id uuid,
  p_capability text,
  p_team_id uuid default null,
  p_require_all boolean default false
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if not public.direct_entry_has_capability(p_app_user_id, p_capability)
     and not (
       p_capability in ('report_form_manage', 'report_assign', 'report_view', 'report_analytics_view')
       and public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
       and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
       and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
       and public.direct_entry_has_scope(p_app_user_id, 'all')
     ) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if public.direct_entry_has_scope(p_app_user_id, 'all') then return 'all'; end if;
  if p_require_all then raise exception 'WORK_REPORT_ALL_SCOPE_REQUIRED' using errcode = '42501'; end if;
  if p_team_id is not null and exists (
    select 1 from public.direct_entry_scope_grants s
     where s.app_user_id = p_app_user_id and s.scope_kind = 'team'
       and s.team_id = p_team_id and s.is_current
  ) then return 'team'; end if;
  raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
end;
$function$;

commit;
