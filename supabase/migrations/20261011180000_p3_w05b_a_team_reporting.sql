-- =============================================================================
-- P3-W05B-A - Team reporting backend/API (#85, append-only).
-- Patches the live W04A/W05A definitions in place; never re-emits them.
-- =============================================================================

begin;

create function public.direct_entry_w05b_replace_proc_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_definition text;
  v_count integer;
begin
  select pg_get_functiondef(p_signature) into v_definition;
  if v_definition is null or p_expected is null or p_expected = '' then
    raise exception 'W05B function source missing' using errcode = '55000';
  end if;
  v_count := (length(v_definition) - length(replace(v_definition, p_expected, '')))
    / length(p_expected);
  if v_count <> p_expected_count then
    raise exception 'W05B function source drift for %: expected %, found %',
      p_signature, p_expected_count, v_count using errcode = '55000';
  end if;
  execute replace(v_definition, p_expected, p_replacement);
end;
$$;
revoke all on function public.direct_entry_w05b_replace_proc_source(regprocedure, text, text, integer)
  from public, anon, authenticated, service_role;

create function public.direct_entry_w05b_replace_view_source(
  p_view regclass,
  p_expected text,
  p_replacement text,
  p_expected_count integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_definition text;
  v_count integer;
  v_target text;
begin
  select quote_ident(n.nspname) || '.' || quote_ident(c.relname)
    into v_target
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_view;
  if v_target is null then
    raise exception 'W05B view missing' using errcode = '55000';
  end if;
  select pg_get_viewdef(p_view, true) into v_definition;
  if v_definition is null or p_expected is null or p_expected = '' then
    raise exception 'W05B view source missing' using errcode = '55000';
  end if;
  v_count := (length(v_definition) - length(replace(v_definition, p_expected, '')))
    / length(p_expected);
  if v_count <> p_expected_count then
    raise exception 'W05B view source drift for %: expected %, found %',
      p_view, p_expected_count, v_count using errcode = '55000';
  end if;
  execute 'create or replace view ' || v_target || ' as '
    || replace(v_definition, p_expected, p_replacement);
end;
$$;
revoke all on function public.direct_entry_w05b_replace_view_source(regclass, text, text, integer)
  from public, anon, authenticated, service_role;

select public.direct_entry_w05b_replace_view_source(
  'public.direct_entry_reporting_facts_v01'::regclass,
  'JOIN recruiters r ON r.recruiter_id = e.recruiter_id',
  'JOIN recruiters r ON r.recruiter_id = e.recruiter_id
     LEFT JOIN public.teams t ON t.team_id = e.team_id',
  1
);

select public.direct_entry_w05b_replace_view_source(
  'public.direct_entry_reporting_facts_v01'::regclass,
  '    direct_entry_reporting_cutoff() AS cutoff_date',
  '    direct_entry_reporting_cutoff() AS cutoff_date,
    t.team_id AS team_id,
    t.code AS team_code,
    t.display_name AS team_display_name,
    t.active AS team_active',
  1
);

select public.direct_entry_w05b_replace_proc_source(
  'public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)'::regprocedure,
  $$          'cutoff_date', to_char(f.cutoff_date, 'YYYY-MM-DD')$$,
  $$          'cutoff_date', to_char(f.cutoff_date, 'YYYY-MM-DD'),
          'team_id', f.team_id,
          'team_code', f.team_code,
          'team_display_name', f.team_display_name,
          'team_active', f.team_active$$,
  1
);

select public.direct_entry_w05b_replace_proc_source(
  'public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)'::regprocedure,
  $$          'cutoff_date', to_char(public.direct_entry_reporting_cutoff(), 'YYYY-MM-DD')$$,
  $$          'cutoff_date', to_char(public.direct_entry_reporting_cutoff(), 'YYYY-MM-DD'),
          'team_id', null,
          'team_code', null,
          'team_display_name', null,
          'team_active', null$$,
  1
);

drop function public.direct_entry_w05b_replace_proc_source(regprocedure, text, text, integer);
drop function public.direct_entry_w05b_replace_view_source(regclass, text, text, integer);

create function public.direct_entry_reporting_team_drill_down(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bucket_key text,
  p_filters jsonb,
  p_cursor text,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audience jsonb;
  v_kind text;
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from date;
  v_to date;
  v_project text;
  v_recruiter text;
  v_provider text;
  v_employment text;
  v_team_code text;
  v_bucket_display text;
  v_team_active boolean;
  v_team_id uuid;
  v_limit integer := coalesce(p_limit, 25);
  v_cursor jsonb;
  v_cursor_recruiter text;
  v_cursor_date date;
  v_cursor_entry_id uuid;
  v_rows jsonb;
  v_total bigint;
  v_has_more boolean;
  v_last_recruiter text;
  v_last_date date;
  v_last_entry_id uuid;
  v_legacy_total bigint;
  v_legacy_from date;
  v_legacy_to date;
  v_legacy jsonb;
  v_token text;
  v_decoded text;
  v_padding integer;
begin
  if p_bucket_key is null or p_bucket_key = '' then
    raise exception 'bucket_key is required' using errcode = '22023';
  end if;
  if v_limit < 1 or v_limit > 100 then
    raise exception 'limit is invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'filters must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_object_keys(v_filters) k
     where k not in ('from', 'to', 'project', 'recruiter', 'provider', 'employment')
  ) then
    raise exception 'drill-down filter is not allowlisted' using errcode = '22023';
  end if;

  v_from := nullif(v_filters->>'from', '')::date;
  v_to := nullif(v_filters->>'to', '')::date;
  if v_from is not null and v_to is not null and v_from > v_to then
    raise exception 'from must not be greater than to' using errcode = '22023';
  end if;
  v_project := nullif(v_filters->>'project', '');
  v_recruiter := nullif(v_filters->>'recruiter', '');
  v_provider := nullif(v_filters->>'provider', '');
  v_employment := nullif(v_filters->>'employment', '');

  if p_cursor is not null then
    if p_cursor = '' or p_cursor !~ '^[A-Za-z0-9_-]+$' then
      raise exception 'cursor is invalid' using errcode = '22023';
    end if;
    v_token := replace(replace(p_cursor, '-', '+'), '_', '/');
    v_padding := (4 - (length(v_token) % 4)) % 4;
    begin
      v_decoded := convert_from(decode(v_token || repeat('=', v_padding), 'base64'), 'UTF8');
      v_cursor := v_decoded::jsonb;
    exception when others then
      raise exception 'cursor is invalid' using errcode = '22023';
    end;
    if jsonb_typeof(v_cursor) <> 'object'
       or (select count(*) from jsonb_object_keys(v_cursor)) <> 3
       or not (v_cursor ? 'recruiter_display')
       or not (v_cursor ? 'business_date')
       or not (v_cursor ? 'entry_id') then
      raise exception 'cursor is invalid' using errcode = '22023';
    end if;
    begin
      v_cursor_recruiter := v_cursor->>'recruiter_display';
      v_cursor_date := (v_cursor->>'business_date')::date;
      v_cursor_entry_id := (v_cursor->>'entry_id')::uuid;
    exception when others then
      raise exception 'cursor is invalid' using errcode = '22023';
    end;
    if v_cursor_recruiter is null or v_cursor_recruiter = '' then
      raise exception 'cursor is invalid' using errcode = '22023';
    end if;
  end if;

  v_audience := public.direct_entry_reporting_resolve_audience(
    p_auth_subject, p_app_user_id
  );
  v_kind := v_audience->>'audience';
  if v_kind <> 'all' then
    raise exception 'team drill-down requires all audience' using errcode = '42501';
  end if;

  if p_bucket_key = 'unknown' then
    v_bucket_display := 'Không xác định';
  elsif p_bucket_key = '__unknown__' or p_bucket_key !~ '^team\.[A-Za-z0-9_-]+$'
     or length(p_bucket_key) < 7 or length(p_bucket_key) > 688 then
    raise exception 'bucket_key is invalid' using errcode = '22023';
  else
    v_token := substring(p_bucket_key from 6);
    v_padding := (4 - (length(v_token) % 4)) % 4;
    begin
      v_decoded := convert_from(
        decode(replace(replace(v_token, '-', '+'), '_', '/') || repeat('=', v_padding), 'base64'),
        'UTF8'
      );
    exception when others then
      raise exception 'bucket_key is invalid' using errcode = '22023';
    end;
    if length(btrim(v_decoded)) not between 1 and 128
       or v_decoded <> btrim(v_decoded)
       or v_decoded ~ '[[:space:][:cntrl:]]'
       or rtrim(replace(replace(regexp_replace(encode(convert_to(v_decoded, 'UTF8'), 'base64'), '\s', '', 'g'), '+', '-'), '/', '_'), '=') <> v_token then
      raise exception 'bucket_key is invalid' using errcode = '22023';
    end if;
    select t.team_id, t.display_name, t.active, t.code
      into v_team_id, v_bucket_display, v_team_active, v_team_code
      from public.teams t
     where t.code = v_decoded;
    if not found then
      raise exception 'bucket_key is invalid' using errcode = '22023';
    end if;
    if not v_team_active then
      v_bucket_display := v_bucket_display || ' (Đã ngừng hoạt động)';
    end if;
  end if;

  with base_filtered as (
    select f.*
      from public.direct_entry_reporting_facts_v01 f
     where (
       (p_bucket_key = 'unknown' and (f.team_id is null or f.team_code is null))
       or (p_bucket_key <> 'unknown' and f.team_code = v_team_code)
     )
       and (v_from is null or f.business_date >= v_from)
       and (v_to is null or f.business_date <= v_to)
       and (v_project is null or f.project_key = v_project)
       and (v_recruiter is null or f.recruiter_key = v_recruiter)
       and (v_provider is null or f.provider_type_key = v_provider)
       and (v_employment is null or f.employment_type_key = v_employment)
  ), filtered as (
    select f.*
      from base_filtered f
     where p_cursor is null
        or f.recruiter_display > v_cursor_recruiter
        or (f.recruiter_display = v_cursor_recruiter and f.business_date < v_cursor_date)
        or (f.recruiter_display = v_cursor_recruiter and f.business_date = v_cursor_date
            and f.entry_id > v_cursor_entry_id)
  ), ordered as (
    select f.*,
           row_number() over (
             order by f.recruiter_display asc, f.business_date desc, f.entry_id asc
           ) as row_number
      from filtered f
  ), page as (
    select * from ordered where row_number <= v_limit
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'business_date', to_char(p.business_date, 'YYYY-MM-DD'),
      'project_display', p.project_display,
      'recruiter_display', p.recruiter_display,
      'provider_type_display', p.provider_type_display,
      'employment_type_display', p.employment_type_display,
      'recruited_count', p.recruited_count,
      'first_work_date', to_char(p.first_work_date, 'YYYY-MM-DD')
    ) order by p.row_number) from page p), '[]'::jsonb),
    (select count(*) from base_filtered),
    exists (select 1 from ordered where row_number > v_limit),
    (select p.recruiter_display from page p order by p.row_number desc limit 1),
    (select p.business_date from page p order by p.row_number desc limit 1),
    (select p.entry_id from page p order by p.row_number desc limit 1)
    into v_rows, v_total, v_has_more, v_last_recruiter, v_last_date, v_last_entry_id;

  if p_bucket_key = 'unknown' then
    select coalesce(sum(b.recruited_count), 0)::bigint,
           min(b.business_date), max(b.business_date)
      into v_legacy_total, v_legacy_from, v_legacy_to
      from public.daily_recruitment_breakdown b
      join public.data_sources ds on ds.id = b.source_id
     where ds.active
       and not ds.is_test
       and b.business_date < public.direct_entry_reporting_cutoff()
       and (v_from is null or b.business_date >= v_from)
       and (v_to is null or b.business_date <= v_to)
       and (v_project is null or b.project_key = v_project)
       and (v_recruiter is null or b.recruiter_key = v_recruiter)
       and (v_provider is null or b.provider_type_key = v_provider)
       and (v_employment is null or b.employment_type_key = v_employment);
    v_legacy := jsonb_build_object(
      'recruited_count', v_legacy_total,
      'from', to_char(v_legacy_from, 'YYYY-MM-DD'),
      'to', to_char(v_legacy_to, 'YYYY-MM-DD'),
      'cutover_date', to_char(public.direct_entry_reporting_cutoff(), 'YYYY-MM-DD')
    );
  else
    v_legacy := null;
  end if;

  return jsonb_build_object(
    'bucket', jsonb_build_object('key', p_bucket_key, 'display', v_bucket_display),
    'rows', v_rows,
    'nextCursor', case when v_has_more then
      rtrim(replace(replace(regexp_replace(encode(convert_to(jsonb_build_object(
        'recruiter_display', v_last_recruiter,
        'business_date', to_char(v_last_date, 'YYYY-MM-DD'),
        'entry_id', v_last_entry_id
      )::text, 'UTF8'), 'base64'), '\s', '', 'g'), '+', '-'), '/', '_'), '=')
      else null end,
    'total', v_total,
    'applied', jsonb_build_object(
      'from', v_filters->>'from', 'to', v_filters->>'to',
      'project', v_filters->>'project', 'recruiter', v_filters->>'recruiter',
      'provider', v_filters->>'provider', 'employment', v_filters->>'employment'
    ),
    'legacy_aggregate_total', v_legacy
  );
