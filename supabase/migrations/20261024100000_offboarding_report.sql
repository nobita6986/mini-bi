-- =============================================================================
-- Offboarding / unemployed worker report.
--
-- "Người lao động đã nghỉ việc ở đợt làm việc cuối và chưa có công việc ON mới
-- hơn ở bất kỳ dự án nào, đủ >= 3 ngày."
--
-- Business rules (fail-closed, CCCD never leaves the database):
--   * A person is the canonical CCCD (9/12 ASCII digits after normalization)
--     across submitted, non-deleted, non-voided episodes.
--   * An episode is "currently working" when its latest status (highest version)
--     is ON. If ANY episode of the person is ON, the person is excluded.
--   * The "last job" is the episode with the greatest OFF effective_date among
--     that person's OFF episodes (ties broken by greatest first_work_date then
--     entry_id). Its project and recruiter are reported.
--   * The threshold is inclusive: an OFF effective_date exactly 3 days before the
--     business current date is included (days_since_off >= 3).
--   * UNCONFIRMED episodes are NOT ON, so they do not disqualify a person; the
--     "last job" is still their most recent OFF episode. (Explicit decision: only
--     ON means "đang làm".)
--
-- Authority:
--   * Full Admin (canonical triple at all scope) and the BoD/Accounting bundle
--     (entry_privileged_edit at all scope) see the whole company, receive the full
--     phone number, and may export to Excel.
--   * A current Team Leader sees only workers whose LAST recruiter is a current
--     member of the leader's current team. No phone number is present in the API
--     response, and export is denied.
--   * Everyone else is denied before any read.
--
-- CCCD is used only for server-side identity/grouping and is never projected into
-- the response, the Excel file, a log, or an error message.
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Authority resolver (internal): returns scope + phone/export flags, or denies.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_offboarding_authority(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_team_id uuid;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  -- Full Admin.
  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    return jsonb_build_object(
      'scope', 'all', 'team_id', null,
      'can_phone', true, 'can_export', true, 'authority', 'admin'
    );
  exception when insufficient_privilege then
    null;
  end;

  -- BoD / Accounting privileged bundle.
  if public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
     and public.direct_entry_has_scope(p_app_user_id, 'all') then
    return jsonb_build_object(
      'scope', 'all', 'team_id', null,
      'can_phone', true, 'can_export', true, 'authority', 'bod'
    );
  end if;

  -- Current Team Leader.
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
-- 2. Internal data projection (scope-filtered, phone-gated, CCCD-free).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_offboarding_data(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb := public.direct_entry_offboarding_authority(p_auth_subject, p_app_user_id);
  v_scope text := v_auth->>'scope';
  v_team_id uuid := (v_auth->>'team_id')::uuid;
  v_can_phone boolean := (v_auth->>'can_phone')::boolean;
  v_items jsonb;
begin
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
           coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = e.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') as latest_status,
           (
             select max(st.effective_date)
               from public.direct_entry_employment_status_events st
              where st.entry_id = e.entry_id
                and st.status = 'OFF'
           ) as last_off_date
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
           bool_or(ep.latest_status = 'ON') as has_on,
           max(ep.last_off_date) as last_off_date
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
           ep.worker_details, ep.last_off_date
      from ep
      join eligible el
        on el.cccd = ep.cccd
       and el.last_off_date = ep.last_off_date
     order by ep.cccd, ep.first_work_date desc, ep.entry_id desc
  )
  select coalesce(jsonb_agg(item.json order by item.off_effective_date asc, item.employee_code asc), '[]'::jsonb)
    into v_items
    from (
      select jsonb_build_object(
               'employee_code', le.employee_code,
               'display_name', le.worker_details->>'display_name',
               'project_id', le.project_id,
               'project_display', p.display_name,
               'recruiter_id', le.recruiter_id,
               'recruiter_display', r.display_name,
               'off_effective_date', pg_catalog.to_char(le.last_off_date, 'YYYY-MM-DD'),
               'days_since_off', public.direct_entry_authorization_date() - le.last_off_date
             )
             || case when v_can_phone
                  and le.worker_details->'phone'->>'state' = 'provided'
                then jsonb_build_object(
                  'phone', le.worker_details->'phone'->>'value'
                )
                else '{}'::jsonb end as json,
             le.last_off_date, le.employee_code
        from last_ep le
        join public.direct_entry_projects p on p.project_id = le.project_id
        join public.recruiters r on r.recruiter_id = le.recruiter_id
       where v_scope = 'all'
          or exists (
            select 1
              from public.recruiter_team_memberships m
             where m.recruiter_id = le.recruiter_id
               and m.team_id = v_team_id
               and m.is_current
          )
    ) item;

  return jsonb_build_object(
    'scope', v_scope,
    'authority', v_auth->>'authority',
    'can_phone', v_can_phone,
    'can_export', (v_auth->>'can_export')::boolean,
    'authorization_date', public.direct_entry_authorization_date(),
    'items', v_items
  );
end;
$function$;

revoke all on function public.direct_entry_offboarding_data(uuid, uuid)
  from public, anon, authenticated, service_role;
comment on function public.direct_entry_offboarding_data(uuid, uuid) is
  'Internal offboarding rows projection. Applies server-side scope filtering (all vs team by last recruiter current team), gates the full phone number to all-scope audiences, and never emits the CCCD. Revoked from every role.';

-- -----------------------------------------------------------------------------
-- 3. Public paginated list RPC.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_offboarding_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_data jsonb;
  v_items jsonb;
  v_total integer;
  v_page_items jsonb;
  v_has_more boolean;
begin
  if v_page < 1 or v_page > 1000 then
    raise exception 'offboarding_report_page_invalid' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'offboarding_report_page_size_invalid' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  v_data := public.direct_entry_offboarding_data(p_auth_subject, p_app_user_id);
  v_items := coalesce(v_data->'items', '[]'::jsonb);
  v_total := jsonb_array_length(v_items);

  select coalesce(jsonb_agg(elem.value order by elem.ord), '[]'::jsonb)
    into v_page_items
    from jsonb_array_elements(v_items) with ordinality as elem(value, ord)
   where elem.ord > v_offset
     and elem.ord <= v_offset + v_page_size;

  v_has_more := v_offset + v_page_size < v_total;

  return jsonb_build_object(
    'scope', v_data->>'scope',
    'authority', v_data->>'authority',
    'can_export', (v_data->>'can_export')::boolean,
    'authorization_date', v_data->>'authorization_date',
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'has_more', v_has_more,
    'items', v_page_items
  );
end;
$function$;

revoke all on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer)
  to service_role;
