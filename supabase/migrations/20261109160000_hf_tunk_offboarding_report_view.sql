-- =============================================================================
-- Hotfix: Least-Privilege Offboarding Report Read Capability (`offboarding_report_view`)
--         for Canonical Account `tunk.mkt`
--
-- Scope:
--   1. Extend `public.direct_entry_capability_grants_capability_check` with
--      `offboarding_report_view` (read-only offboarding report capability).
--   2. Update `public.direct_entry_offboarding_authority(uuid, uuid)` so an actor
--      with effective `offboarding_report_view` is authorized strictly within their
--      existing current scope:
--        - exactly 1 current `all` scope grant (and <= 1 effective `team` scope grant)
--          -> `scope = 'all'`, `team_id = null`
--        - 0 current `all` scope grants and exactly 1 effective current `team` scope
--          grant on an active team -> `scope = 'team'`, `team_id = <team_id>`
--        - 0 eligible scopes or ambiguous scopes -> denied (`42501`)
--      Always returns `can_phone = false`, `can_export = false`, `can_hide = false`,
--      `authority = 'offboarding_report_view'`.
--   3. Idempotently grant `offboarding_report_view` to the single enabled canonical
--      app user for `tunk.mkt` (`tunk.mkt@hrpartner.vn`) without modifying any
--      existing capabilities, scopes, assignments, teams, recruiters, or projects.
--   4. Run install-time and post-grant self-checks.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Ensure `auth.users.email` exists in minimal PGlite test harnesses.
-- -----------------------------------------------------------------------------
do $ensure_auth_users_email_for_pglite$
begin
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'auth'
       and c.relname = 'users'
       and a.attname = 'email'
       and a.attnum > 0
       and not a.attisdropped
  ) then
    alter table auth.users add column email text;
  end if;
end;
$ensure_auth_users_email_for_pglite$;

-- -----------------------------------------------------------------------------
-- 2. Extend `direct_entry_capability_grants_capability_check` with
--    `offboarding_report_view`.
-- -----------------------------------------------------------------------------
do $capability_constraint$
declare
  v_constraint record;
