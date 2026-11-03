-- Align HRP/Vendor recruiter membership resolution and Team Leader lifecycle/cancellation-restore/routing
-- across catalog reads, batch creation, draft writes, privileged edits, change request application,
-- team membership mutations, team leader mutations/reads/authority, and leave approval routing.

create or replace function public.direct_entry__internal_team_leader_assignment_effective(
  p_assignment_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_team_leader_assignments a
      join public.teams t
        on t.team_id = a.team_id
       and t.active
       and t.code <> '__system_vendor__'
      join public.direct_entry_app_users u
        on u.app_user_id = a.leader_app_user_id
       and u.enabled
      join public.recruiters r
        on r.recruiter_id = a.leader_recruiter_id
       and r.active
     where a.assignment_id = p_assignment_id
       and a.valid_from <= p_as_of
       and (a.valid_to is null or p_as_of < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and (
         a.is_current
         or p_as_of > public.direct_entry_authorization_date()
         or (
           not a.is_current
           and exists (
             select 1
               from public.direct_entry_scope_grants s
              where s.app_user_id = a.leader_app_user_id
                and s.scope_kind = 'team'
                and s.team_id = a.team_id
                and s.valid_from <= a.valid_from
                and s.valid_to is not distinct from a.valid_to
                and (s.valid_to is null or s.valid_to > s.valid_from)
                and not s.is_current
           )
           and exists (
             select 1
               from public.direct_entry_capability_grants g
              where g.app_user_id = a.leader_app_user_id
                and g.capability = 'team_manager_assign'
                and g.valid_from = a.valid_from
                and g.valid_to is not distinct from a.valid_to
                and (g.valid_to is null or g.valid_to > g.valid_from)
                and not g.is_current
           )
           and exists (
             select 1
               from public.direct_entry_team_leader_revisions rev
              where rev.team_id = a.team_id
                and rev.action in ('designate', 'replace')
                and rev.after_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
                and rev.after_snapshot->>'valid_from' = a.valid_from::text
           )
         )
       )
  )
$function$;

revoke all on function public.direct_entry__internal_team_leader_assignment_effective(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry__internal_team_scope_grant_effective(
  p_grant_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.direct_entry_app_users u
        on u.app_user_id = s.app_user_id
       and u.enabled
      join public.teams t
        on t.team_id = s.team_id
       and t.active
     where s.grant_id = p_grant_id
       and s.scope_kind = 'team'
       and not (
         s.valid_to is not null
         and s.valid_to > s.valid_from
         and s.valid_to <= p_as_of
         and exists (
           select 1
             from public.direct_entry_team_leader_assignments a
            where a.leader_app_user_id = s.app_user_id
              and a.team_id = s.team_id
              and a.valid_to = s.valid_to
              and a.valid_to > a.valid_from
         )
       )
       and (
         s.is_current
         or (
           not s.is_current
           and s.valid_from <= p_as_of
           and (s.valid_to is null or p_as_of < s.valid_to)
           and (s.valid_to is null or s.valid_to > s.valid_from)
           and exists (
             select 1
               from public.direct_entry_team_leader_assignments a
              where a.leader_app_user_id = s.app_user_id
                and a.team_id = s.team_id
                and s.valid_from <= a.valid_from
                and s.valid_to is not distinct from a.valid_to
                and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, p_as_of)
           )
         )
       )
  )
$function$;

revoke all on function public.direct_entry__internal_team_scope_grant_effective(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry__internal_capability_grant_effective(
  p_grant_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_capability_grants g
      join public.direct_entry_app_users u
        on u.app_user_id = g.app_user_id
       and u.enabled
     where g.grant_id = p_grant_id
       and g.capability not in ('pii_view', 'pii_export', 'payment_view', 'payment_edit')
       and not (
         g.capability in ('team_manager_assign', 'report_view', 'report_analytics_view', 'report_assign', 'report_review')
         and g.valid_to is not null
         and g.valid_to > g.valid_from
         and g.valid_to <= p_as_of
         and exists (
           select 1
             from public.direct_entry_team_leader_assignments a
            where a.leader_app_user_id = g.app_user_id
              and a.valid_to = g.valid_to
              and a.valid_to > a.valid_from
         )
       )
       and (
         g.is_current
         or (
           not g.is_current
           and g.capability = 'team_manager_assign'
           and g.valid_from <= p_as_of
           and (g.valid_to is null or p_as_of < g.valid_to)
           and (g.valid_to is null or g.valid_to > g.valid_from)
           and exists (
             select 1
               from public.direct_entry_team_leader_assignments a
              where a.leader_app_user_id = g.app_user_id
                and a.valid_from = g.valid_from
                and a.valid_to is not distinct from g.valid_to
                and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, p_as_of)
           )
         )
       )
  )
$function$;

revoke all on function public.direct_entry__internal_capability_grant_effective(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry__internal_recruiter_team_membership_effective(
  p_membership_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.recruiter_team_memberships m
      join public.recruiters r
        on r.recruiter_id = m.recruiter_id
       and r.active
      join public.teams t
        on t.team_id = m.team_id
       and t.active
     where m.membership_id = p_membership_id
       and m.valid_from <= p_as_of
       and (m.valid_to is null or p_as_of < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from)
       and (
         m.is_current
         or m.valid_from > public.direct_entry_authorization_date()
         or m.valid_to is not null
         or exists (
           select 1
             from public.recruiter_team_memberships prev
            where prev.recruiter_id = m.recruiter_id
              and prev.membership_id <> m.membership_id
              and prev.is_current
              and prev.valid_to is not null
              and prev.valid_to > prev.valid_from
              and prev.valid_to <= m.valid_from
              and prev.valid_to <= public.direct_entry_authorization_date()
         )
         or exists (
           select 1
             from public.direct_entry_team_membership_revisions rev
            where rev.recruiter_id = m.recruiter_id
              and rev.after_snapshot->>'change' = 'MOVE'
              and rev.after_snapshot->>'team_id' = m.team_id::text
              and rev.after_snapshot->>'valid_from' = m.valid_from::text
         )
       )
  )
$function$;

revoke all on function public.direct_entry__internal_recruiter_team_membership_effective(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry__internal_recruiter_provider_membership_effective(
  p_membership_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.recruiter_provider_memberships m
      join public.recruiters r
        on r.recruiter_id = m.recruiter_id
       and r.active
      left join public.vendors v
        on v.vendor_id = m.vendor_id
     where m.membership_id = p_membership_id
       and (m.vendor_id is null or v.active)
       and m.valid_from <= p_as_of
       and (m.valid_to is null or p_as_of < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from)
       and (
         m.is_current
         or m.valid_from > public.direct_entry_authorization_date()
         or m.valid_to is not null
         or exists (
           select 1
             from public.recruiter_provider_memberships prev
            where prev.recruiter_id = m.recruiter_id
              and prev.membership_id <> m.membership_id
              and prev.is_current
              and prev.valid_to is not null
              and prev.valid_to > prev.valid_from
              and prev.valid_to <= m.valid_from
              and prev.valid_to <= public.direct_entry_authorization_date()
         )
       )
  )
$function$;

revoke all on function public.direct_entry__internal_recruiter_provider_membership_effective(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.work_report_sync_team_leader_capabilities()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_capability text;
  v_grant_id uuid;
  v_grant_from date;
begin
  if new.is_current then
    if tg_op = 'UPDATE'
       and old.valid_to is null
       and new.valid_to is not null
       and new.valid_to > new.valid_from then
      update public.direct_entry_capability_grants g
         set valid_to = greatest(new.valid_to, g.valid_from)
        from public.work_report_team_leader_capability_grants x
       where x.leader_assignment_id = new.assignment_id
         and x.capability_grant_id = g.grant_id
         and g.valid_to is null;
    elsif tg_op = 'UPDATE'
       and old.valid_to is not null
       and old.valid_to > old.valid_from
       and new.valid_to is null then
      update public.direct_entry_capability_grants g
         set valid_to = null,
             is_current = true
        from public.work_report_team_leader_capability_grants x
       where x.leader_assignment_id = new.assignment_id
         and x.capability_grant_id = g.grant_id
         and g.valid_to = old.valid_to
         and g.valid_to > g.valid_from
         and not exists (
           select 1
             from public.direct_entry_capability_grants other
            where other.app_user_id = g.app_user_id
              and other.capability = g.capability
              and other.grant_id <> g.grant_id
              and (
                other.is_current
                or (
                  (other.valid_to is null or other.valid_to > other.valid_from)
                  and daterange(other.valid_from, other.valid_to, '[)')
                      && daterange(g.valid_from, null, '[)')
                )
              )
         );
    end if;

    foreach v_capability in array array['report_view','report_analytics_view','report_assign','report_review'] loop
      if not exists (
        select 1 from public.direct_entry_capability_grants g
         where g.app_user_id = new.leader_app_user_id
           and g.capability = v_capability
           and g.is_current
      ) then
        if exists (
          select 1 from public.direct_entry_capability_grants g
           where g.app_user_id = new.leader_app_user_id
             and g.capability = v_capability
             and not g.is_current
             and g.valid_to is null
        ) then
          perform set_config('direct_entry.team_leader_marker', 'on', true);
          update public.direct_entry_capability_grants g
             set valid_to = greatest(new.valid_from, g.valid_from)
           where g.app_user_id = new.leader_app_user_id
             and g.capability = v_capability
             and not g.is_current
             and g.valid_to is null;
        end if;

        select greatest(new.valid_from, coalesce(max(g.valid_to), new.valid_from))
          into v_grant_from
          from public.direct_entry_capability_grants g
         where g.app_user_id = new.leader_app_user_id
           and g.capability = v_capability
           and not g.is_current
           and g.valid_to is not null
           and g.valid_to > g.valid_from
           and daterange(g.valid_from, g.valid_to, '[)') && daterange(new.valid_from, null, '[)');

        insert into public.direct_entry_capability_grants
          (app_user_id, capability, valid_from, valid_to, is_current)
        values (new.leader_app_user_id, v_capability, v_grant_from, null, true)
        returning grant_id into v_grant_id;

        insert into public.work_report_team_leader_capability_grants
          (leader_assignment_id, capability, capability_grant_id)
        values (new.assignment_id, v_capability, v_grant_id)
        on conflict (leader_assignment_id, capability) do update
          set capability_grant_id = excluded.capability_grant_id;
      end if;
    end loop;
  elsif tg_op = 'UPDATE' and old.is_current and not new.is_current then
    perform set_config('direct_entry.team_leader_marker', 'on', true);
    update public.direct_entry_capability_grants g
       set is_current = false,
           valid_to = greatest(coalesce(new.valid_to, g.valid_from), g.valid_from)
      from public.work_report_team_leader_capability_grants x
     where x.leader_assignment_id = old.assignment_id
       and x.capability_grant_id = g.grant_id
       and (g.is_current or g.valid_to is null);
  end if;
  return new;
end;
$function$;

revoke all on function public.work_report_sync_team_leader_capabilities()
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_has_capability(p_app_user_id uuid, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
     and p_capability is not null
     and p_capability not in ('pii_view', 'pii_export', 'payment_view', 'payment_edit')
     and exists (
       select 1
         from public.direct_entry_capability_grants g
        where g.app_user_id = p_app_user_id
          and g.capability = p_capability
          and public.direct_entry__internal_capability_grant_effective(g.grant_id)
     )
$function$;

create or replace function public.direct_entry_has_scope(p_app_user_id uuid, p_scope_kind text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
     and p_scope_kind in ('own', 'team', 'all')
     and exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = p_app_user_id
          and u.enabled
     )
     and exists (
       select 1
         from public.direct_entry_scope_grants s
        where s.app_user_id = p_app_user_id
          and s.scope_kind = p_scope_kind
          and (
            (s.scope_kind <> 'team' and s.is_current)
            or (
              s.scope_kind = 'team'
              and public.direct_entry__internal_team_scope_grant_effective(s.grant_id)
            )
          )
     )
$function$;

create or replace function public.direct_entry_resolve_actor_context(p_auth_subject uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_id uuid;
  v_review_scopes jsonb;
begin
  select u.app_user_id into v_app_user_id
    from public.direct_entry_app_users u where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  select case when not u.enabled then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind', s.kind,
      'team_id', s.team_id,
      'label', s.label
    ) order by case when s.kind = 'all' then 0 else 1 end, s.label, s.team_id)
      from (
        select distinct
          raw_scopes.kind,
          raw_scopes.team_id,
          raw_scopes.label
        from (
          select 'all'::text as kind, null::uuid as team_id, 'Toàn công ty'::text as label
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and public.direct_entry_has_scope(u.app_user_id, 'all')
          union all
          select 'team'::text as kind, t.team_id, coalesce(t.display_name, t.code) as label
            from public.direct_entry_scope_grants g
            join public.teams t on t.team_id = g.team_id and t.active
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and g.app_user_id = u.app_user_id
             and g.scope_kind = 'team'
             and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
          union all
          select d.scope_kind as kind,
                 case when d.scope_kind = 'team' then d.scope_team_id else null end as team_id,
                 case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end as label
            from public.work_report_delegations d
            left join public.teams tm on tm.team_id = d.scope_team_id
           where d.delegate_app_user_id = u.app_user_id
             and d.capability = 'report_review'
             and d.state = 'ACTIVE'
             and d.is_current
             and statement_timestamp() between d.effective_from and d.effective_to
             and public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
        ) raw_scopes
      ) s
  ), '[]'::jsonb) end
    into v_review_scopes
    from public.direct_entry_app_users u
   where u.app_user_id = v_app_user_id;

  return (
    select jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce((
        select jsonb_agg(distinct g.capability order by g.capability)
          from public.direct_entry_capability_grants g
         where g.app_user_id = u.app_user_id
           and public.direct_entry__internal_capability_grant_effective(g.grant_id)
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
              and g.team_id = t.team_id
              and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
         )
      ), '[]'::jsonb),
      'team_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', g.team_id,
          'valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from, g.team_id)
          from public.direct_entry_scope_grants g
          join public.teams t on t.team_id = g.team_id and t.active
         where g.app_user_id = u.app_user_id
           and g.scope_kind = 'team'
           and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
      ), '[]'::jsonb),
      'all_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id and g.scope_kind = 'all' and g.is_current and u.enabled
      ), '[]'::jsonb)
    ) || case
      when jsonb_array_length(v_review_scopes) > 0 then jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u where u.app_user_id = v_app_user_id
  );