end;
$$;
revoke all on function public.direct_entry_reporting_team_drill_down(uuid, uuid, text, jsonb, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_reporting_team_drill_down(uuid, uuid, text, jsonb, text, integer)
  to service_role;
comment on function public.direct_entry_reporting_team_drill_down(uuid, uuid, text, jsonb, text, integer) is
  'P3-W05B-A: Full cross-team reporting drill-down with DB audience re-check, opaque cursor, exact sanitized rows and unknown-panel aggregate split.';

do $$
declare
  v_columns text;
  v_definition text;
  v_count integer;
  v_signature text := 'public.direct_entry_reporting_team_drill_down(uuid,uuid,text,jsonb,text,integer)';
  v_key text;
begin
  select array_to_string(array_agg(attname order by attnum), ',')
    into v_columns
    from pg_attribute
   where attrelid = 'public.direct_entry_reporting_facts_v01'::regclass
     and attnum > 0
     and not attisdropped;
  if v_columns <> 'source_id,business_date,project_key,project_display,recruiter_key,recruiter_display,provider_type_key,provider_type_display,employment_type_key,employment_type_display,recruited_count,first_work_date,entry_id,submission_id,cutoff_date,team_id,team_code,team_display_name,team_active' then
    raise exception 'W05B facts view column layout drifted: %', v_columns using errcode = '55000';
  end if;

  select pg_get_viewdef('public.direct_entry_reporting_facts_v01'::regclass, true)
    into v_definition;
  if v_definition not like '%direct_entry_reporting_employment_display%'
     or lower(v_definition) like '%case e.labor_type%' then
    raise exception 'W05B facts view lost W02C employment display patch' using errcode = '55000';
  end if;

  select pg_get_functiondef('public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)'::regprocedure)
    into v_definition;
  foreach v_key in array array[
    'team_id', 'team_code', 'team_display_name', 'team_active',
    'source_id', 'business_date', 'cutoff_date'
  ] loop
    if v_definition not like '%' || v_key || '%' then
      raise exception 'W05B scoped-facts body lost key %', v_key using errcode = '55000';
    end if;
  end loop;

  select count(*)::int into v_count
    from pg_proc p
   where p.oid = 'public.direct_entry_reporting_team_drill_down(uuid,uuid,text,jsonb,text,integer)'::regprocedure
     and p.prosecdef
     and 'search_path=pg_catalog, public' = any(p.proconfig);
  if v_count <> 1 then
    raise exception 'W05B drill-down function security posture drifted' using errcode = '55000';
  end if;
  if not has_function_privilege('service_role', v_signature, 'EXECUTE') then
    raise exception 'W05B drill-down is not executable by service_role' using errcode = '55000';
  end if;
  if has_function_privilege('public', v_signature, 'EXECUTE')
     or has_function_privilege('anon', v_signature, 'EXECUTE')
     or has_function_privilege('authenticated', v_signature, 'EXECUTE') then
    raise exception 'W05B drill-down is exposed to a browser role' using errcode = '55000';
  end if;

  select pg_get_viewdef('public.reporting_dimension_options_v01'::regclass, true)
    into v_definition;
  if lower(v_definition) like '%''team''%' then
    raise exception 'legacy reporting options gained a team dimension' using errcode = '55000';
  end if;
  select pg_get_viewdef('public.direct_entry_reporting_dimension_options_v01'::regclass, true)
    into v_definition;
  if lower(v_definition) like '%''team''%' then
    raise exception 'Direct Entry reporting options gained a team dimension' using errcode = '55000';
  end if;

  if has_table_privilege('anon', 'public.direct_entry_reporting_facts_v01', 'SELECT')
     or has_table_privilege('authenticated', 'public.direct_entry_reporting_facts_v01', 'SELECT')
     or not has_table_privilege('service_role', 'public.direct_entry_reporting_facts_v01', 'SELECT') then
    raise exception 'W05B facts view ACL drifted' using errcode = '55000';
  end if;
end;
$$;

commit;
