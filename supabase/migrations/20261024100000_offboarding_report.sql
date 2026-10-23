-- =============================================================================
-- Offboarding / unemployed worker report.
--
-- "Người lao động đã nghỉ việc ở đợt làm việc cuối và chưa có công việc ON mới
-- hơn ở bất kỳ dự án nào, đủ >= 3 ngày."
--
-- Workforce convention (per episode, at authorization_date()):
--   * drop superseded events (NOT EXISTS r WHERE r.supersedes_event_id = ev.event_id);
--   * only events with effective_date <= authorization_date();
--   * latest status = the status ordered by effective_date DESC, version DESC;
--   * ON means "đang làm" and disqualifies the person; UNCONFIRMED is "đang chờ
--     việc" (not working) and does NOT disqualify.
--   * last_off_date = max effective_date over the VALID OFF events (not raw OFF).
--   * threshold inclusive: last_off_date <= authorization_date() - 3.
--   * last project/recruiter come from the episode carrying that last OFF date
--     (ties broken by greatest first_work_date then entry_id).
--
-- Authority:
--   * Full Admin (canonical triple at all scope) and BoD/Accounting
--     (entry_privileged_edit at all scope): all workers, full phone, Excel.
--   * Current Team Leader: workers whose LAST recruiter is a current member of the
--     leader's current team. No phone key in the response, no export.
--   * Everyone else: denied before any read.
--
-- CCCD is used only for server-side identity/grouping and is never projected into
-- the response, the Excel file, a log, or an error message.
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Authority resolver (internal).
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
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    return jsonb_build_object(
      'scope', 'all', 'team_id', null,
      'can_phone', true, 'can_export', true, 'authority', 'admin'
    );
  exception when insufficient_privilege then
    null;
  end;

  if public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
     and public.direct_entry_has_scope(p_app_user_id, 'all') then
    return jsonb_build_object(
      'scope', 'all', 'team_id', null,
      'can_phone', true, 'can_export', true, 'authority', 'bod'
    );
  end if;

  begin
    v_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
    return jsonb_build_object(
      'scope', 'team', 'team_id', v_team_id,
      'can_phone', false, 'can_export', false, 'authority', 'team_leader'
    );
  exception when insufficient_privilege then
    null;
  end;

  raise exception 'offboarding report denied' using errcode = '42501';
end;
$function$;

