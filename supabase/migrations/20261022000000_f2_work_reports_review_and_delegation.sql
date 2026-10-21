-- F2-WP1 Work Reports: Review workflow, time-bounded delegation, Team Leader review grant lifecycle,
-- and analytics finality ('final' vs 'provisional_included').
-- Forward-only migration; all application access goes through the service-role RPC allowlist.

begin;

alter table public.direct_entry_capability_grants
  drop constraint direct_entry_capability_grants_capability_check;
alter table public.direct_entry_capability_grants
  add constraint direct_entry_capability_grants_capability_check
  check (capability in (
    'entry_create', 'entry_own', 'entry_team', 'entry_admin', 'entry_restore',
    'submission_create', 'change_request_create', 'change_review', 'entry_privileged_edit',
    'employment_status.request', 'employment_status.review', 'employment_status.apply',
    'document_upload', 'document_view', 'payment_view', 'payment_edit',
    'recruiter_master_manage', 'team_master_manage', 'pii_view', 'pii_export', 'audit_view',
    'catalog_master_manage', 'team_manager_assign',
    'report_form_manage', 'report_assign', 'report_view', 'report_analytics_view',
    'report_review', 'report_delegate'
  ));
comment on constraint direct_entry_capability_grants_capability_check
  on public.direct_entry_capability_grants is
  'F2: canonical DB vocabulary has 29 tokens: 23 Direct Entry tokens (including four retired compatibility tokens) plus six active Work Reports tokens.';

alter table public.work_report_team_leader_capability_grants
  drop constraint work_report_team_leader_capability_grants_capability_check;
alter table public.work_report_team_leader_capability_grants
  add constraint work_report_team_leader_capability_grants_capability_check
  check (capability in ('report_view', 'report_analytics_view', 'report_assign', 'report_review'));

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

-- Backfill report_review for currently active Team Leader assignments using the same trigger path.
update public.direct_entry_team_leader_assignments
   set is_current = true
 where is_current;

create table public.work_report_delegations (
  delegation_id uuid primary key default gen_random_uuid(),
  grantor_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  delegate_app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  capability text not null check (capability in ('report_assign', 'report_review')),
  template_id uuid not null references public.work_report_templates(template_id) on delete restrict,
  template_version_id uuid not null references public.work_report_template_versions(version_id) on delete restrict,
  scope_kind text not null check (scope_kind in ('all', 'team')),
  scope_team_id uuid references public.teams(team_id) on delete restrict,
  effective_from timestamptz not null,
  effective_to timestamptz not null check (effective_to >= effective_from),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'REVOKED')),
  is_current boolean not null default true,
  revoked_by_user_id uuid references public.direct_entry_app_users(app_user_id) on delete restrict,
  revoked_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (grantor_user_id <> delegate_app_user_id),
  check (
    (scope_kind = 'all' and scope_team_id is null) or
    (scope_kind = 'team' and scope_team_id is not null)
  ),
  check (
    (state = 'ACTIVE' and is_current = true and revoked_at is null and revoked_by_user_id is null) or
    (state = 'REVOKED' and is_current = false and revoked_at is not null and revoked_by_user_id is not null)
  )
);
create index work_report_delegations_delegate_active_idx
  on public.work_report_delegations (delegate_app_user_id, capability, is_current, effective_from, effective_to);
create index work_report_delegations_grantor_idx
  on public.work_report_delegations (grantor_user_id, created_at desc);
create index work_report_delegations_template_idx
  on public.work_report_delegations (template_id, capability, is_current);
create trigger work_report_delegations_no_delete
  before delete on public.work_report_delegations
  for each row execute function public.work_report_immutable_guard();

create table public.work_report_review_events (
  review_event_id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.work_report_submissions(submission_id) on delete restrict,
  revision_id uuid not null references public.work_report_submission_revisions(revision_id) on delete restrict,
  obligation_id uuid not null references public.work_report_obligations(obligation_id) on delete restrict,
  template_id uuid not null references public.work_report_templates(template_id) on delete restrict,
  reviewer_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  author_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  decision text not null check (decision in ('APPROVED', 'REJECTED')),
  reason_id uuid references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  reason_text text,
  acting_scope_kind text not null check (acting_scope_kind in ('all', 'team')),
  acting_team_id uuid references public.teams(team_id) on delete restrict,
  delegation_id uuid references public.work_report_delegations(delegation_id) on delete restrict,
  created_at timestamptz not null default now(),
  check (reviewer_user_id <> author_user_id),
  check (
    (decision = 'APPROVED') or
    (decision = 'REJECTED' and reason_id is not null and length(btrim(coalesce(reason_text, ''))) between 1 and 4000)
  )
);
create index work_report_review_events_submission_created_idx
  on public.work_report_review_events (submission_id, created_at desc);
create index work_report_review_events_obligation_created_idx
  on public.work_report_review_events (obligation_id, created_at desc);
create trigger work_report_review_events_immutable
  before update or delete on public.work_report_review_events
  for each row execute function public.work_report_immutable_guard();

do $rls$
declare
  v_table text;
begin
  foreach v_table in array array['work_report_delegations', 'work_report_review_events'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', v_table);
  end loop;
end;
$rls$;

create or replace function public.work_report__internal_has_direct_capability(
  p_app_user_id uuid,
  p_capability text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if p_app_user_id is null or p_capability is null then
    return false;
  end if;
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id and u.enabled
  ) then
    return false;
  end if;
  if public.direct_entry_has_capability(p_app_user_id, p_capability) then
    return true;
  end if;
  if p_capability in (
    'report_form_manage', 'report_assign', 'report_view', 'report_analytics_view', 'report_review', 'report_delegate'
  )
     and not exists (
       select 1 from public.direct_entry_capability_grants g
        where g.app_user_id = p_app_user_id
          and g.capability = p_capability
          and not g.is_current
     )
     and public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
     and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
     and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
     and public.direct_entry_has_scope(p_app_user_id, 'all') then
    return true;
  end if;
  return false;
end;
$function$;

create or replace function public.work_report__internal_has_direct_scope(
  p_app_user_id uuid,
  p_capability text,
  p_scope_kind text,
  p_team_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    return false;
  end if;
  if public.direct_entry_has_scope(p_app_user_id, 'all') then
    if p_scope_kind = 'all' and p_team_id is null then
      return true;
    end if;
    if p_scope_kind = 'team' and p_team_id is not null and exists (
      select 1 from public.teams t where t.team_id = p_team_id and t.active
    ) then
      return true;
    end if;
    return false;
  end if;
  if p_scope_kind = 'team' and p_team_id is not null and exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = p_team_id
       and s.is_current
  ) then
    return true;
  end if;
  return false;
end;
$function$;

create or replace function public.work_report__internal_is_delegation_effective(
  p_delegation_id uuid,
  p_as_of timestamptz default statement_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_del public.work_report_delegations%rowtype;
begin
  select * into v_del
    from public.work_report_delegations d
   where d.delegation_id = p_delegation_id;
  if not found then
    return false;
  end if;
  if v_del.state <> 'ACTIVE' or not v_del.is_current then
    return false;
  end if;
  if p_as_of < v_del.effective_from or p_as_of > v_del.effective_to then
    return false;
  end if;
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = v_del.delegate_app_user_id and u.enabled
  ) then
    return false;
  end if;
  if not exists (
    select 1 from public.work_report_templates t
     where t.template_id = v_del.template_id
       and t.status = 'ACTIVE'
       and t.current_published_version_id is not null
  ) then
    return false;
  end if;
  if v_del.scope_kind = 'team' then
    if not exists (
      select 1 from public.teams tm where tm.team_id = v_del.scope_team_id and tm.active
    ) then
      return false;
    end if;
    if public.work_report_current_team(v_del.delegate_app_user_id) is distinct from v_del.scope_team_id
       and not exists (
         select 1 from public.direct_entry_scope_grants sg
          where sg.app_user_id = v_del.delegate_app_user_id
            and sg.scope_kind = 'team'
            and sg.team_id = v_del.scope_team_id
            and sg.is_current
       ) then
      return false;
    end if;
  end if;
  if not public.work_report__internal_has_direct_scope(
    v_del.grantor_user_id, 'report_delegate', v_del.scope_kind, v_del.scope_team_id
  ) then
    return false;
  end if;
  if not public.work_report__internal_has_direct_scope(
    v_del.grantor_user_id, v_del.capability, v_del.scope_kind, v_del.scope_team_id
  ) then
    return false;
  end if;
  return true;
end;
$function$;

create or replace function public.work_report__internal_resolve_capability_authority(
  p_app_user_id uuid,
  p_capability text,
  p_template_id uuid,
  p_team_id uuid,
  p_as_of timestamptz default statement_timestamp()
)
returns table(
  acting_scope_kind text,
  acting_team_id uuid,
  delegation_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_delegation_id uuid;
  v_del_scope_kind text;
  v_del_team_id uuid;
begin
  if public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    if public.direct_entry_has_scope(p_app_user_id, 'all') then
      return query select 'all'::text, null::uuid, null::uuid;
      return;
    end if;
    if p_team_id is not null and exists (
      select 1
        from public.direct_entry_scope_grants s
        join public.teams t on t.team_id = s.team_id and t.active
       where s.app_user_id = p_app_user_id
         and s.scope_kind = 'team'
         and s.team_id = p_team_id
         and s.is_current
    ) then
      return query select 'team'::text, p_team_id, null::uuid;
      return;
    end if;
  end if;

  if p_capability in ('report_assign', 'report_review') and p_template_id is not null then
    select d.delegation_id,
           d.scope_kind,
           case when d.scope_kind = 'team' then d.scope_team_id else null end
      into v_delegation_id, v_del_scope_kind, v_del_team_id
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = p_capability
       and d.template_id = p_template_id
       and d.state = 'ACTIVE'
       and d.is_current
       and p_as_of between d.effective_from and d.effective_to
       and (
         d.scope_kind = 'all'
         or (d.scope_kind = 'team' and p_team_id is not null and d.scope_team_id = p_team_id)
       )
       and public.work_report__internal_is_delegation_effective(d.delegation_id, p_as_of)
     order by case when d.scope_kind = 'all' then 0 else 1 end, d.created_at desc, d.delegation_id desc
     limit 1;

    if v_delegation_id is not null then
      return query select v_del_scope_kind, v_del_team_id, v_delegation_id;
      return;
    end if;
  end if;
end;
$function$;

create or replace function public.work_report__internal_has_any_capability_authority(
  p_app_user_id uuid,
  p_capability text,
  p_as_of timestamptz default statement_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    if public.direct_entry_has_scope(p_app_user_id, 'all') then
      return true;
    end if;
    if exists (
      select 1
        from public.direct_entry_scope_grants s
        join public.teams t on t.team_id = s.team_id and t.active
       where s.app_user_id = p_app_user_id
         and s.scope_kind = 'team'
         and s.is_current
    ) then
      return true;
    end if;
  end if;

  if p_capability in ('report_assign', 'report_review') and exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = p_capability
       and d.state = 'ACTIVE'
       and d.is_current
       and p_as_of between d.effective_from and d.effective_to
       and public.work_report__internal_is_delegation_effective(d.delegation_id, p_as_of)
  ) then
    return true;
  end if;

  return false;
end;
$function$;

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
     and not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
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
  if not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
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
             and g.is_current
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
    ) || case
      when jsonb_array_length(v_review_scopes) > 0 then jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u where u.app_user_id = v_app_user_id
  );
end;
$function$;

