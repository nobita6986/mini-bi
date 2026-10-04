create table public.direct_entry_catalog_bootstrap_runs (
  run_id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.direct_entry_app_users(app_user_id) on delete restrict,
  source_fingerprint text not null check (source_fingerprint ~ '^[a-f0-9]{64}$'),
  project_count integer not null check (project_count >= 0),
  recruiter_count integer not null check (recruiter_count >= 0),
  team_count integer not null check (team_count >= 0),
  provider_membership_count integer not null check (provider_membership_count >= 0),
  status text not null check (status = 'APPLIED'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  reason_id uuid not null references public.direct_entry_restricted_reasons(reason_id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (app_user_id, idempotency_key)
);

alter table public.direct_entry_catalog_bootstrap_runs enable row level security;
alter table public.direct_entry_catalog_bootstrap_runs force row level security;
revoke all on table public.direct_entry_catalog_bootstrap_runs
  from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'direct_entry_catalog_bootstrap_executor') then
    create role direct_entry_catalog_bootstrap_executor
      nologin noinherit nobypassrls;
    perform set_config('mini_bi.catalog_bootstrap_executor_created', 'true', true);
  else
    perform set_config('mini_bi.catalog_bootstrap_executor_created', 'false', true);
  end if;
end
$$;

grant usage, create on schema public to direct_entry_catalog_bootstrap_executor;
grant select on public.daily_recruitment_breakdown, public.data_sources
  to direct_entry_catalog_bootstrap_executor;
grant select on public.direct_entry_app_users, public.direct_entry_capability_grants,
  public.direct_entry_projects, public.recruiters, public.teams, public.recruiter_aliases,
  public.recruiter_provider_memberships, public.recruiter_team_memberships,
  public.direct_entry_banks, public.direct_entry_catalog_bootstrap_runs
  to direct_entry_catalog_bootstrap_executor;
grant insert on public.direct_entry_projects, public.recruiters, public.teams,
  public.recruiter_aliases, public.recruiter_provider_memberships,
  public.recruiter_team_memberships, public.direct_entry_catalog_bootstrap_runs,
  public.direct_entry_audit_events
  to direct_entry_catalog_bootstrap_executor;

create policy direct_entry_catalog_bootstrap_source_scope
  on public.data_sources for select
  to direct_entry_catalog_bootstrap_executor
  using (active and not is_test);
create policy direct_entry_catalog_bootstrap_executor_scope
  on public.daily_recruitment_breakdown for select
  to direct_entry_catalog_bootstrap_executor
  using (exists (
    select 1 from public.data_sources s
     where s.id = daily_recruitment_breakdown.source_id
       and s.active and not s.is_test
  ));
create policy direct_entry_catalog_bootstrap_actor_read
  on public.direct_entry_app_users for select
  to direct_entry_catalog_bootstrap_executor
  using (app_user_id::text = current_setting('mini_bi.catalog_bootstrap_app_user_id', true));
create policy direct_entry_catalog_bootstrap_capability_read
  on public.direct_entry_capability_grants for select
  to direct_entry_catalog_bootstrap_executor
  using (app_user_id::text = current_setting('mini_bi.catalog_bootstrap_app_user_id', true));
create policy direct_entry_catalog_bootstrap_projects
  on public.direct_entry_projects for all
  to direct_entry_catalog_bootstrap_executor using (true) with check (true);
create policy direct_entry_catalog_bootstrap_recruiters
  on public.recruiters for all
  to direct_entry_catalog_bootstrap_executor using (true) with check (true);
create policy direct_entry_catalog_bootstrap_teams
  on public.teams for all
  to direct_entry_catalog_bootstrap_executor using (true) with check (true);
create policy direct_entry_catalog_bootstrap_aliases
  on public.recruiter_aliases for all
  to direct_entry_catalog_bootstrap_executor using (true) with check (true);
create policy direct_entry_catalog_bootstrap_provider_memberships
  on public.recruiter_provider_memberships for all
  to direct_entry_catalog_bootstrap_executor using (true) with check (true);
create policy direct_entry_catalog_bootstrap_team_memberships
  on public.recruiter_team_memberships for all
  to direct_entry_catalog_bootstrap_executor using (true) with check (true);
create policy direct_entry_catalog_bootstrap_banks_read
  on public.direct_entry_banks for select
  to direct_entry_catalog_bootstrap_executor using (true);
create policy direct_entry_catalog_bootstrap_runs
  on public.direct_entry_catalog_bootstrap_runs for all
  to direct_entry_catalog_bootstrap_executor
  using (app_user_id::text = current_setting('mini_bi.catalog_bootstrap_app_user_id', true))
  with check (app_user_id::text = current_setting('mini_bi.catalog_bootstrap_app_user_id', true));
create policy direct_entry_catalog_bootstrap_audit
  on public.direct_entry_audit_events for insert
  to direct_entry_catalog_bootstrap_executor
  with check (app_user_id::text = current_setting('mini_bi.catalog_bootstrap_app_user_id', true));

grant execute on function public.direct_entry_authorization_date()
  to direct_entry_catalog_bootstrap_executor;
grant execute on function public.direct_entry_reason(uuid, text)
  to direct_entry_catalog_bootstrap_executor;
grant execute on function public.recruitment_dimension_key(text),
  public.recruitment_dimension_display(text)
  to direct_entry_catalog_bootstrap_executor;

create or replace function public.direct_entry_catalog_bootstrap_projection()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with raw as materialized (
    select b.source_id, b.business_date, b.project_key, b.project_display,
           b.recruiter_key, b.recruiter_display, b.provider_type_key,
           b.provider_type_display, b.recruited_count
      from public.daily_recruitment_breakdown b
      join public.data_sources s on s.id = b.source_id
     where s.active and not s.is_test
  ), projects as (
    select distinct on (r.project_key)
           r.project_key as project_id, r.project_display as display_name
      from raw r
     order by r.project_key, r.business_date desc, r.project_display
  ), recruiters as (
    select distinct on (r.recruiter_key)
           r.recruiter_key, r.recruiter_display as display_name,
           min(r.business_date) over (partition by r.recruiter_key) as alias_from
      from raw r
     order by r.recruiter_key, r.business_date desc, r.recruiter_display
  ), provider_days as (
    select r.recruiter_key, r.business_date, min(r.provider_type_key) as provider_type
      from raw r
     where r.provider_type_key in ('hrp', 'vendor')
     group by r.recruiter_key, r.business_date
    having count(distinct r.provider_type_key) = 1
  ), provider_changes as (
    select recruiter_key, business_date as valid_from, provider_type
      from (
        select recruiter_key, business_date, provider_type,
               lag(provider_type) over (partition by recruiter_key order by business_date) as previous_type
          from provider_days
      ) d
     where previous_type is distinct from provider_type
  ), provider_periods as (
    select recruiter_key, provider_type, valid_from,
           lead(valid_from) over (partition by recruiter_key order by valid_from) as valid_to
      from provider_changes
  ), recruiter_projection as (
    select r.recruiter_key, r.display_name, r.alias_from,
           min(p.valid_from) as team_from,
           coalesce(jsonb_agg(jsonb_build_object(
             'provider_type', p.provider_type,
             'valid_from', p.valid_from,
             'valid_to', p.valid_to
           ) order by p.valid_from) filter (where p.valid_from is not null), '[]'::jsonb) as periods
      from recruiters r
      left join provider_periods p on p.recruiter_key = r.recruiter_key
     group by r.recruiter_key, r.display_name, r.alias_from
  ), source_rows as (
    select coalesce(jsonb_agg(jsonb_build_array(
      source_id, business_date, project_key, project_display,
      recruiter_key, recruiter_display, provider_type_key,
      provider_type_display, recruited_count
    ) order by source_id, business_date, project_key, recruiter_key,
       provider_type_key, provider_type_display, recruited_count), '[]'::jsonb) as rows
      from raw
  ), invalids as (
    select
      (select count(*)::integer from raw r
        where r.project_key <> public.recruitment_dimension_key(r.project_key)
           or r.project_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
           or r.project_key in ('__unknown__', '__invalid__')
           or r.recruiter_key <> public.recruitment_dimension_key(r.recruiter_key)
           or r.recruiter_key in ('__unknown__', '__invalid__')
           or r.project_display <> public.recruitment_dimension_display(r.project_display)
           or r.recruiter_display <> public.recruitment_dimension_display(r.recruiter_display)
           or length(btrim(r.project_display)) not between 1 and 256
           or length(btrim(r.recruiter_display)) not between 1 and 256
           or r.provider_type_key not in ('hrp', 'vendor')) +
      (select count(*)::integer from (
        select project_key, business_date
          from raw
         group by project_key, business_date
        having count(distinct project_display) > 1
      ) project_conflicts) +
      (select count(*)::integer from (
        select recruiter_key, business_date
          from raw
         group by recruiter_key, business_date
        having count(distinct recruiter_display) > 1
      ) recruiter_conflicts) +
      (select count(*)::integer from recruiters r
        where not exists (
          select 1 from provider_periods p where p.recruiter_key = r.recruiter_key
        )) as invalid_count,
      (select count(*)::integer from (
        select recruiter_key, business_date
          from raw
         where provider_type_key in ('hrp', 'vendor')
         group by recruiter_key, business_date
        having count(distinct provider_type_key) > 1
      ) provider_ambiguities) as ambiguous_count
  )
  select jsonb_build_object(
    'source_fingerprint',
      encode(sha256(convert_to(source_rows.rows::text, 'UTF8')), 'hex'),
    'project_count', (select count(*)::integer from projects),
    'recruiter_count', (select count(*)::integer from recruiter_projection),
    'provider_period_count',
      (select count(*)::integer from provider_periods),
    'invalid_count', invalids.invalid_count,
    'ambiguous_count', invalids.ambiguous_count,
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project_id', p.project_id, 'display_name', p.display_name
      ) order by p.project_id) from projects p
    ), '[]'::jsonb),
    'recruiters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reporting_key', r.recruiter_key,
        'display_name', r.display_name,
        'alias_from', r.alias_from,
        'team_from', r.team_from,
        'periods', r.periods
      ) order by r.recruiter_key) from recruiter_projection r
    ), '[]'::jsonb)
  )
    from source_rows, invalids;
