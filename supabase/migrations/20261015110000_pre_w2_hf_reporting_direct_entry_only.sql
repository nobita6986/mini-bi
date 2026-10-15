-- PRE-W2-HF reporting simplification.
-- The company reporting charts use submitted, non-deleted Direct Entry rows as
-- their canonical dataset. Historical first_work_date is valid business data;
-- it is not constrained by an app-launch/cutover date. Recruiter and provider
-- attribution comes from the stored Direct Entry row and current recruiter
-- display name, not date-effective alias/membership lookups.
--
-- This migration changes only reporting readers/projections. It does not
-- rewrite business rows or remove any table/helper used by other workflows.

create or replace function public.direct_entry_reporting_authorized_entries(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (entry_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audience jsonb := public.direct_entry_reporting_resolve_audience(
    p_auth_subject, p_app_user_id
  );
  v_kind text := v_audience->>'audience';
  v_team_ids uuid[];
  v_recruiter_id uuid;
begin
  if v_kind = 'all' then
    return query
      select e.entry_id
        from public.direct_entries e
        join public.direct_entry_submissions s on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null;
  elsif v_kind = 'team' then
    v_team_ids := array(
      select jsonb_array_elements_text(v_audience->'team_ids')::uuid
    );
    return query
      select e.entry_id
        from public.direct_entries e
        join public.direct_entry_submissions s on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.team_id = any(v_team_ids);
  else
    v_recruiter_id := (v_audience->>'recruiter_id')::uuid;
    if v_recruiter_id is null then
      return;
    end if;
    return query
      select e.entry_id
        from public.direct_entries e
        join public.direct_entry_submissions s on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.recruiter_id = v_recruiter_id;
  end if;
end;
$$;

comment on function public.direct_entry_reporting_authorized_entries(uuid, uuid) is
  'PRE-W2-HF: authorized submitted, non-deleted Direct Entry rows; no business-date cutoff.';
revoke all on function public.direct_entry_reporting_authorized_entries(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_authorized_entries(uuid, uuid)
  to service_role;

create or replace view public.direct_entry_reporting_facts_v01
as
select
    public.direct_entry_reporting_source_id()::text as source_id,
    e.first_work_date as business_date,
    public.direct_entry_reporting_dim_key(p.display_name) as project_key,
    p.display_name as project_display,
    public.direct_entry_reporting_dim_key(r.display_name) as recruiter_key,
    r.display_name as recruiter_display,
    e.provider_type as provider_type_key,
    case e.provider_type
      when 'hrp' then 'HRP'
      when 'vendor' then 'Vendor'
      else 'Không xác định'
    end as provider_type_display,
    public.direct_entry_reporting_employment_key(e.labor_type) as employment_type_key,
    public.direct_entry_reporting_employment_display(e.labor_type) as employment_type_display,
    1::integer as recruited_count,
    e.first_work_date as first_work_date,
    e.entry_id as entry_id,
    e.submission_id as submission_id,
    null::date as cutoff_date,
    t.team_id as team_id,
    t.code as team_code,
    t.display_name as team_display_name,
    t.active as team_active
  from public.direct_entries e
  join public.direct_entry_submissions s on s.submission_id = e.submission_id
  join public.direct_entry_projects p on p.project_id = e.project_id
  join public.recruiters r on r.recruiter_id = e.recruiter_id
  left join public.teams t on t.team_id = e.team_id
 where s.state = 'SUBMITTED'
   and e.deleted_at is null
 order by
   public.direct_entry_reporting_source_id()::text,
   e.first_work_date,
   public.direct_entry_reporting_dim_key(p.display_name),
   public.direct_entry_reporting_dim_key(r.display_name),
   e.provider_type,
   public.direct_entry_reporting_employment_key(e.labor_type),
   e.entry_id;

comment on view public.direct_entry_reporting_facts_v01 is
  'PRE-W2-HF Direct Entry reporting projection: one row per submitted, non-deleted entry; historical dates included; stored provider and recruiter display used. Service-role-only.';
revoke all on public.direct_entry_reporting_facts_v01 from public, anon, authenticated;
grant select on public.direct_entry_reporting_facts_v01 to service_role;

create or replace function public.direct_entry_reporting_scoped_facts(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_filters jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audience jsonb := public.direct_entry_reporting_resolve_audience(
    p_auth_subject, p_app_user_id
  );
  v_from date;
  v_to date;
  v_project text;
  v_recruiter text;
  v_provider text;
  v_employment text;
  v_facts jsonb;
begin
  v_from := nullif(p_filters->>'from', '')::date;
  v_to := nullif(p_filters->>'to', '')::date;
  v_project := nullif(p_filters->>'project', '');
  v_recruiter := nullif(p_filters->>'recruiter', '');
  v_provider := nullif(p_filters->>'provider', '');
  v_employment := nullif(p_filters->>'employment', '');

  select coalesce(jsonb_agg(jsonb_build_object(
           'source_id', f.source_id,
           'business_date', to_char(f.business_date, 'YYYY-MM-DD'),
           'project_key', f.project_key,
           'project_display', f.project_display,
           'recruiter_key', f.recruiter_key,
           'recruiter_display', f.recruiter_display,
           'provider_type_key', f.provider_type_key,
           'provider_type_display', f.provider_type_display,
           'employment_type_key', f.employment_type_key,
           'employment_type_display', f.employment_type_display,
           'recruited_count', f.recruited_count,
           'first_work_date', to_char(f.first_work_date, 'YYYY-MM-DD'),
           'entry_id', f.entry_id,
           'submission_id', f.submission_id,
           'cutoff_date', null,
           'team_id', f.team_id,
           'team_code', f.team_code,
           'team_display_name', f.team_display_name,
           'team_active', f.team_active
         ) order by f.business_date, f.project_key, f.recruiter_key,
                    f.provider_type_key, f.employment_type_key, f.entry_id), '[]'::jsonb)
    into v_facts
    from public.direct_entry_reporting_facts_v01 f
   where f.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
     and (v_from is null or f.business_date >= v_from)
     and (v_to is null or f.business_date <= v_to)
     and (v_project is null or f.project_key = v_project)
     and (v_recruiter is null or f.recruiter_key = v_recruiter)
     and (v_provider is null or f.provider_type_key = v_provider)
     and (v_employment is null or f.employment_type_key = v_employment);

  return jsonb_build_object(
    'audience', v_audience,
    'facts', v_facts,
    'sources', '[]'::jsonb,
    'latest_runs', '[]'::jsonb,
    'presence', '[]'::jsonb
  );
end;
$$;
comment on function public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb) is
  'PRE-W2-HF: DB-authorized Direct Entry facts only; no cutoff, legacy aggregate, or source metadata.';
revoke all on function public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)
  to service_role;

create or replace function public.direct_entry_reporting_de_options_scoped(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (
  dimension text,
  key text,
  display text,
  recruited_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with scoped as (
    select f.*
      from public.direct_entry_reporting_facts_v01 f
     where f.entry_id in (
       select ae.entry_id
         from public.direct_entry_reporting_authorized_entries(
           p_auth_subject, p_app_user_id
         ) ae
     )
  )
  select 'project'::text, f.project_key, f.project_display, count(*)::integer
    from scoped f
   group by f.project_key, f.project_display
  union all
  select 'recruiter'::text, f.recruiter_key, f.recruiter_display, count(*)::integer
    from scoped f
   group by f.recruiter_key, f.recruiter_display
  union all
  select 'provider'::text, f.provider_type_key, f.provider_type_display, count(*)::integer
    from scoped f
   group by f.provider_type_key, f.provider_type_display
  union all
  select 'employment'::text, f.employment_type_key, f.employment_type_display, count(*)::integer
    from scoped f
   group by f.employment_type_key, f.employment_type_display
$$;
revoke all on function public.direct_entry_reporting_de_options_scoped(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_de_options_scoped(uuid, uuid)
  to service_role;

create or replace function public.direct_entry_reporting_scoped_options(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audience jsonb := public.direct_entry_reporting_resolve_audience(
    p_auth_subject, p_app_user_id
  );
  v_dimensions jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'dimension', d.dimension,
           'key', d.key,
           'display', d.display,
           'recruited_count', d.recruited_count
         ) order by d.dimension, d.key, d.display), '[]'::jsonb)
    into v_dimensions
    from public.direct_entry_reporting_de_options_scoped(
      p_auth_subject, p_app_user_id
    ) d;

  return jsonb_build_object(
    'audience', v_audience,
    'dimensions', v_dimensions,
    'sources', '[]'::jsonb
  );
end;
$$;
comment on function public.direct_entry_reporting_scoped_options(uuid, uuid) is
  'PRE-W2-HF: actor-scoped Direct Entry dimensions only; no external source or legacy options.';
revoke all on function public.direct_entry_reporting_scoped_options(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_scoped_options(uuid, uuid)
  to service_role;

-- The drill-down keeps its established response envelope and row pagination;
-- its former external aggregate is now always null.
do $patch$
declare
  v_signature constant text :=
    'public.direct_entry_reporting_team_drill_down(uuid,uuid,text,jsonb,text,integer)';
  v_definition text;
  v_start integer;
  v_end_relative integer;
  v_end integer;
  v_old text;
begin
  select pg_get_functiondef(v_signature::regprocedure) into v_definition;
  v_start := position($start$  if p_bucket_key = 'unknown' then
    select coalesce(sum(b.recruited_count), 0)::bigint,$start$ in v_definition);
  if v_definition is null or v_start = 0 then
    raise exception 'team drill-down legacy block not found';
  end if;

  v_end_relative := position('  end if;' in substring(v_definition from v_start));
  if v_end_relative = 0 then
    raise exception 'team drill-down legacy block terminator not found';
  end if;
  v_end := v_start + v_end_relative + length('  end if;') - 1;
  v_old := substring(v_definition from v_start for v_end - v_start + 1);
  if length(v_old) - length(replace(v_old, 'daily_recruitment_breakdown', '')) = 0 then
    raise exception 'team drill-down legacy block did not match expected body';
  end if;

  v_definition := replace(v_definition, v_old, '  v_legacy := null;');
  execute v_definition;
end;
$patch$;

do $$
declare
  v_view text;
  v_facts text;
  v_options text;
  v_drill text;
begin
  select pg_get_viewdef('public.direct_entry_reporting_facts_v01'::regclass, true)
    into v_view;
  if v_view ilike '%direct_entry_reporting_cutoff%'
     or v_view ilike '%recruiter_alias_key%'
     or v_view ilike '%recruiter_provider_key%' then
    raise exception 'Direct Entry projection still depends on cutoff or date-effective identities';
  end if;

  select pg_get_functiondef('public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)'::regprocedure)
    into v_facts;
  select pg_get_functiondef('public.direct_entry_reporting_scoped_options(uuid,uuid)'::regprocedure)
    into v_options;
  select pg_get_functiondef('public.direct_entry_reporting_team_drill_down(uuid,uuid,text,jsonb,text,integer)'::regprocedure)
    into v_drill;
  if v_facts ilike '%daily_recruitment_breakdown%'
     or v_facts ilike '%data_sources%'
     or v_options ilike '%reporting_dimension_options_v01%'
     or v_options ilike '%data_sources%'
     or v_drill ilike '%daily_recruitment_breakdown%'
     or v_drill ilike '%direct_entry_reporting_cutoff%' then
    raise exception 'Live reporting reader still depends on external aggregates or cutoff';
  end if;

  if has_function_privilege('anon', 'public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.direct_entry_reporting_scoped_options(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_reporting_scoped_options(uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.direct_entry_reporting_scoped_options(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.direct_entry_reporting_team_drill_down(uuid,uuid,text,jsonb,text,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_reporting_team_drill_down(uuid,uuid,text,jsonb,text,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.direct_entry_reporting_team_drill_down(uuid,uuid,text,jsonb,text,integer)', 'EXECUTE') then
    raise exception 'Reporting RPC ACL drifted';
  end if;
end;
$$;
