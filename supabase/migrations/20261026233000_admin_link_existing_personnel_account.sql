-- =============================================================================
-- Admin Link Existing Personnel Account (forward-only).
--
-- Adds Full Admin RPCs to inspect recruiter<->account link status on the HRP
-- personnel catalog, list server-filtered candidate accounts matching a
-- personnel profile's canonical personnel_code, and link an existing enabled BI
-- account (direct_entry_app_users) with an existing active HRP personnel profile
-- (recruiters) in a single transaction with OCC, idempotency, optional reason,
-- minimal HRP own-entry baseline grants, and immutable revision/audit records.
--
-- Does NOT create a new recruiters row and does NOT mutate recruiters fields,
-- team memberships, provider memberships, or existing business data.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Batch link-status lookup for HRP personnel rows on the current catalog page.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_account_operation_recruiter_link_status(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_recruiter_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_linked jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_recruiter_ids is null or cardinality(p_recruiter_ids) > 100
     or array_position(p_recruiter_ids, null) is not null then
    raise exception 'recruiter id batch invalid' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(distinct l.recruiter_id order by l.recruiter_id), '[]'::jsonb)
    into v_linked
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.recruiter_id = any(p_recruiter_ids)
     and l.verified
     and (l.is_current or l.valid_to is null or l.valid_to > v_today)
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and (m.is_current or (not r.active and m.valid_to is null
            and (select count(*) from public.recruiter_provider_memberships x
                  where x.recruiter_id = r.recruiter_id and x.valid_to is null) = 1))
     );

  return jsonb_build_object(
    'linked_recruiter_ids', v_linked
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 2. Server-filtered candidate accounts for linking an existing HRP recruiter.
--    Matches only enabled, unlinked accounts whose canonical login_id equals
--    the recruiter's canonical personnel_code (case-insensitive exact match).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_account_operation_recruiter_link_candidates(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_recruiter_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_recruiter public.recruiters;
  v_already_linked boolean;
  v_code text;
  v_candidates jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_recruiter_id is null then
    raise exception 'personnel required' using errcode = '22023';
  end if;

  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and (m.is_current or (not r.active and m.valid_to is null
            and (select count(*) from public.recruiter_provider_memberships x
                  where x.recruiter_id = r.recruiter_id and x.valid_to is null) = 1))
     );
  if not found then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;

  select exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = v_recruiter.recruiter_id
       and l.verified
       and (l.is_current or l.valid_to is null or l.valid_to > v_today)
  ) into v_already_linked;

  v_code := lower(btrim(coalesce(v_recruiter.personnel_code, '')));

  if not v_recruiter.active
     or v_already_linked
     or not public.direct_entry_is_canonical_login_id(v_code) then
    v_candidates := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(c.row_json order by c.display_name, c.login_id, c.app_user_id), '[]'::jsonb)
      into v_candidates
      from (
        select jsonb_build_object(
                 'app_user_id', u.app_user_id,
                 'display_name', u.display_name,
                 'login_id', lower(btrim(split_part(au.email, '@', 1))),
                 'version', u.version
               ) as row_json,
               u.display_name,
               lower(btrim(split_part(au.email, '@', 1))) as login_id,
               u.app_user_id
          from public.direct_entry_app_users u
          join auth.users au on au.id = u.auth_subject
         where u.enabled
           and lower(btrim(split_part(au.email, '@', 1))) = v_code
           and public.direct_entry_is_canonical_login_id(lower(btrim(split_part(au.email, '@', 1))))
           and not exists (
             select 1
               from public.direct_entry_app_user_recruiter_links l
              where l.app_user_id = u.app_user_id
                and l.verified
                and (l.is_current or l.valid_to is null or l.valid_to > v_today)
           )
         order by u.display_name, lower(btrim(split_part(au.email, '@', 1))), u.app_user_id
         limit 10
      ) c;
  end if;

  return jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id,
    'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code,
    'personnel_position', v_recruiter.personnel_position,
    'active', v_recruiter.active,
    'version', v_recruiter.version,
    'already_linked', v_already_linked,
    'candidates', v_candidates
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Link an existing enabled account with an existing active HRP recruiter.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_account_operation_link_recruiter(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_recruiter_id uuid,
  p_expected_recruiter_version integer,
  p_account_ref uuid,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'account_recruiter_link_create';
  v_today date := public.direct_entry_authorization_date();
  v_lock_key text;
  v_account public.direct_entry_app_users;
  v_recruiter public.recruiters;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_login_id text;
  v_code text;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_link_id uuid;
  v_capability text;
  v_next_capability_start date;
  v_next_scope_start date;
  v_app_user_revision_id uuid;
  v_result jsonb;
begin
  -- Authority first: only Full Admin triple + all scope may execute this operation.
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_recruiter_id is null
     or p_expected_recruiter_version is null
     or p_expected_recruiter_version < 1 then
    raise exception 'personnel reference or version invalid' using errcode = '22023';
  end if;
  if p_account_ref is null
     or p_expected_account_version is null
     or p_expected_account_version < 1 then
    raise exception 'account reference or version invalid' using errcode = '22023';
  end if;
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'expected_recruiter_version', p_expected_recruiter_version,
    'account_ref', p_account_ref,
    'expected_account_version', p_expected_account_version,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  for v_lock_key in
    select k
      from unnest(array[
        'recruiter-link:' || p_account_ref::text,
        'recruiter-link-recruiter:' || p_recruiter_id::text
      ]) as t(k)
     order by k
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref
   for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id
     and exists (
       select 1
         from public.recruiter_provider_memberships m
        where m.recruiter_id = r.recruiter_id
          and m.provider_type = 'hrp'
          and m.vendor_id is null
          and (m.is_current or (not r.active and m.valid_to is null
            and (select count(*) from public.recruiter_provider_memberships x
                  where x.recruiter_id = r.recruiter_id and x.valid_to is null) = 1))
     )
   for update;
  if not found then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;

  perform m.membership_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id = p_recruiter_id
   order by m.membership_id
   for update;

  if not v_account.enabled then
    raise exception 'account is not enabled' using errcode = '23514';
  end if;
  if not v_recruiter.active then
    raise exception 'personnel is not active' using errcode = '23514';
  end if;

  select count(*)::int,
         count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::int
    into v_provider_count, v_hrp_provider_count
    from public.recruiter_provider_memberships m
   where m.recruiter_id = p_recruiter_id
     and m.is_current;
  if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
    raise exception 'personnel requires an active HRP provider membership' using errcode = '23514';
  end if;

  if v_recruiter.personnel_position is not null
     and v_recruiter.personnel_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '23514';
  end if;

  v_code := lower(nullif(btrim(coalesce(v_recruiter.personnel_code, '')), ''));
  if v_code is null or not public.direct_entry_is_canonical_login_id(v_code) then
    raise exception 'personnel code is missing or not canonical for account linking' using errcode = '22023';
  end if;

  select lower(nullif(btrim(split_part(au.email, '@', 1)), ''))
    into v_login_id
    from auth.users au
   where au.id = v_account.auth_subject;
  if v_login_id is null
     or not public.direct_entry_is_canonical_login_id(v_login_id)
     or v_login_id <> v_code then
    raise exception 'personnel code does not match account login ID' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref
       and l.verified
       and (l.is_current or l.valid_to is null or l.valid_to > v_today)
  ) then
    raise exception 'account already has an effective recruiter link' using errcode = '23P01';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_recruiter_id
       and l.verified
       and (l.is_current or l.valid_to is null or l.valid_to > v_today)
  ) then
    raise exception 'personnel already has an effective account link' using errcode = '23P01';
  end if;

  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;
  if v_recruiter.version <> p_expected_recruiter_version then
    raise exception 'personnel version conflict' using errcode = '40001';
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_app_user_recruiter_links (
    app_user_id, recruiter_id, verified, valid_from, is_current
  ) values (
    p_account_ref, p_recruiter_id, true, v_today, true
  ) returning link_id into v_link_id;

  -- Provision only the minimal HRP own-entry baseline capabilities and own scope.
  -- Never grant all/team scope or Team Leader capabilities from personnel_position.
  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view'
  ]::text[]
  loop
    if not exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref
         and g.capability = v_capability
         and g.is_current
    ) then
      if exists (
        select 1
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_account_ref
           and g.capability = v_capability
           and g.valid_from <= v_today
           and (g.valid_to is null or v_today < g.valid_to)
      ) then
        update public.direct_entry_capability_grants g
           set is_current = true
         where g.app_user_id = p_account_ref
           and g.capability = v_capability
           and g.valid_from <= v_today
           and (g.valid_to is null or v_today < g.valid_to);
      else
        select min(g.valid_from)
          into v_next_capability_start
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_account_ref
           and g.capability = v_capability
           and g.valid_from > v_today;
        insert into public.direct_entry_capability_grants (
          app_user_id, capability, valid_from, valid_to, is_current
        ) values (
          p_account_ref, v_capability, v_today, v_next_capability_start, true
        );
      end if;
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if not exists (
    select 1
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref
       and g.scope_kind = 'own'
       and g.is_current
  ) then
    if exists (
      select 1
        from public.direct_entry_scope_grants g
       where g.app_user_id = p_account_ref
         and g.scope_kind = 'own'
         and g.valid_from <= v_today
         and (g.valid_to is null or v_today < g.valid_to)
    ) then
      update public.direct_entry_scope_grants g
         set is_current = true
       where g.app_user_id = p_account_ref
         and g.scope_kind = 'own'
         and g.valid_from <= v_today
         and (g.valid_to is null or v_today < g.valid_to);
    else
      select min(g.valid_from)
        into v_next_scope_start
        from public.direct_entry_scope_grants g
       where g.app_user_id = p_account_ref
         and g.scope_kind = 'own'
         and g.valid_from > v_today;
      insert into public.direct_entry_scope_grants (
        app_user_id, scope_kind, valid_from, valid_to, is_current
      ) values (
        p_account_ref, 'own', v_today, v_next_scope_start, true
      );
    end if;
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = now()
   where app_user_id = p_account_ref
  returning version into v_account.version;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref,
    v_account.version,
    p_actor_app_user_id,
    'link_create',
    jsonb_build_object('recruiter_id', null),
    jsonb_build_object('recruiter_id', v_recruiter.recruiter_id),
    v_reason_id
  ) returning revision_id into v_app_user_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject,
    p_actor_app_user_id,
    'link_create',
    'entry_admin',
    p_account_ref::text,
    'all',
    'APPLIED',
    v_reason_id,
    array['recruiter_link'],
    v_app_user_revision_id
  );

  v_result := jsonb_build_object(
    'link_id', v_link_id,
    'app_user_id', p_account_ref,
    'app_user_version', v_account.version,
    'app_user_revision_id', v_app_user_revision_id,
    'recruiter_id', v_recruiter.recruiter_id,
    'recruiter_version', v_recruiter.version,
    'personnel_code', v_recruiter.personnel_code,
    'valid_from', v_today
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Align routine ownership with canonical Direct Entry owner when permitted.
-- -----------------------------------------------------------------------------
do $align_recruiter_link_rpc_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_sig text;
  v_proc_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  foreach v_sig in array array[
    'public.direct_entry_account_operation_recruiter_link_status(uuid, uuid, uuid[])',
    'public.direct_entry_account_operation_recruiter_link_candidates(uuid, uuid, uuid)',
    'public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_sig);

    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;
end;
$align_recruiter_link_rpc_owners$;

-- -----------------------------------------------------------------------------
-- 5. Strict function ACLs (service_role only).
-- -----------------------------------------------------------------------------
revoke all on function public.direct_entry_account_operation_recruiter_link_status(uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_recruiter_link_status(uuid, uuid, uuid[])
  to service_role;

revoke all on function public.direct_entry_account_operation_recruiter_link_candidates(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_recruiter_link_candidates(uuid, uuid, uuid)
  to service_role;

revoke all on function public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 6. Install-time fail-closed catalog & ACL self-check.
-- -----------------------------------------------------------------------------
do $check_admin_link_existing_personnel_account$
declare
  v_rpc_fn pg_catalog.regprocedure;
  v_secdef boolean;
  v_config text;
  v_owner_bypasses_rls boolean;
begin
  foreach v_rpc_fn in array array[
    'public.direct_entry_account_operation_recruiter_link_status(uuid, uuid, uuid[])'::pg_catalog.regprocedure,
    'public.direct_entry_account_operation_recruiter_link_candidates(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)'::pg_catalog.regprocedure
  ]
  loop
    select p.prosecdef,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
           (r.rolsuper or r.rolbypassrls)
      into v_secdef, v_config, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_rpc_fn;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public'
       or not coalesce(v_owner_bypasses_rls, false) then
      raise exception 'Direct Entry account link RPC security definer owner/RLS/search_path drift on %', v_rpc_fn
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_rpc_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_rpc_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_rpc_fn, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(
             (select p2.proacl from pg_catalog.pg_proc p2 where p2.oid = v_rpc_fn),
             pg_catalog.acldefault('f', (select p2.proowner from pg_catalog.pg_proc p2 where p2.oid = v_rpc_fn))
           )) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege('service_role', v_rpc_fn, 'EXECUTE') then
      raise exception 'Direct Entry account link RPC EXECUTE ACL drift on %', v_rpc_fn
        using errcode = '55000';
    end if;
  end loop;
end;
$check_admin_link_existing_personnel_account$;

commit;