revoke all on function public.direct_entry_offboarding_authority(uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_offboarding_authority(uuid, uuid) is
  'Internal authority for the offboarding report. Returns {scope, team_id, can_phone, can_export, authority} for Full Admin, BoD/Accounting, or current Team Leader; raises 42501 otherwise. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 2. Internal rows (scope-filtered, phone-gated, CCCD-free). Callers resolve
--    authority once and pass p_scope/p_team_id/p_can_phone so the data query is
--    stable and the public RPCs can apply real SQL LIMIT/OFFSET.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_offboarding_rows(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_team_id uuid,
  p_can_phone boolean
)
returns table (
  employee_code text,
  display_name text,
  project_id text,
  project_display text,
  recruiter_id uuid,
  recruiter_display text,
  off_effective_date date,
  days_since_off integer,
  phone text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  return query
  with ep as (
    select e.entry_id,
           e.employee_code,
           e.first_work_date,
           e.project_id,
           e.recruiter_id,
           e.worker_details,
           public.direct_entry_canonical_national_id(
             e.worker_details->'national_id'->>'value'
           ) as cccd,
           (
             select ev.status
               from public.direct_entry_employment_status_events ev
              where ev.entry_id = e.entry_id
                and ev.effective_date <= public.direct_entry_authorization_date()
                and not exists (
                  select 1
                    from public.direct_entry_employment_status_events r
                   where r.supersedes_event_id = ev.event_id
                )
              order by ev.effective_date desc, ev.version desc, ev.event_id desc
              limit 1
           ) as latest_valid_status,
           (
             select max(ev.effective_date)
               from public.direct_entry_employment_status_events ev
              where ev.entry_id = e.entry_id
                and ev.status = 'OFF'
                and ev.effective_date <= public.direct_entry_authorization_date()
                and not exists (
                  select 1
                    from public.direct_entry_employment_status_events r
                   where r.supersedes_event_id = ev.event_id
                )
           ) as last_valid_off_date
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
       and s.state = 'SUBMITTED'
     where e.deleted_at is null
       and e.voided_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
  ),
  person as (
    select ep.cccd,
           bool_or(ep.latest_valid_status = 'ON') as has_on,
           max(ep.last_valid_off_date) as last_off_date
      from ep
     where public.direct_entry_is_canonical_national_id(ep.cccd)
     group by ep.cccd
  ),
  eligible as (
    select p.cccd, p.last_off_date
      from person p
     where not p.has_on
       and p.last_off_date is not null
       and p.last_off_date <= public.direct_entry_authorization_date() - 3
  ),
  last_ep as (
    select distinct on (ep.cccd)
           ep.entry_id, ep.employee_code, ep.project_id, ep.recruiter_id,
           ep.worker_details, ep.last_valid_off_date as last_off_date
      from ep
      join eligible el
        on el.cccd = ep.cccd
       and el.last_off_date = ep.last_valid_off_date
     order by ep.cccd, ep.first_work_date desc, ep.entry_id desc
  )
  select le.employee_code,
         le.worker_details->>'display_name' as display_name,
         le.project_id,
         p.display_name as project_display,
         le.recruiter_id,
         r.display_name as recruiter_display,
         le.last_off_date as off_effective_date,
         public.direct_entry_authorization_date() - le.last_off_date as days_since_off,
         case when p_can_phone and le.worker_details->'phone'->>'state' = 'provided'
              then le.worker_details->'phone'->>'value'
              else null end as phone
    from last_ep le
    join public.direct_entry_projects p on p.project_id = le.project_id
    join public.recruiters r on r.recruiter_id = le.recruiter_id
   where p_scope = 'all'
      or exists (
        select 1
          from public.recruiter_team_memberships m
         where m.recruiter_id = le.recruiter_id
           and m.team_id = p_team_id
           and m.is_current
      );
end;
$function$;

revoke all on function public.direct_entry_offboarding_rows(uuid, uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_offboarding_rows(uuid, uuid, text, uuid, boolean) is
  'Internal offboarding rows. Applies server-side scope filtering and phone gating; never emits the CCCD. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 3. Public paginated list RPC (real DB LIMIT/OFFSET, not a JSON slice).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_offboarding_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_auth jsonb;
  v_scope text;
  v_team_id uuid;
  v_can_phone boolean;
  v_total integer;
  v_items jsonb;
  v_has_more boolean;
begin
  if v_page < 1 or v_page > 1000 then
    raise exception 'offboarding_report_page_invalid' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'offboarding_report_page_size_invalid' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  v_auth := public.direct_entry_offboarding_authority(p_auth_subject, p_app_user_id);
  v_scope := v_auth->>'scope';
  v_team_id := (v_auth->>'team_id')::uuid;
  v_can_phone := (v_auth->>'can_phone')::boolean;

  select count(*)::int into v_total
    from public.direct_entry_offboarding_rows(
      p_auth_subject, p_app_user_id, v_scope, v_team_id, v_can_phone
    );

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'employee_code', r.employee_code,
             'display_name', r.display_name,
             'project_id', r.project_id,
             'project_display', r.project_display,
             'recruiter_id', r.recruiter_id,
             'recruiter_display', r.recruiter_display,
             'off_effective_date', pg_catalog.to_char(r.off_effective_date, 'YYYY-MM-DD'),
             'days_since_off', r.days_since_off
           )
           || case when v_can_phone then jsonb_build_object('phone', r.phone) else '{}'::jsonb end
           order by r.off_effective_date asc, r.employee_code asc), '[]'::jsonb)
    into v_items
    from (
      select r.employee_code, r.display_name, r.project_id, r.project_display,
             r.recruiter_id, r.recruiter_display, r.off_effective_date,
             r.days_since_off, r.phone
        from public.direct_entry_offboarding_rows(
          p_auth_subject, p_app_user_id, v_scope, v_team_id, v_can_phone
        ) r
       order by r.off_effective_date asc, r.employee_code asc
       limit v_page_size offset v_offset
    ) r;

  v_has_more := v_offset + v_page_size < v_total;

  return jsonb_build_object(
    'scope', v_scope,
    'authority', v_auth->>'authority',
    'can_export', (v_auth->>'can_export')::boolean,
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'has_more', v_has_more,
    'items', v_items
  );
