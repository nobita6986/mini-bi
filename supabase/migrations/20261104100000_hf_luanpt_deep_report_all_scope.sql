begin;

do $grant_luanpt_deep_report$
declare
  v_account_count integer;
  v_app_user_id uuid;
  v_enabled boolean;
  v_today date := public.direct_entry_authorization_date();
  v_current_scope_count integer;
  v_effective_scope_count integer;
  v_future_scope_count integer;
begin
  select count(*)
    into v_account_count
    from public.direct_entry_app_users u
    join auth.users au on au.id = u.auth_subject
   where lower(btrim(au.email)) = 'luanpt@hrpartner.vn';

  if v_account_count = 0 then
    raise notice 'Skipping luanpt all-scope grant because luanpt@hrpartner.vn is not provisioned in this database';
    return;
  elsif v_account_count > 1 then
    raise exception 'expected exactly one app user for luanpt@hrpartner.vn';
  end if;

  select u.app_user_id, u.enabled
    into v_app_user_id, v_enabled
    from public.direct_entry_app_users u
    join auth.users au on au.id = u.auth_subject
   where lower(btrim(au.email)) = 'luanpt@hrpartner.vn';

  if not v_enabled then
    raise exception 'luanpt@hrpartner.vn must be enabled before granting all scope';
  end if;

  select count(*)
    into v_current_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = v_app_user_id
     and g.scope_kind = 'all'
     and g.team_id is null
     and g.is_current
     and g.valid_from <= v_today
     and (g.valid_to is null or v_today < g.valid_to);

  if v_current_scope_count > 1 then
    raise exception 'luanpt@hrpartner.vn has ambiguous current all-scope grants';
  elsif v_current_scope_count = 0 then
    select count(*)
      into v_future_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = v_app_user_id
       and g.scope_kind = 'all'
       and g.team_id is null
       and g.valid_from > v_today;

    if v_future_scope_count > 0 then
      raise exception 'luanpt@hrpartner.vn has a future all-scope grant; manual review required';
    end if;

    select count(*)
      into v_effective_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = v_app_user_id
       and g.scope_kind = 'all'
       and g.team_id is null
       and g.valid_from <= v_today
       and (g.valid_to is null or v_today < g.valid_to);

    if v_effective_scope_count > 0 then
      raise exception 'luanpt@hrpartner.vn has an inactive all-scope interval; manual review required';
    end if;

    insert into public.direct_entry_scope_grants (
      app_user_id, scope_kind, team_id, valid_from, valid_to, is_current
    ) values (
      v_app_user_id, 'all', null, v_today, null, true
    );
  end if;

  select count(*)
    into v_current_scope_count
    from public.direct_entry_scope_grants g
   where g.app_user_id = v_app_user_id
     and g.scope_kind = 'all'
     and g.team_id is null
     and g.is_current
     and g.valid_from <= v_today
     and (g.valid_to is null or v_today < g.valid_to);

  if v_current_scope_count <> 1 then
    raise exception 'failed to establish exactly one current all-scope grant for luanpt@hrpartner.vn';
  end if;
end;
$grant_luanpt_deep_report$;

commit;