-- Assignment RPCs updated to honor active report_assign delegations on the delegated template and scope.
create or replace function public.work_report_create_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_kind text,
  p_target_user_id uuid,
  p_target_team_id uuid,
  p_target_user_ids uuid[],
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_scope_team_id uuid;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_target_kind not in ('USER','TEAM','USER_SET')
     or p_frequency not in ('DAILY','WEEKLY','MONTHLY','ONCE')
     or p_due_day_offset not between 0 and 31
     or p_effective_from is null or (p_effective_to is not null and p_effective_to < p_effective_from)
     or length(coalesce(p_idempotency_key,'')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;
  if (p_target_kind='USER') <> (p_target_user_id is not null and p_target_team_id is null)
     or (p_target_kind='TEAM') <> (p_target_team_id is not null and p_target_user_id is null)
     or (p_target_kind='USER_SET' and (p_target_user_id is not null or p_target_team_id is not null)) then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_target_kind='USER_SET' and coalesce(cardinality(p_target_user_ids),0) < 1 then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_target_kind='TEAM' then v_scope_team_id := p_target_team_id;
  elsif p_target_kind='USER' then v_scope_team_id := public.work_report_resolve_assignment_user_team(p_target_user_id);
  end if;

  if p_target_kind in ('USER','TEAM') then
    select a.acting_scope_kind, a.delegation_id
      into v_scope, v_delegation_id
      from public.work_report__internal_resolve_capability_authority(
        p_app_user_id, 'report_assign', p_template_id, v_scope_team_id
      ) a;
    if v_scope is null then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  else
    if exists (
      select 1 from unnest(p_target_user_ids) x(user_id)
       where not exists (
         select 1
           from public.work_report__internal_resolve_capability_authority(
             p_app_user_id, 'report_assign', p_template_id, public.work_report_current_team(x.user_id)
           ) a
       )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null) then 'all'
      else 'team'
    end;
  end if;

  select * into v_template from public.work_report_templates where template_id=p_template_id for share;
  if not found or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id',p_template_id,'target_kind',p_target_kind,'target_user_id',p_target_user_id,
    'target_team_id',p_target_team_id,'target_user_ids',p_target_user_ids,'frequency',p_frequency,
    'is_mandatory',p_is_mandatory,'due_day_offset',p_due_day_offset,'due_time_local',p_due_time_local,
    'exclude_sundays',p_exclude_sundays,'effective_from',p_effective_from,'effective_to',p_effective_to
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_assignment_create',p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  insert into public.work_report_assignments
    (template_id,template_version_id,target_kind,target_user_id,target_team_id,frequency,is_mandatory,
     due_day_offset,due_time_local,exclude_sundays,effective_from,effective_to,assigned_by_user_id)
  values
    (p_template_id,v_template.current_published_version_id,p_target_kind,p_target_user_id,p_target_team_id,p_frequency,
     coalesce(p_is_mandatory,true),p_due_day_offset,p_due_time_local,coalesce(p_exclude_sundays,false),
     p_effective_from,p_effective_to,p_app_user_id)
  returning assignment_id into v_assignment_id;
  if p_target_kind='USER_SET' then
    insert into public.work_report_assignment_targets (assignment_id,target_user_id)
      select v_assignment_id, x from (select distinct unnest(p_target_user_ids) x) q;
  end if;
  insert into public.work_report_audit_events
    (action,actor_user_id,capability,scope_kind,scope_team_id,template_id,outcome,metadata_json)
  values ('ASSIGNMENT_CREATE',p_app_user_id,'report_assign',v_scope,
    case when v_scope='team' then v_scope_team_id else null end,p_template_id,'APPLIED',
    jsonb_build_object('assignment_id',v_assignment_id,'target_kind',p_target_kind,'delegation_id',v_delegation_id));
  v_result := jsonb_build_object('assignment_id',v_assignment_id,'version',1);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_assignment_create',p_idempotency_key,v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_set_assignment_state(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_state text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_assignment public.work_report_assignments%rowtype;
  v_team_id uuid;
  v_scope text;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_state not in ('ACTIVE','PAUSED','REVOKED') then raise exception 'WORK_REPORT_ASSIGNMENT_STATE_INVALID' using errcode='22023'; end if;
  select * into v_assignment from public.work_report_assignments where assignment_id=p_assignment_id for update;
  if not found then raise exception 'WORK_REPORT_ASSIGNMENT_NOT_FOUND' using errcode='P0002'; end if;
  if v_assignment.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  v_team_id := case v_assignment.target_kind when 'TEAM' then v_assignment.target_team_id
    when 'USER' then public.work_report_resolve_assignment_user_team(v_assignment.target_user_id) else null end;
  if v_assignment.target_kind='USER_SET' then
    if exists (select 1 from public.work_report_assignment_targets x
      where x.assignment_id=p_assignment_id and not exists (
        select 1 from public.work_report__internal_resolve_capability_authority(
          p_app_user_id, 'report_assign', v_assignment.template_id, public.work_report_current_team(x.target_user_id)
        ) a
      )) then raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode='42501'; end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null) then 'all'
      else 'team'
    end;
  else
    select a.acting_scope_kind, a.delegation_id
      into v_scope, v_delegation_id
      from public.work_report__internal_resolve_capability_authority(
        p_app_user_id, 'report_assign', v_assignment.template_id, v_team_id
      ) a;
    if v_scope is null then raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode='42501'; end if;
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('assignment_id',p_assignment_id,'expected_version',p_expected_version,'state',p_state));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_assignment_state',p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  update public.work_report_assignments set state=p_state,is_current=(p_state<>'REVOKED'),version=version+1,updated_at=now()
   where assignment_id=p_assignment_id;
  if p_state='REVOKED' then
    update public.work_report_obligations set obligation_status='CANCELLED',status_changed_by_user_id=p_app_user_id,
      version=version+1,updated_at=now()
     where assignment_id=p_assignment_id and obligation_status='ACTIVE'
       and not exists (select 1 from public.work_report_submissions s where s.obligation_id=work_report_obligations.obligation_id and s.first_submitted_at is not null);
  end if;
  insert into public.work_report_audit_events
    (action,actor_user_id,capability,scope_kind,scope_team_id,template_id,outcome,metadata_json)
  values ('ASSIGNMENT_STATE',p_app_user_id,'report_assign',v_scope,case when v_scope='team' then v_team_id end,
    v_assignment.template_id,'APPLIED',jsonb_build_object('assignment_id',p_assignment_id,'state',p_state,'delegation_id',v_delegation_id));
  v_result := jsonb_build_object('assignment_id',p_assignment_id,'state',p_state,'version',p_expected_version+1);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_assignment_state',p_idempotency_key,v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_ensure_obligations_for_window(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_inserted integer;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_business_date is null then raise exception 'WORK_REPORT_DATE_INVALID' using errcode='22023'; end if;
  with candidate as (
    select a.*, u.app_user_id as assignee_id,
      public.work_report_current_team(u.app_user_id) as team_id
      from public.work_report_assignments a
      cross join lateral (
        select a.target_user_id as app_user_id where a.target_kind='USER'
        union all
        select x.target_user_id from public.work_report_assignment_targets x
          where a.target_kind='USER_SET' and x.assignment_id=a.assignment_id
        union all
        select l.app_user_id
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiter_team_memberships m on m.recruiter_id=l.recruiter_id and m.is_current
         where a.target_kind='TEAM' and m.team_id=a.target_team_id and l.verified and l.is_current
      ) u
     where a.is_current and a.state='ACTIVE'
       and a.effective_from <= p_business_date and (a.effective_to is null or p_business_date <= a.effective_to)
  ), authorized as (
    select c.* from candidate c
     where exists (
       select 1 from public.work_report__internal_resolve_capability_authority(
         p_app_user_id, 'report_assign', c.template_id, c.team_id
       ) auth
     )
  ), materialized as (
    select a.*, p.period_key, p.period_start_date, p.period_end_date,
      public.work_report_due_at(p.period_end_date,a.due_day_offset,a.due_time_local,a.exclude_sundays) due_at
      from authorized a cross join lateral public.work_report_period(a.frequency,p_business_date) p
  ), inserted as (
    insert into public.work_report_obligations
      (template_id,template_version_id,assignment_id,assignee_app_user_id,snapshot_team_id,
       snapshot_team_code,snapshot_team_display_name,period_type,period_key,period_start_date,period_end_date,
       due_at,is_mandatory)
    select m.template_id,m.template_version_id,m.assignment_id,m.assignee_id,m.team_id,t.code,t.display_name,
      m.frequency,m.period_key,m.period_start_date,m.period_end_date,m.due_at,m.is_mandatory
      from materialized m left join public.teams t on t.team_id=m.team_id
     where exists (select 1 from public.direct_entry_app_users u where u.app_user_id=m.assignee_id and u.enabled)
    on conflict (template_id,assignee_app_user_id,period_key) do nothing
    returning 1
  ) select count(*)::int into v_inserted from inserted;
  insert into public.work_report_audit_events
    (action,actor_user_id,capability,scope_kind,outcome,metadata_json)
  values ('OBLIGATION_MATERIALIZE',p_app_user_id,'report_assign',
    case when public.direct_entry_has_scope(p_app_user_id,'all') then 'all' else 'team' end,'APPLIED',
    jsonb_build_object('business_date',p_business_date,'inserted_count',v_inserted));
  return jsonb_build_object('business_date',p_business_date,'inserted_count',v_inserted);
end;
$function$;

create or replace function public.work_report_change_obligation_status(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid,
  p_expected_version integer,
  p_action text,
  p_reason text,
  p_reopened_until timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_scope text;
  v_delegation_id uuid;
  v_reason_id uuid;
  v_status text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_action not in ('EXEMPT','REOPEN') or length(btrim(coalesce(p_reason,''))) not between 1 and 4000 then
    raise exception 'WORK_REPORT_REASON_REQUIRED' using errcode='22023';
  end if;
  select * into v_obligation from public.work_report_obligations where obligation_id=p_obligation_id for update;
  if not found then raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_obligation.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  select a.acting_scope_kind, a.delegation_id
    into v_scope, v_delegation_id
    from public.work_report__internal_resolve_capability_authority(
      p_app_user_id, 'report_assign', v_obligation.template_id, v_obligation.snapshot_team_id
    ) a;
  if v_scope is null then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;
  if p_action='REOPEN' and (p_reopened_until is null or p_reopened_until <= now()) then
    raise exception 'WORK_REPORT_REOPEN_WINDOW_INVALID' using errcode='22023';
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('obligation_id',p_obligation_id,
    'expected_version',p_expected_version,'action',p_action,'reason',p_reason,'reopened_until',p_reopened_until));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_obligation_'||lower(p_action),p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id,btrim(p_reason));
  v_status := case when p_action='EXEMPT' then 'EXEMPTED' else 'ACTIVE' end;
  update public.work_report_obligations set obligation_status=v_status,
    reopened_until=case when p_action='REOPEN' then p_reopened_until else null end,
    status_changed_by_user_id=p_app_user_id,status_reason_id=v_reason_id,version=version+1,updated_at=now()
   where obligation_id=p_obligation_id;
  insert into public.work_report_audit_events
    (action,actor_user_id,capability,scope_kind,scope_team_id,template_id,obligation_id,outcome,reason_id,metadata_json)
  values (p_action,p_app_user_id,'report_assign',v_scope,case when v_scope='team' then v_obligation.snapshot_team_id end,
    v_obligation.template_id,p_obligation_id,'APPLIED',v_reason_id,
    case when p_action='REOPEN' then jsonb_build_object('reopened_until',p_reopened_until,'delegation_id',v_delegation_id)
      else jsonb_build_object('delegation_id',v_delegation_id) end);
  v_result := jsonb_build_object('obligation_id',p_obligation_id,'status',v_status,
    'reopened_until',case when p_action='REOPEN' then p_reopened_until end,'version',p_expected_version+1);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_obligation_'||lower(p_action),p_idempotency_key,v_result);
  return v_result;
end;
$function$;

-- Submission RPCs updated for F2:
-- 1. work_report_get_submission includes sanitized latest_review_event without leaking reviewer authority metadata.
-- 2. work_report_save_draft and work_report_submit allow the assignee to amend/resubmit a REJECTED report even after due_at.
create or replace function public.work_report_get_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  select o.* into v_obligation
    from public.work_report_obligations o
   where o.obligation_id = p_obligation_id
      or exists (
        select 1 from public.work_report_submissions s
         where s.submission_id = p_obligation_id
           and s.obligation_id = o.obligation_id
      );
  if not found then
    raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_obligation.assignee_app_user_id <> p_app_user_id then
    begin
      perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_view');
    exception when insufficient_privilege then
      raise exception 'WORK_REPORT_ACCESS_DENIED' using errcode = '42501';
    end;
    if not public.direct_entry_has_scope(p_app_user_id, 'all') then
      perform public.work_report_assert_scope(p_app_user_id, 'report_view', v_obligation.snapshot_team_id, false);
    end if;
  end if;
  select jsonb_build_object(
    'obligation', jsonb_build_object(
      'obligation_id', o.obligation_id,
      'template_id', o.template_id,
      'assignee_app_user_id', o.assignee_app_user_id,
      'snapshot_team_id', o.snapshot_team_id,
      'snapshot_team_code', o.snapshot_team_code,
      'snapshot_team_display_name', o.snapshot_team_display_name,
      'period_key', o.period_key,
      'period_start_date', o.period_start_date,
      'period_end_date', o.period_end_date,
      'due_at', o.due_at,
      'obligation_status', o.obligation_status,
      'reopened_until', o.reopened_until,
      'version', o.version
    ),
    'template', jsonb_build_object(
      'template_code', t.template_code,
      'display_name', t.display_name,
      'schema_json', v.schema_json
    ),
    'submission', case when s.submission_id is null then null else jsonb_build_object(
      'submission_id', s.submission_id,
      'state', s.state,
      'draft_payload_json', s.draft_payload_json,
      'first_submitted_at', s.first_submitted_at,
      'latest_submitted_at', s.latest_submitted_at,
      'is_late', s.is_late,
      'has_post_deadline_amendment', s.has_post_deadline_amendment,
      'current_revision_id', s.current_revision_id,
      'version', s.version
    ) end,
    'latest_review_event', (
      select jsonb_build_object(
        'decision', re.decision,
        'reason', re.reason_text,
        'reviewed_at', re.created_at,
        'revision_no', rr.revision_no
      )
        from public.work_report_review_events re
        left join public.work_report_submission_revisions rr on rr.revision_id = re.revision_id
       where re.submission_id = s.submission_id
       order by re.created_at desc, re.review_event_id desc
       limit 1
    ),
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'revision_id', r.revision_id,
        'revision_no', r.revision_no,
        'payload_json', r.payload_json,
        'created_at', r.created_at
      ) order by r.revision_no desc)
        from public.work_report_submission_revisions r
       where r.submission_id = s.submission_id
    ), '[]'::jsonb)
  ) into v_result
    from public.work_report_obligations o
    join public.work_report_templates t on t.template_id = o.template_id
    join public.work_report_template_versions v on v.version_id = o.template_version_id
    left join public.work_report_submissions s on s.obligation_id = o.obligation_id
   where o.obligation_id = v_obligation.obligation_id;
  return v_result;
