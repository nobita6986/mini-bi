-- =============================================================================
-- P3-W07C-R2 — Store `date_of_birth` and `national_id_issued_at` as raw text.
--
-- Task:    P3-W07C-R2_STORE_DOB_AND_CCCD_ISSUE_AS_RAW_TEXT
-- Status:  P3-W07C-R2_STORE_DOB_AND_CCCD_ISSUE_AS_RAW_TEXT_LOCAL_PASS_AWAITING_INTEGRATION
-- Base:    4b641a8f9980288067a5839c4fabbf9051efadfb
-- Delta:   docs/handoffs/p3-w07c-direct-entry-save-date-lazy-defaults-hotfix.md
--
-- Goal: Lock the contract that `date_of_birth` and `national_id_issued_at`
-- are PURE TEXT round-tripped from the UI cell -> payload -> JSONB column
-- and back. The user's exact input (e.g. "07/10/1990", "07-10-1990",
-- "1990-10-07") is preserved verbatim. NO parsing, NO calendar validation,
-- NO ISO canonicalization, NO chronological comparison happen at the
-- storage / RPC layer for these two fields.
--
-- Other date fields (notably `first_work_date`, `leave_date`,
-- `effective_date`, `effective_month`) keep their existing DATE / ISO contract
-- untouched. Migration is append-only:
--   * The large `direct_entry_create_full_profile_batch` body contains two
--     inline lexical comparisons of DOB/CCCD text against ISO dates. A
--     guarded, source-preserving patch removes only that exact block; it
--     leaves bank/account text metadata, employment, submission, and audit
--     behavior untouched. This is not a payment or accounting workflow.
--   * `worker_details` is JSONB text already; no column type changes.
--   * `security definer`, `search_path = pg_catalog, public`, and grants
--     on the validator are preserved.
--
-- Coordination note (HANDOFF):
--   W05A branch owns migration #45
--   (`20261008040000_p3_w05a_actor_scoped_reporting.sql`). This R2 migration
--   is positioned at slot #46 (`20261008050000_...`) so it lands strictly
--   AFTER #45 once W05A is integrated. On the W07C branch this file is the
--   last 20261008 file and the PGlite suite expects 45 applied migrations
--   (mirroring local CI expectations). On integration, both files apply in
--   slot order; rebase must keep #45 -> #46 ordering.
--
-- Migration slot naming:
--   File:    supabase/migrations/20261008050000_p3_w07c_r2_raw_text_dates.sql
--   Slot:    #46 (after W05A's #45, before any later task).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) `direct_entry_valid_worker_details` — pure-text pass-through for the
--    two raw-text date fields. The function only enforces the JSONB object
--    envelope and that any `provided` value is a non-empty string. It does
--    NOT parse, validate calendar reality, compare chronology, or rewrite the
--    stored value.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_valid_worker_details(p_worker jsonb)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_field jsonb;
  v_value jsonb;
  v_state text;