begin
  for v_constraint in
    select c.conname
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.direct_entry_capability_grants'::pg_catalog.regclass
       and c.contype = 'c'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%capability%'
  loop
    execute pg_catalog.format(
      'alter table public.direct_entry_capability_grants drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$capability_constraint$;

alter table public.direct_entry_capability_grants
  add constraint direct_entry_capability_grants_capability_check
  check (
    capability in (
      'entry_create', 'entry_own', 'entry_team', 'entry_admin',
      'entry_restore',
      'submission_create', 'change_request_create', 'change_review', 'entry_privileged_edit',
      'employment_status.request', 'employment_status.review', 'employment_status.apply',
      'document_upload', 'document_view', 'payment_view', 'payment_edit',
      'recruiter_master_manage', 'team_master_manage', 'pii_view', 'pii_export', 'audit_view',
      'catalog_master_manage', 'team_manager_assign',
      'report_form_manage', 'report_assign', 'report_view', 'report_analytics_view',
      'report_review', 'report_delegate',
      'vendor_finance_view', 'vendor_finance_record',
      'duplicate_cccd_withdraw',
      'worker_edit_history_view',
      'offboarding_report_view'
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Update `public.direct_entry_offboarding_authority(uuid, uuid)` to support
--    read-only `offboarding_report_view` within the actor's existing scope.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_offboarding_authority(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_team_id uuid;
  v_all_scope_count integer;
  v_team_scope_count integer;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    return jsonb_build_object(
      'scope', 'all',
      'team_id', null,
      'can_phone', true,
      'can_export', true,
      'can_hide', true,
      'authority', 'admin'
    );
  exception when insufficient_privilege then
    null;
  end;

  if public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
     and public.direct_entry_has_scope(p_app_user_id, 'all') then
    return jsonb_build_object(
      'scope', 'all',
      'team_id', null,
      'can_phone', true,
      'can_export', true,
      'can_hide', true,
      'authority', 'bod'
    );
  end if;

  begin
    v_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
    return jsonb_build_object(
      'scope', 'team',
      'team_id', v_team_id,
      'can_phone', false,
      'can_export', false,
      'can_hide', false,
      'authority', 'team_leader'
    );
  exception when insufficient_privilege then
    null;
  end;

  if public.direct_entry_has_capability(p_app_user_id, 'offboarding_report_view') then
    select count(*)::integer
      into v_all_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'all'
       and g.team_id is null
       and g.is_current;

    select count(*)::integer,
           (pg_catalog.array_agg(g.team_id order by g.team_id))[1]
      into v_team_scope_count,
           v_team_id
      from public.direct_entry_scope_grants g
      join public.teams t
        on t.team_id = g.team_id
       and t.active
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'team'
       and public.direct_entry__internal_team_scope_grant_effective(g.grant_id);

    if v_all_scope_count = 1 and v_team_scope_count <= 1 then
      return jsonb_build_object(
        'scope', 'all',
        'team_id', null,
        'can_phone', false,
        'can_export', false,
        'can_hide', false,
        'authority', 'offboarding_report_view'
      );
    elsif v_all_scope_count = 0 and v_team_scope_count = 1 then
      return jsonb_build_object(
        'scope', 'team',
        'team_id', v_team_id,
        'can_phone', false,
        'can_export', false,
        'can_hide', false,
        'authority', 'offboarding_report_view'
      );
    end if;
  end if;

  raise exception 'offboarding report denied' using errcode = '42501';
end;
$function$;

comment on function public.direct_entry_offboarding_authority(uuid, uuid) is
  'Internal authority for the offboarding report. Returns {scope, team_id, can_phone, can_export, can_hide, authority} for Full Admin, BoD/Accounting, current Team Leader, or read-only offboarding_report_view within current all/single-team scope; raises 42501 otherwise. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 4. Owner alignment & strict internal ACLs for `direct_entry_offboarding_authority`
-- -----------------------------------------------------------------------------
do $align_offboarding_authority_owner_and_acl$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_proc_owner_oid oid;
  v_owner name;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  select p.proowner
    into v_proc_owner_oid
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry_offboarding_authority(uuid, uuid)'::pg_catalog.regprocedure;

  if v_proc_owner_oid is distinct from v_base_owner_oid
     and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter function public.direct_entry_offboarding_authority(uuid, uuid) owner to %I',
      v_base_owner
    );
  end if;

  revoke all on function public.direct_entry_offboarding_authority(uuid, uuid)
    from public, anon, authenticated, service_role;

  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname in (
         'direct_entry_offboarding_authority',
         'direct_entry_offboarding_report',
         'direct_entry_offboarding_report_export',
         'direct_entry_offboarding_hide_snapshot'
       )
  loop
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_offboarding_authority(uuid, uuid) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_capability(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_has_scope(uuid, text) to %I',
      v_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry__internal_team_scope_grant_effective(uuid, date) to %I',
      v_owner
    );
  end loop;
end;
$align_offboarding_authority_owner_and_acl$;

-- -----------------------------------------------------------------------------
-- 5. Idempotently grant `offboarding_report_view` to canonical `tunk.mkt`
--    and run post-grant self-checks.
-- -----------------------------------------------------------------------------
do $grant_tunk_offboarding_report_view$
declare
  v_account_count integer;
  v_auth_Count integer;
  v_app_user_id uuid;
  v_auth_subject uuid;
  v_enabled boolean;
  v_today date := public.direct_entry_authorization_date();
  v_scope_count_before integer;
  v_scope_count_after integer;
  v_other_cap_count_before integer;
  v_other_cap_count_after integer;
  v_current_cap_count integer;
  v_future_cap_count integer;
  v_inactive_overlap_count integer;
  v_granted_user_count integer;
  v_auth jsonb;
begin
  select count(*)::integer
    into v_auth_Count
    from auth.users au
   where pg_catalog.lower(pg_catalog.split_part(pg_catalog.btrim(coalesce(au.email, '')), '@', 1)) = 'tunk.mkt';

  select count(*)::integer
    into v_account_count
    from public.direct_entry_app_users u
    join auth.users au on au.id = u.auth_subject
   where pg_catalog.lower(pg_catalog.split_part(pg_catalog.btrim(coalesce(au.email, '')), '@', 1)) = 'tunk.mkt';

  if v_auth_Count = 0 and v_account_count = 0 then
    raise notice 'Skipping tunk.mkt offboarding_report_view grant because tunk.mkt is not provisioned in this database';
    return;
  end if;

  if v_auth_Count <> 1 or v_account_count <> 1 then
    raise exception 'expected exactly one canonical auth/app user mapping for tunk.mkt, found auth_users=% app_users=%',
      v_auth_Count, v_account_count
      using errcode = 'P0001';
  end if;

  select u.app_user_id, u.auth_subject, u.enabled
    into v_app_user_id, v_auth_subject, v_enabled
    from public.direct_entry_app_users u
    join auth.users au on au.id = u.auth_subject
   where pg_catalog.lower(pg_catalog.split_part(pg_catalog.btrim(coalesce(au.email, '')), '@', 1)) = 'tunk.mkt';

  if not coalesce(v_enabled, false) then
    raise exception 'tunk.mkt (app_user_id=%) must be enabled to receive offboarding_report_view',
      v_app_user_id
      using errcode = 'P0001';
  end if;

  select count(*)::integer
    into v_scope_count_before
    from public.direct_entry_scope_grants s
   where s.app_user_id = v_app_user_id;

  select count(*)::integer
    into v_other_cap_count_before
    from public.direct_entry_capability_grants g
   where g.app_user_id = v_app_user_id
     and g.capability <> 'offboarding_report_view';

  select count(*)::integer
    into v_current_cap_count
    from public.direct_entry_capability_grants g
   where g.app_user_id = v_app_user_id
     and g.capability = 'offboarding_report_view'
     and g.is_current
     and g.valid_from <= v_today
     and (g.valid_to is null or v_today < g.valid_to);

  if v_current_cap_count > 1 then
    raise exception 'tunk.mkt has ambiguous current offboarding_report_view grants'
      using errcode = 'P0001';
  elsif v_current_cap_count = 0 then
    select count(*)::integer
      into v_future_cap_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_app_user_id
       and g.capability = 'offboarding_report_view'
       and g.valid_from > v_today;

    if v_future_cap_count > 0 then
      raise exception 'tunk.mkt has a future offboarding_report_view grant; manual review required'
        using errcode = 'P0001';
    end if;

    select count(*)::integer
      into v_inactive_overlap_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_app_user_id
       and g.capability = 'offboarding_report_view'
       and g.valid_from <= v_today
       and (g.valid_to is null or v_today < g.valid_to);

    if v_inactive_overlap_count > 0 then
      raise exception 'tunk.mkt has an inactive overlapping offboarding_report_view interval; manual review required'
        using errcode = 'P0001';
    end if;

    insert into public.direct_entry_capability_grants (
      app_user_id,
      capability,
      valid_from,
      valid_to,
      is_current
    ) values (
      v_app_user_id,
      'offboarding_report_view',
      v_today,
      null,
      true
    );
  end if;

  -- Self-checks on provisioned DB:
  -- 1. Exactly one enabled app user holds `offboarding_report_view` for `tunk.mkt`.
  select count(distinct g.app_user_id)::integer
    into v_granted_user_count
    from public.direct_entry_capability_grants g
    join public.direct_entry_app_users u on u.app_user_id = g.app_user_id
   where g.capability = 'offboarding_report_view'
     and g.is_current
     and u.enabled;

  if v_granted_user_count <> 1 then
    raise exception 'self-check failed: expected exactly 1 enabled app user with current offboarding_report_view, found %',
      v_granted_user_count
      using errcode = '55000';
  end if;

  -- 2. New capability is effective for `tunk.mkt`.
  if not public.direct_entry_has_capability(v_app_user_id, 'offboarding_report_view') then
    raise exception 'self-check failed: offboarding_report_view is not effective for tunk.mkt'
      using errcode = '55000';
  end if;

  -- 3. No new scopes or unrelated capability changes were introduced.
  select count(*)::integer
    into v_scope_count_after
    from public.direct_entry_scope_grants s
   where s.app_user_id = v_app_user_id;

  select count(*)::integer
    into v_other_cap_count_after
    from public.direct_entry_capability_grants g
   where g.app_user_id = v_app_user_id
     and g.capability <> 'offboarding_report_view';

  if v_scope_count_after <> v_scope_count_before
     or v_other_cap_count_after <> v_other_cap_count_before then
    raise exception 'self-check failed: unexpected scope or unrelated capability mutation for tunk.mkt'
      using errcode = '55000';
  end if;

  -- 4. Authority resolves cleanly with can_phone=false, can_export=false, can_hide=false.
  v_auth := public.direct_entry_offboarding_authority(v_auth_subject, v_app_user_id);
  if coalesce((v_auth->>'can_phone')::boolean, true) is not false
     or coalesce((v_auth->>'can_export')::boolean, true) is not false
     or coalesce((v_auth->>'can_hide')::boolean, true) is not false then
    raise exception 'self-check failed: tunk.mkt must keep can_phone=false, can_export=false, can_hide=false (got %)',
      v_auth
      using errcode = '55000';
  end if;
end;
$grant_tunk_offboarding_report_view$;

-- -----------------------------------------------------------------------------
-- 6. Data-free security & posture self-check
-- -----------------------------------------------------------------------------
do $security_posture_self_check$
declare
  v_oid oid := 'public.direct_entry_offboarding_authority(uuid, uuid)'::pg_catalog.regprocedure;
  v_prosecdef boolean;
  v_proconfig text[];
  v_proowner oid;
  v_proacl aclitem[];
  v_rolsuper boolean;
  v_rolbypassrls boolean;
begin
  select p.prosecdef, p.proconfig, p.proowner, p.proacl, r.rolsuper, r.rolbypassrls
    into v_prosecdef, v_proconfig, v_proowner, v_proacl, v_rolsuper, v_rolbypassrls
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = v_oid;

  if not coalesce(v_prosecdef, false) then
    raise exception 'direct_entry_offboarding_authority must be SECURITY DEFINER'
      using errcode = '55000';
  end if;

  if v_proconfig is null or not ('search_path=pg_catalog, public' = any(v_proconfig)) then
    raise exception 'direct_entry_offboarding_authority must lock search_path=pg_catalog, public'
      using errcode = '55000';
  end if;

  if not (coalesce(v_rolsuper, false) or coalesce(v_rolbypassrls, false)) then
    raise exception 'owner of direct_entry_offboarding_authority must bypass FORCE RLS'
      using errcode = '55000';
  end if;

  if not pg_catalog.has_function_privilege(v_proowner, v_oid, 'EXECUTE') then
    raise exception 'owner of direct_entry_offboarding_authority lacks EXECUTE'
      using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
     or exists (
       select 1
         from pg_catalog.aclexplode(coalesce(v_proacl, pg_catalog.acldefault('f', v_proowner))) a
        where a.grantee = 0
          and a.privilege_type = 'EXECUTE'
     ) then
    raise exception 'direct_entry_offboarding_authority must remain revoked from PUBLIC, anon, authenticated, and service_role'
      using errcode = '55000';
  end if;
end;
$security_posture_self_check$;

commit;
