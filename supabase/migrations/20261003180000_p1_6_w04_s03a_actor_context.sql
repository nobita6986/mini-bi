create or replace function public.direct_entry_resolve_actor_context(
  p_auth_subject uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_app_user_id uuid;
  v_today date := (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  select u.app_user_id
    into v_app_user_id
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;

  if not found then
    return null;
  end if;

  return (
    select jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'enabled', u.enabled,
      'capabilities', coalesce((
        select jsonb_agg(distinct g.capability order by g.capability)
          from public.direct_entry_capability_grants g
         where g.app_user_id = u.app_user_id
           and g.valid_from <= v_today
           and (g.valid_to is null or v_today < g.valid_to)
      ), '[]'::jsonb),
      'recruiter_links', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', l.app_user_id,
          'recruiter_id', l.recruiter_id,
          'verified', l.verified,
          'valid_from', l.valid_from,
          'valid_to', l.valid_to
        ) order by l.valid_from, l.recruiter_id)
          from public.direct_entry_app_user_recruiter_links l
         where l.app_user_id = u.app_user_id
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object(
          'team_id', t.team_id,
          'code', t.code,
          'display', t.display_name,
          'active', t.active
        ) order by t.team_id)
          from public.teams t
         where exists (
           select 1
             from public.direct_entry_scope_grants g
            where g.app_user_id = u.app_user_id
              and g.scope_kind = 'team'
              and g.team_id = t.team_id
         )
      ), '[]'::jsonb),
      'team_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object(
          'team_id', g.team_id,
          'valid_from', g.valid_from,
          'valid_to', g.valid_to
        ) order by g.valid_from, g.team_id)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id
           and g.scope_kind = 'team'
      ), '[]'::jsonb),
      'all_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object(
          'valid_from', g.valid_from,
          'valid_to', g.valid_to
        ) order by g.valid_from)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id
           and g.scope_kind = 'all'
      ), '[]'::jsonb)
    )
      from public.direct_entry_app_users u
     where u.app_user_id = v_app_user_id
  );
end;
$$;

revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_actor_context(uuid)
  to service_role;