end;
$function$;

create or replace function public.direct_entry_assert_team_leader_current_team(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_scope_count integer;
  v_scope_team_id uuid;
  v_link_count integer;
  v_link_recruiter_id uuid;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_assignment_count integer;
  v_matching_assignment_count integer;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_has_capability(p_app_user_id, 'team_manager_assign') then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int, (array_agg(s.team_id))[1]
    into v_scope_count, v_scope_team_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_app_user_id
     and s.scope_kind = 'team'
     and public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today);
  if v_scope_count <> 1 or v_scope_team_id is null
     or (p_team_id is not null and p_team_id <> v_scope_team_id) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.teams t
     where t.team_id = v_scope_team_id and t.active and t.code <> '__system_vendor__'
  ) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int, (array_agg(l.recruiter_id))[1]
    into v_link_count, v_link_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id and l.verified and l.is_current;
  if v_link_count <> 1 or v_link_recruiter_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = v_link_recruiter_id and r.active
  ) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int,
         count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::int
    into v_provider_count, v_hrp_provider_count
    from public.recruiter_provider_memberships m
   where m.recruiter_id = v_link_recruiter_id
     and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today);
  if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int, count(*) filter (where m.team_id = v_scope_team_id)::int
    into v_membership_count, v_matching_membership_count
    from public.recruiter_team_memberships m
   where m.recruiter_id = v_link_recruiter_id
     and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today);
  if v_membership_count <> 1 or v_matching_membership_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::int,
         count(*) filter (where a.leader_recruiter_id = v_link_recruiter_id
                            and a.team_id = v_scope_team_id)::int
    into v_assignment_count, v_matching_assignment_count
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_app_user_id
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);
  if v_assignment_count <> 1 or v_matching_assignment_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;
  return v_scope_team_id;
end;
$function$;

revoke all on function public.direct_entry_assert_team_leader_current_team(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_list_team_leaders_current(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
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
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today)
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
         and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today)
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
    'authorization_date', v_today,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'leaders', v_leaders
  );
end;
$function$;

