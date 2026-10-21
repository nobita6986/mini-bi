-- F1 Work Reports — WP1 Closeout Review Fixes (forward-only after #131).
-- Preserves 20261021160000_f1_work_reports_foundation.sql checksum on TEST.

begin;

create or replace function public.work_report_valid_template_schema(p_schema jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_section jsonb;
  v_field jsonb;
  v_option jsonb;
  v_section_keys text[] := array[]::text[];
  v_field_keys text[] := array[]::text[];
  v_option_keys text[];
  v_type text;
  v_validation jsonb;
begin
  if jsonb_typeof(p_schema) <> 'object'
     or p_schema ->> 'version' <> 'work-report-schema/1.0'
     or jsonb_typeof(p_schema -> 'sections') <> 'array'
     or jsonb_array_length(p_schema -> 'sections') = 0
     or (p_schema - array['version', 'sections']) <> '{}'::jsonb then
    return false;
  end if;

  for v_section in select value from jsonb_array_elements(p_schema -> 'sections') loop
    if jsonb_typeof(v_section) <> 'object'
       or (v_section - array['section_key','label','description','sort_order','fields']) <> '{}'::jsonb
       or coalesce(v_section ->> 'section_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
       or length(btrim(coalesce(v_section ->> 'label', ''))) not between 1 and 256
       or not (v_section ? 'description')
       or not (
         jsonb_typeof(v_section -> 'description') = 'null'
         or (jsonb_typeof(v_section -> 'description') = 'string' and length(v_section ->> 'description') <= 2000)
       )
       or jsonb_typeof(v_section -> 'sort_order') <> 'number'
       or (v_section ->> 'sort_order')::numeric < 0
       or (v_section ->> 'sort_order')::numeric <> trunc((v_section ->> 'sort_order')::numeric)
       or jsonb_typeof(v_section -> 'fields') <> 'array'
       or jsonb_array_length(v_section -> 'fields') = 0
       or (v_section ->> 'section_key') = any(v_section_keys) then
      return false;
    end if;
    v_section_keys := array_append(v_section_keys, v_section ->> 'section_key');

    for v_field in select value from jsonb_array_elements(v_section -> 'fields') loop
      v_type := v_field ->> 'field_type';
      v_validation := v_field -> 'validation';
      if jsonb_typeof(v_field) <> 'object'
         or (v_field - array['field_key','section_key','sort_order','label','description','field_type','required','default_value','validation','options','is_metric','metric_spec','is_dimension']) <> '{}'::jsonb
         or not (v_field ? 'default_value')
         or coalesce(v_field ->> 'field_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
         or v_field ->> 'section_key' <> v_section ->> 'section_key'
         or (v_field ->> 'field_key') = any(v_field_keys)
         or v_type not in ('text','textarea','integer','decimal','date','boolean','single_select','multi_select')
         or length(btrim(coalesce(v_field ->> 'label', ''))) not between 1 and 256
         or not (v_field ? 'description')
         or not (
           jsonb_typeof(v_field -> 'description') = 'null'
           or (jsonb_typeof(v_field -> 'description') = 'string' and length(v_field ->> 'description') <= 2000)
         )
         or jsonb_typeof(v_field -> 'sort_order') <> 'number'
         or (v_field ->> 'sort_order')::numeric < 0
         or (v_field ->> 'sort_order')::numeric <> trunc((v_field ->> 'sort_order')::numeric)
         or jsonb_typeof(v_field -> 'required') <> 'boolean'
         or jsonb_typeof(v_field -> 'is_metric') <> 'boolean'
         or jsonb_typeof(v_field -> 'is_dimension') <> 'boolean'
         or jsonb_typeof(v_validation) <> 'object'
         or (
           (v_field ->> 'is_metric')::boolean and jsonb_typeof(v_field -> 'metric_spec') <> 'object'
         )
         or (
           not (v_field ->> 'is_metric')::boolean and jsonb_typeof(v_field -> 'metric_spec') <> 'null'
         ) then
        return false;
      end if;
      v_field_keys := array_append(v_field_keys, v_field ->> 'field_key');

      if v_type = 'text' then
        if (v_validation - array['min_length','max_length','pattern_preset']) <> '{}'::jsonb
           or jsonb_typeof(v_validation -> 'min_length') <> 'number'
           or (v_validation ->> 'min_length')::numeric <> trunc((v_validation ->> 'min_length')::numeric)
           or (v_validation ->> 'min_length')::int < 0
           or jsonb_typeof(v_validation -> 'max_length') <> 'number'
           or (v_validation ->> 'max_length')::numeric <> trunc((v_validation ->> 'max_length')::numeric)
           or (v_validation ->> 'max_length')::int not between 1 and 500
           or (v_validation ->> 'min_length')::int > (v_validation ->> 'max_length')::int
           or coalesce(v_validation ->> 'pattern_preset', '') not in ('none','code','phone','email') then
          return false;
        end if;
      elsif v_type = 'textarea' then
        if (v_validation - array['min_length','max_length']) <> '{}'::jsonb
           or jsonb_typeof(v_validation -> 'min_length') <> 'number'
           or (v_validation ->> 'min_length')::numeric <> trunc((v_validation ->> 'min_length')::numeric)
           or (v_validation ->> 'min_length')::int < 0
           or jsonb_typeof(v_validation -> 'max_length') <> 'number'
           or (v_validation ->> 'max_length')::numeric <> trunc((v_validation ->> 'max_length')::numeric)
           or (v_validation ->> 'max_length')::int not between 1 and 4000
           or (v_validation ->> 'min_length')::int > (v_validation ->> 'max_length')::int then
          return false;
        end if;
      elsif v_type = 'integer' then
        if (v_validation - array['min_value','max_value','allow_zero']) <> '{}'::jsonb
           or jsonb_typeof(v_validation -> 'min_value') <> 'number'
           or jsonb_typeof(v_validation -> 'max_value') <> 'number'
           or (v_validation ->> 'min_value')::numeric <> trunc((v_validation ->> 'min_value')::numeric)
           or (v_validation ->> 'max_value')::numeric <> trunc((v_validation ->> 'max_value')::numeric)
           or (v_validation ->> 'min_value')::numeric > (v_validation ->> 'max_value')::numeric
           or jsonb_typeof(v_validation -> 'allow_zero') <> 'boolean' then
          return false;
        end if;
      elsif v_type = 'decimal' then
        if (v_validation - array['min_value','max_value','decimal_places','allow_zero']) <> '{}'::jsonb
           or jsonb_typeof(v_validation -> 'min_value') <> 'number'
           or jsonb_typeof(v_validation -> 'max_value') <> 'number'
           or (v_validation ->> 'min_value')::numeric > (v_validation ->> 'max_value')::numeric
           or jsonb_typeof(v_validation -> 'decimal_places') <> 'number'
           or (v_validation ->> 'decimal_places')::numeric <> trunc((v_validation ->> 'decimal_places')::numeric)
           or (v_validation ->> 'decimal_places')::int not between 1 and 4
           or jsonb_typeof(v_validation -> 'allow_zero') <> 'boolean' then
          return false;
        end if;
      elsif v_type = 'date' then
        if (v_validation - array['min_date_rule']) <> '{}'::jsonb
           or coalesce(v_validation ->> 'min_date_rule', '') not in ('any','within_period','not_future') then
          return false;
        end if;
      elsif v_type in ('boolean','single_select') then
        if v_validation <> '{}'::jsonb then
          return false;
        end if;
      elsif v_type = 'multi_select' then
        if (v_validation - array['min_selected','max_selected']) <> '{}'::jsonb
           or jsonb_typeof(v_validation -> 'min_selected') <> 'number'
           or (v_validation ->> 'min_selected')::numeric <> trunc((v_validation ->> 'min_selected')::numeric)
           or (v_validation ->> 'min_selected')::int < 0
           or jsonb_typeof(v_validation -> 'max_selected') <> 'number'
           or (v_validation ->> 'max_selected')::numeric <> trunc((v_validation ->> 'max_selected')::numeric)
           or (v_validation ->> 'max_selected')::int < 1
           or (v_validation ->> 'min_selected')::int > (v_validation ->> 'max_selected')::int then
          return false;
        end if;
      end if;

      if v_type in ('single_select','multi_select') then
        if jsonb_typeof(v_field -> 'options') <> 'array'
           or jsonb_array_length(v_field -> 'options') not between 1 and 50 then
          return false;
        end if;
        v_option_keys := array[]::text[];
        for v_option in select value from jsonb_array_elements(v_field -> 'options') loop
          if jsonb_typeof(v_option) <> 'object'
             or (v_option - array['option_key','label','active','sort_order']) <> '{}'::jsonb
             or coalesce(v_option ->> 'option_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
             or (v_option ->> 'option_key') = any(v_option_keys)
             or length(btrim(coalesce(v_option ->> 'label', ''))) not between 1 and 256
             or jsonb_typeof(v_option -> 'active') <> 'boolean'
             or jsonb_typeof(v_option -> 'sort_order') <> 'number'
             or (v_option ->> 'sort_order')::numeric < 0
             or (v_option ->> 'sort_order')::numeric <> trunc((v_option ->> 'sort_order')::numeric) then
            return false;
          end if;
          v_option_keys := array_append(v_option_keys, v_option ->> 'option_key');
        end loop;
      elsif jsonb_typeof(v_field -> 'options') <> 'null' then
        return false;
      end if;
    end loop;
  end loop;
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function public.work_report_valid_metric_contract(p_schema jsonb, p_contract jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_metric jsonb;
  v_agg_text text;
  v_type text;
  v_field_keys text[] := array[]::text[];
  v_metric_keys text[] := array[]::text[];
  v_match_count integer;
begin
  if not public.work_report_valid_template_schema(p_schema)
     or jsonb_typeof(p_contract) <> 'object'
     or p_contract ->> 'version' <> 'work-report-metrics/1.0'
     or jsonb_typeof(p_contract -> 'metrics') <> 'array'
     or (p_contract - array['version','metrics']) <> '{}'::jsonb then
    return false;
  end if;

  if jsonb_array_length(p_contract -> 'metrics') <> (
    select count(*) from jsonb_array_elements(p_schema -> 'sections') s,
      jsonb_array_elements(s -> 'fields') f where (f ->> 'is_metric')::boolean
  ) then
    return false;
  end if;

  for v_metric in select value from jsonb_array_elements(p_contract -> 'metrics') loop
    v_type := v_metric ->> 'field_type';
    if jsonb_typeof(v_metric) <> 'object'
       or (v_metric - array['field_key','field_type','metric_key','unit','aggregations','null_policy','zero_policy','compatible_group']) <> '{}'::jsonb
       or coalesce(v_metric ->> 'field_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
       or coalesce(v_metric ->> 'metric_key', '') !~ '^[a-z][a-z0-9_]{1,63}$'
       or coalesce(v_metric ->> 'compatible_group', '') !~ '^[a-z][a-z0-9_]{1,63}$'
       or jsonb_typeof(v_metric -> 'unit') <> 'string'
       or length(btrim(coalesce(v_metric ->> 'unit', ''))) < 1
       or length(coalesce(v_metric ->> 'unit', '')) > 64
       or coalesce(v_metric ->> 'null_policy', '') not in ('EXCLUDE_FROM_AVG','INCLUDE_AS_ZERO')
       or coalesce(v_metric ->> 'zero_policy', '') not in ('INCLUDE_AS_ZERO','EXCLUDE')
       or jsonb_typeof(v_metric -> 'aggregations') <> 'array'
       or jsonb_array_length(v_metric -> 'aggregations') = 0
       or v_metric ->> 'field_key' = any(v_field_keys)
       or v_metric ->> 'metric_key' = any(v_metric_keys) then
      return false;
    end if;

    select count(*) into v_match_count
      from jsonb_array_elements(p_schema -> 'sections') s,
           jsonb_array_elements(s -> 'fields') f
     where f ->> 'field_key' = v_metric ->> 'field_key'
       and (f ->> 'is_metric')::boolean
       and f ->> 'field_type' = v_type
       and jsonb_typeof(f -> 'metric_spec') = 'object'
       and ((f -> 'metric_spec') - array['metric_key','unit','aggregations','null_policy','zero_policy','compatible_group']) = '{}'::jsonb
       and (f -> 'metric_spec' ->> 'metric_key') = (v_metric ->> 'metric_key')
       and (f -> 'metric_spec' ->> 'unit') = (v_metric ->> 'unit')
       and (f -> 'metric_spec' ->> 'null_policy') = (v_metric ->> 'null_policy')
       and (f -> 'metric_spec' ->> 'zero_policy') = (v_metric ->> 'zero_policy')
       and (f -> 'metric_spec' ->> 'compatible_group') = (v_metric ->> 'compatible_group')
       and jsonb_typeof(f -> 'metric_spec' -> 'aggregations') = 'array'
       and (
         select array_agg(a order by a)
           from jsonb_array_elements_text(f -> 'metric_spec' -> 'aggregations') a
       ) = (
         select array_agg(b order by b)
           from jsonb_array_elements_text(v_metric -> 'aggregations') b
       );
    if v_match_count <> 1 then
      return false;
    end if;

    for v_agg_text in select value from jsonb_array_elements_text(v_metric -> 'aggregations') loop
      if v_type in ('integer','decimal') then
        if v_agg_text not in ('SUM','AVG','MIN','MAX','COUNT_VALID') then return false; end if;
      elsif v_type = 'boolean' then
        if v_agg_text not in ('TRUE_COUNT','TRUE_RATE','COUNT_VALID') then return false; end if;
      elsif v_type in ('single_select','multi_select') then
        if v_agg_text not in ('COUNT_BY_OPTION','COUNT_VALID') then return false; end if;
      elsif v_type in ('text','textarea','date') then
        if v_agg_text not in ('COUNT_VALID') then return false; end if;
      else
        return false;
      end if;
    end loop;

    v_field_keys := array_append(v_field_keys, v_metric ->> 'field_key');
    v_metric_keys := array_append(v_metric_keys, v_metric ->> 'metric_key');
  end loop;
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function public.work_report_valid_submission_payload(
  p_schema jsonb,
  p_payload jsonb,
  p_period_start date,
  p_period_end date,
  p_require_required boolean default true
)
returns boolean
language plpgsql
stable
set search_path = pg_catalog
as $function$
declare
  v_field jsonb;
  v_key text;
  v_type text;
  v_value jsonb;
  v_rule jsonb;
  v_text text;
  v_preset text;
  v_date date;
begin
  if not public.work_report_valid_template_schema(p_schema) or jsonb_typeof(p_payload) <> 'object' then
    return false;
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_payload) k
     where not exists (
       select 1 from jsonb_array_elements(p_schema -> 'sections') s,
         jsonb_array_elements(s -> 'fields') f where f ->> 'field_key' = k
     )
  ) then
    return false;
  end if;

  for v_field in select f from jsonb_array_elements(p_schema -> 'sections') s,
    jsonb_array_elements(s -> 'fields') f loop
    v_key := v_field ->> 'field_key';
    v_type := v_field ->> 'field_type';
    v_rule := v_field -> 'validation';

    if not (p_payload ? v_key)
       or jsonb_typeof(p_payload -> v_key) = 'null'
       or (jsonb_typeof(p_payload -> v_key) = 'string' and (p_payload ->> v_key) = '') then
      if p_require_required and (v_field ->> 'required')::boolean then
        return false;
      end if;
      continue;
    end if;

    v_value := p_payload -> v_key;
    if v_type in ('text','textarea') then
      if jsonb_typeof(v_value) <> 'string' then
        return false;
      end if;
      v_text := v_value #>> '{}';
      if length(v_text) < coalesce((v_rule ->> 'min_length')::int, 0)
         or length(v_text) > coalesce((v_rule ->> 'max_length')::int, case when v_type = 'text' then 500 else 4000 end) then
        return false;
      end if;
      if v_type = 'text' then
        v_preset := coalesce(v_rule ->> 'pattern_preset', 'none');
        if v_preset = 'code' and v_text !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' then
          return false;
        elsif v_preset = 'phone' and v_text !~ '^\+?[0-9][0-9 .()-]{5,30}$' then
          return false;
        elsif v_preset = 'email' and v_text !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
          return false;
        end if;
      end if;
    elsif v_type in ('integer','decimal') then
      if jsonb_typeof(v_value) <> 'number'
         or (v_type = 'integer' and (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric))
         or (v_type = 'decimal' and scale(trim_scale((v_value #>> '{}')::numeric)) > (v_rule ->> 'decimal_places')::int)
         or (v_value #>> '{}')::numeric < (v_rule ->> 'min_value')::numeric
         or (v_value #>> '{}')::numeric > (v_rule ->> 'max_value')::numeric
         or (not (v_rule ->> 'allow_zero')::boolean and (v_value #>> '{}')::numeric = 0) then
        return false;
      end if;
    elsif v_type = 'boolean' then
      if jsonb_typeof(v_value) <> 'boolean' then
        return false;
      end if;
    elsif v_type = 'date' then
      if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
        return false;
      end if;
      v_date := (v_value #>> '{}')::date;
      if to_char(v_date, 'YYYY-MM-DD') <> (v_value #>> '{}') then
        return false;
      end if;
      if v_rule ->> 'min_date_rule' = 'within_period'
         and (p_period_start is null or p_period_end is null or v_date < p_period_start or v_date > p_period_end) then
        return false;
      end if;
      if v_rule ->> 'min_date_rule' = 'not_future'
         and v_date > (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then
        return false;
      end if;
    elsif v_type = 'single_select' then
      if jsonb_typeof(v_value) <> 'string' or not exists (
        select 1 from jsonb_array_elements(v_field -> 'options') o
         where (o ->> 'active')::boolean and o ->> 'option_key' = v_value #>> '{}'
      ) then
        return false;
      end if;
    elsif v_type = 'multi_select' then
      if jsonb_typeof(v_value) <> 'array'
         or jsonb_array_length(v_value) < coalesce((v_rule ->> 'min_selected')::int, 0)
         or jsonb_array_length(v_value) > coalesce((v_rule ->> 'max_selected')::int, 50)
         or exists (select 1 from jsonb_array_elements(v_value) elem where jsonb_typeof(elem) <> 'string')
         or (select count(*) from jsonb_array_elements_text(v_value)) <>
            (select count(distinct x) from jsonb_array_elements_text(v_value) x)
         or exists (
           select 1 from jsonb_array_elements_text(v_value) x
            where not exists (
              select 1 from jsonb_array_elements(v_field -> 'options') o
               where (o ->> 'active')::boolean and o ->> 'option_key' = x
            )
         ) then
        return false;
      end if;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$function$;

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
    foreach v_capability in array array['report_view','report_analytics_view','report_assign'] loop
      if not exists (
        select 1 from public.direct_entry_capability_grants g
         where g.app_user_id = new.leader_app_user_id
           and g.capability = v_capability
           and g.is_current
      ) then
        -- Any previously disabled (not is_current) row whose valid_to was left NULL
        -- by account/team/recruiter disable must have its open-ended metadata interval
        -- bounded before inserting a new leader grant, without resurrecting it or
        -- attaching an independent grant to work_report_team_leader_capability_grants.
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

        -- Never resurrect or overwrite a closed independent grant whose finite
        -- [valid_from, valid_to) interval overlaps daterange(new.valid_from, null, '[)').
        -- Instead, start the new leader-owned grant metadata interval at the end of
        -- any overlapping closed interval so direct_entry_capability_grant_no_overlap
        -- is satisfied while the closed independent grant remains intact.
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

revoke all on function public.work_report_valid_template_schema(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_valid_metric_contract(jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_valid_submission_payload(jsonb, jsonb, date, date, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report_sync_team_leader_capabilities()
  from public, anon, authenticated, service_role;

commit;