end;
$function$;

create or replace function public.work_report_save_draft(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid,
  p_payload_json jsonb,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_version public.work_report_template_versions%rowtype;
  v_submission public.work_report_submissions%rowtype;
  v_submission_found boolean := false;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,null);
  select * into v_obligation from public.work_report_obligations where obligation_id=p_obligation_id for update;
  if not found then raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_obligation.assignee_app_user_id <> p_app_user_id or v_obligation.obligation_status <> 'ACTIVE' then
    raise exception 'WORK_REPORT_SUBMISSION_DENIED' using errcode='42501';
  end if;
  select * into v_submission from public.work_report_submissions where obligation_id=p_obligation_id for update;
  v_submission_found := found;
  if now() > v_obligation.due_at
     and coalesce(v_obligation.reopened_until < now(), true)
     and coalesce(v_submission.state, 'NOT_STARTED') <> 'REJECTED' then
    raise exception 'WORK_REPORT_DEADLINE_PASSED' using errcode='42501';
  end if;
  select * into v_version from public.work_report_template_versions where version_id=v_obligation.template_version_id;
  if not public.work_report_valid_submission_payload(v_version.schema_json,p_payload_json,
    v_obligation.period_start_date,v_obligation.period_end_date,false) then
    raise exception 'WORK_REPORT_PAYLOAD_INVALID' using errcode='22023';
  end if;
  if v_submission_found and v_submission.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  if not v_submission_found and p_expected_version is not null then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('obligation_id',p_obligation_id,
    'payload_json',p_payload_json,'expected_version',p_expected_version));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_draft_save',p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  if v_submission.submission_id is null then
    insert into public.work_report_submissions
      (obligation_id,template_id,template_version_id,assignee_app_user_id,draft_payload_json)
    values (p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,p_app_user_id,p_payload_json)
    returning * into v_submission;
  else
    update public.work_report_submissions set draft_payload_json=p_payload_json,version=version+1,updated_at=now()
     where submission_id=v_submission.submission_id returning * into v_submission;
  end if;
  insert into public.work_report_audit_events
    (action,actor_user_id,scope_kind,scope_team_id,template_id,obligation_id,submission_id,outcome)
  values ('DRAFT_SAVE',p_app_user_id,'own',v_obligation.snapshot_team_id,v_obligation.template_id,
    p_obligation_id,v_submission.submission_id,'APPLIED');
  v_result := jsonb_build_object('submission_id',v_submission.submission_id,'state',v_submission.state,'version',v_submission.version);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_draft_save',p_idempotency_key,v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_submit(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid,
  p_payload_json jsonb,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_template_version public.work_report_template_versions%rowtype;
  v_submission public.work_report_submissions%rowtype;
  v_submission_found boolean := false;
  v_revision_id uuid;
  v_revision_no integer;
  v_state text;
  v_now timestamptz := statement_timestamp();
  v_metric jsonb;
  v_value jsonb;
  v_option text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject,p_app_user_id,null);
  select * into v_obligation from public.work_report_obligations where obligation_id=p_obligation_id for update;
  if not found then raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_obligation.assignee_app_user_id <> p_app_user_id or v_obligation.obligation_status <> 'ACTIVE' then
    raise exception 'WORK_REPORT_SUBMISSION_DENIED' using errcode='42501';
  end if;
  select * into v_submission from public.work_report_submissions where obligation_id=p_obligation_id for update;
  v_submission_found := found;
  if v_now > v_obligation.due_at
     and coalesce(v_obligation.reopened_until < v_now, true)
     and coalesce(v_submission.state, 'NOT_STARTED') <> 'REJECTED' then
    raise exception 'WORK_REPORT_DEADLINE_PASSED' using errcode='42501';
  end if;
  select * into v_template_version from public.work_report_template_versions where version_id=v_obligation.template_version_id;
  if not public.work_report_valid_submission_payload(v_template_version.schema_json,p_payload_json,
    v_obligation.period_start_date,v_obligation.period_end_date,true) then
    raise exception 'WORK_REPORT_PAYLOAD_INVALID' using errcode='22023';
  end if;
  if v_submission_found and v_submission.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  if not v_submission_found and p_expected_version is not null then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('obligation_id',p_obligation_id,
    'payload_json',p_payload_json,'expected_version',p_expected_version));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id,'work_report_submit',p_idempotency_key,v_request_hash);
  if v_prior is not null then return v_prior; end if;
  if v_submission.submission_id is null then
    insert into public.work_report_submissions
      (obligation_id,template_id,template_version_id,assignee_app_user_id,submitted_by_user_id,
       submitted_team_id,draft_payload_json)
    values (p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,p_app_user_id,p_app_user_id,
      v_obligation.snapshot_team_id,p_payload_json)
    returning * into v_submission;
  end if;
  select coalesce(max(revision_no),0)+1 into v_revision_no
    from public.work_report_submission_revisions where submission_id=v_submission.submission_id;
  insert into public.work_report_submission_revisions
    (submission_id,obligation_id,template_version_id,revision_no,payload_json,payload_checksum,created_by_user_id)
  values (v_submission.submission_id,p_obligation_id,v_obligation.template_version_id,v_revision_no,p_payload_json,
    encode(sha256(convert_to(p_payload_json::text,'UTF8')),'hex'),p_app_user_id)
  returning revision_id into v_revision_id;
  v_state := case when v_template_version.requires_review then 'PENDING_REVIEW' else 'COMPLETED' end;
  update public.work_report_metric_values set is_current_revision=false,is_provisional=false,is_final=false,is_eligible=false
   where submission_id=v_submission.submission_id and is_current_revision;
  for v_metric in select value from jsonb_array_elements(v_template_version.metric_contract_json -> 'metrics') loop
    v_value := p_payload_json -> (v_metric ->> 'field_key');
    if v_value is null or jsonb_typeof(v_value)='null' then continue; end if;
    if v_metric ->> 'field_type' in ('integer','decimal') then
      insert into public.work_report_metric_values
        (submission_id,revision_id,obligation_id,template_id,template_version_id,assignee_app_user_id,snapshot_team_id,
         period_type,period_key,period_start_date,period_end_date,field_key,metric_key,compatible_group,value_type,unit,
         numeric_value,is_current_revision,is_provisional,is_final,is_eligible)
      values (v_submission.submission_id,v_revision_id,p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,
        p_app_user_id,v_obligation.snapshot_team_id,v_obligation.period_type,v_obligation.period_key,
        v_obligation.period_start_date,v_obligation.period_end_date,v_metric->>'field_key',v_metric->>'metric_key',
        v_metric->>'compatible_group',upper(v_metric->>'field_type'),v_metric->>'unit',(v_value#>>'{}')::numeric,
        true,v_template_version.requires_review,not v_template_version.requires_review,true);
    elsif v_metric ->> 'field_type'='boolean' then
      insert into public.work_report_metric_values
        (submission_id,revision_id,obligation_id,template_id,template_version_id,assignee_app_user_id,snapshot_team_id,
         period_type,period_key,period_start_date,period_end_date,field_key,metric_key,compatible_group,value_type,unit,
         boolean_value,is_current_revision,is_provisional,is_final,is_eligible)
      values (v_submission.submission_id,v_revision_id,p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,
        p_app_user_id,v_obligation.snapshot_team_id,v_obligation.period_type,v_obligation.period_key,
        v_obligation.period_start_date,v_obligation.period_end_date,v_metric->>'field_key',v_metric->>'metric_key',
        v_metric->>'compatible_group','BOOLEAN',v_metric->>'unit',(v_value#>>'{}')::boolean,
        true,v_template_version.requires_review,not v_template_version.requires_review,true);
    elsif v_metric ->> 'field_type'='single_select' then
      insert into public.work_report_metric_values
        (submission_id,revision_id,obligation_id,template_id,template_version_id,assignee_app_user_id,snapshot_team_id,
         period_type,period_key,period_start_date,period_end_date,field_key,metric_key,compatible_group,value_type,unit,
         option_key,is_current_revision,is_provisional,is_final,is_eligible)
      values (v_submission.submission_id,v_revision_id,p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,
        p_app_user_id,v_obligation.snapshot_team_id,v_obligation.period_type,v_obligation.period_key,
        v_obligation.period_start_date,v_obligation.period_end_date,v_metric->>'field_key',v_metric->>'metric_key',
        v_metric->>'compatible_group','SINGLE_SELECT',v_metric->>'unit',v_value#>>'{}',
        true,v_template_version.requires_review,not v_template_version.requires_review,true);
    elsif v_metric ->> 'field_type'='multi_select' then
      for v_option in select value from jsonb_array_elements_text(v_value) loop
        insert into public.work_report_metric_values
          (submission_id,revision_id,obligation_id,template_id,template_version_id,assignee_app_user_id,snapshot_team_id,
           period_type,period_key,period_start_date,period_end_date,field_key,metric_key,compatible_group,value_type,unit,
           option_key,is_current_revision,is_provisional,is_final,is_eligible)
        values (v_submission.submission_id,v_revision_id,p_obligation_id,v_obligation.template_id,v_obligation.template_version_id,
          p_app_user_id,v_obligation.snapshot_team_id,v_obligation.period_type,v_obligation.period_key,
          v_obligation.period_start_date,v_obligation.period_end_date,v_metric->>'field_key',v_metric->>'metric_key',
          v_metric->>'compatible_group','MULTI_SELECT',v_metric->>'unit',v_option,
          true,v_template_version.requires_review,not v_template_version.requires_review,true);
      end loop;
    end if;
  end loop;
  update public.work_report_submissions set current_revision_id=v_revision_id,state=v_state,draft_payload_json=p_payload_json,
    submitted_by_user_id=p_app_user_id,submitted_team_id=v_obligation.snapshot_team_id,
    first_submitted_at=coalesce(first_submitted_at,v_now),latest_submitted_at=v_now,
    is_late=case when first_submitted_at is null then v_now>v_obligation.due_at else is_late end,
    has_post_deadline_amendment=has_post_deadline_amendment or (first_submitted_at is not null and v_now>v_obligation.due_at),
    version=version+1,updated_at=now()
   where submission_id=v_submission.submission_id returning * into v_submission;
  insert into public.work_report_audit_events
    (action,actor_user_id,scope_kind,scope_team_id,template_id,obligation_id,submission_id,outcome,metadata_json)
  values (case when v_revision_no=1 then 'SUBMIT' else 'RESUBMIT' end,p_app_user_id,'own',v_obligation.snapshot_team_id,
    v_obligation.template_id,p_obligation_id,v_submission.submission_id,'APPLIED',
    jsonb_build_object('revision_id',v_revision_id,'revision_no',v_revision_no,
      'post_deadline_amendment',v_submission.has_post_deadline_amendment));
  v_result := jsonb_build_object('submission_id',v_submission.submission_id,'revision_id',v_revision_id,
    'revision_no',v_revision_no,'state',v_state,'version',v_submission.version);
  perform public.direct_entry_idempotency_finish(p_app_user_id,'work_report_submit',p_idempotency_key,v_result);
  return v_result;
end;
$function$;

-- F2 Review RPCs:
-- 1. work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)
-- 2. work_report_get_review_submission(uuid, uuid, uuid)
-- 3. work_report_decide_review(uuid, uuid, uuid, text, text, integer, text)
create or replace function public.work_report_list_pending_reviews(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid default null,
  p_cursor text default null,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := statement_timestamp();
  v_limit integer := coalesce(p_page_size, 50);
  v_cursor_parts text[];
  v_has_cursor boolean := false;
  v_cursor_submitted_at timestamptz;
  v_cursor_obligation_id uuid;
  v_items jsonb;
  v_next_cursor text;
  v_has_more boolean := false;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_review', v_as_of) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if v_limit not between 1 and 100 then
    raise exception 'WORK_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  if p_template_id is not null and not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    v_cursor_parts := string_to_array(p_cursor, '|');
    if coalesce(array_length(v_cursor_parts, 1), 0) <> 2 then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end if;
    begin
      if v_cursor_parts[1] !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
        raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
      end if;
      v_cursor_submitted_at := v_cursor_parts[1]::timestamptz;
      v_cursor_obligation_id := v_cursor_parts[2]::uuid;
      v_has_cursor := true;
    exception when others then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end;
  end if;

  with candidate_rows as (
    select o.obligation_id,
           s.submission_id,
           o.template_id,
           t.template_code,
           t.display_name as template_name,
           v.version_no as template_version,
           o.assignee_app_user_id,
           u.display_name as assignee_label,
           o.snapshot_team_id as team_id,
           coalesce(o.snapshot_team_display_name, tm.display_name, o.snapshot_team_code, tm.code, 'Chưa phân nhóm') as team_label,
           o.period_key,
           o.due_at,
           coalesce(s.latest_submitted_at, s.updated_at, s.created_at) as submitted_at,
           s.state,
           s.version
      from public.work_report_obligations o
      join public.work_report_submissions s on s.obligation_id = o.obligation_id
      join public.work_report_templates t on t.template_id = o.template_id
      join public.work_report_template_versions v on v.version_id = o.template_version_id
      join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
      left join public.teams tm on tm.team_id = o.snapshot_team_id
     where o.obligation_status = 'ACTIVE'
       and s.state = 'PENDING_REVIEW'
       and (p_template_id is null or o.template_id = p_template_id)
       and exists (
         select 1
           from public.work_report__internal_resolve_capability_authority(
             p_app_user_id, 'report_review', o.template_id, o.snapshot_team_id, v_as_of
           ) auth
       )
  ),
  window_rows as (
    select c.*
      from candidate_rows c
     where not v_has_cursor
        or c.submitted_at < v_cursor_submitted_at
        or (c.submitted_at = v_cursor_submitted_at and c.obligation_id < v_cursor_obligation_id)
     order by c.submitted_at desc, c.obligation_id desc
     limit (v_limit + 1)
  ),
  page_rows as (
    select *
      from window_rows
     order by submitted_at desc, obligation_id desc
     limit v_limit
  )
  select coalesce((
           select jsonb_agg(jsonb_build_object(
             'obligation_id', pr.obligation_id,
             'submission_id', pr.submission_id,
             'template_id', pr.template_id,
             'template_code', pr.template_code,
             'template_name', pr.template_name,
             'template_version', pr.template_version,
             'assignee_app_user_id', pr.assignee_app_user_id,
             'assignee_label', pr.assignee_label,
             'team_id', pr.team_id,
             'team_label', pr.team_label,
             'period_key', pr.period_key,
             'due_at', pr.due_at,
             'submitted_at', pr.submitted_at,
             'state', pr.state,
             'version', pr.version
           ) order by pr.submitted_at desc, pr.obligation_id desc)
           from page_rows pr
         ), '[]'::jsonb),
         (select count(*) > v_limit from window_rows),
         case
           when (select count(*) > v_limit from window_rows) then (
             select to_char(pr.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || pr.obligation_id::text
               from page_rows pr
              order by pr.submitted_at asc, pr.obligation_id asc
              limit 1
           )
           else null
         end
    into v_items, v_has_more, v_next_cursor;

  return jsonb_build_object(
    'items', v_items,
    'next_cursor', v_next_cursor,
    'has_more', v_has_more
  );
end;
$function$;

create or replace function public.work_report_get_review_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_scope text;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  select o.* into v_obligation
    from public.work_report_obligations o
   where o.obligation_id = p_obligation_id
      or exists (
        select 1 from public.work_report_submissions s
         where s.submission_id = p_obligation_id
           and s.obligation_id = o.obligation_id
      );
  if not found then
    raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select a.acting_scope_kind into v_scope
    from public.work_report__internal_resolve_capability_authority(
      p_app_user_id, 'report_review', v_obligation.template_id, v_obligation.snapshot_team_id
    ) a;
  if v_scope is null then
    raise exception 'WORK_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'obligation', jsonb_build_object(
      'obligation_id', o.obligation_id,
      'template_id', o.template_id,
      'assignee_app_user_id', o.assignee_app_user_id,
      'snapshot_team_id', o.snapshot_team_id,
      'snapshot_team_code', o.snapshot_team_code,
      'snapshot_team_display_name', o.snapshot_team_display_name,
      'period_key', o.period_key,
      'period_start_date', o.period_start_date,
      'period_end_date', o.period_end_date,
      'due_at', o.due_at,
      'obligation_status', o.obligation_status,
      'reopened_until', o.reopened_until,
      'version', o.version
    ),
    'template', jsonb_build_object(
      'template_id', t.template_id,
      'template_code', t.template_code,
      'display_name', t.display_name,
      'version_id', v.version_id,
      'version_no', v.version_no,
      'schema_json', v.schema_json
    ),
    'submission', case when s.submission_id is null then null else jsonb_build_object(
      'submission_id', s.submission_id,
      'state', s.state,
      'first_submitted_at', s.first_submitted_at,
      'latest_submitted_at', s.latest_submitted_at,
      'is_late', s.is_late,
      'has_post_deadline_amendment', s.has_post_deadline_amendment,
      'current_revision_id', s.current_revision_id,
      'version', s.version
    ) end,
    'current_revision', case when r.revision_id is null then null else jsonb_build_object(
      'revision_id', r.revision_id,
      'revision_no', r.revision_no,
      'payload_json', r.payload_json,
      'created_at', r.created_at
    ) end,
    'assignee_display_name', u.display_name,
    'team_display_name', coalesce(o.snapshot_team_display_name, tm.display_name, o.snapshot_team_code, tm.code),
    'review_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'review_event_id', re.review_event_id,
        'decision', re.decision,
        'reason', re.reason_text,
        'reviewed_at', re.created_at,
        'reviewer_display_name', ru.display_name,
        'revision_no', rr.revision_no
      ) order by re.created_at desc, re.review_event_id desc)
        from public.work_report_review_events re
        join public.direct_entry_app_users ru on ru.app_user_id = re.reviewer_user_id
        left join public.work_report_submission_revisions rr on rr.revision_id = re.revision_id
       where re.submission_id = s.submission_id
    ), '[]'::jsonb)
  ) into v_result
    from public.work_report_obligations o
    join public.work_report_templates t on t.template_id = o.template_id
    join public.work_report_template_versions v on v.version_id = o.template_version_id
    join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
    left join public.teams tm on tm.team_id = o.snapshot_team_id
    left join public.work_report_submissions s on s.obligation_id = o.obligation_id
    left join public.work_report_submission_revisions r on r.revision_id = s.current_revision_id
   where o.obligation_id = v_obligation.obligation_id;

  return v_result;
