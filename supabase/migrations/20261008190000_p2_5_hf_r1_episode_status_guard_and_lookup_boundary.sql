-- P2.5-HF-R1 - episode invariant on the status-event path + bounded server lookup.
--
-- R1 of P2.5-HF_WORKER_CREATE_AND_REHIRE. #58 is already pushed and is NOT modified here.
--   1. The "one active episode per normalized CCCD" invariant from #58 only ran on
--      direct_entries.worker_details. Every status writer (direct_entry_apply_employment_status,
--      direct_entry_correct_latest_status and the WORK_STATUS change-request apply, which all
--      append to direct_entry_employment_status_events) can therefore still turn an older OFF
--      episode back ON. This migration moves the invariant onto that shared write path.
--   2. direct_entry_lookup_worker_episodes required project + name + national id at once and was
--      only reachable through the service role. It is replaced by a bounded lookup that accepts a
--      name OR an exact CCCD, with explicit page_size/offset.
--
-- Rollout: #58 and #59 belong to the same maintenance window. #58 relaxes creation so a rehire
-- creates a new episode; #59 closes the status-event loophole that would otherwise let an older
-- episode be reopened instead. Applying #58 without #59 leaves that hole open.

-- -----------------------------------------------------------------------------
-- 1. Status-event guard: same normalization, same advisory lock, same error code as #58.
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
    -- Closing an episode can never produce a second active episode.
    return new;
  end if;

  select nullif(btrim(coalesce(e.worker_details->'national_id'->>'value', '')), ''),
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

  -- Same key as the #58 create guard: a concurrent create and a concurrent status change for
  -- the same CCCD serialize on this lock instead of both passing their own check.
  perform pg_advisory_xact_lock(hashtextextended('worker-episode:' || v_cccd, 0));

  -- (1) Invariant: at most one episode of a CCCD may have a latest status other than OFF.
  --     Unknown and UNCONFIRMED fail closed, exactly like the #58 create guard.
  select exists (
    select 1
      from public.direct_entries e
     where e.entry_id <> new.entry_id
       and e.deleted_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
       and btrim(e.worker_details->'national_id'->>'value') = v_cccd
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

  -- (2) A closed episode is never reopened through the append-only status path (a WORK_STATUS
  --     OFF->ON approval lands here with supersedes_event_id = null). Returning to work is a new
  --     profile. The dedicated correction path keeps working: it supersedes the event it fixes,
  --     so it arrives with supersedes_event_id set.
  if v_own_latest = 'OFF' and new.supersedes_event_id is null then
    raise exception 'worker_episode_reopen_forbidden' using errcode = '23505';
  end if;

  return new;
end;
$$;
revoke all on function public.direct_entry_guard_episode_status_event()
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_guard_episode_status_event() is
  'P2.5-HF-R1: keeps the one-active-episode-per-CCCD invariant on the status-event write path. '
  'Rejects 23505 worker_active_episode_exists when another episode of the same normalized CCCD '
  'is not OFF, and 23505 worker_episode_reopen_forbidden when an append-only event would reopen '
  'a closed episode. Neither message carries the CCCD or any other profile value.';

create trigger direct_entry_episode_status_guard
  before insert on public.direct_entry_employment_status_events
  for each row execute function public.direct_entry_guard_episode_status_event();

-- -----------------------------------------------------------------------------
-- 2. Bounded lookup: name OR exact CCCD, paginated, same authority rule as #58.
-- -----------------------------------------------------------------------------
drop function if exists public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text);

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
stable
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
    -- Digits only, so a leading zero survives and formatting characters are ignored.
    v_cccd := regexp_replace(v_raw_id, '[^0-9]', '', 'g');
    if v_cccd !~ '^[0-9]{6,12}$' then
      -- Caller input is never echoed back in the message.
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
    -- Any other caller must be an explicit all-scope administrator.
    perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
  end if;

  with keys as (
    select distinct
           regexp_replace(btrim(coalesce(e.worker_details->'national_id'->>'value', '')), '[^0-9]', '', 'g') as cccd
      from public.direct_entries e
     where e.deleted_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
       and regexp_replace(btrim(coalesce(e.worker_details->'national_id'->>'value', '')), '[^0-9]', '', 'g') <> ''
       and (
         case
           when v_cccd is not null then
             regexp_replace(btrim(coalesce(e.worker_details->'national_id'->>'value', '')), '[^0-9]', '', 'g') = v_cccd
           else
             -- A name search is bounded to the target project: it is never a global directory.
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
        on k.cccd = regexp_replace(btrim(coalesce(e.worker_details->'national_id'->>'value', '')), '[^0-9]', '', 'g')
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
  'P2.5-HF-R1 bounded episode lookup. Match by exact normalized CCCD (digits only, leading zero '
  'preserved) or by display name inside the target project; a caller that supplies both is resolved '
  'by the CCCD so a stale name cannot hide the person. Returns per worker only display name, '
  'employee code, episode count, active-episode flag and, per episode, employee code, project, '
  'first work date and latest status. No CCCD, date of birth, address, phone, bank or document '
  'value is returned and no global worker directory is exposed: name search is project scoped and '
  'only an effective manager of the target project or an all-scope administrator may call it.';

-- -----------------------------------------------------------------------------
-- 3. Self-check.
-- -----------------------------------------------------------------------------
do $p2_5_hf_r1$
declare
  v_source text;
  v_safe boolean;
begin
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_guard_episode_status_event()'::regprocedure;
  if v_source is null
     or position('worker_active_episode_exists' in v_source) = 0
     or position('worker_episode_reopen_forbidden' in v_source) = 0
     or position('pg_advisory_xact_lock' in v_source) = 0
     or position(chr(39) || 'UNCONFIRMED' || chr(39) in v_source) = 0 then
    raise exception 'P2.5-HF-R1 status-event guard is not fail-closed';
  end if;
  if position('hashtextextended(' || chr(39) || 'worker-episode:' in v_source) = 0 then
    raise exception 'P2.5-HF-R1 status-event guard lost the shared per-CCCD lock key';
  end if;
  if (select count(*) from pg_trigger
       where tgname = 'direct_entry_episode_status_guard' and not tgisinternal) <> 1 then
    raise exception 'P2.5-HF-R1 status-event guard trigger is missing';
  end if;
  if (select count(*) from pg_trigger
       where tgname = 'direct_entry_active_episode_guard' and not tgisinternal) <> 1 then
    raise exception 'P2.5-HF-R1 the #58 create guard was removed';
  end if;

  if to_regprocedure(
       'public.direct_entry_lookup_worker_episodes(uuid,uuid,text,text,text)') is not null then
    raise exception 'P2.5-HF-R1 the unrestricted three-key lookup signature still exists';
  end if;
  select p.prosrc into v_source from pg_proc p
   where p.oid = 'public.direct_entry_lookup_worker_episodes(uuid,uuid,text,text,text,integer,integer)'::regprocedure;
  if v_source is null then
    raise exception 'P2.5-HF-R1 bounded lookup is missing';
  end if;
  v_safe := position('date_of_birth' in v_source) = 0
        and position('permanent_address' in v_source) = 0
        and position('phone_number' in v_source) = 0
        and position('account_number' in v_source) = 0
        and position('account_holder' in v_source) = 0
        and position('direct_entry_document' in v_source) = 0
        and position('p_page_size' in v_source) > 0
        and position('worker_lookup_query_required' in v_source) > 0;
  if not v_safe then
    raise exception 'P2.5-HF-R1 bounded lookup returns more than the agreed minimum';
  end if;

  if not has_function_privilege('service_role',
       'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)', 'EXECUTE') then
    raise exception 'P2.5-HF-R1 bounded lookup ACL self-check failed';
  end if;
  if has_function_privilege('service_role',
       'public.direct_entry_guard_episode_status_event()', 'EXECUTE') then
    raise exception 'P2.5-HF-R1 status-event guard must stay internal';
  end if;
end;
$p2_5_hf_r1$;
