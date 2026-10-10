begin;

-- P3.1 hotfix: migration #71 intentionally preserved the earlier valid_from of
-- each legacy team scope while creating the canonical leader assignment and
-- team_manager_assign capability at the transition date. The write RPC still
-- required all three rows to have the same valid_from, so every transitioned
-- leader was impossible to replace or revoke. Accept exactly one team scope
-- that starts on or before the assignment and has the same end boundary. This
-- preserves the legacy authority history while keeping the close operation
-- atomic across the assignment, covering scope, and exact capability row.
do $migration$
declare
  v_signature regprocedure :=
    'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::regprocedure;
  v_source text;
  v_scope_before constant text := $before$
       and s.valid_from = v_old.valid_from
       and s.valid_to is not distinct from v_old.valid_to
       and (s.valid_to is null or s.valid_to > s.valid_from);$before$;
  v_scope_after constant text := $after$
       and s.valid_from <= v_old.valid_from
       and s.valid_to is not distinct from v_old.valid_to
       and (s.valid_to is null or s.valid_to > s.valid_from);$after$;
  v_error_before constant text := $before$
      raise exception 'legacy leader assignment, scope, and capability intervals do not match'
        using errcode = '42501';$before$;
  v_error_after constant text := $after$
      raise exception 'leader authority interval state conflict'
        using errcode = '23514';$after$;
begin
  select pg_get_functiondef(v_signature) into v_source;

  if length(v_source) - length(replace(v_source, v_scope_before, ''))
       <> length(v_scope_before)
     or length(v_source) - length(replace(v_source, v_error_before, ''))
       <> length(v_error_before) then
    raise exception 'team leader legacy-scope hotfix source drift'
      using errcode = '55000';
  end if;

  v_source := replace(v_source, v_scope_before, v_scope_after);
  v_source := replace(v_source, v_error_before, v_error_after);
  execute v_source;
end;
$migration$;

comment on function public.direct_entry_apply_team_leader_mutation(
  uuid, uuid, uuid, uuid, date, integer, text, text, text, text
) is
  'P3.1-W01D atomic leader designate/replace/revoke helper. A transitioned legacy team scope may start before its assignment, but must uniquely cover the assignment and share its end boundary; malformed authority bundles fail as state conflicts, not authorization denials.';

do $self_check$
declare
  v_signature regprocedure :=
    'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::regprocedure;
  v_source text := pg_get_functiondef(
    'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::regprocedure
  );
begin
  if not exists (
       select 1
         from pg_proc p
        where p.oid = v_signature
          and p.prosecdef
          and p.proconfig @> array['search_path=pg_catalog, public']::text[]
     )
     or v_source not like '%and s.valid_from <= v_old.valid_from%'
     or v_source like '%and s.valid_from = v_old.valid_from%'
     or v_source not like '%leader authority interval state conflict%'
     or v_source not like '%errcode = ''23514''%'
     or has_function_privilege('public', v_signature, 'EXECUTE')
     or has_function_privilege('anon', v_signature, 'EXECUTE')
     or has_function_privilege('authenticated', v_signature, 'EXECUTE')
     or has_function_privilege('service_role', v_signature, 'EXECUTE') then
    raise exception 'team leader legacy-scope hotfix self-check failed'
      using errcode = '55000';
  end if;
end;
$self_check$;

commit;