end;
$function$;

create or replace function public.work_report_decide_review(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid,
  p_decision text,
  p_reason text,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_submission public.work_report_submissions%rowtype;
  v_decision text;
  v_clean_reason text;
  v_reason_id uuid;
  v_acting_scope_kind text;
  v_acting_team_id uuid;
  v_delegation_id uuid;
  v_review_event_id uuid;
  v_now timestamptz := statement_timestamp();
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);

  v_decision := case upper(btrim(coalesce(p_decision, '')))
    when 'APPROVE' then 'APPROVED'
    when 'APPROVED' then 'APPROVED'
    when 'REJECT' then 'REJECTED'
    when 'REJECTED' then 'REJECTED'
    else null
  end;
  if v_decision is null then
    raise exception 'WORK_REPORT_REVIEW_DECISION_INVALID' using errcode = '22023';
  end if;

  v_clean_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_decision = 'REJECTED' and (v_clean_reason is null or length(v_clean_reason) > 4000) then
    raise exception 'WORK_REPORT_REVIEW_REASON_REQUIRED: rejection requires a reason' using errcode = '22023';
  end if;
  if v_clean_reason is not null and length(v_clean_reason) > 4000 then
    raise exception 'WORK_REPORT_REVIEW_REASON_INVALID' using errcode = '22023';
  end if;

  if p_obligation_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_REVIEW_INVALID' using errcode = '22023';
  end if;

  select * into v_obligation
    from public.work_report_obligations
   where obligation_id = p_obligation_id
   for update;
  if not found then
    raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_submission
    from public.work_report_submissions
   where obligation_id = p_obligation_id
   for update;
  if not found or v_submission.current_revision_id is null then
    raise exception 'WORK_REPORT_SUBMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select a.acting_scope_kind, a.acting_team_id, a.delegation_id
    into v_acting_scope_kind, v_acting_team_id, v_delegation_id
    from public.work_report__internal_resolve_capability_authority(
      p_app_user_id, 'report_review', v_obligation.template_id, v_obligation.snapshot_team_id, v_now
    ) a;
  if v_acting_scope_kind is null then
    raise exception 'WORK_REPORT_REVIEW_ACCESS_DENIED' using errcode = '42501';
  end if;

  if v_obligation.assignee_app_user_id = p_app_user_id
     or v_submission.assignee_app_user_id = p_app_user_id
     or v_submission.submitted_by_user_id = p_app_user_id then
    raise exception 'WORK_REPORT_SELF_REVIEW_FORBIDDEN' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'obligation_id', p_obligation_id,
    'decision', v_decision,
    'reason', v_clean_reason,
    'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_decide_review', p_idempotency_key, v_request_hash);
  if v_prior is not null then
    return v_prior;
  end if;

  if v_submission.version <> p_expected_version or v_submission.state <> 'PENDING_REVIEW' then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = '40001';
  end if;

  if v_clean_reason is not null then
    v_reason_id := public.direct_entry_reason(p_app_user_id, v_clean_reason);
  end if;

  update public.work_report_submissions
     set state = v_decision,
         reviewed_by_user_id = p_app_user_id,
         reviewed_at = v_now,
         review_reason_id = v_reason_id,
         version = version + 1,
         updated_at = v_now
   where submission_id = v_submission.submission_id
   returning * into v_submission;

  if v_decision = 'APPROVED' then
    update public.work_report_metric_values
       set is_current_revision = true,
           is_provisional = false,
           is_final = true,
           is_eligible = true
     where submission_id = v_submission.submission_id
       and revision_id = v_submission.current_revision_id;
  else
    update public.work_report_metric_values
       set is_current_revision = true,
           is_provisional = false,
           is_final = false,
           is_eligible = false
     where submission_id = v_submission.submission_id
       and revision_id = v_submission.current_revision_id;
  end if;

  insert into public.work_report_review_events
    (submission_id, revision_id, obligation_id, template_id, reviewer_user_id, author_user_id,
     decision, reason_id, reason_text, acting_scope_kind, acting_team_id, delegation_id, created_at)
  values
    (v_submission.submission_id, v_submission.current_revision_id, p_obligation_id, v_obligation.template_id,
     p_app_user_id, v_obligation.assignee_app_user_id, v_decision, v_reason_id, v_clean_reason,
     v_acting_scope_kind, v_acting_team_id, v_delegation_id, v_now)
  returning review_event_id into v_review_event_id;

  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, scope_team_id, template_id, obligation_id, submission_id, outcome, reason_id, metadata_json)
  values
    (case when v_decision = 'APPROVED' then 'REVIEW_APPROVE' else 'REVIEW_REJECT' end,
     p_app_user_id, 'report_review', v_acting_scope_kind, v_acting_team_id,
     v_obligation.template_id, p_obligation_id, v_submission.submission_id, 'APPLIED', v_reason_id,
     jsonb_build_object(
       'review_event_id', v_review_event_id,
       'revision_id', v_submission.current_revision_id,
       'decision', v_decision,
       'delegation_id', v_delegation_id
     ));

  v_result := jsonb_build_object(
    'submission_id', v_submission.submission_id,
    'obligation_id', p_obligation_id,
    'revision_id', v_submission.current_revision_id,
    'review_event_id', v_review_event_id,
    'state', v_decision,
    'version', v_submission.version,
    'acting_scope_kind', v_acting_scope_kind,
    'acting_team_id', v_acting_team_id,
    'delegation_id', v_delegation_id
  );
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_decide_review', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

