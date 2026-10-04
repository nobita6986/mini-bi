begin;

create table public.direct_entry_employee_code_counters (
  employee_year integer primary key check (employee_year between 1900 and 9999),
  last_sequence integer not null check (last_sequence between 0 and 999999)
);

insert into public.direct_entry_employee_code_counters (employee_year, last_sequence)
select substring(employee_code from 5 for 4)::integer,
       max(substring(employee_code from 10 for 6)::integer)
  from public.direct_entries
 where employee_code ~ '^hrp-[0-9]{4}-[0-9]{6}$'
 group by substring(employee_code from 5 for 4);

alter table public.direct_entry_employee_code_counters enable row level security;
alter table public.direct_entry_employee_code_counters force row level security;
revoke all on table public.direct_entry_employee_code_counters
  from public, anon, authenticated, service_role;

comment on table public.direct_entry_employee_code_counters is
  'Internal transactional counters. Access only through direct_entry_create_full_profile_batch_v2.';

create or replace function public.direct_entry_create_full_profile_batch_v2(
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
  v_rows jsonb := '[]'::jsonb;
  v_codes text[] := '{}';
  v_year integer;
  v_sequence integer;
  v_counter_year integer;
  v_provider_type text;
  v_recruiter_id uuid;
  v_membership_count integer;
  v_prior jsonb;
  v_hash text;
  v_inner_key text;
  v_result jsonb;
begin
  if p_contract_version is distinct from 'worker-profile/1.1' then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 then
    raise exception 'BATCH_INVALID' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row - array[
         'project_id','first_work_date','provider_type','recruiter_id','labor_type',
         'display_name','worker_details','general_note','payment','employment'
       ] <> '{}'::jsonb
       or v_row->>'provider_type' not in ('hrp','vendor')
       or coalesce(v_row->>'first_work_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or coalesce(v_row->>'recruiter_id','') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    begin
      v_year := substring(v_row->>'first_work_date' from 1 for 4)::integer;
      if to_char((v_row->>'first_work_date')::date, 'YYYY-MM-DD') <>
         v_row->>'first_work_date' then
        raise exception 'invalid date';
      end if;
    exception when others then
      raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
    end;
  end loop;

  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'entry_create');
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'submission_create');

  v_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'contract_version', p_contract_version, 'rows', p_rows
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'full_profile_batch_create_v2', p_idempotency_key, v_hash
  );
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  v_inner_key :=
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 1 for 8) || '-' ||
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 9 for 4) || '-4' ||
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 14 for 3) || '-8' ||
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 18 for 3) || '-' ||
    substring(md5(p_idempotency_key || ':worker-profile/1.1') from 21 for 12);

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_year := substring(v_row->>'first_work_date' from 1 for 4)::integer;
    v_recruiter_id := (v_row->>'recruiter_id')::uuid;
    v_provider_type := v_row->>'provider_type';
    select count(*)::integer
      into v_membership_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and m.provider_type = v_provider_type
       and m.valid_from <= (v_row->>'first_work_date')::date
       and (m.valid_to is null or (v_row->>'first_work_date')::date < m.valid_to);
    if v_membership_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;

    insert into public.direct_entry_employee_code_counters (employee_year, last_sequence)
      values (v_year, 0)
      on conflict (employee_year) do nothing;
    update public.direct_entry_employee_code_counters
       set last_sequence = last_sequence + 1
     where employee_year = v_year
       and last_sequence < 999999
     returning last_sequence into v_sequence;
    if not found then
      raise exception 'EMPLOYEE_CODE_SEQUENCE_EXHAUSTED' using errcode = '22023';
    end if;
    v_counter_year := v_year;
    v_codes := array_append(v_codes,
      'hrp-' || v_counter_year::text || '-' || lpad(v_sequence::text, 6, '0'));
    v_rows := v_rows || jsonb_build_array(
      (v_row - 'provider_type') || jsonb_build_object('employee_code', v_codes[array_length(v_codes, 1)])
    );
  end loop;

  v_result := public.direct_entry_create_full_profile_batch(
    p_auth_subject,
    p_app_user_id,
    'worker-profile/1.0',
    v_rows,
    v_inner_key
  );
  v_result := v_result || jsonb_build_object(
    'employee_codes', to_jsonb(v_codes),
    'replayed', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'full_profile_batch_create_v2', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.direct_entry_create_full_profile_batch_v2(uuid,uuid,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_full_profile_batch_v2(uuid,uuid,text,jsonb,text)
  to service_role;

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'direct_entry_employee_code_counters'
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'employee-code counter RLS self-check failed';
  end if;
  if has_table_privilege('service_role',
      'public.direct_entry_employee_code_counters', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'employee-code counter table ACL self-check failed';
  end if;
  if not has_function_privilege('service_role',
      'public.direct_entry_create_full_profile_batch_v2(uuid,uuid,text,jsonb,text)', 'EXECUTE')
     or has_function_privilege('anon',
      'public.direct_entry_create_full_profile_batch_v2(uuid,uuid,text,jsonb,text)', 'EXECUTE')
     or has_function_privilege('authenticated',
      'public.direct_entry_create_full_profile_batch_v2(uuid,uuid,text,jsonb,text)', 'EXECUTE')
     or has_function_privilege('public',
      'public.direct_entry_create_full_profile_batch_v2(uuid,uuid,text,jsonb,text)', 'EXECUTE') then
    raise exception 'employee-code RPC ACL self-check failed';
  end if;
end;
$$;

commit;
