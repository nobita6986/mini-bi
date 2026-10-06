-- P3-W07B — Project manager assignment and Direct Entry project scope.
-- Projects remain provider/team agnostic. This table only controls which
-- project an authenticated Direct Entry actor may select/write.

begin;

create table public.direct_entry_project_manager_assignments (
  project_id text primary key
    references public.direct_entry_projects(project_id) on delete restrict,
  manager_recruiter_id uuid not null
    references public.recruiters(recruiter_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index direct_entry_project_manager_assignments_manager_idx
  on public.direct_entry_project_manager_assignments(manager_recruiter_id, project_id);

alter table public.direct_entry_project_manager_assignments enable row level security;
alter table public.direct_entry_project_manager_assignments force row level security;
revoke all on table public.direct_entry_project_manager_assignments
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_project_manager_assignments is
  'Current project-to-HRP-manager assignment. Runtime access is fail-closed and exposed only through service-role SECURITY DEFINER RPCs.';

create or replace function public.direct_entry_actor_can_access_project(
  p_app_user_id uuid,
  p_project_id text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    exists (
      select 1
        from public.direct_entry_capability_grants c
        join public.direct_entry_scope_grants s
          on s.app_user_id = c.app_user_id
         and s.scope_kind = 'all'
         and s.valid_from <= public.direct_entry_authorization_date()
         and (s.valid_to is null or public.direct_entry_authorization_date() < s.valid_to)
       where c.app_user_id = p_app_user_id
         and c.capability = 'entry_admin'
         and c.valid_from <= public.direct_entry_authorization_date()
         and (c.valid_to is null or public.direct_entry_authorization_date() < c.valid_to)
    )
    or exists (
      select 1
        from public.direct_entry_project_manager_assignments a
        join public.direct_entry_app_user_recruiter_links l
          on l.recruiter_id = a.manager_recruiter_id
         and l.app_user_id = p_app_user_id
         and l.verified
         and l.valid_from <= public.direct_entry_authorization_date()
         and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
       where a.project_id = p_project_id
    );
$$;

revoke all on function public.direct_entry_actor_can_access_project(uuid, text)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_actor_can_access_project(uuid, text) is
  'Fail-closed project access: entry_admin+all bypass, otherwise a verified current app-user/recruiter link must match the assigned project manager.';

-- Preserve the exact catalog payload from migration #42, then filter only
-- its projects array. Recruiters and banks remain byte-for-byte compatible.
alter function public.direct_entry_input_catalog(uuid, uuid, date)
  rename to direct_entry_input_catalog_unscoped_v42;
revoke all on function public.direct_entry_input_catalog_unscoped_v42(uuid, uuid, date)
  from public, anon, authenticated, service_role;

create function public.direct_entry_input_catalog(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_effective_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_catalog jsonb;
  v_projects jsonb;
begin
  v_catalog := public.direct_entry_input_catalog_unscoped_v42(
    p_auth_subject, p_app_user_id, p_effective_date
  );

  select coalesce(jsonb_agg(project order by project->>'display_name', project->>'project_id'), '[]'::jsonb)
    into v_projects
    from jsonb_array_elements(v_catalog->'projects') as project
   where public.direct_entry_actor_can_access_project(
     p_app_user_id, project->>'project_id'
   );

  return jsonb_set(v_catalog, '{projects}', v_projects, false);
end;
$$;

revoke all on function public.direct_entry_input_catalog(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_input_catalog(uuid, uuid, date)
  to service_role;

comment on function public.direct_entry_input_catalog(uuid, uuid, date) is
  'P3-W07B: migration #42 catalog contract with projects filtered by current manager assignment; entry_admin+all sees every active project.';

-- The currently deployed spreadsheet save path uses the v2 full-profile RPC.
-- Older batch/draft HTTP handlers already load this filtered catalog before
-- invoking their service-role RPC, so their established DB contracts remain
-- unchanged. The v2 wrapper below is the authoritative write-side guard for
-- the live UI and prevents a forged project_id from bypassing the catalog.
alter function public.direct_entry_create_full_profile_batch_v2(uuid, uuid, text, jsonb, text)
  rename to direct_entry_create_full_profile_batch_v2_unscoped_h03;
revoke all on function public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid, uuid, text, jsonb, text)
  from public, anon, authenticated, service_role;

create function public.direct_entry_create_full_profile_batch_v2(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_contract_version text,
  p_rows jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row jsonb;
begin
  if jsonb_typeof(p_rows) = 'array' then
    for v_row in select value from jsonb_array_elements(p_rows) loop
      if not public.direct_entry_actor_can_access_project(p_app_user_id, v_row->>'project_id') then
        raise exception 'PROJECT_SCOPE_DENIED' using errcode = '42501';
      end if;
    end loop;
  end if;
  return public.direct_entry_create_full_profile_batch_v2_unscoped_h03(
    p_auth_subject, p_app_user_id, p_contract_version, p_rows, p_idempotency_key
  );
end;
$$;
revoke all on function public.direct_entry_create_full_profile_batch_v2(uuid, uuid, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_full_profile_batch_v2(uuid, uuid, text, jsonb, text)
  to service_role;

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'direct_entry_project_manager_assignments'
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'project manager assignment RLS self-check failed';
  end if;
  if has_table_privilege('service_role',
      'public.direct_entry_project_manager_assignments', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'project manager assignment ACL self-check failed';
  end if;
  if not has_function_privilege('service_role',
      'public.direct_entry_input_catalog(uuid,uuid,date)', 'EXECUTE')
     or not has_function_privilege('service_role',
      'public.direct_entry_create_full_profile_batch_v2(uuid,uuid,text,jsonb,text)', 'EXECUTE')
     or has_function_privilege('authenticated',
      'public.direct_entry_actor_can_access_project(uuid,text)', 'EXECUTE') then
    raise exception 'project scope RPC ACL self-check failed';
  end if;
end;
$$;

commit;
