begin;

-- New workers are active by default. This migration changes creation semantics
-- only; existing employment history, including legacy UNCONFIRMED rows, is left
-- untouched.

create function public.direct_entry_w06_replace_proc_source(
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
    raise exception 'status-default source missing' using errcode = '55000';
  end if;
  v_count := (length(v_definition) - length(replace(v_definition, p_expected, '')))
    / length(p_expected);
  if v_count <> p_expected_count then
    raise exception 'status-default source drift for %: expected %, found %',
      p_signature, p_expected_count, v_count using errcode = '55000';
  end if;
  execute replace(v_definition, p_expected, p_replacement);
end;
$$;

select public.direct_entry_w06_replace_proc_source(
  'public.direct_entry_validate_status_event()'::regprocedure,
  'if new.status <> ''UNCONFIRMED'' or new.version <> 1',
  'if new.status not in (''UNCONFIRMED'',''ON'') or new.version <> 1',
  1
);

select public.direct_entry_w06_replace_proc_source(
  'public.direct_entry_create_batch(uuid,uuid,jsonb,text)'::regprocedure,
  'v_entry_id, ''UNCONFIRMED'', v_first_work_date, 1, p_app_user_id, v_reason_id',
  'v_entry_id, ''ON'', v_first_work_date, 1, p_app_user_id, v_reason_id',
  1
);

select public.direct_entry_w06_replace_proc_source(
  'public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure,
  'v_entry_id, ''UNCONFIRMED'', v_first_work_date, 1, p_app_user_id, v_reason_id',
  'v_entry_id, ''ON'', v_first_work_date, 1, p_app_user_id, v_reason_id',
  1
);

select public.direct_entry_w06_replace_proc_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  'v_entry_id, ''UNCONFIRMED'', v_first_work_date, 1, p_app_user_id, v_reason_id',
  'v_entry_id, ''ON'', v_first_work_date, 1, p_app_user_id, v_reason_id',
  1
);

-- An explicitly supplied OFF state remains a second historical event. ON and
-- omitted/legacy UNCONFIRMED input both resolve to the new ON-at-entry default.
select public.direct_entry_w06_replace_proc_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  'if v_status in (''ON'',''OFF'') then',
  'if v_status = ''OFF'' then',
  1
);

drop function public.direct_entry_w06_replace_proc_source(regprocedure,text,text,integer);

comment on function public.direct_entry_validate_status_event() is
  'Employment history validator. Initial events may be legacy UNCONFIRMED or the current ON default.';
comment on function public.direct_entry_create_batch(uuid,uuid,jsonb,text) is
  'Creates an initial DRAFT batch; every new worker starts with employment status ON.';
comment on function public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text) is
  'Adds a DRAFT row; every new worker starts with employment status ON.';
comment on function public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text) is
  'Creates full-profile rows; omitted, ON or legacy UNCONFIRMED input starts ON, while explicit OFF appends a departure event.';

do $$
declare
  v_create text;
  v_draft text;
  v_full text;
  v_guard text;
begin
  select p.prosrc into v_create from pg_proc p
   where p.oid = 'public.direct_entry_create_batch(uuid,uuid,jsonb,text)'::regprocedure;
  select p.prosrc into v_draft from pg_proc p
   where p.oid = 'public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)'::regprocedure;
  select p.prosrc into v_full from pg_proc p
   where p.oid = 'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure;
  select p.prosrc into v_guard from pg_proc p
   where p.oid = 'public.direct_entry_validate_status_event()'::regprocedure;

  if v_create not like '%v_entry_id, ''ON'', v_first_work_date, 1, p_app_user_id, v_reason_id%'
     or v_draft not like '%v_entry_id, ''ON'', v_first_work_date, 1, p_app_user_id, v_reason_id%'
     or v_full not like '%v_entry_id, ''ON'', v_first_work_date, 1, p_app_user_id, v_reason_id%'
     or v_full not like '%if v_status = ''OFF'' then%'
     or v_full like '%if v_status in (''ON'',''OFF'') then%'
     or v_guard not like '%new.status not in (''UNCONFIRMED'',''ON'')%' then
    raise exception 'initial ON policy self-check failed' using errcode = '55000';
  end if;

  if not has_function_privilege('service_role',
       'public.direct_entry_create_batch(uuid,uuid,jsonb,text)', 'EXECUTE')
     or not has_function_privilege('service_role',
       'public.direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)', 'EXECUTE')
     or not has_function_privilege('service_role',
       'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)', 'EXECUTE') then
    raise exception 'initial ON policy ACL self-check failed' using errcode = '55000';
  end if;
end;
$$;

commit;
