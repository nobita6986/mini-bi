-- P2.5-HF-R5 — session identity header (#62).
--
-- Base: origin/main@910fa2f (61 migrations).
-- Adds the canonical account display name used by the header identity control.
--
-- 1. direct_entry_app_users.display_name text: NOT NULL, canonical (stored value
--    equals its btrim), length 1..256, NOT unique.
-- 2. Backfill from the login identifier of the mapped auth user (local part
--    before "@"), used by the migration only - never a runtime authority.
-- 3. Fail-closed: any app user without a mapped auth user, or without a usable
--    login label, aborts the migration. No generic placeholder, no UUID.
-- 4. direct_entry_resolve_actor_context now returns the canonical display_name so
--    the actor projection is the single server-side source.
-- No email, auth_subject or login metadata is returned by the actor context RPC.

begin;

alter table public.direct_entry_app_users
  add column display_name text;

do $hf_r5_backfill$
declare
  v_has_email boolean;
  v_pending integer;
  v_unmapped integer;
  v_unusable integer;
  v_missing integer;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'users' and column_name = 'email'
  ) into v_has_email;

  select count(*) into v_pending
    from public.direct_entry_app_users where display_name is null;

  if v_pending > 0 then
    if not v_has_email then
      raise exception 'HF-R5 refused: % app user(s) need a display name but auth.users.email is unavailable', v_pending;
    end if;

    select count(*) into v_unmapped
      from public.direct_entry_app_users u
     where not exists (select 1 from auth.users a where a.id = u.auth_subject);
    if v_unmapped <> 0 then
      raise exception 'HF-R5 refused: % app user(s) have no mapped auth user', v_unmapped;
    end if;

    select count(*) into v_unusable
      from public.direct_entry_app_users u
      join auth.users a on a.id = u.auth_subject
     where a.email is null
        or position('@' in a.email) = 0
        or length(btrim(split_part(a.email, '@', 1))) not between 1 and 256;
    if v_unusable <> 0 then
      raise exception 'HF-R5 refused: % app user(s) have no usable login label', v_unusable;
    end if;

    update public.direct_entry_app_users u
       set display_name = btrim(split_part(a.email, '@', 1))
      from auth.users a
     where a.id = u.auth_subject
       and u.display_name is null;
  end if;

  select count(*) into v_missing
    from public.direct_entry_app_users
   where display_name is null or display_name <> btrim(display_name)
      or length(display_name) not between 1 and 256;
  if v_missing <> 0 then
    raise exception 'HF-R5 refused: % app user(s) lack a canonical display name', v_missing;
  end if;
end
$hf_r5_backfill$;

alter table public.direct_entry_app_users
  alter column display_name set not null;

alter table public.direct_entry_app_users
  add constraint direct_entry_app_users_display_name_canonical
  check (display_name = btrim(display_name) and length(display_name) between 1 and 256);

comment on column public.direct_entry_app_users.display_name is
  'P2.5-HF-R5 canonical account display name. Server-side identity source for the header; never derived from the browser.';

create or replace function public.direct_entry_resolve_actor_context(
  p_auth_subject uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_app_user_id uuid;
  v_today date := (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  select u.app_user_id
    into v_app_user_id
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;

  if not found then
    return null;
  end if;

  return (
    select jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce((
        select jsonb_agg(distinct g.capability order by g.capability)
          from public.direct_entry_capability_grants g
         where g.app_user_id = u.app_user_id
           and g.valid_from <= v_today
           and (g.valid_to is null or v_today < g.valid_to)
      ), '[]'::jsonb),
      'recruiter_links', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', l.app_user_id,
          'recruiter_id', l.recruiter_id,
          'verified', l.verified,
          'valid_from', l.valid_from,
          'valid_to', l.valid_to
        ) order by l.valid_from, l.recruiter_id)
          from public.direct_entry_app_user_recruiter_links l
         where l.app_user_id = u.app_user_id
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object(
          'team_id', t.team_id,
          'code', t.code,
          'display', t.display_name,
          'active', t.active
        ) order by t.team_id)
          from public.teams t
         where exists (
           select 1
             from public.direct_entry_scope_grants g
            where g.app_user_id = u.app_user_id
              and g.scope_kind = 'team'
              and g.team_id = t.team_id
         )
      ), '[]'::jsonb),
      'team_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object(
          'team_id', g.team_id,
          'valid_from', g.valid_from,
          'valid_to', g.valid_to
        ) order by g.valid_from, g.team_id)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id
           and g.scope_kind = 'team'
      ), '[]'::jsonb),
      'all_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object(
          'valid_from', g.valid_from,
          'valid_to', g.valid_to
        ) order by g.valid_from)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id
           and g.scope_kind = 'all'
      ), '[]'::jsonb)
    )
      from public.direct_entry_app_users u
     where u.app_user_id = v_app_user_id
  );
end;
$$;

revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_actor_context(uuid)
  to service_role;

do $hf_r5_check$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'direct_entry_app_users'
       and column_name = 'display_name' and is_nullable = 'NO'
  ) then
    raise exception 'HF-R5 self-check failed: display_name is not NOT NULL';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.direct_entry_app_users'::regclass
       and conname = 'direct_entry_app_users_display_name_canonical'
  ) then
    raise exception 'HF-R5 self-check failed: canonical check missing';
  end if;
  if exists (
    select 1 from public.direct_entry_app_users
     where display_name is null or display_name = '' or display_name <> btrim(display_name)
  ) then
    raise exception 'HF-R5 self-check failed: non-canonical display name present';
  end if;
  if has_function_privilege('authenticated', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') then
    raise exception 'HF-R5 self-check failed: actor context must stay service-role only';
  end if;
end
$hf_r5_check$;

commit;
