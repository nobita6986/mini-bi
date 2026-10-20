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
       and exists (select 1 from public.recruiters r where r.recruiter_id = a.manager_recruiter_id and r.active)
       and exists (select 1 from public.direct_entry_app_user_recruiter_links l join public.direct_entry_app_users u
                    on u.app_user_id = l.app_user_id and u.enabled
                   where l.recruiter_id = a.manager_recruiter_id and l.verified and l.is_current)
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
      select p.active and r.active and exists (
        select 1 from public.direct_entry_app_user_recruiter_links l
        join public.direct_entry_app_users u on u.app_user_id = l.app_user_id and u.enabled
        where l.recruiter_id = new.manager_recruiter_id and l.verified and l.is_current
      ) into new.is_current
        from public.direct_entry_projects p join public.recruiters r on r.recruiter_id = new.manager_recruiter_id
       where p.project_id = new.project_id;
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

commit;