comment on function public.direct_entry_offboarding_report(uuid, uuid, integer, integer) is
  'Offboarding report list. Full Admin and BoD/Accounting see all workers and receive the full phone number; a current Team Leader sees only workers whose last recruiter belongs to their current team and receives no phone number. Paginated server-side; CCCD is never returned. service_role only.';

-- -----------------------------------------------------------------------------
-- 4. Public export RPC (all scope only). Returns every row in scope.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_offboarding_report_export(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_data jsonb;
begin
  v_data := public.direct_entry_offboarding_data(p_auth_subject, p_app_user_id);
  if (v_data->>'can_export')::boolean is not true then
    raise exception 'offboarding report export denied' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'authorization_date', v_data->>'authorization_date',
    'items', v_data->'items'
  );
end;
$function$;

revoke all on function public.direct_entry_offboarding_report_export(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_offboarding_report_export(uuid, uuid)
  to service_role;
comment on function public.direct_entry_offboarding_report_export(uuid, uuid) is
  'Offboarding report export source. Same server-side scope/data rules as the list; only Full Admin and BoD/Accounting (can_export) may call it. CCCD is never returned. service_role only.';

-- -----------------------------------------------------------------------------
-- 5. Install-time self-check (data free).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_source text;
begin
  select p.prosrc into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_offboarding_data(uuid,uuid)'::regprocedure;
  if v_source is null then
    raise exception 'offboarding data function missing';
  end if;
  -- Fail-closed on the CCCD and phone boundaries.
  if position('national_id' in v_source) > 0
     or position('cccd_last4' in v_source) > 0
     or position('right(' in v_source) > 0 then
    raise exception 'offboarding data function projects a CCCD';
  end if;
  if position('days_since_off' in v_source) = 0
     or position('employee_code' in v_source) = 0
     or position('recruiter_team_memberships' in v_source) = 0
     or position('authorization_date() - 3' in v_source) = 0 then
    raise exception 'offboarding data function lost its business contract';
  end if;

  foreach v_source in array array[
    'public.direct_entry_offboarding_authority(uuid,uuid)',
    'public.direct_entry_offboarding_data(uuid,uuid)'
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
