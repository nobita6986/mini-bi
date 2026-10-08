-- P2.5-HF-R2 - one canonical CCCD rule for every episode guard, the lookup and the preflight.
--
-- The verified hole: #58 compares the stored national_id with btrim() and #59's lookup compares
-- digits only, so a historical value that still carries formatting characters ("0123 456 78901")
-- is the same person for the lookup but a different string for the guard. A new digits-only
-- episode could therefore be created while that episode was still active.
--
-- This migration does NOT edit #58/#59 (already pushed); it re-creates the three functions with
-- one shared rule and the same per-CCCD advisory-lock key, and it refuses to install when the
-- data already violates the invariant (#58 and #60 belong to the same maintenance window):
--   * canonical rule: digits only, business length 9 or 12, leading zero preserved as text;
--   * a stored value is compared through its digit form, so legacy formatting cannot hide a
--     duplicate; a value with no digits at all cannot be matched and is reported, never repaired.

-- -----------------------------------------------------------------------------
-- 1. Shared rule helpers.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_canonical_national_id(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select nullif(regexp_replace(btrim(coalesce(p_value, '')), '[^0-9]', '', 'g'), '')
$$;
revoke all on function public.direct_entry_canonical_national_id(text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_canonical_national_id(text) is
  'P2.5-HF-R2: digit form of a stored CMT/CCCD. Used to compare legacy values carrying formatting '
  'characters with canonical values. Returns NULL when the value holds no digit at all. It never '
  'rewrites stored data.';

create or replace function public.direct_entry_is_canonical_national_id(p_value text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_value is not null and p_value ~ '^([0-9]{9}|[0-9]{12})$'
$$;
revoke all on function public.direct_entry_is_canonical_national_id(text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_is_canonical_national_id(text) is
  'P2.5-HF-R2: the single canonical CMT/CCCD rule - ASCII digits only, business length 9 or 12.';

create or replace function public.direct_entry_national_id_lock_key(p_value text)
returns bigint
language sql
immutable
set search_path = pg_catalog
as $$
  select hashtextextended('worker-episode:' || public.direct_entry_canonical_national_id(p_value), 0)
$$;
revoke all on function public.direct_entry_national_id_lock_key(text)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_national_id_lock_key(text) is
  'P2.5-HF-R2: the per-CCCD transaction lock key shared by the create guard, the status-event '
  'guard and the lookup, so both spellings of one CCCD serialise on the same key.';

-- -----------------------------------------------------------------------------
-- 2. Create guard (#58 body, canonical comparison and the shared key).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_guard_active_episode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cccd text;
  v_conflict boolean;
begin
  if new.worker_details->'national_id'->>'state' is distinct from 'provided' then
    return new;
  end if;
  v_cccd := public.direct_entry_canonical_national_id(new.worker_details->'national_id'->>'value');
  if v_cccd is null then
    return new;
  end if;
  -- Serialize per canonical CCCD so two concurrent creates cannot both pass the check.
  perform pg_advisory_xact_lock(public.direct_entry_national_id_lock_key(v_cccd));
  select exists (
    select 1
      from public.direct_entries e
     where e.entry_id <> new.entry_id
       and e.deleted_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
       and public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value') = v_cccd
       and coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = e.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') <> 'OFF'
  ) into v_conflict;
  if v_conflict then
    raise exception 'worker_active_episode_exists' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_guard_active_episode()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_guard_active_episode() is
  'P2.5-HF-R2: a canonical CCCD may hold at most one episode whose latest status is not OFF. '
  'Legacy values with formatting characters are compared through their digit form, so they can no '
  'longer hide an active episode. The message never carries the CCCD or any other profile value.';

-- -----------------------------------------------------------------------------
-- 3. Status-event guard (#59 body, canonical comparison and the shared key).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_guard_episode_status_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cccd text;
  v_own_latest text;
  v_conflict boolean;
begin
  if new.status = 'OFF' then
    return new;
  end if;
  select public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value'),
         (
           select st.status
             from public.direct_entry_employment_status_events st
            where st.entry_id = e.entry_id
            order by st.version desc
            limit 1
         )
    into v_cccd, v_own_latest
    from public.direct_entries e
   where e.entry_id = new.entry_id;
  if v_cccd is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(public.direct_entry_national_id_lock_key(v_cccd));

  select exists (
    select 1
      from public.direct_entries e
     where e.entry_id <> new.entry_id
       and e.deleted_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
       and public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value') = v_cccd
       and coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = e.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') <> 'OFF'
  ) into v_conflict;
  if v_conflict then
    raise exception 'worker_active_episode_exists' using errcode = '23505';
  end if;

  if v_own_latest = 'OFF' and new.supersedes_event_id is null then
    raise exception 'worker_episode_reopen_forbidden' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function public.direct_entry_guard_episode_status_event()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_guard_episode_status_event() is
  'P2.5-HF-R2: keeps the one-active-episode-per-canonical-CCCD invariant on the status-event path, '
  'with the same normalization and the same lock key as the create guard. Neither message carries '
  'the CCCD or any other profile value.';

-- -----------------------------------------------------------------------------
-- 4. Preflight audit: safe counts only, no CCCD and no other PII.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_national_id_canonical_audit()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with live as (
    select e.entry_id,
           e.worker_details->'national_id'->>'value' as stored_value,
           public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value') as cccd,
           coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = e.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') as latest_status
      from public.direct_entries e
     where e.deleted_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
  )
  select jsonb_build_object(
    'national_id_entries', (select count(*) from live),
    'noncanonical_entries', (select count(*) from live
       where not public.direct_entry_is_canonical_national_id(stored_value)),
    'unmatchable_entries', (select count(*) from live where cccd is null),
    'duplicate_active_cccd_groups', (select count(*) from (
       select cccd from live where latest_status <> 'OFF' and cccd is not null
        group by cccd having count(*) > 1) as duplicated)
  )
$$;
revoke all on function public.direct_entry_national_id_canonical_audit()
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_national_id_canonical_audit() to service_role;
comment on function public.direct_entry_national_id_canonical_audit() is
  'P2.5-HF-R2 read-only preflight. Returns counts only: how many live episodes carry a CMT/CCCD, '
  'how many of those are not canonical, how many hold no digit at all, and how many canonical '
  'CCCDs already own more than one active episode. It never returns or logs a CCCD or any PII, and '
  'it never modifies data.';

-- -----------------------------------------------------------------------------
-- 5. Lookup: same rule, same lock key (same signature and ACL as #59).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_lookup_worker_episodes(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_display_name text default null,
  p_national_id text default null,
  p_page_size integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_raw_id text := nullif(btrim(coalesce(p_national_id, '')), '');
  v_cccd text;
  v_page_size integer := coalesce(p_page_size, 20);
  v_offset integer := coalesce(p_offset, 0);
  v_rows jsonb;
  v_workers jsonb;
  v_has_more boolean;
begin
  if p_project_id is null or btrim(p_project_id) = '' then
    raise exception 'worker_lookup_project_required' using errcode = '22023';
  end if;
  if v_raw_id is not null then
    v_cccd := public.direct_entry_canonical_national_id(v_raw_id);
    if v_cccd is null or not public.direct_entry_is_canonical_national_id(v_cccd) then
      raise exception 'worker_lookup_national_id_invalid' using errcode = '22023';
    end if;
  end if;
  if v_cccd is null and v_name is null then
    raise exception 'worker_lookup_query_required' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 50 or v_offset < 0 or v_offset > 5000 then
    raise exception 'worker_lookup_page_invalid' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
  end if;
  -- Same key as the two guards, so a lookup never reads a half-written CCCD identity.
  if v_cccd is not null then
    perform pg_advisory_xact_lock(public.direct_entry_national_id_lock_key(v_cccd));
  end if;

  with keys as (
    select distinct
           public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value') as cccd
      from public.direct_entries e
     where e.deleted_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
       and public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value') is not null
       and (
         case
           when v_cccd is not null then
             public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value') = v_cccd
           else
             e.project_id = p_project_id
             and lower(btrim(coalesce(e.worker_details->>'display_name', ''))) = lower(v_name)
         end
       )
  ),
  episodes as (
    select e.entry_id,
           e.project_id,
           e.employee_code,
           e.first_work_date,
           nullif(btrim(coalesce(e.worker_details->>'display_name', '')), '') as display_name,
           k.cccd
      from public.direct_entries e
      join keys k
        on k.cccd = public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value')
     where e.deleted_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
  ),
  grouped as (
    select ep.cccd,
           count(*)::int as episode_count,
           (array_agg(ep.display_name order by ep.first_work_date desc, ep.entry_id desc))[1] as display_name,
           (array_agg(ep.employee_code order by ep.first_work_date desc, ep.entry_id desc))[1] as employee_code,
           max(ep.first_work_date) as latest_first_work_date,
           bool_or(coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = ep.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') <> 'OFF') as active_episode_exists
      from episodes ep
     group by ep.cccd
  )
  select coalesce(jsonb_agg(w.row_json order by w.latest_first_work_date desc, w.cccd), '[]'::jsonb)
    into v_rows
    from (
      select g.cccd,
             g.latest_first_work_date,
             jsonb_build_object(
               'display_name', g.display_name,
               'employee_code', g.employee_code,
               'episode_count', g.episode_count,
               'active_episode_exists', g.active_episode_exists,
               'rehire_allowed', not g.active_episode_exists,
               'episodes', (
                 select coalesce(jsonb_agg(jsonb_build_object(
                          'entry_id', ep.entry_id,
                          'display_name', ep.display_name,
                          'employee_code', ep.employee_code,
                          'project_id', ep.project_id,
                          'project_display', pj.display_name,
                          'first_work_date', pg_catalog.to_char(ep.first_work_date, 'YYYY-MM-DD'),
                          'latest_status', coalesce((
                            select st.status
                              from public.direct_entry_employment_status_events st
                             where st.entry_id = ep.entry_id
                             order by st.version desc
                             limit 1
                          ), 'UNCONFIRMED')
                        ) order by ep.first_work_date desc, ep.entry_id desc), '[]'::jsonb)
                   from episodes ep
                   join public.direct_entry_projects pj on pj.project_id = ep.project_id
                  where ep.cccd = g.cccd
               )
             ) as row_json
        from grouped g
       order by g.latest_first_work_date desc, g.cccd
       limit v_page_size + 1
      offset v_offset
    ) w;

  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb)
      into v_workers
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
     where t.ord <= v_page_size;
  else
    v_workers := v_rows;
  end if;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'project_id', p_project_id,
    'match', case when v_cccd is not null then 'national_id' else 'display_name' end,
    'page_size', v_page_size,
    'offset', v_offset,
    'has_more', v_has_more,
    'workers', v_workers
  );
end;
$$;
revoke all on function public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)
  to service_role;
comment on function public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer) is
  'P2.5-HF-R2 bounded episode lookup. Matches an exact canonical CCCD (digits only, business length '
  '9 or 12, leading zero preserved) or a display name inside the target project, compares stored '
  'values through the shared digit rule so a legacy formatted value is still found, and takes the '
  'same per-CCCD advisory lock as both episode guards. Same minimum field set and same authority '
  'rule as #59.';

-- -----------------------------------------------------------------------------
-- 6. Install-time preflight and self-check.
-- -----------------------------------------------------------------------------
do $p2_5_hf_r2$
declare
  v_audit jsonb;
  v_source text;
  v_valid jsonb;
  v_invalid jsonb;
begin
  v_audit := public.direct_entry_national_id_canonical_audit();
  if (v_audit->>'duplicate_active_cccd_groups')::int > 0
     or (v_audit->>'noncanonical_entries')::int > 0 then
    -- Counts only: no CCCD, no name, no other value is ever put in the message or the log.
    raise exception 'p2_5_hf_r2_national_id_preflight_failed' using errcode = '23514',
      hint = format('noncanonical_entries=%s duplicate_active_cccd_groups=%s',
        v_audit->>'noncanonical_entries', v_audit->>'duplicate_active_cccd_groups');
  end if;

  -- One rule, both directions, including the leading zero.
  if public.direct_entry_canonical_national_id('0123 456 78901') <> '012345678901'
     or public.direct_entry_canonical_national_id('012345678') <> '012345678'
     or public.direct_entry_canonical_national_id('NOT-REAL') is not null then
    raise exception 'P2.5-HF-R2 canonical national id rule is broken';
  end if;
  if not public.direct_entry_is_canonical_national_id('012345678')
     or not public.direct_entry_is_canonical_national_id('012345678901')
     or public.direct_entry_is_canonical_national_id('0123 456 78901')
     or public.direct_entry_is_canonical_national_id('12345678')
     or public.direct_entry_is_canonical_national_id('1234567890123') then
    raise exception 'P2.5-HF-R2 canonical national id lengths are broken';
  end if;
  -- Both spellings of one CCCD must land on exactly the same lock key.
  if public.direct_entry_national_id_lock_key('012345678901')
     <> public.direct_entry_national_id_lock_key('0123 456 78901') then
    raise exception 'P2.5-HF-R2 the guards and the lookup do not share one lock key';
  end if;

  -- The write-side validator (W07C-R2) must keep enforcing the very same rule.
  v_valid := jsonb_build_object(
    'display_name', 'R2 self check',
    'date_of_birth', jsonb_build_object('state', 'omitted'),
    'national_id', jsonb_build_object('state', 'provided', 'value', '012345678'),
    'address', jsonb_build_object('state', 'omitted'),
    'phone', jsonb_build_object('state', 'omitted'));
  v_invalid := jsonb_set(v_valid, '{national_id,value}', to_jsonb('0123 456 78901'::text));
  if not public.direct_entry_valid_worker_details(v_valid) then
    raise exception 'P2.5-HF-R2 the worker_details validator rejects a canonical national id';
  end if;
  if public.direct_entry_valid_worker_details(v_invalid)
     or public.direct_entry_valid_worker_details(
          jsonb_set(v_valid, '{national_id,value}', to_jsonb('12345678'::text))) then
    raise exception 'P2.5-HF-R2 the worker_details validator is not canonical';
  end if;

  for v_source in
    select p.prosrc from pg_proc p where p.oid in (
      'public.direct_entry_guard_active_episode()'::regprocedure,
      'public.direct_entry_guard_episode_status_event()'::regprocedure,
      'public.direct_entry_lookup_worker_episodes(uuid,uuid,text,text,text,integer,integer)'::regprocedure)
  loop
    if position('direct_entry_canonical_national_id' in v_source) = 0
       or position('direct_entry_national_id_lock_key' in v_source) = 0 then
      raise exception 'P2.5-HF-R2 a guard or the lookup lost the shared canonical rule';
    end if;
  end loop;

  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_national_id_canonical_audit()'::regprocedure;
  if position('duplicate_active_cccd_groups' in v_source) = 0
     or position('display_name' in v_source) > 0
     or position('employee_code' in v_source) > 0
     or position('date_of_birth' in v_source) > 0 then
    raise exception 'P2.5-HF-R2 the preflight audit must return counts only';
  end if;
  if position('update ' in lower(v_source)) > 0 or position('delete ' in lower(v_source)) > 0 then
    raise exception 'P2.5-HF-R2 the preflight audit must not modify data';
  end if;

  if has_function_privilege('anon',
       'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)', 'EXECUTE')
     or not has_function_privilege('service_role',
       'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)', 'EXECUTE')
     or not has_function_privilege('service_role',
       'public.direct_entry_national_id_canonical_audit()', 'EXECUTE')
     or has_function_privilege('service_role',
       'public.direct_entry_canonical_national_id(text)', 'EXECUTE')
     or has_function_privilege('service_role',
       'public.direct_entry_is_canonical_national_id(text)', 'EXECUTE')
     or has_function_privilege('service_role',
       'public.direct_entry_national_id_lock_key(text)', 'EXECUTE') then
    raise exception 'P2.5-HF-R2 ACL self-check failed';
  end if;
end;
$p2_5_hf_r2$;
