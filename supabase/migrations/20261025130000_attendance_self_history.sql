begin;

-- Self-service history for signed-in employees. The API supplies the actor pair
-- from the verified server session; clients never choose an employee_id.
create or replace function public.attendance_self_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_from_date date default null,
  p_to_date date default null,
  p_page integer default 1,
  p_page_size integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_to_date date := coalesce(p_to_date, v_today);
  v_from_date date := coalesce(p_from_date, coalesce(p_to_date, v_today) - 89);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 100);
  v_total_rows integer := 0;
  v_total_pages integer := 1;
  v_items jsonb := '[]'::jsonb;
begin
  if p_auth_subject is null or p_app_user_id is null or not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) then
    raise exception 'ATTENDANCE_ACTOR_DENIED' using errcode = '42501';
  end if;

  if v_from_date in ('infinity'::date, '-infinity'::date)
     or v_to_date in ('infinity'::date, '-infinity'::date)
     or v_from_date > v_to_date
     or (v_to_date - v_from_date) > 366 then
    raise exception 'ATTENDANCE_REPORT_RANGE_INVALID' using errcode = '22023';
  end if;

  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'ATTENDANCE_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  select count(*)::integer
    into v_total_rows
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.business_date between v_from_date and v_to_date;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'checkin_id', p.checkin_id,
               'employee_display_name', p.employee_display_name,
               'business_date', p.business_date,
               'sequence_in_day', p.sequence_in_day,
               'captured_at', p.captured_at,
               'received_at', p.received_at,
               'time_source', p.time_source,
               'latitude', p.latitude,
               'longitude', p.longitude,
               'accuracy_meters', p.accuracy_meters,
               'address_hint', p.address_hint,
               'note', p.note
             ) order by p.raw_captured_at desc, p.checkin_id desc
           ),
           '[]'::jsonb
         )
    into v_items
    from (
      select c.checkin_id,
             u.display_name as employee_display_name,
             c.business_date::text as business_date,
             c.sequence_in_day,
             pg_catalog.to_char(c.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at,
             pg_catalog.to_char(c.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as received_at,
             c.captured_at as raw_captured_at,
             c.time_source,
             c.latitude,
             c.longitude,
             c.accuracy_meters,
             c.address_hint,
             c.note
        from public.attendance_checkins c
        join public.direct_entry_app_users u
          on u.app_user_id = c.app_user_id
       where c.app_user_id = p_app_user_id
         and c.business_date between v_from_date and v_to_date
       order by c.captured_at desc, c.checkin_id desc
       offset ((v_page - 1) * v_page_size)
       limit v_page_size
    ) p;

  v_total_pages := greatest(
    1,
    pg_catalog.ceil(v_total_rows::numeric / v_page_size::numeric)::integer
  );

  return jsonb_build_object(
    'items', v_items,
    'pagination', jsonb_build_object(
      'page', v_page,
      'page_size', v_page_size,
      'total_rows', v_total_rows,
      'total_pages', v_total_pages,
      'has_more', (v_page * v_page_size) < v_total_rows
    )
  );
end;
$function$;

comment on function public.attendance_self_history(uuid, uuid, date, date, integer, integer) is
  'Service-role-only read of check-in history scoped in SQL to the verified actor app_user_id. It returns no employee selector, other-user identifiers, or private R2 key.';

create or replace function public.attendance_self_checkin_photo(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_checkin_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_storage_key text;
begin
  if p_auth_subject is null or p_app_user_id is null or not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) then
    raise exception 'ATTENDANCE_ACTOR_DENIED' using errcode = '42501';
  end if;

  if p_checkin_id is null then
    raise exception 'ATTENDANCE_REPORT_QUERY_INVALID' using errcode = '22023';
  end if;

  select c.photo_storage_key
    into v_storage_key
    from public.attendance_checkins c
   where c.checkin_id = p_checkin_id
     and c.app_user_id = p_app_user_id;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object('found', true, 'photo_storage_key', v_storage_key);
end;
$function$;

comment on function public.attendance_self_checkin_photo(uuid, uuid, uuid) is
  'Service-role-only resolver for a private R2 check-in photo owned by the verified actor; other users appear not found.';

do $align_attendance_self_history_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_proc_owner_oid oid;
  v_sig text;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  foreach v_sig in array array[
    'public.attendance_self_history(uuid,uuid,date,date,integer,integer)',
    'public.attendance_self_checkin_photo(uuid,uuid,uuid)'
  ]
  loop
    select p.proowner into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_sig);

    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;
end;
$align_attendance_self_history_owners$;

revoke all on function public.attendance_self_history(uuid, uuid, date, date, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_self_history(uuid, uuid, date, date, integer, integer)
  to service_role;

revoke all on function public.attendance_self_checkin_photo(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_self_checkin_photo(uuid, uuid, uuid)
  to service_role;

do $check_attendance_self_history$
declare
  v_signature text;
  v_oid pg_catalog.regprocedure;
  v_secdef boolean;
  v_config text;
  v_volatility "char";
  v_owner_bypasses_rls boolean;
begin
  foreach v_signature in array array[
    'public.attendance_self_history(uuid,uuid,date,date,integer,integer)',
    'public.attendance_self_checkin_photo(uuid,uuid,uuid)'
  ]
  loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    select p.prosecdef, coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           p.provolatile, (r.rolsuper or r.rolbypassrls)
      into v_secdef, v_config, v_volatility, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or v_volatility <> 's'::"char"
       or not coalesce(v_owner_bypasses_rls, false)
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_oid),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_oid))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'Attendance self-service RPC security boundary drift on %', v_signature
        using errcode = '55000';
    end if;
  end loop;
end;
$check_attendance_self_history$;

commit;
