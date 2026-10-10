begin;

-- A cancelled future move leaves the preceding membership with a finite end.
-- Permit moving that still-effective interval while preserving its end date.
-- Keep open/scheduled selection, locks, OCC, replay, attribution and audit intact.
do $migration$
declare
  v_signature regprocedure := 'public.direct_entry_move_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::regprocedure;
  v_source text := pg_get_functiondef(v_signature);
  v_before text[] := array[
    '     and m.valid_to is null',
    'insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)
  values (p_recruiter_id, p_team_id, p_valid_from)',
    'p_recruiter_id, p_team_id, p_valid_from, null, v_subject.version + 1, ''MOVE'''
  ];
  v_after text[] := array[
    '     and (m.valid_to is null or (
       m.valid_from <= p_valid_from and p_valid_from < m.valid_to
       and public.direct_entry_authorization_date() < m.valid_to
     ))',
    'insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to)
  values (p_recruiter_id, p_team_id, p_valid_from, v_open.valid_to)',
    'p_recruiter_id, p_team_id, p_valid_from, v_open.valid_to, v_subject.version + 1, ''MOVE'''
  ];
begin
  for i in 1..array_length(v_before, 1) loop
    if length(v_source) - length(replace(v_source, v_before[i], '')) <> length(v_before[i]) then
      raise exception 'finite membership move source drift' using errcode = '55000';
    end if;
    v_source := replace(v_source, v_before[i], v_after[i]);
  end loop;
  execute v_source;
  if not exists (select 1 from pg_proc where oid = v_signature and prosecdef
    and proconfig @> array['search_path=pg_catalog, public']::text[])
    or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    or has_function_privilege('anon', v_signature, 'EXECUTE')
    or has_function_privilege('authenticated', v_signature, 'EXECUTE')
    or has_function_privilege('public', v_signature, 'EXECUTE') then
    raise exception 'finite membership move security drift' using errcode = '55000';
  end if;
end;
$migration$;

commit;