-- F2 Delegation RPCs:
-- 4. work_report_list_delegations(uuid, uuid)
-- 5. work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamptz, timestamptz, text)
-- 6. work_report_revoke_delegation(uuid, uuid, uuid, integer, text)
create or replace function public.work_report_list_delegations(
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
  v_all_scope boolean;
  v_as_of timestamptz := statement_timestamp();
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');
  v_all_scope := public.direct_entry_has_scope(p_app_user_id, 'all');

  if not v_all_scope and not exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'team'
       and s.is_current
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'delegation_id', d.delegation_id,
        'grantor_user_id', d.grantor_user_id,
        'grantor_display_name', gu.display_name,
        'capability', d.capability,
        'delegate_app_user_id', d.delegate_app_user_id,
        'delegate_display_name', du.display_name,
        'template_id', d.template_id,
        'template_code', t.template_code,
        'template_name', t.display_name,
        'template_version_id', d.template_version_id,
        'scope_kind', d.scope_kind,
        'scope_id', d.scope_team_id,
        'scope_team_id', d.scope_team_id,
        'scope_label', case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end,
        'effective_from', d.effective_from,
        'effective_to', d.effective_to,
        'state', d.state,
        'status', case
          when d.state = 'REVOKED' or not d.is_current then 'REVOKED'
          when v_as_of > d.effective_to then 'EXPIRED'
          else 'ACTIVE'
        end,
        'is_current', d.is_current,
        'version', d.version,
        'created_at', d.created_at
      ) order by d.created_at desc, d.delegation_id desc)
        from public.work_report_delegations d
        join public.direct_entry_app_users gu on gu.app_user_id = d.grantor_user_id
        join public.direct_entry_app_users du on du.app_user_id = d.delegate_app_user_id
        join public.work_report_templates t on t.template_id = d.template_id
        left join public.teams tm on tm.team_id = d.scope_team_id
       where v_all_scope
          or d.grantor_user_id = p_app_user_id
          or (
            d.scope_kind = 'team'
            and exists (
              select 1
                from public.direct_entry_scope_grants s
                join public.teams scoped_team on scoped_team.team_id = s.team_id and scoped_team.active
               where s.app_user_id = p_app_user_id
                 and s.scope_kind = 'team'
                 and s.team_id = d.scope_team_id
                 and s.is_current
            )
          )
    ), '[]'::jsonb),
    'options', jsonb_build_object(
      'delegates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', u.app_user_id,
          'display_name', u.display_name
        ) order by u.display_name, u.app_user_id)
          from public.direct_entry_app_users u
         where u.enabled
           and u.app_user_id <> p_app_user_id
           and (
             v_all_scope
             or exists (
               select 1
                 from public.direct_entry_scope_grants s
                 join public.teams scoped_team on scoped_team.team_id = s.team_id and scoped_team.active
                where s.app_user_id = p_app_user_id
                  and s.scope_kind = 'team'
                  and s.is_current
                  and s.team_id = public.work_report_current_team(u.app_user_id)
             )
           )
      ), '[]'::jsonb),
      'templates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'template_id', t.template_id,
          'version_id', t.current_published_version_id,
          'name', t.display_name,
          'template_code', t.template_code,
          'display_name', t.display_name
        ) order by t.template_code)
          from public.work_report_templates t
         where t.status = 'ACTIVE'
           and t.current_published_version_id is not null
      ), '[]'::jsonb),
      'scopes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'scope_kind', sc.scope_kind,
          'scope_id', sc.scope_id,
          'label', sc.label
        ) order by sc.sort_order, sc.label)
          from (
            select 0 as sort_order, 'all'::text as scope_kind, null::uuid as scope_id, 'Toàn công ty'::text as label
             where v_all_scope
            union all
            select 1 as sort_order, 'team'::text as scope_kind, t.team_id as scope_id, coalesce(t.display_name, t.code) as label
              from public.teams t
             where t.active
               and (
                 v_all_scope
                 or exists (
                   select 1
                     from public.direct_entry_scope_grants s
                    where s.app_user_id = p_app_user_id
                      and s.scope_kind = 'team'
                      and s.team_id = t.team_id
                      and s.is_current
                 )
               )
          ) sc
      ), '[]'::jsonb),
      'capabilities', coalesce((
        select jsonb_agg(cap order by cap)
          from unnest(array['report_assign', 'report_review']::text[]) as cap
         where public.work_report__internal_has_direct_capability(p_app_user_id, cap)
      ), '[]'::jsonb)
    )
  );
end;
$function$;

