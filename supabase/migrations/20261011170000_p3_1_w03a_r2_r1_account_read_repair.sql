-- =============================================================================
-- P3.1-W03A-R2-R1 - Repair account read contract (#84, append-only).
--
-- Migration #83 exposed the wrong hash label and had no search input. This
-- migration retires that list signature and replaces the effective projection
-- with the canonical server-side display_name from #62.
-- =============================================================================

begin;

drop function public.direct_entry_list_app_users_admin(uuid, uuid, text, integer, integer);

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
    'display_name', p_app_user.display_name,
    'enabled', p_app_user.enabled,
    'version', p_app_user.version
  )
$$;
revoke all on function public.direct_entry_app_user_projection(public.direct_entry_app_users)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_app_user_projection(public.direct_entry_app_users) is
  'P3.1-W03A-R2-R1 internal four-key account projection. Uses canonical display_name; no auth subject, email, UUID label, authority, reason or audit data.';

create function public.direct_entry_list_app_users_admin(
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
   where (v_search is null or u.display_name ilike '%' || v_search || '%')
     and (p_enabled = 'all'
       or (p_enabled = 'true' and u.enabled)
       or (p_enabled = 'false' and not u.enabled));

  select coalesce(jsonb_agg(public.direct_entry_app_user_projection(u)
                           order by u.display_name, u.app_user_id), '[]'::jsonb)
    into v_accounts
    from (
      select u.*
        from public.direct_entry_app_users u
       where (v_search is null or u.display_name ilike '%' || v_search || '%')
         and (p_enabled = 'all'
           or (p_enabled = 'true' and u.enabled)
           or (p_enabled = 'false' and not u.enabled))
       order by u.display_name, u.app_user_id
       limit p_page_size offset v_offset
    ) u;

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
  'P3.1-W03A-R2-R1 bounded Full-Admin-only account list. Canonical display_name search, stable display_name/app_user_id order, exact six-key envelope.';

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

-- The obsolete #83 list signature must not remain callable by service_role.
do $$
declare
  v_definition text;
  v_name text;
begin
  if to_regprocedure('public.direct_entry_list_app_users_admin(uuid,uuid,text,integer,integer)') is not null then
    raise exception 'obsolete account list signature remains' using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'public.direct_entry_app_user_projection(public.direct_entry_app_users)'::regprocedure
  ) into v_definition;
  foreach v_name in array array['account_label', 'auth_subject', 'email', 'capability', 'scope', 'reason', 'audit', 'recruiter'] loop
    if v_definition ilike '%' || v_name || '%' then
      raise exception 'account projection leaks %', v_name using errcode = '55000';
    end if;
  end loop;
  foreach v_name in array array[
    'public.direct_entry_list_app_users_admin(uuid,uuid,text,text,integer,integer)',
    'public.direct_entry_get_app_user_admin(uuid,uuid,uuid)'
  ] loop
    if has_function_privilege('public', v_name, 'EXECUTE')
       or has_function_privilege('anon', v_name, 'EXECUTE')
       or has_function_privilege('authenticated', v_name, 'EXECUTE')
       or not has_function_privilege('service_role', v_name, 'EXECUTE') then
      raise exception 'account read ACL is invalid: %', v_name using errcode = '55000';
    end if;
  end loop;
end;
$$;

commit;
