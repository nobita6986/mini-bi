-- PRE-W2-HF account list: show the linked recruiter's real name and the
-- Auth login ID, without returning the account email or auth subject.

begin;

create or replace function public.direct_entry_app_user_projection(
  p_app_user public.direct_entry_app_users
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_display_name text;
  v_login_id text;
begin
  select r.display_name into v_display_name
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.app_user_id = p_app_user.app_user_id
     and l.verified
     and l.valid_from <= public.direct_entry_authorization_date()
     and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
   order by l.valid_from desc, l.link_id desc
   limit 1;

  select lower(nullif(split_part(u.email, '@', 1), '')) into v_login_id
    from auth.users u
   where u.id = p_app_user.auth_subject;

  return jsonb_build_object(
    'account_ref', p_app_user.app_user_id,
    'display_name', coalesce(v_display_name, nullif(p_app_user.display_name, v_login_id)),
    'login_id', v_login_id,
    'enabled', p_app_user.enabled,
    'version', p_app_user.version
  );
end;
$$;
revoke all on function public.direct_entry_app_user_projection(public.direct_entry_app_users)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_app_user_projection(public.direct_entry_app_users) is
  'Internal Full-Admin account projection: linked recruiter real name, Auth email local-part as login_id, status/version. Never returns email or auth subject.';

create or replace function public.direct_entry_list_app_users_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_enabled text default 'all',
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_search text;
  v_total integer;
  v_accounts jsonb;
  v_offset integer;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_search is not null and (btrim(p_search) = '' or length(p_search) > 256)
     or p_enabled is null or p_enabled not in ('all', 'true', 'false')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'account list query is invalid' using errcode = '22023';
  end if;
  v_search := nullif(btrim(p_search), '');
  v_offset := (p_page - 1) * p_page_size;

  select count(*)::integer into v_total
    from public.direct_entry_app_users u
    join auth.users au on au.id = u.auth_subject
    left join lateral (
      select r.display_name
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified
         and l.valid_from <= public.direct_entry_authorization_date()
         and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where (v_search is null
       or coalesce(linked.display_name, u.display_name) ilike '%' || v_search || '%'
       or split_part(au.email, '@', 1) ilike '%' || v_search || '%')
     and (p_enabled = 'all'
       or (p_enabled = 'true' and u.enabled)
       or (p_enabled = 'false' and not u.enabled));

  select coalesce(jsonb_agg(public.direct_entry_app_user_projection(account_row.app_user)
                           order by account_row.resolved_name, account_row.resolved_login), '[]'::jsonb)
    into v_accounts
    from (
      select u as app_user,
             u.*,
             coalesce(linked.display_name, u.display_name) as resolved_name,
             split_part(au.email, '@', 1) as resolved_login
        from public.direct_entry_app_users u
        join auth.users au on au.id = u.auth_subject
        left join lateral (
          select r.display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified
             and l.valid_from <= public.direct_entry_authorization_date()
             and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
       where (v_search is null
           or coalesce(linked.display_name, u.display_name) ilike '%' || v_search || '%'
           or split_part(au.email, '@', 1) ilike '%' || v_search || '%')
         and (p_enabled = 'all'
           or (p_enabled = 'true' and u.enabled)
           or (p_enabled = 'false' and not u.enabled))
       order by coalesce(linked.display_name, u.display_name), split_part(au.email, '@', 1)
       limit p_page_size offset v_offset
    ) account_row;

  return jsonb_build_object(
    'search', v_search,
    'enabled', p_enabled,
    'page', p_page,
    'page_size', p_page_size,
    'total', v_total,
    'accounts', v_accounts
  );
end;
$$;
revoke all on function public.direct_entry_list_app_users_admin(uuid, uuid, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_app_users_admin(uuid, uuid, text, text, integer, integer)
  to service_role;
comment on function public.direct_entry_list_app_users_admin(uuid, uuid, text, text, integer, integer) is
  'Bounded Full-Admin-only account list. Searches/sorts by linked real name and login ID; response omits full email and auth subject.';

-- Personnel-from-account uses the account's real display name and canonical
-- login ID. The RPC independently verifies the ID against Auth before writing.
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
  if p_valid_from is null or p_valid_from > public.direct_entry_authorization_date() then
    raise exception 'provider valid from is invalid' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
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
       and l.valid_from <= public.direct_entry_authorization_date()
       and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
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

create or replace function public.direct_entry_account_operation_list_eligible_accounts(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_total integer;
  v_rows jsonb;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'account list pagination invalid' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;
  select count(*)::int into v_total
    from public.direct_entry_app_users u join auth.users au on au.id = u.auth_subject
   where u.enabled
     and public.direct_entry_is_canonical_login_id(lower(split_part(au.email, '@', 1)))
     and not exists (
       select 1 from public.direct_entry_app_user_recruiter_links l
        where l.app_user_id = u.app_user_id and l.verified
          and l.valid_from <= public.direct_entry_authorization_date()
          and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
     );
  select coalesce(jsonb_agg(a.row_json order by a.display_name, a.login_id, a.app_user_id), '[]'::jsonb)
    into v_rows from (
      select jsonb_build_object('app_user_id', u.app_user_id, 'display_name', u.display_name,
               'login_id', lower(split_part(au.email, '@', 1))) as row_json,
             u.display_name, lower(split_part(au.email, '@', 1)) as login_id, u.app_user_id
        from public.direct_entry_app_users u join auth.users au on au.id = u.auth_subject
       where u.enabled
         and public.direct_entry_is_canonical_login_id(lower(split_part(au.email, '@', 1)))
         and not exists (
           select 1 from public.direct_entry_app_user_recruiter_links l
            where l.app_user_id = u.app_user_id and l.verified
              and l.valid_from <= public.direct_entry_authorization_date()
              and (l.valid_to is null or public.direct_entry_authorization_date() < l.valid_to)
         )
       order by u.display_name, lower(split_part(au.email, '@', 1)), u.app_user_id
       limit v_page_size + 1 offset v_offset
    ) a;
  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb) into v_rows
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord) where t.ord <= v_page_size;
  end if;
  return jsonb_build_object('page', v_page, 'page_size', v_page_size, 'total', v_total,
    'has_more', v_has_more, 'accounts', v_rows);
end;
$$;
revoke all on function public.direct_entry_account_operation_list_eligible_accounts(uuid, uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_list_eligible_accounts(uuid, uuid, integer, integer)
  to service_role;
comment on function public.direct_entry_account_operation_list_eligible_accounts(uuid, uuid, integer, integer) is
  'Bounded Full-Admin-only account selector returns real display_name and login_id only; never email/auth_subject.';

do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.direct_entry_list_app_users_admin(uuid,uuid,text,text,integer,integer)'::regprocedure
  ) into v_definition;
  if v_definition not ilike '%direct_entry_assert_actor_app_user_admin%'
     or v_definition not ilike '%p_page_size%'
     or has_function_privilege('public', 'public.direct_entry_list_app_users_admin(uuid,uuid,text,text,integer,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.direct_entry_list_app_users_admin(uuid,uuid,text,text,integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.direct_entry_list_app_users_admin(uuid,uuid,text,text,integer,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.direct_entry_list_app_users_admin(uuid,uuid,text,text,integer,integer)', 'EXECUTE') then
    raise exception 'account real-name list guard or ACL is invalid' using errcode = '55000';
  end if;
end;
$$;

commit;