create or replace function public.work_report_create_delegation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text,
  p_delegate_app_user_id uuid,
  p_template_id uuid,
  p_scope_kind text,
  p_scope_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');

  if p_capability is null or p_capability not in ('report_assign', 'report_review') then
    raise exception 'WORK_REPORT_DELEGATION_CAPABILITY_INVALID' using errcode = '22023';
  end if;

  if not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_delegate_app_user_id is null
     or p_template_id is null
     or p_scope_kind is null
     or p_scope_kind not in ('all', 'team')
     or p_effective_from is null
     or p_effective_to is null
     or p_effective_to < p_effective_from
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_DELEGATION_INVALID' using errcode = '22023';
  end if;

  if (p_scope_kind = 'all' and p_scope_id is not null)
     or (p_scope_kind = 'team' and p_scope_id is null) then
    raise exception 'WORK_REPORT_DELEGATION_SCOPE_INVALID' using errcode = '22023';
  end if;

  if p_delegate_app_user_id = p_app_user_id then
    raise exception 'WORK_REPORT_SELF_DELEGATION_FORBIDDEN' using errcode = '22023';
  end if;

  if not public.work_report__internal_has_direct_scope(p_app_user_id, 'report_delegate', p_scope_kind, p_scope_id)
     or not public.work_report__internal_has_direct_scope(p_app_user_id, p_capability, p_scope_kind, p_scope_id) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_delegate_app_user_id and u.enabled
  ) then
    raise exception 'WORK_REPORT_DELEGATE_NOT_AVAILABLE' using errcode = '42501';
  end if;

  if p_scope_kind = 'team' then
    if public.work_report_current_team(p_delegate_app_user_id) is distinct from p_scope_id
       and not exists (
         select 1
           from public.direct_entry_scope_grants sg
          where sg.app_user_id = p_delegate_app_user_id
            and sg.scope_kind = 'team'
            and sg.team_id = p_scope_id
            and sg.is_current
       ) then
      raise exception 'WORK_REPORT_DELEGATE_OUTSIDE_SCOPE' using errcode = '42501';
    end if;
  end if;

  select * into v_template
    from public.work_report_templates
   where template_id = p_template_id
   for share;
  if not found or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'capability', p_capability,
    'delegate_app_user_id', p_delegate_app_user_id,
    'template_id', p_template_id,
    'scope_kind', p_scope_kind,
    'scope_id', p_scope_id,
    'effective_from', p_effective_from,
    'effective_to', p_effective_to
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_delegation_create', p_idempotency_key, v_request_hash);
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_delegations
    (grantor_user_id, delegate_app_user_id, capability, template_id, template_version_id,
     scope_kind, scope_team_id, effective_from, effective_to, state, is_current, version)
  values
    (p_app_user_id, p_delegate_app_user_id, p_capability, p_template_id, v_template.current_published_version_id,
     p_scope_kind, p_scope_id, p_effective_from, p_effective_to, 'ACTIVE', true, 1)
  returning delegation_id into v_delegation_id;

  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, scope_team_id, template_id, outcome, metadata_json)
  values
    ('DELEGATION_CREATE', p_app_user_id, 'report_delegate', p_scope_kind, p_scope_id, p_template_id, 'APPLIED',
     jsonb_build_object(
       'delegation_id', v_delegation_id,
       'delegated_capability', p_capability,
       'delegate_app_user_id', p_delegate_app_user_id,
       'effective_from', p_effective_from,
       'effective_to', p_effective_to
     ));

  v_result := jsonb_build_object(
    'delegation_id', v_delegation_id,
    'status', 'ACTIVE',
    'state', 'ACTIVE',
    'version', 1
  );
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_delegation_create', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_revoke_delegation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_delegation_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_delegation public.work_report_delegations%rowtype;
  v_now timestamptz := statement_timestamp();
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');

  if p_delegation_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_DELEGATION_INVALID' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'delegation_id', p_delegation_id,
    'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_delegation_revoke', p_idempotency_key, v_request_hash);
  if v_prior is not null then
    return v_prior;
  end if;

  select * into v_delegation
    from public.work_report_delegations
   where delegation_id = p_delegation_id
   for update;
  if not found then
    raise exception 'WORK_REPORT_DELEGATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not public.direct_entry_has_scope(p_app_user_id, 'all')
     and v_delegation.grantor_user_id <> p_app_user_id
     and not (
       v_delegation.scope_kind = 'team'
       and public.work_report__internal_has_direct_scope(p_app_user_id, 'report_delegate', 'team', v_delegation.scope_team_id)
     ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if v_delegation.version <> p_expected_version or v_delegation.state = 'REVOKED' then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = '40001';
  end if;

  update public.work_report_delegations
     set state = 'REVOKED',
         is_current = false,
         revoked_by_user_id = p_app_user_id,
         revoked_at = v_now,
         version = version + 1,
         updated_at = v_now
   where delegation_id = p_delegation_id;

  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, scope_team_id, template_id, outcome, metadata_json)
  values
    ('DELEGATION_REVOKE', p_app_user_id, 'report_delegate', v_delegation.scope_kind, v_delegation.scope_team_id,
     v_delegation.template_id, 'APPLIED',
     jsonb_build_object(
       'delegation_id', p_delegation_id,
       'delegate_app_user_id', v_delegation.delegate_app_user_id,
       'delegated_capability', v_delegation.capability
     ));

  v_result := jsonb_build_object(
    'delegation_id', p_delegation_id,
    'status', 'REVOKED',
    'state', 'REVOKED',
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_delegation_revoke', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

-- F2 Analytics Finality updates ('final' vs 'provisional_included'):
create or replace function public.work_report_analytics_overview(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_version_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_team_id uuid default null,
  p_assignee_id uuid default null,
  p_finality text default 'final'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_label text;
  v_team_ids uuid[];
  v_as_of timestamptz := statement_timestamp();
  v_finality text := coalesce(p_finality, 'final');
  v_include_provisional boolean := false;
  v_compliance jsonb;
  v_metrics jsonb;
  v_ratios jsonb;
begin
  select s.scope_kind, s.scope_label, s.authorized_team_ids
    into v_scope_kind, v_scope_label, v_team_ids
    from public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, false, p_team_id, p_assignee_id, p_template_id
    ) s;

  if p_template_id is null or not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_version_id is not null and not exists (
    select 1 from public.work_report_template_versions v
     where v.version_id = p_version_id and v.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'WORK_REPORT_DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  if v_finality not in ('final', 'provisional_included') then
    raise exception 'WORK_REPORT_FINALITY_INVALID' using errcode = '22023';
  end if;
  v_include_provisional := (v_finality = 'provisional_included');

  with scoped_obligations as (
    select o.obligation_id,
           o.template_id,
           o.template_version_id,
           o.assignee_app_user_id,
           o.snapshot_team_id,
           o.period_type,
           o.period_key,
           o.period_start_date,
           o.period_end_date,
           o.due_at,
           o.obligation_status,
           s.submission_id,
           s.current_revision_id,
           s.state as submission_state,
           coalesce(s.is_late, false) as is_late
      from public.work_report_obligations o
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
     where o.template_id = p_template_id
       and (p_version_id is null or o.template_version_id = p_version_id)
       and (p_from is null or o.period_start_date >= p_from)
       and (p_to is null or o.period_start_date <= p_to)
       and (v_team_ids is null or o.snapshot_team_id = any(v_team_ids))
       and (p_assignee_id is null or o.assignee_app_user_id = p_assignee_id)
  ),
  compliance_counts as (
    select count(*) filter (where obligation_status = 'ACTIVE')::int as due_count,
           count(*) filter (where obligation_status = 'ACTIVE' and submission_state in ('COMPLETED', 'APPROVED'))::int as completed_count,
           count(*) filter (where obligation_status = 'ACTIVE' and submission_state in ('COMPLETED', 'APPROVED') and not is_late)::int as on_time_count,
           count(*) filter (where obligation_status = 'ACTIVE' and submission_state in ('COMPLETED', 'APPROVED') and is_late)::int as late_submitted_count,
           count(*) filter (where obligation_status = 'ACTIVE' and coalesce(submission_state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT', 'REJECTED') and v_as_of <= due_at)::int as pending_due_count,
           count(*) filter (where obligation_status = 'ACTIVE' and coalesce(submission_state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT', 'REJECTED') and v_as_of > due_at)::int as overdue_missing_count,
           count(*) filter (where obligation_status = 'EXEMPTED')::int as exempted_count,
           count(*) filter (where obligation_status = 'ACTIVE' and submission_state = 'PENDING_REVIEW')::int as pending_review_count
      from scoped_obligations
  )
  select jsonb_build_object(
    'due_count', c.due_count,
    'completed_count', c.completed_count,
    'on_time_count', c.on_time_count,
    'late_submitted_count', c.late_submitted_count,
    'pending_due_count', c.pending_due_count,
    'overdue_missing_count', c.overdue_missing_count,
    'exempted_count', c.exempted_count,
    'pending_review_count', c.pending_review_count,
    'completion_rate', case
      when c.due_count = 0 then null
      else trim_scale(round((c.completed_count::numeric * 100.0) / c.due_count::numeric, 2))
    end
  ) into v_compliance
    from compliance_counts c;

  with scoped_obligations as (
    select o.obligation_id,
           o.template_version_id,
           o.obligation_status,
           s.submission_id,
           s.current_revision_id,
           s.state as submission_state
      from public.work_report_obligations o
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
     where o.template_id = p_template_id
       and (p_version_id is null or o.template_version_id = p_version_id)
       and (p_from is null or o.period_start_date >= p_from)
       and (p_to is null or o.period_start_date <= p_to)
       and (v_team_ids is null or o.snapshot_team_id = any(v_team_ids))
       and (p_assignee_id is null or o.assignee_app_user_id = p_assignee_id)
  ),
  version_metrics as (
    select v.version_id,
           v.version_no,
           (s.ordinality * 1000 + f.ordinality)::int as sort_key,
           f.value ->> 'field_key' as field_key,
           f.value ->> 'field_type' as field_type,
           f.value ->> 'label' as field_label,
           f.value -> 'metric_spec' ->> 'metric_key' as metric_key,
           f.value -> 'metric_spec' ->> 'unit' as unit,
           f.value -> 'metric_spec' ->> 'compatible_group' as compatible_group
      from public.work_report_template_versions v
      cross join lateral jsonb_array_elements(v.schema_json -> 'sections') with ordinality as s(value, ordinality)
      cross join lateral jsonb_array_elements(s.value -> 'fields') with ordinality as f(value, ordinality)
     where v.template_id = p_template_id
       and (f.value ->> 'is_metric')::boolean
       and (
         (p_version_id is not null and v.version_id = p_version_id)
         or (
           p_version_id is null
           and (
             exists (select 1 from scoped_obligations so where so.template_version_id = v.version_id)
             or (
               not exists (select 1 from scoped_obligations)
               and v.version_id = coalesce(
                 (select t.current_published_version_id from public.work_report_templates t where t.template_id = p_template_id),
                 (select v2.version_id from public.work_report_template_versions v2 where v2.template_id = p_template_id order by v2.version_no desc limit 1)
               )
             )
           )
         )
       )
  ),
  metric_groups as (
    select vm.metric_key,
           vm.unit,
           vm.compatible_group,
           (array_agg(vm.field_type order by vm.version_no desc))[1] as field_type,
           (array_agg(vm.field_label order by vm.version_no desc))[1] as base_label,
           min(vm.sort_key)::int as sort_key,
           min(vm.version_no)::int as min_version_no,
           max(vm.version_no)::int as max_version_no,
           array_agg(distinct vm.version_id) as version_ids,
           count(*) over (partition by vm.metric_key)::int as variants_for_metric_key
      from version_metrics vm
     group by vm.metric_key, vm.unit, vm.compatible_group
  ),
  aggregated_metrics as (
    select mg.metric_key,
           case
             when mg.variants_for_metric_key > 1 then
               case
                 when mg.min_version_no = mg.max_version_no then format('%s (v%s)', mg.base_label, mg.max_version_no)
                 else format('%s (v%s-v%s)', mg.base_label, mg.min_version_no, mg.max_version_no)
               end
             else mg.base_label
           end as label,
           mg.unit,
           mg.compatible_group,
           mg.sort_key,
           mg.max_version_no,
           stats.sum_value,
           stats.avg_value,
           stats.min_value,
           stats.max_value,
           stats.count_valid,
           greatest(completed_obs.completed_for_group - stats.count_valid, 0)::int as missing_value_count
      from metric_groups mg
      cross join lateral (
        select count(*)::int as completed_for_group
          from scoped_obligations so
         where so.obligation_status = 'ACTIVE'
           and (
             so.submission_state in ('COMPLETED', 'APPROVED')
             or (v_include_provisional and so.submission_state = 'PENDING_REVIEW')
           )
           and so.template_version_id = any(mg.version_ids)
      ) completed_obs
      cross join lateral (
        select case
                 when mg.field_type in ('integer', 'decimal') then
                   case when count(mv.numeric_value) = 0 then null else trim_scale(round(sum(mv.numeric_value), 4)) end
                 when mg.field_type = 'boolean' then
                   case when count(mv.boolean_value) = 0 then null else (count(distinct mv.submission_id) filter (where mv.boolean_value = true))::numeric end
                 else
                   case when count(mv.option_key) = 0 then null else (count(distinct mv.submission_id) filter (where mv.option_key is not null))::numeric end
               end as sum_value,
               case
                 when mg.field_type in ('integer', 'decimal') then
                   case when count(mv.numeric_value) = 0 then null else trim_scale(round(avg(mv.numeric_value), 2)) end
                 when mg.field_type = 'boolean' then
                   case
                     when count(distinct mv.submission_id) filter (where mv.boolean_value is not null) = 0 then null
                     else trim_scale(round(
                       (count(distinct mv.submission_id) filter (where mv.boolean_value = true)::numeric * 100.0)
                       / count(distinct mv.submission_id) filter (where mv.boolean_value is not null)::numeric,
                       2
                     ))
                   end
                 else null
               end as avg_value,
               case
                 when mg.field_type in ('integer', 'decimal') and count(mv.numeric_value) > 0 then
                   trim_scale(round(min(mv.numeric_value), 4))
                 else null
               end as min_value,
               case
                 when mg.field_type in ('integer', 'decimal') and count(mv.numeric_value) > 0 then
                   trim_scale(round(max(mv.numeric_value), 4))
                 else null
               end as max_value,
               case
                 when mg.field_type in ('integer', 'decimal') then
                   (count(distinct mv.submission_id) filter (where mv.numeric_value is not null))::int
                 when mg.field_type = 'boolean' then
                   (count(distinct mv.submission_id) filter (where mv.boolean_value is not null))::int
                 else
                   (count(distinct mv.submission_id) filter (where mv.option_key is not null))::int
               end as count_valid
          from scoped_obligations so
          join public.work_report_metric_values mv
            on mv.obligation_id = so.obligation_id
           and mv.submission_id = so.submission_id
           and mv.revision_id = so.current_revision_id
         where so.obligation_status = 'ACTIVE'
           and (
             so.submission_state in ('COMPLETED', 'APPROVED')
             or (v_include_provisional and so.submission_state = 'PENDING_REVIEW')
           )
           and mv.is_eligible = true
           and (mv.is_final = true or (v_include_provisional and mv.is_provisional = true))
           and mv.metric_key = mg.metric_key
           and mv.unit = mg.unit
           and mv.compatible_group = mg.compatible_group
      ) stats
  ),
  ratio_pairs(ratio_key, label, numerator_key, denominator_key) as (
    values
      ('interested_per_call_rate', 'Tỷ lệ ứng viên quan tâm / cuộc gọi', 'interested_candidates', 'calls_made'),
      ('started_per_interested_rate', 'Tỷ lệ NLĐ đi làm / ứng viên quan tâm', 'workers_started', 'interested_candidates'),
      ('started_per_call_rate', 'Tỷ lệ NLĐ đi làm / cuộc gọi', 'workers_started', 'calls_made')
  ),
  computed_ratios as (
    select rp.ratio_key,
           rp.label,
           rp.numerator_key as numerator_metric_key,
           rp.denominator_key as denominator_metric_key,
           num.sum_value as numerator_sum,
           den.sum_value as denominator_sum,
           100 as scale_factor,
           case
             when coalesce(den.sum_value, 0) <= 0 or num.sum_value is null then null
             else trim_scale(round((num.sum_value::numeric * 100.0) / den.sum_value::numeric, 2))
           end as value
      from ratio_pairs rp
      join aggregated_metrics num on num.metric_key = rp.numerator_key and num.max_version_no = (
        select max(m2.max_version_no) from aggregated_metrics m2 where m2.metric_key = rp.numerator_key
      )
      join aggregated_metrics den on den.metric_key = rp.denominator_key and den.max_version_no = (
        select max(m3.max_version_no) from aggregated_metrics m3 where m3.metric_key = rp.denominator_key
      )
  )
  select coalesce((
           select jsonb_agg(jsonb_build_object(
             'metric_key', am.metric_key,
             'label', am.label,
             'unit', am.unit,
             'compatible_group', am.compatible_group,
             'sum_value', am.sum_value,
             'avg_value', am.avg_value,
             'min_value', am.min_value,
             'max_value', am.max_value,
             'count_valid', am.count_valid,
             'missing_value_count', am.missing_value_count
           ) order by am.sort_key, am.metric_key, am.max_version_no, am.compatible_group)
           from aggregated_metrics am
         ), '[]'::jsonb),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'ratio_key', cr.ratio_key,
             'label', cr.label,
             'numerator_metric_key', cr.numerator_metric_key,
             'denominator_metric_key', cr.denominator_metric_key,
             'numerator_sum', cr.numerator_sum,
             'denominator_sum', cr.denominator_sum,
             'scale_factor', cr.scale_factor,
             'value', cr.value
           ) order by cr.ratio_key)
           from computed_ratios cr
         ), '[]'::jsonb)
    into v_metrics, v_ratios;

  return jsonb_build_object(
    'as_of', to_char(v_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effective_scope', jsonb_build_object('kind', v_scope_kind, 'label', v_scope_label),
    'compliance', v_compliance,
    'metrics', v_metrics,
    'ratios', v_ratios
  );
end;
$function$;

create or replace function public.work_report_analytics_breakdown(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_version_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_team_id uuid default null,
  p_assignee_id uuid default null,
  p_finality text default 'final',
  p_group_by text default 'team',
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_label text;
  v_team_ids uuid[];
  v_as_of timestamptz := statement_timestamp();
  v_finality text := coalesce(p_finality, 'final');
  v_include_provisional boolean := false;
  v_offset integer;
  v_total_groups integer := 0;
  v_items jsonb;
begin
  select s.scope_kind, s.scope_label, s.authorized_team_ids
    into v_scope_kind, v_scope_label, v_team_ids
    from public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, false, p_team_id, p_assignee_id, p_template_id
    ) s;

  if p_template_id is null or not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_version_id is not null and not exists (
    select 1 from public.work_report_template_versions v
     where v.version_id = p_version_id and v.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'WORK_REPORT_DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  if v_finality not in ('final', 'provisional_included') then
    raise exception 'WORK_REPORT_FINALITY_INVALID' using errcode = '22023';
  end if;
  v_include_provisional := (v_finality = 'provisional_included');

  if p_group_by is null or p_group_by not in ('team', 'assignee', 'period') then
    raise exception 'WORK_REPORT_GROUP_BY_INVALID' using errcode = '22023';
  end if;

  if p_page is null or p_page not between 1 and 1000
     or p_page_size is null or p_page_size not between 1 and 100 then
    raise exception 'WORK_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  v_offset := (p_page - 1) * p_page_size;

  with scoped_obligations as (
    select o.obligation_id,
           o.template_version_id,
           o.assignee_app_user_id,
           u.display_name as assignee_display_name,
           o.snapshot_team_id,
           coalesce(o.snapshot_team_display_name, t.display_name, o.snapshot_team_code, t.code, 'Chưa phân nhóm') as team_display_name,
           coalesce(o.snapshot_team_code, t.code, '') as team_code,
           o.period_key,
           o.period_start_date,
           o.due_at,
           o.obligation_status,
           s.submission_id,
           s.current_revision_id,
           s.state as submission_state,
           coalesce(s.is_late, false) as is_late,
           case p_group_by
             when 'team' then o.snapshot_team_id::text
             when 'assignee' then o.assignee_app_user_id::text
             else o.period_key
           end as group_id,
           case p_group_by
             when 'team' then coalesce(o.snapshot_team_display_name, t.display_name, o.snapshot_team_code, t.code, 'Chưa phân nhóm')
             when 'assignee' then coalesce(u.display_name, o.assignee_app_user_id::text)
             else o.period_key
           end as group_label,
           case p_group_by
             when 'team' then coalesce(o.snapshot_team_code, t.code, '')
             when 'assignee' then coalesce(u.display_name, '')
             else o.period_start_date::text || ':' || o.period_key
           end as group_sort
      from public.work_report_obligations o
      join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
      left join public.teams t on t.team_id = o.snapshot_team_id
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
     where o.template_id = p_template_id
       and o.obligation_status in ('ACTIVE', 'EXEMPTED')
       and (p_version_id is null or o.template_version_id = p_version_id)
       and (p_from is null or o.period_start_date >= p_from)
       and (p_to is null or o.period_start_date <= p_to)
       and (v_team_ids is null or o.snapshot_team_id = any(v_team_ids))
       and (p_assignee_id is null or o.assignee_app_user_id = p_assignee_id)
  ),
  version_metrics as (
    select v.version_id,
           v.version_no,
           (s.ordinality * 1000 + f.ordinality)::int as sort_key,
           f.value ->> 'field_key' as field_key,
           f.value ->> 'field_type' as field_type,
           f.value ->> 'label' as field_label,
           f.value -> 'metric_spec' ->> 'metric_key' as metric_key,
           f.value -> 'metric_spec' ->> 'unit' as unit,
           f.value -> 'metric_spec' ->> 'compatible_group' as compatible_group
      from public.work_report_template_versions v
      cross join lateral jsonb_array_elements(v.schema_json -> 'sections') with ordinality as s(value, ordinality)
      cross join lateral jsonb_array_elements(s.value -> 'fields') with ordinality as f(value, ordinality)
     where v.template_id = p_template_id
       and (f.value ->> 'is_metric')::boolean
       and (
         (p_version_id is not null and v.version_id = p_version_id)
         or (
           p_version_id is null
           and (
             exists (select 1 from scoped_obligations so where so.template_version_id = v.version_id)
             or (
               not exists (select 1 from scoped_obligations)
               and v.version_id = coalesce(
                 (select t.current_published_version_id from public.work_report_templates t where t.template_id = p_template_id),
                 (select v2.version_id from public.work_report_template_versions v2 where v2.template_id = p_template_id order by v2.version_no desc limit 1)
               )
             )
           )
         )
       )
  ),
  metric_groups as (
    select vm.metric_key,
           vm.unit,
           vm.compatible_group,
           (array_agg(vm.field_type order by vm.version_no desc))[1] as field_type,
           (array_agg(vm.field_label order by vm.version_no desc))[1] as base_label,
           min(vm.sort_key)::int as sort_key,
           min(vm.version_no)::int as min_version_no,
           max(vm.version_no)::int as max_version_no,
           array_agg(distinct vm.version_id) as version_ids,
           count(*) over (partition by vm.metric_key)::int as variants_for_metric_key
      from version_metrics vm
     group by vm.metric_key, vm.unit, vm.compatible_group
  ),
  grouped_base as (
    select so.group_id,
           max(so.group_label) as group_label,
           max(so.group_sort) as group_sort,
           count(*) filter (where so.obligation_status = 'ACTIVE')::int as due_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and so.submission_state in ('COMPLETED', 'APPROVED'))::int as completed_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and so.submission_state in ('COMPLETED', 'APPROVED') and not so.is_late)::int as on_time_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and so.submission_state in ('COMPLETED', 'APPROVED') and so.is_late)::int as late_submitted_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and coalesce(so.submission_state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT', 'REJECTED') and v_as_of <= so.due_at)::int as pending_due_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and coalesce(so.submission_state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT', 'REJECTED') and v_as_of > so.due_at)::int as overdue_missing_count,
           count(*) filter (where so.obligation_status = 'EXEMPTED')::int as exempted_count,
           count(*) filter (where so.obligation_status = 'ACTIVE' and so.submission_state = 'PENDING_REVIEW')::int as pending_review_count
      from scoped_obligations so
     group by so.group_id
  ),
  paged_groups as (
    select gb.*,
           count(*) over ()::int as total_groups
      from grouped_base gb
     order by
       case when p_group_by = 'period' then gb.group_sort end desc,
       case when p_group_by <> 'period' then gb.group_sort end asc,
       gb.group_id asc nulls last
     offset v_offset
     limit p_page_size
  ),
  enriched_groups as (
    select pg.*,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'metric_key', mg.metric_key,
               'label', case
                 when mg.variants_for_metric_key > 1 then
                   case
                     when mg.min_version_no = mg.max_version_no then format('%s (v%s)', mg.base_label, mg.max_version_no)
                     else format('%s (v%s-v%s)', mg.base_label, mg.min_version_no, mg.max_version_no)
                   end
                 else mg.base_label
               end,
               'unit', mg.unit,
               'compatible_group', mg.compatible_group,
               'sum_value', stats.sum_value,
               'avg_value', stats.avg_value,
               'min_value', stats.min_value,
               'max_value', stats.max_value,
               'count_valid', stats.count_valid,
               'missing_value_count', greatest(completed_obs.completed_for_group - stats.count_valid, 0)::int
             ) order by mg.sort_key, mg.metric_key, mg.max_version_no, mg.compatible_group)
               from metric_groups mg
               cross join lateral (
                 select count(*)::int as completed_for_group
                   from scoped_obligations so
                  where so.group_id is not distinct from pg.group_id
                    and so.obligation_status = 'ACTIVE'
                    and (
                      so.submission_state in ('COMPLETED', 'APPROVED')
                      or (v_include_provisional and so.submission_state = 'PENDING_REVIEW')
                    )
                    and so.template_version_id = any(mg.version_ids)
               ) completed_obs
               cross join lateral (
                 select case
                          when mg.field_type in ('integer', 'decimal') then
                            case when count(mv.numeric_value) = 0 then null else trim_scale(round(sum(mv.numeric_value), 4)) end
                          when mg.field_type = 'boolean' then
                            case when count(mv.boolean_value) = 0 then null else (count(distinct mv.submission_id) filter (where mv.boolean_value = true))::numeric end
                          else
                            case when count(mv.option_key) = 0 then null else (count(distinct mv.submission_id) filter (where mv.option_key is not null))::numeric end
                        end as sum_value,
                        case
                          when mg.field_type in ('integer', 'decimal') then
                            case when count(mv.numeric_value) = 0 then null else trim_scale(round(avg(mv.numeric_value), 2)) end
                          when mg.field_type = 'boolean' then
                            case
                              when count(distinct mv.submission_id) filter (where mv.boolean_value is not null) = 0 then null
                              else trim_scale(round(
                                (count(distinct mv.submission_id) filter (where mv.boolean_value = true)::numeric * 100.0)
                                / count(distinct mv.submission_id) filter (where mv.boolean_value is not null)::numeric,
                                2
                              ))
                            end
                          else null
                        end as avg_value,
                        case
                          when mg.field_type in ('integer', 'decimal') and count(mv.numeric_value) > 0 then
                            trim_scale(round(min(mv.numeric_value), 4))
                          else null
                        end as min_value,
                        case
                          when mg.field_type in ('integer', 'decimal') and count(mv.numeric_value) > 0 then
                            trim_scale(round(max(mv.numeric_value), 4))
                          else null
                        end as max_value,
                        case
                          when mg.field_type in ('integer', 'decimal') then
                            (count(distinct mv.submission_id) filter (where mv.numeric_value is not null))::int
                          when mg.field_type = 'boolean' then
                            (count(distinct mv.submission_id) filter (where mv.boolean_value is not null))::int
                          else
                            (count(distinct mv.submission_id) filter (where mv.option_key is not null))::int
                        end as count_valid
                   from scoped_obligations so
                   join public.work_report_metric_values mv
                     on mv.obligation_id = so.obligation_id
                    and mv.submission_id = so.submission_id
                    and mv.revision_id = so.current_revision_id
                  where so.group_id is not distinct from pg.group_id
                    and so.obligation_status = 'ACTIVE'
                    and (
                      so.submission_state in ('COMPLETED', 'APPROVED')
                      or (v_include_provisional and so.submission_state = 'PENDING_REVIEW')
                    )
                    and mv.is_eligible = true
                    and (mv.is_final = true or (v_include_provisional and mv.is_provisional = true))
                    and mv.metric_key = mg.metric_key
                    and mv.unit = mg.unit
                    and mv.compatible_group = mg.compatible_group
               ) stats
           ), '[]'::jsonb) as metrics
      from paged_groups pg
  )
  select coalesce(max(eg.total_groups), 0)::int,
         coalesce(jsonb_agg(jsonb_build_object(
           'group_id', eg.group_id,
           'group_label', eg.group_label,
           'due_count', eg.due_count,
           'completed_count', eg.completed_count,
           'on_time_count', eg.on_time_count,
           'late_submitted_count', eg.late_submitted_count,
           'pending_due_count', eg.pending_due_count,
           'overdue_missing_count', eg.overdue_missing_count,
           'exempted_count', eg.exempted_count,
           'pending_review_count', eg.pending_review_count,
           'completion_rate', case
             when eg.due_count = 0 then null
             else trim_scale(round((eg.completed_count::numeric * 100.0) / eg.due_count::numeric, 2))
           end,
           'metrics', eg.metrics
         )), '[]'::jsonb)
    into v_total_groups, v_items
    from enriched_groups eg;

  return jsonb_build_object(
    'as_of', to_char(v_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effective_scope', jsonb_build_object('kind', v_scope_kind, 'label', v_scope_label),
    'group_by', p_group_by,
    'page', p_page,
    'page_size', p_page_size,
    'total_groups', v_total_groups,
    'items', v_items
  );
end;
$function$;

create or replace function public.work_report_analytics_contributions(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_version_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_team_id uuid default null,
  p_assignee_id uuid default null,
  p_finality text default 'final',
  p_metric_key text default null,
  p_compatible_group text default null,
  p_target_team_id uuid default null,
  p_target_assignee_id uuid default null,
  p_target_period_key text default null,
  p_cursor text default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_label text;
  v_team_ids uuid[];
  v_as_of timestamptz := statement_timestamp();
  v_finality text := coalesce(p_finality, 'final');
  v_include_provisional boolean := false;
  v_effective_team_filter uuid := coalesce(p_target_team_id, p_team_id);
  v_cursor_parts text[];
  v_has_cursor boolean := false;
  v_cursor_has_submitted_at boolean := false;
  v_cursor_submitted_at timestamptz;
  v_cursor_period_start_date date;
  v_cursor_obligation_id uuid;
  v_items jsonb;
  v_next_cursor text;
begin
  select s.scope_kind, s.scope_label, s.authorized_team_ids
    into v_scope_kind, v_scope_label, v_team_ids
    from public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, true, p_team_id, p_assignee_id, p_template_id
    ) s;

  if p_target_team_id is not null then
    perform public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, true, p_target_team_id, null, p_template_id
    );
    if p_team_id is not null and p_team_id <> p_target_team_id then
      v_team_ids := array[]::uuid[];
    else
      v_team_ids := array[p_target_team_id];
    end if;
  end if;

  if p_target_assignee_id is not null then
    perform public.work_report__internal_resolve_analytics_scope(
      p_auth_subject, p_app_user_id, true, v_effective_team_filter, p_target_assignee_id, p_template_id
    );
  end if;

  if p_template_id is null or not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_version_id is not null and not exists (
    select 1 from public.work_report_template_versions v
     where v.version_id = p_version_id and v.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'WORK_REPORT_DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  if v_finality not in ('final', 'provisional_included') then
    raise exception 'WORK_REPORT_FINALITY_INVALID' using errcode = '22023';
  end if;
  v_include_provisional := (v_finality = 'provisional_included');

  if p_metric_key is not null and p_metric_key !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'WORK_REPORT_METRIC_INVALID' using errcode = '22023';
  end if;

  if p_compatible_group is not null and p_compatible_group !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'WORK_REPORT_METRIC_INVALID' using errcode = '22023';
  end if;

  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'WORK_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    v_cursor_parts := string_to_array(p_cursor, '|');
    if coalesce(array_length(v_cursor_parts, 1), 0) <> 3 then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end if;
    begin
      if v_cursor_parts[1] = 'null' then
        v_cursor_submitted_at := null;
        v_cursor_has_submitted_at := false;
      else
        if v_cursor_parts[1] !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
          raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
        end if;
        v_cursor_submitted_at := v_cursor_parts[1]::timestamptz;
        v_cursor_has_submitted_at := true;
      end if;
      if v_cursor_parts[2] !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
      end if;
      v_cursor_period_start_date := v_cursor_parts[2]::date;
      v_cursor_obligation_id := v_cursor_parts[3]::uuid;
      v_has_cursor := true;
    exception when others then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end;
  end if;

  with candidate_rows as (
    select o.obligation_id,
           s.submission_id,
           r.revision_no,
           o.assignee_app_user_id,
           u.display_name as assignee_display_name,
           o.snapshot_team_id,
           coalesce(o.snapshot_team_display_name, t.display_name, o.snapshot_team_code, t.code) as team_display_name,
           o.period_key,
           o.period_start_date,
           coalesce(s.state, 'NOT_STARTED') as state,
           s.latest_submitted_at as submitted_at,
           coalesce(s.is_late, false) as is_late,
           coalesce(s.has_post_deadline_amendment, false) as has_post_deadline_amendment,
           metric_contrib.metric_contribution_value
      from public.work_report_obligations o
      join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
      left join public.teams t on t.team_id = o.snapshot_team_id
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
      left join public.work_report_submission_revisions r on r.revision_id = s.current_revision_id
      left join lateral (
        select case
                 when max(mv.value_type) in ('INTEGER', 'DECIMAL') then trim_scale(round(sum(mv.numeric_value), 4))
                 when max(mv.value_type) = 'BOOLEAN' then case when bool_or(mv.boolean_value) then 1::numeric else 0::numeric end
                 else 1::numeric
               end as metric_contribution_value,
               count(*)::int as matched_rows
          from public.work_report_metric_values mv
         where p_metric_key is not null
           and mv.obligation_id = o.obligation_id
           and mv.submission_id = s.submission_id
           and mv.revision_id = s.current_revision_id
           and mv.is_eligible = true
           and (mv.is_final = true or (v_include_provisional and mv.is_provisional = true))
           and mv.metric_key = p_metric_key
           and (p_compatible_group is null or mv.compatible_group = p_compatible_group)
           and (
             (mv.value_type in ('INTEGER', 'DECIMAL') and mv.numeric_value is not null)
             or (mv.value_type = 'BOOLEAN' and mv.boolean_value is not null)
             or (mv.value_type in ('SINGLE_SELECT', 'MULTI_SELECT') and mv.option_key is not null)
           )
      ) metric_contrib on true
     where o.template_id = p_template_id
       and o.obligation_status = 'ACTIVE'
       and (p_version_id is null or o.template_version_id = p_version_id)
       and (p_from is null or o.period_start_date >= p_from)
       and (p_to is null or o.period_start_date <= p_to)
       and (v_team_ids is null or o.snapshot_team_id = any(v_team_ids))
       and (p_assignee_id is null or o.assignee_app_user_id = p_assignee_id)
       and (p_target_assignee_id is null or o.assignee_app_user_id = p_target_assignee_id)
       and (p_target_period_key is null or o.period_key = p_target_period_key)
       and (
         p_metric_key is null
         or (
           (
             s.state in ('COMPLETED', 'APPROVED')
             or (v_include_provisional and s.state = 'PENDING_REVIEW')
           )
           and coalesce(metric_contrib.matched_rows, 0) > 0
         )
       )
  ),
  window_rows as (
    select c.*
      from candidate_rows c
     where not v_has_cursor
        or (
          v_cursor_has_submitted_at
          and (
            c.submitted_at is null
            or c.submitted_at < v_cursor_submitted_at
            or (
              c.submitted_at = v_cursor_submitted_at
              and (
                c.period_start_date < v_cursor_period_start_date
                or (c.period_start_date = v_cursor_period_start_date and c.obligation_id < v_cursor_obligation_id)
              )
            )
          )
        )
        or (
          not v_cursor_has_submitted_at
          and c.submitted_at is null
          and (
            c.period_start_date < v_cursor_period_start_date
            or (c.period_start_date = v_cursor_period_start_date and c.obligation_id < v_cursor_obligation_id)
          )
        )
     order by c.submitted_at desc nulls last, c.period_start_date desc, c.obligation_id desc
     limit (p_limit + 1)
  ),
  page_rows as (
    select *
      from window_rows
     order by submitted_at desc nulls last, period_start_date desc, obligation_id desc
     limit p_limit
  )
  select coalesce((
           select jsonb_agg(jsonb_build_object(
             'obligation_id', pr.obligation_id,
             'submission_id', pr.submission_id,
             'revision_no', pr.revision_no,
             'assignee_app_user_id', pr.assignee_app_user_id,
             'assignee_display_name', pr.assignee_display_name,
             'snapshot_team_id', pr.snapshot_team_id,
             'team_display_name', pr.team_display_name,
             'period_key', pr.period_key,
             'state', pr.state,
             'submitted_at', pr.submitted_at,
             'is_late', pr.is_late,
             'has_post_deadline_amendment', pr.has_post_deadline_amendment,
             'metric_contribution_value', pr.metric_contribution_value
           ) order by pr.submitted_at desc nulls last, pr.period_start_date desc, pr.obligation_id desc)
           from page_rows pr
         ), '[]'::jsonb),
         case
           when (select count(*) from window_rows) > p_limit then (
             select case
                      when pr.submitted_at is null then 'null'
                      else to_char(pr.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                    end || '|' || pr.period_start_date::text || '|' || pr.obligation_id::text
               from page_rows pr
              order by pr.submitted_at asc nulls first, pr.period_start_date asc, pr.obligation_id asc
              limit 1
           )
           else null
         end
    into v_items, v_next_cursor;

  return jsonb_build_object(
    'as_of', to_char(v_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effective_scope', jsonb_build_object('kind', v_scope_kind, 'label', v_scope_label),
    'next_cursor', v_next_cursor,
    'items', v_items
  );
end;
$function$;

-- Reconcile metric projection updated to expect is_eligible=false on REJECTED submissions.
-- (Note: F1.5 already defined expected_provisional = (ss.state = 'PENDING_REVIEW'),
-- expected_final = (ss.state in ('COMPLETED', 'APPROVED')),
-- expected_eligible = (ss.state in ('COMPLETED', 'APPROVED', 'PENDING_REVIEW')).)

-- Lock down all new and updated functions; expose only the server-bound RPC allowlist to service_role.
revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_actor_context(uuid) to service_role;

revoke all on function public.work_report_sync_team_leader_capabilities()
  from public, anon, authenticated, service_role;
revoke all on function public.work_report__internal_has_direct_capability(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report__internal_has_direct_scope(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report__internal_is_delegation_effective(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report__internal_resolve_capability_authority(uuid, text, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report__internal_has_any_capability_authority(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_assert_actor(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_assert_scope(uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.work_report_list_assignment_options(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_direct_cap boolean;
  v_direct_all boolean;
  v_direct_has_team boolean;
  v_delegated_all boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_direct_cap := public.work_report__internal_has_direct_capability(p_app_user_id, 'report_assign');
  v_direct_all := v_direct_cap and public.direct_entry_has_scope(p_app_user_id, 'all');
  v_direct_has_team := v_direct_cap and exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active
     where s.app_user_id = p_app_user_id and s.scope_kind = 'team' and s.is_current
  );
  v_delegated_all := exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'all'
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  );

  if p_team_id is not null then
    if not exists (select 1 from public.teams t where t.team_id = p_team_id and t.active) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if not (
      v_direct_all
      or v_delegated_all
      or (
        v_direct_cap and exists (
          select 1 from public.direct_entry_scope_grants s
           where s.app_user_id = p_app_user_id
             and s.scope_kind = 'team'
             and s.team_id = p_team_id
             and s.is_current
        )
      )
      or exists (
        select 1 from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'team'
           and d.scope_team_id = p_team_id
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'template_id', t.template_id,
        'template_code', t.template_code,
        'display_name', t.display_name,
        'default_frequency', t.default_frequency,
        'current_published_version_id', t.current_published_version_id
      ) order by t.template_code)
        from public.work_report_templates t
       where t.status = 'ACTIVE'
         and t.current_published_version_id is not null
         and (
           v_direct_all
           or v_direct_has_team
           or exists (
             select 1 from public.work_report_delegations d
              where d.delegate_app_user_id = p_app_user_id
                and d.capability = 'report_assign'
                and d.template_id = t.template_id
                and public.work_report__internal_is_delegation_effective(d.delegation_id)
           )
         )
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'team_id', t.team_id, 'code', t.code, 'display_name', t.display_name
      ) order by t.code)
        from public.teams t
       where t.active and (
         v_direct_all
         or v_delegated_all
         or (
           v_direct_cap and exists (
             select 1 from public.direct_entry_scope_grants s
              where s.app_user_id = p_app_user_id and s.scope_kind = 'team'
                and s.team_id = t.team_id and s.is_current
           )
         )
         or exists (
           select 1 from public.work_report_delegations d
            where d.delegate_app_user_id = p_app_user_id
              and d.capability = 'report_assign'
              and d.scope_kind = 'team'
              and d.scope_team_id = t.team_id
              and public.work_report__internal_is_delegation_effective(d.delegation_id)
         )
       )
    ), '[]'::jsonb),
    'users', case when p_team_id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'app_user_id', eligible.app_user_id, 'display_name', eligible.display_name
      ) order by eligible.display_name, eligible.app_user_id)
        from (
          select distinct u.app_user_id, u.display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.direct_entry_app_users u on u.app_user_id = l.app_user_id and u.enabled
            join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
            join public.recruiter_team_memberships m on m.recruiter_id = r.recruiter_id
              and m.team_id = p_team_id and m.is_current
           where l.verified and l.is_current
             and exists (
               select 1 from public.teams t where t.team_id = p_team_id and t.active
             )
        ) eligible
    ), '[]'::jsonb) end
  );
