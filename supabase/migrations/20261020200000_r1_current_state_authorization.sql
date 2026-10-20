-- R1 authorization cutover: interval dates initialize state once, then become metadata.
begin;

alter table public.direct_entry_capability_grants
  add column is_current boolean not null default false;
alter table public.direct_entry_scope_grants
  add column is_current boolean not null default false;
alter table public.direct_entry_app_user_recruiter_links
  add column is_current boolean not null default false;
alter table public.recruiter_team_memberships
  add column is_current boolean not null default false;
alter table public.recruiter_provider_memberships
  add column is_current boolean not null default false;
alter table public.direct_entry_project_manager_assignments
  add column is_current boolean not null default false;
alter table public.direct_entry_project_team_scopes
  add column is_current boolean not null default false;
alter table public.direct_entry_team_leader_assignments
  add column is_current boolean not null default false;

-- Marker map and lifecycle owners:
-- * capability_grants: account creation/team-leader designation sets true;
--   team-leader revoke and app-user disable clear it.
-- * scope_grants: account creation/team-leader designation sets true;
--   team-leader revoke and app-user/team disable clear it.
-- * app_user_recruiter_links: account creation sets true; verification revoke,
--   app-user/recruiter disable clear it.
-- * recruiter_team_memberships: team assignment/move sets true; unassign,
--   move-away, recruiter/team disable clear it. The existing audited catalog
--   bootstrap sets true only for the snapshot-current default team row.
-- * recruiter_provider_memberships: personnel/vendor creation sets true;
--   recruiter/vendor disable clears it. The existing audited catalog bootstrap
--   sets true only for the single provider period covering its import snapshot;
--   historical/future periods remain false and are never auto-promoted.
-- * project_manager_assignments: project-manager assignment sets true;
--   assignment revoke and recruiter disable clear it. Project deactivation only
--   prevents new work; it does not revoke access to existing project history.
-- * project_team_scopes: project-team grant sets true; revoke and
--   project/team disable clear it.
-- * team_leader_assignments: team-leader designation sets true; revoke and
--   app-user/recruiter/team disable clear it.
-- No post-cutover date-only update sets or clears these markers.

-- Fail closed where legacy intervals contain more than one current row for a
-- relationship that is supposed to resolve uniquely.
do $backfill$
declare
  v_snapshot date := public.direct_entry_authorization_date();
begin
  with candidates as (
    select grant_id, count(*) over (partition by app_user_id, capability) as n
      from public.direct_entry_capability_grants
     where valid_from <= v_snapshot and (valid_to is null or v_snapshot < valid_to)
  )
  update public.direct_entry_capability_grants g
     set is_current = c.n = 1 and exists (
       select 1 from public.direct_entry_app_users u where u.app_user_id = g.app_user_id and u.enabled
     )
    from candidates c
   where g.grant_id = c.grant_id;

  with candidates as (
    select grant_id, count(*) over (partition by app_user_id, scope_kind, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)) as n
      from public.direct_entry_scope_grants
     where valid_from <= v_snapshot and (valid_to is null or v_snapshot < valid_to)
  )
  update public.direct_entry_scope_grants g
     set is_current = c.n = 1
       and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = g.app_user_id and u.enabled)
       and (g.team_id is null or exists (select 1 from public.teams t where t.team_id = g.team_id and t.active))
    from candidates c
   where g.grant_id = c.grant_id;

  with candidates as (
    select link_id, count(*) over (partition by app_user_id) as n
      from public.direct_entry_app_user_recruiter_links
     where verified and valid_from <= v_snapshot and (valid_to is null or v_snapshot < valid_to)
  )
  update public.direct_entry_app_user_recruiter_links l
     set is_current = c.n = 1 and l.verified
       and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = l.app_user_id and u.enabled)
       and exists (select 1 from public.recruiters r where r.recruiter_id = l.recruiter_id and r.active)
    from candidates c
   where l.link_id = c.link_id;

  with candidates as (
    select membership_id, count(*) over (partition by recruiter_id) as n
      from public.recruiter_team_memberships
     where valid_from <= v_snapshot and (valid_to is null or v_snapshot < valid_to)
  )
  update public.recruiter_team_memberships m
     set is_current = c.n = 1
       and exists (select 1 from public.recruiters r where r.recruiter_id = m.recruiter_id and r.active)
       and exists (select 1 from public.teams t where t.team_id = m.team_id and t.active)
    from candidates c
   where m.membership_id = c.membership_id;

  with candidates as (
    select membership_id, count(*) over (partition by recruiter_id) as n
      from public.recruiter_provider_memberships
     where valid_from <= v_snapshot and (valid_to is null or v_snapshot < valid_to)
  )
  update public.recruiter_provider_memberships m
     set is_current = c.n = 1
       and exists (select 1 from public.recruiters r where r.recruiter_id = m.recruiter_id and r.active)
       and (m.vendor_id is null or exists (select 1 from public.vendors v where v.vendor_id = m.vendor_id and v.active))
    from candidates c
   where m.membership_id = c.membership_id;

  with candidates as (
    select assignment_id, count(*) over (partition by project_id, manager_recruiter_id) as n
      from public.direct_entry_project_manager_assignments
     where revoked_at is null and valid_from <= v_snapshot and (valid_to is null or v_snapshot < valid_to)
  )
  update public.direct_entry_project_manager_assignments a
     set is_current = c.n = 1
       and a.revoked_at is null
       and exists (select 1 from public.recruiters r where r.recruiter_id = a.manager_recruiter_id and r.active)
       and (select count(*)::int
              from public.direct_entry_app_user_recruiter_links l
             where l.recruiter_id = a.manager_recruiter_id and l.verified and l.is_current) = 1
       and (select count(*)::int
              from public.direct_entry_app_user_recruiter_links l
              join public.direct_entry_app_users u on u.app_user_id = l.app_user_id
             where l.recruiter_id = a.manager_recruiter_id and l.verified and l.is_current
               and u.enabled and u.auth_subject is not null) = 1
    from candidates c
   where a.assignment_id = c.assignment_id;

  with candidates as (
    select mapping_id, count(*) over (partition by project_id, team_id) as n
      from public.direct_entry_project_team_scopes
     where revoked_at is null and valid_from <= v_snapshot and (valid_to is null or v_snapshot < valid_to)
  )
  update public.direct_entry_project_team_scopes s
     set is_current = c.n = 1
       and exists (select 1 from public.direct_entry_projects p where p.project_id = s.project_id and p.active)
       and exists (select 1 from public.teams t where t.team_id = s.team_id and t.active)
    from candidates c
   where s.mapping_id = c.mapping_id;

  with candidates as (
    select assignment_id,
           count(*) over (partition by team_id) as team_n,
           count(*) over (partition by leader_app_user_id) as leader_n
      from public.direct_entry_team_leader_assignments
     where valid_from <= v_snapshot and (valid_to is null or v_snapshot < valid_to)
  )
  update public.direct_entry_team_leader_assignments a
     set is_current = c.team_n = 1 and c.leader_n = 1
       and exists (select 1 from public.teams t where t.team_id = a.team_id and t.active)
       and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = a.leader_app_user_id and u.enabled)
       and exists (select 1 from public.recruiters r where r.recruiter_id = a.leader_recruiter_id and r.active)
       and exists (select 1 from public.direct_entry_app_user_recruiter_links l
                    where l.app_user_id = a.leader_app_user_id and l.recruiter_id = a.leader_recruiter_id
                      and l.verified and l.is_current)
    from candidates c
   where a.assignment_id = c.assignment_id;
end;
$backfill$;

create or replace function public.direct_entry_set_current_on_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
begin
  if tg_op = 'UPDATE' then
    if tg_table_name in ('direct_entry_project_manager_assignments', 'direct_entry_project_team_scopes') then
      if old.revoked_at is null and new.revoked_at is not null then
        new.is_current := false;
        return new;
      end if;
    elsif tg_table_name = 'direct_entry_app_user_recruiter_links' then
      if old.verified and not new.verified then
        new.is_current := false;
        return new;
      end if;
    end if;
  end if;

  -- Markers are set by the audited grant/activation operation. A scheduled
  -- insert defaults to false and dates never promote it on a later request.
  if not new.is_current then
    return new;
  end if;

  case tg_table_name
    when 'direct_entry_capability_grants' then
      select u.enabled into new.is_current
        from public.direct_entry_app_users u where u.app_user_id = new.app_user_id;
    when 'direct_entry_scope_grants' then
      select u.enabled and (new.team_id is null or t.active) into new.is_current
        from public.direct_entry_app_users u left join public.teams t on t.team_id = new.team_id
       where u.app_user_id = new.app_user_id;
    when 'direct_entry_app_user_recruiter_links' then
      select new.verified and u.enabled and r.active into new.is_current
        from public.direct_entry_app_users u join public.recruiters r on r.recruiter_id = new.recruiter_id
       where u.app_user_id = new.app_user_id;
    when 'recruiter_team_memberships' then
      select r.active and t.active into new.is_current
        from public.recruiters r join public.teams t on t.team_id = new.team_id
       where r.recruiter_id = new.recruiter_id;
    when 'recruiter_provider_memberships' then
      select r.active and (new.vendor_id is null or v.active) into new.is_current
        from public.recruiters r left join public.vendors v on v.vendor_id = new.vendor_id
       where r.recruiter_id = new.recruiter_id;
    when 'direct_entry_project_manager_assignments' then
      select new.revoked_at is null and r.active
        and (select count(*)::int
               from public.direct_entry_app_user_recruiter_links l
              where l.recruiter_id = new.manager_recruiter_id and l.verified and l.is_current) = 1
        and (select count(*)::int
               from public.direct_entry_app_user_recruiter_links l
               join public.direct_entry_app_users u on u.app_user_id = l.app_user_id
              where l.recruiter_id = new.manager_recruiter_id and l.verified and l.is_current
                and u.enabled and u.auth_subject is not null) = 1
        into new.is_current
        from public.recruiters r
       where r.recruiter_id = new.manager_recruiter_id;
    when 'direct_entry_project_team_scopes' then
      select new.revoked_at is null and p.active and t.active into new.is_current
        from public.direct_entry_projects p join public.teams t on t.team_id = new.team_id
       where p.project_id = new.project_id;
    when 'direct_entry_team_leader_assignments' then
      select t.active and u.enabled and r.active and exists (
        select 1 from public.direct_entry_app_user_recruiter_links l
         where l.app_user_id = new.leader_app_user_id and l.recruiter_id = new.leader_recruiter_id
           and l.verified and l.is_current
      ) into new.is_current
        from public.teams t join public.direct_entry_app_users u on u.app_user_id = new.leader_app_user_id
        join public.recruiters r on r.recruiter_id = new.leader_recruiter_id
       where t.team_id = new.team_id;
    else
      raise exception 'unsupported current-state table %', tg_table_name using errcode = '22023';
  end case;
  new.is_current := coalesce(new.is_current, false);
  return new;
end;
$function$;

revoke all on function public.direct_entry_set_current_on_insert() from public, anon, authenticated, service_role;

create trigger direct_entry_set_current_on_insert
before insert or update on public.direct_entry_capability_grants
for each row execute function public.direct_entry_set_current_on_insert();
create trigger direct_entry_set_current_on_insert
before insert or update on public.direct_entry_scope_grants
for each row execute function public.direct_entry_set_current_on_insert();
create trigger direct_entry_set_current_on_insert
before insert or update on public.direct_entry_app_user_recruiter_links
for each row execute function public.direct_entry_set_current_on_insert();
create trigger direct_entry_set_current_on_insert
before insert or update on public.recruiter_team_memberships
for each row execute function public.direct_entry_set_current_on_insert();
create trigger direct_entry_set_current_on_insert
before insert or update on public.recruiter_provider_memberships
for each row execute function public.direct_entry_set_current_on_insert();
create trigger direct_entry_set_current_on_insert
before insert or update on public.direct_entry_project_manager_assignments
for each row execute function public.direct_entry_set_current_on_insert();
create trigger direct_entry_set_current_on_insert
before insert or update on public.direct_entry_project_team_scopes
for each row execute function public.direct_entry_set_current_on_insert();
create trigger direct_entry_set_current_on_insert
before insert or update on public.direct_entry_team_leader_assignments
for each row execute function public.direct_entry_set_current_on_insert();

create or replace function public.direct_entry_clear_authority_on_disable()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'UPDATE' then
    if tg_table_name = 'direct_entry_app_users' then
      if old.enabled and not new.enabled then
        update public.direct_entry_capability_grants set is_current = false where app_user_id = new.app_user_id;
        update public.direct_entry_scope_grants set is_current = false where app_user_id = new.app_user_id;
        update public.direct_entry_app_user_recruiter_links set is_current = false where app_user_id = new.app_user_id;
        update public.direct_entry_team_leader_assignments set is_current = false where leader_app_user_id = new.app_user_id;
      end if;
    elsif tg_table_name = 'recruiters' then
      if old.active and not new.active then
        update public.recruiter_team_memberships set is_current = false where recruiter_id = new.recruiter_id;
        update public.recruiter_provider_memberships set is_current = false where recruiter_id = new.recruiter_id;
        update public.direct_entry_app_user_recruiter_links set is_current = false where recruiter_id = new.recruiter_id;
        update public.direct_entry_project_manager_assignments set is_current = false where manager_recruiter_id = new.recruiter_id;
        update public.direct_entry_team_leader_assignments set is_current = false where leader_recruiter_id = new.recruiter_id;
      end if;
    elsif tg_table_name = 'teams' then
      if old.active and not new.active then
        update public.direct_entry_scope_grants set is_current = false where team_id = new.team_id;
        update public.recruiter_team_memberships set is_current = false where team_id = new.team_id;
        update public.direct_entry_project_team_scopes set is_current = false where team_id = new.team_id;
        update public.direct_entry_team_leader_assignments set is_current = false where team_id = new.team_id;
      end if;
    elsif tg_table_name = 'direct_entry_projects' then
      if old.active and not new.active then
        update public.direct_entry_project_team_scopes set is_current = false where project_id = new.project_id;
      end if;
    elsif tg_table_name = 'vendors' then
      if old.active and not new.active then
        update public.recruiter_provider_memberships set is_current = false where vendor_id = new.vendor_id;
      end if;
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.direct_entry_clear_authority_on_disable() from public, anon, authenticated, service_role;
create trigger direct_entry_clear_authority_on_disable after update of enabled on public.direct_entry_app_users for each row execute function public.direct_entry_clear_authority_on_disable();
create trigger direct_entry_clear_authority_on_disable after update of active on public.recruiters for each row execute function public.direct_entry_clear_authority_on_disable();
create trigger direct_entry_clear_authority_on_disable after update of active on public.teams for each row execute function public.direct_entry_clear_authority_on_disable();
create trigger direct_entry_clear_authority_on_disable after update of active on public.direct_entry_projects for each row execute function public.direct_entry_clear_authority_on_disable();
create trigger direct_entry_clear_authority_on_disable after update of active on public.vendors for each row execute function public.direct_entry_clear_authority_on_disable();

create or replace function public.direct_entry_has_capability(p_app_user_id uuid, p_capability text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
     and p_capability is not null
     and p_capability not in ('pii_view', 'pii_export', 'payment_view', 'payment_edit')
     and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = p_app_user_id and u.enabled)
     and exists (select 1 from public.direct_entry_capability_grants g
                  where g.app_user_id = p_app_user_id and g.capability = p_capability and g.is_current)
$function$;

create or replace function public.direct_entry_has_scope(p_app_user_id uuid, p_scope_kind text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
     and p_scope_kind in ('own', 'team', 'all')
     and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = p_app_user_id and u.enabled)
     and exists (select 1 from public.direct_entry_scope_grants s
                  where s.app_user_id = p_app_user_id and s.scope_kind = p_scope_kind and s.is_current
                    and (s.scope_kind <> 'team' or exists (select 1 from public.teams t where t.team_id=s.team_id and t.active)))
$function$;

create or replace function public.direct_entry_assert_actor(p_auth_subject uuid, p_app_user_id uuid, p_capability text)
returns void language plpgsql security definer
set search_path = pg_catalog, public
as $function$
begin
  if not exists (select 1 from public.direct_entry_app_users u
                  where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled) then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;
  if not public.direct_entry_has_capability(p_app_user_id, p_capability) then
    raise exception 'capability denied' using errcode = '42501';
  end if;
end;
$function$;

create or replace function public.direct_entry_assert_actor_app_user_admin(p_auth_subject uuid, p_app_user_id uuid)
returns text language plpgsql security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not (public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
      and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
      and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
      and public.direct_entry_has_scope(p_app_user_id, 'all')) then
    raise exception 'actor is not a Full Admin' using errcode = '42501';
  end if;
  return 'entry_admin';
end;
$function$;

create or replace function public.direct_entry_assert_catalog_operator(p_auth_subject uuid, p_app_user_id uuid)
returns text language plpgsql security definer
set search_path = pg_catalog, public
as $function$
declare
  v_full_admin boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_full_admin := public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage');
  if not v_full_admin and not public.direct_entry_has_capability(p_app_user_id, 'catalog_master_manage') then
    raise exception 'catalog operator denied' using errcode = '42501';
  end if;
  if not public.direct_entry_has_scope(p_app_user_id, 'all') then
    raise exception 'catalog operation requires all scope' using errcode = '42501';
  end if;
  return case when v_full_admin then 'entry_admin' else 'catalog_master_manage' end;
end;
$function$;

create or replace function public.direct_entry_assert_entry_access(
  p_auth_subject uuid, p_app_user_id uuid, p_capability text, p_entry_owner uuid, p_team_id uuid,
  p_effective_date date, p_required_scope text default null
)
returns text language plpgsql security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope text;
  v_matches integer;
begin
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, p_capability);
  select count(*), min(g.scope_kind) into v_matches, v_scope
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id and g.is_current
     and (g.scope_kind <> 'team' or exists (select 1 from public.teams t where t.team_id = g.team_id and t.active))
     and ((g.scope_kind = 'own' and p_entry_owner = p_app_user_id)
       or (g.scope_kind = 'team' and g.team_id = p_team_id) or g.scope_kind = 'all')
     and (p_required_scope is null or g.scope_kind = p_required_scope);
  if v_matches <> 1 then raise exception 'resource scope denied' using errcode = '42501'; end if;
  return v_scope;
end;
$function$;

create or replace function public.direct_entry_assert_draft_access(
  p_auth_subject uuid, p_app_user_id uuid, p_entry_owner uuid, p_team_id uuid,
  p_resource_scope_date date, p_required_scope text default null
)
returns text language plpgsql security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope text;
  v_capability text;
  v_matches integer;
begin
  select count(*), min(g.scope_kind) into v_matches, v_scope
    from public.direct_entry_scope_grants g
    join public.direct_entry_capability_grants c on c.app_user_id = g.app_user_id and c.is_current
      and c.capability = case g.scope_kind when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end
   where g.app_user_id = p_app_user_id and g.is_current
     and (g.scope_kind <> 'team' or exists (select 1 from public.teams t where t.team_id = g.team_id and t.active))
     and ((g.scope_kind = 'own' and p_entry_owner = p_app_user_id)
       or (g.scope_kind = 'team' and g.team_id = p_team_id) or g.scope_kind = 'all')
     and (p_required_scope is null or g.scope_kind = p_required_scope);
  if v_matches <> 1 then raise exception 'draft scope/capability denied' using errcode = '42501'; end if;
  v_capability := case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end;
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, v_capability);
  return v_scope;
end;
$function$;

create or replace function public.direct_entry_has_entry_access(
  p_app_user_id uuid, p_capability text, p_entry_owner uuid, p_team_id uuid, p_effective_date date
)
returns boolean language sql security definer
set search_path = pg_catalog, public
as $function$
  select public.direct_entry_has_capability(p_app_user_id, p_capability)
     and (select count(*) from public.direct_entry_scope_grants sg
           where sg.app_user_id = p_app_user_id and sg.is_current
             and (sg.scope_kind <> 'team' or exists (select 1 from public.teams t where t.team_id=sg.team_id and t.active))
             and ((sg.scope_kind = 'own' and p_entry_owner = p_app_user_id)
               or (sg.scope_kind = 'team' and p_team_id is not null and sg.team_id = p_team_id)
               or sg.scope_kind = 'all')) = 1
$function$;

create or replace function public.direct_entry_project_assignment_effective(p_app_user_id uuid, p_project_id text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1 from public.direct_entry_project_manager_assignments a
    join public.direct_entry_app_user_recruiter_links l
      on l.recruiter_id = a.manager_recruiter_id and l.app_user_id = p_app_user_id and l.verified and l.is_current
    join public.direct_entry_app_users u
      on u.app_user_id = l.app_user_id and u.enabled and u.auth_subject is not null
    join public.recruiters r on r.recruiter_id = a.manager_recruiter_id and r.active
    where p_app_user_id is not null and a.is_current and a.revoked_at is null
      and (p_project_id is null or a.project_id = p_project_id)
      and (select count(*)::int
             from public.direct_entry_app_user_recruiter_links current_link
            where current_link.recruiter_id = a.manager_recruiter_id
              and current_link.verified and current_link.is_current) = 1
      and (select count(*)::int
             from public.direct_entry_app_user_recruiter_links current_link
             join public.direct_entry_app_users linked_user
               on linked_user.app_user_id = current_link.app_user_id
            where current_link.recruiter_id = a.manager_recruiter_id
              and current_link.verified and current_link.is_current
              and linked_user.enabled and linked_user.auth_subject is not null) = 1
  )
$function$;

create or replace function public.direct_entry_actor_can_access_project(p_app_user_id uuid, p_project_id text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null and p_project_id is not null and (
    (public.direct_entry_has_scope(p_app_user_id, 'all') and public.direct_entry_has_capability(p_app_user_id, 'entry_admin'))
    or public.direct_entry_project_assignment_effective(p_app_user_id, p_project_id)
  )
$function$;

create or replace function public.direct_entry_project_team_scope_effective(p_project_id text, p_team_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $function$
  select exists (select 1 from public.direct_entry_project_team_scopes s
                  join public.direct_entry_projects p on p.project_id=s.project_id and p.active
                  join public.teams t on t.team_id=s.team_id and t.active
                 where s.project_id=p_project_id and s.team_id=p_team_id and s.is_current and s.revoked_at is null)
$function$;

create or replace function public.direct_entry_lock_project_team_scope(p_project_id text, p_team_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $function$
declare v_mapping_id uuid;
begin
  select s.mapping_id into v_mapping_id from public.direct_entry_project_team_scopes s
   where s.project_id=p_project_id and s.team_id=p_team_id and s.is_current and s.revoked_at is null
   for update;
  return v_mapping_id is not null;
end;
$function$;

create or replace function public.direct_entry_create_authority(
  p_auth_subject uuid, p_app_user_id uuid, p_project_id text, p_first_work_date date default null
)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if p_project_id is not null and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    return 'manager';
  end if;
  if public.direct_entry_has_capability(p_app_user_id, 'entry_create')
     and public.direct_entry_has_capability(p_app_user_id, 'submission_create')
     and public.direct_entry_has_scope(p_app_user_id, 'own') then
    return 'legacy';
  end if;
  raise exception 'worker create authority denied' using errcode='42501';
end;
$function$;

create or replace function public.direct_entry_assert_project_admin(p_auth_subject uuid, p_app_user_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'entry_admin');
  if not public.direct_entry_has_scope(p_app_user_id, 'all') then
    raise exception 'project administration requires all scope' using errcode = '42501';
  end if;
end;
$function$;

create or replace function public.direct_entry_resolve_actor_context(p_auth_subject uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog
as $function$
declare
  v_app_user_id uuid;
begin
  select u.app_user_id into v_app_user_id
    from public.direct_entry_app_users u where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  return (
    select jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce((
        select jsonb_agg(distinct g.capability order by g.capability)
          from public.direct_entry_capability_grants g
         where g.app_user_id = u.app_user_id and g.is_current
           and g.capability not in ('pii_view', 'pii_export', 'payment_view', 'payment_edit')
      ), '[]'::jsonb),
      'recruiter_links', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', l.app_user_id, 'recruiter_id', l.recruiter_id, 'verified', l.verified,
          'valid_from', l.valid_from, 'valid_to', l.valid_to
        ) order by l.valid_from, l.recruiter_id)
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
         where l.app_user_id = u.app_user_id and l.verified and l.is_current and u.enabled
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', t.team_id, 'code', t.code,
          'display', t.display_name, 'active', t.active) order by t.team_id)
          from public.teams t
         where t.active and exists (
           select 1 from public.direct_entry_scope_grants g
            where g.app_user_id = u.app_user_id and g.scope_kind = 'team'
              and g.team_id = t.team_id and g.is_current and u.enabled
         )
      ), '[]'::jsonb),
      'team_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', g.team_id,
          'valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from, g.team_id)
          from public.direct_entry_scope_grants g join public.teams t on t.team_id = g.team_id and t.active
         where g.app_user_id = u.app_user_id and g.scope_kind = 'team' and g.is_current and u.enabled
      ), '[]'::jsonb),
      'all_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id and g.scope_kind = 'all' and g.is_current and u.enabled
      ), '[]'::jsonb)
    ) from public.direct_entry_app_users u where u.app_user_id = v_app_user_id
  );
end;
$function$;

create or replace function public.direct_entry_worker_directory_audience(
  p_auth_subject uuid, p_app_user_id uuid, p_scope text, p_project_id text
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $function$
declare
  v_link_count integer;
  v_recruiter_id uuid;
  v_project_ids jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if p_scope is null or p_scope not in ('recruited', 'managed', 'all') then
    raise exception 'invalid worker directory scope' using errcode = '22023';
  end if;
  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'invalid project filter' using errcode = '22023';
  end if;

  if p_scope = 'recruited' then
    select count(*)::int into v_link_count from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id and l.verified and l.is_current;
    if v_link_count <> 1 then
      raise exception 'worker directory recruiter link unavailable or ambiguous' using errcode = '42501';
    end if;
    select l.recruiter_id into v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
     where l.app_user_id = p_app_user_id and l.verified and l.is_current;
    if v_recruiter_id is null then raise exception 'worker directory recruiter unavailable' using errcode = '42501'; end if;
    return jsonb_build_object('scope','recruited','recruiter_ids',jsonb_build_array(v_recruiter_id),
      'project_ids','[]'::jsonb,'view_pii',true,'view_payment',true);
  end if;

  if p_scope = 'managed' then
    if not public.direct_entry_actor_has_project_assignment(p_app_user_id) then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;
    select coalesce(jsonb_agg(distinct a.project_id), '[]'::jsonb) into v_project_ids
      from public.direct_entry_project_manager_assignments a
      join public.direct_entry_app_user_recruiter_links l on l.recruiter_id = a.manager_recruiter_id
       and l.app_user_id = p_app_user_id and l.verified and l.is_current
     where a.is_current and a.revoked_at is null;
    if jsonb_array_length(v_project_ids) = 0 then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;
    if p_project_id is not null and not (v_project_ids ? p_project_id) then
      raise exception 'worker directory project is out of scope' using errcode = '42501';
    end if;
    return jsonb_build_object('scope','managed','recruiter_ids','[]'::jsonb,
      'project_ids',v_project_ids,'view_pii',true,'view_payment',true);
  end if;

  if not public.direct_entry_has_scope(p_app_user_id, 'all') then
    raise exception 'worker directory requires all scope' using errcode = '42501';
  end if;
  if not (public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
       or public.direct_entry_has_capability(p_app_user_id, 'change_review')) then
    raise exception 'worker directory requires a reviewer or admin capability' using errcode = '42501';
  end if;
  return jsonb_build_object('scope','all','recruiter_ids','[]'::jsonb,
    'project_ids','[]'::jsonb,'view_pii',true,'view_payment',true);
end;
$function$;

create or replace function public.direct_entry_reporting_resolve_audience(p_auth_subject uuid, p_app_user_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $function$
declare
  v_found boolean;
  v_team jsonb;
  v_link jsonb;
  v_link_count integer;
begin
  select exists (select 1 from public.direct_entry_app_users u
                  where u.app_user_id=p_app_user_id and u.auth_subject=p_auth_subject and u.enabled) into v_found;
  if not v_found then raise exception 'reporting actor unavailable' using errcode='42501'; end if;

  if public.direct_entry_has_scope(p_app_user_id, 'all') then
    return jsonb_build_object('audience','all','label','Toàn công ty','team_ids','[]'::jsonb,'recruiter_id',null);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('team_id',t.team_id,'label',t.display_name)
                   order by t.display_name,t.team_id),'[]'::jsonb) into v_team
    from public.direct_entry_scope_grants g join public.teams t on t.team_id=g.team_id and t.active
   where g.app_user_id=p_app_user_id and g.scope_kind='team' and g.is_current;
  if jsonb_array_length(v_team)>0 then
    return jsonb_build_object('audience','team','label',v_team->0->>'label',
      'team_ids',(select coalesce(jsonb_agg(x->'team_id'),'[]'::jsonb) from jsonb_array_elements(v_team) x),
      'recruiter_id',null);
  end if;

  select count(*) into v_link_count from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id=p_app_user_id and l.verified and l.is_current;
  if v_link_count>1 then raise exception 'reporting actor ambiguous recruiter link' using errcode='42501'; end if;
  select jsonb_build_object('recruiter_id',l.recruiter_id,'label',r.display_name) into v_link
    from public.direct_entry_app_user_recruiter_links l join public.recruiters r
      on r.recruiter_id=l.recruiter_id and r.active
   where l.app_user_id=p_app_user_id and l.verified and l.is_current limit 1;
  return jsonb_build_object('audience','own','label',coalesce(v_link->>'label','Cá nhân'),
    'team_ids','[]'::jsonb,'recruiter_id',v_link->>'recruiter_id');
