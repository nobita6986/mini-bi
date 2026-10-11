-- =============================================================================
-- P3.1-W03A-R2 - Existing-account bounded read boundary (#83, append-only).
--
-- Scope: Full-Admin-only list/detail projections for existing app users. The
-- enable/disable lifecycle remains owned by W03A #82 and is called directly.
-- No child authority, audit, or P3.2 surface is exposed here.
-- =============================================================================

begin;

create or replace function public.direct_entry_app_user_projection(
  p_app_user public.direct_entry_app_users
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'account_ref', p_app_user.app_user_id,
    'account_label', 'TK-' || substring(md5(p_app_user.app_user_id::text) from 1 for 8),
    'enabled', p_app_user.enabled,
    'version', p_app_user.version
  )
$$;
revoke all on function public.direct_entry_app_user_projection(public.direct_entry_app_users)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_app_user_projection(public.direct_entry_app_users) is
  'P3.1-W03A-R2 internal four-key account projection. No auth subject, email, UUID display, authority, reason or audit data.';

create or replace function public.direct_entry_list_app_users_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
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
  v_total integer;
  v_accounts jsonb;
  v_offset integer;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_enabled is null or p_enabled not in ('all', 'true', 'false')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'account list query is invalid' using errcode = '22023';
  end if;

  v_offset := (p_page - 1) * p_page_size;

  select count(*)::integer into v_total
    from public.direct_entry_app_users u
   where p_enabled = 'all'
      or (p_enabled = 'true' and u.enabled)
      or (p_enabled = 'false' and not u.enabled);

  select coalesce(jsonb_agg(public.direct_entry_app_user_projection(u)
                           order by u.app_user_id), '[]'::jsonb)
    into v_accounts
    from (
      select u.*
        from public.direct_entry_app_users u
       where p_enabled = 'all'
          or (p_enabled = 'true' and u.enabled)
          or (p_enabled = 'false' and not u.enabled)
       order by u.app_user_id
       limit p_page_size offset v_offset
    ) u;

  return jsonb_build_object(
    'enabled', p_enabled,
    'page', p_page,
    'page_size', p_page_size,
    'total', v_total,
    'accounts', v_accounts
  );
end;
$$;
revoke all on function public.direct_entry_list_app_users_admin(uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_app_users_admin(uuid, uuid, text, integer, integer)
  to service_role;
comment on function public.direct_entry_list_app_users_admin(uuid, uuid, text, integer, integer) is
  'P3.1-W03A-R2 bounded Full-Admin-only account list. Stable app_user_id order; exact four-key rows and exact list envelope.';

create or replace function public.direct_entry_get_app_user_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_account public.direct_entry_app_users;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_target_app_user_id is null then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  return public.direct_entry_app_user_projection(v_account);
end;
$$;
revoke all on function public.direct_entry_get_app_user_admin(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_get_app_user_admin(uuid, uuid, uuid)
  to service_role;
comment on function public.direct_entry_get_app_user_admin(uuid, uuid, uuid) is
  'P3.1-W03A-R2 bounded Full-Admin-only account detail. Target UUID is an opaque internal request reference.';

-- Migration self-check: no raw identity fields or broad authority projection are
-- present in the SQL projection, and both read RPCs remain service-role-only.
do $$
declare
  v_definition text;
  v_name text;
begin
  select pg_get_functiondef(
    'public.direct_entry_app_user_projection(public.direct_entry_app_users)'::regprocedure
  ) into v_definition;
  foreach v_name in array array['auth_subject', 'email', 'capability', 'scope', 'reason', 'audit', 'recruiter'] loop
    if v_definition ilike '%' || v_name || '%' then
      raise exception 'account projection leaks %', v_name using errcode = '55000';
    end if;
  end loop;

  foreach v_name in array array[
    'public.direct_entry_list_app_users_admin(uuid,uuid,text,integer,integer)',
    'public.direct_entry_get_app_user_admin(uuid,uuid,uuid)'
  ] loop
    if has_function_privilege('public', v_name, 'EXECUTE')
       or has_function_privilege('anon', v_name, 'EXECUTE')
       or has_function_privilege('authenticated', v_name, 'EXECUTE') then
      raise exception 'account read function is exposed: %', v_name using errcode = '55000';
    end if;
  end loop;
end;
$$;

commit;