end;
$function$;

create or replace function public.work_report_list_assignments(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_direct_cap boolean;
  v_direct_all boolean;
  v_delegated_all boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_direct_cap := public.work_report__internal_has_direct_capability(p_app_user_id, 'report_assign');
  v_direct_all := v_direct_cap and public.direct_entry_has_scope(p_app_user_id, 'all');
  v_delegated_all := exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'all'
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  );

  if p_team_id is not null then
    if not exists (select 1 from public.teams t where t.team_id = p_team_id and t.active) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if not (
      v_direct_all
      or v_delegated_all
      or (
        v_direct_cap and exists (
          select 1 from public.direct_entry_scope_grants s
           where s.app_user_id = p_app_user_id
             and s.scope_kind = 'team'
             and s.team_id = p_team_id
             and s.is_current
        )
      )
      or exists (
        select 1 from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'team'
           and d.scope_team_id = p_team_id
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'assignment_id', tracked.assignment_id,
      'template_id', tracked.template_id,
      'template_code', tracked.template_code,
      'template_name', tracked.template_name,
      'target_kind', tracked.target_kind,
      'target_label', tracked.target_label,
      'frequency', tracked.frequency,
      'is_mandatory', tracked.is_mandatory,
      'effective_from', tracked.effective_from,
      'effective_to', tracked.effective_to,
      'state', tracked.state,
      'version', tracked.version,
      'created_at', tracked.created_at,
      'obligation_total', tracked.obligation_total,
      'submitted_count', tracked.submitted_count,
      'not_started_count', tracked.not_started_count,
      'draft_count', tracked.draft_count,
      'exempted_count', tracked.exempted_count,
      'cancelled_count', tracked.cancelled_count
    ) order by tracked.updated_at desc, tracked.assignment_id)
      from (
       select a.assignment_id, a.template_id, t.template_code, t.display_name as template_name,
         a.target_kind,
         case a.target_kind when 'TEAM' then coalesce(team.display_name, team.code, 'Nhóm không còn hoạt động')
           when 'USER' then coalesce(target_user.display_name, 'Tài khoản không còn hoạt động')
           else coalesce(target_list.target_label, 'Danh sách nhân viên') end as target_label,
         a.frequency, a.is_mandatory, a.effective_from, a.effective_to, a.state, a.version,
         a.created_at, a.updated_at,
         count(o.obligation_id)::integer as obligation_total,
         count(o.obligation_id) filter (where s.first_submitted_at is not null)::integer as submitted_count,
         count(o.obligation_id) filter (where o.obligation_status = 'ACTIVE' and s.submission_id is null)::integer as not_started_count,
         count(o.obligation_id) filter (where o.obligation_status = 'ACTIVE' and s.state = 'DRAFT')::integer as draft_count,
         count(o.obligation_id) filter (where o.obligation_status = 'EXEMPTED')::integer as exempted_count,
         count(o.obligation_id) filter (where o.obligation_status = 'CANCELLED')::integer as cancelled_count
        from public.work_report_assignments a
      join public.work_report_templates t on t.template_id = a.template_id
      left join public.teams team on team.team_id = a.target_team_id
      left join public.direct_entry_app_users target_user on target_user.app_user_id = a.target_user_id
      left join lateral (
        select string_agg(u.display_name, ', ' order by u.display_name, u.app_user_id) as target_label
          from public.work_report_assignment_targets x
          join public.direct_entry_app_users u on u.app_user_id = x.target_user_id
         where x.assignment_id = a.assignment_id
      ) target_list on true
      left join public.work_report_obligations o on o.assignment_id = a.assignment_id
      left join public.work_report_submissions s on s.obligation_id = o.obligation_id
     where (
       (a.target_kind = 'TEAM' and exists (
         select 1 from public.work_report__internal_resolve_capability_authority(
           p_app_user_id, 'report_assign', a.template_id, a.target_team_id
         )
       )) or
       (a.target_kind = 'USER' and exists (
         select 1 from public.work_report__internal_resolve_capability_authority(
           p_app_user_id, 'report_assign', a.template_id, public.work_report_current_team(a.target_user_id)
         )
       )) or
       (a.target_kind = 'USER_SET'
         and exists (select 1 from public.work_report_assignment_targets x where x.assignment_id = a.assignment_id)
         and not exists (
           select 1 from public.work_report_assignment_targets x
            where x.assignment_id = a.assignment_id
              and not exists (
                select 1 from public.work_report__internal_resolve_capability_authority(
                  p_app_user_id, 'report_assign', a.template_id, public.work_report_current_team(x.target_user_id)
                )
              )
         )
       )
     )
       and (p_team_id is null or
         (a.target_kind = 'TEAM' and a.target_team_id = p_team_id) or
         (a.target_kind = 'USER' and public.work_report_current_team(a.target_user_id) = p_team_id) or
         (a.target_kind = 'USER_SET' and exists (
           select 1 from public.work_report_assignment_targets x
            where x.assignment_id = a.assignment_id
              and public.work_report_current_team(x.target_user_id) = p_team_id
         ))
       )
     group by a.assignment_id, t.template_code, t.display_name, team.display_name, team.code,
       target_user.display_name, target_list.target_label
      ) tracked
  ), '[]'::jsonb));
