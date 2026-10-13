-- =============================================================================
-- PRE-W2-HF-C - Global duplicate-CCCD read access.
--
-- Goal: open the "Bao cao CCCD trung" report to EVERY authenticated, enabled
-- business actor, while keeping the exact same read-only projection, pagination,
-- ordering and service_role-only RPC boundary.
--
-- The report reader gate `direct_entry_assert_duplicate_cccd_reader` (#74) used
-- to require a high-authority bundle (Full Admin triple OR catalog_master_manage
-- OR entry_privileged_edit) AND an effective `all` scope. That gate is replaced
-- with the canonical actor-mapping / active-account guard:
--
--   * authenticated Supabase session mapped to an ENABLED direct_entry_app_user
--     with a unique actor mapping -> allowed;
--   * anonymous / unmapped / mismatched / disabled / ambiguous actors -> 42501
--     (fail closed), exactly like every other Direct Entry read boundary.
--
-- This is a DB-authority change only. It does NOT rely on email, display name,
-- role label or any client-provided authority, it does NOT grant any capability,
-- it does NOT weaken the service_role-only ACL of
-- `public.direct_entry_duplicate_cccd_report`, and it does NOT read business
-- tables through the service role to bypass the predicate. The report RPC keeps
-- its signature, envelope, pagination, ordering and masked projection byte for
-- byte; only the authority label it emits becomes the stable `business_actor`.
-- =============================================================================

begin;

create or replace function public.direct_entry_assert_duplicate_cccd_reader(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $reader$
begin
  -- PRE-W2-HF-C: every authenticated, enabled business actor with a unique actor
  -- mapping may read. The canonical guard fails closed (42501) for an unmapped,
  -- mismatched, disabled or absent actor, so an anonymous or broken account can
  -- never receive an empty page that would look like "no duplicates".
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  return 'business_actor';
end;
$reader$;
revoke all on function public.direct_entry_assert_duplicate_cccd_reader(uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_assert_duplicate_cccd_reader(uuid, uuid) is
  'PRE-W2-HF-C internal guard for the duplicate-CCCD report: every authenticated, enabled business actor with a unique actor mapping may read. Reuses direct_entry_assert_actor_mapping (fail-closed 42501 for unmapped, mismatched, disabled or absent actors); no capability, all-scope grant, email or role label is consulted. Returns the stable authority label business_actor. Revoked from every role: reachable only through the service_role report RPC.';

-- -----------------------------------------------------------------------------
-- Self-check (data-free: installs on an empty and a Production-shaped database).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_reader regprocedure :=
    'public.direct_entry_assert_duplicate_cccd_reader(uuid,uuid)'::regprocedure;
  v_report regprocedure :=
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)'::regprocedure;
  v_signature text := 'public.direct_entry_assert_duplicate_cccd_reader(uuid,uuid)';
  v_source text;
  v_secdef boolean;
  v_config text[];
begin
  -- 1. Exactly one reader function; SECURITY DEFINER with the fixed search_path.
  if (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = 'direct_entry_assert_duplicate_cccd_reader') <> 1 then
    raise exception 'PRE-W2-HF-C expected exactly one reader guard';
  end if;
  select p.prosecdef, p.proconfig, replace(p.prosrc, chr(13), '')
    into v_secdef, v_config, v_source
    from pg_proc p where p.oid = v_reader;
  if v_secdef is null or not v_secdef
     or not (v_config @> array['search_path=pg_catalog, public']) then
    raise exception 'PRE-W2-HF-C reader must be SECURITY DEFINER with a fixed search_path';
  end if;

  -- 2. Revoked from every role.
  if has_function_privilege('anon', v_reader, 'EXECUTE')
     or has_function_privilege('authenticated', v_reader, 'EXECUTE')
     or has_function_privilege('service_role', v_reader, 'EXECUTE')
     or exists (
       select 1 from aclexplode(coalesce(
         (select p.proacl from pg_proc p where p.oid = v_reader),
         acldefault('f', (select p.proowner from pg_proc p where p.oid = v_reader))
       )) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'
     ) then
    raise exception 'PRE-W2-HF-C reader must stay revoked from every role';
  end if;

  -- 3. The global rule reuses the canonical actor-mapping guard and the old
  --    high-authority + all-scope gate is gone for good.
  if position('direct_entry_assert_actor_mapping' in v_source) = 0 then
    raise exception 'PRE-W2-HF-C reader must reuse the canonical actor-mapping guard';
  end if;
  if position('duplicate cccd report denied' in v_source) > 0
     or position('duplicate cccd report requires all scope' in v_source) > 0
     or position(chr(39) || 'entry_admin' || chr(39) in v_source) > 0
     or position(chr(39) || 'catalog_master_manage' || chr(39) in v_source) > 0
     or position(chr(39) || 'entry_privileged_edit' || chr(39) in v_source) > 0
     or position('direct_entry_has_capability' in v_source) > 0
     or position('direct_entry_scope_grants' in v_source) > 0 then
    raise exception 'PRE-W2-HF-C the old capability/all-scope gate survived';
  end if;
  if position(chr(39) || 'business_actor' || chr(39) in v_source) = 0 then
    raise exception 'PRE-W2-HF-C the reader must return the stable authority label';
  end if;

  -- 4. The report RPC keeps its exact signature, STABLE volatility, pinned
  --    search_path and service_role-only ACL — no projection/envelope change.
  if not exists (
    select 1 from pg_proc p
     where p.oid = v_report
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig @> array['search_path=pg_catalog, public']
       and p.proargnames = array['p_auth_subject','p_app_user_id','p_page','p_page_size']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'PRE-W2-HF-C the report RPC boundary changed';
  end if;
  select replace(p.prosrc, chr(13), '') into v_source from pg_proc p where p.oid = v_report;
  if position(chr(39) || 'groups' || chr(39) in v_source) = 0
     or position(chr(39) || 'cccd_last4' || chr(39) in v_source) = 0
     or position('right(' in v_source) = 0 then
    raise exception 'PRE-W2-HF-C the report projection changed';
  end if;

  -- 5. Behaviour, data-free: an unmapped actor is still refused before any read
  --    and the reader has no other entry point.
  begin
    perform public.direct_entry_duplicate_cccd_report(
      '00000000-0000-4000-8000-0000000000e1'::uuid,
      '00000000-0000-4000-8000-0000000000e2'::uuid
    );
    raise exception 'PRE-W2-HF-C the report accepted an unmapped actor';
  exception
    when others then
      if position('PRE-W2-HF-C' in sqlerrm) > 0 then
        raise;
      end if;
      if sqlstate <> '42501' then
        raise exception 'PRE-W2-HF-C an unmapped actor must be denied with 42501 (got %)', sqlstate;
      end if;
  end;

  raise notice 'PRE-W2-HF-C migration self-check OK (global reader access) %', v_signature;
end;
$check$;

commit;
