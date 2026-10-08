-- P2.5-HF-R6 - keep full-profile creation authority project-scoped when an
-- assigned manager explicitly supplies an initial employment state.
--
-- #58 made bank metadata project-scoped for managers, but left the explicit
-- OFF branch behind the global employment_status.apply capability. The live
-- spreadsheet can carry that off-screen value, so an otherwise-authorized
-- project manager received a generic 403 for the entire atomic batch.

begin;

create function public.direct_entry_hf_r6_replace_proc_source(
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
  v_source text;
  v_definition text;
  v_expected text := p_expected;
  v_replacement text := p_replacement;
  v_next text;
  v_count integer;
begin
  select p.prosrc into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null or p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'P2.5-HF-R6 invalid source patch specification' using errcode = '55000';
  end if;
  if position(chr(13) || chr(10) in v_source) > 0 then
    v_expected := replace(v_expected, chr(10), chr(13) || chr(10));
    v_replacement := replace(v_replacement, chr(10), chr(13) || chr(10));
  end if;
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'P2.5-HF-R6 source drift for %: expected %, found %',
      p_signature, p_expected_count, v_count using errcode = '55000';
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select pg_get_functiondef(p.oid) into v_definition from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'P2.5-HF-R6 could not reconstruct function definition: %', p_signature
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_source, v_next);
end;
$$;
revoke all on function public.direct_entry_hf_r6_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

select public.direct_entry_hf_r6_replace_proc_source(
  'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure,
  $old$
  if v_has_status then
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'employment_status.apply'
    );
  end if;$old$,
  $new$
  -- Project managers already passed the per-row authority count above. They may
  -- record the supplied initial state for their own project; the legacy/global
  -- path continues to require employment_status.apply.
  if v_has_status and v_count > 0 then
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'employment_status.apply'
    );
  end if;$new$,
  1
);

drop function public.direct_entry_hf_r6_replace_proc_source(regprocedure,text,text,integer);

do $$
declare
  v_source text;
begin
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure;
  if v_source not like '%if v_has_status and v_count > 0 then%'
     or v_source like E'%\n  if v_has_status then\n%'
     or not exists (
       select 1 from pg_proc p
        where p.oid = 'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure
          and p.prosecdef
          and p.proconfig @> array['search_path=pg_catalog, public']
     )
     or not has_function_privilege(
       'service_role',
       'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)',
       'EXECUTE'
     ) then
    raise exception 'P2.5-HF-R6 manager initial-status self-check failed' using errcode = '55000';
  end if;
end;
$$;

comment on function public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text) is
  'Creates full-profile rows. An assigned project manager may supply profile, bank-text and initial employment data for that project; legacy actors still need the existing global capabilities.';

commit;
