-- PRE-W2 migration #102: explicit initial status is valid for any start date.
-- Keep enum validation and the separate OFF leave-date/reason checks unchanged.

begin;

do $$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure;
  v_source text;
  v_definition text;
  v_expected constant text := $old$
      if v_status not in ('UNCONFIRMED','ON','OFF')
         or v_first_work_date >= v_auth_date then$old$;
  v_replacement constant text := $new$
      if v_status not in ('UNCONFIRMED','ON','OFF') then$new$;
  v_count integer;
  v_next text;
  v_is_security_definer boolean;
  v_config text[];
begin
  select p.prosrc into v_source from pg_proc p where p.oid = v_signature;
  if v_source is null then
    raise exception 'PRE-W2 initial-status function missing: %', v_signature using errcode = '55000';
  end if;

  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> 1 then
    raise exception 'PRE-W2 initial-status source drift: expected one date guard, found %',
      v_count using errcode = '55000';
  end if;

  v_next := replace(v_source, v_expected, v_replacement);
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = v_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'PRE-W2 could not reconstruct function definition' using errcode = '55000';
  end if;
  execute replace(v_definition, v_source, v_next);

  select p.prosecdef, p.proconfig into v_is_security_definer, v_config
    from pg_proc p where p.oid = v_signature;
  select p.prosrc into v_source from pg_proc p where p.oid = v_signature;
  if not v_is_security_definer
     or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
     or position(v_expected in v_source) > 0
     or position('if v_status not in (''UNCONFIRMED'',''ON'',''OFF'') then' in v_source) = 0
     or not has_function_privilege('service_role', v_signature, 'EXECUTE')
     or has_function_privilege('anon', v_signature, 'EXECUTE')
     or has_function_privilege('authenticated', v_signature, 'EXECUTE') then
    raise exception 'PRE-W2 initial-status self-check failed' using errcode = '55000';
  end if;
end;
$$;

comment on function public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text) is
  'Creates full-profile rows with explicit initial employment status valid for historical, current or future start dates; OFF retains its leave-date and reason checks.';

commit;