end;
$function$;

create or replace function public.direct_entry_team_leader_request_team(p_app_user_id uuid, p_request_id uuid)
returns uuid language sql stable security definer
set search_path = pg_catalog, public
as $function$
 select (array_agg(e.team_id))[1]
 from public.direct_entry_change_request_items i
 join public.direct_entries e on e.entry_id=i.entry_id
 where i.request_id=p_request_id and e.team_id is not null
   and public.direct_entry_has_capability(p_app_user_id,'team_manager_assign')
   and exists(select 1 from public.direct_entry_scope_grants s join public.teams t on t.team_id=s.team_id and t.active
     where s.app_user_id=p_app_user_id and s.scope_kind='team' and s.team_id=e.team_id and s.is_current)
   and exists(select 1 from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id=p_app_user_id and a.team_id=e.team_id and a.is_current)
 group by i.request_id
 having count(*)=(select count(*) from public.direct_entry_change_request_items x where x.request_id=p_request_id)
    and count(distinct e.team_id)=1;
$function$;

create or replace function public.direct_entry_assert_team_leader_read_authority(
  p_auth_subject uuid, p_app_user_id uuid, p_team_id uuid default null
)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_count integer;
  v_scope_team_id uuid;
  v_link_count integer;
  v_link_recruiter_id uuid;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_assignment_count integer;
  v_catalog_operator boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'team leader read authority denied' using errcode='42501';
  end if;
  perform public.direct_entry_assert_actor_mapping(p_auth_subject,p_app_user_id);
  begin
    perform public.direct_entry_assert_catalog_operator(p_auth_subject,p_app_user_id);
    v_catalog_operator := true;
  exception when insufficient_privilege then null;
  end;
  if v_catalog_operator then return p_team_id; end if;
  if not public.direct_entry_has_capability(p_app_user_id,'team_manager_assign') then
    raise exception 'team leader read authority denied' using errcode='42501';
  end if;

  select count(*)::int,(array_agg(s.team_id))[1] into v_scope_count,v_scope_team_id
    from public.direct_entry_scope_grants s join public.teams t on t.team_id=s.team_id and t.active and t.code<>'__system_vendor__'
   where s.app_user_id=p_app_user_id and s.scope_kind='team' and s.is_current;
  if v_scope_count<>1 or v_scope_team_id is null then
    raise exception 'team leader read authority denied' using errcode='42501';
  end if;
  if p_team_id is not null and p_team_id<>v_scope_team_id then
    raise exception 'team leader read authority denied' using errcode='42501';
  end if;

  select count(*)::int,(array_agg(l.recruiter_id))[1] into v_link_count,v_link_recruiter_id
    from public.direct_entry_app_user_recruiter_links l join public.recruiters r on r.recruiter_id=l.recruiter_id and r.active
   where l.app_user_id=p_app_user_id and l.verified and l.is_current;
  if v_link_count<>1 or v_link_recruiter_id is null then
    raise exception 'team leader read authority denied' using errcode='42501';
  end if;

  select count(*)::int,count(*) filter(where m.provider_type='hrp' and m.vendor_id is null)::int
    into v_provider_count,v_hrp_provider_count from public.recruiter_provider_memberships m
    join public.recruiters r on r.recruiter_id=m.recruiter_id and r.active
   where m.recruiter_id=v_link_recruiter_id and m.is_current;
  if v_provider_count<>1 or v_hrp_provider_count<>1 then
    raise exception 'team leader read authority denied' using errcode='42501';
  end if;

  select count(*)::int,count(*) filter(where m.team_id=v_scope_team_id)::int
    into v_membership_count,v_matching_membership_count from public.recruiter_team_memberships m
    join public.teams t on t.team_id=m.team_id and t.active
   where m.recruiter_id=v_link_recruiter_id and m.is_current;
  if v_membership_count<>1 or v_matching_membership_count<>1 then
    raise exception 'team leader read authority denied' using errcode='42501';
  end if;

  select count(*)::int into v_assignment_count from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id=p_app_user_id and a.leader_recruiter_id=v_link_recruiter_id
     and a.team_id=v_scope_team_id and a.is_current;
  if v_assignment_count<>1 then raise exception 'team leader read authority denied' using errcode='42501'; end if;
  return v_scope_team_id;
end;
$function$;

create or replace function public.direct_entry_resolve_submission_read_scope(
  p_auth_subject uuid, p_app_user_id uuid, p_entry_id uuid
)
returns text language plpgsql security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope text;
  v_entry public.direct_entries%rowtype;
  v_recruiter_link_count integer;
begin
  v_scope := public.direct_entry_resolve_draft_scope(p_auth_subject,p_app_user_id,p_entry_id);
  if v_scope is not null then return v_scope; end if;
  perform public.direct_entry_assert_actor_mapping(p_auth_subject,p_app_user_id);
  select e.* into v_entry from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id=e.submission_id
   where e.entry_id=p_entry_id and e.deleted_at is null and s.state='SUBMITTED';
  if not found then return null; end if;
  if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id,v_entry.project_id) then return 'project'; end if;
  if exists(select 1 from public.direct_entry_change_request_items i
     join public.direct_entry_change_requests r on r.request_id=i.request_id
    where i.entry_id=v_entry.entry_id and public.direct_entry_team_leader_request_team(p_app_user_id,r.request_id)=v_entry.team_id) then
    return 'team_review';
  end if;
  select count(*)::integer into v_recruiter_link_count from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id=p_app_user_id and l.verified and l.is_current;
  if v_recruiter_link_count=1 and exists(
    select 1 from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r on r.recruiter_id=l.recruiter_id and r.active
    where l.app_user_id=p_app_user_id and l.recruiter_id=v_entry.recruiter_id and l.verified and l.is_current
  ) then return 'recruited'; end if;
  if public.direct_entry_has_scope(p_app_user_id,'all') and (
      public.direct_entry_has_capability(p_app_user_id,'entry_admin')
      or public.direct_entry_has_capability(p_app_user_id,'change_review')) then return 'all'; end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_read_projection(p_auth_subject uuid, p_app_user_id uuid, p_entry_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  v_scope := public.direct_entry_resolve_submission_read_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end if;
  if v_scope is null then
    raise exception 'entry scope/capability denied' using errcode = '42501';
  end if;
  v_pii := true;
  v_payment := true;
  v_documents := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id and g.capability = 'document_view'
       and g.is_current
  ) or (
    v_entry.created_by_user_id = p_app_user_id
    and v_scope = 'project'
    and exists (
      select 1 from public.direct_entry_submissions s
       where s.submission_id = v_entry.submission_id and s.state = 'DRAFT'
    )
  );

  if v_scope = 'project' and exists (
       select 1 from public.direct_entry_submissions s
        where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
     ) then
    v_pii := true;
    v_payment := true;
  end if;
  v_result := jsonb_build_object(
    'entry_id', v_entry.entry_id, 'submission_id', v_entry.submission_id,
    'project_id', v_entry.project_id, 'first_work_date', v_entry.first_work_date,
    'employee_code', v_entry.employee_code,
    'worker_details', case when v_pii then v_entry.worker_details else jsonb_build_object(
      'display_name', jsonb_build_object('present', v_entry.worker_details ? 'display_name'),
      'gender', jsonb_build_object('state', v_entry.worker_details->'gender'->>'state'),
      'date_of_birth', jsonb_build_object('state', v_entry.worker_details->'date_of_birth'->>'state'),
      'national_id', jsonb_build_object('state', v_entry.worker_details->'national_id'->>'state'),
      'national_id_issued_at', jsonb_build_object(
        'state', v_entry.worker_details->'national_id_issued_at'->>'state'
      ),
      'national_id_issued_place', jsonb_build_object(
        'state', v_entry.worker_details->'national_id_issued_place'->>'state'
      ),
      'address', jsonb_build_object('state', v_entry.worker_details->'address'->>'state'),
      'phone', jsonb_build_object('state', v_entry.worker_details->'phone'->>'state')
    ) end,
    'general_note', case when v_entry.general_note is null then null
      when v_pii then to_jsonb(v_entry.general_note)
      else jsonb_build_object('present', true) end,
    'recruiter_id', v_entry.recruiter_id, 'team_id', v_entry.team_id,
    'provider_type', v_entry.provider_type, 'labor_type', v_entry.labor_type,
    'labor_type_display', (select lt.display_name from public.direct_entry_labor_types lt
      where lt.labor_type_key = v_entry.labor_type),
    'version', v_entry.version, 'scope_kind', v_scope,
    'payment', (
      select case when v_payment then jsonb_build_object(
        'state', p.state, 'account_number', p.account_number, 'bank_id', p.bank_id,
        'bank_name', p.bank_name, 'account_holder_name', p.account_holder_name,
        'version', p.version
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
    'worker_portrait', case when v_documents then (
      select jsonb_build_object(
        'origin', c.worker_portrait_origin,
        'added_at', c.worker_portrait_added_at,
        'status', coalesce(latest.upload_status, 'MISSING'),
        'current', case when current_document.document_id is null then null
          else jsonb_build_object(
            'document_id', current_document.document_id,
            'version', current_document.version,
            'checksum_sha256', current_document.checksum_sha256,
            'mime_type', current_document.mime_type,
            'size_bytes', current_document.size_bytes
          )
        end
      )
        from public.direct_entry_candidates c
        left join lateral (
          select e.upload_status
            from public.direct_entry_document_versions d
            join lateral (
              select ev.upload_status
                from public.direct_entry_document_events ev
               where ev.document_id = d.document_id
               order by ev.version desc
               limit 1
            ) e on true
           where d.candidate_id = c.candidate_id
             and d.document_type = 'WORKER_PORTRAIT'
           order by d.version desc
           limit 1
        ) latest on true
        left join lateral (
          select cd.document_id, cd.version, cd.checksum_sha256, cd.mime_type, cd.size_bytes
            from public.direct_entry_current_documents cd
           where cd.candidate_id = c.candidate_id
             and cd.document_type = 'WORKER_PORTRAIT'
        ) current_document on true
       where c.candidate_id = v_entry.candidate_id
    ) else null end,
    'documents', case when v_documents then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'size_bytes', d.size_bytes, 'mime_type', d.mime_type,
        'upload_status', d.upload_status, 'scan_status', d.scan_status,
        'validation_status', d.validation_status
      ) order by d.document_type, d.version), '[]'::jsonb)
        from public.direct_entry_current_documents d
       where d.candidate_id = v_entry.candidate_id
         and d.document_type <> 'WORKER_PORTRAIT'
    ) else '[]'::jsonb end
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_workers(p_auth_subject uuid, p_app_user_id uuid, p_scope text, p_project_id text DEFAULT NULL::text, p_recruiter_id uuid DEFAULT NULL::uuid, p_employment_status text DEFAULT NULL::text, p_cursor text DEFAULT NULL::text, p_page_size integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_audience jsonb;
  v_scope text;
  v_recruiter_ids uuid[];
  v_project_ids text[];
  v_view_pii boolean;
  v_view_payment boolean;
  v_page_size integer;
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_scanned integer;
  v_items jsonb;
  v_next_cursor text;
  v_summary jsonb;
begin
  v_audience := public.direct_entry_worker_directory_audience(
    p_auth_subject, p_app_user_id, p_scope, p_project_id
  );
  v_scope := v_audience->>'scope';
  v_view_pii := true;
  v_view_payment := true;
  v_recruiter_ids := case
    when jsonb_array_length(v_audience->'recruiter_ids') = 0 then null
    else array(select jsonb_array_elements_text(v_audience->'recruiter_ids')::uuid)
  end;
  v_project_ids := case
    when jsonb_array_length(v_audience->'project_ids') = 0 then null
    else array(select jsonb_array_elements_text(v_audience->'project_ids'))
  end;

  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_employment_status is not null
     and p_employment_status not in ('UNCONFIRMED', 'ON', 'OFF') then
    raise exception 'invalid employment status filter' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{8}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select e.entry_id,
           e.version,
           e.project_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.recruiter_id,
           e.labor_type,
           (select lt.display_name from public.direct_entry_labor_types lt
             where lt.labor_type_key = e.labor_type) as labor_type_display,
           s.state,
           pr.display_name as project_display,
           rc.display_name as recruiter_display,
           st.status as employment_status,
           pay.state as payment_state,
           pay.account_number,
           pay.bank_id,
           pay.account_holder_name,
           pay.version as payment_version
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
      join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join lateral (
        select ev.status
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
      left join public.direct_entry_payments pay
        on pay.entry_id = e.entry_id
     where e.deleted_at is null and e.voided_at is null
       and s.state = 'SUBMITTED'
       and (
         v_scope = 'all'
         or (v_scope = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
         or (v_scope = 'managed' and e.project_id = any(v_project_ids))
       )
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_recruiter_id is null or e.recruiter_id = p_recruiter_id)
       and (p_employment_status is null or st.status = p_employment_status)
  ),
  summary as (
    select count(*)::bigint as total_workers,
           count(distinct project_id)::bigint as project_count,
           count(distinct recruiter_id)::bigint as recruiter_count
      from candidates
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.first_work_date, 'YYYYMMDD') || ':' || c.entry_id::text as cursor
      from candidates c
     where v_cursor_stamp is null
        or (
             pg_catalog.to_char(c.first_work_date, 'YYYYMMDD'),
             c.entry_id::text
           ) < (v_cursor_stamp, v_cursor_id::text)
     order by c.first_work_date desc, c.entry_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by first_work_date desc, entry_id desc limit v_page_size
  )
  select
    (select count(*)::int from page),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
               'entry_id', t.entry_id,
               'entry_version', t.version,
               'submission_state', t.state,
               'employee_code', t.employee_code,
               'display_name', t.worker_details->>'display_name',
               'project_id', t.project_id,
               'project_display', t.project_display,
               'first_work_date', pg_catalog.to_char(t.first_work_date, 'YYYY-MM-DD'),
               'labor_type', t.labor_type,
               'labor_type_display', t.labor_type_display,
               'employment_status', t.employment_status,
               'recruiter_id', t.recruiter_id,
               'recruiter_display', t.recruiter_display,
               'payment', case
                 when v_view_payment and t.payment_state is not null then jsonb_build_object(
                   'state', t.payment_state,
                   'account_number', t.account_number,
                   'bank_id', t.bank_id,
                   'account_holder_name', t.account_holder_name,
                   'version', t.payment_version
                 )
                 else null
               end,
               'pending_request', case when pr.request_id is null then null else jsonb_build_object(
                 'request_id', pr.request_id,
                 'state', 'PENDING',
                 'version', pr.version
               ) end,
               'last_decision', case when ld.state is null then null else jsonb_build_object(
                 'state', ld.state,
                 'decided_at', pg_catalog.to_char(ld.decided_at at time zone 'UTC', 'YYYY-MM-DD')
                   || 'T' || pg_catalog.to_char(ld.decided_at at time zone 'UTC', 'HH24:MI:SS.US')
                   || 'Z'
               ) end,
               'is_project_manager',
                 public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, t.project_id),
               'allowed_actions', jsonb_build_object(
                 'view', true,
                 'view_pii', v_view_pii,
                 'view_payment', v_view_payment,
                 -- P2.5-W05: W04 #53 closed the propose policy, so the directory serves
                 -- the live server authority instead of a placeholder: an effective
                 -- project-manager assignment on this SUBMITTED row. The column
                 -- "is_project_manager" above stays the same predicate.
                 'propose_change',
                   public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, t.project_id),
                 'propose_change_code', case
                   when public.direct_entry_actor_is_assigned_project_manager(
                     p_app_user_id, t.project_id
                   ) then null
                   else 'NOT_PROJECT_MANAGER'
                 end
               )
             ) order by t.first_work_date desc, t.entry_id desc), '[]'::jsonb)
        from trimmed t
        left join lateral (
          select r.request_id, r.version
            from public.direct_entry_change_requests r
            join public.direct_entry_change_request_items i
              on i.request_id = r.request_id
           where i.entry_id = t.entry_id
             and r.state = 'PENDING'
           order by r.created_at desc, r.request_id desc
           limit 1
        ) pr on true
        left join lateral (
          select r.state, r.decided_at
            from public.direct_entry_change_requests r
            join public.direct_entry_change_request_items i
              on i.request_id = r.request_id
           where i.entry_id = t.entry_id
             and r.state in ('APPROVED', 'REJECTED')
           order by r.decided_at desc nulls last, r.request_id desc
           limit 1
        ) ld on true
    ),
    (
      select t.cursor from trimmed t
       order by t.first_work_date asc, t.entry_id asc
       limit 1
    ),
    (
      select jsonb_build_object(
        'total_workers', s.total_workers,
        'project_count', s.project_count,
        'recruiter_count', s.recruiter_count
      ) from summary s
    )
  into v_scanned, v_items, v_next_cursor, v_summary;

  return jsonb_build_object(
    'items', v_items,
    'scope', v_scope,
    'page_size', v_page_size,
    'has_more', v_scanned > v_page_size,
    'next_cursor', case when v_scanned > v_page_size then v_next_cursor else null end,
    'summary', v_summary,
    'authorization_date', public.direct_entry_authorization_date()
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_export_workers(p_auth_subject uuid, p_app_user_id uuid, p_scope text, p_project_id text DEFAULT NULL::text, p_recruiter_id uuid DEFAULT NULL::uuid, p_employment_status text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_audience jsonb;
  v_scope text;
  v_recruiter_ids uuid[];
  v_project_ids text[];
  v_scope_kind text;
  v_reason_id uuid;
  v_filter_hash text;
  v_total integer;
  v_rows jsonb;
begin
  -- 1. Scope: recruited | managed | all. Every other token fails closed before any read.
  if p_scope is null or p_scope not in ('recruited', 'managed', 'all') then
    raise exception 'worker export scope denied' using errcode = '42501';
  end if;

  -- 2. Row authority: reuse the directory audience guard. For `all` this enforces
  --    the effective all-scope grant AND (entry_admin OR change_review); for
  --    recruited/managed it enforces the verified recruiter link / effective PM
  --    assignment. An unauthorized actor raises 42501 here, before any read.
  v_audience := public.direct_entry_worker_directory_audience(
    p_auth_subject, p_app_user_id, p_scope, p_project_id
  );
  v_scope := v_audience->>'scope';
  v_recruiter_ids := case
    when jsonb_array_length(v_audience->'recruiter_ids') = 0 then null
    else array(select jsonb_array_elements_text(v_audience->'recruiter_ids')::uuid)
  end;
  v_project_ids := case
    when jsonb_array_length(v_audience->'project_ids') = 0 then null
    else array(select jsonb_array_elements_text(v_audience->'project_ids'))
  end;

  -- 4. Filters: mirror the directory semantics exactly.
  if p_employment_status is not null
     and p_employment_status not in ('UNCONFIRMED', 'ON', 'OFF') then
    raise exception 'invalid employment status filter' using errcode = '22023';
  end if;

  -- 5. Mandatory reason (reuses the restricted-reasons table).
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- 6. One batch query, deterministic order, at most 10,001 candidates.
  with candidates as (
    select e.entry_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.provider_type,
           e.general_note,
           pr.display_name as project_display,
           rc.display_name as recruiter_display,
           (select lt.display_name from public.direct_entry_labor_types lt
             where lt.labor_type_key = e.labor_type) as labor_type_display,
           st.status as employment_status,
           st.leave_date,
           st.leave_reason_text,
           pay.account_number,
           pay.bank_name,
           pay.account_holder_name
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
      join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join lateral (
        select ev.status, ev.leave_date, ev.leave_reason_text
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
      left join public.direct_entry_payments pay
        on pay.entry_id = e.entry_id
     where e.deleted_at is null and e.voided_at is null
       and s.state = 'SUBMITTED'
       and (
         (v_scope = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
         or (v_scope = 'managed' and e.project_id = any(v_project_ids))
         or (v_scope = 'all')
       )
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_recruiter_id is null or e.recruiter_id = p_recruiter_id)
       and (p_employment_status is null or st.status = p_employment_status)
  ),
  bounded as (
    select * from candidates
     order by first_work_date desc, entry_id desc
     limit 10001
  )
  select coalesce((select count(*)::int from bounded), 0),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'employee_code', b.employee_code,
             'display_name', b.worker_details->>'display_name',
             'date_of_birth', case
               when b.worker_details->'date_of_birth'->>'state' = 'provided'
               then b.worker_details->'date_of_birth'->>'value' else null end,
             'national_id', case
               when b.worker_details->'national_id'->>'state' = 'provided'
               then b.worker_details->'national_id'->>'value' else null end,
             'national_id_issued_at', case
               when b.worker_details->'national_id_issued_at'->>'state' = 'provided'
               then b.worker_details->'national_id_issued_at'->>'value' else null end,
             'phone', case
               when b.worker_details->'phone'->>'state' = 'provided'
               then b.worker_details->'phone'->>'value' else null end,
             'address', case
               when b.worker_details->'address'->>'state' = 'provided'
               then b.worker_details->'address'->>'value' else null end,
             'project_display', b.project_display,
             'first_work_date', pg_catalog.to_char(b.first_work_date, 'YYYY-MM-DD'),
             'labor_type_display', b.labor_type_display,
             'recruiter_display', b.recruiter_display,
             'provider_type', public.recruitment_provider_type_display(b.provider_type),
             'employment_status', b.employment_status,
             'leave_date', case when b.leave_date is null then null
               else pg_catalog.to_char(b.leave_date, 'YYYY-MM-DD') end,
             'leave_reason', b.leave_reason_text,
             'account_number', b.account_number,
             'bank_name', b.bank_name,
             'account_holder_name', b.account_holder_name,
             'payment_note', null,
             'general_note', b.general_note
           ) order by b.first_work_date desc, b.entry_id desc)
           from bounded b
         ), '[]'::jsonb)
    into v_total, v_rows;

  -- 7. Canonical, server-built filter hash (never embeds a raw filter value).
  v_filter_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'scope', p_scope,
    'project_id', p_project_id,
    'recruiter_id', p_recruiter_id,
    'employment_status', p_employment_status
  ));
  -- Raw scope token is never written as scope_kind.
  v_scope_kind := case
    when p_scope = 'recruited' then 'own'
    when p_scope = 'managed' then 'project'
    else 'all'
  end;

  -- 8. Row cap: 10,001 candidates means over the 10,000 limit. Persist the
  --    REJECTED access event, then return the strict non-PII envelope WITHOUT
  --    raising (a raise here would roll the audit back).
  if v_total > 10000 then
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, denial_code, reason_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'worker_export', null,
      'worker-export:' || p_scope || ':' || v_total::text || ':' || v_filter_hash,
      v_scope_kind, 'REJECTED', 'EXPORT_ROW_LIMIT_EXCEEDED', v_reason_id,
      array[]::text[]
    );
    return jsonb_build_object('status', 'too_many_rows', 'limit', 10000);
  end if;

  -- 9. Success: one immutable ALLOW access event (written once the PII rows are
  --    read; a later XLSX build/download failure does not undo it).
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, denial_code, reason_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'worker_export', null,
    'worker-export:' || p_scope || ':' || v_total::text || ':' || v_filter_hash,
    v_scope_kind, 'ALLOW', null, v_reason_id, array[]::text[]
  );

  return jsonb_build_object('status', 'ok', 'rows', v_rows);
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_change_request_required_capabilities(p_request_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select array(
    select distinct required.capability
      from (
        select 'change_review'::text as capability
        union all
        select case
                 when i.target_kind = 'PAYMENT' then null
                 when i.target_kind = 'DOCUMENT' then 'document_view'
                 when i.target_kind = 'ENTRY_FIELD' and (i.proposal ? 'worker_details') then null
               end
          from public.direct_entry_change_request_items i
         where i.request_id = p_request_id
        union all
        select case
                 when i.target_kind = 'DOCUMENT' then 'document_upload'
               end
          from public.direct_entry_change_request_items i
         where i.request_id = p_request_id
      ) required
     where required.capability is not null
     order by required.capability
  );
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_read_change_request(p_auth_subject uuid, p_app_user_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_request public.direct_entry_change_requests%rowtype;
  v_audience text;
  v_pii_view boolean;
  v_payment_view boolean;
  v_document_view boolean;
  v_request_reason text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if p_request_id is null then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  v_audience := public.direct_entry_change_request_audience(
    p_app_user_id, v_request.proposer_user_id, v_request.request_id
  );
  if v_audience = 'NONE'
     and v_request.state in ('APPROVED', 'REJECTED')
     and public.direct_entry_has_scope(p_app_user_id, 'all')
     and public.direct_entry_has_capability(p_app_user_id, 'entry_admin') then
    v_audience := 'AUDITOR';
  end if;
  if v_audience = 'NONE' then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  v_pii_view := true;
  v_payment_view := true;
  v_document_view := public.direct_entry_has_capability(p_app_user_id, 'document_view');
  if v_audience in ('REVIEWER', 'AUDITOR') then
    select rr.reason_text into v_request_reason
      from public.direct_entry_restricted_reasons rr
     where rr.reason_id = v_request.reason_id;
  end if;
  return jsonb_build_object(
    'request_id', v_request.request_id,
    'state', v_request.state,
    'version', v_request.version,
    'created_at', pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
    'request_reason', v_request_reason,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'entry_id', i.entry_id,
               'target_kind', i.target_kind,
               'expected_version', i.expected_version,
               'proposal', case
                 when i.target_kind = 'WORK_STATUS' and v_audience in ('REVIEWER', 'AUDITOR')
                      and i.proposal ? 'leave_reason'
                   then public.direct_entry_change_request_proposal_projection(
                     i.target_kind, i.proposal, v_pii_view, v_payment_view, v_document_view
                   ) || jsonb_build_object('leave_reason', i.proposal->'leave_reason')
                 else public.direct_entry_change_request_proposal_projection(
                   i.target_kind, i.proposal, v_pii_view, v_payment_view, v_document_view
                 )
               end,
               'labor_type_display', case
                 when i.target_kind = 'ENTRY_FIELD'
                      and nullif(i.proposal->>'labor_type', '') is not null
                   then (select lt.display_name from public.direct_entry_labor_types lt
                          where lt.labor_type_key = i.proposal->>'labor_type')
                 else null end
             ) order by i.entry_id), '[]'::jsonb)
        from public.direct_entry_change_request_items i
       where i.request_id = v_request.request_id
    ),
    'can_withdraw', (v_audience = 'PROPOSER' and v_request.state = 'PENDING'),
    'can_decide', (v_audience = 'REVIEWER' and v_request.state = 'PENDING')
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_reviewer_bundle_capabilities()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select array['change_review']::text[];
$function$;

