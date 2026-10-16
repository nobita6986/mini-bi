-- PRE-W2-HF: give account-created HRP personnel the same own-entry baseline
-- as other HRP users, atomically with creating their recruiter link.
begin;

create or replace function public.direct_entry_account_operation_create_personnel(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_account_ref uuid,
  p_expected_account_version integer,
  p_personnel_code text,
  p_personnel_position text,
  p_valid_from date,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_action text := 'personnel_created';
  v_code text := lower(btrim(p_personnel_code));
  v_login_id text;
  v_position text := p_personnel_position;
  v_account public.direct_entry_app_users;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_recruiter public.recruiters;
  v_membership_id uuid;
  v_link_id uuid;
  v_personnel_revision_id uuid;
  v_app_user_revision_id uuid;
  v_result jsonb;
  v_capability text;
  v_today date := public.direct_entry_authorization_date();
  v_next_capability_start date;
  v_next_scope_start date;
begin
  if p_account_ref is null or p_expected_account_version is null or p_expected_account_version < 1 then
    raise exception 'account reference or version invalid' using errcode = '22023';
  end if;
  if v_code is null or not public.direct_entry_is_canonical_login_id(v_code) then
    raise exception 'personnel code must be the account login ID' using errcode = '22023';
  end if;
  if v_position is null or v_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  if p_valid_from is null or p_valid_from > v_today then
    raise exception 'provider valid from is invalid' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'account_ref', p_account_ref, 'expected_account_version', p_expected_account_version,
    'personnel_code', v_code, 'personnel_position', v_position,
    'valid_from', p_valid_from, 'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then return v_prior; end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref
   for update;
  if not found then raise exception 'account not found' using errcode = 'P0002'; end if;
  if not v_account.enabled then raise exception 'account is not enabled' using errcode = '23514'; end if;
  select lower(nullif(split_part(u.email, '@', 1), '')) into v_login_id
    from auth.users u where u.id = v_account.auth_subject;
  if v_login_id is null or not public.direct_entry_is_canonical_login_id(v_login_id)
     or v_code <> v_login_id then
    raise exception 'personnel code does not match account login ID' using errcode = '22023';
  end if;
  if lower(btrim(v_account.display_name)) = v_login_id then
    raise exception 'account real name must be updated before personnel creation' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref and l.verified
       and l.valid_from <= v_today
       and (l.valid_to is null or v_today < l.valid_to)
  ) then raise exception 'account already has an effective recruiter link' using errcode = '23514'; end if;
  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = '40001';
  end if;
  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then raise exception 'personnel code already exists' using errcode = '23505'; end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);
  insert into public.recruiters (display_name, personnel_code, personnel_position, active, version)
  values (v_account.display_name, v_code, v_position, true, 1)
  returning * into v_recruiter;
  insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, vendor_id)
  values (v_recruiter.recruiter_id, 'hrp', p_valid_from, null)
  returning membership_id into v_membership_id;
  insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from)
  values (p_account_ref, v_recruiter.recruiter_id, true, p_valid_from)
  returning link_id into v_link_id;

  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view',
    'pii_view', 'payment_view', 'pii_export'
  ]::text[]
  loop
    if not exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref and g.capability = v_capability
         and g.valid_from <= v_today and (g.valid_to is null or v_today < g.valid_to)
    ) then
      select min(g.valid_from) into v_next_capability_start
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref and g.capability = v_capability
         and g.valid_from > v_today;
      insert into public.direct_entry_capability_grants
        (app_user_id, capability, valid_from, valid_to)
      values (p_account_ref, v_capability, v_today, v_next_capability_start);
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if not exists (
    select 1 from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref and g.scope_kind = 'own'
       and g.valid_from <= v_today and (g.valid_to is null or v_today < g.valid_to)
  ) then
    select min(g.valid_from) into v_next_scope_start
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref and g.scope_kind = 'own'
       and g.valid_from > v_today;
    insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to)
    values (p_account_ref, 'own', v_today, v_next_scope_start);
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  update public.direct_entry_app_users set version = version + 1, updated_at = now()
   where app_user_id = p_account_ref returning version into v_account.version;
  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref, v_account.version, p_actor_app_user_id, 'link_create',
    jsonb_build_object('recruiter_id', null), jsonb_build_object('recruiter_id', v_recruiter.recruiter_id), v_reason_id
  ) returning revision_id into v_app_user_revision_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'link_create', 'entry_admin', p_account_ref::text,
    'all', 'APPLIED', v_reason_id, array['recruiter_link'], v_app_user_revision_id
  );
  v_personnel_revision_id := public.direct_entry_write_personnel_revision(
    v_recruiter.recruiter_id, v_recruiter.version, p_actor_app_user_id, v_reason_id,
    null, public.direct_entry_personnel_snapshot(v_recruiter)
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, personnel_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin', v_recruiter.recruiter_id::text,
    'all', 'APPLIED', v_reason_id, array['display_name', 'personnel_code', 'personnel_position', 'active'],
    v_personnel_revision_id
  );
  v_result := jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id, 'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code, 'personnel_position', v_recruiter.personnel_position,
    'version', v_recruiter.version, 'link_id', v_link_id, 'membership_id', v_membership_id,
    'app_user_version', v_account.version, 'app_user_revision_id', v_app_user_revision_id,
    'personnel_revision_id', v_personnel_revision_id
  );
  perform public.direct_entry_idempotency_finish(p_actor_app_user_id, v_action, p_idempotency_key, v_result);
  return v_result;