end;
$function$;

revoke all on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer)
  to service_role;
comment on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer) is
  'Offboarding report list. Full Admin and BoD/Accounting see all workers and receive the full phone number; a current Team Leader sees only workers whose last recruiter belongs to their current team and receives no phone number. Real DB pagination; CCCD never returned. service_role only.';

-- -----------------------------------------------------------------------------
-- 4. Public export RPC (all scope only). Returns every row in scope.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_offboarding_report_export(
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
  v_auth jsonb;
  v_scope text;
  v_team_id uuid;
  v_items jsonb;
begin
  v_auth := public.direct_entry_offboarding_authority(p_auth_subject, p_app_user_id);
  if (v_auth->>'can_export')::boolean is not true then
    raise exception 'offboarding report export denied' using errcode = '42501';
  end if;
  v_scope := v_auth->>'scope';
  v_team_id := (v_auth->>'team_id')::uuid;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'employee_code', r.employee_code,
             'display_name', r.display_name,
             'project_id', r.project_id,
             'project_display', r.project_display,
             'recruiter_id', r.recruiter_id,
             'recruiter_display', r.recruiter_display,
             'off_effective_date', pg_catalog.to_char(r.off_effective_date, 'YYYY-MM-DD'),
             'days_since_off', r.days_since_off,
             'phone', r.phone
           )
           order by r.off_effective_date asc, r.employee_code asc), '[]'::jsonb)
    into v_items
    from public.direct_entry_offboarding_rows(
      p_auth_subject, p_app_user_id, v_scope, v_team_id, true
    ) r;

  return jsonb_build_object(
    'authorization_date', public.direct_entry_authorization_date(),
    'items', v_items
  );
end;
$function$;

revoke all on function public.direct_entry_offboarding_report_export(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_offboarding_report_export(uuid, uuid)
  to service_role;
comment on function public.direct_entry_offboarding_report_export(uuid, uuid) is
  'Offboarding report export source. Same server-side scope/data rules as the list; only Full Admin and BoD/Accounting may call it. CCCD never returned. service_role only.';

-- -----------------------------------------------------------------------------
-- 5. Install-time self-check (data free).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_source text;
begin
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_offboarding_rows(uuid,uuid,text,uuid,boolean)'::regprocedure;
  if v_source is null then
    raise exception 'offboarding rows function missing';
  end if;
  -- Workforce convention + CCCD boundary.
  if position('supersedes_event_id' in v_source) = 0
     or position('effective_date <= public.direct_entry_authorization_date()' in v_source) = 0
     or position('effective_date desc, ev.version desc' in v_source) = 0
     or position('days_since_off' in v_source) = 0
     or position('recruiter_team_memberships' in v_source) = 0 then
    raise exception 'offboarding rows function lost its Workforce contract';
  end if;
  if position(chr(39) || 'cccd' || chr(39) in v_source) > 0
     or position('cccd_last4' in v_source) > 0 then
    raise exception 'offboarding rows function projects a CCCD';
  end if;

  foreach v_source in array array[
    'public.direct_entry_offboarding_authority(uuid,uuid)',
    'public.direct_entry_offboarding_rows(uuid,uuid,text,uuid,boolean)'
  ] loop
    if exists (
      select 1 from pg_proc p
       where p.oid = v_source::regprocedure
         and has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) then
      raise exception 'offboarding internal helper must stay revoked: %', v_source;
    end if;
  end loop;

  foreach v_source in array array[
    'public.direct_entry_offboarding_report(uuid,uuid,integer,integer)',
    'public.direct_entry_offboarding_report_export(uuid,uuid)'
  ] loop
    if not exists (
      select 1 from pg_proc p
       where p.oid = v_source::regprocedure
         and p.prosecdef
         and p.provolatile = 's'
         and p.proconfig @> array['search_path=pg_catalog, public']
         and not has_function_privilege('anon', p.oid, 'EXECUTE')
         and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
         and has_function_privilege('service_role', p.oid, 'EXECUTE')
         and not exists (
           select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         )
    ) then
      raise exception 'offboarding RPC security boundary wrong: %', v_source;
    end if;
  end loop;

  raise notice 'offboarding report migration self-check OK';
end;
$check$;

commit;