$$;

create or replace function public.direct_entry_catalog_bootstrap_plan(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
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
$$;

create or replace function public.direct_entry_apply_catalog_bootstrap(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_source_fingerprint text,
  p_idempotency_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
     and g.valid_from <= public.direct_entry_authorization_date()
     and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to);
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

    insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from)
    values (v_recruiter_id, v_team_id, (v_item->>'team_from')::date);

    for v_period in select value from jsonb_array_elements(v_item->'periods') loop
      insert into public.recruiter_provider_memberships(
        recruiter_id, provider_type, valid_from, valid_to
      ) values (
        v_recruiter_id, v_period->>'provider_type',
        (v_period->>'valid_from')::date, (v_period->>'valid_to')::date
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
$$;

revoke all on function public.direct_entry_catalog_bootstrap_projection()
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_catalog_bootstrap_plan(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_apply_catalog_bootstrap(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_catalog_bootstrap_plan(uuid, uuid) to service_role;
grant execute on function public.direct_entry_apply_catalog_bootstrap(uuid, uuid, text, text, text)
  to service_role;

do $$
declare
  v_installer name := current_user;
  v_executor_created boolean :=
    current_setting('mini_bi.catalog_bootstrap_executor_created', true) = 'true';
  v_installer_member boolean;
  v_signature text;
  v_table text;
begin
  if v_installer in ('service_role', 'anon', 'authenticated',
                     'direct_entry_catalog_bootstrap_executor') then
    raise exception 'unauthorized catalog bootstrap migration installer'
      using errcode = '42501';
  end if;
  with recursive memberships(roleid) as (
    select m.roleid
      from pg_auth_members m
      join pg_roles member_role on member_role.oid = m.member
     where member_role.rolname = v_installer
    union
    select m.roleid
      from pg_auth_members m
      join memberships inherited on inherited.roleid = m.member
  )
  select exists (
    select 1 from memberships
     where roleid = 'direct_entry_catalog_bootstrap_executor'::regrole
  ) into v_installer_member;
  -- PostgreSQL 16+ can give a CREATEROLE user membership/admin option on a
  -- role it has just created. That membership belongs to this transaction
  -- and must be removed below. Membership on a pre-existing executor role is
  -- unexpected residue and remains a hard stop.
  if v_installer_member and not v_executor_created then
    raise exception 'migration installer already inherits catalog executor membership'
      using errcode = '42501';
  end if;

  execute format(
    'grant direct_entry_catalog_bootstrap_executor to %I',
    v_installer
  );
  begin
    execute 'alter function public.direct_entry_catalog_bootstrap_projection()'
      || ' owner to direct_entry_catalog_bootstrap_executor';
    execute 'alter function public.direct_entry_catalog_bootstrap_plan(uuid, uuid)'
      || ' owner to direct_entry_catalog_bootstrap_executor';
    execute 'alter function public.direct_entry_apply_catalog_bootstrap(uuid, uuid, text, text, text)'
      || ' owner to direct_entry_catalog_bootstrap_executor';
  exception when others then
    execute format(
      'revoke direct_entry_catalog_bootstrap_executor from %I',
      v_installer
    );
    raise;
  end;
  execute format(
    'revoke direct_entry_catalog_bootstrap_executor from %I',
    v_installer
  );
  revoke create on schema public from direct_entry_catalog_bootstrap_executor;

  if (select rolbypassrls or rolcanlogin from pg_roles
       where rolname = 'direct_entry_catalog_bootstrap_executor') then
    raise exception 'catalog bootstrap executor role must be NOLOGIN and NOBYPASSRLS';
  end if;
  if (select rolinherit from pg_roles
       where rolname = 'direct_entry_catalog_bootstrap_executor') then
    raise exception 'catalog bootstrap executor role must be NOINHERIT';
  end if;
  -- Supabase grants the creator an ADMIN link from supabase_admin when a role
  -- is created. The installer cannot revoke a grant owned by supabase_admin.
  -- Accept only that exact managed-service link, and only when this migration
  -- created the executor. Every runtime or unrelated membership remains a
  -- hard failure.
  if exists (
       select 1
         from pg_auth_members m
         join pg_roles target_role on target_role.oid = m.roleid
         join pg_roles member_role on member_role.oid = m.member
         join pg_roles grantor_role on grantor_role.oid = m.grantor
        where target_role.rolname = 'direct_entry_catalog_bootstrap_executor'
          and not (
            v_executor_created
            and member_role.rolname = v_installer
            and grantor_role.rolname = 'supabase_admin'
            and m.admin_option
          )
     )
     or pg_has_role('service_role', 'direct_entry_catalog_bootstrap_executor', 'member')
     or pg_has_role('anon', 'direct_entry_catalog_bootstrap_executor', 'member')
     or pg_has_role('authenticated', 'direct_entry_catalog_bootstrap_executor', 'member') then
    raise exception 'catalog executor membership residue';
  end if;
  if has_schema_privilege('direct_entry_catalog_bootstrap_executor', 'public', 'CREATE') then
    raise exception 'catalog executor must not retain CREATE on public schema';
  end if;
  if pg_has_role('service_role', 'direct_entry_catalog_bootstrap_executor', 'member') then
    raise exception 'service_role must not inherit the catalog executor role';
  end if;
  foreach v_table in array array[
    'direct_entry_catalog_bootstrap_runs', 'direct_entry_projects', 'recruiters', 'teams',
    'recruiter_aliases', 'recruiter_provider_memberships', 'recruiter_team_memberships',
    'direct_entry_audit_events'
  ] loop
    if has_table_privilege('service_role', 'public.' || v_table,
         'INSERT, UPDATE, DELETE, TRUNCATE')
       or has_table_privilege('anon', 'public.' || v_table,
         'INSERT, UPDATE, DELETE, TRUNCATE')
       or has_table_privilege('authenticated', 'public.' || v_table,
         'INSERT, UPDATE, DELETE, TRUNCATE') then
      raise exception 'catalog table DML must not be granted to API roles';
    end if;
  end loop;

  foreach v_signature in array array[
    'public.direct_entry_catalog_bootstrap_projection()',
    'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)',
    'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)'
  ] loop
    if not (select p.prosecdef
               and p.proconfig = array['search_path=pg_catalog, public']
               and pg_get_userbyid(p.proowner) = 'direct_entry_catalog_bootstrap_executor'
              from pg_proc p where p.oid = v_signature::regprocedure) then
      raise exception 'catalog bootstrap function security contract mismatch';
    end if;
  end loop;
  foreach v_signature in array array[
    'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)',
    'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)'
  ] loop
    if not has_function_privilege('service_role', v_signature::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_signature::regprocedure, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature::regprocedure, 'EXECUTE')
       or exists (
         select 1 from pg_proc p
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where p.oid = v_signature::regprocedure
            and a.grantee = 0 and a.privilege_type = 'EXECUTE'
       ) then
      raise exception 'catalog bootstrap RPC execute ACL mismatch';
    end if;
  end loop;
  if has_function_privilege('service_role',
       'public.direct_entry_catalog_bootstrap_projection()'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon',
       'public.direct_entry_catalog_bootstrap_projection()'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.direct_entry_catalog_bootstrap_projection()'::regprocedure, 'EXECUTE') then
    raise exception 'catalog bootstrap projection helper must not be API executable';
  end if;
end
$$;
