-- =============================================================================
-- PRE-W2-HF-D2 - Active duplicate-CCCD reporting semantics.
--
-- The P3.1-HF duplicate report (#74) grouped a canonical CCCD on TOTAL profiles
-- (two or more rows, ON/UNCONFIRMED/OFF alike) and returned every episode of the
-- group, including resigned (OFF) episodes. That made the report list duplicate
-- CCCD HISTORY rather than "who is currently working the same CCCD".
--
-- This migration patches ONLY public.direct_entry_duplicate_cccd_report so that:
--   * a group is eligible only when it has >= 2 episodes whose canonical latest
--     employment status is ON ("Dang lam viec") - the authoritative working state;
--   * the projection returns only those ON episodes, never an OFF/UNCONFIRMED one;
--   * after a PM closes an episode (OFF), the next read drops the group when the
--     remaining ON count falls below two.
--
-- Append-only: nothing in #74/#87 is edited. The reader guard (HF-C #87), the RPC
-- signature, envelope, pagination/ceiling, deterministic ordering, masked
-- projection, ACL (service_role-only) and pinned search_path all stay byte-stable.
-- =============================================================================

begin;

create function public.direct_entry_hf_d2_replace_proc_source(
  p_signature regprocedure, p_expected text, p_replacement text, p_expected_count integer
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_source text; v_definition text;
  v_expected text := p_expected; v_replacement text := p_replacement;
  v_next text; v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'PRE-W2-HF-D2 invalid source patch specification';
  end if;
  select replace(p.prosrc, chr(13), '') into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then
    raise exception 'PRE-W2-HF-D2 source function not found: %', p_signature;
  end if;
  v_expected := replace(p_expected, chr(13), '');
  v_replacement := replace(p_replacement, chr(13), '');
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'PRE-W2-HF-D2 expected % exact source fragment(s), found % in %, starting with: %',
      p_expected_count, v_count, p_signature, left(v_expected, 96);
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select replace(pg_get_functiondef(p.oid), chr(13), '') into v_definition
    from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'PRE-W2-HF-D2 could not reconstruct function definition: %', p_signature;
  end if;
  execute replace(v_definition, v_source, v_next);
end;
$$;
revoke all on function public.direct_entry_hf_d2_replace_proc_source(regprocedure,text,text,integer)
  from public, anon, authenticated, service_role;

-- (1) Only ON episodes are working episodes, and `active` follows the ON status
--     instead of "anything that is not OFF".
select public.direct_entry_hf_d2_replace_proc_source(
  'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::regprocedure,
  $old$l.latest_status <> 'OFF'$old$,
  $new$l.latest_status = 'ON'$new$,
  2
);

-- (2) The `live` set keeps only the episodes whose canonical latest status is ON,
--     so the group count, project count, date range and episode list all describe
--     currently-working episodes, never resigned/unknown ones.
select public.direct_entry_hf_d2_replace_proc_source(
  'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::regprocedure,
  $old$where public.direct_entry_is_canonical_national_id(c.cccd)$old$,
  $new$where public.direct_entry_is_canonical_national_id(c.cccd)
         and coalesce((
               select st.status
                 from public.direct_entry_employment_status_events st
                where st.entry_id = c.entry_id
                order by st.version desc
                limit 1
             ), 'UNCONFIRMED') = 'ON'$new$,
  1
);

drop function public.direct_entry_hf_d2_replace_proc_source(regprocedure,text,text,integer);

-- -----------------------------------------------------------------------------
-- Install-time self-check (data free: this migration installs on an empty and a
-- Production-shaped database alike).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_source text;
begin
  select replace(p.prosrc, chr(13), '') into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::regprocedure;
  if v_source is null then
    raise exception 'PRE-W2-HF-D2 the duplicate report function is missing';
  end if;

  -- The authoritative working predicate is ON; the old OFF-based "active" is gone.
  if position('l.latest_status = ' || chr(39) || 'ON' || chr(39) in v_source) = 0 then
    raise exception 'PRE-W2-HF-D2 the report lost the ON working predicate';
  end if;
  if position('<> ' || chr(39) || 'OFF' || chr(39) in v_source) > 0 then
    raise exception 'PRE-W2-HF-D2 the old OFF-based active predicate survived';
  end if;
  if position('coalesce((' in v_source) = 0 then
    raise exception 'PRE-W2-HF-D2 the canonical latest-status coalesce was lost';
  end if;

  -- Still masked, still no raw UUID, still bounded, still read-only.
  if position('right(' in v_source) = 0
     or position(chr(39) || 'cccd_last4' || chr(39) in v_source) = 0 then
    raise exception 'PRE-W2-HF-D2 the report does not mask the CCCD';
  end if;
  if position(chr(39) || 'entry_id' || chr(39) in v_source) > 0
     or position(chr(39) || 'worker_id' || chr(39) in v_source) > 0
     or position(chr(39) || 'recruiter_id' || chr(39) in v_source) > 0 then
    raise exception 'PRE-W2-HF-D2 the report projects a raw UUID';
  end if;
  if position('duplicate_report_page_size_invalid' in v_source) = 0
     or position('duplicate_report_page_invalid' in v_source) = 0 then
    raise exception 'PRE-W2-HF-D2 the report is not bounded';
  end if;
  if v_source ~* '(insert into|update public|delete from|for update|advisory_xact_lock|truncate)' then
    raise exception 'PRE-W2-HF-D2 the report is not read-only';
  end if;

  -- The HF-C reader guard remains the authority source; the report still delegates.
  if position('direct_entry_assert_duplicate_cccd_reader' in v_source) = 0 then
    raise exception 'PRE-W2-HF-D2 the report no longer delegates to the HF-C reader guard';
  end if;

  -- Security boundary unchanged: STABLE, SECURITY DEFINER, pinned search_path,
  -- service_role-only, revoked from every other role.
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'PRE-W2-HF-D2 the duplicate report security boundary changed';
  end if;

  raise notice 'PRE-W2-HF-D2 migration self-check OK (active duplicate-CCCD semantics)';
end;
$check$;

commit;
