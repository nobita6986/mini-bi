-- =============================================================================
-- P3-W07C-R3 — Direct Entry column order + server default for CCCD issue place.
--
-- Task:    P3-W07C-R3_DIRECT_ENTRY_COLUMN_ORDER_AND_ISSUE_PLACE_SERVER_DEFAULT
-- Status:  P3-W07C-R3_ISSUE_PLACE_DEFAULT_COLUMN_ORDER_LOCAL_PASS_AWAITING_INTEGRATION
-- Base:    c86cd9288e5af6ba7b654e5b8d5a88753c3fa54c
-- Delta:   docs/handoffs/p3-w07c-r3-issue-place-default-column-order-TASK.md
--
-- Goal: At the DB/RPC boundary, every new Direct Entry worker is created with
-- `national_id_issued_place` = {"state":"provided","value":"Bộ Công An"} regardless
-- of the value (or absence) sent by the client. This is a server-authoritative
-- default for new records only; historical rows and the update flow are not
-- backfilled. The client/UI may stop shipping the field altogether; the JSONB
-- envelope and the validator still accept the key for legacy reads.
--
-- Other behavior of `direct_entry_create_full_profile_batch` is unchanged:
--   * security definer, search_path=pg_catalog, public, and grants preserved.
--   * all other worker_details keys, audit, idempotency, and scope checks
--     untouched. Application only stores metadata as text — no payment
--     sub-system is involved here.
--
-- Migration slot naming:
--   File:    supabase/migrations/20261008060000_p3_w07c_r3_issue_place_server_default.sql
--   Slot:    #46 on this branch (after W07C-R2 #45, before any later task);
--            becomes #47 after W05A's #45 (`20261008040000_...`) integrates.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- `direct_entry_create_full_profile_batch` — single-line source-preserving
-- replacement: the `national_id_issued_place` entry in the
-- `v_worker_details := jsonb_build_object(...)` block becomes a hard-coded
-- server default. The installed function body is read via `pg_proc.prosrc` and
-- rewritten via `pg_get_functiondef`, so we never copy, paraphrase, or rewrite
-- the rest of the RPC. The migration fails closed if the source does not
-- match the expected line exactly.
-- -----------------------------------------------------------------------------
do $p3_w07c_r3$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure;
  v_source text;
  v_source_with_server_default text;
  v_definition text;
  v_replaced_length integer;
  v_legacy_line constant text := $legacy$
      'national_id_issued_place', coalesce(v_worker_input->'national_id_issued_place', '{"state":"omitted"}'::jsonb),
$legacy$;
  v_default_line constant text := $defaulted$
      'national_id_issued_place', '{"state":"provided","value":"Bộ Công An"}'::jsonb,
$defaulted$;
  v_is_security_definer boolean;
  v_config text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
begin
  select p.prosrc
    into v_source
    from pg_proc p
   where p.oid = v_signature;
  if v_source is null then
    raise exception 'P3-W07C-R3 could not find the existing full-profile batch RPC';
  end if;

  -- P3-W07C-R3: there must be exactly one occurrence of the legacy
  -- `national_id_issued_place` line. If the installed body differs (e.g. an
  -- earlier integration already changed the default), stop and ask for an
  -- updated patch rather than silently rewriting a different RPC version.
  v_replaced_length := length(v_source) - length(replace(v_source, v_legacy_line, ''));
  if v_replaced_length <> length(v_legacy_line) then
    raise exception 'P3-W07C-R3 expected exactly one legacy national_id_issued_place coalesce line; no RPC was changed';
  end if;

  v_source_with_server_default := replace(v_source, v_legacy_line, v_default_line);

  v_definition := pg_get_functiondef(v_signature);
  v_replaced_length := length(v_definition) - length(replace(v_definition, v_source, ''));
  if v_replaced_length <> length(v_source) then
    raise exception 'P3-W07C-R3 could not safely reconstruct the existing full-profile batch RPC';
  end if;
  execute replace(v_definition, v_source, v_source_with_server_default);

  -- Post-patch security boundary: must be identical to the pre-patch
  -- contract documented in W07C-R2.
  select p.prosecdef, p.proconfig,
         has_function_privilege('service_role', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         exists (
           select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         )
    into v_is_security_definer, v_config, v_service_exec, v_anon_exec,
         v_authenticated_exec, v_public_exec
    from pg_proc p
   where p.oid = v_signature;
  if not v_is_security_definer
     or not coalesce(v_config @> array['search_path=pg_catalog, public'], false)
     or not v_service_exec or v_anon_exec or v_authenticated_exec or v_public_exec then
    raise exception 'P3-W07C-R3 changed the existing full-profile batch RPC security boundary';
  end if;
end;
$p3_w07c_r3$;