end;
$function$;

revoke all on function public.work_report_list_assignment_options(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_list_assignments(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time, boolean, date, date, text)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_ensure_obligations_for_window(uuid, uuid, date)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_change_obligation_status(uuid, uuid, uuid, integer, text, text, timestamptz, text)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_get_submission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_save_draft(uuid, uuid, uuid, jsonb, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_submit(uuid, uuid, uuid, jsonb, integer, text)
  from public, anon, authenticated, service_role;

revoke all on function public.work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_get_review_submission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_decide_review(uuid, uuid, uuid, text, text, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_list_delegations(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_revoke_delegation(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;

revoke all on function public.work_report_analytics_overview(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_analytics_breakdown(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_analytics_contributions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, text, uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;

grant execute on function public.work_report_list_assignment_options(uuid, uuid, uuid) to service_role;
grant execute on function public.work_report_list_assignments(uuid, uuid, uuid) to service_role;
grant execute on function public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time, boolean, date, date, text) to service_role;
grant execute on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text) to service_role;
grant execute on function public.work_report_ensure_obligations_for_window(uuid, uuid, date) to service_role;
grant execute on function public.work_report_change_obligation_status(uuid, uuid, uuid, integer, text, text, timestamptz, text) to service_role;
grant execute on function public.work_report_get_submission(uuid, uuid, uuid) to service_role;
grant execute on function public.work_report_save_draft(uuid, uuid, uuid, jsonb, integer, text) to service_role;
grant execute on function public.work_report_submit(uuid, uuid, uuid, jsonb, integer, text) to service_role;

grant execute on function public.work_report_list_pending_reviews(uuid, uuid, uuid, text, integer) to service_role;
grant execute on function public.work_report_get_review_submission(uuid, uuid, uuid) to service_role;
grant execute on function public.work_report_decide_review(uuid, uuid, uuid, text, text, integer, text) to service_role;
grant execute on function public.work_report_list_delegations(uuid, uuid) to service_role;
grant execute on function public.work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamptz, timestamptz, text) to service_role;
grant execute on function public.work_report_revoke_delegation(uuid, uuid, uuid, integer, text) to service_role;

grant execute on function public.work_report_analytics_overview(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text) to service_role;
grant execute on function public.work_report_analytics_breakdown(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer, integer) to service_role;
grant execute on function public.work_report_analytics_contributions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, text, uuid, uuid, text, text, integer) to service_role;

commit;
