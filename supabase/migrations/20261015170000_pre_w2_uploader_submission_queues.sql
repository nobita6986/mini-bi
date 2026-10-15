-- PRE-W2: split the uploader submission list into active and history queues.
-- Additive only: no business row is inserted, updated or deleted.
begin;

-- Preserve every later Project Manager authority patch on the submission reader and change only
-- the two exact state-filter fragments needed by the uploader tabs.
create function public.direct_entry_pre_w2_replace_proc_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_source text;
  v_definition text;
  v_expected text := p_expected;
  v_replacement text := p_replacement;
  v_count integer;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then
    raise exception 'PRE-W2 source function not found: %', p_signature;
  end if;
  if position(E'\r\n' in v_source) > 0 then
    v_expected := replace(v_expected, E'\n', E'\r\n');
    v_replacement := replace(v_replacement, E'\n', E'\r\n');
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) /
    length(v_expected);
  if v_count <> 1 then
    raise exception 'PRE-W2 expected one source fragment, found % in %', v_count, p_signature;
  end if;
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'PRE-W2 could not reconstruct function definition: %', p_signature;
  end if;
  execute replace(v_definition, v_source, replace(v_source, v_expected, v_replacement));
  if not exists (
    select 1 from pg_proc p
     where p.oid = p_signature and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog, public']
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception 'PRE-W2 changed function security boundary: %', p_signature;
  end if;
end;
$$;
revoke all on function public.direct_entry_pre_w2_replace_proc_source(regprocedure,text,text)
  from public, anon, authenticated, service_role;

select public.direct_entry_pre_w2_replace_proc_source(
  'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)'::regprocedure,
  $old$
  if p_state is not null and p_state not in ('DRAFT', 'REVIEW', 'SUBMITTED') then
    raise exception 'invalid submission state filter' using errcode = '22023';
  end if;$old$,
  $new$
  if p_state is not null and p_state not in
       ('DRAFT', 'REVIEW', 'SUBMITTED', 'ACTIVE', 'HISTORY') then
    raise exception 'invalid submission state filter' using errcode = '22023';
  end if;$new$
);

select public.direct_entry_pre_w2_replace_proc_source(
  'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)'::regprocedure,
  $old$
       and (p_state is null or s.state = p_state)$old$,
  $new$
       and (p_state is null
         or (p_state = 'ACTIVE' and s.state in ('DRAFT', 'REVIEW'))
         or (p_state = 'HISTORY' and s.state = 'SUBMITTED')
         or s.state = p_state)$new$
);

drop function public.direct_entry_pre_w2_replace_proc_source(regprocedure,text,text);

commit;