create or replace function public.direct_entry_list_team_leader_candidates(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
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
           and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
      ) providers
      cross join lateral (
        select count(*)::int as membership_count,
               count(*) filter (where m.team_id = p_team_id)::int as target_count
          from public.recruiter_team_memberships m
         where m.recruiter_id = r.recruiter_id
           and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
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
            and (
              public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today)
              or (a.valid_from > v_today and (a.valid_to is null or a.valid_to > a.valid_from))
            )
       )
       and not exists (
         select 1 from public.direct_entry_scope_grants s
          where s.app_user_id = u.app_user_id
            and s.scope_kind = 'team'
            and (
              public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today)
              or (s.valid_from > v_today and (s.valid_to is null or s.valid_to > s.valid_from))
            )
       )
       and not exists (
         select 1 from public.direct_entry_capability_grants g
          where g.app_user_id = u.app_user_id
            and g.capability = 'team_manager_assign'
            and (
              public.direct_entry__internal_capability_grant_effective(g.grant_id, v_today)
              or (g.valid_from > v_today and (g.valid_to is null or g.valid_to > g.valid_from))
            )
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

create or replace function public.direct_entry_apply_team_leader_mutation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_target_leader_app_user_id uuid,
  p_effective_date date,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text,
  p_operation text,
  p_authority text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_team public.teams;
  v_old public.direct_entry_team_leader_assignments%rowtype;
  v_new public.direct_entry_team_leader_assignments%rowtype;
  v_old_count integer := 0;
  v_origin public.direct_entry_team_leader_revisions%rowtype;
  v_previous public.direct_entry_team_leader_assignments%rowtype;
  v_prev_scope_grant_id uuid;
  v_prev_scope_grant_count integer := 0;
  v_prev_capability_grant_id uuid;
  v_prev_capability_grant_count integer := 0;
  v_restore boolean := false;
  v_restore_recruiter_id uuid;
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
  v_post_restored_assignment_count integer;
  v_post_restored_scope_count integer;
  v_post_restored_capability_count integer;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_operation not in ('designate', 'revoke') then
    raise exception 'invalid team leader operation' using errcode = '22023';
  end if;
  if (p_operation = 'designate') <> (p_target_leader_app_user_id is not null) then
    raise exception 'target leader does not match operation' using errcode = '22023';
  end if;
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_effective_date is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected team version required' using errcode = '22023';
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

  if v_team.version <> p_expected_version then
    raise exception 'team version conflict' using errcode = '40001';
  end if;
  if p_operation = 'designate' and not v_team.active then
    raise exception 'target team is inactive' using errcode = '23514';
  end if;

  update public.direct_entry_team_leader_assignments a
     set is_current = false
   where a.team_id = p_team_id
     and a.is_current
     and a.valid_to is not null
     and a.valid_to <= v_today;

  update public.direct_entry_scope_grants s
     set is_current = false
   where s.scope_kind = 'team'
     and s.team_id = p_team_id
     and s.is_current
     and s.valid_to is not null
     and s.valid_to <= v_today;

  update public.direct_entry_capability_grants g
     set is_current = false
   where g.capability = 'team_manager_assign'
     and g.is_current
     and g.valid_to is not null
     and g.valid_to <= v_today
     and exists (
       select 1
         from public.direct_entry_team_leader_assignments a
        where a.team_id = p_team_id
          and a.leader_app_user_id = g.app_user_id
          and a.valid_from = g.valid_from
          and a.valid_to = g.valid_to
     );

  update public.direct_entry_team_leader_assignments a
     set is_current = true
   where a.team_id = p_team_id
     and not a.is_current
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);

  update public.direct_entry_scope_grants s
     set is_current = true
   where s.scope_kind = 'team'
     and s.team_id = p_team_id
     and not s.is_current
     and public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today);

  update public.direct_entry_capability_grants g
     set is_current = true
   where g.capability = 'team_manager_assign'
     and not g.is_current
     and public.direct_entry__internal_capability_grant_effective(g.grant_id, v_today)
     and exists (
       select 1
         from public.direct_entry_team_leader_assignments a
        where a.team_id = p_team_id
          and a.leader_app_user_id = g.app_user_id
          and g.valid_from = a.valid_from
          and g.valid_to is not distinct from a.valid_to
     );

  select count(*)::int into v_old_count
    from public.direct_entry_team_leader_assignments a
   where a.team_id = p_team_id
     and (a.valid_to is null or a.valid_to > a.valid_from)
     and daterange(a.valid_from, a.valid_to, '[)')
         && daterange(p_effective_date, null, '[)');
  if v_old_count > 1 then
    raise exception 'team leader assignment is ambiguous' using errcode = '42501';
  end if;
  if v_old_count = 1 then
    select a.* into v_old
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and daterange(a.valid_from, a.valid_to, '[)')
           && daterange(p_effective_date, null, '[)')
     order by a.valid_from, a.assignment_id
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

  if p_operation = 'revoke'
     and v_old_count = 1
     and p_effective_date = v_old.valid_from then
    select r.* into v_origin
      from public.direct_entry_team_leader_revisions r
     where r.team_id = p_team_id
       and r.after_snapshot->>'leader_app_user_id' = v_old.leader_app_user_id::text
       and r.after_snapshot->>'valid_from' = v_old.valid_from::text
     order by r.version desc
     limit 1;
    if found and v_origin.action = 'replace' then
      select a.* into v_previous
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.valid_to = v_old.valid_from
         and a.valid_from < a.valid_to
         and exists (
           select 1
             from public.direct_entry_team_leader_revisions r
            where r.team_id = p_team_id
              and r.version <= v_origin.version
              and r.action = 'replace'
              and r.after_snapshot->>'valid_from' = v_old.valid_from::text
              and r.before_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
              and r.before_snapshot->>'leader_recruiter_id' = a.leader_recruiter_id::text
              and r.before_snapshot->>'valid_from' = a.valid_from::text
              and not exists (
                select 1
                  from public.direct_entry_team_leader_revisions r2
                 where r2.team_id = p_team_id
                   and r2.version > r.version
                   and (
                     r2.action <> 'replace'
                     or r2.after_snapshot->>'valid_from' <> v_old.valid_from::text
                   )
              )
         )
       order by a.valid_from desc, a.assignment_id desc
       limit 1;
    end if;
  end if;

  v_actor_ids := array_remove(array[
    case when v_old_count = 1 then v_old.leader_app_user_id end,
    p_target_leader_app_user_id,
    v_previous.leader_app_user_id
  ]::uuid[], null);

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

  for v_lock_key in
    select distinct key
      from unnest(array[
        case when v_old_count = 1 then
          'capability:' || v_old.leader_app_user_id::text || ':team_manager_assign' end,
        case when v_old_count = 1 then
          'scope:' || v_old.leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when v_previous.assignment_id is not null then
          'capability:' || v_previous.leader_app_user_id::text || ':team_manager_assign' end,
        case when v_previous.assignment_id is not null then
          'scope:' || v_previous.leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when v_previous.assignment_id is not null then
          'recruiter-link:' || v_previous.leader_app_user_id::text end,
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
       and (
         l.is_current
         or (
           p_effective_date > v_today
           and l.valid_from <= p_effective_date
           and (l.valid_to is null or p_effective_date < l.valid_to)
           and (l.valid_to is null or l.valid_to > l.valid_from)
         )
       );
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
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date);
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
       and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, p_effective_date);
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'target recruiter must have exactly one effective membership in the target team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_leader_app_user_id
         and a.team_id <> p_team_id
         and (
           a.is_current
           or (
             (a.valid_to is null or a.valid_to > a.valid_from)
             and daterange(a.valid_from, a.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
    ) then
      raise exception 'target leader is assigned or scheduled for another team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = p_target_leader_app_user_id
         and s.scope_kind = 'team'
         and (
           s.is_current
           or (
             (s.valid_to is null or s.valid_to > s.valid_from)
             and daterange(s.valid_from, s.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_target_leader_app_user_id
         and g.capability = 'team_manager_assign'
         and (
           g.is_current
           or (
             (g.valid_to is null or g.valid_to > g.valid_from)
             and daterange(g.valid_from, g.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
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
     where s.app_user_id = v_old.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = p_team_id
       and s.valid_from <= v_old.valid_from
       and s.valid_to is not distinct from v_old.valid_to
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int, (array_agg(g.grant_id order by g.grant_id))[1]
      into v_capability_count, v_capability_grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = v_old.valid_from
       and g.valid_to is not distinct from v_old.valid_to
       and (g.valid_to is null or g.valid_to > g.valid_from);
    if v_scope_count <> 1 or v_capability_count <> 1 then
      raise exception 'leader authority interval state conflict'
        using errcode = '23514';
    end if;
    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team'
         and (
           s.is_current
           or (
             (s.valid_to is null or s.valid_to > s.valid_from)
             and daterange(s.valid_from, s.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
         and s.grant_id <> v_scope_grant_id
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and (
           g.is_current
           or (
             (g.valid_to is null or g.valid_to > g.valid_from)
             and daterange(g.valid_from, g.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
         and g.grant_id <> v_capability_grant_id
    ) then
      raise exception 'outgoing leader has ambiguous future authority intervals'
        using errcode = '42501';
    end if;
  end if;

  if p_operation = 'revoke' and v_previous.assignment_id is not null then
    perform a.assignment_id
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_previous.assignment_id
     for update;

    select count(*)::int, (array_agg(s.grant_id order by s.grant_id))[1]
      into v_prev_scope_grant_count, v_prev_scope_grant_id
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_previous.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = p_team_id
       and s.valid_from <= v_previous.valid_from
       and s.valid_to = v_previous.valid_to
       and s.valid_to > s.valid_from;

    select count(*)::int, (array_agg(g.grant_id order by g.grant_id))[1]
      into v_prev_capability_grant_count, v_prev_capability_grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_previous.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = v_previous.valid_from
       and g.valid_to = v_previous.valid_to
       and g.valid_to > g.valid_from;

    select (array_agg(l.recruiter_id order by l.link_id) filter (where l.verified))[1]
      into v_restore_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = v_previous.leader_app_user_id
       and l.is_current;

    if v_team.active
       and v_prev_scope_grant_count = 1
       and v_prev_capability_grant_count = 1
       and v_restore_recruiter_id is not null
       and v_restore_recruiter_id = v_previous.leader_recruiter_id
       and exists (
         select 1
           from public.direct_entry_app_users u
           join public.recruiters r on r.recruiter_id = v_restore_recruiter_id
          where u.app_user_id = v_previous.leader_app_user_id
            and u.enabled
            and r.active
       )
       and (
         select count(*)::int
           from public.direct_entry_app_user_recruiter_links l
          where l.app_user_id = v_previous.leader_app_user_id
            and l.is_current
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_provider_memberships m
          where m.recruiter_id = v_restore_recruiter_id
            and m.provider_type = 'hrp'
            and m.vendor_id is null
            and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = v_restore_recruiter_id
            and m.team_id = p_team_id
            and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
       ) = 1
       and not exists (
         select 1
           from public.direct_entry_team_leader_assignments a
          where a.assignment_id not in (v_old.assignment_id, v_previous.assignment_id)
            and (a.team_id = p_team_id or a.leader_app_user_id = v_previous.leader_app_user_id)
            and (
              a.is_current
              or (
                (a.valid_to is null or a.valid_to > a.valid_from)
                and daterange(a.valid_from, a.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       )
       and not exists (
         select 1
           from public.direct_entry_scope_grants s
          where s.app_user_id = v_previous.leader_app_user_id
            and s.scope_kind = 'team'
            and s.grant_id not in (v_scope_grant_id, v_prev_scope_grant_id)
            and (
              s.is_current
              or (
                (s.valid_to is null or s.valid_to > s.valid_from)
                and daterange(s.valid_from, s.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       )
       and not exists (
         select 1
           from public.direct_entry_capability_grants g
          where g.app_user_id = v_previous.leader_app_user_id
            and g.capability = 'team_manager_assign'
            and g.grant_id not in (v_capability_grant_id, v_prev_capability_grant_id)
            and (
              g.is_current
              or (
                (g.valid_to is null or g.valid_to > g.valid_from)
                and daterange(g.valid_from, g.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       ) then
      v_restore := true;
    end if;
  end if;

  if v_old_count = 1 then
    if p_effective_date = v_old.valid_from then
      perform set_config('direct_entry.team_leader_marker', 'on', true);
    end if;
    update public.direct_entry_team_leader_assignments
       set valid_to = p_effective_date,
           is_current = (p_effective_date > v_old.valid_from and v_old.valid_from <= v_today and v_today < p_effective_date)
     where assignment_id = v_old.assignment_id;
    update public.direct_entry_scope_grants
       set valid_to = p_effective_date,
           is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date)
     where grant_id = v_scope_grant_id;
    update public.direct_entry_capability_grants
       set valid_to = p_effective_date,
           is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date)
     where grant_id = v_capability_grant_id;
  end if;

  if v_restore then
    update public.direct_entry_team_leader_assignments
       set valid_to = null,
           is_current = (v_previous.valid_from <= v_today)
     where assignment_id = v_previous.assignment_id;
    update public.direct_entry_scope_grants
       set valid_to = null,
           is_current = (valid_from <= v_today)
     where grant_id = v_prev_scope_grant_id;
    update public.direct_entry_capability_grants
       set valid_to = null,
           is_current = (valid_from <= v_today)
     where grant_id = v_prev_capability_grant_id;
  end if;

  if p_operation = 'designate' then
    insert into public.direct_entry_team_leader_assignments
      (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
    values
      (p_team_id, p_target_leader_app_user_id, v_recruiter_id, p_effective_date, (p_effective_date <= v_today))
    returning * into v_new;
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, team_id, valid_from, is_current)
    values
      (p_target_leader_app_user_id, 'team', p_team_id, p_effective_date, (p_effective_date <= v_today));
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from, is_current)
    values
      (p_target_leader_app_user_id, 'team_manager_assign', p_effective_date, (p_effective_date <= v_today));
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
     where a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);

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
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_target_leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    select count(*)::int into v_post_coextensive_scope_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_scope_grants s
        on s.app_user_id = a.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = a.team_id
       and s.valid_from = a.valid_from
       and s.valid_to is not distinct from a.valid_to
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_coextensive_capability_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_capability_grants g
        on g.app_user_id = a.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = a.valid_from
       and g.valid_to is not distinct from a.valid_to
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
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
         and a.valid_from <= p_effective_date
         and (a.valid_to is null or p_effective_date < a.valid_to)
         and (a.valid_to is null or a.valid_to > a.valid_from);
      select count(*)::int into v_post_outgoing_scope_count
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team' and s.team_id = p_team_id
         and s.valid_from <= p_effective_date
         and (s.valid_to is null or p_effective_date < s.valid_to)
         and (s.valid_to is null or s.valid_to > s.valid_from);
      select count(*)::int into v_post_outgoing_capability_count
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.valid_from <= p_effective_date
         and (g.valid_to is null or p_effective_date < g.valid_to)
         and (g.valid_to is null or g.valid_to > g.valid_from);
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
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);
    select count(*)::int into v_post_outgoing_scope_count
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_old.leader_app_user_id
       and s.scope_kind = 'team' and s.team_id = p_team_id
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_outgoing_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
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
    if v_restore then
      select count(*)::int into v_post_restored_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_previous.assignment_id
         and a.valid_to is null
         and a.is_current = (v_previous.valid_from <= v_today);
      select count(*)::int into v_post_restored_scope_count
        from public.direct_entry_scope_grants s
       where s.grant_id = v_prev_scope_grant_id
         and s.valid_to is null
         and s.is_current = (s.valid_from <= v_today);
      select count(*)::int into v_post_restored_capability_count
        from public.direct_entry_capability_grants g
       where g.grant_id = v_prev_capability_grant_id
         and g.valid_to is null
         and g.is_current = (g.valid_from <= v_today);
      if v_post_team_assignment_count <> 1
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1
         or v_post_restored_assignment_count <> 1
         or v_post_restored_scope_count <> 1
         or v_post_restored_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    else
      if v_post_team_assignment_count <> 0
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
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
      v_old.valid_from, p_effective_date,
      case when v_restore then v_previous.leader_recruiter_id else null end,
      v_team_version, v_change
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

revoke all on function public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.leave_management__internal_resolve_authority(
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
  v_today date := public.leave_management__internal_business_date();
  v_is_full_admin boolean := false;
  v_is_bod boolean := false;
  v_is_admin_bod_grant boolean := false;
  v_is_hr_operator boolean := false;
  v_is_hr_report_viewer boolean := false;
  v_is_team_leader boolean := false;
  v_is_dept_approver boolean := false;
  v_is_shared boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'Direct entry actor mapping is not active'
      using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select exists (
           select 1
             from public.leave_employee_profiles p
            where p.app_user_id = p_app_user_id
              and p.is_shared_non_employee = true
         )
    into v_is_shared;

  v_is_full_admin := (
    public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
    and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
    and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
    and public.direct_entry_has_scope(p_app_user_id, 'all')
  );

  v_is_bod := (
    public.direct_entry_has_scope(p_app_user_id, 'all')
    and (
      public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
      or (
        public.direct_entry_has_capability(p_app_user_id, 'report_analytics_view')
        and public.direct_entry_has_capability(p_app_user_id, 'report_view')
      )
    )
  );

  select exists (
           select 1
             from public.leave_module_grants g
            where g.app_user_id = p_app_user_id
              and g.role_code = 'LEAVE_ADMIN_BOD_APPROVER'
              and g.is_current = true
              and g.valid_from <= v_today
              and (g.valid_to is null or v_today < g.valid_to)
         ),
         exists (
           select 1
             from public.leave_module_grants g
            where g.app_user_id = p_app_user_id
              and g.role_code = 'HR_LEAVE_OPERATOR'
              and g.is_current = true
              and g.valid_from <= v_today
              and (g.valid_to is null or v_today < g.valid_to)
         ),
         exists (
           select 1
             from public.leave_module_grants g
            where g.app_user_id = p_app_user_id
              and g.role_code = 'HR_REPORT_VIEWER'
              and g.is_current = true
              and g.valid_from <= v_today
              and (g.valid_to is null or v_today < g.valid_to)
         )
    into v_is_admin_bod_grant, v_is_hr_operator, v_is_hr_report_viewer;

  select exists (
           select 1
             from public.direct_entry_team_leader_assignments tla
            where tla.leader_app_user_id = p_app_user_id
              and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
         )
    into v_is_team_leader;

  select exists (
           select 1
             from public.leave_department_approvers da
            where da.approver_app_user_id = p_app_user_id
              and da.valid_from <= v_today
              and (da.valid_to is null or v_today < da.valid_to)
              and (da.valid_to is null or da.valid_to > da.valid_from)
         )
    into v_is_dept_approver;

  if v_is_shared then
    v_is_team_leader := false;
    v_is_dept_approver := false;
  end if;

  return pg_catalog.jsonb_build_object(
    'app_user_id', p_app_user_id,
    'is_shared_non_employee', v_is_shared,
    'is_full_admin', v_is_full_admin,
    'is_bod', (v_is_bod or v_is_admin_bod_grant),
    'is_hr_operator', v_is_hr_operator,
    'is_hr_report_viewer', v_is_hr_report_viewer,
    'is_team_leader', v_is_team_leader,
    'is_department_approver', v_is_dept_approver,
    'can_submit_request', (not v_is_shared),
    'can_approve_requests', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_admin_bod_grant or v_is_team_leader or v_is_dept_approver)),
    'can_view_monthly_report', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator or v_is_hr_report_viewer)),
    'can_manage_config', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator))
  );
end;
$function$;

create or replace function public.leave_management__internal_resolve_routing(
  p_app_user_id uuid,
  p_as_of date default public.leave_management__internal_business_date()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_unit_kind text := 'UNCLASSIFIED';
  v_recruiter_id uuid;
  v_team_count integer := 0;
  v_team_id uuid;
  v_team_code text;
  v_team_name text;
  v_leader_count integer := 0;
  v_leader_app_user_id uuid;
  v_dept_approver_id uuid;
  v_is_requester_team_leader boolean := false;
  v_is_requester_dept_approver boolean := false;
begin
  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_app_user_id;

  if found then
    v_has_profile := true;
    v_unit_kind := v_profile.unit_kind;
    v_profile_configured := (
      not v_profile.is_shared_non_employee
      and v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
  end if;

  select l.recruiter_id
    into v_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.app_user_id = p_app_user_id
     and l.verified = true
     and l.is_current = true
     and r.active = true
     and coalesce(r.personnel_code, '') <> '__system_vendor__'
   order by l.valid_from desc, l.link_id desc
   limit 1;

  select exists (
           select 1
             from public.direct_entry_team_leader_assignments tla
            where tla.leader_app_user_id = p_app_user_id
              and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, p_as_of)
         )
    into v_is_requester_team_leader;

  select exists (
           select 1
             from public.leave_department_approvers da
            where da.approver_app_user_id = p_app_user_id
              and da.valid_from <= p_as_of
              and (da.valid_to is null or p_as_of < da.valid_to)
              and (da.valid_to is null or da.valid_to > da.valid_from)
         )
    into v_is_requester_dept_approver;

  if v_is_requester_team_leader or v_is_requester_dept_approver or v_unit_kind = 'MANAGEMENT_BOD' then
    return pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_DIRECT',
      'unit_kind', case when v_unit_kind = 'UNCLASSIFIED' and v_is_requester_team_leader then 'RECRUITMENT' else v_unit_kind end,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', null,
      'profile_configured', v_profile_configured
    );
  end if;

  if v_unit_kind in ('MARKETING', 'IT', 'ACCOUNTING') then
    select da.approver_app_user_id
      into v_dept_approver_id
      from public.leave_department_approvers da
      join public.direct_entry_app_users u on u.app_user_id = da.approver_app_user_id
     where da.unit_kind = v_unit_kind
       and da.valid_from <= p_as_of
       and (da.valid_to is null or p_as_of < da.valid_to)
       and (da.valid_to is null or da.valid_to > da.valid_from)
       and u.enabled = true
     order by da.valid_from desc, da.row_version desc
     limit 1;

    if v_dept_approver_id is not null and v_dept_approver_id <> p_app_user_id then
      return pg_catalog.jsonb_build_object(
        'route_kind', 'DEPARTMENT_HEAD',
        'unit_kind', v_unit_kind,
        'primary_approver_app_user_id', v_dept_approver_id,
        'team_id', null,
        'team_code', null,
        'team_name', null,
        'fallback_reason', null,
        'profile_configured', v_profile_configured
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_FALLBACK',
      'unit_kind', v_unit_kind,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', 'DEPARTMENT_APPROVER_NOT_CONFIGURED',
      'profile_configured', v_profile_configured
    );
  end if;

  if v_recruiter_id is not null then
    select count(*)::integer,
           (pg_catalog.array_agg(t.team_id order by t.code))[1],
           (pg_catalog.array_agg(t.code order by t.code))[1],
           (pg_catalog.array_agg(t.display_name order by t.code))[1]
      into v_team_count, v_team_id, v_team_code, v_team_name
      from public.recruiter_team_memberships rtm
      join public.teams t on t.team_id = rtm.team_id
     where rtm.recruiter_id = v_recruiter_id
       and t.active = true
       and t.code <> '__system_vendor__'
       and public.direct_entry__internal_recruiter_team_membership_effective(rtm.membership_id, p_as_of);

    if v_team_count = 1 then
      select count(distinct tla.leader_app_user_id)::integer,
             (pg_catalog.array_agg(tla.leader_app_user_id order by tla.valid_from desc, tla.assignment_id desc))[1]
        into v_leader_count, v_leader_app_user_id
        from public.direct_entry_team_leader_assignments tla
       where tla.team_id = v_team_id
         and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, p_as_of);

      if v_leader_count = 1 and v_leader_app_user_id is not null and v_leader_app_user_id <> p_app_user_id then
        return pg_catalog.jsonb_build_object(
          'route_kind', 'TEAM_LEADER',
          'unit_kind', case when v_unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_unit_kind end,
          'primary_approver_app_user_id', v_leader_app_user_id,
          'team_id', v_team_id,
          'team_code', v_team_code,
          'team_name', v_team_name,
          'fallback_reason', null,
          'profile_configured', v_profile_configured
        );
      end if;

      return pg_catalog.jsonb_build_object(
        'route_kind', 'ADMIN_BOD_FALLBACK',
        'unit_kind', case when v_unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_unit_kind end,
        'primary_approver_app_user_id', null,
        'team_id', v_team_id,
        'team_code', v_team_code,
        'team_name', v_team_name,
        'fallback_reason', case when v_leader_count = 0 then 'TEAM_WITHOUT_ACTIVE_LEADER' else 'TEAM_MULTIPLE_LEADERS_OR_SELF' end,
        'profile_configured', v_profile_configured
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_FALLBACK',
      'unit_kind', case when v_unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_unit_kind end,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', case when v_team_count = 0 then 'RECRUITER_WITHOUT_ACTIVE_TEAM' else 'RECRUITER_MULTI_ACTIVE_TEAMS' end,
      'profile_configured', v_profile_configured
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'route_kind', 'ADMIN_BOD_FALLBACK',
    'unit_kind', v_unit_kind,
    'primary_approver_app_user_id', null,
    'team_id', null,
    'team_code', null,
    'team_name', null,
    'fallback_reason', case when not v_has_profile or not v_profile_configured then 'PROFILE_UNCONFIGURED_OR_UNMAPPED' else 'UNMAPPED_UNIT_OR_RECRUITER' end,
    'profile_configured', v_profile_configured
  );
end;
$function$;

create or replace function public.leave_management__internal_can_actor_decide_request(
  p_actor_app_user_id uuid,
  p_request public.leave_requests,
  p_as_of date default public.leave_management__internal_business_date()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_auth jsonb;
  v_is_admin_or_bod boolean := false;
  v_is_current_team_leader boolean := false;
  v_is_current_dept_approver boolean := false;
begin
  if p_actor_app_user_id is null or p_request.request_id is null then
    return false;
  end if;

  if p_actor_app_user_id = p_request.app_user_id then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id;

  if not found or not v_user.enabled then
    return false;
  end if;

  v_auth := public.leave_management__internal_resolve_authority(v_user.auth_subject, p_actor_app_user_id);
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    return false;
  end if;

  v_is_admin_or_bod := (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  );

  if v_is_admin_or_bod then
    return true;
  end if;

  if p_request.primary_approver_app_user_id = p_actor_app_user_id then
    return true;
  end if;

  if p_request.route_kind = 'TEAM_LEADER' and p_request.routed_team_id is not null then
    select exists (
             select 1
               from public.direct_entry_team_leader_assignments tla
              where tla.team_id = p_request.routed_team_id
                and tla.leader_app_user_id = p_actor_app_user_id
                and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, p_as_of)
           )
      into v_is_current_team_leader;
    if v_is_current_team_leader then
      return true;
    end if;
  end if;

  if p_request.route_kind = 'DEPARTMENT_HEAD' and p_request.unit_kind_snapshot in ('MARKETING', 'IT', 'ACCOUNTING') then
    select exists (
             select 1
               from public.leave_department_approvers da
              where da.unit_kind = p_request.unit_kind_snapshot
                and da.approver_app_user_id = p_actor_app_user_id
                and da.valid_from <= p_as_of
                and (da.valid_to is null or p_as_of < da.valid_to)
                and (da.valid_to is null or da.valid_to > da.valid_from)
           )
      into v_is_current_dept_approver;
    if v_is_current_dept_approver then
      return true;
    end if;
  end if;

  return false;
end;
$function$;

revoke all on function
  public.leave_management__internal_resolve_authority(uuid, uuid),
  public.leave_management__internal_resolve_routing(uuid, date),
  public.leave_management__internal_can_actor_decide_request(uuid, public.leave_requests, date)
from public, anon, authenticated, service_role;

create or replace function public.direct_entry__internal_reconcile_cancelled_team_leaders(
  p_as_of_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := coalesce(p_as_of_date, public.direct_entry_authorization_date());
  v_cand record;
  v_prev public.direct_entry_team_leader_assignments;
  v_prev_scope_grant_id uuid;
  v_prev_scope_grant_count integer;
  v_prev_capability_grant_id uuid;
  v_prev_capability_grant_count integer;
  v_recruiter_id uuid;
  v_restored_count integer := 0;
  v_restored_teams jsonb := '[]'::jsonb;
begin
  update public.direct_entry_team_leader_assignments a
     set is_current = false
   where a.is_current
     and a.valid_to is not null
     and a.valid_to <= v_today;

  update public.direct_entry_scope_grants s
     set is_current = false
   where s.scope_kind = 'team'
     and s.is_current
     and s.valid_to is not null
     and s.valid_to <= v_today;

  update public.direct_entry_capability_grants g
     set is_current = false
   where g.capability = 'team_manager_assign'
     and g.is_current
     and g.valid_to is not null
     and g.valid_to <= v_today;

  update public.direct_entry_team_leader_assignments a
     set is_current = true
   where not a.is_current
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);

  update public.direct_entry_scope_grants s
     set is_current = true
   where s.scope_kind = 'team'
     and not s.is_current
     and public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today);

  update public.direct_entry_capability_grants g
     set is_current = true
   where g.capability = 'team_manager_assign'
     and not g.is_current
     and public.direct_entry__internal_capability_grant_effective(g.grant_id, v_today)
     and exists (
       select 1
         from public.direct_entry_team_leader_assignments a
        where a.leader_app_user_id = g.app_user_id
          and g.valid_from = a.valid_from
          and g.valid_to is not distinct from a.valid_to
     );

  for v_cand in
    select distinct on (r_rev.team_id)
           r_rev.team_id,
           r_rev.revision_id as revoke_revision_id,
           r_rev.version as revoke_version,
           r_rep.revision_id as replace_revision_id,
           r_rep.version as replace_version,
           (r_rep.before_snapshot->>'leader_app_user_id')::uuid as prev_leader_app_user_id,
           (r_rep.before_snapshot->>'leader_recruiter_id')::uuid as prev_leader_recruiter_id,
           (r_rep.before_snapshot->>'valid_from')::date as prev_valid_from,
           (r_rep.after_snapshot->>'valid_from')::date as cancelled_date
      from public.direct_entry_team_leader_revisions r_rev
      join public.direct_entry_team_leader_revisions r_rep
        on r_rep.team_id = r_rev.team_id
       and r_rep.version < r_rev.version
       and r_rep.action = 'replace'
       and r_rep.after_snapshot->>'valid_from' = r_rev.after_snapshot->>'valid_from'
     where r_rev.action = 'revoke'
       and r_rev.after_snapshot->>'valid_from' = r_rev.after_snapshot->>'valid_to'
       and r_rev.after_snapshot->>'previous_leader_recruiter_id' is null
       and not exists (
         select 1
           from public.direct_entry_team_leader_revisions r_later
          where r_later.team_id = r_rev.team_id
            and r_later.version > r_rev.version
       )
       and not exists (
         select 1
           from public.direct_entry_team_leader_revisions r_mid
          where r_mid.team_id = r_rev.team_id
            and r_mid.version > r_rep.version
            and r_mid.version < r_rev.version
            and (
              r_mid.action <> 'replace'
              or r_mid.after_snapshot->>'valid_from' <> r_rev.after_snapshot->>'valid_from'
            )
       )
     order by r_rev.team_id, r_rev.version desc, r_rep.version asc
  loop
    select * into v_prev
      from public.direct_entry_team_leader_assignments a
     where a.team_id = v_cand.team_id
       and a.leader_app_user_id = v_cand.prev_leader_app_user_id
       and a.leader_recruiter_id = v_cand.prev_leader_recruiter_id
       and a.valid_from = v_cand.prev_valid_from
       and a.valid_to = v_cand.cancelled_date
       and a.valid_from < a.valid_to
     order by a.created_at desc, a.assignment_id desc
     limit 1
     for update;

    if not found then
      continue;
    end if;

    select count(*)::int, (array_agg(s.grant_id order by s.grant_id))[1]
      into v_prev_scope_grant_count, v_prev_scope_grant_id
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_prev.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = v_prev.team_id
       and s.valid_from <= v_prev.valid_from
       and s.valid_to = v_prev.valid_to;

    select count(*)::int, (array_agg(g.grant_id order by g.grant_id))[1]
      into v_prev_capability_grant_count, v_prev_capability_grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_prev.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = v_prev.valid_from
       and g.valid_to = v_prev.valid_to;

    select (array_agg(l.recruiter_id order by l.link_id) filter (where l.verified))[1]
      into v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = v_prev.leader_app_user_id
       and l.is_current
       and l.valid_from <= v_today
       and (l.valid_to is null or l.valid_to > v_today);

    if v_prev_scope_grant_count = 1
       and v_prev_capability_grant_count = 1
       and v_recruiter_id is not null
       and v_recruiter_id = v_prev.leader_recruiter_id
       and exists (
         select 1
           from public.teams t
           join public.direct_entry_app_users u on u.app_user_id = v_prev.leader_app_user_id
           join public.recruiters r on r.recruiter_id = v_recruiter_id
          where t.team_id = v_prev.team_id
            and t.active
            and t.code <> '__system_vendor__'
            and u.enabled
            and r.active
       )
       and (
         select count(*)::int
           from public.direct_entry_app_user_recruiter_links l
          where l.app_user_id = v_prev.leader_app_user_id
            and l.is_current
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_provider_memberships m
          where m.recruiter_id = v_recruiter_id
            and m.provider_type = 'hrp'
            and m.vendor_id is null
            and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = v_recruiter_id
            and m.team_id = v_prev.team_id
            and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
       ) = 1
       and not exists (
         select 1
           from public.direct_entry_team_leader_assignments a
          where a.assignment_id <> v_prev.assignment_id
            and (a.team_id = v_prev.team_id or a.leader_app_user_id = v_prev.leader_app_user_id)
            and (
              a.is_current
              or (
                (a.valid_to is null or a.valid_to > a.valid_from)
                and daterange(a.valid_from, a.valid_to, '[)')
                    && daterange(v_prev.valid_from, null, '[)')
              )
            )
       )
       and not exists (
         select 1
           from public.direct_entry_scope_grants s
          where s.app_user_id = v_prev.leader_app_user_id
            and s.scope_kind = 'team'
            and s.grant_id <> v_prev_scope_grant_id
            and (
              s.is_current
              or (
                (s.valid_to is null or s.valid_to > s.valid_from)
                and daterange(s.valid_from, s.valid_to, '[)')
                    && daterange(v_prev.valid_from, null, '[)')
              )
            )
       )
       and not exists (
         select 1
           from public.direct_entry_capability_grants g
          where g.app_user_id = v_prev.leader_app_user_id
            and g.capability = 'team_manager_assign'
            and g.grant_id <> v_prev_capability_grant_id
            and (
              g.is_current
              or (
                (g.valid_to is null or g.valid_to > g.valid_from)
                and daterange(g.valid_from, g.valid_to, '[)')
                    && daterange(v_prev.valid_from, null, '[)')
              )
            )
       ) then
      update public.direct_entry_team_leader_assignments
         set valid_to = null,
             is_current = (v_prev.valid_from <= v_today)
       where assignment_id = v_prev.assignment_id;

      update public.direct_entry_scope_grants
         set valid_to = null,
             is_current = (valid_from <= v_today)
       where grant_id = v_prev_scope_grant_id;

      update public.direct_entry_capability_grants
         set valid_to = null,
             is_current = (valid_from <= v_today)
       where grant_id = v_prev_capability_grant_id;

      v_restored_count := v_restored_count + 1;
      v_restored_teams := v_restored_teams || jsonb_build_array(jsonb_build_object(
        'team_id', v_prev.team_id,
        'assignment_id', v_prev.assignment_id,
        'leader_app_user_id', v_prev.leader_app_user_id,
        'valid_from', v_prev.valid_from,
        'cancelled_date', v_cand.cancelled_date
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'as_of_date', v_today,
    'restored_count', v_restored_count,
    'restored_teams', v_restored_teams
  );
end;
$function$;

revoke all on function public.direct_entry__internal_reconcile_cancelled_team_leaders(date)
  from public, anon, authenticated, service_role;


-- =============================================================================
-- 1. Deterministic one-time reconciliation of stale/rolled-over `is_current` rows
--    and historical team leader assignments closed by cancelled replacements
-- =============================================================================
do $reconcile_legacy_memberships$
declare
  v_snapshot date := public.direct_entry_authorization_date();
  v_promote_team_ids uuid[];
  v_promote_provider_ids uuid[];
begin
  with eligible_team_rollover as (
    select m.membership_id,
           m.recruiter_id,
           count(*) over (partition by m.recruiter_id) as active_interval_count
      from public.recruiter_team_memberships m
      join public.recruiters r
        on r.recruiter_id = m.recruiter_id
       and r.active
      join public.teams t
        on t.team_id = m.team_id
       and t.active
      join public.recruiter_provider_memberships pm
        on pm.recruiter_id = m.recruiter_id
       and pm.provider_type = 'hrp'
       and pm.valid_from <= v_snapshot
       and (pm.valid_to is null or v_snapshot < pm.valid_to)
       and (pm.valid_to is null or pm.valid_to > pm.valid_from)
     where m.valid_from <= v_snapshot
       and (m.valid_to is null or v_snapshot < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from)
       and (
         m.is_current
         or exists (
           select 1
             from public.recruiter_team_memberships prev
            where prev.recruiter_id = m.recruiter_id
              and prev.is_current
              and prev.valid_to is not null
              and prev.valid_to > prev.valid_from
              and prev.valid_to <= m.valid_from
              and prev.valid_to <= v_snapshot
         )
         or exists (
           select 1
             from public.direct_entry_team_membership_revisions rev
            where rev.recruiter_id = m.recruiter_id
              and rev.after_snapshot->>'change' = 'MOVE'
              and rev.after_snapshot->>'team_id' = m.team_id::text
              and rev.after_snapshot->>'valid_from' = m.valid_from::text
         )
       )
  )
  select coalesce(array_agg(e.membership_id), '{}'::uuid[])
    into v_promote_team_ids
    from eligible_team_rollover e
   where e.active_interval_count = 1;

  update public.recruiter_team_memberships m
     set is_current = false
   where m.is_current
     and (
       (m.valid_to is not null and (m.valid_to <= v_snapshot or m.valid_to <= m.valid_from))
       or m.valid_from > v_snapshot
     );

  update public.recruiter_team_memberships m
     set is_current = true
   where m.membership_id = any(v_promote_team_ids)
     and not m.is_current
     and not exists (
       select 1
         from public.recruiter_team_memberships c
        where c.recruiter_id = m.recruiter_id
          and c.is_current
          and c.membership_id <> m.membership_id
     );

  with eligible_provider_rollover as (
    select m.membership_id,
           m.recruiter_id,
           count(*) over (partition by m.recruiter_id) as active_interval_count
      from public.recruiter_provider_memberships m
      join public.recruiters r
        on r.recruiter_id = m.recruiter_id
       and r.active
      left join public.vendors v
        on v.vendor_id = m.vendor_id
     where m.valid_from <= v_snapshot
       and (m.valid_to is null or v_snapshot < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from)
       and (m.provider_type = 'hrp' or (m.provider_type = 'vendor' and v.active is true))
       and (
         m.is_current
         or exists (
           select 1
             from public.recruiter_provider_memberships prev
            where prev.recruiter_id = m.recruiter_id
              and prev.is_current
              and prev.valid_to is not null
              and prev.valid_to > prev.valid_from
              and prev.valid_to <= m.valid_from
              and prev.valid_to <= v_snapshot
         )
       )
  )
  select coalesce(array_agg(e.membership_id), '{}'::uuid[])
    into v_promote_provider_ids
    from eligible_provider_rollover e
   where e.active_interval_count = 1;

  update public.recruiter_provider_memberships m
     set is_current = false
   where m.is_current
     and (
       (m.valid_to is not null and (m.valid_to <= v_snapshot or m.valid_to <= m.valid_from))
       or m.valid_from > v_snapshot
     );

  update public.recruiter_provider_memberships m
     set is_current = true
   where m.membership_id = any(v_promote_provider_ids)
     and not m.is_current
     and not exists (
       select 1
         from public.recruiter_provider_memberships c
        where c.recruiter_id = m.recruiter_id
          and c.is_current
          and c.membership_id <> m.membership_id
     );

  perform public.direct_entry__internal_reconcile_cancelled_team_leaders(v_snapshot);
end
$reconcile_legacy_memberships$;

-- =============================================================================
-- 2. Align trigger, catalog, entry write RPCs, and personnel projection
-- =============================================================================
do $align_membership_functions$
declare
  v_def text;
  v_updated text;
begin
  v_def := replace(
    pg_get_functiondef('public.direct_entry_validate_new_entry()'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$    select count(*), min(m.provider_type)
      into v_provider_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = new.recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);$old$,
$new$    select count(*), min(m.provider_type)
      into v_provider_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = new.recruiter_id
       and m.valid_from <= public.direct_entry_authorization_date()
       and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from);$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch provider check in direct_entry_validate_new_entry';
  end if;
  v_def := v_updated;
  v_updated := replace(
    v_def,
$old$      select count(*) into v_team_count
        from public.recruiter_team_memberships m
       where m.recruiter_id = new.recruiter_id
         and m.team_id = new.team_id
         and m.valid_from <= public.direct_entry_authorization_date()
         and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to);$old$,
$new$      select count(*) into v_team_count
        from public.recruiter_team_memberships m
       where m.recruiter_id = new.recruiter_id
         and m.team_id = new.team_id
         and m.valid_from <= public.direct_entry_authorization_date()
         and (m.valid_to is null or public.direct_entry_authorization_date() < m.valid_to)
         and (m.valid_to is null or m.valid_to > m.valid_from);$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch team check in direct_entry_validate_new_entry';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_input_catalog_unscoped_v42(uuid,uuid,date)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$  with hrp_memberships as (
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
  )$old$,
$new$  with hrp_memberships as (
    -- P1.6 contract (unchanged from #41): an HRP recruiter is eligible only
    -- when they have exactly one HRP provider membership in force on
    -- `effective_date`. Overlapping HRP memberships are excluded.
    select m.recruiter_id, count(*) as membership_count
      from public.recruiter_provider_memberships m
     where m.provider_type = 'hrp'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  ), vendor_memberships as (
    -- P3-W07A (unchanged from #41): Vendor eligibility is decided by
    -- `provider_type = 'vendor'` membership at `effective_date`. The
    -- catalog surfaces the active membership; overlapping memberships
    -- are filtered by the effective-date window.
    select m.recruiter_id, m.vendor_id
      from public.recruiter_provider_memberships m
     where m.provider_type = 'vendor'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
  ), hrp_teams as (
    select m.recruiter_id, count(*) as membership_count,
           min(m.team_id::text)::uuid as team_id
      from public.recruiter_team_memberships m
     where public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  )$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_input_catalog_unscoped_v42';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$    select count(*), min(m.provider_type) into v_count, v_provider_type
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
    end if;$old$,
$new$    select count(*), min(m.provider_type) into v_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, public.direct_entry_authorization_date());
    if v_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;
    if v_provider_type = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, public.direct_entry_authorization_date());
      if v_count <> 1 then
        raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
      end if;
    end if;$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_create_full_profile_batch';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid,uuid,text,jsonb,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$    select count(*)::integer
      into v_membership_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.provider_type = v_provider_type
       and m.is_current;$old$,
$new$    select count(*)::integer
      into v_membership_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.provider_type = v_provider_type
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, public.direct_entry_authorization_date());$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_create_full_profile_batch_v2_unscoped_h03';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_create_batch(uuid,uuid,jsonb,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$    select count(*), min(m.provider_type) into v_count, v_provider_type
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
    end if;$old$,
$new$    select count(*), min(m.provider_type) into v_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, public.direct_entry_authorization_date());
    if v_count <> 1 then
      raise exception 'recruiter provider membership denied' using errcode = '42501';
    end if;
    if v_provider_type = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, public.direct_entry_authorization_date());
      if v_count <> 1 then
        raise exception 'recruiter team membership denied' using errcode = '42501';
      end if;
    end if;$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_create_batch';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$  select count(*), min(m.provider_type) into v_count, v_provider_type
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
  end if;$old$,
$new$  select count(*), min(m.provider_type) into v_count, v_provider_type
    from public.recruiter_provider_memberships m
   where m.recruiter_id = v_recruiter_id
     and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, public.direct_entry_authorization_date());
  if v_count <> 1 then
    raise exception 'recruiter provider membership denied' using errcode = '42501';
  end if;
  if v_provider_type = 'vendor' then
    v_team_id := public.direct_entry_system_vendor_team_id();
  else
    select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, public.direct_entry_authorization_date());
    if v_count <> 1 then
      raise exception 'recruiter team membership denied' using errcode = '42501';
    end if;
  end if;$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_create_draft_row';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$    select count(*), min(m.provider_type) into v_count, v_provider
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
    end if;$old$,
$new$    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_new_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, public.direct_entry_authorization_date());
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    if v_provider = 'vendor' then
      v_team := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_new_recruiter_id
         and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, public.direct_entry_authorization_date());
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_update_draft_row';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$    select count(*), min(m.provider_type) into v_count, v_provider
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
    end if;$old$,
$new$    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = case when p_patch ? 'recruiter_id'
            then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, public.direct_entry_authorization_date());
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    if v_provider = 'vendor' then
      v_team := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team
        from public.recruiter_team_memberships m
       where m.recruiter_id = case when p_patch ? 'recruiter_id'
              then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end
         and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, public.direct_entry_authorization_date());
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_privileged_edit';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_apply_change_item(uuid,uuid,uuid,direct_entries,text,jsonb,uuid)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$    select count(*), min(m.provider_type) into v_count, v_provider
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
    end if;$old$,
$new$    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, public.direct_entry_authorization_date());
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    if v_provider = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, public.direct_entry_authorization_date());
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_apply_change_item';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_list_team_membership_current(uuid,uuid,uuid,uuid,text,integer,integer)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
    'where (m.is_current)',
    'where public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, public.direct_entry_authorization_date())'
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_list_team_membership_current';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_personnel_admin_projection(recruiters,date,integer)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$       where m.recruiter_id = p_recruiter.recruiter_id
         and m.is_current$old$,