-- Current-state mutation and consumer updates.
CREATE OR REPLACE FUNCTION public.direct_entry_account_operation_create_personnel(p_auth_subject uuid, p_actor_app_user_id uuid, p_account_ref uuid, p_expected_account_version integer, p_personnel_code text, p_personnel_position text, p_valid_from date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_action text := 'personnel_created';
  v_code text := lower(btrim(p_personnel_code));
  v_login_id text;
  v_position text := p_personnel_position;
  v_account public.direct_entry_app_users;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_recruiter public.recruiters;
  v_membership_id uuid;
  v_link_id uuid;
  v_personnel_revision_id uuid;
  v_app_user_revision_id uuid;
  v_result jsonb;
  v_capability text;
  v_today date := public.direct_entry_authorization_date();
  v_next_capability_start date;
  v_next_scope_start date;
begin
  if p_account_ref is null or p_expected_account_version is null or p_expected_account_version < 1 then
    raise exception 'account reference or version invalid' using errcode = '22023';
  end if;
  if v_code is null or not public.direct_entry_is_canonical_login_id(v_code) then
    raise exception 'personnel code must be the account login ID' using errcode = '22023';
  end if;
  if v_position is null or v_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  if p_valid_from is null or p_valid_from > v_today then
    raise exception 'provider valid from is invalid' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'account_ref', p_account_ref, 'expected_account_version', p_expected_account_version,
    'personnel_code', v_code, 'personnel_position', v_position,
    'valid_from', p_valid_from, 'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then return v_prior; end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref
   for update;
  if not found then raise exception 'account not found' using errcode = 'P0002'; end if;
  if not v_account.enabled then raise exception 'account is not enabled' using errcode = '23514'; end if;
  select lower(nullif(split_part(u.email, '@', 1), '')) into v_login_id
    from auth.users u where u.id = v_account.auth_subject;
  if v_login_id is null or not public.direct_entry_is_canonical_login_id(v_login_id)
     or v_code <> v_login_id then
    raise exception 'personnel code does not match account login ID' using errcode = '22023';
  end if;
  if lower(btrim(v_account.display_name)) = v_login_id then
    raise exception 'account real name must be updated before personnel creation' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref and l.verified
       and l.is_current
  ) then raise exception 'account already has an effective recruiter link' using errcode = '23514'; end if;
  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;
  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then raise exception 'personnel code already exists' using errcode = '23505'; end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);
  insert into public.recruiters (display_name, personnel_code, personnel_position, active, version)
  values (v_account.display_name, v_code, v_position, true, 1)
  returning * into v_recruiter;
  insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, vendor_id, is_current)
  values (v_recruiter.recruiter_id, 'hrp', p_valid_from, null, true)
  returning membership_id into v_membership_id;
  insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
  values (p_account_ref, v_recruiter.recruiter_id, true, p_valid_from, true)
  returning link_id into v_link_id;

  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view'
  ]::text[]
  loop
    if not exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref and g.capability = v_capability
         and g.is_current
    ) then
      select min(g.valid_from) into v_next_capability_start
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref and g.capability = v_capability
         and g.valid_from > v_today;
      insert into public.direct_entry_capability_grants
        (app_user_id, capability, valid_from, valid_to, is_current)
      values (p_account_ref, v_capability, v_today, v_next_capability_start, true);
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if not exists (
    select 1 from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref and g.scope_kind = 'own'
       and g.is_current
  ) then
    select min(g.valid_from) into v_next_scope_start
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref and g.scope_kind = 'own'
       and g.valid_from > v_today;
    insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current)
    values (p_account_ref, 'own', v_today, v_next_scope_start, true);
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  update public.direct_entry_app_users set version = version + 1, updated_at = now()
   where app_user_id = p_account_ref returning version into v_account.version;
  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref, v_account.version, p_actor_app_user_id, 'link_create',
    jsonb_build_object('recruiter_id', null), jsonb_build_object('recruiter_id', v_recruiter.recruiter_id), v_reason_id
  ) returning revision_id into v_app_user_revision_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'link_create', 'entry_admin', p_account_ref::text,
    'all', 'APPLIED', v_reason_id, array['recruiter_link'], v_app_user_revision_id
  );
  v_personnel_revision_id := public.direct_entry_write_personnel_revision(
    v_recruiter.recruiter_id, v_recruiter.version, p_actor_app_user_id, v_reason_id,
    null, public.direct_entry_personnel_snapshot(v_recruiter)
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, personnel_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin', v_recruiter.recruiter_id::text,
    'all', 'APPLIED', v_reason_id, array['display_name', 'personnel_code', 'personnel_position', 'active'],
    v_personnel_revision_id
  );
  v_result := jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id, 'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code, 'personnel_position', v_recruiter.personnel_position,
    'version', v_recruiter.version, 'link_id', v_link_id, 'membership_id', v_membership_id,
    'app_user_version', v_account.version, 'app_user_revision_id', v_app_user_revision_id,
    'personnel_revision_id', v_personnel_revision_id
  );
  perform public.direct_entry_idempotency_finish(p_actor_app_user_id, v_action, p_idempotency_key, v_result);
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_account_operation_finalize_create(p_auth_subject uuid, p_actor_app_user_id uuid, p_intent_id uuid, p_intent_token uuid, p_created_auth_subject uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_action text := 'account_created';
  v_intent public.direct_entry_account_operation_intents;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_app_user public.direct_entry_app_users;
  v_revision_id uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_created_auth_subject is null or p_intent_id is null or p_intent_token is null then
    raise exception 'intent, token and auth subject required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'intent_id', p_intent_id, 'intent_token', p_intent_token,
    'auth_subject', p_created_auth_subject
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_intent := public.direct_entry_lock_account_operation(p_intent_id);
  if v_intent.kind <> 'CREATE_ACCOUNT' then
    raise exception 'account operation kind mismatch' using errcode = '22023';
  end if;

  -- Terminal first: APPLIED/FAILED/EXPIRED/BLOCKED/CONFLICT are immutable.
  if v_intent.state in ('APPLIED', 'FAILED', 'EXPIRED', 'BLOCKED', 'CONFLICT') then
    v_prior := jsonb_build_object(
      'intent_id', v_intent.intent_id,
      'intent_state', v_intent.state,
      'account_ref', v_intent.account_ref
    );
    perform public.direct_entry_idempotency_finish(
      p_actor_app_user_id, v_action, p_idempotency_key, v_prior
    );
    return v_prior;
  end if;
  if v_intent.state not in ('IN_FLIGHT', 'INDETERMINATE') then
    raise exception 'account operation is not claimable' using errcode = '22023';
  end if;

  if v_intent.intent_token <> p_intent_token then
    update public.direct_entry_account_operation_intents
       set state = 'BLOCKED', resolved_at = now(), updated_at = now()
     where intent_id = p_intent_id;
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, denial_code, reason_id
    ) values (
      p_auth_subject, p_actor_app_user_id, 'account_operation_finish', 'entry_admin',
      p_intent_id::text, 'all', 'REJECTED', 'provenance_mismatch', v_intent.reason_id
    );
    v_prior := jsonb_build_object(
      'intent_id', p_intent_id, 'intent_state', 'BLOCKED', 'account_ref', null
    );
    perform public.direct_entry_idempotency_finish(
      p_actor_app_user_id, v_action, p_idempotency_key, v_prior
    );
    return v_prior;
  end if;

  v_reason_id := v_intent.reason_id;
  insert into public.direct_entry_app_users (auth_subject, enabled, display_name)
  values (p_created_auth_subject, true, v_intent.display_name)
  returning * into v_app_user;
  -- Retired PII/payment capabilities are not provisioned for new accounts.

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    v_app_user.app_user_id, v_app_user.version, p_actor_app_user_id, v_action,
    null, jsonb_build_object('display_name', v_app_user.display_name, 'enabled', true), v_reason_id
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    v_app_user.app_user_id::text, 'all', 'APPLIED', v_reason_id,
    array['auth_subject', 'enabled', 'display_name'], v_revision_id
  );

  update public.direct_entry_account_operation_intents
     set state = 'APPLIED', resolved_at = now(), updated_at = now(),
         auth_subject = p_created_auth_subject,
         account_ref = v_app_user.app_user_id
   where intent_id = p_intent_id;

  v_prior := jsonb_build_object(
    'app_user_id', v_app_user.app_user_id,
    'auth_subject', v_app_user.auth_subject,
    'display_name', v_app_user.display_name,
    'version', v_app_user.version,
    'revision_id', v_revision_id,
    'intent_id', p_intent_id,
    'intent_state', 'APPLIED'
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_prior
  );
  return v_prior;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_account_operation_list_eligible_accounts(p_auth_subject uuid, p_actor_app_user_id uuid, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_total integer;
  v_rows jsonb;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'account list pagination invalid' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;
  select count(*)::int into v_total
    from public.direct_entry_app_users u join auth.users au on au.id = u.auth_subject
   where u.enabled
     and public.direct_entry_is_canonical_login_id(lower(split_part(au.email, '@', 1)))
     and not exists (
       select 1 from public.direct_entry_app_user_recruiter_links l
        where l.app_user_id = u.app_user_id and l.verified
          and l.is_current
     );
  select coalesce(jsonb_agg(a.row_json order by a.display_name, a.login_id, a.app_user_id), '[]'::jsonb)
    into v_rows from (
      select jsonb_build_object('app_user_id', u.app_user_id, 'display_name', u.display_name,
               'login_id', lower(split_part(au.email, '@', 1))) as row_json,
             u.display_name, lower(split_part(au.email, '@', 1)) as login_id, u.app_user_id
        from public.direct_entry_app_users u join auth.users au on au.id = u.auth_subject
       where u.enabled
         and public.direct_entry_is_canonical_login_id(lower(split_part(au.email, '@', 1)))
         and not exists (
           select 1 from public.direct_entry_app_user_recruiter_links l
            where l.app_user_id = u.app_user_id and l.verified
              and l.is_current
         )
       order by u.display_name, lower(split_part(au.email, '@', 1)), u.app_user_id
       limit v_page_size + 1 offset v_offset
    ) a;
  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb) into v_rows
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord) where t.ord <= v_page_size;
  end if;
  return jsonb_build_object('page', v_page, 'page_size', v_page_size, 'total', v_total,
    'has_more', v_has_more, 'accounts', v_rows);
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_account_operation_update_display_name(p_auth_subject uuid, p_actor_app_user_id uuid, p_target_app_user_id uuid, p_display_name text, p_expected_app_user_version integer, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_action text := 'display_name_update';
  v_display_name text := btrim(p_display_name);
  v_locked_id uuid;
  v_target public.direct_entry_app_users;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_linked_recruiter_id uuid;
  v_recruiter_before public.recruiters;
  v_recruiter_after public.recruiters;
  v_recruiter_version integer;
  v_recruiter_revision_id uuid;
  v_result jsonb;
begin
  if p_display_name is null or length(v_display_name) not between 1 and 256 then
    raise exception 'display name invalid' using errcode = '22023';
  end if;
  if p_expected_app_user_version is null or p_expected_app_user_version < 1 then
    raise exception 'expected app user version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Authority first: an unauthorized actor is denied before any target lookup/lock.
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'target_app_user_id', p_target_app_user_id, 'display_name', v_display_name,
    'expected_app_user_version', p_expected_app_user_version, 'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  for v_locked_id in
    select u.app_user_id from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id for update
  loop null; end loop;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;

  -- Resolve the effective verified link by app_user_id only; never by name/email.
  select l.recruiter_id into v_linked_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_target_app_user_id
     and l.verified
     and l.is_current
   order by l.valid_from desc, l.link_id desc
   limit 1;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  v_before := jsonb_build_object('display_name', v_target.display_name);
  update public.direct_entry_app_users
     set display_name = v_display_name, version = version + 1, updated_at = now()
   where app_user_id = p_target_app_user_id
  returning * into v_target;
  v_after := jsonb_build_object('display_name', v_target.display_name);

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_target_app_user_id, v_target.version, p_actor_app_user_id, v_action, v_before, v_after, v_reason_id
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    p_target_app_user_id::text, 'all', 'APPLIED', v_reason_id,
    array['display_name'], v_revision_id
  );

  -- Sync the effective linked recruiter display_name in the same transaction.
  v_recruiter_version := null;
  v_recruiter_revision_id := null;
  if v_linked_recruiter_id is not null then
    select r.* into v_recruiter_before
      from public.recruiters r
     where r.recruiter_id = v_linked_recruiter_id
     for update;
    if found then
      update public.recruiters
         set display_name = v_display_name
       where recruiter_id = v_linked_recruiter_id
      returning * into v_recruiter_after;
      select b.personnel_version, b.revision_id
        into v_recruiter_version, v_recruiter_revision_id
        from public.direct_entry_bump_personnel_version(
          v_linked_recruiter_id, p_actor_app_user_id, v_reason_id,
          public.direct_entry_personnel_snapshot(v_recruiter_before),
          public.direct_entry_personnel_snapshot(v_recruiter_after)
        ) b;
    end if;
  end if;

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'recruiter_id', v_linked_recruiter_id,
    'recruiter_version', v_recruiter_version,
    'recruiter_revision_id', v_recruiter_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_app_user_projection(p_app_user direct_entry_app_users)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_display_name text;
  v_login_id text;
