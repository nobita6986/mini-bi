-- Require OFFICIAL employment_status when previewing or applying leave opening balances.
begin;

create or replace function public.leave_management_preview_opening_batch(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_leave_year integer,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_item jsonb;
  v_idx integer := 0;
  v_target_id_text text;
  v_target_id uuid;
  v_carry_units integer;
  v_open_units integer;
  v_sen_units integer;
  v_note text;
  v_seen_ids uuid[] := array[]::uuid[];
  v_account jsonb;
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean;
  v_row_errors jsonb;
  v_preview_rows jsonb := '[]'::jsonb;
  v_error_count integer := 0;
  v_total_carry integer := 0;
  v_total_open integer := 0;
  v_total_sen integer := 0;
  v_has_carry_expiry_error boolean := false;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_year < 2020 or v_year > 2100 then
    raise exception 'LEAVE_YEAR_INVALID'
      using errcode = '22023';
  end if;

  if p_rows is null
     or pg_catalog.jsonb_typeof(p_rows) <> 'array'
     or pg_catalog.jsonb_array_length(p_rows) < 1
     or pg_catalog.jsonb_array_length(p_rows) > 300 then
    raise exception 'LEAVE_OPENING_ROWS_INVALID'
      using errcode = '22023';
  end if;

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  for v_item in
    select value
      from pg_catalog.jsonb_array_elements(p_rows)
  loop
    v_idx := v_idx + 1;
    v_row_errors := '[]'::jsonb;
    v_target_id := null;
    v_account := null;

    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ROW_NOT_OBJECT');
    else
      v_target_id_text := pg_catalog.btrim(coalesce(v_item->>'app_user_id', ''));
      begin
        v_target_id := v_target_id_text::uuid;
      exception
        when others then
          v_target_id := null;
      end;

      begin
        v_carry_units := coalesce((v_item->>'carry_over_units')::integer, 0);
        v_open_units := coalesce((v_item->>'opening_current_year_units')::integer, 0);
        v_sen_units := coalesce((v_item->>'seniority_units')::integer, 0);
      exception
        when others then
          v_carry_units := -1;
          v_open_units := -1;
          v_sen_units := -1;
      end;

      v_note := nullif(pg_catalog.btrim(coalesce(v_item->>'note', '')), '');

      if v_target_id is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('INVALID_APP_USER_ID');
      else
        if v_target_id = any(v_seen_ids) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('DUPLICATE_APP_USER_IN_BATCH');
        else
          v_seen_ids := pg_catalog.array_append(v_seen_ids, v_target_id);
        end if;

        v_account := public.leave_management__internal_account_summary(v_target_id);
        if v_account is null then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('APP_USER_NOT_FOUND');
        end if;

        select p.*
          into v_profile
          from public.leave_employee_profiles p
         where p.app_user_id = v_target_id;
        v_has_profile := found;

        if v_has_profile and v_profile.is_shared_non_employee then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('SHARED_ACCOUNT_NOT_ELIGIBLE');
        elsif v_account is not null and (not v_has_profile or v_profile.employment_status <> 'OFFICIAL') then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('EMPLOYEE_NOT_OFFICIAL');
        end if;
      end if;

      if v_carry_units < 0 or v_carry_units > 120
         or v_open_units < 0 or v_open_units > 120
         or v_sen_units < 0 or v_sen_units > 60 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('UNITS_OUT_OF_RANGE');
      elsif (v_carry_units + v_open_units + v_sen_units) <= 0 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ZERO_UNITS_ROW');
      end if;

      if v_carry_units > 0 and v_carry_over_expiry is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED');
        v_has_carry_expiry_error := true;
      end if;

      if v_target_id is not null and v_carry_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'CARRY_OVER'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('CARRY_OVER_LOT_ALREADY_EXISTS');
        end if;
      end if;

      if v_target_id is not null and v_open_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'OPENING_CURRENT_YEAR'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('OPENING_CURRENT_YEAR_LOT_ALREADY_EXISTS');
        end if;
      end if;
    end if;

    if pg_catalog.jsonb_array_length(v_row_errors) > 0 then
      v_error_count := v_error_count + 1;
    else
      v_total_carry := v_total_carry + v_carry_units;
      v_total_open := v_total_open + v_open_units;
      v_total_sen := v_total_sen + v_sen_units;
    end if;

    v_preview_rows := v_preview_rows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'row_index', v_idx,
        'app_user_id', v_target_id,
        'account', v_account,
        'carry_over_units', greatest(coalesce(v_carry_units, 0), 0),
        'opening_current_year_units', greatest(coalesce(v_open_units, 0), 0),
        'seniority_units', greatest(coalesce(v_sen_units, 0), 0),
        'note', v_note,
        'valid', (pg_catalog.jsonb_array_length(v_row_errors) = 0),
        'errors', v_row_errors
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'leave_year', v_year,
    'carry_over_expires_after_date', v_carry_over_expiry,
    'valid', (v_error_count = 0),
    'has_carry_over_expiry_error', v_has_carry_expiry_error,
    'row_count', v_idx,
    'error_row_count', v_error_count,
    'total_carry_over_units', v_total_carry,
    'total_opening_current_year_units', v_total_open,
    'total_seniority_units', v_total_sen,
    'rows', v_preview_rows
  );
end;
$function$;

revoke all on function public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb) to service_role;

commit;