end;
$$;

revoke all on function public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)
  to service_role;

-- Repair accounts already linked to an effective HRP recruiter before this fix.
do $$
declare
  v_today date := public.direct_entry_authorization_date();
begin
  with hrp_accounts as (
    select distinct l.app_user_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiter_provider_memberships m on m.recruiter_id = l.recruiter_id
     where l.verified and l.valid_from <= v_today and (l.valid_to is null or v_today < l.valid_to)
       and m.provider_type = 'hrp'
       and m.valid_from <= v_today and (m.valid_to is null or v_today < m.valid_to)
  ), missing_grants as (
    select a.app_user_id, c.capability,
           (select min(g.valid_from) from public.direct_entry_capability_grants g
             where g.app_user_id = a.app_user_id and g.capability = c.capability
               and g.valid_from > v_today) as next_valid_from
      from hrp_accounts a
      cross join unnest(array[
        'entry_create', 'entry_own', 'submission_create', 'change_request_create',
        'employment_status.request', 'document_upload', 'document_view',
        'pii_view', 'payment_view', 'pii_export'
      ]::text[]) as c(capability)
     where not exists (
       select 1 from public.direct_entry_capability_grants g
        where g.app_user_id = a.app_user_id and g.capability = c.capability
          and g.valid_from <= v_today and (g.valid_to is null or v_today < g.valid_to)
     )
  ), inserted as (
    insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to)
    select app_user_id, capability, v_today, next_valid_from from missing_grants
    returning app_user_id, capability
  )
  insert into public.direct_entry_audit_events (action, capability, resource_ref, outcome, changed_fields)
  select 'capability_default_grant', capability, app_user_id::text, 'APPLIED', array['valid_from', 'valid_to']
    from inserted;

  with hrp_accounts as (
    select distinct l.app_user_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiter_provider_memberships m on m.recruiter_id = l.recruiter_id
     where l.verified and l.valid_from <= v_today and (l.valid_to is null or v_today < l.valid_to)
       and m.provider_type = 'hrp'
       and m.valid_from <= v_today and (m.valid_to is null or v_today < m.valid_to)
  ), missing_scopes as (
    select a.app_user_id,
           (select min(g.valid_from) from public.direct_entry_scope_grants g
             where g.app_user_id = a.app_user_id and g.scope_kind = 'own'
               and g.valid_from > v_today) as next_valid_from
      from hrp_accounts a
     where not exists (
       select 1 from public.direct_entry_scope_grants g
        where g.app_user_id = a.app_user_id and g.scope_kind = 'own'
          and g.valid_from <= v_today and (g.valid_to is null or v_today < g.valid_to)
     )
  ), inserted as (
    insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to)
    select app_user_id, 'own', v_today, next_valid_from from missing_scopes
    returning app_user_id
  )
  insert into public.direct_entry_audit_events (
    action, capability, resource_ref, scope_kind, outcome, changed_fields
  )
  select 'scope_default_grant', 'entry_own', app_user_id::text, 'own', 'APPLIED',
         array['scope_kind', 'valid_from', 'valid_to']
    from inserted;
end;
$$;

do $$
declare
  v_source text := pg_get_functiondef(
    'public.direct_entry_account_operation_create_personnel(uuid,uuid,uuid,integer,text,text,date,text,text)'::regprocedure
  );
begin
  if position('entry_own' in v_source) = 0
     or position('change_request_create' in v_source) = 0
     or position('scope_default_grant' in v_source) = 0
     or position('team_manager_assign' in v_source) <> 0
     or position('security definer' in lower(v_source)) = 0 then
    raise exception 'personnel-from-account default access self-check failed';
  end if;
end;
$$;

commit;