begin
  select r.display_name into v_display_name
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.app_user_id = p_app_user.app_user_id
     and l.verified
     and l.is_current
   order by l.valid_from desc, l.link_id desc
   limit 1;

  select lower(nullif(split_part(u.email, '@', 1), '')) into v_login_id
    from auth.users u
   where u.id = p_app_user.auth_subject;

  return jsonb_build_object(
    'account_ref', p_app_user.app_user_id,
    'display_name', coalesce(v_display_name, nullif(p_app_user.display_name, v_login_id)),
    'login_id', v_login_id,
    'enabled', p_app_user.enabled,
    'version', p_app_user.version
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_apply_catalog_bootstrap(p_auth_subject uuid, p_app_user_id uuid, p_expected_source_fingerprint text, p_idempotency_key text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_projection jsonb;
  v_capability_count integer;
  v_existing public.direct_entry_catalog_bootstrap_runs%rowtype;
  v_run_id uuid;
  v_reason_id uuid;
  v_team_id uuid;
  v_item jsonb;
  v_period jsonb;
  v_recruiter_id uuid;
  v_project_count integer;
  v_recruiter_count integer;
  v_provider_count integer;
  v_snapshot_date date;
begin
  if p_auth_subject is null
     or p_app_user_id is null
     or p_expected_source_fingerprint is null
     or p_expected_source_fingerprint !~ '^[a-f0-9]{64}$'
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$'
     or p_reason is null
     or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'invalid catalog bootstrap request' using errcode = '22023';
  end if;
  perform set_config('mini_bi.catalog_bootstrap_app_user_id', p_app_user_id::text, true);
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  select count(distinct g.capability)::integer into v_capability_count
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_app_user_id
     and g.capability in ('entry_admin', 'recruiter_master_manage', 'team_master_manage')
     and g.is_current;
  if v_capability_count <> 3 then
    raise exception 'catalog bootstrap capability denied' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('direct_entry_catalog_bootstrap', 0));
  v_projection := public.direct_entry_catalog_bootstrap_projection();
  if v_projection->>'source_fingerprint' <> p_expected_source_fingerprint then
    raise exception 'catalog bootstrap source conflict' using errcode = '40001';
  end if;
  if (v_projection->>'invalid_count')::integer <> 0
     or (v_projection->>'ambiguous_count')::integer <> 0
     or (v_projection->>'project_count')::integer = 0
     or (v_projection->>'recruiter_count')::integer = 0
     or (v_projection->>'provider_period_count')::integer = 0 then
    raise exception 'catalog bootstrap source is not valid' using errcode = '23514';
  end if;

  select * into v_existing
    from public.direct_entry_catalog_bootstrap_runs
   where app_user_id = p_app_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.source_fingerprint <> p_expected_source_fingerprint then
      raise exception 'catalog bootstrap replay conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status', 'ALREADY_APPLIED',
      'source_fingerprint', v_existing.source_fingerprint,
      'project_count', v_existing.project_count,
      'recruiter_count', v_existing.recruiter_count,
      'team_count', v_existing.team_count,
      'provider_membership_count', v_existing.provider_membership_count,
      'replayed', true
    );
  end if;

  if exists (select 1 from public.direct_entry_projects)
     or exists (select 1 from public.recruiters)
     or exists (select 1 from public.teams)
     or exists (select 1 from public.recruiter_aliases)
     or exists (select 1 from public.recruiter_provider_memberships)
     or exists (select 1 from public.recruiter_team_memberships)
     or exists (select 1 from public.direct_entry_banks) then
    raise exception 'catalog bootstrap target is not empty' using errcode = '23505';
  end if;

  v_run_id := gen_random_uuid();
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  -- This audited, one-time import initializes explicit state from a single
  -- snapshot. Future/expired history remains false and is never auto-promoted.
  v_snapshot_date := public.direct_entry_authorization_date();

  insert into public.direct_entry_projects(project_id, display_name)
  select x.project_id, x.display_name
    from jsonb_to_recordset(v_projection->'projects') as x(project_id text, display_name text);
  v_project_count := (v_projection->>'project_count')::integer;

  insert into public.teams(code, display_name)
  values ('unassigned', 'Chưa phân nhóm')
  returning team_id into v_team_id;

  for v_item in select value from jsonb_array_elements(v_projection->'recruiters') loop
    insert into public.recruiters(display_name)
    values (v_item->>'display_name')
    returning recruiter_id into v_recruiter_id;

    insert into public.recruiter_aliases(recruiter_id, reporting_key, valid_from)
    values (v_recruiter_id, v_item->>'reporting_key', (v_item->>'alias_from')::date);

    insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from, is_current)
    values (v_recruiter_id, v_team_id, (v_item->>'team_from')::date,
      (v_item->>'team_from')::date <= v_snapshot_date);

    for v_period in select value from jsonb_array_elements(v_item->'periods') loop
      insert into public.recruiter_provider_memberships(
        recruiter_id, provider_type, valid_from, valid_to, is_current
      ) values (
        v_recruiter_id, v_period->>'provider_type',
        (v_period->>'valid_from')::date, (v_period->>'valid_to')::date,
        (v_period->>'valid_from')::date <= v_snapshot_date
          and (v_period->>'valid_to' is null or v_snapshot_date < (v_period->>'valid_to')::date)
      );
    end loop;
  end loop;

  v_recruiter_count := (v_projection->>'recruiter_count')::integer;
  v_provider_count := (v_projection->>'provider_period_count')::integer;

  insert into public.direct_entry_catalog_bootstrap_runs(
    run_id, app_user_id, source_fingerprint, project_count, recruiter_count,
    team_count, provider_membership_count, status, idempotency_key, reason_id
  ) values (
    v_run_id, p_app_user_id, p_expected_source_fingerprint, v_project_count,
    v_recruiter_count, 1, v_provider_count, 'APPLIED', p_idempotency_key, v_reason_id
  );

  insert into public.direct_entry_audit_events(
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'catalog_bootstrap', 'entry_admin',
    'catalog-bootstrap:' || v_run_id::text, 'all', 'APPLIED', v_reason_id,
    array[
      'projects', 'recruiters', 'recruiter_aliases', 'teams',
      'recruiter_team_memberships', 'recruiter_provider_memberships'
    ]
  );

  return jsonb_build_object(
    'status', 'APPLIED',
    'source_fingerprint', p_expected_source_fingerprint,
    'project_count', v_project_count,
    'recruiter_count', v_recruiter_count,
    'team_count', 1,
    'provider_membership_count', v_provider_count,
    'replayed', false
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_apply_change_item(p_auth_subject uuid, p_app_user_id uuid, p_request_id uuid, p_entry direct_entries, p_target_kind text, p_proposal jsonb, p_reason_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid := p_reason_id;
  v_revision_id uuid;
  v_scope text;
  v_review_capability text := 'change_review';
  v_team_review boolean;
  v_team_id uuid;
  v_provider text;
  v_date date;
  v_recruiter_id uuid;
  v_count integer;
  v_document_id uuid;
  v_status_version integer;
  v_latest public.direct_entry_employment_status_events%rowtype;
begin
  -- entry_void_apply_v1: keep the void-only reviewer grants separate from other changes.
  v_team_review := public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) = p_entry.team_id;
  if p_target_kind = 'ENTRY_VOID' then
    if v_team_review then
      perform public.direct_entry_assert_actor(p_auth_subject,p_app_user_id,'team_manager_assign');
      v_scope := 'team';
      v_review_capability := 'team_manager_assign';
    elsif public.direct_entry_has_scope(p_app_user_id,'all')
       and public.direct_entry_has_capability(p_app_user_id,'entry_admin') then
      v_scope := 'all';
      v_review_capability := 'entry_admin';
    elsif public.direct_entry_has_scope(p_app_user_id,'all')
       and public.direct_entry_has_capability(p_app_user_id,'entry_privileged_edit') then
      v_scope := 'all';
      v_review_capability := 'entry_privileged_edit';
    elsif public.direct_entry_has_scope(p_app_user_id,'all')
       and public.direct_entry_has_capability(p_app_user_id,'change_review') then
      v_scope := 'all';
      v_review_capability := 'change_review';
    else
      raise exception 'entry void review scope/capability denied' using errcode='42501';
    end if;
  elsif v_team_review then
    v_scope := 'team';
    v_review_capability := 'team_manager_assign';
  else
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review', p_entry.created_by_user_id,
      p_entry.team_id, p_entry.first_work_date
    );
  end if;
  -- P2.5-W05-R1 matrix: review needs the capability to SEE the data it decides, never
  -- the apply-side token. The all-scope review lock is asserted by the decision path
  -- (#55) before this helper runs, and DRAFT direct writes keep their own capabilities.
  if p_target_kind = 'DOCUMENT' then
    if not (public.direct_entry_has_capability(p_app_user_id, 'document_view')
            and public.direct_entry_has_capability(p_app_user_id, 'document_upload')) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry.entry_id);
  if p_target_kind = 'ENTRY_VOID' then
    if p_proposal is distinct from '{}'::jsonb
       or p_entry.voided_at is not null
       or (select count(*) from public.direct_entry_change_request_items i
            where i.request_id=p_request_id and i.target_kind='ENTRY_VOID') <> 1
       or not exists (
         select 1 from public.direct_entry_submissions s
          where s.submission_id=p_entry.submission_id and s.state='SUBMITTED'
       ) then
      raise exception 'entry void target is not active' using errcode='40001';
    end if;
    update public.direct_entries set
      voided_at=now(), voided_by_user_id=p_app_user_id, void_reason_id=v_reason_id,
      version=version+1
     where entry_id=p_entry.entry_id and voided_at is null;
    if not found then
      raise exception 'entry already voided' using errcode='40001';
    end if;
  elsif p_target_kind = 'ENTRY_FIELD' then
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb
       or (p_proposal ? 'worker_details'
           and public.direct_entry_w04_worker_details_allowed(p_proposal->'worker_details') is not true) then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;
    v_recruiter_id := case when p_proposal ? 'recruiter_id'
      then (p_proposal->>'recruiter_id')::uuid else p_entry.recruiter_id end;
    v_date := case when p_proposal ? 'first_work_date'
      then (p_proposal->>'first_work_date')::date else p_entry.first_work_date end;
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id and m.is_current;
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    if v_provider = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id and m.is_current;
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;
    if v_team_review then
      if v_team_id is distinct from p_entry.team_id then
        raise exception 'entry scope/capability denied' using errcode = '42501';
      end if;
    else
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        p_entry.created_by_user_id, v_team_id, v_date, v_scope
      );
    end if;
    update public.direct_entries set
      project_id = case when p_proposal ? 'project_id' then p_proposal->>'project_id' else project_id end,
      first_work_date = v_date,
      employee_code = case when p_proposal ? 'employee_code' then p_proposal->>'employee_code' else employee_code end,
      worker_details = case when p_proposal ? 'worker_details' then p_proposal->'worker_details' else worker_details end,
      recruiter_id = v_recruiter_id, team_id = v_team_id, provider_type = v_provider,
      labor_type = case when p_proposal ? 'labor_type' then p_proposal->>'labor_type' else labor_type end,
      version = version + 1
     where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'PAYMENT' then
    if (p_proposal - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb then
      raise exception 'unsupported payment proposal field' using errcode = '22023';
    end if;
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, account_holder_name, version
    ) values (
      p_entry.entry_id, p_proposal->>'state', p_proposal->>'account_number',
      p_proposal->>'bank_id', p_proposal->>'account_holder_name', 1
    ) on conflict (entry_id) do update set
      state = excluded.state, account_number = excluded.account_number,
      bank_id = excluded.bank_id, account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1, updated_at = now();
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'WORK_STATUS' then
    if (p_proposal - array['status','effective_date','leave_reason']) <> '{}'::jsonb then
      raise exception 'unsupported status proposal field' using errcode = '22023';
    end if;
    select * into v_latest from public.direct_entry_employment_status_events
     where entry_id = p_entry.entry_id order by version desc limit 1 for update;
    v_status_version := coalesce(v_latest.version, 0) + 1;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, leave_date, leave_reason_text,
      version, actor_user_id, reason_id, supersedes_event_id
    ) values (
      p_entry.entry_id, p_proposal->>'status', (p_proposal->>'effective_date')::date,
      case when p_proposal->>'status' = 'OFF' then (p_proposal->>'effective_date')::date end,
      case when p_proposal->>'status' = 'OFF' then p_proposal->>'leave_reason' end,
      v_status_version, p_app_user_id, v_reason_id, null
    );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'DOCUMENT' then
    if (p_proposal - array['document_type','idempotency_key','checksum_sha256','size_bytes','mime_type']) <> '{}'::jsonb then
      raise exception 'unsupported document proposal field' using errcode = '22023';
    end if;
    select document_id into v_document_id
      from public.direct_entry_create_document_record(
        p_entry.candidate_id, p_proposal->>'document_type',
        p_proposal->>'idempotency_key', p_proposal->>'checksum_sha256',
        (p_proposal->>'size_bytes')::bigint, p_proposal->>'mime_type', p_app_user_id
      );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  else
    raise exception 'unsupported change target' using errcode = '22023';
  end if;
  v_after := public.direct_entry_entry_snapshot(p_entry.entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry.entry_id, p_app_user_id, v_reason_id, v_before, v_after, p_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_approve', v_review_capability,
    p_entry.entry_id::text, v_scope,
    case when v_scope = 'team' then
      case when p_target_kind = 'ENTRY_FIELD' then v_team_id else p_entry.team_id end
      else null end,
    'APPLIED', v_reason_id, v_revision_id, array[p_target_kind]
  );
  return v_revision_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_apply_team_leader_mutation(p_auth_subject uuid, p_app_user_id uuid, p_team_id uuid, p_target_leader_app_user_id uuid, p_effective_date date, p_expected_version integer, p_reason text, p_idempotency_key text, p_operation text, p_authority text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_team public.teams;
  v_old public.direct_entry_team_leader_assignments%rowtype;
  v_new public.direct_entry_team_leader_assignments%rowtype;
  v_old_count integer := 0;
  v_candidate_user_enabled boolean;
  v_link_count integer;
  v_verified_link_count integer;
  v_recruiter_id uuid;
  v_recruiter_active boolean;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_scope_count integer;
  v_capability_count integer;
  v_scope_grant_id uuid;
  v_capability_grant_id uuid;
  v_idempotency_action text;
  v_prior_hash text;
  v_change text;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_team_version integer;
  v_before jsonb;
  v_after jsonb;
  v_changed_fields text[] := array[
    'team_leader_assignment', 'team_scope', 'team_manager_assign'
  ];
  v_actor_ids uuid[];
  v_lock_key text;
  v_scope_grant_count integer;
  v_capability_grant_count integer;
  v_post_team_assignment_count integer;
  v_post_target_team_assignment_count integer;
  v_post_target_assignment_count integer;
  v_post_scope_count integer;
  v_post_target_team_scope_count integer;
  v_post_capability_count integer;
  v_post_coextensive_scope_count integer;
  v_post_coextensive_capability_count integer;
  v_post_outgoing_assignment_count integer;
  v_post_outgoing_scope_count integer;
  v_post_outgoing_capability_count integer;
  v_post_closed_assignment_count integer;
  v_post_closed_scope_count integer;
  v_post_closed_capability_count integer;
begin
  if p_operation not in ('designate', 'revoke') then
    raise exception 'invalid team leader operation' using errcode = '22023';
  end if;
  if (p_operation = 'designate') <> (p_target_leader_app_user_id is not null) then
    raise exception 'target leader does not match operation' using errcode = '22023';
  end if;
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_effective_date is null then raise exception 'effective date required' using errcode = '22023'; end if;
  if p_effective_date > public.direct_entry_authorization_date() then raise exception 'future team leader assignments require explicit activation' using errcode = '22023'; end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected team version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if v_team.code = '__system_vendor__' then
    raise exception 'reserved team cannot have a leader' using errcode = '23514';
  end if;

  v_idempotency_action := case p_operation
    when 'designate' then 'team_leader_designate'
    else 'team_leader_revoke'
  end;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'team_id', p_team_id,
    'target_leader_app_user_id', p_target_leader_app_user_id,
    'effective_date', p_effective_date,
    'expected_version', p_expected_version,
    'reason', p_reason
  ));
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = v_idempotency_action
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_request_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is null then
      raise exception 'completed idempotency result is missing' using errcode = '55000';
    end if;
    return v_prior;
  end if;

  -- The team row is already locked; compare its OCC token before locking any
  -- leader account/grant rows. The read-only idempotency lookup above preserves
  -- exact replay semantics for a request whose original version is now stale.
  if v_team.version <> p_expected_version then
    raise exception 'team version conflict' using errcode = '40001';
  end if;
  if p_operation = 'designate' and not v_team.active then
    raise exception 'target team is inactive' using errcode = '23514';
  end if;

  select count(*)::int into v_old_count from public.direct_entry_team_leader_assignments a where a.team_id = p_team_id and a.is_current;
  if v_old_count > 1 then
    raise exception 'team leader assignment is ambiguous' using errcode = '42501';
  end if;
  if v_old_count = 1 then
    select a.* into v_old
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id and a.is_current order by a.assignment_id
     limit 1;
    if v_old.valid_from > p_effective_date then
      raise exception 'future team leader must be cancelled at its start date'
        using errcode = '23514';
    end if;
  elsif p_operation = 'revoke' then
    raise exception 'no leader assignment to revoke' using errcode = '22023';
  end if;
  if p_operation = 'designate'
     and v_old_count = 1
     and v_old.leader_app_user_id = p_target_leader_app_user_id then
    raise exception 'leader is already assigned to this team' using errcode = '23514';
  end if;

  v_actor_ids := array_remove(array[
    case when v_old_count = 1 then v_old.leader_app_user_id end,
    p_target_leader_app_user_id
  ]::uuid[], null);

  -- App-user and grant row locks follow a stable UUID order after the team OCC root.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_actor_ids)
   order by u.app_user_id
   for update;
  if p_operation = 'designate' then
    select u.enabled into v_candidate_user_enabled
      from public.direct_entry_app_users u
     where u.app_user_id = p_target_leader_app_user_id;
    if not found or not coalesce(v_candidate_user_enabled, false) then
      raise exception 'target leader account is not enabled' using errcode = '42501';
    end if;
  end if;
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = any(v_actor_ids)
     and s.scope_kind = 'team'
   order by s.app_user_id, s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = any(v_actor_ids)
     and g.capability = 'team_manager_assign'
   order by g.app_user_id, g.grant_id
   for update;

  -- Acquire the same interval keys used by the canonical link/scope/capability
  -- overlap trigger, in stable order, before identity validation or interval writes.
  for v_lock_key in
    select distinct key
      from unnest(array[
        case when v_old_count = 1 then
          'capability:' || v_old.leader_app_user_id::text || ':team_manager_assign' end,
        case when v_old_count = 1 then
          'scope:' || v_old.leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when p_operation = 'designate' then
          'capability:' || p_target_leader_app_user_id::text || ':team_manager_assign' end,
        case when p_operation = 'designate' then
          'scope:' || p_target_leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when p_operation = 'designate' then
          'recruiter-link:' || p_target_leader_app_user_id::text end
      ]) as keys(key)
     where key is not null
     order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  if p_operation = 'designate' then
    perform l.link_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_target_leader_app_user_id
     order by l.link_id
     for update;
    select count(*)::int,
           count(*) filter (where l.verified)::int,
           (array_agg(l.recruiter_id order by l.link_id))[1]
      into v_link_count, v_verified_link_count, v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_target_leader_app_user_id
       and l.is_current;
    if v_link_count <> 1 or v_verified_link_count <> 1 or v_recruiter_id is null then
      raise exception 'target leader requires exactly one verified recruiter link'
        using errcode = '42501';
    end if;

    select r.active into v_recruiter_active
      from public.recruiters r
     where r.recruiter_id = v_recruiter_id
     for update;
    if not found or not coalesce(v_recruiter_active, false) then
      raise exception 'target recruiter is not active' using errcode = '42501';
    end if;

    for v_lock_key in
      select key
        from unnest(array[
          'provider:' || v_recruiter_id::text,
          'team-membership:' || v_recruiter_id::text
        ]) as keys(key)
       order by key
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
     order by m.membership_id
     for update;
    select count(*)::int,
           count(*) filter (
             where m.provider_type = 'hrp' and m.vendor_id is null
           )::int
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.is_current;
    if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
      raise exception 'target recruiter requires exactly one effective HRP provider'
        using errcode = '42501';
    end if;

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
     order by m.membership_id
     for update;
    select count(*)::int,
           count(*) filter (where m.team_id = p_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.is_current;
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'target recruiter must have exactly one effective membership in the target team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_leader_app_user_id and a.team_id <> p_team_id and a.is_current
    ) then
      raise exception 'target leader is assigned or scheduled for another team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = p_target_leader_app_user_id
         and s.scope_kind = 'team'
         and s.is_current
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_target_leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.is_current
    ) then
      raise exception 'target leader has pre-existing leader authority intervals'
        using errcode = '42501';
    end if;
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_old_count = 1 then
    perform a.assignment_id
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
     for update;

    select count(*)::int, (array_agg(s.grant_id order by s.grant_id))[1]
      into v_scope_count, v_scope_grant_id
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_old.leader_app_user_id and s.scope_kind = 'team' and s.team_id = p_team_id and s.is_current;
    select count(*)::int, (array_agg(g.grant_id order by g.grant_id))[1]
      into v_capability_count, v_capability_grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id and g.capability = 'team_manager_assign' and g.is_current;
    if v_scope_count <> 1 or v_capability_count <> 1 then
      raise exception 'leader authority interval state conflict'
        using errcode = '23514';
    end if;
    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team'
         and s.is_current
         and s.grant_id <> v_scope_grant_id
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.is_current
         and g.grant_id <> v_capability_grant_id
    ) then
      raise exception 'outgoing leader has ambiguous future authority intervals'
        using errcode = '42501';
    end if;
  end if;

  if v_old_count = 1 then
    if p_effective_date = v_old.valid_from then
      perform set_config('direct_entry.team_leader_marker', 'on', true);
    end if;
    update public.direct_entry_team_leader_assignments set valid_to = p_effective_date, is_current = false
     where assignment_id = v_old.assignment_id;
    update public.direct_entry_scope_grants set valid_to = p_effective_date, is_current = false
     where grant_id = v_scope_grant_id;
    update public.direct_entry_capability_grants set valid_to = p_effective_date, is_current = false
     where grant_id = v_capability_grant_id;
  end if;

  if p_operation = 'designate' then
    insert into public.direct_entry_team_leader_assignments
      (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
    values
      (p_team_id, p_target_leader_app_user_id, v_recruiter_id, p_effective_date, true)
    returning * into v_new;
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, team_id, valid_from, is_current)
    values
      (p_target_leader_app_user_id, 'team', p_team_id, p_effective_date, true);
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from, is_current)
    values
      (p_target_leader_app_user_id, 'team_manager_assign', p_effective_date, true);
    v_change := case when v_old_count = 1 then 'replace' else 'designate' end;
  else
    v_new := v_old;
    v_change := 'revoke';
  end if;

  if p_operation = 'designate' then
    select count(*) filter (where a.team_id = p_team_id)::int,
           count(*) filter (
             where a.team_id = p_team_id
               and a.leader_app_user_id = p_target_leader_app_user_id
           )::int,
           count(*) filter (
             where a.leader_app_user_id = p_target_leader_app_user_id
           )::int
      into v_post_team_assignment_count, v_post_target_team_assignment_count,
           v_post_target_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.is_current;

    if v_post_team_assignment_count <> 1
       or v_post_target_team_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;
    if v_post_target_assignment_count <> 1
       or v_post_target_team_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    select count(*)::int,
           count(*) filter (where s.team_id = p_team_id)::int
      into v_post_scope_count, v_post_target_team_scope_count
      from public.direct_entry_scope_grants s
     where s.app_user_id = p_target_leader_app_user_id
       and s.scope_kind = 'team'
       and s.is_current;
    select count(*)::int into v_post_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_target_leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.is_current;
    select count(*)::int into v_post_coextensive_scope_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_scope_grants s
        on s.app_user_id = a.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = a.team_id
       and s.is_current
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.is_current
       and s.is_current;
    select count(*)::int into v_post_coextensive_capability_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_capability_grants g
        on g.app_user_id = a.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.is_current
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.is_current
       and g.is_current;
    if v_post_scope_count <> 1 or v_post_target_team_scope_count <> 1
       or v_post_capability_count <> 1
       or v_post_coextensive_scope_count <> 1
       or v_post_coextensive_capability_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    if v_old_count = 1 then
      select count(*)::int into v_post_outgoing_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.leader_app_user_id = v_old.leader_app_user_id
         and a.is_current;
      select count(*)::int into v_post_outgoing_scope_count
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team' and s.team_id = p_team_id
         and s.is_current;
      select count(*)::int into v_post_outgoing_capability_count
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.is_current;
      select count(*)::int into v_post_closed_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_old.assignment_id
         and a.valid_to = p_effective_date;
      select count(*)::int into v_post_closed_scope_count
        from public.direct_entry_scope_grants s
       where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
      select count(*)::int into v_post_closed_capability_count
        from public.direct_entry_capability_grants g
       where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
      if v_post_outgoing_assignment_count <> 0
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    end if;
  else
    select count(*)::int into v_post_team_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and a.is_current;
    select count(*)::int into v_post_outgoing_scope_count
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_old.leader_app_user_id
       and s.scope_kind = 'team' and s.team_id = p_team_id
       and s.is_current;
    select count(*)::int into v_post_outgoing_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.is_current;
    select count(*)::int into v_post_closed_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
       and a.valid_to = p_effective_date;
    select count(*)::int into v_post_closed_scope_count
      from public.direct_entry_scope_grants s
     where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
    select count(*)::int into v_post_closed_capability_count
      from public.direct_entry_capability_grants g
     where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
    if v_post_team_assignment_count <> 0
       or v_post_outgoing_scope_count <> 0
       or v_post_outgoing_capability_count <> 0
       or v_post_closed_assignment_count <> 1
       or v_post_closed_scope_count <> 1
       or v_post_closed_capability_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;
  end if;

  update public.teams t
     set version = t.version + 1
   where t.team_id = p_team_id
  returning t.version into v_team_version;
  if v_team_version is null then
    raise exception 'team not found' using errcode = 'P0002';
  end if;

  if v_old_count = 1 then
    v_before := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, v_old.valid_to, null, v_team.version, v_change
    );
  end if;
  if p_operation = 'designate' then
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_new.leader_app_user_id, v_new.leader_recruiter_id,
      v_new.valid_from, v_new.valid_to,
      case when v_old_count = 1 then v_old.leader_recruiter_id end,
      v_team_version, v_change
    );
  else
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, p_effective_date, null, v_team_version, v_change
    );
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_team_leader_revisions
    (team_id, version, actor_user_id, action, before_snapshot, after_snapshot)
  values
    (p_team_id, v_team_version, p_app_user_id, v_change, v_before, v_after)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, leader_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_leader_' || v_change, p_authority,
     p_team_id::text, 'all', 'APPLIED', v_reason_id, v_changed_fields, v_revision_id);

  v_result := jsonb_build_object(
    'team_id', p_team_id,
    'assignment_id', v_new.assignment_id,
    'leader_app_user_id', v_new.leader_app_user_id,
    'leader_recruiter_id', v_new.leader_recruiter_id,
    'valid_from', v_new.valid_from,
    'valid_to', case when p_operation = 'revoke' then p_effective_date else v_new.valid_to end,
    'version', v_team_version,
    'revision_id', v_revision_id,
    'change', v_change
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_get_project_admin(p_auth_subject uuid, p_app_user_id uuid, p_project_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_team_id uuid;
  v_project jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;

  select jsonb_build_object(
      'project_id', p.project_id,
      'display_name', p.display_name,
      'active', p.active,
      'version', p.version,
      'created_at', rev.first_revision_at,
      'updated_at', rev.last_revision_at,
      'revision_count', coalesce(rev.revision_count, 0),
      'active_assignment_count', coalesce(asg.active_count, 0),
      'can_manage_project_master', v_authority <> 'team_manager_assign',
      'can_assign_managers',
        v_authority <> 'team_manager_assign'
        or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
    )
    into v_project
    from public.direct_entry_projects p
    left join lateral (
      select min(r.created_at) as first_revision_at,
             max(r.created_at) as last_revision_at,
             count(*)::int as revision_count
        from public.direct_entry_project_revisions r
       where r.project_id = p.project_id
    ) rev on true
    left join lateral (
      select count(*)::int as active_count
        from public.direct_entry_project_manager_assignments a
       where a.project_id = p.project_id and a.is_current and a.revoked_at is null
    ) asg on true
   where p.project_id = p_project_id
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
     );
  if v_project is null then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  return v_project;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_projects_admin(p_auth_subject uuid, p_app_user_id uuid, p_include_inactive boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_team_id uuid;
  v_include_inactive boolean := coalesce(p_include_inactive, false);
  v_projects jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  if v_authority = 'team_manager_assign' then
    v_include_inactive := false;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'project_id', p.project_id,
      'display_name', p.display_name,
      'active', p.active,
      'version', p.version,
      'created_at', rev.first_revision_at,
      'updated_at', rev.last_revision_at,
      'revision_count', coalesce(rev.revision_count, 0),
      'active_assignment_count', coalesce(asg.active_count, 0),
      'can_manage_project_master', v_authority <> 'team_manager_assign',
      'can_assign_managers',
        v_authority <> 'team_manager_assign'
        or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
    ) order by p.display_name, p.project_id), '[]'::jsonb)
    into v_projects
    from public.direct_entry_projects p
    left join lateral (
      select min(r.created_at) as first_revision_at,
             max(r.created_at) as last_revision_at,
             count(*)::int as revision_count
        from public.direct_entry_project_revisions r
       where r.project_id = p.project_id
    ) rev on true
    left join lateral (
      select count(*)::int as active_count
        from public.direct_entry_project_manager_assignments a
       where a.project_id = p.project_id and a.is_current and a.revoked_at is null
    ) asg on true
   where (v_include_inactive or p.active)
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(p.project_id, v_team_id)
     );

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'projects', v_projects
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_assign_project_manager(p_auth_subject uuid, p_app_user_id uuid, p_project_id text, p_manager_recruiter_id uuid, p_valid_from date, p_expected_project_version integer, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_team_id uuid;
  v_project public.direct_entry_projects;
  v_valid_from date;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_link_count integer;
  v_enabled_link_count integer;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_assignment_id uuid;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;
  if p_manager_recruiter_id is null then
    raise exception 'project manager required' using errcode = '22023';
  end if;
  if p_expected_project_version is null or p_expected_project_version < 1 then
    raise exception 'expected project version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;
  v_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());
  if v_valid_from > public.direct_entry_authorization_date() then raise exception 'future project manager assignments require explicit activation' using errcode = '22023'; end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_manager_assignment_assign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'manager_recruiter_id', p_manager_recruiter_id,
      'valid_from', v_valid_from,
      'expected_project_version', p_expected_project_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Lock project first, then the effective mapping, then the canonical leader/team and
  -- target-recruiter authority aggregates in the same order as W01C/W01D before
  -- validating; the mapping is re-read AFTER every lock is held.
  v_project := public.direct_entry_lock_project(p_project_id, p_expected_project_version);
  if not v_project.active then
    raise exception 'project is not active' using errcode = '22023';
  end if;
  if v_authority = 'team_manager_assign' then
    if not public.direct_entry_lock_project_team_scope(p_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
    perform public.direct_entry_lock_project_team_manager_context(
      p_auth_subject, p_app_user_id, v_team_id, p_manager_recruiter_id
    );
    if not public.direct_entry_project_team_scope_effective(p_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
    select count(*)::int,
           count(*) filter (where m.team_id = v_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = p_manager_recruiter_id
       and m.is_current;
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
    select count(*)::int
      into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.is_current;
    select count(*)::int
      into v_enabled_link_count
      from public.direct_entry_app_user_recruiter_links l
      join public.direct_entry_app_users au on au.app_user_id = l.app_user_id
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.is_current
       and au.enabled
       and au.auth_subject is not null;
    select count(*)::int,
           count(*) filter (
             where m.provider_type = 'hrp' and m.vendor_id is null
           )::int
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = p_manager_recruiter_id
       and m.is_current;
    if v_link_count <> 1 or v_enabled_link_count <> 1
       or v_provider_count <> 1 or v_hrp_provider_count <> 1
       or not exists (
         select 1 from public.recruiters r
          where r.recruiter_id = p_manager_recruiter_id and r.active
       ) then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
  end if;
  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = p_manager_recruiter_id and r.active
  ) then
    raise exception 'project manager recruiter is not active' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.is_current
  ) then
    raise exception 'project manager has no verified account link' using errcode = '22023';
  end if;
  select count(*)::int
    into v_link_count
    from public.direct_entry_app_user_recruiter_links l
   where l.recruiter_id = p_manager_recruiter_id
     and l.verified and l.is_current;
  select count(*)::int
    into v_enabled_link_count
    from public.direct_entry_app_user_recruiter_links l
    join public.direct_entry_app_users au on au.app_user_id = l.app_user_id
   where l.recruiter_id = p_manager_recruiter_id
     and l.verified and l.is_current
     and au.enabled and au.auth_subject is not null;
  if v_link_count <> 1 or v_enabled_link_count <> 1 then
    raise exception 'project manager must have exactly one enabled verified account link'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from public.direct_entry_project_manager_assignments a
     where a.project_id = p_project_id
       and a.manager_recruiter_id = p_manager_recruiter_id
       and a.is_current and a.revoked_at is null
  ) then
    raise exception 'project manager is already assigned to this project'
      using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);
  insert into public.direct_entry_project_manager_assignments
    (project_id, manager_recruiter_id, valid_from, valid_to,
     created_by_user_id, reason_id, version, is_current)
  values
    (p_project_id, p_manager_recruiter_id, v_valid_from, null,
     p_app_user_id, v_reason_id, 1, true)
  returning assignment_id into v_assignment_id;

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      p_project_id, p_app_user_id, v_reason_id, v_before,
      jsonb_set(
        public.direct_entry_project_snapshot(v_project),
        '{assignment_change}',
        jsonb_build_object(
          'change', 'ASSIGN',
          'assignment_id', v_assignment_id,
          'manager_recruiter_id', p_manager_recruiter_id,
          'valid_from', v_valid_from,
          'valid_to', null
        ),
        true
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     scope_team_id, outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_assign',
     v_authority, v_assignment_id::text,
     case when v_authority = 'team_manager_assign' then 'team' else 'all' end,
     case when v_authority = 'team_manager_assign' then v_team_id else null end,
     'APPLIED', v_reason_id,
     array['project_id', 'manager_recruiter_id', 'valid_from'], v_revision_id);

  v_result := jsonb_build_object(
    'assignment_id', v_assignment_id,
    'project_id', p_project_id,
    'manager_recruiter_id', p_manager_recruiter_id,
    'valid_from', v_valid_from,
    'valid_to', null,
    'version', 1,
    'project_version', v_project_version,
    'already_assigned', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_manager_assignment_assign', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_assign_team_membership(p_auth_subject uuid, p_app_user_id uuid, p_recruiter_id uuid, p_team_id uuid, p_valid_from date, p_expected_version integer, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_reason_id uuid;
  v_subject public.recruiters;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_changed text[];
  v_prior jsonb;
  v_result jsonb;
begin
  -- Authorization first: an actor without catalog authority always gets 42501 and
  -- learns nothing about the shape of the input.
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null or p_team_id is null then
    raise exception 'recruiter and target team required' using errcode = '22023';
  end if;
  if p_valid_from is null then raise exception 'effective date required' using errcode = '22023'; end if;
  if p_valid_from > public.direct_entry_authorization_date() then raise exception 'future team memberships require explicit activation' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_assign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'team_id', p_team_id,
      'valid_from', p_valid_from,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_subject := public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
  perform public.direct_entry_assert_membership_target_team(p_team_id);

  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_from, p_team_id) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- The overlap trigger is the only authority on "at most one effective
  -- membership": no pre-check here, and the recruiter row is already locked.
  insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
  values (p_recruiter_id, p_team_id, p_valid_from, true)
  returning * into v_membership;

  v_changed := array['team_id', 'valid_from'];
  if p_valid_from < public.direct_entry_authorization_date() then
    v_changed := array_append(v_changed, 'backdated');
  end if;

  select b.recruiter_version, b.revision_id
    into v_recruiter_version, v_revision_id
    from public.direct_entry_bump_membership_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      null,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, p_team_id, p_valid_from, null, v_subject.version + 1, 'ASSIGN'
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome,
     reason_id, changed_fields, team_membership_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_membership_assign', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id, v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'membership_id', v_membership.membership_id,
    'recruiter_id', p_recruiter_id,
    'team_id', p_team_id,
    'valid_from', to_jsonb(v_membership.valid_from),
    'valid_to', to_jsonb(v_membership.valid_to),
    'recruiter_version', v_recruiter_version,
    'revision_id', v_revision_id,
    'change', 'ASSIGN'
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_membership_assign', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_catalog_bootstrap_plan(p_auth_subject uuid, p_app_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_projection jsonb;
  v_capability_count integer;
  v_catalog_empty boolean;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'catalog bootstrap actor required' using errcode = '22023';
  end if;
  perform set_config('mini_bi.catalog_bootstrap_app_user_id', p_app_user_id::text, true);
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  select count(distinct g.capability)::integer into v_capability_count
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_app_user_id
     and g.capability in ('entry_admin', 'recruiter_master_manage', 'team_master_manage')
     and g.is_current;
  if v_capability_count <> 3 then
    raise exception 'catalog bootstrap capability denied' using errcode = '42501';
  end if;

  v_projection := public.direct_entry_catalog_bootstrap_projection();
  select not (
    exists (select 1 from public.direct_entry_projects)
    or exists (select 1 from public.recruiters)
    or exists (select 1 from public.teams)
    or exists (select 1 from public.recruiter_aliases)
    or exists (select 1 from public.recruiter_provider_memberships)
    or exists (select 1 from public.recruiter_team_memberships)
    or exists (select 1 from public.direct_entry_banks)
  ) into v_catalog_empty;

  return jsonb_build_object(
    'source_fingerprint', v_projection->'source_fingerprint',
    'project_count', v_projection->'project_count',
    'recruiter_count', v_projection->'recruiter_count',
    'provider_period_count', v_projection->'provider_period_count',
    'invalid_count', v_projection->'invalid_count',
    'ambiguous_count', v_projection->'ambiguous_count',
    'catalog_empty', v_catalog_empty
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_claim_worker_portrait_stage(p_auth_subject uuid, p_app_user_id uuid, p_stage_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_date date := public.direct_entry_authorization_date();
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability = 'document_upload'
       and g.is_current
  ) then raise exception 'capability denied' using errcode = '42501'; end if;
  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'portrait stage claim invalid' using errcode = '22023';
  end if;
  if v_stage.status = 'STAGED' then
    update public.direct_entry_worker_portrait_stages
       set status = 'CLAIMED', claim_idempotency_key = p_idempotency_key
     where stage_id = p_stage_id returning * into v_stage;
  elsif v_stage.status not in ('CLAIMED', 'ATTACHED') or
        v_stage.claim_idempotency_key <> p_idempotency_key then
    raise exception 'portrait stage already claimed' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
    'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
    'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_create_batch(p_auth_subject uuid, p_app_user_id uuid, p_rows jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_row jsonb;
  v_submission_id uuid := gen_random_uuid();
  v_candidate_id uuid;
  v_entry_id uuid;
  v_recruiter_id uuid;
  v_project_id text;
  v_first_work_date date;
  v_employee_code text;
  v_worker_details jsonb;
  v_labor_type text;
  v_provider_type text;
  v_team_id uuid;
  v_scope text;
  v_count integer;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_entry_ids jsonb := '[]'::jsonb;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 then
    raise exception 'invalid batch input' using errcode = '22023';
  end if;
  -- P2.5-HF: per-row project authority, before the idempotency record and the
  -- submission insert.
  select count(*)::int into v_count
    from jsonb_array_elements(p_rows) as e(value)
   where public.direct_entry_create_authority(
           p_auth_subject, p_app_user_id, e.value->>'project_id',
           case when coalesce(e.value->>'first_work_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then (e.value->>'first_work_date')::date end
         ) <> 'manager';
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'batch_create', p_idempotency_key,
    public.direct_entry_payload_hash(p_rows)
  );
  if v_prior is not null then return v_prior; end if;
  insert into public.direct_entry_submissions (submission_id, created_by_user_id)
    values (v_submission_id, p_app_user_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Initial batch creation');
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if (v_row - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'])
       <> '{}'::jsonb then
      raise exception 'unsupported batch field' using errcode = '22023';
    end if;
    v_project_id := v_row->>'project_id';
    v_first_work_date := (v_row->>'first_work_date')::date;
    v_employee_code := v_row->>'employee_code';
    v_worker_details := v_row->'worker_details';
    v_recruiter_id := (v_row->>'recruiter_id')::uuid;
    v_labor_type := v_row->>'labor_type';
    if public.direct_entry_contains_authority(v_worker_details) then
      raise exception 'client authority field forbidden' using errcode = '22023';
    end if;
    if v_project_id is null or v_first_work_date is null or v_employee_code is null
       or jsonb_typeof(v_worker_details) <> 'object'
       or v_recruiter_id is null or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
      raise exception 'incomplete batch row' using errcode = '22023';
    end if;
    -- P2.5-HF: enforced once by the per-row authority guard before this batch ran.
    select count(*), min(m.provider_type) into v_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.is_current;
    if v_count <> 1 then
      raise exception 'recruiter provider membership denied' using errcode = '42501';
    end if;
    if v_provider_type = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and m.is_current;
      if v_count <> 1 then
        raise exception 'recruiter team membership denied' using errcode = '42501';
      end if;
    end if;
    insert into public.direct_entry_candidates default values returning candidate_id into v_candidate_id;
    insert into public.direct_entries (
      submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
      employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_labor_type
    ) returning entry_id into v_entry_id;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, version, actor_user_id, reason_id
    ) values (
      v_entry_id, 'ON', v_first_work_date, 1, p_app_user_id, v_reason_id
    );
    perform public.direct_entry_write_revision(
      v_entry_id, p_app_user_id, v_reason_id, null,
      public.direct_entry_entry_snapshot(v_entry_id), 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'entry_create', 'entry_create', v_entry_id::text,
      'own', 'APPLIED', v_reason_id, array['entry_created']
    );
    v_entry_ids := v_entry_ids || jsonb_build_array(v_entry_id);
  end loop;
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_submission_id, p_app_user_id, v_reason_id, null,
    jsonb_build_object('state','DRAFT','version',1,'entry_count',jsonb_array_length(p_rows)), 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'batch_create', 'entry_create',
    v_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['submission_created','entries_created']
  );
  v_result := jsonb_build_object(
    'submission_id', v_submission_id, 'state', 'DRAFT', 'version', 1, 'entry_ids', v_entry_ids
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'batch_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_create_draft_row(p_auth_subject uuid, p_app_user_id uuid, p_submission_id uuid, p_expected_submission_version integer, p_row jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_submission public.direct_entry_submissions%rowtype;
  v_entry_id uuid;
  v_candidate_id uuid;
  v_recruiter_id uuid;
  v_new_recruiter_id uuid;
  v_new_work_date date;
  v_team_id uuid;
  v_provider_type text;
  v_project_id text;
  v_first_work_date date;
  v_employee_code text;
  v_worker_details jsonb;
  v_labor_type text;
  v_count integer;
  v_scope text;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_row) <> 'object'
     or (p_row - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'])
        <> '{}'::jsonb then
    raise exception 'invalid draft row input' using errcode = '22023';
  end if;
  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id;
  if not found or v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'draft submission scope denied' using errcode = '42501';
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_row_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'submission_id', p_submission_id, 'expected_version', p_expected_submission_version,
      'row', p_row
    ))
  );
  if v_prior is not null then return v_prior; end if;
  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found or v_submission.created_by_user_id <> p_app_user_id
     or v_submission.state <> 'DRAFT' then
    raise exception 'draft submission denied' using errcode = '42501';
  end if;
  if p_expected_submission_version is null or p_expected_submission_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = '40001';
  end if;
  v_project_id := p_row->>'project_id';
  v_first_work_date := (p_row->>'first_work_date')::date;
  v_employee_code := p_row->>'employee_code';
  v_worker_details := p_row->'worker_details';
  v_recruiter_id := (p_row->>'recruiter_id')::uuid;
  v_labor_type := p_row->>'labor_type';
  if public.direct_entry_contains_authority(v_worker_details) then
    raise exception 'client authority field forbidden' using errcode = '22023';
  end if;
  if v_project_id is null or v_first_work_date is null or v_employee_code is null
     or jsonb_typeof(v_worker_details) <> 'object'
     or v_recruiter_id is null or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
    raise exception 'incomplete draft row' using errcode = '22023';
  end if;
  -- P2.5-HF: the row's project decides the creation authority for this row.
  perform public.direct_entry_create_authority(
    p_auth_subject, p_app_user_id, v_project_id, v_first_work_date
  );
  select count(*), min(m.provider_type) into v_count, v_provider_type
    from public.recruiter_provider_memberships m
   where m.recruiter_id = v_recruiter_id and m.is_current;
  if v_count <> 1 then
    raise exception 'recruiter provider membership denied' using errcode = '42501';
  end if;
  if v_provider_type = 'vendor' then
    v_team_id := public.direct_entry_system_vendor_team_id();
  else
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id and m.is_current;
    if v_count <> 1 then
      raise exception 'recruiter team membership denied' using errcode = '42501';
    end if;
  end if;
  insert into public.direct_entry_candidates default values returning candidate_id into v_candidate_id;
  insert into public.direct_entries (
    submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
    employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type
  ) values (
    p_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
    v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_labor_type
  ) returning entry_id into v_entry_id;
  update public.direct_entry_submissions
     set version = version + 1
   where submission_id = p_submission_id;
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Draft row creation');
  insert into public.direct_entry_employment_status_events (
    entry_id, status, effective_date, version, actor_user_id, reason_id
  ) values (
    v_entry_id, 'ON', v_first_work_date, 1, p_app_user_id, v_reason_id
  );
  perform public.direct_entry_write_revision(
    v_entry_id, p_app_user_id, v_reason_id, null,
    public.direct_entry_entry_snapshot(v_entry_id), 1
  );
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    p_submission_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state','DRAFT','version',v_submission.version,'entry_count',
      (select count(*) - 1 from public.direct_entries
        where submission_id=p_submission_id and deleted_at is null)),
    jsonb_build_object('state','DRAFT','version',v_submission.version + 1,'entry_count',
      (select count(*) from public.direct_entries where submission_id=p_submission_id)),
    v_submission.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, revision_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_row_create', 'entry_create',
    v_entry_id::text, 'own', 'APPLIED', v_reason_id,
    (select revision_id from public.direct_entry_revisions where entry_id=v_entry_id and version=1),
    v_submission_revision_id, array['entry_created']
  );
  v_result := jsonb_build_object(
    'entry_id', v_entry_id, 'candidate_id', v_candidate_id,
    'submission_id', p_submission_id, 'version', 1,
    'submission_version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_row_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_create_full_profile_batch(p_auth_subject uuid, p_app_user_id uuid, p_contract_version text, p_rows jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_auth_date date := public.direct_entry_authorization_date();
  v_row jsonb;
  v_worker_input jsonb;
  v_worker_details jsonb;
  v_payment jsonb;
  v_employment jsonb;
  v_note jsonb;
  v_state text;
  v_project_id text;
  v_recruiter_id uuid;
  v_first_work_date date;
  v_employee_code text;
  v_labor_type text;
  v_display_name text;
  v_general_note text;
  v_payment_state text;
  v_account_number text;
  v_bank_id text;
  v_bank_name text;
  v_account_holder_name text;
  v_status text;
  v_leave_date date;
  v_leave_reason_text text;
  v_provider_type text;
  v_team_id uuid;
  v_count integer;
  v_submission_id uuid := gen_random_uuid();
  v_candidate_id uuid;
  v_entry_id uuid;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_trim_chars text := E' \t\n\r' || chr(11) || chr(12) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
    || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232)
    || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279);
  v_entry_ids jsonb := '[]'::jsonb;
  v_codes text[] := '{}';
  v_national_ids text[] := '{}';
  v_national_id text;
  v_has_payment boolean := false;
  v_has_status boolean := false;
  v_prior jsonb;
  v_hash text;
  v_result jsonb;