begin
  if jsonb_typeof(p_worker) <> 'object'
     or p_worker - array[
       'display_name','date_of_birth','national_id','address','phone','gender',
       'national_id_issued_at','national_id_issued_place'
     ] <> '{}'::jsonb
     or not (p_worker ?& array[
       'display_name','date_of_birth','national_id','address','phone'
     ])
     or jsonb_typeof(p_worker->'display_name') <> 'string'
     or length(btrim(p_worker->>'display_name')) not between 1 and 256 then
    return false;
  end if;

  foreach v_key in array array[
    'date_of_birth','national_id','address','phone','gender',
    'national_id_issued_at','national_id_issued_place'
  ] loop
    if not (p_worker ? v_key) then
      continue;
    end if;
    v_field := p_worker->v_key;
    if jsonb_typeof(v_field) <> 'object'
       or v_field - array['state','value'] <> '{}'::jsonb
       or not (v_field ? 'state') then
      return false;
    end if;
    v_state := v_field->>'state';
    if v_state in ('omitted','unknown','intentionally_blank') then
      if v_field ? 'value' or (v_key = 'gender' and v_state = 'intentionally_blank') then
        return false;
      end if;
      continue;
    end if;
    if v_state <> 'provided' or not (v_field ? 'value')
       or jsonb_typeof(v_field->'value') <> 'string' then
      return false;
    end if;
    v_value := v_field->'value';
    -- P3-W07C-R2: date values are text. Keep a small payload-size bound and
    -- reject blank strings, but do not parse, reformat or compare dates.
    if v_key in ('date_of_birth','national_id_issued_at') then
      if length(btrim(v_value#>>'{}')) = 0
         or length(v_value#>>'{}') > 10 then
        return false;
      end if;
    elsif v_key = 'gender' then
      if v_value#>>'{}' not in ('MALE','FEMALE','OTHER') then
        return false;
      end if;
    elsif v_key = 'national_id' then
      if length(btrim(v_value#>>'{}')) not in (9,12)
         or v_value#>>'{}' !~ '^[0-9]+$' then
        return false;
      end if;
    elsif v_key = 'national_id_issued_place' then
      if length(btrim(v_value#>>'{}')) not between 1 and 256 then
        return false;
      end if;
    elsif v_key = 'address' and length(v_value#>>'{}') > 1024 then
      return false;
    elsif v_key = 'phone' and length(v_value#>>'{}') > 64 then
      return false;
    end if;
  end loop;

  -- P3-W07C-R2: no date semantics apply to these two ordinary text fields.
  return true;
end;
$$;

-- The validator stays internal to SECURITY DEFINER RPCs: no direct grant to
-- service_role, public, anon, or authenticated.
revoke all on function public.direct_entry_valid_worker_details(jsonb)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2) `direct_entry_create_full_profile_batch` — remove only the legacy
--    lexical DOB/CCCD-issued-date comparisons. `worker_details` is JSONB,
--    so these strings already persist without a schema/type conversion.
--    pg_get_functiondef lets this migration preserve the installed function
--    body verbatim except for the guarded block; no profile/audit logic is
--    copied, rewritten, or dropped.
-- -----------------------------------------------------------------------------
do $p3_w07c_r2$
declare
  v_signature constant regprocedure :=
    'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)'::regprocedure;
  v_source text;
  v_source_without_date_checks text;
  v_definition text;
  v_replaced_length integer;
  v_is_security_definer boolean;
  v_config text[];
  v_service_exec boolean;
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_public_exec boolean;
  v_date_check_block constant text := $date_checks$
    if v_worker_details->'date_of_birth'->>'state' = 'provided'
       and v_worker_details->'date_of_birth'->>'value' > to_char(v_auth_date, 'YYYY-MM-DD') then
      raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
    end if;
    if v_worker_details->'national_id_issued_at'->>'state' = 'provided' then
      if v_worker_details->'national_id_issued_at'->>'value' > to_char(v_auth_date, 'YYYY-MM-DD')
         or (v_worker_details->'date_of_birth'->>'state' = 'provided'
           and v_worker_details->'national_id_issued_at'->>'value'
             < v_worker_details->'date_of_birth'->>'value') then
        raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
      end if;
    end if;
$date_checks$;
begin
  select p.prosrc
    into v_source
    from pg_proc p
   where p.oid = v_signature;
  if v_source is null then
    raise exception 'P3-W07C-R2 could not find the existing full-profile batch RPC';
  end if;

  -- Require exactly the known legacy block. If the installed body differs,
  -- stop rather than silently altering a different RPC version.
  v_source_without_date_checks := replace(v_source, v_date_check_block, '');
  v_replaced_length := length(v_source) - length(v_source_without_date_checks);
  if v_replaced_length <> length(v_date_check_block) then
    raise exception 'P3-W07C-R2 expected exactly one known DOB/CCCD comparison block; no RPC was changed';
  end if;

  v_definition := pg_get_functiondef(v_signature);
  v_replaced_length := length(v_definition) - length(replace(v_definition, v_source, ''));
  if v_replaced_length <> length(v_source) then
    raise exception 'P3-W07C-R2 could not safely reconstruct the existing full-profile batch RPC';
  end if;
  execute replace(v_definition, v_source, v_source_without_date_checks);

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
    raise exception 'P3-W07C-R2 changed the existing full-profile batch RPC security boundary';
  end if;
end;
$p3_w07c_r2$;