$new$       where m.recruiter_id = p_recruiter.recruiter_id
         and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, public.direct_entry_authorization_date())$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_personnel_admin_projection';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_move_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$  update public.recruiter_team_memberships set valid_to = p_valid_from, is_current = false
   where membership_id = v_open.membership_id;$old$,
$new$  update public.recruiter_team_memberships set is_current = false
   where recruiter_id = p_recruiter_id
     and is_current
     and membership_id <> v_open.membership_id
     and valid_to is not null
     and valid_to <= public.direct_entry_authorization_date();

  update public.recruiter_team_memberships set valid_to = p_valid_from, is_current = false
   where membership_id = v_open.membership_id;$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_move_team_membership';
  end if;
  execute v_updated;

  v_def := replace(
    pg_get_functiondef('public.direct_entry_unassign_team_membership(uuid,uuid,uuid,date,integer,text,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  );
  v_updated := replace(
    v_def,
$old$  if v_restore then
    update public.recruiter_team_memberships set valid_to = null
     where membership_id = v_previous.membership_id;
  end if;$old$,
$new$  if v_restore then
    update public.recruiter_team_memberships set valid_to = null
     where membership_id = v_previous.membership_id;
  else
    update public.recruiter_team_memberships set is_current = false
     where recruiter_id = p_recruiter_id
       and is_current
       and valid_to is not null
       and valid_to <= public.direct_entry_authorization_date();
  end if;$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch direct_entry_unassign_team_membership';
  end if;
  execute v_updated;
end
$align_membership_functions$;

do $owner_align$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_fn regprocedure;
  v_proc_owner_oid oid;
  v_caller_owner name;
  v_helper_fn regprocedure;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner is null then
    raise exception 'DIRECT_ENTRY_OWNER_RESOLUTION_FAILED';
  end if;

  for v_fn, v_proc_owner_oid in
    select p.oid::regprocedure, p.proowner
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)'::pg_catalog.regprocedure,
       'public.direct_entry__internal_team_scope_grant_effective(uuid,date)'::pg_catalog.regprocedure,
       'public.direct_entry__internal_capability_grant_effective(uuid,date)'::pg_catalog.regprocedure,
       'public.direct_entry__internal_recruiter_team_membership_effective(uuid,date)'::pg_catalog.regprocedure,
       'public.direct_entry__internal_recruiter_provider_membership_effective(uuid,date)'::pg_catalog.regprocedure,
       'public.direct_entry__internal_reconcile_cancelled_team_leaders(date)'::pg_catalog.regprocedure,
       'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::pg_catalog.regprocedure,
       'public.work_report_sync_team_leader_capabilities()'::pg_catalog.regprocedure,
       'public.leave_management__internal_resolve_authority(uuid,uuid)'::pg_catalog.regprocedure,
       'public.leave_management__internal_resolve_routing(uuid,date)'::pg_catalog.regprocedure,
       'public.leave_management__internal_can_actor_decide_request(uuid,public.leave_requests,date)'::pg_catalog.regprocedure
     )
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;

  for v_caller_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and (
         p.proname like 'direct_entry_%'
         or p.proname like 'leave_management_%'
         or p.proname like 'attendance_%'
         or p.proname like 'work_report_%'
       )
  loop
    for v_helper_fn in
      select p.oid::pg_catalog.regprocedure
        from pg_catalog.pg_proc p
       where p.oid in (
         'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)'::pg_catalog.regprocedure,
         'public.direct_entry__internal_team_scope_grant_effective(uuid,date)'::pg_catalog.regprocedure,
         'public.direct_entry__internal_capability_grant_effective(uuid,date)'::pg_catalog.regprocedure,
         'public.direct_entry__internal_recruiter_team_membership_effective(uuid,date)'::pg_catalog.regprocedure,
         'public.direct_entry__internal_recruiter_provider_membership_effective(uuid,date)'::pg_catalog.regprocedure,
         'public.direct_entry__internal_reconcile_cancelled_team_leaders(date)'::pg_catalog.regprocedure,
         'public.leave_management__internal_resolve_authority(uuid,uuid)'::pg_catalog.regprocedure,
         'public.leave_management__internal_resolve_routing(uuid,date)'::pg_catalog.regprocedure,
         'public.leave_management__internal_can_actor_decide_request(uuid,public.leave_requests,date)'::pg_catalog.regprocedure
       )
    loop
      execute pg_catalog.format('grant execute on function %s to %I', v_helper_fn, v_caller_owner);
    end loop;
  end loop;
end
$owner_align$;