begin
  if p_contract_version is distinct from 'worker-profile/1.0' then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 then
    raise exception 'BATCH_INVALID' using errcode = '22023';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row - array[
         'project_id','first_work_date','employee_code','recruiter_id','labor_type',
         'display_name','worker_details','general_note','payment','employment'
       ] <> '{}'::jsonb then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    if v_row ? 'payment'
       and coalesce(v_row->'payment'->>'state', 'omitted') <> 'omitted'
       and not (
         v_row->'payment'->>'state' = 'provided'
         and nullif(btrim(v_row->'payment'->>'account_number', v_trim_chars), '') is null
         and nullif(btrim(v_row->'payment'->>'bank_name', v_trim_chars), '') is null
         and nullif(btrim(v_row->'payment'->>'account_holder_name', v_trim_chars), '') is null
         and nullif(btrim(v_row->'payment'->>'bank_id'), '') is null
       ) then
      v_has_payment := true;
    end if;
    -- P2.5-HF: ON is the creation default (#57), so only an explicit departure needs
    -- the privileged employment_status.apply capability.
    if coalesce(v_row->'employment'->>'initial_status', '') = 'OFF' then
      v_has_status := true;
    end if;
  end loop;

  -- P2.5-HF: creation authority is per ROW and per PROJECT. The guard below calls the
  -- authority for every row, so one unauthorized project fails the whole batch before
  -- the idempotency record, the submission or any entry exists.
  select count(*)::int into v_count
    from jsonb_array_elements(p_rows) as e(value)
   where public.direct_entry_create_authority(
           p_auth_subject, p_app_user_id, e.value->>'project_id',
           case when coalesce(e.value->>'first_work_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then (e.value->>'first_work_date')::date end
         ) <> 'manager';
  -- Payment fields follow the enclosing current-scope create action.
  -- Project managers already passed the per-row authority count above. They may
  -- record the supplied initial state for their own project; the legacy/global
  -- path continues to require employment_status.apply.
  if v_has_status and v_count > 0 then
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'employment_status.apply'
    );
  end if;

  v_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'contract_version', p_contract_version, 'rows', p_rows
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'full_profile_batch_create', p_idempotency_key, v_hash
  );
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  insert into public.direct_entry_submissions (submission_id, created_by_user_id)
    values (v_submission_id, p_app_user_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Initial full-profile batch creation');

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if v_row ? 'worker_details' and jsonb_typeof(v_row->'worker_details') <> 'object' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_worker_input := coalesce(v_row->'worker_details', '{}'::jsonb);
    if v_worker_input - array[
      'gender','date_of_birth','national_id','national_id_issued_at',
      'national_id_issued_place','address','phone'
    ] <> '{}'::jsonb then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;

    v_project_id := v_row->>'project_id';
    v_recruiter_id := case
      when coalesce(v_row->>'recruiter_id','') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (v_row->>'recruiter_id')::uuid else null end;
    v_employee_code := v_row->>'employee_code';
    v_labor_type := v_row->>'labor_type';
    v_display_name := v_row->>'display_name';
    begin
      if coalesce(v_row->>'first_work_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'invalid date';
      end if;
      v_first_work_date := (v_row->>'first_work_date')::date;
      if to_char(v_first_work_date, 'YYYY-MM-DD') <> v_row->>'first_work_date' then
        raise exception 'invalid date';
      end if;
    exception when others then
      raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
    end;

    if v_project_id is null or v_project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       or not exists (
         select 1 from public.direct_entry_projects p
          where p.project_id = v_project_id and p.active
       ) then
      raise exception 'PROJECT_NOT_ACTIVE' using errcode = '22023';
    end if;
    if v_recruiter_id is null or not exists (
      select 1 from public.recruiters r
       where r.recruiter_id = v_recruiter_id and r.active
    ) then
      raise exception 'RECRUITER_NOT_ACTIVE' using errcode = '22023';
    end if;
    if v_employee_code is null then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    elsif v_employee_code ~ '^hrp-[0-9]{4}-[0-9]+$'
       and v_employee_code !~ '^hrp-[0-9]{4}-[0-9]{6}$' then
      raise exception 'EMPLOYEE_CODE_LEGACY_QUARANTINE' using errcode = '22023';
    elsif v_employee_code !~ '^hrp-[0-9]{4}-[0-9]{6}$' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    elsif substring(v_employee_code from 5 for 4) <> to_char(v_first_work_date, 'YYYY') then
      raise exception 'EMPLOYEE_CODE_YEAR' using errcode = '22023';
    end if;
    if v_employee_code = any(v_codes) then
      raise exception 'EMPLOYEE_CODE_DUPLICATE' using errcode = '22023';
    end if;
    v_codes := array_append(v_codes, v_employee_code);

    if v_display_name is null or length(btrim(v_display_name)) not between 1 and 256
       or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_worker_details := jsonb_build_object(
      'display_name', v_display_name,
      'gender', coalesce(v_worker_input->'gender', '{"state":"omitted"}'::jsonb),
      'date_of_birth', coalesce(v_worker_input->'date_of_birth', '{"state":"omitted"}'::jsonb),
      'national_id', coalesce(v_worker_input->'national_id', '{"state":"omitted"}'::jsonb),
      'national_id_issued_at', coalesce(v_worker_input->'national_id_issued_at', '{"state":"omitted"}'::jsonb),
      'national_id_issued_place', '{"state":"provided","value":"Bộ Công An"}'::jsonb,
      'address', coalesce(v_worker_input->'address', '{"state":"omitted"}'::jsonb),
      'phone', coalesce(v_worker_input->'phone', '{"state":"omitted"}'::jsonb)
    );
    if not public.direct_entry_valid_worker_details(v_worker_details) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_national_id := case
      when v_worker_details->'national_id'->>'state' = 'provided'
      then v_worker_details->'national_id'->>'value'
      else null
    end;
    if v_national_id is not null then
      -- P3.1-HF: a canonical CCCD repeated inside one batch is a second episode for
      -- the same worker, exactly like a rehire, so this refusal is gone. The
      -- cross-episode refusal #58 relaxed is gone too; only the format validation
      -- above (direct_entry_valid_worker_details) remains on this write path.
      v_national_ids := array_append(v_national_ids, v_national_id);
    end if;

    -- P2.5-HF: the creation authority (project assignment, or the legacy bundle with
    -- its own scope) was already enforced once for the whole batch above.
    select count(*), min(m.provider_type) into v_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.is_current;
    if v_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;
    if v_provider_type = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and m.is_current;
      if v_count <> 1 then
        raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
      end if;
    end if;

    v_note := coalesce(v_row->'general_note', '{"state":"omitted"}'::jsonb);
    if jsonb_typeof(v_note) <> 'object'
       or v_note - array['state','value'] <> '{}'::jsonb
       or not (v_note ? 'state') then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_state := v_note->>'state';
    if v_state = 'provided' then
      v_general_note := v_note->>'value';
      if jsonb_typeof(v_note->'value') <> 'string'
         or not (v_note ? 'value')
         or length(btrim(v_general_note)) not between 1 and 4000 then
        raise exception 'GENERAL_NOTE_TOO_LONG' using errcode = '22023';
      end if;
    elsif v_state = 'omitted' then
      if v_note ? 'value' then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_general_note := null;
    else
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;

    v_payment := nullif(v_row->'payment', 'null'::jsonb);
    v_payment_state := null;
    v_account_number := null;
    v_bank_id := null;
    v_account_holder_name := null;
    if v_payment is not null then
      if jsonb_typeof(v_payment) <> 'object'
         or v_payment - array['state','account_number','bank_id','bank_name','account_holder_name'] <> '{}'::jsonb
         or not (v_payment ? 'state') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      v_payment_state := v_payment->>'state';
      if v_payment_state not in ('omitted','unknown','intentionally_blank','provided') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      v_account_number := nullif(btrim(v_payment->>'account_number', v_trim_chars), '');
      v_bank_id := nullif(btrim(v_payment->>'bank_id'), '');
      v_bank_name := nullif(btrim(v_payment->>'bank_name', v_trim_chars), '');
      v_account_holder_name := nullif(
        btrim(v_payment->>'account_holder_name', v_trim_chars), ''
      );
      if (v_payment ? 'account_number' and jsonb_typeof(v_payment->'account_number') not in ('string','null'))
         or (v_payment ? 'bank_id' and jsonb_typeof(v_payment->'bank_id') not in ('string','null'))
         or (v_payment ? 'bank_name' and jsonb_typeof(v_payment->'bank_name') not in ('string','null'))
         or (v_payment ? 'account_holder_name' and jsonb_typeof(v_payment->'account_holder_name') not in ('string','null'))
         or (v_account_number is not null and (length(v_account_number) not between 1 and 64
           or v_account_number ~ '[[:cntrl:]]'))
         or (v_bank_name is not null and (length(v_bank_name) not between 1 and 256
           or v_bank_name ~ '[[:cntrl:]]'))
         or (v_account_holder_name is not null and
           (length(v_account_holder_name) not between 1 and 256
             or v_account_holder_name ~ '[[:cntrl:]]'))
         or (v_bank_id is not null and
           v_bank_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      if v_bank_id is not null and not exists (
        select 1 from public.direct_entry_banks b
         where b.bank_id = v_bank_id and b.active
      ) then
        raise exception 'BANK_NOT_ACTIVE' using errcode = '22023';
      end if;
      if v_payment_state <> 'provided' then
        if v_account_number is not null or v_bank_id is not null or v_bank_name is not null
           or v_account_holder_name is not null then
          raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
        end if;
      elsif v_account_number is null and v_bank_name is null and v_account_holder_name is null then
        if v_bank_id is not null then
          raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
        end if;
        v_payment_state := 'omitted';
      end if;
    end if;

    v_employment := nullif(v_row->'employment', 'null'::jsonb);
    v_status := null;
    v_leave_date := null;
    v_leave_reason_text := null;
    if v_employment is not null then
      if jsonb_typeof(v_employment) <> 'object'
         or v_employment - array['initial_status','leave_date','leave_reason_text'] <> '{}'::jsonb
         or not (v_employment ? 'initial_status') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_status := v_employment->>'initial_status';
      if v_status not in ('UNCONFIRMED','ON','OFF') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      if v_status = 'OFF' then
        begin
          if coalesce(v_employment->>'leave_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
            raise exception 'invalid date';
          end if;
          v_leave_date := (v_employment->>'leave_date')::date;
          if to_char(v_leave_date, 'YYYY-MM-DD') <> v_employment->>'leave_date' then
            raise exception 'invalid date';
          end if;
        exception when others then
          raise exception 'OFF_REQUIRES_DATE_AND_REASON' using errcode = '22023';
        end;
        v_leave_reason_text := v_employment->>'leave_reason_text';
        if v_leave_date < v_first_work_date or v_leave_date > v_auth_date
           or v_leave_reason_text is null
           or length(btrim(v_leave_reason_text)) not between 1 and 4000 then
          raise exception 'OFF_REQUIRES_DATE_AND_REASON' using errcode = '22023';
        end if;
      elsif v_employment ? 'leave_date' or v_employment ? 'leave_reason_text' then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
    end if;

    insert into public.direct_entry_candidates default values
      returning candidate_id into v_candidate_id;
    insert into public.direct_entries (
      submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
      employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type,
      general_note
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type,
      v_labor_type, v_general_note
    ) returning entry_id into v_entry_id;

    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, version, actor_user_id, reason_id
    ) values (
      v_entry_id, case when v_status = 'UNCONFIRMED' then 'UNCONFIRMED' else 'ON' end, v_first_work_date, 1, p_app_user_id, v_reason_id
    );
    if v_status = 'OFF' then
      insert into public.direct_entry_employment_status_events (
        entry_id, status, effective_date, leave_date, leave_reason_text,
        version, actor_user_id, reason_id
      ) values (
        v_entry_id, v_status,
        case when v_status = 'OFF' then v_leave_date else v_first_work_date end,
        v_leave_date, v_leave_reason_text, 2, p_app_user_id, v_reason_id
      );
    end if;
    if v_payment_state is not null and v_payment_state <> 'omitted' then
      insert into public.direct_entry_payments (
        entry_id, state, account_number, bank_id, bank_name, account_holder_name
      ) values (
        v_entry_id, v_payment_state, v_account_number, v_bank_id, v_bank_name, v_account_holder_name
      );
    end if;

    v_revision_id := public.direct_entry_write_revision(
      v_entry_id, p_app_user_id, v_reason_id, null,
      public.direct_entry_entry_snapshot(v_entry_id), 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'entry_create', 'entry_create',
      v_entry_id::text, 'own', 'APPLIED', v_reason_id, v_revision_id,
      array['entry_created','worker_details','general_note']
        || case when v_payment_state is not null and v_payment_state <> 'omitted'
             then array['payment']::text[] else '{}'::text[] end
        || case when v_status is not null
             then array['employment_status']::text[] else '{}'::text[] end
    );
    v_entry_ids := v_entry_ids || jsonb_build_array(v_entry_id);
  end loop;

  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_submission_id, p_app_user_id, v_reason_id, null,
    jsonb_build_object('state','DRAFT','version',1,'entry_count',jsonb_array_length(p_rows)), 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'full_profile_batch_create', 'entry_create',
    v_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['submission_created','entries_created']
  );
  v_result := jsonb_build_object(
    'submission_id', v_submission_id,
    'state', 'DRAFT',
    'version', 1,
    'entry_ids', v_entry_ids,
    'replayed', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'full_profile_batch_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_create_full_profile_batch_v2_unscoped_h03(p_auth_subject uuid, p_app_user_id uuid, p_contract_version text, p_rows jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_codes text[] := '{}';
  v_year integer;
  v_sequence integer;
  v_counter_year integer;
  v_provider_type text;
  v_recruiter_id uuid;
  v_membership_count integer;
  v_prior jsonb;
  v_hash text;
  v_inner_key text;
  v_result jsonb;
begin
  if p_contract_version is distinct from 'worker-profile/1.1' then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 then
    raise exception 'BATCH_INVALID' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row - array[
         'project_id','first_work_date','provider_type','recruiter_id','labor_type',
         'display_name','worker_details','general_note','payment','employment'
       ] <> '{}'::jsonb
       or v_row->>'provider_type' not in ('hrp','vendor')
       or coalesce(v_row->>'first_work_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or coalesce(v_row->>'recruiter_id','') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    begin
      v_year := substring(v_row->>'first_work_date' from 1 for 4)::integer;
      if to_char((v_row->>'first_work_date')::date, 'YYYY-MM-DD') <>
         v_row->>'first_work_date' then
        raise exception 'invalid date';
      end if;
    exception when others then
      raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
    end;
  end loop;

  -- P2.5-HF: same per-row project authority as the inner batch, evaluated before the
  -- idempotency record and before any employee-code counter is consumed.
  select count(*)::int into v_membership_count
    from jsonb_array_elements(p_rows) as e(value)
   where public.direct_entry_create_authority(
           p_auth_subject, p_app_user_id, e.value->>'project_id',
           (e.value->>'first_work_date')::date
         ) <> 'manager';

  v_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'contract_version', p_contract_version, 'rows', p_rows
  ));
  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':' || p_idempotency_key, 0)
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'full_profile_batch_create_v2', p_idempotency_key, v_hash
  );
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  v_inner_key :=
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 1 for 8) || '-' ||
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 9 for 4) || '-4' ||
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 14 for 3) || '-8' ||
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 18 for 3) || '-' ||
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 21 for 12);

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_year := substring(v_row->>'first_work_date' from 1 for 4)::integer;
    v_recruiter_id := (v_row->>'recruiter_id')::uuid;
    v_provider_type := v_row->>'provider_type';
    select count(*)::integer
      into v_membership_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.provider_type = v_provider_type
       and m.is_current;
    if v_membership_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;

    insert into public.direct_entry_employee_code_counters (employee_year, last_sequence)
      values (v_year, 0)
      on conflict (employee_year) do nothing;
    update public.direct_entry_employee_code_counters
       set last_sequence = last_sequence + 1
     where employee_year = v_year
       and last_sequence < 999999
     returning last_sequence into v_sequence;
    if not found then
      raise exception 'EMPLOYEE_CODE_SEQUENCE_EXHAUSTED' using errcode = '22023';
    end if;
    v_counter_year := v_year;
    v_codes := array_append(v_codes,
      'hrp-' || v_counter_year::text || '-' || lpad(v_sequence::text, 6, '0'));
    v_rows := v_rows || jsonb_build_array(
      (v_row - 'provider_type') || jsonb_build_object('employee_code', v_codes[array_length(v_codes, 1)])
    );
  end loop;

  v_result := public.direct_entry_create_full_profile_batch(
    p_auth_subject,
    p_app_user_id,
    'worker-profile/1.0',
    v_rows,
    v_inner_key
  );
  v_result := v_result || jsonb_build_object(
    'employee_codes', to_jsonb(v_codes),
    'replayed', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'full_profile_batch_create_v2', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_create_personnel(p_auth_subject uuid, p_app_user_id uuid, p_expected_version integer, p_personnel_code text, p_display_name text, p_personnel_position text, p_valid_from date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_code text;
  v_display text;
  v_position text;
  v_valid_from date;
  v_reason_id uuid;
  v_recruiter public.recruiters;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  -- Authorization first: an actor without catalog authority always gets 42501 and
  -- learns nothing about the shape of the input.
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  -- create opens a new aggregate: expected_version must be exactly 0.
  if p_expected_version is distinct from 0 then
    raise exception 'create expected version must be zero' using errcode = '22023';
  end if;
  if p_personnel_code is null or btrim(p_personnel_code) = '' then
    raise exception 'personnel code required' using errcode = '22023';
  end if;
  v_code := btrim(p_personnel_code);
  if length(v_code) > 64 or v_code ~ '[[:space:][:cntrl:]]' then
    raise exception 'personnel code is not canonical' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'personnel display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  if p_personnel_position is null or p_personnel_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  v_position := p_personnel_position;
  -- FIX R1: the contract carries an EXPLICIT valid_from. It is never coalesced to
  -- the authorization date, so a missing value fails validation with zero residue
  -- instead of silently inventing a provider start date.
  if p_valid_from is null then
    raise exception 'provider valid from required' using errcode = '22023';
  end if;
  v_valid_from := p_valid_from;
  if v_valid_from > public.direct_entry_authorization_date() then
    raise exception 'provider valid from is in the future' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'personnel_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'personnel_code', v_code,
      'display_name', v_display,
      'personnel_position', v_position,
      'valid_from', v_valid_from
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then
    raise exception 'personnel code already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.recruiters (display_name, personnel_code, personnel_position, active, version)
  values (v_display, v_code, v_position, true, 1)
  returning * into v_recruiter;

  -- Exactly one HRP provider membership with an explicit valid_from. The insert
  -- creates no auth account, no app user, no recruiter link, no team membership,
  -- no capability grant and no scope grant.
  insert into public.recruiter_provider_memberships
    (recruiter_id, provider_type, valid_from, vendor_id, is_current)
  values (v_recruiter.recruiter_id, 'hrp', v_valid_from, null, true);

  v_revision_id := public.direct_entry_write_personnel_revision(
    v_recruiter.recruiter_id, v_recruiter.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_personnel_snapshot(v_recruiter)
  );

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, personnel_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'personnel_create', v_authority,
     v_recruiter.recruiter_id::text, 'all', 'APPLIED', v_reason_id,
     array['display_name', 'personnel_code', 'personnel_position', 'active'],
     v_revision_id);

  v_result := jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id,
    'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code,
    'personnel_position', v_recruiter.personnel_position,
    'active', v_recruiter.active,
    'version', v_recruiter.version,
    'hrp_valid_from', v_valid_from,
    'revision_id', v_revision_id,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'personnel_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_create_vendor(p_auth_subject uuid, p_app_user_id uuid, p_expected_version integer, p_vendor_id text, p_display_name text, p_valid_from date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_vendor_id text;
  v_display text;
  v_reason_id uuid;
  v_vendor public.vendors;
  v_recruiter_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  -- Authorization first: an actor without catalog authority always gets 42501 and
  -- learns nothing about the shape of the input.
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  -- create opens a new aggregate: expected_version must be exactly 0.
  if p_expected_version is distinct from 0 then
    raise exception 'create expected version must be zero' using errcode = '22023';
  end if;
  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;
  v_vendor_id := btrim(p_vendor_id);
  -- The reserved system namespace is not a business vendor. It is rejected before
  -- the shape check so the boundary is explicit and not an accident of the #41
  -- check constraint (which rejects a leading underscore anyway).
  if v_vendor_id = '__system_vendor__' then
    raise exception 'vendor id is reserved' using errcode = '22023';
  end if;
  -- The canonical Vendor business key mirrors the public.vendors check exactly,
  -- so a malformed key is a bounded 22023 instead of a raw 23514.
  if length(v_vendor_id) > 128
     or v_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'vendor id is not canonical' using errcode = '22023';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 256 then
    raise exception 'vendor display name required' using errcode = '22023';
  end if;
  v_display := btrim(p_display_name);
  -- The representation membership interval is explicit and is never coalesced to
  -- the authorization date.
  if p_valid_from is null then raise exception 'vendor valid from required' using errcode = '22023'; end if;
  if p_valid_from > public.direct_entry_authorization_date() then raise exception 'future vendor memberships require explicit activation' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'vendor_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'vendor_id', v_vendor_id,
      'display_name', v_display,
      'valid_from', p_valid_from
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if exists (select 1 from public.vendors v where v.vendor_id = v_vendor_id) then
    raise exception 'vendor already exists' using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.vendors (vendor_id, display_name, active, version)
  values (v_vendor_id, v_display, true, 1)
  returning * into v_vendor;

  -- The canonical Vendor Direct Entry representation: exactly one recruiter row...
  insert into public.recruiters (display_name, active, version)
  values (v_display, true, 1)
  returning recruiter_id into v_recruiter_id;

  -- ...plus exactly one provider membership of provider_type 'vendor' that points
  -- at the new vendor. No team membership, no team and no scope is created.
  insert into public.recruiter_provider_memberships
    (recruiter_id, provider_type, vendor_id, valid_from, is_current)
  values
    (v_recruiter_id, 'vendor', v_vendor.vendor_id, p_valid_from, true);

  v_revision_id := public.direct_entry_write_vendor_revision(
    v_vendor.vendor_id, v_vendor.version, p_app_user_id, v_reason_id,
    null, public.direct_entry_vendor_snapshot(v_vendor)
  );

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, vendor_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'vendor_create', v_authority,
     v_vendor.vendor_id, 'all', 'APPLIED', v_reason_id,
     array['vendor_id', 'display_name', 'active'], v_revision_id);

  v_result := jsonb_build_object(
    'vendor_id', v_vendor.vendor_id,
    'display_name', v_vendor.display_name,
    'active', v_vendor.active,
    'version', v_vendor.version,
    'revision_id', v_revision_id,
    'recruiter_id', v_recruiter_id,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'vendor_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_create_worker_portrait_stage(p_auth_subject uuid, p_app_user_id uuid, p_stage_id uuid, p_mime_type text, p_size_bytes bigint, p_checksum_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_date date := public.direct_entry_authorization_date();
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.auth_subject = p_auth_subject and u.enabled
  ) then raise exception 'actor mapping denied' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability = 'document_upload'
       and g.is_current
  ) then raise exception 'capability denied' using errcode = '42501'; end if;
  if p_mime_type not in ('image/jpeg', 'image/png') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'portrait stage invalid' using errcode = '22023';
  end if;
  insert into public.direct_entry_worker_portrait_stages (
    stage_id, created_by_user_id, mime_type, size_bytes, checksum_sha256
  ) values (
    p_stage_id, p_app_user_id, p_mime_type, p_size_bytes, p_checksum_sha256
  ) returning * into v_stage;
  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
    'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
    'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_delete_draft_submission(p_auth_subject uuid, p_app_user_id uuid, p_submission_id uuid, p_expected_version integer, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_submission public.direct_entry_submissions%rowtype;
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_own_scope_count integer;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_deleted_at timestamptz := clock_timestamp();
  v_deleted_entries integer := 0;
  v_cleanup_objects integer := 0;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'submission_create'
  );

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.is_current;
  if v_own_scope_count <> 1 then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'submission_id', p_submission_id,
    'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_submission_delete', p_idempotency_key, v_request_hash
  );
  if v_prior is not null then return v_prior; end if;

  perform 1
    from public.direct_entries e
   where e.submission_id = p_submission_id and e.deleted_at is null
   order by e.entry_id
   for update;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found or v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.state <> 'DRAFT' then
    raise exception 'submission is not a draft' using errcode = '55000';
  end if;
  if p_expected_version is null or p_expected_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = '40001';
  end if;
  if exists (
    select 1 from public.direct_entry_worker_portrait_stages s
     where s.submission_id = p_submission_id and s.status = 'CLAIMED'
  ) then
    raise exception 'submission document processing' using errcode = '55P03';
  end if;
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.is_current;
  if v_own_scope_count <> 1 then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;

  v_before := jsonb_build_object(
    'state', v_submission.state,
    'version', v_submission.version,
    'entry_count', (
      select count(*)::int from public.direct_entries e
       where e.submission_id = p_submission_id and e.deleted_at is null
    ),
    'submitted_at', v_submission.submitted_at
  );
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Draft submission deletion');

  for v_entry in
    select e.* from public.direct_entries e
     where e.submission_id = p_submission_id and e.deleted_at is null
     order by e.entry_id
  loop
    v_scope := public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_entry.team_id, v_entry.first_work_date
    );
    if v_scope <> 'own' then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
    v_after := public.direct_entry_entry_snapshot(v_entry.entry_id);
    update public.direct_entries
       set deleted_at = v_deleted_at, version = version + 1
     where entry_id = v_entry.entry_id;
    v_revision_id := public.direct_entry_write_revision(
      v_entry.entry_id, p_app_user_id, v_reason_id, v_after,
      public.direct_entry_entry_snapshot(v_entry.entry_id), v_entry.version + 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'draft_submission_delete', 'submission_create',
      v_entry.entry_id::text, 'own', 'APPLIED', v_reason_id, v_revision_id,
      array['deleted_at']
    );
    v_deleted_entries := v_deleted_entries + 1;
  end loop;

  insert into public.direct_entry_submission_object_cleanup (
    submission_id, object_kind, stage_id
  )
  select p_submission_id, 'PORTRAIT_STAGE', s.stage_id
    from public.direct_entry_worker_portrait_stages s
   where s.submission_id = p_submission_id and s.status = 'ATTACHED'
  on conflict do nothing;

  insert into public.direct_entry_submission_object_cleanup (
    submission_id, object_kind, document_id, storage_key
  )
  select p_submission_id, kinds.object_kind, d.document_id, d.storage_key
    from public.direct_entry_document_versions d
    join public.direct_entries e on e.candidate_id = d.candidate_id
    cross join (values ('DOCUMENT_STAGED'), ('DOCUMENT_FINAL')) as kinds(object_kind)
   where e.submission_id = p_submission_id
     and not exists (
       select 1 from public.direct_entries other
        where other.candidate_id = d.candidate_id
          and other.submission_id <> p_submission_id
     )
  on conflict do nothing;

  update public.direct_entry_submissions
     set state = 'DELETED', version = version + 1
   where submission_id = p_submission_id;
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    p_submission_id, p_app_user_id, v_reason_id, v_before,
    jsonb_build_object(
      'state', 'DELETED',
      'version', v_submission.version + 1,
      'entry_count', 0,
      'deleted_entry_count', v_deleted_entries,
      'deleted_at', v_deleted_at
    ),
    v_submission.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_submission_delete', 'submission_create',
    p_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['state', 'entries_deleted']
  );

  select count(*)::int into v_cleanup_objects
    from public.direct_entry_submission_object_cleanup c
   where c.submission_id = p_submission_id and c.cleanup_completed_at is null;
  v_result := jsonb_build_object(
    'submission_id', p_submission_id,
    'deleted', true,
    'version', v_submission.version + 1,
    'entries_deleted', v_deleted_entries,
    'cleanup_objects_queued', v_cleanup_objects
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_submission_delete', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_document_direct_context(p_auth_subject uuid, p_app_user_id uuid, p_entry_id uuid, p_document_id uuid, p_purpose text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_entry public.direct_entries%rowtype;
  v_document public.direct_entry_document_versions%rowtype;
  v_scope text;
  v_latest public.direct_entry_document_events%rowtype;
begin
  if p_purpose not in ('finalize', 'download', 'preview', 'cccd_preview') then
    raise exception 'invalid document context purpose' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  if p_purpose = 'finalize' then
    perform public.direct_entry_assert_document_upload_access(
      p_auth_subject, p_app_user_id, p_entry_id
    );
  else
    if p_purpose = 'download' then
      perform public.direct_entry_assert_document_download_access(
        p_auth_subject, p_app_user_id, v_entry.entry_id, p_document_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    elsif p_purpose = 'cccd_preview' then
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found or v_document.document_type not in ('CCCD_FRONT', 'CCCD_BACK') then
        raise exception 'document is not a CCCD image' using errcode = 'P0002';
      end if;
      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'document_view',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    else
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found then
        raise exception 'document not found' using errcode = 'P0002';
      end if;
      if v_document.document_type <> 'WORKER_PORTRAIT' then
        raise exception 'private preview is portrait-only' using errcode = 'P0002';
      end if;
      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'entry_privileged_edit',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    end if;
    if not exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = p_app_user_id and g.capability = 'document_view'
         and g.is_current
    ) then
      raise exception 'document view denied' using errcode = '42501';
    end if;
  end if;
  select * into v_document from public.direct_entry_document_versions d
   where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  select * into v_latest from public.direct_entry_document_events e
   where e.document_id = p_document_id order by e.version desc limit 1;
  if p_purpose = 'download' and v_document.document_type = 'WORKER_PORTRAIT' then
    raise exception 'portrait requires private preview' using errcode = 'P0002';
  end if;
  if p_purpose = 'preview' and (
    v_document.document_type <> 'WORKER_PORTRAIT'
    or not exists (
      select 1 from public.direct_entry_current_documents cd
       where cd.document_id = p_document_id
         and cd.candidate_id = v_entry.candidate_id
         and cd.document_type = 'WORKER_PORTRAIT'
    )
  ) then
    raise exception 'portrait is not current' using errcode = 'P0002';
  end if;
  if p_purpose in ('download', 'preview', 'cccd_preview') and not (
    v_latest.upload_status = 'READY' and v_latest.validation_status = 'VALIDATED'
    and v_latest.scan_status in ('CLEAN', 'NOT_REQUIRED')
  ) then
    raise exception 'document not eligible' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'document_id', v_document.document_id, 'document_type', v_document.document_type,
    'version', v_document.version, 'storage_key', v_document.storage_key,
    'size_bytes', coalesce((
      select o.size_bytes from public.direct_entry_document_objects o
       where o.document_id = v_document.document_id
    ), v_document.size_bytes),
    'mime_type', v_document.mime_type,
    'checksum_sha256', (
      select o.checksum_sha256 from public.direct_entry_document_objects o
       where o.document_id = v_document.document_id
    ),
    'upload_status', v_latest.upload_status, 'scan_status', v_latest.scan_status,
    'validation_status', v_latest.validation_status, 'entry_version', v_entry.version
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_get_personnel_admin(p_auth_subject uuid, p_app_user_id uuid, p_recruiter_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_personnel jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
  if p_recruiter_id is null then
    raise exception 'personnel required' using errcode = '22023';
  end if;

  select public.direct_entry_personnel_admin_projection(r, hrp.valid_from, rev.revision_count)
    into v_personnel
    from public.recruiters r
    left join lateral (
      select m.valid_from
        from public.recruiter_provider_memberships m
       where m.recruiter_id = r.recruiter_id
         and m.provider_type = 'hrp'
         and m.vendor_id is null
         and m.is_current
       order by m.valid_from desc
       limit 1
    ) hrp on true
    left join lateral (
      select count(*)::int as revision_count
        from public.direct_entry_personnel_revisions v
       where v.recruiter_id = r.recruiter_id
    ) rev on true
   where r.recruiter_id = p_recruiter_id
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and m.is_current
     );

  if v_personnel is null then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;
  return v_personnel;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_grant_project_team_scope(p_auth_subject uuid, p_app_user_id uuid, p_project_id text, p_team_id uuid, p_expected_pair_version integer, p_effective_from date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_project public.direct_entry_projects;
  v_team public.teams;
  v_effective_from date;
  v_current_version integer;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_mapping public.direct_entry_project_team_scopes;
  v_result jsonb;
begin
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_expected_pair_version is null or p_expected_pair_version < 0 then
    raise exception 'expected mapping version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Canonical Full Admin triple at effective all scope; resolved server-side only.
  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_effective_from := coalesce(p_effective_from, public.direct_entry_authorization_date());
  if v_effective_from > public.direct_entry_authorization_date() then raise exception 'future project-team scopes require explicit activation' using errcode = '22023'; end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'project_id', p_project_id,
    'team_id', p_team_id,
    'expected_pair_version', p_expected_pair_version,
    'valid_from', v_effective_from,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_grant', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Lock order: project row first, then the target team row.
  select p.* into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  if not v_project.active then
    raise exception 'project is not active' using errcode = '22023';
  end if;

  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if not v_team.active or v_team.code = '__system_vendor__' then
    raise exception 'team is not active' using errcode = '22023';
  end if;

  select coalesce(max(s.version), 0)::int into v_current_version
    from public.direct_entry_project_team_scopes s
   where s.project_id = p_project_id
     and s.team_id = p_team_id;
  if v_current_version <> p_expected_pair_version then
    raise exception 'project team mapping version conflict' using errcode = '40001';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_project_team_scopes (
    project_id, team_id, valid_from, valid_to, version,
    granted_by_user_id, reason_id
  , is_current) values (
    p_project_id, p_team_id, v_effective_from, null, v_current_version + 1,
    p_app_user_id, v_reason_id
  , true) returning * into v_mapping;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_team_scope_grant', v_authority,
     v_mapping.mapping_id::text, 'all', 'APPLIED', v_reason_id,
     array['project_id', 'team_id', 'valid_from']);

  v_result := jsonb_build_object(
    'mapping_id', v_mapping.mapping_id,
    'project_id', v_mapping.project_id,
    'team_id', v_mapping.team_id,
    'valid_from', v_mapping.valid_from,
    'valid_to', v_mapping.valid_to,
    'version', v_mapping.version,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_grant', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_grant_project_team_scopes_batch(p_auth_subject uuid, p_app_user_id uuid, p_team_id uuid, p_project_ids text[], p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_project_ids text[];
  v_project_id text;
  v_project_count integer;
  v_team public.teams;
  v_effective_from date := public.direct_entry_authorization_date();
  v_current_version integer;
  v_mapping public.direct_entry_project_team_scopes;
  v_reason_id uuid;
  v_created jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_payload_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_project_ids is null or cardinality(p_project_ids) not between 1 and 100
     or array_position(p_project_ids, null) is not null
     or exists (
       select 1 from unnest(p_project_ids) ids(project_id)
        where ids.project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     )
     or (select count(*) from unnest(p_project_ids)) <>
        (select count(distinct ids.project_id) from unnest(p_project_ids) ids(project_id)) then
    raise exception 'project batch is invalid' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  select array_agg(ids.project_id order by ids.project_id)
    into v_project_ids
    from unnest(p_project_ids) ids(project_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'team_id', p_team_id,
    'project_ids', to_jsonb(v_project_ids),
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_batch_grant', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  perform p.project_id
    from public.direct_entry_projects p
   where p.project_id = any(v_project_ids)
   order by p.project_id
   for update;
  select count(*)::int into v_project_count
    from public.direct_entry_projects p
   where p.project_id = any(v_project_ids);
  if v_project_count <> cardinality(v_project_ids) then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.direct_entry_projects p
     where p.project_id = any(v_project_ids) and not p.active
  ) then
    raise exception 'project is not active' using errcode = '22023';
  end if;

  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if not v_team.active or v_team.code = '__system_vendor__' then
    raise exception 'team is not active' using errcode = '22023';
  end if;

  for v_project_id in
    select ids.project_id from unnest(v_project_ids) ids(project_id) order by ids.project_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('project-team-scope:' || v_project_id, 0));
  end loop;

  for v_project_id in select unnest(v_project_ids) order by 1 loop
    select s.* into v_mapping
      from public.direct_entry_project_team_scopes s
     where s.project_id = v_project_id
       and s.team_id = p_team_id
       and s.is_current
     order by s.valid_from desc, s.mapping_id desc
     limit 1;
    if found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'project_id', v_project_id,
        'status', 'ALREADY_EFFECTIVE',
        'mapping_id', v_mapping.mapping_id,
        'version', v_mapping.version
      ));
      continue;
    end if;

    select coalesce(max(s.version), 0)::int into v_current_version
      from public.direct_entry_project_team_scopes s
     where s.project_id = v_project_id and s.team_id = p_team_id;
    if v_reason_id is null then
      v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
    end if;
    insert into public.direct_entry_project_team_scopes (
      project_id, team_id, valid_from, valid_to, version,
      granted_by_user_id, reason_id
    , is_current) values (
      v_project_id, p_team_id, v_effective_from, null, v_current_version + 1,
      p_app_user_id, v_reason_id
    , true) returning * into v_mapping;

    insert into public.direct_entry_audit_events
      (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
       outcome, reason_id, changed_fields)
    values
      (p_auth_subject, p_app_user_id, 'project_team_scope_grant', v_authority,
       v_mapping.mapping_id::text, 'all', 'APPLIED', v_reason_id,
       array['project_id', 'team_id', 'valid_from']);

    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'mapping_id', v_mapping.mapping_id,
      'project_id', v_mapping.project_id,
      'team_id', v_mapping.team_id,
      'valid_from', v_mapping.valid_from,
      'valid_to', v_mapping.valid_to,
      'version', v_mapping.version,
      'created', true
    ));
  end loop;

  v_result := jsonb_build_object(
    'team_id', p_team_id,
    'effective_from', v_effective_from,
    'created', v_created,
    'skipped', v_skipped
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_batch_grant', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_input_catalog_unscoped_v42(p_auth_subject uuid, p_app_user_id uuid, p_effective_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_result jsonb;
begin
  if p_effective_date is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;
  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) or not exists (
    select 1
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability in ('entry_create', 'entry_own')
       and g.is_current
  ) then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  with hrp_memberships as (
    -- P1.6 contract (unchanged from #41): an HRP recruiter is eligible only
    -- when they have exactly one HRP provider membership in force on
    -- `effective_date`. Overlapping HRP memberships are excluded.
    select m.recruiter_id, count(*) as membership_count
      from public.recruiter_provider_memberships m
     where m.provider_type = 'hrp'
       and m.is_current
     group by m.recruiter_id
  ), vendor_memberships as (
    -- P3-W07A (unchanged from #41): Vendor eligibility is decided by
    -- `provider_type = 'vendor'` membership at `effective_date`. The
    -- catalog surfaces the active membership; overlapping memberships
    -- are filtered by the effective-date window.
    select m.recruiter_id, m.vendor_id
      from public.recruiter_provider_memberships m
     where m.provider_type = 'vendor'
       and m.is_current
  ), hrp_teams as (
    select m.recruiter_id, count(*) as membership_count,
           min(m.team_id::text)::uuid as team_id
      from public.recruiter_team_memberships m
     where m.is_current
     group by m.recruiter_id
  ), hrp_recruiters as (
    select r.recruiter_id, r.display_name, r.personnel_code, tt.team_id,
           team.display_name as team_display_name
      from public.recruiters r
      join hrp_memberships p on p.recruiter_id = r.recruiter_id
                            and p.membership_count = 1
      join hrp_teams tt on tt.recruiter_id = r.recruiter_id
                        and tt.membership_count = 1
      join public.teams team on team.team_id = tt.team_id and team.active
     where r.active
  ), vendor_recruiters as (
    select r.recruiter_id, r.display_name, vm.vendor_id,
           v.display_name as vendor_display_name
      from public.recruiters r
      join vendor_memberships vm on vm.recruiter_id = r.recruiter_id
      left join public.vendors v on v.vendor_id = vm.vendor_id and v.active
     where r.active
       -- Vendor recruiters without a `vendor_id` on the membership are
       -- legacy P1.6 bootstrap rows; they still appear in the catalog with
       -- the recruiter display_name as the label until the W07A importer
       -- links them to a vendor record.
       and (vm.vendor_id is null or v.vendor_id is not null)
  )
  select jsonb_build_object(
    'effective_date', p_effective_date,
    'labor_types', public.direct_entry_labor_type_options(),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project_id', p.project_id, 'display_name', p.display_name
      ) order by p.display_name, p.project_id)
        from public.direct_entry_projects p
       where p.active
    ), '[]'::jsonb),
    'recruiters', coalesce((
      select coalesce(jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', r.display_name,
        'personnel_code', r.personnel_code,
        'provider_type', 'hrp',
        'vendor_id', null,
        'team_id', r.team_id,
        'team_display_name', r.team_display_name,
        'label', (
          r.display_name
          || ' · ' || coalesce(r.personnel_code, '—')
          || ' · ' || r.team_display_name
        )
      ) order by r.display_name, r.team_display_name, r.recruiter_id), '[]'::jsonb)
        from hrp_recruiters r
    ) || coalesce((
      select jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', coalesce(r.vendor_display_name, r.display_name),
        'personnel_code', null,
        'provider_type', 'vendor',
        'vendor_id', r.vendor_id,
        'team_id', null,
        'team_display_name', null,
        'label', coalesce(r.vendor_display_name, r.display_name)
      ) order by coalesce(r.vendor_display_name, r.display_name), r.recruiter_id)
        from vendor_recruiters r
    ), '[]'::jsonb), '[]'::jsonb),
    -- P3-W07A-R2: restore the `banks` key that migration #41 dropped.
    -- Active banks only, ordered for determinism, may be empty.
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
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_app_users_admin(p_auth_subject uuid, p_app_user_id uuid, p_search text DEFAULT NULL::text, p_enabled text DEFAULT 'all'::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_search text;
  v_total integer;
  v_accounts jsonb;
  v_offset integer;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_search is not null and (btrim(p_search) = '' or length(p_search) > 256)
     or p_enabled is null or p_enabled not in ('all', 'true', 'false')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'account list query is invalid' using errcode = '22023';
  end if;
  v_search := nullif(btrim(p_search), '');
  v_offset := (p_page - 1) * p_page_size;

  select count(*)::integer into v_total
    from public.direct_entry_app_users u
    join auth.users au on au.id = u.auth_subject
    left join lateral (
      select r.display_name
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified
         and l.is_current
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where (v_search is null
       or coalesce(linked.display_name, u.display_name) ilike '%' || v_search || '%'
       or split_part(au.email, '@', 1) ilike '%' || v_search || '%')
     and (p_enabled = 'all'
       or (p_enabled = 'true' and u.enabled)
       or (p_enabled = 'false' and not u.enabled));

  select coalesce(jsonb_agg(public.direct_entry_app_user_projection(account_row.app_user)
                           order by account_row.resolved_name, account_row.resolved_login), '[]'::jsonb)
    into v_accounts
    from (
      select u as app_user,
             u.*,
             coalesce(linked.display_name, u.display_name) as resolved_name,
             split_part(au.email, '@', 1) as resolved_login
        from public.direct_entry_app_users u
        join auth.users au on au.id = u.auth_subject
        left join lateral (
          select r.display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified
             and l.is_current
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
       where (v_search is null
           or coalesce(linked.display_name, u.display_name) ilike '%' || v_search || '%'
           or split_part(au.email, '@', 1) ilike '%' || v_search || '%')
         and (p_enabled = 'all'
           or (p_enabled = 'true' and u.enabled)
           or (p_enabled = 'false' and not u.enabled))
       order by coalesce(linked.display_name, u.display_name), split_part(au.email, '@', 1)
       limit p_page_size offset v_offset
    ) account_row;

  return jsonb_build_object(
    'search', v_search,
    'enabled', p_enabled,
    'page', p_page,
    'page_size', p_page_size,
    'total', v_total,
    'accounts', v_accounts
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_own_drafts(p_auth_subject uuid, p_app_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_result jsonb;
  v_count integer;
  v_employment_apply boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_employment_apply := exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability = 'employment_status.apply'
       and g.is_current
  );

  select count(*) into v_count
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where s.state = 'DRAFT'
     and e.deleted_at is null
     and public.direct_entry_resolve_draft_scope(
       p_auth_subject, p_app_user_id, e.entry_id
     ) is not null;
  if v_count > 500 then
    raise exception 'draft list exceeds supported size' using errcode = '54000';
  end if;

  with eligible as materialized (
    select e.*, s.version as submission_version,
           (s.created_by_user_id = p_app_user_id and e.created_by_user_id = p_app_user_id)
             as own_submission,
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
       and public.direct_entry_resolve_draft_scope(
         p_auth_subject, p_app_user_id, e.entry_id
       ) is not null
  ),
  authorized as materialized (
    select e.*,
           public.direct_entry_resolve_draft_scope(
             p_auth_subject, p_app_user_id, e.entry_id
           ) as resolved_scope
      from eligible e
  )
  select jsonb_build_object(
    'projection_version', 'direct-entry-draft-list/2',
    'drafts', coalesce(jsonb_agg(jsonb_build_object(
      'submission_id', e.submission_id,
      'submission_version', e.submission_version,
      'entry_id', e.entry_id,
      'entry_version', e.version,
      'employee_code', e.employee_code,
      'first_work_date', e.first_work_date,
      'worker_display_name', case when e.own_submission then e.worker_details->>'display_name' else '' end,
      'project_id', e.project_id,
      'project_display_name', e.project_display_name,
      'recruiter_id', e.recruiter_id,
      'recruiter_display_name', e.recruiter_display_name,
      'provider_type', e.provider_type,
      'team_id', e.team_id,
      'team_display_name', case when e.provider_type = 'vendor'
        then 'Không áp dụng' else e.team_display_name end,
      'labor_type', e.labor_type,
      'labor_type_display', (select lt.display_name from public.direct_entry_labor_types lt
        where lt.labor_type_key = e.labor_type),
      'employment_status', status.status,
      'created_at', e.created_at,
      'updated_at', e.updated_at,
      'profile', jsonb_build_object(
        'contract_version', 'worker-profile/1.0',
        'worker_details', jsonb_build_object(
          'display_name', case when e.own_submission then jsonb_build_object(
            'state', 'provided', 'value', e.worker_details->>'display_name'
          ) else jsonb_build_object('state', 'redacted', 'present', true) end,
          'gender', public.direct_entry_draft_profile_field(e.worker_details->'gender', e.own_submission),
          'date_of_birth', public.direct_entry_draft_profile_field(e.worker_details->'date_of_birth', e.own_submission),
          'national_id', public.direct_entry_draft_profile_field(e.worker_details->'national_id', e.own_submission),
          'national_id_issued_at', public.direct_entry_draft_profile_field(e.worker_details->'national_id_issued_at', e.own_submission),
          'national_id_issued_place', public.direct_entry_draft_profile_field(e.worker_details->'national_id_issued_place', e.own_submission),
          'address', public.direct_entry_draft_profile_field(e.worker_details->'address', e.own_submission),
          'phone', public.direct_entry_draft_profile_field(e.worker_details->'phone', e.own_submission)
        ),
        'general_note', case
          when e.general_note is null then jsonb_build_object('state', 'omitted')
          when e.own_submission then jsonb_build_object('state', 'provided', 'value', e.general_note)
          else jsonb_build_object('state', 'redacted', 'present', true)
        end,
        'employment', case when status.version is null then null else jsonb_build_object(
            'status', status.status,
            'effective_date', status.effective_date,
            'version', status.version,
            'leave_date', case
              when status.leave_date is null then jsonb_build_object('state', 'omitted')
              when not (v_employment_apply or e.own_submission)
                then jsonb_build_object('state', 'omitted')
              when e.own_submission
                then jsonb_build_object('state', 'provided', 'value', status.leave_date)
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'leave_reason_text', case
              when status.leave_reason_text is null then jsonb_build_object('state', 'omitted')
              when not (v_employment_apply or e.own_submission)
                then jsonb_build_object('state', 'omitted')
              when e.own_submission
                then jsonb_build_object('state', 'provided', 'value', status.leave_reason_text)
              else jsonb_build_object('state', 'redacted', 'present', true)
            end
          ) end,
        'payment', case when payment.entry_id is null then null else jsonb_build_object(
            'state', payment.state,
            'account_number', case
              when payment.account_number is null then jsonb_build_object('state', 'omitted')
              when e.own_submission then jsonb_build_object(
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
              when e.own_submission then jsonb_build_object(
                'state', 'provided', 'value', payment.bank_name
              )
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'account_holder_name', case
              when payment.account_holder_name is null then jsonb_build_object('state', 'omitted')
              when e.own_submission then jsonb_build_object(
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
   where e.resolved_scope in ('own', 'team', 'all', 'project');

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_own_submissions(p_auth_subject uuid, p_app_user_id uuid, p_page_size integer, p_cursor text, p_state text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_page_size integer;
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_own_scope_count integer;
  v_can_list_own boolean := false;
  v_has_project_assignment boolean := false;
  v_scanned integer;
  v_items jsonb;
  v_next_cursor text;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.is_current;
  v_can_list_own := v_own_scope_count = 1
    and public.direct_entry_has_capability(p_app_user_id, 'submission_create');
  v_has_project_assignment := public.direct_entry_actor_has_project_assignment(p_app_user_id);
  if not v_can_list_own and not v_has_project_assignment then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  v_page_size := coalesce(p_page_size, 20);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_state is not null and p_state not in
       ('DRAFT', 'REVIEW', 'SUBMITTED', 'ACTIVE', 'HISTORY') then
    raise exception 'invalid submission state filter' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select s.submission_id,
           s.state,
           s.version,
           s.created_at,
           s.updated_at,
           s.submitted_at,
           not (v_can_list_own and s.created_by_user_id = p_app_user_id) as project_scoped
      from public.direct_entry_submissions s
     where s.state <> 'DELETED' and (
             (v_can_list_own and s.created_by_user_id = p_app_user_id)
             or (
               s.state = 'SUBMITTED'
               and v_has_project_assignment
               and exists (
                 select 1 from public.direct_entries e
                  where e.submission_id = s.submission_id
                    and e.deleted_at is null
                    and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
               )
             )
           )
       and (p_state is null
         or (p_state = 'ACTIVE' and s.state in ('DRAFT', 'REVIEW'))
         or (p_state = 'HISTORY' and s.state = 'SUBMITTED')
         or s.state = p_state)
       and (
         v_cursor_stamp is null
         or (
              pg_catalog.to_char(s.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
              s.submission_id::text
            ) < (v_cursor_stamp, v_cursor_id::text)
       )
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
             || ':' || c.submission_id::text as cursor
      from candidates c
     order by c.created_at desc, c.submission_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by created_at desc, submission_id desc limit v_page_size
  )
  select
    (select count(*)::int from page),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
               'submission_id', t.submission_id,
               'state', t.state,
               'version', t.version,
               'entry_count', (
                 select count(*)::int from public.direct_entries e
                  where e.submission_id = t.submission_id and e.deleted_at is null
                     and (not t.project_scoped or
                       public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
                ),
                'project_scoped', t.project_scoped,
               'created_at',
                 pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.created_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'updated_at',
                 pg_catalog.to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.updated_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'submitted_at', case when t.submitted_at is null then null else
                 pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z' end,
               'allowed_transitions', case t.state
                 when 'DRAFT' then jsonb_build_array('SUBMITTED')
                 when 'REVIEW' then jsonb_build_array('DRAFT', 'SUBMITTED')
                 else jsonb_build_array()
               end
             ) order by t.created_at desc, t.submission_id desc), '[]'::jsonb)
        from trimmed t
    ),
    (
      select t.cursor from trimmed t
       order by t.created_at asc, t.submission_id asc limit 1
    )
  into v_scanned, v_items, v_next_cursor;

  v_has_more := v_scanned > v_page_size;
  return jsonb_build_object(
    'items', v_items,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor', case when v_has_more then v_next_cursor else null end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_personnel_admin(p_auth_subject uuid, p_app_user_id uuid, p_search text DEFAULT NULL::text, p_include_inactive boolean DEFAULT true, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_search text;
  v_include_inactive boolean := coalesce(p_include_inactive, true);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_personnel jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid personnel search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  -- HRP boundary: this catalog is exactly the recruiters holding a canonical
  -- effective HRP provider membership (provider_type = 'hrp', vendor_id is null).
  -- Vendor recruiters are never counted here, and a team membership is not required.
  select count(*)::int into v_total
    from public.recruiters r
   where (v_include_inactive or r.active)
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and m.is_current
     )
     and (
       v_search is null
       or r.display_name ilike '%' || v_search || '%'
       or coalesce(r.personnel_code, '') ilike '%' || v_search || '%'
     );

  -- Deterministic order and a hard page bound. No team join at all: personnel
  -- with zero active team membership stay visible in the admin catalog.
  select coalesce(jsonb_agg(t.personnel), '[]'::jsonb)
    into v_personnel
    from (
      select public.direct_entry_personnel_admin_projection(
               r, hrp.valid_from, rev.revision_count
             ) as personnel,
             r.display_name,
             r.recruiter_id
        from public.recruiters r
        left join lateral (
          select m.valid_from
            from public.recruiter_provider_memberships m
           where m.recruiter_id = r.recruiter_id
             and m.provider_type = 'hrp'
             and m.vendor_id is null
             and m.is_current
           order by m.valid_from desc
           limit 1
        ) hrp on true
        left join lateral (
          select count(*)::int as revision_count
            from public.direct_entry_personnel_revisions v
           where v.recruiter_id = r.recruiter_id
        ) rev on true
       where (v_include_inactive or r.active)
         and exists (
           select 1
             from public.recruiter_provider_memberships m
            where m.recruiter_id = r.recruiter_id
              and m.provider_type = 'hrp'
              and m.vendor_id is null
              and m.is_current
         )
         and (
           v_search is null
           or r.display_name ilike '%' || v_search || '%'
           or coalesce(r.personnel_code, '') ilike '%' || v_search || '%'
         )
       order by r.display_name, r.recruiter_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) t;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_inactive', v_include_inactive,
    'search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'personnel', v_personnel
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_project_manager_assignments(p_auth_subject uuid, p_app_user_id uuid, p_project_id text DEFAULT NULL::text, p_include_history boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_team_id uuid;
  v_assignments jsonb;
  v_active integer;
  v_project_version integer;
  v_project_active boolean;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;

  if p_project_id is not null then
    select p.version, p.active into v_project_version, v_project_active
      from public.direct_entry_projects p
     where p.project_id = p_project_id;
    if v_project_version is null then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    if v_authority = 'team_manager_assign'
       and (not v_project_active
            or not public.direct_entry_project_team_scope_effective(p_project_id, v_team_id)) then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'assignment_id', a.assignment_id,
      'project_id', a.project_id,
      'project_version', p.version,
      'manager_recruiter_id', a.manager_recruiter_id,
      'valid_from', a.valid_from,
      'valid_to', a.valid_to,
      'effective', a.is_current and a.revoked_at is null,
      'version', a.version,
      'revoked_at', a.revoked_at,
      'created_at', a.created_at,
      'updated_at', a.updated_at
    ) order by a.project_id, a.valid_from, a.assignment_id), '[]'::jsonb)
    into v_assignments
    from public.direct_entry_project_manager_assignments a
    join public.direct_entry_projects p on p.project_id = a.project_id
   where (p_project_id is null or a.project_id = p_project_id)
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(a.project_id, v_team_id)
     )
     and (p_include_history or (a.is_current and a.revoked_at is null))
     and (
       v_authority <> 'team_manager_assign'
       or (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.is_current
       ) = 1
     )
     and (
       v_authority <> 'team_manager_assign'
       or exists (
         select 1
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.team_id = v_team_id
            and m.is_current
       )
     );

  select count(*)::int into v_active
    from public.direct_entry_project_manager_assignments a
   where (p_project_id is null or a.project_id = p_project_id)
     and (
       v_authority <> 'team_manager_assign'
       or public.direct_entry_project_team_scope_effective(a.project_id, v_team_id)
     )
     and a.is_current and a.revoked_at is null
     and (
       v_authority <> 'team_manager_assign'
       or (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.is_current
       ) = 1
     )
     and (
       v_authority <> 'team_manager_assign'
       or exists (
         select 1
           from public.recruiter_team_memberships m
          where m.recruiter_id = a.manager_recruiter_id
            and m.team_id = v_team_id
            and m.is_current
       )
     );

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'project_id', p_project_id,
    'project_version', v_project_version,
    'project_active', v_project_active,
    'include_history', p_include_history,
    'active_assignment_count', v_active,
    'assignments', v_assignments
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_project_manager_candidates(p_auth_subject uuid, p_app_user_id uuid, p_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_team_id uuid;
  v_candidates jsonb;
begin
  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;

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
              and l.is_current
         )
         and (
           v_authority <> 'team_manager_assign'
           or (
             select count(*)::int
               from public.direct_entry_app_user_recruiter_links l
              where l.recruiter_id = r.recruiter_id
                and l.verified
                and l.is_current
           ) = 1
         )
         and (
           v_authority <> 'team_manager_assign'
           or exists (
             select 1
               from public.direct_entry_app_user_recruiter_links l
               join public.direct_entry_app_users au on au.app_user_id = l.app_user_id
              where l.recruiter_id = r.recruiter_id
                and l.verified
                and l.is_current
                and au.enabled
                and au.auth_subject is not null
           )
         )
         and (
           v_authority <> 'team_manager_assign'
           or (
             select count(*)::int
               from public.recruiter_provider_memberships m
              where m.recruiter_id = r.recruiter_id
                and m.is_current
           ) = 1
           and (
             select count(*)::int
               from public.recruiter_provider_memberships m
              where m.recruiter_id = r.recruiter_id
                and m.provider_type = 'hrp'
                and m.vendor_id is null
                and m.is_current
           ) = 1
         )
         and (
           v_authority <> 'team_manager_assign'
           or (
             select count(*)::int
               from public.recruiter_team_memberships m
              where m.recruiter_id = r.recruiter_id
                and m.is_current
           ) = 1
         )
         and (
           v_authority <> 'team_manager_assign'
           or exists (
             select 1
               from public.recruiter_team_memberships m
              where m.recruiter_id = r.recruiter_id
                and m.team_id = v_team_id
                and m.is_current
           )
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
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_project_team_scopes_admin(p_auth_subject uuid, p_app_user_id uuid, p_project_id text DEFAULT NULL::text, p_team_id uuid DEFAULT NULL::uuid, p_include_history boolean DEFAULT false, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_include_history boolean := coalesce(p_include_history, false);
  v_offset integer;
  v_total integer;
  v_mappings jsonb;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  if p_project_id is not null and length(btrim(p_project_id)) = 0 then
    raise exception 'project filter is invalid' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  select count(*)::int into v_total
    from public.direct_entry_project_team_scopes s
   where (p_project_id is null or s.project_id = p_project_id)
     and (p_team_id is null or s.team_id = p_team_id)
     and (v_include_history or s.valid_to is null);

  select coalesce(jsonb_agg(page_rows.projection
      order by page_rows.project_id, page_rows.team_id, page_rows.valid_from desc,
               page_rows.mapping_id), '[]'::jsonb)
    into v_mappings
    from (
      select jsonb_build_object(
          'mapping_id', s.mapping_id,
          'project_id', s.project_id,
          'project_display_name', p.display_name,
          'team_id', s.team_id,
          'team_display_name', t.display_name,
          'team_code', t.code,
          'valid_from', to_jsonb(s.valid_from),
          'valid_to', to_jsonb(s.valid_to),
          'effective', s.is_current,
          'state', case
            when s.is_current then 'CURRENT'
            when s.valid_from > public.direct_entry_authorization_date() then 'SCHEDULED'
            else 'HISTORY'
          end,
          'version', s.version,
          'revoked_at', s.revoked_at,
          'created_at', s.created_at
        ) as projection,
        s.project_id, s.team_id, s.valid_from, s.mapping_id
        from public.direct_entry_project_team_scopes s
        join public.direct_entry_projects p on p.project_id = s.project_id
        join public.teams t on t.team_id = s.team_id
       where (p_project_id is null or s.project_id = p_project_id)
         and (p_team_id is null or s.team_id = p_team_id)
         and (v_include_history or s.valid_to is null)
       order by s.project_id, s.team_id, s.valid_from desc, s.mapping_id
       limit v_page_size + 1 offset v_offset
    ) page_rows;

  v_has_more := jsonb_array_length(v_mappings) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(trimmed.value order by trimmed.ord), '[]'::jsonb) into v_mappings
      from jsonb_array_elements(v_mappings) with ordinality as trimmed(value, ord)
     where trimmed.ord <= v_page_size;
  end if;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'include_history', v_include_history,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'has_more', v_has_more,
    'mappings', v_mappings
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_team_leader_candidates(p_auth_subject uuid, p_app_user_id uuid, p_team_id uuid, p_search text DEFAULT NULL::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_candidates jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_team_id is null or not exists (
    select 1 from public.teams t
     where t.team_id = p_team_id
       and t.active
       and t.code <> '__system_vendor__'
  ) then
    raise exception 'team leader candidates unavailable' using errcode = 'P0002';
  end if;
  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid team leader candidate search' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');

  with eligible as (
    select u.app_user_id, links.recruiter_id, r.display_name, r.personnel_code
      from public.direct_entry_app_users u
      cross join lateral (
        select count(*)::int as link_count,
               count(*) filter (where l.verified)::int as verified_link_count,
               (array_agg(l.recruiter_id order by l.link_id)
                 filter (where l.verified))[1] as recruiter_id
          from public.direct_entry_app_user_recruiter_links l
         where l.app_user_id = u.app_user_id
           and l.is_current
      ) links
      join public.recruiters r on r.recruiter_id = links.recruiter_id
      cross join lateral (
        select count(*)::int as provider_count,
               count(*) filter (
                 where m.provider_type = 'hrp' and m.vendor_id is null
               )::int as hrp_count
          from public.recruiter_provider_memberships m
         where m.recruiter_id = r.recruiter_id
           and m.is_current
      ) providers
      cross join lateral (
        select count(*)::int as membership_count,
               count(*) filter (where m.team_id = p_team_id)::int as target_count
          from public.recruiter_team_memberships m
         where m.recruiter_id = r.recruiter_id
           and m.is_current
      ) memberships
     where u.enabled
       and r.active
       and links.link_count = 1
       and links.verified_link_count = 1
       and providers.provider_count = 1
       and providers.hrp_count = 1
       and memberships.membership_count = 1
       and memberships.target_count = 1
       and not exists (
         select 1 from public.direct_entry_team_leader_assignments a
          where a.leader_app_user_id = u.app_user_id
            and a.is_current
       )
       and not exists (
         select 1 from public.direct_entry_scope_grants s
          where s.app_user_id = u.app_user_id
            and s.scope_kind = 'team'
            and s.is_current
       )
       and not exists (
         select 1 from public.direct_entry_capability_grants g
          where g.app_user_id = u.app_user_id
            and g.capability = 'team_manager_assign'
            and g.is_current
       )
  ), filtered as (
    select * from eligible
     where v_search is null
        or display_name ilike '%' || v_search || '%'
        or coalesce(personnel_code, '') ilike '%' || v_search || '%'
  ), page_rows as (
    select * from filtered
     order by display_name, app_user_id
     limit v_page_size offset (v_page - 1) * v_page_size
  )
  select (select count(*)::int from filtered),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'app_user_id', app_user_id,
             'display_name', display_name,
             'personnel_code', personnel_code
           ) order by display_name, app_user_id)
             from page_rows
         ), '[]'::jsonb)
    into v_total, v_candidates;

  return jsonb_build_object(
    'authorization_date', v_today,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'candidates', v_candidates
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_team_leaders_current(p_auth_subject uuid, p_app_user_id uuid, p_team_id uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_effective_team_id uuid := public.direct_entry_assert_team_leader_read_authority(p_auth_subject, p_app_user_id, p_team_id);
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_leaders jsonb;
begin
  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid team leader search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.direct_entry_team_leader_assignments a
    join public.teams t on t.team_id = a.team_id
    join public.recruiters r on r.recruiter_id = a.leader_recruiter_id
   where t.code <> '__system_vendor__'
     and a.is_current
     and (v_effective_team_id is null or a.team_id = v_effective_team_id)
     and (p_team_id is null or a.team_id = p_team_id)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
       or r.display_name ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(entry.projection), '[]'::jsonb) into v_leaders
    from (
      select public.direct_entry_team_leader_projection(a, t.display_name, r.display_name) as projection
        from public.direct_entry_team_leader_assignments a
        join public.teams t on t.team_id = a.team_id
        join public.recruiters r on r.recruiter_id = a.leader_recruiter_id
       where t.code <> '__system_vendor__'
         and a.is_current
         and (v_effective_team_id is null or a.team_id = v_effective_team_id)
         and (p_team_id is null or a.team_id = p_team_id)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
           or r.display_name ilike '%' || v_search || '%'
         )
       order by t.display_name, a.assignment_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) entry;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'leaders', v_leaders
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_list_team_membership_current(p_auth_subject uuid, p_app_user_id uuid, p_recruiter_id uuid DEFAULT NULL::uuid, p_team_id uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_memberships jsonb;
begin
  perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid membership search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.recruiter_team_memberships m
    join public.teams t on t.team_id = m.team_id
    join public.recruiters r on r.recruiter_id = m.recruiter_id
   where (m.is_current)
     and (p_recruiter_id is null or m.recruiter_id = p_recruiter_id)
     and (p_team_id is null or m.team_id = p_team_id)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
       or r.display_name ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(entry.projection), '[]'::jsonb)
    into v_memberships
    from (
      select public.direct_entry_team_membership_projection(m, t.display_name, r.version)
               as projection
        from public.recruiter_team_memberships m
        join public.teams t on t.team_id = m.team_id
        join public.recruiters r on r.recruiter_id = m.recruiter_id
       where (m.is_current)
         and (p_recruiter_id is null or m.recruiter_id = p_recruiter_id)
         and (p_team_id is null or m.team_id = p_team_id)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
           or r.display_name ilike '%' || v_search || '%'
         )
       order by t.display_name, m.membership_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) entry;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'memberships', v_memberships
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_lock_membership_subject(p_recruiter_id uuid, p_expected_version integer)
 RETURNS recruiters
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_recruiter public.recruiters;
begin
  if p_recruiter_id is null then
    raise exception 'recruiter required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected recruiter version required' using errcode = '22023';
  end if;

  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id
     and r.active
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and m.is_current
     )
   for update;
  if not found then
    raise exception 'membership subject not found' using errcode = 'P0002';
  end if;
  if v_recruiter.version <> p_expected_version then
    raise exception 'recruiter version conflict' using errcode = '40001';
  end if;
  return v_recruiter;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_lock_personnel(p_recruiter_id uuid, p_expected_version integer)
 RETURNS recruiters
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_recruiter public.recruiters;
begin
  if p_recruiter_id is null then
    raise exception 'personnel required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected personnel version required' using errcode = '22023';
  end if;

  -- HRP boundary: W01B manages HRP personnel only. A Vendor recruiter, or any
  -- recruiter without a canonical effective HRP provider membership, is simply not
  -- found here, so update/set-active fail closed with P0002 before touching a row.
  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and m.is_current
     )
   for update;
  if not found then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;
  if v_recruiter.version <> p_expected_version then
    raise exception 'personnel version conflict' using errcode = '40001';
  end if;
  return v_recruiter;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_revoke_project_team_scope(p_auth_subject uuid, p_app_user_id uuid, p_mapping_id uuid, p_expected_pair_version integer, p_effective_to date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_project_id text;
  v_project public.direct_entry_projects;
  v_mapping public.direct_entry_project_team_scopes;
  v_revoke_to date;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_result jsonb;
begin
  if p_mapping_id is null then
    raise exception 'mapping required' using errcode = '22023';
  end if;
  if p_expected_pair_version is null or p_expected_pair_version < 1 then
    raise exception 'expected mapping version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Canonical Full Admin triple at effective all scope; resolved server-side only.
  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'mapping_id', p_mapping_id,
    'expected_pair_version', p_expected_pair_version,
    'effective_to', p_effective_to,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_revoke', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Mapping identity is immutable: this unlocked read discovers only the project.
  -- Lock order is always project row first, mapping row second.
  select s.project_id into v_project_id
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id;
  if v_project_id is null then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;

  select p.* into v_project
    from public.direct_entry_projects p
   where p.project_id = v_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;

  select s.* into v_mapping
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id
   for update;
  if not found then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;
  if not v_mapping.is_current or v_mapping.revoked_at is not null then
    raise exception 'project team mapping is already revoked' using errcode = '22023';
  end if;
  if v_mapping.version <> p_expected_pair_version then
    raise exception 'project team mapping version conflict' using errcode = '40001';
  end if;

  -- Revocation is immediate; future-effective revocation would leave access open.
  if p_effective_to is not null
     and p_effective_to > public.direct_entry_authorization_date() then
    raise exception 'revoke date must not be in the future' using errcode = '22023';
  end if;
  -- An explicit end date must not precede the grant. valid_to = valid_from is the
  -- audited same-day cancellation marker and is only armed here.
  if p_effective_to is not null and p_effective_to < v_mapping.valid_from then
    raise exception 'revoke date must not precede the mapping start' using errcode = '22023';
  end if;
  v_revoke_to := greatest(
    coalesce(p_effective_to, public.direct_entry_authorization_date()),
    v_mapping.valid_from
  );

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if v_revoke_to = v_mapping.valid_from then
    perform set_config('direct_entry.project_team_scope_marker', 'on', true);
  end if;
  update public.direct_entry_project_team_scopes
     set valid_to = v_revoke_to,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where mapping_id = p_mapping_id
  returning * into v_mapping;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_team_scope_revoke', v_authority,
     p_mapping_id::text, 'all', 'APPLIED', v_reason_id, array['valid_to']);

  v_result := jsonb_build_object(
    'mapping_id', v_mapping.mapping_id,
    'project_id', v_mapping.project_id,
    'team_id', v_mapping.team_id,
    'valid_to', v_mapping.valid_to,
    'version', v_mapping.version,
    'revoked', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_revoke', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_revoke_project_team_scope(p_auth_subject uuid, p_app_user_id uuid, p_mapping_id uuid, p_effective_to date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_project_id text;
  v_mapping public.direct_entry_project_team_scopes;
  v_revoke_to date;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_result jsonb;
begin
  if p_mapping_id is null then
    raise exception 'mapping required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'mapping_id', p_mapping_id,
    'effective_to', p_effective_to,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_revoke_v2', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  select s.project_id into v_project_id
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id;
  if v_project_id is null then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;

  -- Immutable mapping identity; project then mapping row is the migration #94 lock order.
  perform p.project_id
    from public.direct_entry_projects p
   where p.project_id = v_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  select s.* into v_mapping
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id
   for update;
  if not found then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;
  if not v_mapping.is_current or v_mapping.revoked_at is not null then
    raise exception 'project team mapping is already revoked' using errcode = '22023';
  end if;
  if p_effective_to is not null
     and p_effective_to > public.direct_entry_authorization_date() then
    raise exception 'revoke date must not be in the future' using errcode = '22023';
  end if;
  if p_effective_to is not null and p_effective_to < v_mapping.valid_from then
    raise exception 'revoke date must not precede the mapping start' using errcode = '22023';
  end if;
  v_revoke_to := greatest(
    coalesce(p_effective_to, public.direct_entry_authorization_date()),
    v_mapping.valid_from
  );

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if v_revoke_to = v_mapping.valid_from then
    perform set_config('direct_entry.project_team_scope_marker', 'on', true);
  end if;
  update public.direct_entry_project_team_scopes
     set valid_to = v_revoke_to,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where mapping_id = p_mapping_id
  returning * into v_mapping;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_team_scope_revoke', v_authority,
     p_mapping_id::text, 'all', 'APPLIED', v_reason_id, array['valid_to']);

  v_result := jsonb_build_object(
    'mapping_id', v_mapping.mapping_id,
    'project_id', v_mapping.project_id,
    'team_id', v_mapping.team_id,
    'valid_to', v_mapping.valid_to,
    'version', v_mapping.version,
    'revoked', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_revoke_v2', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_lock_project_team_manager_context(p_auth_subject uuid, p_app_user_id uuid, p_team_id uuid, p_manager_recruiter_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_app_user_ids uuid[];
  v_leader_recruiter_id uuid;
  v_link_count integer;
  v_locked_team_id uuid;
  v_lock_key text;
begin
  if p_team_id is null or p_manager_recruiter_id is null then
    raise exception 'team manager context required' using errcode = '22023';
  end if;

  perform t.team_id
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select array_agg(ids.app_user_id order by ids.app_user_id)
    into v_app_user_ids
    from (
      select p_app_user_id as app_user_id
      union
      select l.app_user_id
        from public.direct_entry_app_user_recruiter_links l
       where l.recruiter_id = p_manager_recruiter_id
         and l.verified
         and l.is_current
    ) ids;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_app_user_ids)
   order by u.app_user_id
   for update;
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_app_user_id
     and s.scope_kind = 'team'
   order by s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_app_user_id
     and g.capability = 'team_manager_assign'
   order by g.grant_id
   for update;

  for v_lock_key in
    select distinct keys.key
      from (
        select 'capability:' || p_app_user_id::text || ':team_manager_assign' as key
        union all
        select 'scope:' || p_app_user_id::text || ':team:' || p_team_id::text
        union all
        select 'recruiter-link:' || ids.app_user_id::text
          from unnest(v_app_user_ids) ids(app_user_id)
      ) keys
     order by keys.key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_app_user_ids)
   order by l.link_id
   for update;

  select count(*)::int,
         (array_agg(l.recruiter_id order by l.link_id))[1]
    into v_link_count, v_leader_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current;
  if v_link_count <> 1 or v_leader_recruiter_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  perform r.recruiter_id
    from public.recruiters r
   where r.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by r.recruiter_id
   for update;

  for v_lock_key in
    select distinct keys.key
      from unnest(array[
        'provider:' || v_leader_recruiter_id::text,
        'team-membership:' || v_leader_recruiter_id::text,
        'provider:' || p_manager_recruiter_id::text,
        'team-membership:' || p_manager_recruiter_id::text
      ]) keys(key)
     order by keys.key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform m.membership_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by m.recruiter_id, m.membership_id
   for update;
  perform m.membership_id
    from public.recruiter_team_memberships m
   where m.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by m.recruiter_id, m.membership_id
   for update;

  v_locked_team_id := public.direct_entry_assert_team_leader_read_authority(
    p_auth_subject, p_app_user_id, p_team_id
  );
  if v_locked_team_id is distinct from p_team_id then
    raise exception 'team leader authority changed' using errcode = '42501';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_move_team_membership(p_auth_subject uuid, p_app_user_id uuid, p_recruiter_id uuid, p_team_id uuid, p_valid_from date, p_expected_version integer, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_reason_id uuid;
  v_subject public.recruiters;
  v_open public.recruiter_team_memberships;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_changed text[];
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null or p_team_id is null then
    raise exception 'recruiter and target team required' using errcode = '22023';
  end if;
  if p_valid_from is null then raise exception 'effective date required' using errcode = '22023'; end if;
  if p_valid_from > public.direct_entry_authorization_date() then raise exception 'future team memberships require explicit activation' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_move', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'team_id', p_team_id,
      'valid_from', p_valid_from,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_subject := public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
  perform public.direct_entry_assert_membership_target_team(p_team_id);

  select m.* into v_open
    from public.recruiter_team_memberships m
   where m.recruiter_id = p_recruiter_id
     and (m.valid_to is null or (
       m.valid_from <= p_valid_from and p_valid_from < m.valid_to
       and public.direct_entry_authorization_date() < m.valid_to
     ))
   order by m.valid_from desc
   limit 1;
  if not found then
    raise exception 'no open membership to move' using errcode = '22023';
  end if;
  if v_open.team_id = p_team_id then
    raise exception 'membership already targets this team' using errcode = '22023';
  end if;
  if p_valid_from < v_open.valid_from then
    raise exception 'move date precedes the open membership' using errcode = '22023';
  end if;
  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_from, p_team_id) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Same-day move collapses the outgoing interval into an inert cancellation
  -- marker; that write is announced so the marker guard accepts it.
  if p_valid_from = v_open.valid_from then
    perform set_config('direct_entry.membership_cancel_marker', 'on', true);
  end if;

  update public.recruiter_team_memberships set valid_to = p_valid_from, is_current = false
   where membership_id = v_open.membership_id;

  insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to, is_current)
  values (p_recruiter_id, p_team_id, p_valid_from, null, true)
  returning * into v_membership;

  v_changed := array['team_id', 'valid_to'];
  if p_valid_from = v_open.valid_from then
    v_changed := array_append(v_changed, 'cancellation_marker');
  end if;
  if p_valid_from < public.direct_entry_authorization_date() then
    v_changed := array_append(v_changed, 'backdated');
  end if;

  select b.recruiter_version, b.revision_id
    into v_recruiter_version, v_revision_id
    from public.direct_entry_bump_membership_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, v_open.team_id, v_open.valid_from, v_open.valid_to,
        v_subject.version, 'MOVE'
      ),
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, p_team_id, p_valid_from, null, v_subject.version + 1, 'MOVE'
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome,
     reason_id, changed_fields, team_membership_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_membership_move', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id, v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'membership_id', v_membership.membership_id,
    'recruiter_id', p_recruiter_id,
    'team_id', p_team_id,
    'valid_from', to_jsonb(v_membership.valid_from),
    'valid_to', to_jsonb(v_membership.valid_to),
    'recruiter_version', v_recruiter_version,
    'revision_id', v_revision_id,
    'change', 'MOVE'
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_membership_move', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_personnel_admin_projection(p_recruiter recruiters, p_hrp_valid_from date, p_revision_count integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
         and m.is_current
    ), '[]'::jsonb)
  )
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_privileged_edit(p_auth_subject uuid, p_app_user_id uuid, p_entry_id uuid, p_expected_version integer, p_patch jsonb, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_entry public.direct_entries%rowtype;
  v_submission_state text;
  v_before jsonb;
  v_after jsonb;
  v_scope text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_fields text[];
  v_team uuid;
  v_provider text;
  v_count integer;
  v_target_date date;
  v_status jsonb;
  v_latest_status public.direct_entry_employment_status_events%rowtype;
  v_status_version integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'
     or public.direct_entry_contains_authority(p_patch)
     or (p_patch - array['project_id','first_work_date','employee_code','worker_details',
                        'recruiter_id','labor_type','employment_status']) <> '{}'::jsonb then
    raise exception 'invalid privileged edit input' using errcode = '22023';
  end if;
  if p_patch ? 'employment_status' then
    v_status := p_patch->'employment_status';
    if jsonb_typeof(v_status) <> 'object'
       or (v_status - array['status','effective_date','leave_reason']) <> '{}'::jsonb
       or jsonb_typeof(v_status->'status') <> 'string'
       or v_status->>'status' not in ('UNCONFIRMED','ON','OFF')
       or jsonb_typeof(v_status->'effective_date') <> 'string'
       or (v_status->>'status' = 'OFF' and (
         jsonb_typeof(v_status->'leave_reason') <> 'string'
         or length(btrim(v_status->>'leave_reason')) not between 1 and 4000
       ))
       or (v_status->>'status' <> 'OFF' and v_status ? 'leave_reason') then
      raise exception 'invalid privileged employment status' using errcode = '22023';
    end if;
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if v_submission_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission_state not in ('DRAFT', 'SUBMITTED') then
    raise exception 'privileged edit requires a draft or submitted entry' using errcode = '42501';
  end if;
  v_scope := public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit',
    v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'entry_privileged_edit', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'version', p_expected_version, 'patch', p_patch, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if p_expected_version is null or p_expected_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  select count(*), min(m.provider_type) into v_count, v_provider
    from public.recruiter_provider_memberships m
   where m.recruiter_id = case when p_patch ? 'recruiter_id'
          then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
     and m.is_current;
  if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
  if v_provider = 'vendor' then
    v_team := public.direct_entry_system_vendor_team_id();
  else
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team
      from public.recruiter_team_memberships m
     where m.recruiter_id = case when p_patch ? 'recruiter_id'
            then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
       and m.is_current;
    if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
  end if;
  v_target_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  perform public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit',
    v_entry.created_by_user_id, v_team, v_target_date, v_scope
  );
  update public.direct_entries set
    project_id = case when p_patch ? 'project_id' then p_patch->>'project_id' else project_id end,
    first_work_date = case when p_patch ? 'first_work_date' then (p_patch->>'first_work_date')::date else first_work_date end,
    employee_code = case when p_patch ? 'employee_code' then p_patch->>'employee_code' else employee_code end,
    worker_details = case when p_patch ? 'worker_details' then p_patch->'worker_details' else worker_details end,
    recruiter_id = case when p_patch ? 'recruiter_id' then (p_patch->>'recruiter_id')::uuid else recruiter_id end,
    labor_type = case when p_patch ? 'labor_type' then p_patch->>'labor_type' else labor_type end,
    team_id = v_team, provider_type = v_provider, version = version + 1
   where entry_id = p_entry_id;
  if v_status is not null then
    select * into v_latest_status
      from public.direct_entry_employment_status_events
     where entry_id = p_entry_id
     order by version desc limit 1 for update;
    if not found then
      raise exception 'employment status not found' using errcode = '23514';
    end if;
    v_status_version := v_latest_status.version + 1;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, leave_date, leave_reason_text,
      version, actor_user_id, reason_id, supersedes_event_id
    ) values (
      p_entry_id, v_status->>'status', (v_status->>'effective_date')::date,
      case when v_status->>'status' = 'OFF' then (v_status->>'effective_date')::date else null end,
      case when v_status->>'status' = 'OFF' then btrim(v_status->>'leave_reason') else null end,
      v_status_version, p_app_user_id, v_reason_id, null
    );
  end if;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  select array_agg(key order by key) into v_fields from jsonb_object_keys(p_patch) key;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'entry_privileged_edit', 'entry_privileged_edit',
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_team else null end,
    'APPLIED', v_reason_id, v_revision_id, v_fields
  );
  v_result := jsonb_build_object('entry_id', p_entry_id, 'version', v_entry.version + 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'entry_privileged_edit', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_read_own_submission(p_auth_subject uuid, p_app_user_id uuid, p_submission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_submission public.direct_entry_submissions%rowtype;
  v_own_scope_count integer;
  v_can_read_own boolean := false;
  v_has_project_assignment boolean := false;
  v_project_scoped boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select count(*) into v_own_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id
     and g.scope_kind = 'own'
     and g.team_id is null
     and g.is_current;
  v_can_read_own := v_own_scope_count = 1
    and public.direct_entry_has_capability(p_app_user_id, 'submission_create');
  v_has_project_assignment := public.direct_entry_actor_has_project_assignment(p_app_user_id);
  if not v_can_read_own and not v_has_project_assignment then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  if p_submission_id is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into v_submission
    from public.direct_entry_submissions s
   where s.submission_id = p_submission_id and s.state <> 'DELETED';
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  v_project_scoped := not (
    v_can_read_own and v_submission.created_by_user_id = p_app_user_id
  );
  if v_project_scoped and (
       v_submission.state <> 'SUBMITTED'
       or not exists (
         select 1 from public.direct_entries e
          where e.submission_id = v_submission.submission_id
            and e.deleted_at is null
            and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
       )
     ) then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'submission_id', v_submission.submission_id,
    'state', v_submission.state,
    'version', v_submission.version,
    'entry_count', (
      select count(*)::int from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
         and (not v_project_scoped or
           public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
    ),
    'project_scoped', v_project_scoped,
    'entry_ids', (
      select coalesce(jsonb_agg(e.entry_id order by e.entry_id), '[]'::jsonb)
        from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
         and (not v_project_scoped or
           public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
    ),
    'created_at',
      pg_catalog.to_char(v_submission.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.created_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z',
    'updated_at',
      pg_catalog.to_char(v_submission.updated_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.updated_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z',
    'submitted_at', case when v_submission.submitted_at is null then null else
      pg_catalog.to_char(v_submission.submitted_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.submitted_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z' end,
    'allowed_transitions', case v_submission.state
      when 'DRAFT' then jsonb_build_array('SUBMITTED')
      when 'REVIEW' then jsonb_build_array('DRAFT', 'SUBMITTED')
      else jsonb_build_array()
    end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_seed_team_scope_grants()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_leader_count integer;
  v_leader record;
  v_app_user_id uuid;
  v_link_count integer;
  v_team_id uuid;
  v_membership_count integer;
  v_existing_team uuid;
begin
  select count(*) into v_leader_count
    from public.recruiters r
   where r.active
     and r.personnel_position = 'TEAM_LEADER'
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.is_current
     );

  if v_leader_count = 0 then
    -- Fresh / empty DB: nothing to seed. Behavioral fixtures seed leaders
    -- separately and call this function directly.
    return;
  end if;

  if v_leader_count <> 7 then
    raise exception
      'team-scope seed refused: expected 7 active HRP team leaders, found %',
      v_leader_count;
  end if;

  for v_leader in
    select r.recruiter_id
      from public.recruiters r
     where r.active
       and r.personnel_position = 'TEAM_LEADER'
       and exists (
         select 1
           from public.recruiter_provider_memberships m
          where m.recruiter_id = r.recruiter_id
            and m.provider_type = 'hrp'
            and m.is_current
       )
     order by r.recruiter_id
  loop
    -- Exactly one verified/effective recruiter link.
    select count(*) into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = v_leader.recruiter_id
       and l.verified
       and l.is_current;

    if v_link_count <> 1 then
      raise exception
        'team-scope seed refused: leader % has % verified recruiter links (expected 1)',
        v_leader.recruiter_id, v_link_count;
    end if;

    select l.app_user_id into v_app_user_id
      from public.direct_entry_app_user_recruiter_links l
      join public.direct_entry_app_users u
        on u.app_user_id = l.app_user_id
       and u.enabled
     where l.recruiter_id = v_leader.recruiter_id
       and l.verified
       and l.is_current;

    if v_app_user_id is null then
      raise exception
        'team-scope seed refused: leader % has no enabled linked app user',
        v_leader.recruiter_id;
    end if;

    -- Exactly one effective active team membership.
    select count(*) into v_membership_count
      from public.recruiter_team_memberships m
      join public.teams t
        on t.team_id = m.team_id
       and t.active
     where m.recruiter_id = v_leader.recruiter_id
       and m.is_current;

    if v_membership_count <> 1 then
      raise exception
        'team-scope seed refused: leader % has % effective team memberships (expected 1)',
        v_leader.recruiter_id, v_membership_count;
    end if;

    select m.team_id into v_team_id
      from public.recruiter_team_memberships m
      join public.teams t
        on t.team_id = m.team_id
       and t.active
     where m.recruiter_id = v_leader.recruiter_id
       and m.is_current;

    -- Overlap guard: any CURRENT effective team grant for this app user must
    -- target the same team (else refuse). Same team => idempotent skip.
    select g.team_id into v_existing_team
      from public.direct_entry_scope_grants g
     where g.app_user_id = v_app_user_id
       and g.scope_kind = 'team'
       and g.is_current
     limit 1;

    if v_existing_team is not null and v_existing_team <> v_team_id then
      raise exception
        'team-scope seed refused: app user % already has an effective team grant for a different team',
        v_app_user_id;
    end if;

    if v_existing_team is null then
      insert into public.direct_entry_scope_grants (
        app_user_id, scope_kind, team_id, valid_from
      , is_current) values (
        v_app_user_id, 'team', v_team_id, v_today
      , true);
    end if;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_set_vendor_active(p_auth_subject uuid, p_app_user_id uuid, p_vendor_id text, p_active boolean, p_expected_version integer, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_reason_id uuid;
  v_before public.vendors;
  v_after public.vendors;
  v_vendor_version integer;
  v_revision_id uuid;
  v_recruiters integer := 0;
  v_changed text[];
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_vendor_id is null or btrim(p_vendor_id) = '' then
    raise exception 'vendor required' using errcode = '22023';
  end if;
  if p_active is null then
    raise exception 'vendor active flag required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'vendor_set_active', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'vendor_id', btrim(p_vendor_id),
      'active', p_active,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_before := public.direct_entry_lock_vendor(btrim(p_vendor_id), p_expected_version);
  if v_before.active = p_active then
    raise exception 'vendor active state is unchanged' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- Soft state only on the canonical Vendor row: it is never deleted and its
  -- provider membership history is never rewritten.
  update public.vendors
     set active = p_active
   where vendor_id = v_before.vendor_id
  returning * into v_after;

  -- Dependency handling, fail closed: the Vendor's canonical Direct Entry
  -- representation recruiter(s) - the recruiters whose ONLY provider membership is
  -- this Vendor's vendor membership - follow the Vendor state in the same
  -- transaction. A deactivated Vendor therefore cannot be used for a new Direct
  -- Entry row (public.direct_entry_validate_new_entry raises 23514 'recruiter is
  -- not active' and direct_entry_input_catalog stops offering it), while every
  -- stored fact, membership interval and revision stays intact and resolvable.
  update public.recruiters r
     set active = p_active,
         version = r.version + 1
   where r.active <> p_active
     and r.recruiter_id in (
       select m.recruiter_id
         from public.recruiter_provider_memberships m
        where m.provider_type = 'vendor'
          and m.vendor_id = v_before.vendor_id
          and m.is_current
          and (
            select count(*)
              from public.recruiter_provider_memberships x
             where x.recruiter_id = m.recruiter_id
          ) = 1
     );
  get diagnostics v_recruiters = row_count;

  select b.vendor_version, b.revision_id
    into v_vendor_version, v_revision_id
    from public.direct_entry_bump_vendor_version(
      v_after.vendor_id, p_app_user_id, v_reason_id,
      public.direct_entry_vendor_snapshot(v_before)
    ) b;

  v_changed := case
    when v_recruiters > 0 then array['active', 'representation_recruiter_active']
    else array['active']
  end;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, vendor_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'vendor_set_active', v_authority,
     v_after.vendor_id, 'all', 'APPLIED', v_reason_id,
     v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'vendor_id', v_after.vendor_id,
    'display_name', v_after.display_name,
    'active', v_after.active,
    'version', v_vendor_version,
    'revision_id', v_revision_id,
    'recruiter_id', public.direct_entry_vendor_representation_recruiter(v_after.vendor_id)
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'vendor_set_active', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_submission_duplicate_cccd_preflight(p_auth_subject uuid, p_app_user_id uuid, p_submission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  declare
    v_submission public.direct_entry_submissions%rowtype;
    v_own_scope_count integer;
    v_state jsonb;
  begin
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'submission_create'
    );
    select * into v_submission
      from public.direct_entry_submissions
     where submission_id = p_submission_id;
    if not found then
      raise exception 'submission not found' using errcode = 'P0002';
    end if;
    if v_submission.created_by_user_id <> p_app_user_id then
      raise exception 'submission scope denied' using errcode = '42501';
    end if;
    select count(*) into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.is_current;
    if v_own_scope_count <> 1 then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
    if v_submission.state <> 'DRAFT' then
      raise exception 'submission is not a draft' using errcode = '22023';
    end if;

    v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);
    return jsonb_build_object(
      'submission_id', p_submission_id,
      'version', v_submission.version,
      'fingerprint', v_state->'fingerprint',
      'conflict_count', v_state->'conflict_count',
      'conflicts', v_state->'conflicts'
    );
  end;
  $function$;

CREATE OR REPLACE FUNCTION public.direct_entry_transition_submission_apply(p_auth_subject uuid, p_app_user_id uuid, p_submission_id uuid, p_expected_version integer, p_target_state text, p_idempotency_key text, p_ack_fingerprint text, p_ack_conflict_count integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  declare
    v_submission public.direct_entry_submissions%rowtype;
    v_own_scope_count integer;
    v_prior_result jsonb;
    v_result jsonb;
    v_request_hash text;
    v_reason_id uuid;
    v_submission_revision_id uuid;
    v_before jsonb;
    v_state jsonb;
    v_conflict_count integer;
    v_acknowledged boolean := false;
  begin
    if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
      raise exception 'invalid idempotency key' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'submission_create'
    );
    select * into v_submission
      from public.direct_entry_submissions
     where submission_id = p_submission_id
     for update;
    if not found then
      raise exception 'submission not found' using errcode = 'P0002';
    end if;
    if v_submission.created_by_user_id <> p_app_user_id then
      raise exception 'submission scope denied' using errcode = '42501';
    end if;
    select count(*) into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.is_current;
    if v_own_scope_count <> 1 then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
    v_request_hash := encode(
      sha256(convert_to(concat_ws('|', p_submission_id::text, p_expected_version::text, p_target_state), 'UTF8')),
      'hex'
    );
    v_prior_result := public.direct_entry_idempotency_begin(
      p_app_user_id, 'submission_transition', p_idempotency_key, v_request_hash
    );
    if v_prior_result is not null then return v_prior_result; end if;
    if p_expected_version is null or p_expected_version <> v_submission.version then
      raise exception 'submission version conflict' using errcode = '40001';
    end if;
    if p_target_state = v_submission.state then
      raise exception 'submission transition cannot be a no-op' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.direct_entries e
       where e.submission_id = p_submission_id and e.deleted_at is null
    ) then
      raise exception 'submission must contain at least one entry' using errcode = '23514';
    end if;

    -- P3.1-HF-R1: only DRAFT -> REVIEW is gated, and only while a conflict exists.
    -- The conflict set is re-derived here, inside the transition transaction and after
    -- the submission row lock, so the acknowledgement can never be replayed against a
    -- different set. A missing, stale or forged acknowledgement raises 22023 before the
    -- first write: the submission stays DRAFT, the version is untouched, no revision and
    -- no APPLIED audit event are written and the idempotency row of this call is rolled
    -- back with the rest of the transaction.
    if v_submission.state = 'DRAFT' and p_target_state = 'SUBMITTED' then
      v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);
      v_conflict_count := (v_state->>'conflict_count')::int;
      if v_conflict_count > 0 then
        if p_ack_fingerprint is null
           or p_ack_fingerprint <> (v_state->>'fingerprint')
           or p_ack_conflict_count is null
           or p_ack_conflict_count <> v_conflict_count then
          raise exception 'duplicate cccd acknowledgement required' using errcode = '22023';
        end if;
        v_acknowledged := true;
      end if;
    end if;
    v_before := jsonb_build_object(
      'state', v_submission.state, 'version', v_submission.version,
      'submitted_at', v_submission.submitted_at
    );
    update public.direct_entry_submissions
       set state = p_target_state,
           version = version + 1
     where submission_id = p_submission_id;
    -- The acknowledgement is recorded as a short code plus the conflict count and twelve
    -- fingerprint characters only: never a CCCD, a worker name, a project name or the
    -- conflict projection itself.
    v_reason_id := public.direct_entry_reason(
      p_app_user_id,
      case
        when v_acknowledged then
          'Submission state transition (duplicate CCCD acknowledged x'
            || v_conflict_count::text || ' fp=' || left(p_ack_fingerprint, 12) || ')'
        else 'Submission state transition'
      end
    );
    insert into public.direct_entry_submission_revisions (
      submission_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
    ) values (
      p_submission_id, v_submission.version + 1, p_app_user_id, v_reason_id, v_before,
      jsonb_build_object(
        'state', p_target_state, 'version', v_submission.version + 1,
        'submitted_at', case when p_target_state = 'SUBMITTED' then now() else null end
      )
    ) returning revision_id into v_submission_revision_id;
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, scope_team_id, outcome, reason_id, submission_revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'submission_transition', 'submission_create',
      p_submission_id::text, 'own', null, 'APPLIED', v_reason_id,
      v_submission_revision_id,
      array['state', 'version']
    );
    v_result := jsonb_build_object(
      'submission_id', p_submission_id,
      'state', p_target_state,
      'version', v_submission.version + 1
    );
    perform public.direct_entry_idempotency_finish(
      p_app_user_id, 'submission_transition', p_idempotency_key, v_result
    );
    return v_result;
  end;
  $function$;

CREATE OR REPLACE FUNCTION public.direct_entry_unassign_project_manager(p_auth_subject uuid, p_app_user_id uuid, p_assignment_id uuid, p_expected_version integer, p_expected_project_version integer, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_team_id uuid;
  v_assignment public.direct_entry_project_manager_assignments%rowtype;
  v_project public.direct_entry_projects;
  v_project_id text;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_revoke_to date;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_assignment_id is null then
    raise exception 'assignment required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected version required' using errcode = '22023';
  end if;
  if p_expected_project_version is null or p_expected_project_version < 1 then
    raise exception 'expected project version required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'assignment_id', p_assignment_id,
      'expected_version', p_expected_version,
      'expected_project_version', p_expected_project_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Assignment identity is immutable: this unlocked lookup discovers only the
  -- project. Lock order is always project first, then the effective mapping for a
  -- leader, then the assignment row, then the leader/team context.
  select a.project_id into v_project_id
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id = p_assignment_id;
  if v_project_id is null then
    raise exception 'project manager assignment not found' using errcode = 'P0002';
  end if;

  v_project := public.direct_entry_lock_project(v_project_id, p_expected_project_version);
  if v_authority = 'team_manager_assign' then
    if not public.direct_entry_lock_project_team_scope(v_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
  end if;
  select * into v_assignment
    from public.direct_entry_project_manager_assignments a
   where a.assignment_id = p_assignment_id
   for update;
  if not found then
    raise exception 'project manager assignment not found' using errcode = 'P0002';
  end if;

  if v_authority = 'team_manager_assign' then
    perform public.direct_entry_lock_project_team_manager_context(
      p_auth_subject, p_app_user_id, v_team_id, v_assignment.manager_recruiter_id
    );
    if not public.direct_entry_project_team_scope_effective(v_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
    select count(*)::int,
           count(*) filter (where m.team_id = v_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_assignment.manager_recruiter_id
       and m.is_current;
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
  end if;

  if not v_assignment.is_current then
    v_result := jsonb_build_object(
      'assignment_id', v_assignment.assignment_id,
      'project_id', v_assignment.project_id,
      'valid_to', v_assignment.valid_to,
      'version', v_assignment.version,
      'project_version', v_project.version,
      'already_unassigned', true
    );
    perform public.direct_entry_idempotency_finish(
      p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key, v_result
    );
    return v_result;
  end if;

  if p_expected_version <> v_assignment.version then
    raise exception 'project assignment version conflict' using errcode = '40001';
  end if;

  v_revoke_to := greatest(
    public.direct_entry_authorization_date(), v_assignment.valid_from
  );
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);

  update public.direct_entry_project_manager_assignments
     set valid_to = v_revoke_to,
         is_current = false,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where assignment_id = p_assignment_id;

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      v_project_id, p_app_user_id, v_reason_id, v_before,
      jsonb_set(
        public.direct_entry_project_snapshot(v_project),
        '{assignment_change}',
        jsonb_build_object(
          'change', 'UNASSIGN',
          'assignment_id', p_assignment_id,
          'manager_recruiter_id', v_assignment.manager_recruiter_id,
          'valid_to', v_revoke_to
        ),
        true
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     scope_team_id, outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_unassign',
     v_authority, p_assignment_id::text,
     case when v_authority = 'team_manager_assign' then 'team' else 'all' end,
     case when v_authority = 'team_manager_assign' then v_team_id else null end,
     'APPLIED', v_reason_id,
     array['valid_to', 'revoked_by_user_id', 'revoke_reason_id'], v_revision_id);

  v_result := jsonb_build_object(
    'assignment_id', v_assignment.assignment_id,
    'project_id', v_assignment.project_id,
    'valid_to', v_revoke_to,
    'version', v_assignment.version + 1,
    'project_version', v_project_version,
    'already_unassigned', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_manager_assignment_unassign', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_unassign_team_membership(p_auth_subject uuid, p_app_user_id uuid, p_recruiter_id uuid, p_valid_to date, p_expected_version integer, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_authority text;
  v_reason_id uuid;
  v_subject public.recruiters;
  v_open public.recruiter_team_memberships;
  v_previous public.recruiter_team_memberships;
  v_origin public.direct_entry_team_membership_revisions;
  v_restore boolean := false;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_change text;
  v_changed text[];
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null then
    raise exception 'recruiter required' using errcode = '22023';
  end if;
  if p_valid_to is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_unassign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'valid_to', p_valid_to,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Close-only lock: revocation must stay possible for a person who is no longer an
  -- eligible creation subject. No target-team check either: an existing membership in
  -- a team that has since become inactive stays readable and must remain closable.
  v_subject := public.direct_entry_lock_membership_close_target(p_recruiter_id, p_expected_version);
  select m.* into v_open
    from public.recruiter_team_memberships m
   where m.recruiter_id = p_recruiter_id
     and (m.valid_to is null or (
       m.valid_from <= p_valid_to and p_valid_to < m.valid_to
       and public.direct_entry_authorization_date() < m.valid_to
     ))
   order by m.valid_from desc
   limit 1;
  if not found then
    raise exception 'no open membership to unassign' using errcode = '22023';
  end if;
  if p_valid_to < v_open.valid_from then
    raise exception 'unassign date precedes the open membership' using errcode = '22023';
  end if;
  -- Restore only a predecessor closed by the audited MOVE chain at this date.
  -- Cancelling a standalone ASSIGN or an already-effective interval stays close-only.
  if p_valid_to = v_open.valid_from
     and public.direct_entry_authorization_date() < v_open.valid_from then
    select r.* into v_origin
      from public.direct_entry_team_membership_revisions r
     where r.recruiter_id = p_recruiter_id
       and r.after_snapshot->>'team_id' = v_open.team_id::text
       and r.after_snapshot->>'valid_from' = v_open.valid_from::text
     order by r.version desc limit 1;
    if v_origin.after_snapshot->>'change' = 'MOVE' then
      select m.* into v_previous
        from public.recruiter_team_memberships m
       where m.recruiter_id = p_recruiter_id
         and m.valid_to = v_open.valid_from and m.valid_from < m.valid_to
         and exists (
           select 1 from public.direct_entry_team_membership_revisions r
            where r.recruiter_id = p_recruiter_id and r.version <= v_origin.version
              and r.after_snapshot->>'change' = 'MOVE'
              and r.after_snapshot->>'valid_from' = v_open.valid_from::text
              and r.before_snapshot->>'team_id' = m.team_id::text
              and r.before_snapshot->>'valid_from' = m.valid_from::text
         );
      if found then
        -- Restoration is not a pure revocation: enforce the creation guards too.
        perform public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
        perform public.direct_entry_assert_membership_target_team(v_previous.team_id);
        v_restore := true;
      end if;
    end if;
  end if;
  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_to,
    case when v_restore then v_previous.team_id else null end) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_change := case when p_valid_to = v_open.valid_from then 'CANCEL' else 'UNASSIGN' end;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  if v_change = 'CANCEL' then
    perform set_config('direct_entry.membership_cancel_marker', 'on', true);
  end if;

  update public.recruiter_team_memberships set valid_to = p_valid_to, is_current = false
   where membership_id = v_open.membership_id
  returning * into v_membership;

  if v_restore then
    update public.recruiter_team_memberships set valid_to = null
     where membership_id = v_previous.membership_id;
  end if;
  v_changed := array['valid_to'];
  if v_restore then
    v_changed := array_append(v_changed, 'previous_membership_restored');
  end if;
  if v_change = 'CANCEL' then
    v_changed := array_append(v_changed, 'cancellation_marker');
  end if;
  if p_valid_to < public.direct_entry_authorization_date() then
    v_changed := array_append(v_changed, 'backdated');
  end if;

  select b.recruiter_version, b.revision_id
    into v_recruiter_version, v_revision_id
    from public.direct_entry_bump_membership_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, v_open.team_id, v_open.valid_from, v_open.valid_to,
        v_subject.version, v_change
      ) || case when v_restore then jsonb_build_object('restored_membership',
        public.direct_entry_team_membership_snapshot(p_recruiter_id, v_previous.team_id,
          v_previous.valid_from, v_previous.valid_to, v_subject.version, 'CANCEL'))
        else '{}'::jsonb end,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, v_open.team_id, v_open.valid_from, p_valid_to,
        v_subject.version + 1, v_change
      ) || case when v_restore then jsonb_build_object('restored_membership',
        public.direct_entry_team_membership_snapshot(p_recruiter_id, v_previous.team_id,
          v_previous.valid_from, null, v_subject.version + 1, 'CANCEL'))
        else '{}'::jsonb end
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome,
     reason_id, changed_fields, team_membership_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_membership_unassign', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id, v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'membership_id', v_membership.membership_id,
    'recruiter_id', p_recruiter_id,
    'team_id', v_membership.team_id,
    'valid_from', to_jsonb(v_membership.valid_from),
    'valid_to', to_jsonb(v_membership.valid_to),
    'recruiter_version', v_recruiter_version,
    'revision_id', v_revision_id,
    'change', v_change
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_membership_unassign', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_update_draft_row(p_auth_subject uuid, p_app_user_id uuid, p_entry_id uuid, p_expected_version integer, p_patch jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_entry public.direct_entries%rowtype;
  v_submission public.direct_entry_submissions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_patch_fields text[];
  v_scope text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_new_recruiter_id uuid;
  v_new_work_date date;
  v_provider text;
  v_team uuid;
  v_count integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or public.direct_entry_contains_authority(p_patch)
     or exists (
       select 1 from jsonb_object_keys(p_patch) as patch_key(key)
        where patch_key.key not in (
          'project_id', 'first_work_date', 'employee_code', 'worker_details',
          'recruiter_id', 'labor_type', 'general_note', 'payment'
        )
     ) then
    raise exception 'invalid draft patch' using errcode = '22023';
  end if;
  if p_patch ? 'general_note' and jsonb_typeof(p_patch->'general_note') <> 'null'
     and (jsonb_typeof(p_patch->'general_note') <> 'string'
          or length(p_patch->>'general_note') > 4000
          or btrim(p_patch->>'general_note') = '') then
    raise exception 'invalid draft general note' using errcode = '22023';
  end if;
  if p_patch ? 'payment' then
    if jsonb_typeof(p_patch->'payment') <> 'object'
       or exists (
         select 1 from jsonb_object_keys(p_patch->'payment') as payment_key(key)
          where payment_key.key not in ('state','account_number','bank_name','account_holder_name')
       )
       or not (p_patch->'payment' ? 'state')
       or (p_patch->'payment' ? 'account_number' and
           jsonb_typeof(p_patch->'payment'->'account_number') not in ('string','null'))
       or (p_patch->'payment' ? 'bank_name' and
           jsonb_typeof(p_patch->'payment'->'bank_name') not in ('string','null'))
       or (p_patch->'payment' ? 'account_holder_name' and
           jsonb_typeof(p_patch->'payment'->'account_holder_name') not in ('string','null'))
       or p_patch->'payment'->>'state' not in ('provided','unknown','intentionally_blank','omitted') then
      raise exception 'invalid draft payment text' using errcode = '22023';
    end if;
    if p_patch->'payment'->>'state' = 'provided' then
      if (p_patch->'payment'->>'account_number' is not null and
          (length(p_patch->'payment'->>'account_number') > 64 or
           p_patch->'payment'->>'account_number' ~ '[[:cntrl:]]')) or
         (p_patch->'payment'->>'bank_name' is not null and
          (length(p_patch->'payment'->>'bank_name') > 256 or
           p_patch->'payment'->>'bank_name' ~ '[[:cntrl:]]')) or
         (p_patch->'payment'->>'account_holder_name' is not null and
          (length(p_patch->'payment'->>'account_holder_name') > 256 or
           p_patch->'payment'->>'account_holder_name' ~ '[[:cntrl:]]')) or
         (nullif(btrim(p_patch->'payment'->>'account_number'), '') is null and
          nullif(btrim(p_patch->'payment'->>'bank_name'), '') is null and
          nullif(btrim(p_patch->'payment'->>'account_holder_name'), '') is null) then
        raise exception 'invalid draft payment text' using errcode = '22023';
      end if;
    elsif coalesce(p_patch->'payment'->'account_number' <> 'null'::jsonb, false) or
          coalesce(p_patch->'payment'->'bank_name' <> 'null'::jsonb, false) or
          coalesce(p_patch->'payment'->'account_holder_name' <> 'null'::jsonb, false) then
      raise exception 'invalid draft payment text' using errcode = '22023';
    end if;
  end if;
  if p_patch ? 'worker_details' then
    if jsonb_typeof(p_patch->'worker_details') <> 'object'
       or p_patch->'worker_details' = '{}'::jsonb then
      raise exception 'invalid draft worker patch' using errcode = '22023';
    end if;
    if p_patch->'worker_details' ? 'display_name'
       and jsonb_typeof(p_patch->'worker_details'->'display_name') <> 'string' then
      raise exception 'invalid draft worker patch' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_object_keys(p_patch->'worker_details') as worker_key(key)
       where worker_key.key not in (
         'display_name', 'gender', 'date_of_birth', 'national_id',
         'national_id_issued_at', 'national_id_issued_place', 'address', 'phone'
       )
    ) then
      raise exception 'invalid draft worker patch' using errcode = '22023';
    end if;
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_resolve_draft_scope(
    p_auth_subject, p_app_user_id, p_entry_id
  );
  if v_scope is null then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_row_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'expected_version', p_expected_version, 'patch', p_patch
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if v_entry.deleted_at is not null then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  select * into v_submission from public.direct_entry_submissions
   where submission_id = v_entry.submission_id for update;
  if v_submission.state <> 'DRAFT' then
    raise exception 'draft submission is not editable' using errcode = '42501';
  end if;
  if p_expected_version is null or p_expected_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_new_recruiter_id := case when p_patch ? 'recruiter_id'
    then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end;
  v_new_work_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  if v_new_recruiter_id is distinct from v_entry.recruiter_id then
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_new_recruiter_id
       and m.is_current;
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    if v_provider = 'vendor' then
      v_team := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_new_recruiter_id
         and m.is_current;
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;
  else
    -- A date-only edit must not re-resolve or rewrite the recruiter assignment.
    v_provider := v_entry.provider_type;
    v_team := v_entry.team_id;
  end if;
  if (v_new_recruiter_id is distinct from v_entry.recruiter_id and not exists (
        select 1 from public.recruiters r
         where r.recruiter_id = v_new_recruiter_id and r.active
      )) or not exists (
        select 1 from public.direct_entry_projects p
         where p.project_id = coalesce(p_patch->>'project_id', v_entry.project_id) and p.active
      ) or (v_new_recruiter_id is distinct from v_entry.recruiter_id and not exists (
        select 1 from public.teams t where t.team_id = v_team and t.active
      )) then
    raise exception 'inactive draft master' using errcode = '22023';
  end if;
  v_scope := public.direct_entry_resolve_draft_scope(
    p_auth_subject, p_app_user_id, p_entry_id,
    coalesce(p_patch->>'project_id', v_entry.project_id)
  );
  if v_scope is null then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;
  update public.direct_entries set
    project_id = case when p_patch ? 'project_id' then p_patch->>'project_id' else project_id end,
    first_work_date = case when p_patch ? 'first_work_date' then (p_patch->>'first_work_date')::date else first_work_date end,
    employee_code = case when p_patch ? 'employee_code' then p_patch->>'employee_code' else employee_code end,
    worker_details = case when p_patch ? 'worker_details'
      then v_entry.worker_details || (p_patch->'worker_details') else worker_details end,
    general_note = case when p_patch ? 'general_note'
      then case when jsonb_typeof(p_patch->'general_note') = 'null'
        then null else p_patch->>'general_note' end
      else general_note end,
    recruiter_id = case when p_patch ? 'recruiter_id' then (p_patch->>'recruiter_id')::uuid else recruiter_id end,
    labor_type = case when p_patch ? 'labor_type' then p_patch->>'labor_type' else labor_type end,
    team_id = v_team,
    provider_type = v_provider,
    version = version + 1
   where entry_id = p_entry_id;
  if p_patch ? 'payment' then
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
    ) values (
      p_entry_id, p_patch->'payment'->>'state',
      nullif(p_patch->'payment'->>'account_number', ''), null,
      nullif(p_patch->'payment'->>'bank_name', ''),
      nullif(p_patch->'payment'->>'account_holder_name', ''), 1
    ) on conflict (entry_id) do update set
      state = excluded.state, account_number = excluded.account_number,
      bank_id = null, bank_name = excluded.bank_name,
      account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1, updated_at = now();
  end if;
  update public.direct_entry_submissions set version = version + 1
   where submission_id = v_entry.submission_id;
  v_reason_id := public.direct_entry_reason(p_app_user_id, 'Draft row update');
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_entry.submission_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state','DRAFT','version',v_submission.version,
      'entry_count',(select count(*) from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    jsonb_build_object('state','DRAFT','version',v_submission.version + 1,
      'entry_count',(select count(*) from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    v_submission.version + 1
  );
  select array_agg(key order by key) into v_patch_fields from jsonb_object_keys(p_patch) key;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id,
    submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_row_update',
    case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team'
      when 'project' then 'project_manager' else 'entry_admin' end,
    p_entry_id::text, case when v_scope = 'project' then null else v_scope end,
    case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, v_submission_revision_id, v_patch_fields
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'version', v_entry.version + 1,
    'submission_version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_row_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_vendor_representation_recruiter(p_vendor_id text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select r.recruiter_id
    from public.recruiters r
    join public.recruiter_provider_memberships m
      on m.recruiter_id = r.recruiter_id
   where m.provider_type = 'vendor'
     and m.vendor_id = p_vendor_id
     and (
       select count(*)
         from public.recruiter_provider_memberships x
        where x.recruiter_id = r.recruiter_id
     ) = 1
   order by r.created_at, r.recruiter_id
   limit 1
$function$;

CREATE OR REPLACE FUNCTION public.direct_entry_update_payment(p_auth_subject uuid, p_app_user_id uuid, p_entry_id uuid, p_expected_entry_version integer, p_expected_payment_version integer, p_payment jsonb, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_entry public.direct_entries%rowtype;
  v_payment public.direct_entry_payments%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_scope text;
  v_submission_state text;
  v_audit_capability text;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_revision_id uuid;
  v_payment_version integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_payment) <> 'object'
     or (p_payment - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb then
    raise exception 'invalid payment input' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission_state <> 'DRAFT' then
    raise exception 'non-draft submissions are change-request only' using errcode = '42501';
  end if;
  v_scope := public.direct_entry_assert_payment_document_access(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
    v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'entry_privileged_edit'
  );
  v_audit_capability := case
    when v_submission_state = 'DRAFT' then case v_scope
      when 'own' then 'entry_own'
      when 'team' then 'entry_team'
      else 'entry_admin'
    end
    else 'entry_privileged_edit'
  end;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'payment_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'entry_version', p_expected_entry_version,
      'payment_version', p_expected_payment_version, 'payment', p_payment, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if p_expected_entry_version is null or p_expected_entry_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;
  select * into v_payment from public.direct_entry_payments where entry_id = p_entry_id for update;
  if found then
    if p_expected_payment_version is null or p_expected_payment_version <> v_payment.version then
      raise exception 'payment version conflict' using errcode = '40001';
    end if;
    v_payment_version := v_payment.version + 1;
  else
    if p_expected_payment_version is distinct from 0 then
      raise exception 'payment version conflict' using errcode = '40001';
    end if;
    v_payment_version := 1;
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_payments (
    entry_id, state, account_number, bank_id, account_holder_name, version
  ) values (
    p_entry_id, p_payment->>'state', p_payment->>'account_number',
    p_payment->>'bank_id', p_payment->>'account_holder_name', v_payment_version
  )
  on conflict (entry_id) do update set
    state = excluded.state, account_number = excluded.account_number,
    bank_id = excluded.bank_id, account_holder_name = excluded.account_holder_name,
    version = excluded.version, updated_at = now();
  update public.direct_entries set version = version + 1 where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'payment_update', v_audit_capability, p_entry_id::text,
    v_scope, case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['payment']
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'entry_version', v_entry.version + 1,
    'payment_version', v_payment_version
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'payment_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

commit;
